export * as WorktreeControlScheduler from "./worktree-scheduler"

import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Context, DateTime, Effect, Layer, Schedule, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { ControlOperation } from "./service"
import { WorktreeControlExecutor } from "./worktree-executor"
import { WorktreeControlWorker } from "./worktree-worker"

export class Service extends Context.Service<Service, ControlOperation.Scheduler>()(
  "@arforge/WorktreeControlScheduler",
) {}

/**
 * App-scoped, detached scheduling. `wake` only records work in the scoped
 * coordinator; worker execution is never owned by the calling HTTP fiber.
 * Each drain enters the persisted location through LocationServiceMap, while
 * closing the app scope interrupts all drains for the next startup scan.
 */
export const make = (input: {
  readonly execute: (
    runID: AgentRuntime.RunID,
    location?: AgentRuntime.ControlPlaneSubject["location"],
  ) => Effect.Effect<void, unknown>
}): Effect.Effect<ControlOperation.Scheduler, never, Scope.Scope> =>
  Effect.gen(function* () {
    const locations = new Map<AgentRuntime.RunID, AgentRuntime.ControlPlaneSubject["location"]>()
    const coordinator = yield* SessionRunCoordinator.make<AgentRuntime.RunID, never>({
      drain: (runID) =>
        input
          .execute(runID, locations.get(runID))
          .pipe(Effect.catchCause((cause) => Effect.logError("Control worker failed", { runID, cause }))),
    })
    return {
      start: (runID, location) =>
        Effect.sync(() => {
          if (location === undefined) return
          const previous = locations.get(runID)
          if (previous !== undefined && previous !== location)
            throw new Error(`Control run ${runID} was scheduled for two different locations`)
          // Keep the immutable binding for the app lifetime. A wake coalesced
          // while another drain is active may run only after that drain exits;
          // deleting here would make the successor lose its trusted location.
          locations.set(runID, location)
        }).pipe(Effect.andThen(coordinator.wake(runID))),
    }
  })

const WorktreeOperationKind = new Set(["worktree.create", "worktree.remove", "worktree.reset"])
const RecoverableWorktreeStatus = new Set<AgentRuntime.RunStatus>([
  "draft",
  "preflight",
  "awaiting_authorization",
  "queued",
  "running",
  "recovering",
  "verifying",
])
export const CONTROL_EXECUTION_DEADLINE_MS = ControlOperation.MAX_RUN_DURATION_MS
export const CONTROL_LEASE_TTL_MS = CONTROL_EXECUTION_DEADLINE_MS + 60_000

const leaseActive = (snapshot: DurableRun.ControlSnapshot, nowMs: number) =>
  snapshot.lease !== undefined && DateTime.toEpochMillis(snapshot.lease.expiresAt) > nowMs

/**
 * Finds persisted worktree control runs without assuming that one location is
 * already open. Safe pre-execution states are woken normally. Orphaned
 * running/recovering/verifying states are also woken, but the worker's strict
 * recovery branch may only persist an interrupted attempt and pause them.
 */
export const scanRecoverableControl = (input: {
  readonly durable: Pick<DurableRun.Interface, "recoverableControl" | "orphanedControl">
  readonly scheduler: ControlOperation.Scheduler
}): Effect.Effect<ReadonlyArray<AgentRuntime.RunID>> =>
  Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
    const [recoverable, orphaned] = yield* Effect.all([
      input.durable.recoverableControl(),
      input.durable.orphanedControl(),
    ])
    const candidates = new Map<AgentRuntime.RunID, DurableRun.ControlSnapshot>()
    for (const snapshot of [...recoverable, ...orphaned]) {
      if (!WorktreeOperationKind.has(snapshot.run.operation.kind)) continue
      // DurableRun already filters its recovery views, but the scheduler owns
      // the final mutation allow-list. A stale/incorrect source must never
      // turn terminal or manually paused state back into a 30-second loop.
      if (!RecoverableWorktreeStatus.has(snapshot.run.status)) continue
      // recoverableControl intentionally returns safe pre-execution states
      // even when another worker still owns them. Never create a competing
      // approval waiter until that opaque ownership has actually expired.
      if (leaseActive(snapshot, nowMs)) continue
      candidates.set(snapshot.run.id, snapshot)
    }
    yield* Effect.forEach(
      candidates.values(),
      (snapshot) => input.scheduler.start(snapshot.run.id, snapshot.run.subject.location),
      { concurrency: 4, discard: true },
    )
    return [...candidates.keys()]
  })

