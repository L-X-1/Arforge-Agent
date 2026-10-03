export * as ControlRunCoordinator from "./run-coordinator"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Context, Effect, Layer, Scope } from "effect"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"

/**
 * The three control operations opened by A4-R1.  This is intentionally an
 * allow-list: a server must never expose an arbitrary persisted operation as
 * something a desktop client can approve or resume.
 */
export const OperationKind = [
  "worktree.create",
  "worktree.remove",
  "worktree.reset",
  "session.revert",
  "session.unrevert",
  "session.share",
  "session.unshare",
] as const
export type OperationKind = (typeof OperationKind)[number]

export type SafeOperationKind = OperationKind | "unknown"

const operationKinds = new Set<string>(OperationKind)
const isOperationKind = (value: string): value is OperationKind => operationKinds.has(value)

/**
 * A control-run record is a projection of the durable `AgentRuntime.ControlRun`
 * aggregate.  `snapshot` is opaque here on purpose.  The Core DurableRun
 * service validates and persists it; the coordinator only passes the exact
 * frozen value to the location worker that rebuilds the ActionGateway call.
 */
export interface Record<Snapshot> {
  readonly runID: AgentRuntime.RunID
  readonly actionID: AgentRuntime.ActionID
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly operationID: string
  /** Canonical preflight binding; it deliberately excludes the caller request alias. */
  readonly bindingDigest: string
  readonly operation: string
  readonly status: AgentRuntime.RunStatus
  readonly snapshot: Snapshot
  readonly expectedSequence: number
}

/**
 * Input for the server-side, atomic request/binding claim.  The repository
 * implementation must write its rebuildable lookup index from the RunCreated
 * EventV2 commit hook.  It must not perform a second, post-event write.
 */
export interface ClaimInput<Snapshot> {
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly operationID: string
  readonly bindingDigest: string
  readonly operation: string
  readonly snapshot: Snapshot
}

/** The caller either created the canonical run or joined an identical existing one. */
export interface ClaimResult<Snapshot> {
  readonly kind: "claimed" | "existing"
  readonly record: Record<Snapshot>
  /** Presentation-only request alias; it never changes `record.subject`. */
  readonly presentedRequestID: AgentRuntime.ControlPlaneRequestID
}

export class SubjectMismatchError extends Error {
  readonly _tag = "ControlRunCoordinator.SubjectMismatchError"

  constructor(readonly runID: AgentRuntime.RunID) {
    super("The requested control operation does not belong to this project and location.")
  }
}

/**
 * The Core adapter owns all persistence.  In particular, `claim` delegates to
 * DurableRun's stable identity/CAS claim and commits any lookup projection in
 * the same transaction as RunCreated.  This contract deliberately contains no
 * mutable status or checkpoint fields, so it cannot become a parallel run
 * state machine.
 */
export interface Repository<Snapshot, ClaimError = never, ReadError = never> {
  readonly claim: (input: ClaimInput<Snapshot>) => Effect.Effect<ClaimResult<Snapshot>, ClaimError>
  readonly load: (runID: AgentRuntime.RunID) => Effect.Effect<Record<Snapshot>, ReadError>
  readonly recoverable: () => Effect.Effect<ReadonlyArray<Record<Snapshot>>, ReadError>
}

/**
 * The executor is location-bound.  It acquires the durable run lease, rebuilds
 * the exact ActionGateway input from `snapshot`, and persists every terminal
 * transition itself.  The request handler never supplies an Effect body and
 * therefore cannot make a disconnected HTTP scope own a side effect.
 */
export interface Worker<Snapshot, Error = never> {
  readonly execute: (record: Record<Snapshot>) => Effect.Effect<void, Error>
}

export type RecoveryDirective = "awaiting_authorization" | "resume" | "recover" | "none"

/** Pure, user-safe classification derived from the durable run status. */
export function recoveryDirective(status: AgentRuntime.RunStatus): RecoveryDirective {
  switch (status) {
    case "draft":
    case "preflight":
    case "queued":
      return "resume"
    case "awaiting_authorization":
      return "awaiting_authorization"
    case "running":
    case "recovering":
    case "verifying":
      return "recover"
    case "paused":
    case "completed":
    case "failed":
    case "cancelled":
      return "none"
  }
}

export type DisplayPhase =
  | "preparing"
  | "waiting_for_confirmation"
  | "queued"
  | "executing"
  | "recovering"
  | "verifying"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"

