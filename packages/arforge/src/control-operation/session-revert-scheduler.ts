export * as SessionRevertControlScheduler from "./session-revert-scheduler"

import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { Database } from "@arforge-ai/core/database/database"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Context, DateTime, Effect, Layer, Schedule, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { Snapshot } from "@/snapshot"
import { Session } from "@/session/session"
import { SessionRevertReadonlyLocal } from "@/session/revert-readonly-local"
import { SessionRevertSnapshot } from "@/session/revert-snapshot"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { SessionRevertControlExecutor } from "./session-revert-executor"
import { SessionRevertControlWorker } from "./session-revert-worker"
import { SessionRevertControlOperation } from "./session-revert-operation"

export class Service extends Context.Service<Service, SessionRevertControlOperation.Scheduler>()(
  "@arforge/SessionRevertControlScheduler",
) {}

export const CONTROL_EXECUTION_DEADLINE_MS = 15 * 60 * 1000
export const CONTROL_LEASE_TTL_MS = CONTROL_EXECUTION_DEADLINE_MS + 60_000

const OperationKind = new Set(["session.revert", "session.unrevert"])
const RecoverableStatus = new Set<AgentRuntime.RunStatus>([
  "draft",
  "preflight",
  "awaiting_authorization",
  "queued",
  "running",
  "recovering",
  "verifying",
])

const leaseActive = (snapshot: DurableRun.ControlSnapshot, nowMs: number) =>
  snapshot.lease !== undefined && DateTime.toEpochMillis(snapshot.lease.expiresAt) > nowMs

const codec = {
  decode: SessionRevertSnapshot.decode,
  actionMaterial: SessionRevertSnapshot.actionMaterial,
  authorizationPlan: (snapshot: SessionRevertSnapshot.Snapshot) => SessionRevertSnapshot.authorizationPlan(snapshot),
}

const makeScheduler = (input: {
  readonly execute: (
    runID: AgentRuntime.RunID,
    location?: AgentRuntime.ControlPlaneSubject["location"],
  ) => Effect.Effect<void, unknown>
}): Effect.Effect<SessionRevertControlOperation.Scheduler, never, Scope.Scope> =>
  Effect.gen(function* () {
    const locations = new Map<AgentRuntime.RunID, AgentRuntime.ControlPlaneSubject["location"]>()
    const coordinator = yield* SessionRunCoordinator.make<AgentRuntime.RunID, never>({
      drain: (runID) =>
        input
          .execute(runID, locations.get(runID))
          .pipe(
            Effect.catchCause((cause) => Effect.logError("Session revert control worker failed", { runID, cause })),
          ),
    })
    return {
      start: (runID, location) =>
        Effect.sync(() => {
          if (location === undefined) throw new Error("Session revert control location is missing")
          const previous = locations.get(runID)
          if (previous !== undefined && previous !== location)
            throw new Error(`Session revert control run ${runID} was scheduled for two locations`)
          locations.set(runID, location)
        }).pipe(Effect.andThen(coordinator.wake(runID))),
    }
  })

export const scanRecoverableControl = (input: {
  readonly durable: Pick<DurableRun.Interface, "recoverableControl" | "orphanedControl">
  readonly scheduler: SessionRevertControlOperation.Scheduler
}): Effect.Effect<ReadonlyArray<AgentRuntime.RunID>> =>
  Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
    const [recoverable, orphaned] = yield* Effect.all([
      input.durable.recoverableControl(),
      input.durable.orphanedControl(),
    ])
    const candidates = new Map<AgentRuntime.RunID, DurableRun.ControlSnapshot>()
    for (const snapshot of [...recoverable, ...orphaned]) {
      if (!OperationKind.has(snapshot.run.operation.kind) || !RecoverableStatus.has(snapshot.run.status)) continue
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

export const startRecoveryScanner = (input: {
  readonly durable: Pick<DurableRun.Interface, "recoverableControl" | "orphanedControl">
  readonly scheduler: SessionRevertControlOperation.Scheduler
  readonly interval?: Parameters<typeof Schedule.spaced>[0]
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* scanRecoverableControl(input).pipe(
      Effect.tap((runIDs) =>
        runIDs.length === 0
          ? Effect.void
          : Effect.logInfo("Scheduled recoverable session revert control runs", { runIDs }),
      ),
      Effect.catchCause((cause) => Effect.logError("Session revert recovery scan failed", { cause })),
      Effect.repeat(Schedule.spaced(input.interval ?? "30 seconds")),
      Effect.forkScoped,
    )
  })

export const makeSessionRevertScheduler: Effect.Effect<
  SessionRevertControlOperation.Scheduler,
  never,
  | DurableRun.Service
  | Database.Service
  | Snapshot.Service
  | Session.Service
  | SessionRevertReadonlyLocal.Service
  | FSUtil.Service
  | InstanceStore.Service
  | LocationServiceMap.Service
  | Scope.Scope
> = Effect.gen(function* () {
  const recoveryDurable = yield* DurableRun.Service
  const database = yield* Database.Service
  const snapshot = yield* Snapshot.Service
  const sessions = yield* Session.Service
  const inspector = yield* SessionRevertReadonlyLocal.Service
  const fs = yield* FSUtil.Service
  const instanceStore = yield* InstanceStore.Service
  const locations = yield* LocationServiceMap.Service
  const scheduler = yield* makeScheduler({
    execute: (runID, location) => {
      if (!location) return Effect.fail(new Error("Session revert control location is missing"))
      const locationLayer = locations.get(Location.Ref.make({ directory: AbsolutePath.make(location) }))
      const effect = Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const gateway = yield* ActionGateway.Service
        const worker = SessionRevertControlWorker.make({
          durable,
          gateway,
          codec,
          executor: SessionRevertControlExecutor.make({
            durable,
            snapshot,
            sessions,
            inspector,
            fs,
            database,
          }),
          pauseOnExecutorError: (error) => error instanceof ActionGateway.RecoveryRequiredError,
          ownerID: `session-revert-control:${randomUUID()}`,
          leaseTtlMs: CONTROL_LEASE_TTL_MS,
          executionDeadlineMs: CONTROL_EXECUTION_DEADLINE_MS,
          scope: (run) =>
            Effect.try({
              try: () => SessionRevertSnapshot.claimMaterial(run.operation.payload).input,
              catch: (cause) =>
                new SessionRevertControlWorker.SnapshotMismatchError({
                  runID: run.id,
                  reason: cause instanceof Error ? cause.message : "The sealed session revert snapshot is invalid.",
                }),
            }),
        })
        return yield* worker.execute(runID)
      }).pipe(
        Effect.provide(locationLayer),
        Effect.provideService(Database.Service, database),
        Effect.provideService(Snapshot.Service, snapshot),
        Effect.provideService(Session.Service, sessions),
        Effect.provideService(SessionRevertReadonlyLocal.Service, inspector),
        Effect.provideService(FSUtil.Service, fs),
      )
      return instanceStore.provide({ directory: location }, effect)
    },
  })
  yield* startRecoveryScanner({ durable: recoveryDurable, scheduler })
  return scheduler
})

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(Service, makeSessionRevertScheduler),
  deps: [
    DurableRun.node,
    Database.node,
    Snapshot.node,
    Session.node,
    SessionRevertReadonlyLocal.node,
    FSUtil.node,
    InstanceStore.node,
    LocationServiceMap.node,
  ],
})