/** App-owned periodic recovery. Re-scanning is required when a dead process's
 * lease is still live during the first startup pass. */
export const startRecoveryScanner = (input: {
  readonly durable: Pick<DurableRun.Interface, "recoverableControl" | "orphanedControl">
  readonly scheduler: ControlOperation.Scheduler
  readonly interval?: Parameters<typeof Schedule.spaced>[0]
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scan = scanRecoverableControl(input).pipe(
      Effect.tap((runIDs) =>
        runIDs.length === 0 ? Effect.void : Effect.logInfo("Scheduled recoverable worktree control runs", { runIDs }),
      ),
      Effect.catchCause((cause) => Effect.logError("Control recovery scan failed", { cause })),
    )
    yield* scan.pipe(Effect.repeat(Schedule.spaced(input.interval ?? "30 seconds")), Effect.forkScoped)
  })

/** Builds the app-owned scheduler and enters location-bound services per run. */
export const makeWorktreeScheduler: Effect.Effect<
  ControlOperation.Scheduler,
  never,
  DurableRun.Service | Worktree.Service | InstanceStore.Service | LocationServiceMap.Service | Scope.Scope
> = Effect.gen(function* () {
  const recoveryDurable = yield* DurableRun.Service
  const worktree = yield* Worktree.Service
  const instanceStore = yield* InstanceStore.Service
  const locations = yield* LocationServiceMap.Service
  const scheduler = yield* make({
    execute: (runID, location) => {
      if (!location) return Effect.fail(new Error("Control worker location is missing"))
      const locationLayer = locations.get(Location.Ref.make({ directory: AbsolutePath.make(location) }))
      const effect = Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const gateway = yield* ActionGateway.Service
        const scopedWorker = WorktreeControlWorker.make({
          durable,
          gateway,
          executor: WorktreeControlExecutor.makeWorktreeExecutor(worktree, durable),
          ownerID: `worktree-control:${randomUUID()}`,
          leaseTtlMs: CONTROL_LEASE_TTL_MS,
          executionDeadlineMs: CONTROL_EXECUTION_DEADLINE_MS,
          scope: (run) =>
            worktree.controlScope().pipe(
              Effect.mapError(
                (error) =>
                  new WorktreeControlWorker.SnapshotMismatchError({
                    runID: run.id,
                    reason: error.message,
                  }),
              ),
            ),
        })
        return yield* scopedWorker.execute(runID)
      }).pipe(Effect.provide(locationLayer), Effect.provideService(Worktree.Service, worktree))
      return instanceStore.provide({ directory: location }, effect)
    },
  })
  yield* startRecoveryScanner({ durable: recoveryDurable, scheduler })
  return scheduler
})

/**
 * This layer must be provided by a long-lived location/app lifecycle, never
 * directly by an HTTP request layer.  If it is absent, ControlOperation
 * rejects before ClaimIndex writes anything.
 */
export const layer: Layer.Layer<
  Service,
  never,
  DurableRun.Service | Worktree.Service | InstanceStore.Service | LocationServiceMap.Service
> = Layer.effect(Service, makeWorktreeScheduler)

/** App-scoped node; handlers must consume this service instead of constructing
 * a scheduler inside an HTTP request. */
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [DurableRun.node, Worktree.node, InstanceStore.node, LocationServiceMap.node],
})