/** A display-only mapping; it is not persisted and cannot drive execution. */
export function displayPhase(status: AgentRuntime.RunStatus): DisplayPhase {
  switch (status) {
    case "draft":
    case "preflight":
      return "preparing"
    case "awaiting_authorization":
      return "waiting_for_confirmation"
    case "queued":
      return "queued"
    case "running":
      return "executing"
    case "recovering":
      return "recovering"
    case "verifying":
      return "verifying"
    case "paused":
      return "paused"
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}

const safeOperationKind = (value: string): SafeOperationKind => (isOperationKind(value) ? value : "unknown")

/**
 * Request IDs are aliases, not authority.  A repeat from another desktop
 * window joins the canonical run only when it has the same stable control
 * scope; the separately checked operation binding prevents that alias from
 * becoming a wildcard query over all runs in the project.
 */
const sameControlScope = (left: AgentRuntime.ControlPlaneSubject, right: AgentRuntime.ControlPlaneSubject) =>
  left.type === right.type &&
  left.id === right.id &&
  left.location === right.location &&
  left.project === right.project &&
  left.actor === right.actor &&
  left.principalRef === right.principalRef

const sameOperationBinding = <Snapshot>(record: Record<Snapshot>, input: StatusInput) =>
  record.operationID === input.operationID && record.bindingDigest === input.bindingDigest

/**
 * A DTO allowed to cross the server boundary.  It intentionally excludes the
 * frozen operation payload, resources, raw reason, metadata, and durable
 * checkpoint.  Unknown operation kinds cannot be approved by the client.
 */
export interface StatusDTO {
  readonly runID: AgentRuntime.RunID
  readonly actionID: AgentRuntime.ActionID
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly projectID: AgentRuntime.ControlPlaneSubject["project"]
  readonly location: AgentRuntime.ControlPlaneSubject["location"]
  readonly operation: SafeOperationKind
  readonly phase: DisplayPhase
  readonly recovery: RecoveryDirective
  readonly canApprove: boolean
}

/**
 * Direct status reads are valid only for the canonical control scope and the
 * original immutable operation binding.  The future ClaimIndex resolves a
 * persisted request alias to these values before calling the repository; this
 * type intentionally provides no in-memory fallback for an unknown alias.
 */
export interface StatusInput {
  readonly runID: AgentRuntime.RunID
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly operationID: string
  readonly bindingDigest: string
}

export interface ClaimAndStartResult {
  readonly kind: "claimed" | "existing"
  readonly status: StatusDTO
}

export function statusDTO<Snapshot>(record: Record<Snapshot>): StatusDTO {
  const operation = safeOperationKind(record.operation)
  const phase = displayPhase(record.status)
  return {
    runID: record.runID,
    actionID: record.actionID,
    requestID: record.subject.requestID,
    projectID: record.subject.project,
    location: record.subject.location,
    operation,
    phase,
    recovery: recoveryDirective(record.status),
    canApprove: operation !== "unknown" && phase === "waiting_for_confirmation",
  }
}

export interface Interface<Snapshot, ClaimError = never, ReadError = never> {
  /** Atomically claim a request/binding, then schedule its app-scoped worker. */
  readonly claimAndStart: (input: ClaimInput<Snapshot>) => Effect.Effect<ClaimAndStartResult, ClaimError>
  /** Rebuild all recoverable control operations after server/location startup. */
  readonly recover: () => Effect.Effect<void, ReadError>
  /** Schedule an already claimed record without waiting for HTTP/renderer lifetime. */
  readonly start: (record: Record<Snapshot>) => Effect.Effect<void>
  /** Return a safe, subject-scoped status projection. */
  readonly status: (input: StatusInput) => Effect.Effect<StatusDTO, ReadError | SubjectMismatchError>
  readonly active: Effect.Effect<ReadonlySet<AgentRuntime.RunID>>
}

export class Service extends Context.Service<Service, Interface<unknown, unknown, unknown>>()(
  "@arforge/ControlRunCoordinator",
) {}

/**
 * Makes the server-side coordinator.  `start` and `recover` use
 * SessionRunCoordinator's scoped FiberSet: work is detached from an HTTP
 * request, but is interrupted when the application Scope closes.  A repeated
 * request for the same durable run joins/coalesces rather than launching a
 * second gateway execution.
 */
export const make = <Snapshot, ClaimError, ReadError, WorkerError>(input: {
  readonly repository: Repository<Snapshot, ClaimError, ReadError>
  readonly worker: Worker<Snapshot, WorkerError>
  /** Durable worker failures are already mapped into Run/Action events by the worker. */
  readonly onWorkerFailure?: (record: Record<Snapshot>, cause: unknown) => Effect.Effect<void>
}): Effect.Effect<Interface<Snapshot, ClaimError, ReadError>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const records = new Map<AgentRuntime.RunID, Record<Snapshot>>()
    const coordinator = yield* SessionRunCoordinator.make<AgentRuntime.RunID, never>({
      drain: (runID) =>
        Effect.suspend(() => {
          const record = records.get(runID)
          if (!record) return Effect.void
          return input.worker
            .execute(record)
            .pipe(
              Effect.catchCause((cause) =>
                input.onWorkerFailure
                  ? input.onWorkerFailure(record, cause)
                  : Effect.logError("Control run worker failed", { runID, cause }),
              ),
            )
        }),
    })

    const start = (record: Record<Snapshot>) =>
      Effect.sync(() => {
        records.set(record.runID, record)
      }).pipe(Effect.andThen(coordinator.wake(record.runID)))

    return {
      claimAndStart: (claim) =>
        input.repository.claim(claim).pipe(
          Effect.tap((result) => start(result.record)),
          Effect.map((result) => ({ kind: result.kind, status: statusDTO(result.record) })),
        ),
      recover: () => input.repository.recoverable().pipe(Effect.andThen((records) => Effect.forEach(records, start))),
      start,
      status: ({ runID, subject, operationID, bindingDigest }) =>
        input.repository
          .load(runID)
          .pipe(
            Effect.flatMap((record) =>
              sameControlScope(record.subject, subject) &&
              sameOperationBinding(record, { runID, subject, operationID, bindingDigest })
                ? Effect.succeed(statusDTO(record))
                : Effect.fail(new SubjectMismatchError(runID)),
            ),
          ),
      active: coordinator.active,
    }
  })

/**
 * Application service layer.  The caller supplies the Core DurableRun adapter
 * only after that adapter has registered the atomic RunCreated projection
 * commit.  Keeping this boundary explicit prevents accidental localStorage or
 * HTTP-handler persistence from becoming authoritative.
 */
export const layer = (input: {
  readonly repository: Repository<unknown, unknown, unknown>
  readonly worker: Worker<unknown, unknown>
  readonly onWorkerFailure?: (record: Record<unknown>, cause: unknown) => Effect.Effect<void>
}): Layer.Layer<Service, never, Scope.Scope> => Layer.effect(Service, make(input))
