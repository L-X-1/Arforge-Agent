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
import { Session } from "@/session/session"
import { SessionShareReadonlyLocal } from "@/share/readonly-local"
import { SessionShareProvider } from "@/share/provider"
import { SessionShareReceiptStore } from "@/share/receipt-store"
import { SessionShareSnapshot } from "@/share/session-snapshot"
import { SessionShareControlExecutor } from "./session-share-executor"
import { SessionShareControlOperation } from "./session-share-operation"
import { SessionShareControlWorker } from "./session-share-worker"

export class Service extends Context.Service<Service, SessionShareControlOperation.Scheduler>()(
  "@arforge/SessionShareControlScheduler",
) {}

export const CONTROL_EXECUTION_DEADLINE_MS = 15 * 60 * 1000
export const CONTROL_LEASE_TTL_MS = CONTROL_EXECUTION_DEADLINE_MS + 60_000

const OperationKind = new Set(["session.share", "session.unshare"])
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
  decode: SessionShareSnapshot.decode,
  actionMaterial: SessionShareSnapshot.actionMaterial,
  authorizationPlan: (snapshot: SessionShareSnapshot.Snapshot) => SessionShareSnapshot.authorizationPlan(snapshot),
}

const makeScheduler = (input: {
  readonly execute: (
    runID: AgentRuntime.RunID,
    location?: AgentRuntime.ControlPlaneSubject["location"],
  ) => Effect.Effect<void, unknown>
}): Effect.Effect<SessionShareControlOperation.Scheduler, never, Scope.Scope> =>
  Effect.gen(function* () {
    const locations = new Map<AgentRuntime.RunID, AgentRuntime.ControlPlaneSubject["location"]>()
    const coordinator = yield* SessionRunCoordinator.make<AgentRuntime.RunID, never>({
      drain: (runID) =>
        input
          .execute(runID, locations.get(runID))
          .pipe(Effect.catchCause((cause) => Effect.logError("Session share control worker failed", { runID, cause }))),
    })
    return {
      start: (runID, location) =>
        Effect.sync(() => {
          if (location === undefined) throw new Error("Session share control location is missing")
          const previous = locations.get(runID)
          if (previous !== undefined && previous !== location)
            throw new Error(`Session share control run ${runID} was scheduled for two locations`)
          locations.set(runID, location)
        }).pipe(Effect.andThen(coordinator.wake(runID))),
    }
  })

export const scanRecoverableControl = (input: {
  readonly durable: Pick<DurableRun.Interface, "recoverableControl" | "orphanedControl">
  readonly scheduler: SessionShareControlOperation.Scheduler
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
  readonly scheduler: SessionShareControlOperation.Scheduler
  readonly interval?: Parameters<typeof Schedule.spaced>[0]
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* scanRecoverableControl(input).pipe(
      Effect.tap((runIDs) =>
        runIDs.length === 0
          ? Effect.void
          : Effect.logInfo("Scheduled recoverable session share control runs", { runIDs }),
      ),
      Effect.catchCause((cause) => Effect.logError("Session share recovery scan failed", { cause })),
      Effect.repeat(Schedule.spaced(input.interval ?? "30 seconds")),
      Effect.forkScoped,
    )
  })

export const makeSessionShareScheduler: Effect.Effect<
  SessionShareControlOperation.Scheduler,
  never,
  | DurableRun.Service
  | Database.Service
  | Session.Service
  | SessionShareReadonlyLocal.Service
  | SessionShareProvider.Service
  | SessionShareReceiptStore.Service
  | InstanceStore.Service
  | LocationServiceMap.Service
  | Scope.Scope
> = Effect.gen(function* () {
  const recoveryDurable = yield* DurableRun.Service
  const database = yield* Database.Service
  const sessions = yield* Session.Service
  const exporter = yield* SessionShareReadonlyLocal.Service
  const provider = yield* SessionShareProvider.Service
  const receipts = yield* SessionShareReceiptStore.Service
  const instanceStore = yield* InstanceStore.Service
  const locations = yield* LocationServiceMap.Service
  const scheduler = yield* makeScheduler({
    execute: (runID, location) => {
      if (!location) return Effect.fail(new Error("Session share control location is missing"))
      const locationLayer = locations.get(Location.Ref.make({ directory: AbsolutePath.make(location) }))
      const effect = Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const gateway = yield* ActionGateway.Service
        const worker = SessionShareControlWorker.make({
          durable,
          gateway,
          codec,
          executor: SessionShareControlExecutor.make({
            provider,
            receipts,
            sessions,
          }),
          pauseOnExecutorError: (error) => error instanceof ActionGateway.RecoveryRequiredError,
          ownerID: `session-share-control:${randomUUID()}`,
          leaseTtlMs: CONTROL_LEASE_TTL_MS,
          executionDeadlineMs: CONTROL_EXECUTION_DEADLINE_MS,
          scope: (run) =>
            Effect.try({
              try: () => SessionShareSnapshot.claimMaterial(run.operation.payload).input,
              catch: (cause) =>
                new SessionShareControlWorker.SnapshotMismatchError({
                  runID: run.id,
                  reason: cause instanceof Error ? cause.message : "The sealed session share snapshot is invalid.",
                }),
            }),
        })
        return yield* worker.execute(runID)
      }).pipe(
        Effect.provide(locationLayer),
        Effect.provideService(Database.Service, database),
        Effect.provideService(Session.Service, sessions),
        Effect.provideService(SessionShareReadonlyLocal.Service, exporter),
        Effect.provideService(SessionShareProvider.Service, provider),
        Effect.provideService(SessionShareReceiptStore.Service, receipts),
      )
      return instanceStore.provide({ directory: location }, effect)
    },
  })
  yield* startRecoveryScanner({ durable: recoveryDurable, scheduler })
  return scheduler
})

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(Service, makeSessionShareScheduler),
  deps: [
    DurableRun.node,
    Database.node,
    Session.node,
    SessionShareReadonlyLocal.node,
    SessionShareProvider.node,
    SessionShareReceiptStore.node,
    InstanceStore.node,
    LocationServiceMap.node,
  ],
})

export * as SessionShareControlScheduler from "./session-share-scheduler"
