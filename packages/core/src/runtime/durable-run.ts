export * as DurableRun from "./durable-run"

import { AccessDeniedError, CurrentCheck, PendingSession, TreeScopeError } from "./subagent-control-access"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionEvent } from "@arforge-ai/schema/session-event"
import { DurableEventManifest } from "@arforge-ai/schema/durable-event-manifest"
import { Cause, Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { usesPostgres } from "../database/dialect"
import { SessionTable } from "../session/sql"
import { SessionRunUsageTable } from "./sql"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { EventSequenceTable, EventTable } from "../event/sql"
import { RuntimeInsight, digest } from "./insight"
import { canonicalHash } from "../util/canonical-hash"
import type { TrustedExperienceIdentity } from "../experience-store"
import type { DurableSettlementFacts, SettlementComponent } from "./child-settlement"
import { childResultDigest, childRunIDFor, type ChildResultInput } from "./child-contract"
import * as AdmissionEvidence from "./admission-evidence"
import { DurableAction } from "./durable-action"
import * as ChildSettlement from "./child-settlement"
import * as SettlementCoordinator from "./settlement-coordinator"
import * as SettlementOutbox from "./settlement-outbox"
import * as SettlementObservation from "./settlement-observation"
import * as SettlementObservationJournal from "./settlement-observation-journal"
import * as SettlementTransactionWriters from "./settlement-transaction-writers"
import * as SessionCheckpoint from "../session/checkpoint"
import { parseRequestEnvelopeJson } from "../session/request-envelope"

export { childResultDigest, childRunIDFor } from "./child-contract"

const settlementIntentFromReceipt = (input: {
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly idempotencyKey: string
  readonly result: AgentRuntime.ChildRunResult
  readonly intentAt: AgentRuntime.ChildRunResult["recordedAt"]
  readonly admissionEvidence?: {
    readonly evidenceID: AgentRuntime.EvidenceID
    readonly recordDigest: string
    readonly actionID?: AgentRuntime.ActionID
    readonly observationID?: AgentRuntime.ObservationID
  }
}) =>
  ChildSettlement.createIntent({
    parentRunID: input.parentRunID,
    childRunID: input.childRunID,
    idempotencyKey: input.idempotencyKey,
    result: {
      status: input.result.status,
      summary: input.result.summary,
      artifactRefs: input.result.artifactRefs,
      evidenceRefs: input.result.evidenceRefs,
      usage: input.result.usage,
    },
    ...(input.admissionEvidence === undefined ? {} : { admissionEvidence: input.admissionEvidence }),
    createdAtMs: DateTime.toEpochMillis(input.intentAt),
  })

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("DurableRun.NotFoundError", {
  runID: AgentRuntime.RunID,
}) {}

export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()(
  "DurableRun.InvalidTransitionError",
  { runID: AgentRuntime.RunID, from: AgentRuntime.RunStatus, to: AgentRuntime.RunStatus },
) {}

export class LeaseHeldError extends Schema.TaggedErrorClass<LeaseHeldError>()("DurableRun.LeaseHeldError", {
  runID: AgentRuntime.RunID,
  ownerID: Schema.String,
  expiresAtMs: Schema.Number,
}) {
  override get message() {
    return "Another execution currently owns this run. Wait for it to finish or for its lease to expire before resuming."
  }
}

export class LeaseMismatchError extends Schema.TaggedErrorClass<LeaseMismatchError>()("DurableRun.LeaseMismatchError", {
  runID: AgentRuntime.RunID,
  leaseID: AgentRuntime.LeaseID,
  ownerID: Schema.String,
}) {}

export class InvalidLeaseDurationError extends Schema.TaggedErrorClass<InvalidLeaseDurationError>()(
  "DurableRun.InvalidLeaseDurationError",
  { ttlMs: Schema.Number },
) {}

export class BudgetExhaustedError extends Schema.TaggedErrorClass<BudgetExhaustedError>()(
  "DurableRun.BudgetExhaustedError",
  {
    runID: AgentRuntime.RunID,
    attemptsUsed: Schema.Number,
    maxAttempts: Schema.Number,
    reason: Schema.optional(Schema.String),
  },
) {}

export class AttemptMismatchError extends Schema.TaggedErrorClass<AttemptMismatchError>()(
  "DurableRun.AttemptMismatchError",
  { runID: AgentRuntime.RunID, expectedAttempt: Schema.Number, receivedAttempt: Schema.Number },
) {}

export class AttemptInProgressError extends Schema.TaggedErrorClass<AttemptInProgressError>()(
  "DurableRun.AttemptInProgressError",
  { runID: AgentRuntime.RunID, attempt: Schema.Number },
) {}

export class InvalidAttemptStateError extends Schema.TaggedErrorClass<InvalidAttemptStateError>()(
  "DurableRun.InvalidAttemptStateError",
  { runID: AgentRuntime.RunID, status: AgentRuntime.RunStatus, reason: Schema.String },
) {}

export class CorruptHistoryError extends Schema.TaggedErrorClass<CorruptHistoryError>()(
  "DurableRun.CorruptHistoryError",
  { runID: AgentRuntime.RunID, sequence: Schema.Number, reason: Schema.String },
) {
  override get message() {
    return "The durable run history is invalid and cannot be recovered automatically."
  }
}

const decodeRunID = Schema.decodeUnknownOption(AgentRuntime.RunID)
const unknownCorruptRunID = AgentRuntime.RunID.make("run_corrupt_history")

export class InvalidControlClaimError extends Schema.TaggedErrorClass<InvalidControlClaimError>()(
  "DurableRun.InvalidControlClaimError",
  { operationID: AgentRuntime.ControlOperationID, reason: Schema.String },
) {}

export class ControlClaimConflictError extends Schema.TaggedErrorClass<ControlClaimConflictError>()(
  "DurableRun.ControlClaimConflictError",
  { runID: AgentRuntime.RunID, reason: Schema.String },
) {}

export class InvalidRunLeaseCapabilityError extends Schema.TaggedErrorClass<InvalidRunLeaseCapabilityError>()(
  "DurableRun.InvalidRunLeaseCapabilityError",
  { runID: Schema.optional(AgentRuntime.RunID), reason: Schema.String },
) {}

export class ChildAdmissionError extends Schema.TaggedErrorClass<ChildAdmissionError>()(
  "DurableRun.ChildAdmissionError",
  { parentRunID: AgentRuntime.RunID, reason: Schema.String },
) {}

export class ChildCapabilityDeniedError extends Schema.TaggedErrorClass<ChildCapabilityDeniedError>()(
  "DurableRun.ChildCapabilityDeniedError",
  {
    parentRunID: AgentRuntime.RunID,
    action: Schema.String,
    resources: Schema.Array(Schema.String),
    reason: Schema.String,
  },
) {}

export class ChildBudgetExceededError extends Schema.TaggedErrorClass<ChildBudgetExceededError>()(
  "DurableRun.ChildBudgetExceededError",
  { parentRunID: AgentRuntime.RunID, reason: Schema.String },
) {}

export class ChildIdempotencyConflictError extends Schema.TaggedErrorClass<ChildIdempotencyConflictError>()(
  "DurableRun.ChildIdempotencyConflictError",
  {
    parentRunID: AgentRuntime.RunID,
    idempotencyKey: Schema.String,
    childRunID: AgentRuntime.RunID,
    reason: Schema.String,
  },
) {}

export class ChildDeadlineExceededError extends Schema.TaggedErrorClass<ChildDeadlineExceededError>()(
  "DurableRun.ChildDeadlineExceededError",
  { runID: AgentRuntime.RunID, deadlineAtMs: Schema.Number },
) {}

export class ChildResultConflictError extends Schema.TaggedErrorClass<ChildResultConflictError>()(
  "DurableRun.ChildResultConflictError",
  { runID: AgentRuntime.RunID, reason: Schema.String },
) {}

export class ChildParentMismatchError extends Schema.TaggedErrorClass<ChildParentMismatchError>()(
  "DurableRun.ChildParentMismatchError",
  {
    parentRunID: AgentRuntime.RunID,
    childRunID: AgentRuntime.RunID,
    reason: Schema.String,
  },
) {}

/**
 * Prepared writes for the settlement coordinator.  These helpers intentionally
 * accept only already-validated durable receipts and an existing transaction
 * handle; all run/lease/budget authorization remains in DurableRun's normal
 * service methods.
 */
export type ChildResultTransactionWriteInput = SettlementTransactionWriters.ChildResultTransactionWriteInput
export type ChildBudgetSettlementTransactionWriteInput =
  SettlementTransactionWriters.ChildBudgetSettlementTransactionWriteInput

/**
 * Compatibility export retained for existing DurableRun callers.  The
 * implementation is now shared with the canonical settlement adapter factory;
 * only the historical error type is translated at this boundary.
 */
export const writeChildResultInTransaction = Effect.fn("DurableRun.writeChildResultInTransaction")(function* (
  input: ChildResultTransactionWriteInput,
) {
  return yield* SettlementTransactionWriters.writeChildResultInTransaction(input).pipe(
    Effect.mapError((error) => new ChildResultConflictError({ runID: input.runID, reason: error.message })),
  )
})

/** Compatibility export for the parent-budget transaction writer. */
export const writeChildBudgetSettlementInTransaction = Effect.fn("DurableRun.writeChildBudgetSettlementInTransaction")(
  function* (input: ChildBudgetSettlementTransactionWriteInput) {
    return yield* SettlementTransactionWriters.writeChildBudgetSettlementInTransaction(input).pipe(
      Effect.mapError((error) => new ChildResultConflictError({ runID: input.parentRunID, reason: error.message })),
    )
  },
)

export interface Snapshot<R extends AgentRuntime.Run = AgentRuntime.Run> {
  readonly run: R
  readonly checkpoint?: AgentRuntime.Checkpoint
  readonly lease?: AgentRuntime.RunLease
  readonly activeAttempt?: {
    readonly attempt: number
    readonly startedAt: AgentRuntime.Run["time"]["updated"]
    readonly usageBaseline?: AgentRuntime.RunUsageBaseline
  }
  readonly lastLeaseGeneration?: number
  readonly lastTransition?: {
    readonly from: AgentRuntime.RunStatus
    readonly to: AgentRuntime.RunStatus
    readonly reason: string
    readonly changedAt: AgentRuntime.Run["time"]["updated"]
  }
  readonly lastSequence: number
}

export type SessionCreateInput = Omit<
  AgentRuntime.SessionRun,
  "id" | "status" | "time" | "child" | "childResult" | "childBudgetReserved"
> & {
  readonly id?: AgentRuntime.RunID
}
export type ControlCreateInput = Omit<AgentRuntime.ControlRun, "id" | "status" | "time"> & {
  readonly id?: never
}
export type CreateInput = SessionCreateInput
export interface SessionCreateOptions {
  /** Root Session execution must never allocate a parallel unfinished run. */
  readonly exclusiveSession?: boolean
  /** Committed with RunCreated so no live root admission can be stolen. */
  readonly initialLease?: { readonly ownerID: string; readonly ttlMs: number }
}

export class SessionAdmissionConflictError extends Schema.TaggedErrorClass<SessionAdmissionConflictError>()(
  "DurableRun.SessionAdmissionConflict",
  { sessionID: AgentRuntime.SessionRun.fields.sessionID, runID: AgentRuntime.RunID, reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}
export type SessionSnapshot = Snapshot<AgentRuntime.SessionRun>

export type PendingCancellationBlocker =
  | "child-run"
  | "lease-held"
  | "not-pending"
  | "execution-started"
  | "dependent-work"
export type RequestAbandonmentBlocker = "child-run" | "owned-job" | "lease-held" | "not-paused" | "dependent-work"
/** The existing Run transition records this decision; it does not resolve remote effects or usage. */
export const REQUEST_ABANDONED_REASON =
  "User abandoned the inspected unknown request without replay; remote outcome and usage remain unknown"
export class RequestAbandonmentError extends Schema.TaggedErrorClass<RequestAbandonmentError>()(
  "DurableRun.RequestAbandonmentError",
  {
    code: Schema.Literals([
      "foreign-session",
      "stale-revision",
      "confirmation-required",
      "request-unverified",
      "request-mismatch",
      "child-run",
      "owned-job",
      "lease-held",
      "not-paused",
      "dependent-work",
    ]),
  },
) {
  override get message() {
    return `The unknown request cannot be abandoned (${this.code}); original execution and usage records are retained.`
  }
}
export interface SessionRecoveryItem {
  readonly runID: AgentRuntime.RunID
  readonly sessionID: AgentRuntime.SessionRun["sessionID"]
  readonly status: AgentRuntime.RunStatus
  readonly revision: number
  readonly admissionRecorded: boolean
  readonly leaseExpiresAt: number | null
  readonly cancellationBlocker: PendingCancellationBlocker | null
  readonly request?: {
    readonly eventID: string
    readonly digest: string
    readonly outcome: "unknown"
    readonly abandonmentBlocker: RequestAbandonmentBlocker | null
  }
}
export class PendingCancellationError extends Schema.TaggedErrorClass<PendingCancellationError>()(
  "DurableRun.PendingCancellationError",
  {
    code: Schema.Literals([
      "foreign-session",
      "stale-revision",
      "child-run",
      "lease-held",
      "not-pending",
      "execution-started",
      "dependent-work",
    ]),
  },
) {
  override get message() {
    return {
      "foreign-session": "The selected run does not belong to this session.",
      "stale-revision": "The run changed after inspection. Inspect it again before deciding to cancel.",
      "child-run": "Child runs must be cancelled through their parent task.",
      "lease-held": "Another worker still owns this run. Wait for its lease to expire or stop that worker normally.",
      "not-pending": "This run is not an unstarted pending task; no cancellation was recorded.",
      "execution-started": "Execution has already started. Pending-task cancellation cannot resolve its outcome.",
      "dependent-work": "This run has durable work or accounting records that require recovery before cancellation.",
    }[this.code]
  }
}
export type ControlSnapshot = Snapshot<AgentRuntime.ControlRun>
export type ChildSnapshot = Snapshot<AgentRuntime.SessionRun> & {
  readonly run: AgentRuntime.SessionRun & { readonly child: AgentRuntime.ChildRunBinding }
}

export type ChildCreateInput = Omit<
  SessionCreateInput,
  "id" | "sessionID" | "child" | "childResult" | "childBudgetReserved" | "admission"
> & {
  readonly sessionID: AgentRuntime.SessionRun["sessionID"]
  readonly parentRunID: AgentRuntime.RunID
  readonly idempotencyKey: string
  /** Optional profile/runtime descriptor binding; omitted by legacy children. */
  readonly runtimeDescriptorDigest?: string
  /** Optional payload-free admission evidence; omitted by legacy children. */
  readonly runtimeAdmission?: AgentRuntime.ChildRuntimeAdmission
  readonly delegatedObjective: string
  readonly allowedCapabilities: ReadonlyArray<AgentRuntime.ChildCapability>
  readonly project: NonNullable<AgentRuntime.SessionRun["project"]>
  readonly location: NonNullable<AgentRuntime.SessionRun["location"]>
  readonly expectedDeliverable: AgentRuntime.ChildExpectedDeliverable
  readonly deadlineAt?: AgentRuntime.ChildRunBinding["deadlineAt"]
}

export type ChildCancelInput = {
  readonly runID: AgentRuntime.RunID
  readonly reason: string
  readonly recursive?: boolean
}

/**
 * Parent-scoped child cancellation. A bare child run ID is intentionally not
 * sufficient for this control path; the immutable parent binding is checked
 * before any durable transition is attempted.
 */
export type ParentChildCancelInput = {
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly reason: string
  readonly recursive?: boolean
}

export const DEFAULT_CHILD_MAX_DEPTH = 8
export const DEFAULT_CHILD_MAX_CONCURRENCY = 32

const RunLeaseCapabilityBrand: unique symbol = Symbol("@arforge/v2/DurableRun/control-lease-capability")
export interface RunLeaseCapability {
  readonly [RunLeaseCapabilityBrand]: typeof RunLeaseCapabilityBrand
}

interface RunLeaseCapabilityBinding {
  readonly runID: AgentRuntime.RunID
  readonly leaseID: AgentRuntime.LeaseID
  readonly ownerID: string
  readonly generation: number
  readonly heartbeatAtMs: number
  readonly expiresAtMs: number
}
export interface ControlClaimResult {
  /** Whether this caller atomically created the canonical control run or joined it. */
  readonly kind: "claimed" | "existing"
  /** The immutable snapshot held by the canonical run. */
  readonly snapshot: ControlSnapshot
  /** The request that presented this claim; it never rewrites the canonical subject. */
  readonly presentedRequestID: AgentRuntime.ControlPlaneRequestID
}

/**
 * Runs inside EventV2's RunCreated transaction. Only trusted server-side
 * coordinators receive this seam; it prevents a control index/event crash
 * gap without exposing a database write to a renderer or tool.
 */
export interface ControlClaimOptions {
  readonly onCreated?: (input: {
    readonly run: AgentRuntime.ControlRun
    readonly sequence: number
  }) => Effect.Effect<void>
}

/** Pure updater: may run again after an event-sequence conflict. Never perform side effects here. */
export type CheckpointState =
  | Readonly<Record<string, unknown>>
  | ((current: Readonly<Record<string, unknown>> | undefined) => Readonly<Record<string, unknown>>)

export interface CheckpointExecution {
  readonly leaseID: AgentRuntime.LeaseID
  readonly ownerID: string
  readonly attempt: number
}

export interface Interface {
  readonly create: (input: CreateInput, options?: SessionCreateOptions) => Effect.Effect<SessionSnapshot>
  /** Read-only projection of the existing unfinished run facts, not another recovery state store. */
  readonly sessionRecovery: (
    sessionID: AgentRuntime.SessionRun["sessionID"],
  ) => Effect.Effect<
    ReadonlyArray<SessionRecoveryItem>,
    | NotFoundError
    | CorruptHistoryError
    | AccessDeniedError
    | TreeScopeError
    | RequestAbandonmentError
    | DurableAction.CorruptHistoryError
  >
  /** Explicitly cancel only the inspected, unstarted SessionRun; accepted input and history stay intact. */
  readonly cancelPendingSession: (input: {
    readonly sessionID: AgentRuntime.SessionRun["sessionID"]
    readonly runID: AgentRuntime.RunID
    readonly expectedSequence: number
  }) => Effect.Effect<
    SessionSnapshot,
    PendingCancellationError | NotFoundError | CorruptHistoryError | AccessDeniedError | TreeScopeError
  >
  /** Explicitly abandon only this inspected unknown request. Never resend, refund or delete its original records. */
  readonly abandonSessionRequest: (input: {
    readonly sessionID: AgentRuntime.SessionRun["sessionID"]
    readonly runID: AgentRuntime.RunID
    readonly expectedSequence: number
    readonly requestEventID: string
    readonly requestDigest: string
    readonly acknowledgeUnknownOutcome: boolean
  }) => Effect.Effect<
    SessionSnapshot,
    | RequestAbandonmentError
    | NotFoundError
    | CorruptHistoryError
    | AccessDeniedError
    | TreeScopeError
    | DurableAction.CorruptHistoryError
  >
  readonly createChild: (
    input: ChildCreateInput,
  ) => Effect.Effect<
    ChildSnapshot,
    | NotFoundError
    | CorruptHistoryError
    | ChildAdmissionError
    | ChildCapabilityDeniedError
    | ChildBudgetExceededError
    | ChildIdempotencyConflictError
  >
  readonly listChildren: (input: {
    readonly parentRunID: AgentRuntime.RunID
    readonly includeTerminal?: boolean
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<ChildSnapshot>, CorruptHistoryError | NotFoundError>
  readonly recoverChildren: (input?: {
    readonly parentRunID?: AgentRuntime.RunID
  }) => Effect.Effect<
    number,
    CorruptHistoryError | NotFoundError | ChildAdmissionError | AccessDeniedError | TreeScopeError
  >
  readonly recordChildResult: (input: {
    readonly runID: AgentRuntime.RunID
    readonly result: ChildResultInput
    /** Worker-bound receipt submission; recovery callers retain their existing contract. */
    readonly execution?: CheckpointExecution
    /** Optional payload-free admission Evidence receipt for the recovery intent. */
    readonly admissionEvidence?: ChildSettlement.AdmissionEvidenceReceipt
    /**
     * Trusted owner identity for an Evidence-bearing same-transaction
     * settlement. Tenant/user must match the request principal; the actor is
     * included in the immutable admission digest. Recovery-outbox callers do
     * not need to provide this field.
     */
    readonly settlementIdentity?: TrustedExperienceIdentity
    /**
     * `auto` (the default) uses the durable recovery outbox. Explicit
     * same-transaction requests fail closed until the production gate is
     * enabled; they never silently downgrade to a different commit mode.
     */
    readonly settlementMode?: "auto" | ChildSettlement.SettlementCommitMode
  }) => Effect.Effect<
    ChildSnapshot,
    | NotFoundError
    | CorruptHistoryError
    | ChildResultConflictError
    | ChildAdmissionError
    | InvalidRunLeaseCapabilityError
  >
  /**
   * Read the DurableRun-owned components of a settlement intent without
   * mutating either aggregate. Evidence is deliberately resolved by
   * ExperienceStore so no second Evidence owner is introduced here.
   */
  readonly readChildSettlementFacts: (input: {
    readonly parentRunID: AgentRuntime.RunID
    readonly childRunID: AgentRuntime.RunID
  }) => Effect.Effect<DurableSettlementFacts, NotFoundError | CorruptHistoryError | ChildParentMismatchError>
  /** Read the immutable parent-owned settlement intent without mutating it. */
  readonly readChildSettlementIntent: (input: {
    readonly parentRunID: AgentRuntime.RunID
    readonly childRunID: AgentRuntime.RunID
  }) => Effect.Effect<
    ChildSettlement.SettlementIntent | undefined,
    NotFoundError | CorruptHistoryError | ChildParentMismatchError
  >
  /** Rebuild a payload-free settlement observation checkpoint from the parent Run journal. */
  readonly readSettlementObservation: (input: {
    readonly parentRunID: AgentRuntime.RunID
    readonly observerID: string
    readonly minimumSamples?: number
  }) => Effect.Effect<
    SettlementObservation.SettlementObservationCheckpoint | undefined,
    NotFoundError | CorruptHistoryError
  >
  readonly cancel: (
    input: ChildCancelInput,
  ) => Effect.Effect<
    Snapshot,
    | NotFoundError
    | CorruptHistoryError
    | InvalidTransitionError
    | AttemptMismatchError
    | InvalidAttemptStateError
    | ChildAdmissionError
    | InvalidRunLeaseCapabilityError
    | AccessDeniedError
    | TreeScopeError
  >
  /** Cancel a child only when the supplied parent matches its immutable binding. */
  readonly cancelChild: (
    input: ParentChildCancelInput,
  ) => Effect.Effect<
    ChildSnapshot,
    | NotFoundError
    | CorruptHistoryError
    | InvalidTransitionError
    | AttemptMismatchError
    | InvalidAttemptStateError
    | ChildAdmissionError
    | ChildParentMismatchError
    | InvalidRunLeaseCapabilityError
    | AccessDeniedError
    | TreeScopeError
  >
  readonly claimControl: (
    input: ControlCreateInput,
    options?: ControlClaimOptions,
  ) => Effect.Effect<ControlClaimResult, InvalidControlClaimError | ControlClaimConflictError>
  readonly load: (runID: AgentRuntime.RunID) => Effect.Effect<Snapshot, NotFoundError | CorruptHistoryError>
  readonly transition: (input: {
    readonly runID: AgentRuntime.RunID
    readonly to: AgentRuntime.RunStatus
    readonly reason: string
    /** Bind post-attempt worker transitions to the same live execution lease. */
    readonly execution?: CheckpointExecution
  }) => Effect.Effect<
    Snapshot,
    NotFoundError | CorruptHistoryError | InvalidTransitionError | InvalidRunLeaseCapabilityError
  >
  readonly transitionControl: (
    capability: RunLeaseCapability,
    input: { readonly runID: AgentRuntime.RunID; readonly to: AgentRuntime.RunStatus; readonly reason: string },
  ) => Effect.Effect<
    ControlSnapshot,
    NotFoundError | CorruptHistoryError | InvalidTransitionError | InvalidRunLeaseCapabilityError
  >
  readonly checkpoint: (input: {
    readonly runID: AgentRuntime.RunID
    readonly state: CheckpointState
    readonly execution?: CheckpointExecution
    readonly lastActionID?: AgentRuntime.ActionID
  }) => Effect.Effect<AgentRuntime.Checkpoint, NotFoundError | CorruptHistoryError | InvalidRunLeaseCapabilityError>
  readonly checkpointControl: (
    capability: RunLeaseCapability,
    input: {
      readonly runID: AgentRuntime.RunID
      readonly state: CheckpointState
      readonly lastActionID?: AgentRuntime.ActionID
    },
  ) => Effect.Effect<AgentRuntime.Checkpoint, NotFoundError | CorruptHistoryError | InvalidRunLeaseCapabilityError>
  readonly beginAttempt: (input: {
    readonly runID: AgentRuntime.RunID
    readonly usageBaseline?: AgentRuntime.RunUsageBaseline
    /** Bind the previous attempt count and admission lease before incrementing. */
    readonly execution?: CheckpointExecution
  }) => Effect.Effect<
    Snapshot,
    | NotFoundError
    | CorruptHistoryError
    | BudgetExhaustedError
    | AttemptInProgressError
    | InvalidAttemptStateError
    | ChildDeadlineExceededError
    | InvalidRunLeaseCapabilityError
  >
  readonly beginControlAttempt: (
    capability: RunLeaseCapability,
    input: { readonly runID: AgentRuntime.RunID; readonly usageBaseline?: AgentRuntime.RunUsageBaseline },
  ) => Effect.Effect<
    ControlSnapshot,
    | NotFoundError
    | CorruptHistoryError
    | BudgetExhaustedError
    | AttemptInProgressError
    | InvalidAttemptStateError
    | ChildDeadlineExceededError
    | InvalidRunLeaseCapabilityError
  >
  readonly finishAttempt: (input: {
    readonly runID: AgentRuntime.RunID
    readonly attempt: number
    /** Fence a SessionRun worker against takeover during usage collection. */
    readonly execution?: CheckpointExecution
    readonly outcome: "completed" | "failed" | "interrupted"
    readonly durationMs: number
    readonly costMicros: number
    readonly tokens: number
  }) => Effect.Effect<
    Snapshot,
    | NotFoundError
    | CorruptHistoryError
    | AttemptMismatchError
    | InvalidAttemptStateError
    | InvalidRunLeaseCapabilityError
  >
  readonly finishControlAttempt: (
    capability: RunLeaseCapability,
    input: {
      readonly runID: AgentRuntime.RunID
      readonly attempt: number
      readonly outcome: "completed" | "failed" | "interrupted"
      readonly durationMs: number
      readonly costMicros: number
      readonly tokens: number
    },
  ) => Effect.Effect<
    ControlSnapshot,
    | NotFoundError
    | CorruptHistoryError
    | AttemptMismatchError
    | InvalidAttemptStateError
    | InvalidRunLeaseCapabilityError
  >
  readonly recoverable: (
    sessionID?: AgentRuntime.SessionRun["sessionID"],
  ) => Effect.Effect<ReadonlyArray<SessionSnapshot>>
  readonly recoverableControl: (
    subject?: AgentRuntime.ControlPlaneSubject,
  ) => Effect.Effect<ReadonlyArray<ControlSnapshot>>
  readonly orphaned: (
    sessionID?: AgentRuntime.SessionRun["sessionID"],
    options?: { readonly includePendingChildren?: boolean },
  ) => Effect.Effect<ReadonlyArray<SessionSnapshot>>
  readonly orphanedControl: (
    subject?: AgentRuntime.ControlPlaneSubject,
  ) => Effect.Effect<ReadonlyArray<ControlSnapshot>>
  readonly acquireLease: (input: {
    readonly runID: AgentRuntime.RunID
    readonly ownerID: string
    readonly ttlMs: number
    /** False requires a fresh lease even when the current owner string matches. */
    readonly reuseExisting?: boolean
  }) => Effect.Effect<
    Snapshot,
    NotFoundError | CorruptHistoryError | LeaseHeldError | InvalidLeaseDurationError | InvalidRunLeaseCapabilityError
  >
  readonly acquireControlLease: (input: {
    readonly runID: AgentRuntime.RunID
    readonly ownerID: string
    readonly ttlMs: number
  }) => Effect.Effect<
    { readonly snapshot: ControlSnapshot; readonly capability: RunLeaseCapability },
    NotFoundError | CorruptHistoryError | LeaseHeldError | InvalidLeaseDurationError | InvalidRunLeaseCapabilityError
  >
  readonly validateControlLease: (
    capability: RunLeaseCapability,
  ) => Effect.Effect<ControlSnapshot, NotFoundError | CorruptHistoryError | InvalidRunLeaseCapabilityError>
  /**
   * Read-only validation for a SessionRun execution lease.  A session lease
   * is intentionally not a bearer capability (unlike a control lease), so
   * every parent-scoped operation must re-check its run/lease/owner tuple and
   * expiry against the durable aggregate before it mutates anything.
   */
  readonly validateLease: (input: {
    readonly runID: AgentRuntime.RunID
    readonly leaseID: AgentRuntime.LeaseID
    readonly ownerID: string
    /** Trusted owner transaction: lock the aggregate before reading its lease. */
    readonly transaction?: Database.Transaction
  }) => Effect.Effect<
    Snapshot,
    NotFoundError | CorruptHistoryError | LeaseMismatchError | InvalidRunLeaseCapabilityError
  >
  readonly heartbeat: (input: {
    readonly runID: AgentRuntime.RunID
    readonly leaseID: AgentRuntime.LeaseID
    readonly ownerID: string
    readonly ttlMs: number
  }) => Effect.Effect<
    Snapshot,
    | NotFoundError
    | CorruptHistoryError
    | LeaseMismatchError
    | InvalidLeaseDurationError
    | InvalidRunLeaseCapabilityError
  >
  readonly heartbeatControl: (
    capability: RunLeaseCapability,
    input: { readonly runID: AgentRuntime.RunID; readonly ttlMs: number },
  ) => Effect.Effect<
    { readonly snapshot: ControlSnapshot; readonly capability: RunLeaseCapability },
    | NotFoundError
    | CorruptHistoryError
    | LeaseMismatchError
    | InvalidLeaseDurationError
    | InvalidRunLeaseCapabilityError
  >
  readonly releaseLease: (input: {
    readonly runID: AgentRuntime.RunID
    readonly leaseID: AgentRuntime.LeaseID
    readonly ownerID: string
    readonly reason: string
  }) => Effect.Effect<
    Snapshot,
    NotFoundError | CorruptHistoryError | LeaseMismatchError | InvalidRunLeaseCapabilityError
  >
  readonly releaseControlLease: (
    capability: RunLeaseCapability,
    input: { readonly runID: AgentRuntime.RunID; readonly reason: string },
  ) => Effect.Effect<
    ControlSnapshot,
    NotFoundError | CorruptHistoryError | LeaseMismatchError | InvalidRunLeaseCapabilityError
  >
  readonly list: (input?: {
    readonly sessionID?: AgentRuntime.SessionRun["sessionID"]
    readonly subject?: AgentRuntime.ControlPlaneSubject
    readonly limit?: number
    /** Startup recovery may quarantine one corrupt aggregate and continue. */
    readonly skipCorrupt?: boolean
  }) => Effect.Effect<ReadonlyArray<Snapshot>, CorruptHistoryError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/DurableRun") {}

const transitions: Readonly<Record<AgentRuntime.RunStatus, ReadonlySet<AgentRuntime.RunStatus>>> = {
  draft: new Set(["preflight", "cancelled"]),
  preflight: new Set(["awaiting_authorization", "queued", "failed", "cancelled"]),
  awaiting_authorization: new Set(["queued", "paused", "failed", "cancelled"]),
  queued: new Set(["running", "paused", "failed", "cancelled"]),
  running: new Set(["paused", "recovering", "verifying", "completed", "failed", "cancelled"]),
  paused: new Set(["queued", "recovering", "failed", "cancelled"]),
  recovering: new Set(["running", "paused", "verifying", "failed", "cancelled"]),
  verifying: new Set(["completed", "failed", "paused", "recovering", "cancelled"]),
  completed: new Set(),
  failed: new Set(["recovering"]),
  cancelled: new Set(),
}

export function canTransition(from: AgentRuntime.RunStatus, to: AgentRuntime.RunStatus) {
  return transitions[from].has(to)
}

const leaseActive = (lease: AgentRuntime.RunLease | undefined, nowMs: number) =>
  lease !== undefined && DateTime.toEpochMillis(lease.expiresAt) > nowMs

const validTtl = (ttlMs: number) => Number.isSafeInteger(ttlMs) && ttlMs > 0
const usageCounter = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0
const normalizedUsageBaseline = (value: AgentRuntime.RunUsageBaseline | undefined) =>
  value
    ? AgentRuntime.RunUsageBaseline.make({
        costMicros: usageCounter(value.costMicros),
        tokens: usageCounter(value.tokens),
      })
    : undefined

/**
 * Computes a provider-call output allowance from settled run usage, active
 * child reservations, and the active attempt's cumulative Session baseline.
 * Input tokens are estimated separately so output cannot claim the entire
 * remaining total-token budget.
 */
export const providerOutputTokenAllowance = (input: {
  readonly snapshot: Snapshot
  readonly cumulativeSessionTokens: number
  readonly estimatedInputTokens: number
  readonly modelMaxOutputTokens?: number
}) => {
  const run = input.snapshot.run
  const baseline = input.snapshot.activeAttempt?.usageBaseline?.tokens ?? 0
  const inFlightTokens = input.snapshot.activeAttempt
    ? Math.max(0, usageCounter(input.cumulativeSessionTokens) - baseline)
    : 0
  const reservedTokens = "childBudgetReserved" in run ? (run.childBudgetReserved?.tokens ?? 0) : 0
  const remainingTotal = Math.max(0, run.budget.maxTokens - run.budget.tokensUsed - reservedTokens - inFlightTokens)
  const remainingOutput = Math.max(0, remainingTotal - usageCounter(input.estimatedInputTokens))
  const modelLimit = usageCounter(input.modelMaxOutputTokens ?? 0)
  return modelLimit > 0 ? Math.min(remainingOutput, modelLimit) : remainingOutput
}

/** Canonical resume-token formula shared by persistence, replay, and independent verification. */
export const checkpointResumeToken = (checkpoint: Omit<AgentRuntime.Checkpoint, "resumeToken">) =>
  digest({
    checkpointID: checkpoint.id,
    runID: checkpoint.runID,
    lastActionID: checkpoint.lastActionID ?? null,
    eventSequence: checkpoint.eventSequence,
    stateDigest: checkpoint.stateDigest,
    createdAt: DateTime.toEpochMillis(checkpoint.createdAt),
  })

const sequenceConflict = (cause: Cause.Cause<unknown>) =>
  cause.reasons
    .filter(Cause.isDieReason)
    .some((reason) => reason.defect instanceof EventV2.AggregateSequenceConflictError)

const sessionRun = (run: AgentRuntime.Run): run is AgentRuntime.SessionRun => "sessionID" in run
const controlRun = (run: AgentRuntime.Run): run is AgentRuntime.ControlRun => "subject" in run
const sessionSnapshot = (snapshot: Snapshot): snapshot is SessionSnapshot => sessionRun(snapshot.run)

const pendingSessionAdmission = (snapshot: SessionSnapshot) =>
  snapshot.run.admission?.owner === "session-runner" &&
  !snapshot.run.child &&
  ["draft", "preflight", "queued"].includes(snapshot.run.status) &&
  snapshot.run.budget.attemptsUsed === 0 &&
  snapshot.activeAttempt === undefined
const controlSnapshot = (snapshot: Snapshot): snapshot is ControlSnapshot => controlRun(snapshot.run)
const childRun = (
  run: AgentRuntime.Run,
): run is AgentRuntime.SessionRun & { readonly child: AgentRuntime.ChildRunBinding } =>
  sessionRun(run) && run.child !== undefined

const runtimeDescriptorDigestPattern = /^[a-f0-9]{64}$/i

/**
 * Admission evidence is optional for legacy children, but when present it is
 * an immutable, successful custom-agent proof.  The descriptor digest must
 * be the same digest used by the child binding and evidence references must
 * not be duplicated; a malformed receipt is never allowed to reach a
 * durable event or a recovery replay.
 */
const validRuntimeAdmission = (
  binding: Pick<AgentRuntime.ChildRunBinding, "runtimeDescriptorDigest" | "runtimeAdmission">,
) => {
  const admission = binding.runtimeAdmission
  if (admission === undefined) return true
  const evidence = admission.evidence
  return (
    evidence.valid &&
    evidence.decision === "admitted" &&
    evidence.status === "admitted" &&
    evidence.ready &&
    evidence.descriptor_digest !== undefined &&
    binding.runtimeDescriptorDigest === evidence.descriptor_digest &&
    new Set(admission.evidenceRefs).size === admission.evidenceRefs.length
  )
}

/**
 * Admission evidence is part of the terminal child receipt as well as the
 * creation binding.  This keeps a successful child from settling without the
 * proof that allowed it to start, while leaving legacy children unchanged.
 */
const validRuntimeEvidenceReferences = (
  binding: Pick<AgentRuntime.ChildRunBinding, "runtimeAdmission">,
  result: Pick<AgentRuntime.ChildRunResult, "evidenceRefs">,
) => {
  const required = binding.runtimeAdmission?.evidenceRefs ?? []
  if (required.length === 0) return true
  const actual = new Set(result.evidenceRefs)
  return actual.size === result.evidenceRefs.length && required.every((evidenceID) => actual.has(evidenceID))
}

const zeroChildBudget = (): AgentRuntime.ChildBudgetAmount => ({ attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 })
const addChildBudget = (
  left: AgentRuntime.ChildBudgetAmount,
  right: AgentRuntime.ChildBudgetAmount,
): AgentRuntime.ChildBudgetAmount => ({
  attempts: left.attempts + right.attempts,
  durationMs: left.durationMs + right.durationMs,
  costMicros: left.costMicros + right.costMicros,
  tokens: left.tokens + right.tokens,
})
const subtractChildBudget = (
  left: AgentRuntime.ChildBudgetAmount,
  right: AgentRuntime.ChildBudgetAmount,
): AgentRuntime.ChildBudgetAmount => ({
  attempts: Math.max(0, left.attempts - right.attempts),
  durationMs: Math.max(0, left.durationMs - right.durationMs),
  costMicros: Math.max(0, left.costMicros - right.costMicros),
  tokens: Math.max(0, left.tokens - right.tokens),
})
const childBudgetFromRun = (run: AgentRuntime.SessionRun): AgentRuntime.ChildBudgetAmount => ({
  attempts: run.budget.attemptsUsed,
  durationMs: run.budget.durationMsUsed,
  costMicros: run.budget.costMicrosUsed,
  tokens: run.budget.tokensUsed,
})
const childBudgetMaxFromRun = (run: AgentRuntime.SessionRun): AgentRuntime.ChildBudgetAmount => ({
  attempts: run.budget.maxAttempts,
  durationMs: run.budget.maxDurationMs,
  costMicros: run.budget.maxCostMicros,
  tokens: run.budget.maxTokens,
})
const sameChildBudget = (left: AgentRuntime.ChildBudgetAmount, right: AgentRuntime.ChildBudgetAmount) =>
  left.attempts === right.attempts &&
  left.durationMs === right.durationMs &&
  left.costMicros === right.costMicros &&
  left.tokens === right.tokens
const childBudgetWithin = (actual: AgentRuntime.ChildBudgetAmount, max: AgentRuntime.ChildBudgetAmount) =>
  actual.attempts <= max.attempts &&
  actual.durationMs <= max.durationMs &&
  actual.costMicros <= max.costMicros &&
  actual.tokens <= max.tokens

const defaultReadOnlyCapability = (): AgentRuntime.ChildCapability => ({
  action: "*",
  resources: ["*"],
  access: "read",
})

const actionContained = (parent: string, child: string) => parent === "*" || parent === child
const resourceContained = (parent: string, child: string) => parent === "*" || parent === child
const capabilityContains = (parent: AgentRuntime.ChildCapability, child: AgentRuntime.ChildCapability) =>
  actionContained(parent.action, child.action) &&
  (parent.access === "write" || child.access === "read") &&
  child.resources.every((resource) => parent.resources.some((candidate) => resourceContained(candidate, resource)))

const childAdmissionFingerprint = (run: AgentRuntime.SessionRun) => {
  if (!run.child) return undefined
  return canonicalHash({
    parentRunID: run.child.parentRunID,
    idempotencyKey: run.child.idempotencyKey,
    runtimeDescriptorDigest: run.child.runtimeDescriptorDigest ?? null,
    runtimeAdmission: run.child.runtimeAdmission ?? null,
    delegatedObjective: run.child.delegatedObjective,
    allowedCapabilities: run.child.allowedCapabilities,
    project: run.child.project,
    location: run.child.location,
    expectedDeliverable: run.child.expectedDeliverable,
    deadlineAt: run.child.deadlineAt ? DateTime.toEpochMillis(run.child.deadlineAt) : null,
    depth: run.child.depth,
    budget: {
      maxAttempts: run.budget.maxAttempts,
      maxDurationMs: run.budget.maxDurationMs,
      maxCostMicros: run.budget.maxCostMicros,
      maxTokens: run.budget.maxTokens,
    },
  })
}

const childRequestFingerprint = (
  input: ChildCreateInput,
  capabilities: ReadonlyArray<AgentRuntime.ChildCapability>,
  depth: number,
) =>
  canonicalHash({
    parentRunID: input.parentRunID,
    idempotencyKey: input.idempotencyKey,
    runtimeDescriptorDigest: input.runtimeDescriptorDigest ?? null,
    runtimeAdmission: input.runtimeAdmission ?? null,
    delegatedObjective: input.delegatedObjective,
    allowedCapabilities: capabilities,
    project: input.project,
    location: input.location,
    expectedDeliverable: input.expectedDeliverable,
    deadlineAt: input.deadlineAt ? DateTime.toEpochMillis(input.deadlineAt) : null,
    depth,
    budget: {
      maxAttempts: input.budget.maxAttempts,
      maxDurationMs: input.budget.maxDurationMs,
      maxCostMicros: input.budget.maxCostMicros,
      maxTokens: input.budget.maxTokens,
    },
  })

const sameControlSubject = (left: AgentRuntime.ControlPlaneSubject, right: AgentRuntime.ControlPlaneSubject) =>
  left.id === right.id &&
  left.location === right.location &&
  left.project === right.project &&
  left.actor === right.actor &&
  left.principalRef === right.principalRef &&
  left.requestID === right.requestID

const sameControlClaim = (left: AgentRuntime.ControlRun, right: AgentRuntime.ControlRun) => {
  const leftHash = canonicalHash({
    subject: {
      id: left.subject.id,
      location: left.subject.location,
      project: left.subject.project,
      actor: left.subject.actor,
      principalRef: left.subject.principalRef,
    },
    operation: left.operation,
  })
  const rightHash = canonicalHash({
    subject: {
      id: right.subject.id,
      location: right.subject.location,
      project: right.subject.project,
      actor: right.subject.actor,
      principalRef: right.subject.principalRef,
    },
    operation: right.operation,
  })
  return leftHash !== undefined && leftHash === rightHash
}

export const controlOperationID = (input: {
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly claimDigest: string
  readonly generation: number
}): AgentRuntime.ControlOperationID | undefined => {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) return undefined
  const identity = canonicalHash({
    version: 1,
    subject: {
      id: input.subject.id,
      location: input.subject.location,
      project: input.subject.project,
      actor: input.subject.actor,
      principalRef: input.subject.principalRef,
    },
    claimDigest: input.claimDigest,
    generation: input.generation,
  })
  return identity === undefined ? undefined : AgentRuntime.ControlOperationID.make(`cop_${identity}`)
}

const controlRunIDFor = (
  subject: AgentRuntime.ControlPlaneSubject,
  operationID: AgentRuntime.ControlOperationID,
): AgentRuntime.RunID | undefined => {
  const claim = canonicalHash({
    version: 1,
    subject: {
      id: subject.id,
      location: subject.location,
      project: subject.project,
      actor: subject.actor,
      principalRef: subject.principalRef,
    },
    operationID,
  })
  return claim === undefined ? undefined : AgentRuntime.RunID.make(`run_control_${claim}`)
}

/**
 * Derive the durable run identity before the complete operation snapshot is
 * assembled. The authorization digest must bind this run ID, while the run ID
 * itself intentionally depends only on the request-independent operation ID.
 */
export const controlRunIDFromOperation = (input: {
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly operationID: AgentRuntime.ControlOperationID
}): AgentRuntime.RunID | undefined => controlRunIDFor(input.subject, input.operationID)

export const controlRunID = (input: ControlCreateInput): AgentRuntime.RunID | undefined => {
  const expectedOperationID = controlOperationID({
    subject: input.subject,
    claimDigest: input.operation.claimDigest,
    generation: input.operation.generation,
  })
  if (expectedOperationID === undefined || expectedOperationID !== input.operation.id) return undefined
  return controlRunIDFor(input.subject, input.operation.id)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const actions = yield* DurableAction.Service
    const { db } = database
    const settlementOutbox = yield* SettlementOutbox.Service
    const issuedRunLeaseCapabilities = new WeakMap<object, RunLeaseCapabilityBinding>()
    const mintRunLeaseCapability = (binding: RunLeaseCapabilityBinding): RunLeaseCapability => {
      const capability: RunLeaseCapability = {
        [RunLeaseCapabilityBrand]: RunLeaseCapabilityBrand,
      }
      Object.freeze(capability)
      issuedRunLeaseCapabilities.set(capability, binding)
      return capability
    }
    const revokeRunLeaseCapability = (capability: RunLeaseCapability) => {
      issuedRunLeaseCapabilities.delete(capability)
    }
    const controlLeaseBinding = (snapshot: ControlSnapshot): RunLeaseCapabilityBinding | undefined => {
      const lease = snapshot.lease
      if (!lease) return undefined
      return {
        runID: snapshot.run.id,
        leaseID: lease.id,
        ownerID: lease.ownerID,
        generation: lease.generation,
        heartbeatAtMs: DateTime.toEpochMillis(lease.heartbeatAt),
        expiresAtMs: DateTime.toEpochMillis(lease.expiresAt),
      }
    }

    const load = Effect.fn("DurableRun.load")(function* (
      runID: AgentRuntime.RunID,
      transaction?: Database.Transaction,
    ) {
      const readStored = (tx: Database.Transaction) =>
        Effect.gen(function* () {
          const sequence = yield* tx
            .select({ seq: EventSequenceTable.seq })
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, runID))
            .get()
            .pipe(Effect.orDie)
          const rows = yield* tx
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, runID))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)
          return { latest: sequence?.seq ?? -1, rows }
        })
      const stored = yield* (transaction ? readStored(transaction) : db.transaction(readStored)).pipe(Effect.orDie)
      const collected: AgentRuntime.RunDurableEvent[] = []
      if (stored.rows.length !== stored.latest + 1)
        return yield* new CorruptHistoryError({
          runID,
          sequence: stored.latest,
          reason: "The event sequence projection does not match the durable run event count.",
        })
      for (let expected = 0; expected < stored.rows.length; expected++) {
        const row = stored.rows[expected]!
        if (row.seq !== expected)
          return yield* new CorruptHistoryError({
            runID,
            sequence: row.seq,
            reason: `Durable run history is not contiguous; expected sequence ${expected}.`,
          })
        const definition = DurableEventManifest.AgentRunDurable.definitions.get(row.type)
        if (!definition?.durable)
          return yield* new CorruptHistoryError({
            runID,
            sequence: row.seq,
            reason: `Unknown durable event type ${row.type} exists in the run aggregate.`,
          })
        const decoded = yield* Schema.decodeUnknownEffect(AgentRuntime.RunDurableEvent, {
          errors: "all",
          onExcessProperty: "error",
          propertyOrder: "original",
        })({
          id: row.id,
          type: definition.type,
          durable: { aggregateID: row.aggregate_id, seq: row.seq, version: definition.durable.version },
          data: row.data,
        }).pipe(
          Effect.mapError(
            () =>
              new CorruptHistoryError({
                runID,
                sequence: row.seq,
                reason: `Durable run event ${row.type} failed strict schema decoding.`,
              }),
          ),
        )
        collected.push(decoded)
      }

      let run: AgentRuntime.Run | undefined
      let checkpoint: AgentRuntime.Checkpoint | undefined
      let lease: AgentRuntime.RunLease | undefined
      let activeAttempt: Snapshot["activeAttempt"]
      let lastLeaseGeneration: number | undefined
      let lastTransition: Snapshot["lastTransition"]
      const childReservations = new Map<AgentRuntime.RunID, AgentRuntime.ChildBudgetAmount>()
      const childSettlements = new Set<AgentRuntime.RunID>()
      const settlementIntents = new Map<AgentRuntime.RunID, string>()
      const settlementObservationCheckpoints = new Map<string, SettlementObservation.SettlementObservationCheckpoint>()
      const settlementObservationChildren = new Map<string, Set<AgentRuntime.RunID>>()
      for (const event of collected) {
        const sequence = event.durable?.seq ?? -1
        if (event.type === AgentRuntime.Event.ChildRunCreated.type) {
          if (run !== undefined)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A durable run aggregate may contain exactly one created event.",
            })
          if (
            sequence !== 0 ||
            event.data.runID !== runID ||
            event.data.run.id !== runID ||
            event.data.sessionID !== event.data.run.sessionID ||
            event.data.run.child === undefined ||
            event.data.run.admission !== undefined ||
            event.data.run.child.parentRunID !== event.data.parentRunID ||
            (event.data.run.child.runtimeDescriptorDigest !== undefined &&
              !runtimeDescriptorDigestPattern.test(event.data.run.child.runtimeDescriptorDigest)) ||
            !validRuntimeAdmission(event.data.run.child)
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "The child run created event does not match aggregate, session, parent, or admission identity.",
            })
          run = event.data.run
          continue
        }
        if (event.type === AgentRuntime.Event.RunCreated.type) {
          if (run !== undefined)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A durable run aggregate may contain exactly one created event.",
            })
          if (sequence !== 0 || event.data.runID !== runID || event.data.run.id !== runID)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "The session run created event does not match aggregate identity or sequence zero.",
            })
          if (event.data.sessionID !== event.data.run.sessionID)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "The session run created event session identity does not match its embedded run.",
            })
          if (event.data.run.child !== undefined)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A child SessionRun must start with the child-run.created event family.",
            })
          const initialLease = event.data.initialLease
          const createdAt = DateTime.toEpochMillis(event.data.run.time.created)
          if (
            (event.data.run.admission !== undefined && initialLease === undefined) ||
            (initialLease !== undefined &&
              (event.data.run.status !== "draft" ||
                initialLease.runID !== runID ||
                initialLease.ownerID.length === 0 ||
                initialLease.generation !== 0 ||
                DateTime.toEpochMillis(initialLease.acquiredAt) !== createdAt ||
                DateTime.toEpochMillis(initialLease.heartbeatAt) !== createdAt ||
                !validTtl(DateTime.toEpochMillis(initialLease.expiresAt) - createdAt)))
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Root admission requires a valid initial lease committed with its creation.",
            })
          run = event.data.run
          lease = initialLease
          lastLeaseGeneration = initialLease?.generation
          continue
        }
        if (event.type === AgentRuntime.Event.ControlRunCreated.type) {
          if (run !== undefined)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A durable run aggregate may contain exactly one created event.",
            })
          if (
            sequence !== 0 ||
            event.data.runID !== runID ||
            event.data.run.id !== runID ||
            !sameControlSubject(event.data.subject, event.data.run.subject)
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "The control run created event does not match aggregate or subject identity.",
            })
          const expectedOperationID = controlOperationID({
            subject: event.data.run.subject,
            claimDigest: event.data.run.operation.claimDigest,
            generation: event.data.run.operation.generation,
          })
          const expectedRunID = controlRunIDFor(event.data.run.subject, event.data.run.operation.id)
          const payloadDigest = canonicalHash(event.data.run.operation.payload)
          if (
            expectedOperationID !== event.data.run.operation.id ||
            expectedRunID !== runID ||
            payloadDigest === undefined ||
            payloadDigest !== event.data.run.operation.payloadDigest
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "The frozen control operation identity or payload digest is invalid.",
            })
          run = event.data.run
          continue
        }
        if (!run)
          return yield* new CorruptHistoryError({
            runID,
            sequence,
            reason: "The created event must be the first durable event in a run aggregate.",
          })
        if (sessionRun(run)) {
          if (event.type.startsWith("agent.control-run."))
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A session run cannot contain a control-plane @2 event.",
            })
          if (event.data.runID !== runID || !("sessionID" in event.data) || event.data.sessionID !== run.sessionID)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A session run event does not match the created run identity.",
            })
          if (
            event.type === AgentRuntime.Event.ChildRunCancelled.type ||
            event.type === AgentRuntime.Event.ChildRunResultRecorded.type
          ) {
            if (!childRun(run) || event.data.parentRunID !== run.child.parentRunID)
              return yield* new CorruptHistoryError({
                runID,
                sequence,
                reason: "A child event does not match the immutable child delegation binding.",
              })
          }
        } else {
          if (!event.type.startsWith("agent.control-run."))
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A control run cannot contain a session @1 event.",
            })
          if (
            event.data.runID !== runID ||
            !("subject" in event.data) ||
            !sameControlSubject(event.data.subject, run.subject)
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A control run event does not match the created control subject.",
            })
        }

        if (event.type === AgentRuntime.Event.ChildRunSettlementIntentRecorded.type) {
          if (
            !sessionRun(run) ||
            event.data.runID !== runID ||
            event.data.childRunID === runID ||
            event.data.sessionID !== run.sessionID ||
            !childReservations.has(event.data.childRunID) ||
            settlementIntents.has(event.data.childRunID) ||
            DateTime.toEpochMillis(event.data.intentAt) !== DateTime.toEpochMillis(event.data.result.recordedAt)
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason:
                "Child settlement intent does not match the parent aggregate, reservation, or immutable timestamp.",
            })
          try {
            const expected = settlementIntentFromReceipt({
              parentRunID: runID,
              childRunID: event.data.childRunID,
              idempotencyKey: event.data.idempotencyKey,
              result: event.data.result,
              ...(event.data.admissionEvidence === undefined
                ? {}
                : { admissionEvidence: event.data.admissionEvidence }),
              intentAt: event.data.intentAt,
            })
            if (
              expected.intentID !== event.data.intentID ||
              expected.idempotencyDigest !== event.data.idempotencyDigest ||
              expected.resultDigest !== event.data.result.resultDigest
            )
              throw new Error("settlement intent identity or result digest drift")
          } catch (cause) {
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: `Child settlement intent failed immutable validation: ${String(cause)}`,
            })
          }
          settlementIntents.set(event.data.childRunID, event.data.intentID)
          continue
        }

        if (event.type === AgentRuntime.Event.ChildRunBudgetReserved.type) {
          if (
            !sessionRun(run) ||
            event.data.childRunID === runID ||
            event.data.childRun.id !== event.data.childRunID ||
            event.data.childRun.child === undefined ||
            event.data.childRun.child.parentRunID !== runID ||
            !validRuntimeAdmission(event.data.childRun.child) ||
            childReservations.has(event.data.childRunID) ||
            !sameChildBudget(
              event.data.reservedTotal,
              addChildBudget(run.childBudgetReserved ?? zeroChildBudget(), event.data.reserved),
            )
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Child budget reservation is not a monotonic parent-scoped admission record.",
            })
          childReservations.set(event.data.childRunID, event.data.reserved)
          run = AgentRuntime.Run.make({
            ...run,
            childBudgetReserved: event.data.reservedTotal,
            time: { ...run.time, updated: event.data.reservedAt },
          })
          continue
        }

        if (event.type === AgentRuntime.Event.ChildRunBudgetSettled.type) {
          const reserved = childReservations.get(event.data.childRunID)
          const sessionRunValue = sessionRun(run) ? run : undefined
          const previous = sessionRunValue?.childBudgetReserved ?? zeroChildBudget()
          const expectedTotal = subtractChildBudget(previous, event.data.reserved)
          const nextBudget = addChildBudget(
            childBudgetFromRun(sessionRunValue ?? (run as AgentRuntime.SessionRun)),
            event.data.actual,
          )
          if (
            sessionRunValue === undefined ||
            reserved === undefined ||
            childSettlements.has(event.data.childRunID) ||
            !sameChildBudget(reserved, event.data.reserved) ||
            !childBudgetWithin(event.data.actual, event.data.reserved) ||
            !sameChildBudget(event.data.reservedTotal, expectedTotal) ||
            nextBudget.attempts > sessionRunValue.budget.maxAttempts ||
            nextBudget.durationMs > sessionRunValue.budget.maxDurationMs ||
            nextBudget.costMicros > sessionRunValue.budget.maxCostMicros ||
            nextBudget.tokens > sessionRunValue.budget.maxTokens
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Child budget settlement is duplicated, exceeds its reservation, or exceeds parent budget.",
            })
          childSettlements.add(event.data.childRunID)
          run = AgentRuntime.Run.make({
            ...run,
            budget: AgentRuntime.Budget.make({
              ...run.budget,
              attemptsUsed: nextBudget.attempts,
              durationMsUsed: nextBudget.durationMs,
              costMicrosUsed: nextBudget.costMicros,
              tokensUsed: nextBudget.tokens,
            }),
            childBudgetReserved: event.data.reservedTotal,
            time: { ...run.time, updated: event.data.settledAt },
          })
          continue
        }

        if (event.type === AgentRuntime.Event.ChildRunSettlementObservationRecorded.type) {
          if (
            !sessionRun(run) ||
            event.data.runID !== runID ||
            event.data.sessionID !== run.sessionID ||
            event.data.childRunID === runID ||
            !childSettlements.has(event.data.childRunID)
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Settlement observation journal event does not match the parent or a settled child.",
            })
          const observerID = event.data.observerID
          const children = settlementObservationChildren.get(observerID) ?? new Set<AgentRuntime.RunID>()
          if (children.has(event.data.childRunID))
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Settlement observation journal event duplicates a child sample.",
            })
          const previous = settlementObservationCheckpoints.get(observerID)
          let next: SettlementObservation.SettlementObservationCheckpoint
          try {
            next = SettlementObservation.appendSettlementObservationCheckpoint({
              observerID,
              ...(previous === undefined ? {} : { checkpoint: previous }),
              sample: event.data.sample,
              minimumSamples: event.data.minimumSamples,
            })
            if (
              event.data.sampleSequence !== next.window.sampleCount ||
              event.data.minimumSamples !== next.window.minimumSamples ||
              event.data.windowDigest !== next.window.windowDigest ||
              event.data.checkpointDigest !== next.checkpointDigest ||
              DateTime.toEpochMillis(event.data.recordedAt) !== event.data.sample.observedAtMs
            )
              throw new Error("settlement observation journal checkpoint metadata drift")
          } catch (cause) {
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: `Settlement observation journal event failed immutable validation: ${String(cause)}`,
            })
          }
          settlementObservationCheckpoints.set(observerID, next)
          children.add(event.data.childRunID)
          settlementObservationChildren.set(observerID, children)
          continue
        }

        if (event.type === AgentRuntime.Event.ChildRunResultRecorded.type) {
          if (
            !sessionRun(run) ||
            !childRun(run) ||
            run.childResult !== undefined ||
            !["completed", "failed", "cancelled"].includes(run.status) ||
            event.data.result.status !== run.status ||
            event.data.result.recordedAt === undefined ||
            childResultDigest({
              status: event.data.result.status,
              summary: event.data.result.summary,
              artifactRefs: event.data.result.artifactRefs,
              evidenceRefs: event.data.result.evidenceRefs,
              usage: event.data.result.usage,
            }) !== event.data.result.resultDigest ||
            !validRuntimeEvidenceReferences(run.child, event.data.result) ||
            !childBudgetWithin(event.data.result.usage, childBudgetMaxFromRun(run)) ||
            !sameChildBudget(event.data.result.usage, childBudgetFromRun(run))
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "The child result receipt is duplicated, non-terminal, or has an invalid digest/usage.",
            })
          run = AgentRuntime.Run.make({
            ...run,
            childResult: event.data.result,
            time: { ...run.time, updated: event.data.result.recordedAt },
          })
          continue
        }

        const session = sessionRun(run)
        const state =
          event.type === AgentRuntime.Event.ChildRunCancelled.type
            ? {
                runID: event.data.runID,
                sessionID: event.data.sessionID,
                from: event.data.from,
                to: event.data.to,
                reason: event.data.reason,
                changedAt: event.data.cancelledAt,
              }
            : event.type === AgentRuntime.Event.RunStateChanged.type ||
                event.type === AgentRuntime.Event.ControlRunStateChanged.type
              ? event.data
              : undefined
        if (state) {
          if (activeAttempt !== undefined)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A durable run cannot change state while an execution attempt is still active.",
            })
          if (state.from !== run.status || !canTransition(state.from, state.to))
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: `Invalid durable run transition ${state.from} → ${state.to}; replay state was ${run.status}.`,
            })
          lastTransition = {
            from: state.from,
            to: state.to,
            reason: state.reason,
            changedAt: state.changedAt,
          }
          const finished = ["completed", "failed", "cancelled"].includes(state.to)
          const next = {
            ...run,
            status: state.to,
            time: {
              ...run.time,
              updated: state.changedAt,
              ...(state.to === "running" && run.time.started === undefined ? { started: state.changedAt } : {}),
              ...(finished ? { finished: state.changedAt } : {}),
            },
          }
          run = AgentRuntime.Run.make(next)
          continue
        }
        const checkpointEvent =
          event.type === AgentRuntime.Event.RunCheckpointCreated.type ||
          event.type === AgentRuntime.Event.ControlRunCheckpointCreated.type
            ? event.data
            : undefined
        if (checkpointEvent) {
          const expectedStateDigest = digest(checkpointEvent.checkpoint.state)
          const expectedResumeToken = checkpointResumeToken(checkpointEvent.checkpoint)
          if (
            checkpointEvent.checkpoint.runID !== runID ||
            checkpointEvent.checkpoint.eventSequence !== sequence ||
            checkpointEvent.checkpoint.stateDigest !== expectedStateDigest ||
            checkpointEvent.checkpoint.resumeToken !== expectedResumeToken
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Checkpoint identity, event position, state digest, or resume token is invalid.",
            })
          checkpoint = checkpointEvent.checkpoint
          continue
        }
        const attemptStarted =
          event.type === AgentRuntime.Event.RunAttemptStarted.type ||
          event.type === AgentRuntime.Event.ControlRunAttemptStarted.type
            ? event.data
            : undefined
        if (attemptStarted) {
          if (
            run.status !== "running" ||
            activeAttempt !== undefined ||
            attemptStarted.attempt !== run.budget.attemptsUsed + 1 ||
            attemptStarted.attempt > run.budget.maxAttempts ||
            run.budget.durationMsUsed >= run.budget.maxDurationMs ||
            run.budget.costMicrosUsed >= run.budget.maxCostMicros ||
            run.budget.tokensUsed >= run.budget.maxTokens
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A durable run attempt is active, out of sequence, outside running state, or over budget.",
            })
          activeAttempt = {
            attempt: attemptStarted.attempt,
            startedAt: attemptStarted.startedAt,
            ...(attemptStarted.usageBaseline ? { usageBaseline: attemptStarted.usageBaseline } : {}),
          }
          const next = {
            ...run,
            budget: AgentRuntime.Budget.make({ ...run.budget, attemptsUsed: attemptStarted.attempt }),
            time: { ...run.time, updated: attemptStarted.startedAt },
          }
          run = AgentRuntime.Run.make(next)
          continue
        }
        const attemptFinished =
          event.type === AgentRuntime.Event.RunAttemptFinished.type ||
          event.type === AgentRuntime.Event.ControlRunAttemptFinished.type
            ? event.data
            : undefined
        if (attemptFinished) {
          const tokens = "tokens" in attemptFinished ? attemptFinished.tokens : 0
          if (
            run.status !== "running" ||
            activeAttempt?.attempt !== attemptFinished.attempt ||
            DateTime.toEpochMillis(attemptFinished.finishedAt) < DateTime.toEpochMillis(activeAttempt.startedAt)
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Run attempt completion has no matching active attempt, valid state, or monotonic timestamp.",
            })
          activeAttempt = undefined
          const next = {
            ...run,
            budget: AgentRuntime.Budget.make({
              ...run.budget,
              durationMsUsed: run.budget.durationMsUsed + attemptFinished.durationMs,
              costMicrosUsed: run.budget.costMicrosUsed + attemptFinished.costMicros,
              tokensUsed: run.budget.tokensUsed + tokens,
            }),
            time: { ...run.time, updated: attemptFinished.finishedAt },
          }
          run = AgentRuntime.Run.make(next)
          continue
        }
        const leaseAcquired =
          event.type === AgentRuntime.Event.RunLeaseAcquired.type ||
          event.type === AgentRuntime.Event.ControlRunLeaseAcquired.type
            ? event.data
            : undefined
        if (leaseAcquired) {
          const acquiredAt = DateTime.toEpochMillis(leaseAcquired.lease.acquiredAt)
          const heartbeatAt = DateTime.toEpochMillis(leaseAcquired.lease.heartbeatAt)
          const expiresAt = DateTime.toEpochMillis(leaseAcquired.lease.expiresAt)
          if (leaseAcquired.lease.runID !== runID || heartbeatAt < acquiredAt || expiresAt <= heartbeatAt)
            return yield* new CorruptHistoryError({ runID, sequence, reason: "Lease belongs to another run." })
          if (leaseAcquired.lease.generation !== (lastLeaseGeneration ?? -1) + 1)
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Run lease generation is not monotonic.",
            })
          if (
            lease !== undefined &&
            DateTime.toEpochMillis(lease.expiresAt) > DateTime.toEpochMillis(leaseAcquired.lease.acquiredAt)
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "A new run lease was acquired while the previous lease was still active.",
            })
          lease = leaseAcquired.lease
          lastLeaseGeneration = lease.generation
          continue
        }
        const heartbeat =
          event.type === AgentRuntime.Event.RunHeartbeatRecorded.type ||
          event.type === AgentRuntime.Event.ControlRunHeartbeatRecorded.type
            ? event.data
            : undefined
        if (heartbeat) {
          const previousHeartbeatAt = lease ? DateTime.toEpochMillis(lease.heartbeatAt) : Number.NaN
          const previousExpiresAt = lease ? DateTime.toEpochMillis(lease.expiresAt) : Number.NaN
          const heartbeatAt = DateTime.toEpochMillis(heartbeat.heartbeatAt)
          const expiresAt = DateTime.toEpochMillis(heartbeat.expiresAt)
          if (
            lease?.id !== heartbeat.leaseID ||
            lease.ownerID !== heartbeat.ownerID ||
            (!session && (!("generation" in heartbeat) || heartbeat.generation !== lease.generation)) ||
            heartbeatAt < previousHeartbeatAt ||
            heartbeatAt >= previousExpiresAt ||
            expiresAt <= heartbeatAt
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Lease heartbeat does not match the active lease.",
            })
          lease = AgentRuntime.RunLease.make({
            ...lease,
            heartbeatAt: heartbeat.heartbeatAt,
            expiresAt: heartbeat.expiresAt,
          })
          continue
        }
        const leaseReleased =
          event.type === AgentRuntime.Event.RunLeaseReleased.type ||
          event.type === AgentRuntime.Event.ControlRunLeaseReleased.type
            ? event.data
            : undefined
        if (leaseReleased) {
          const releasedAt = DateTime.toEpochMillis(leaseReleased.releasedAt)
          const previousHeartbeatAt = lease ? DateTime.toEpochMillis(lease.heartbeatAt) : Number.NaN
          if (
            lease?.id !== leaseReleased.leaseID ||
            lease.ownerID !== leaseReleased.ownerID ||
            (!session && (!("generation" in leaseReleased) || leaseReleased.generation !== lease.generation)) ||
            releasedAt < previousHeartbeatAt
          )
            return yield* new CorruptHistoryError({
              runID,
              sequence,
              reason: "Lease release does not match the active lease.",
            })
          lease = undefined
          continue
        }
        return yield* new CorruptHistoryError({ runID, sequence, reason: "Unknown run event in durable history." })
      }
      if (!run) return yield* new NotFoundError({ runID })
      return {
        run,
        ...(checkpoint ? { checkpoint } : {}),
        ...(lease ? { lease } : {}),
        ...(activeAttempt ? { activeAttempt } : {}),
        ...(lastLeaseGeneration === undefined ? {} : { lastLeaseGeneration }),
        ...(lastTransition ? { lastTransition } : {}),
        lastSequence: stored.latest,
      } satisfies Snapshot
    })

    const publishState = (
      run: AgentRuntime.Run,
      input: {
        readonly to: AgentRuntime.RunStatus
        readonly reason: string
        readonly changedAt: AgentRuntime.Run["time"]["updated"]
        readonly expectedSequence: number
        readonly commit?: EventV2.PublishOptions["commit"]
      },
    ) =>
      Effect.gen(function* () {
        if (sessionRun(run)) {
          if (childRun(run) && input.to === "cancelled") {
            yield* events.publish(
              AgentRuntime.Event.ChildRunCancelled,
              {
                runID: run.id,
                parentRunID: run.child.parentRunID,
                sessionID: run.sessionID,
                from: run.status,
                to: "cancelled",
                reason: input.reason,
                cancelledAt: input.changedAt,
              },
              {
                expectedSequence: input.expectedSequence,
                commit: () =>
                  Effect.gen(function* () {
                    yield* yield* CurrentCheck
                  }).pipe(Effect.orDie),
              },
            )
            return
          }
          yield* events.publish(
            AgentRuntime.Event.RunStateChanged,
            {
              runID: run.id,
              sessionID: run.sessionID,
              from: run.status,
              to: input.to,
              reason: input.reason,
              changedAt: input.changedAt,
            },
            {
              expectedSequence: input.expectedSequence,
              ...(input.to === "cancelled"
                ? {
                    commit: () =>
                      Effect.gen(function* () {
                        yield* yield* CurrentCheck
                        if (input.commit) yield* input.commit(input.expectedSequence + 1)
                      }).pipe(Effect.orDie),
                  }
                : {}),
            },
          )
          return
        }
        yield* events.publish(
          AgentRuntime.Event.ControlRunStateChanged,
          {
            runID: run.id,
            subject: run.subject,
            from: run.status,
            to: input.to,
            reason: input.reason,
            changedAt: input.changedAt,
          },
          { expectedSequence: input.expectedSequence },
        )
      })

    const publishCheckpoint = (run: AgentRuntime.Run, checkpoint: AgentRuntime.Checkpoint, expectedSequence: number) =>
      Effect.gen(function* () {
        if (sessionRun(run)) {
          yield* events.publish(
            AgentRuntime.Event.RunCheckpointCreated,
            { runID: run.id, sessionID: run.sessionID, checkpoint },
            { expectedSequence },
          )
          return
        }
        yield* events.publish(
          AgentRuntime.Event.ControlRunCheckpointCreated,
          { runID: run.id, subject: run.subject, checkpoint },
          { expectedSequence },
        )
      })

    const publishAttemptStarted = (
      run: AgentRuntime.Run,
      attempt: number,
      startedAt: AgentRuntime.Run["time"]["updated"],
      expectedSequence: number,
      usageBaseline?: AgentRuntime.RunUsageBaseline,
    ) =>
      Effect.gen(function* () {
        const data = { attempt, startedAt, ...(usageBaseline ? { usageBaseline } : {}) }
        if (sessionRun(run)) {
          yield* events.publish(
            AgentRuntime.Event.RunAttemptStarted,
            { runID: run.id, sessionID: run.sessionID, ...data },
            { expectedSequence },
          )
          return
        }
        yield* events.publish(
          AgentRuntime.Event.ControlRunAttemptStarted,
          { runID: run.id, subject: run.subject, ...data },
          { expectedSequence },
        )
      })

    const publishAttemptFinished = (
      run: AgentRuntime.Run,
      input: {
        readonly attempt: number
        readonly outcome: "completed" | "failed" | "interrupted"
        readonly durationMs: number
        readonly costMicros: number
        readonly tokens: number
        readonly finishedAt: AgentRuntime.Run["time"]["updated"]
        readonly expectedSequence: number
        readonly commit?: EventV2.PublishOptions["commit"]
      },
    ) =>
      Effect.gen(function* () {
        const data = {
          attempt: input.attempt,
          outcome: input.outcome,
          durationMs: input.durationMs,
          costMicros: input.costMicros,
          finishedAt: input.finishedAt,
        }
        if (sessionRun(run)) {
          yield* events.publish(
            AgentRuntime.Event.RunAttemptFinished,
            { runID: run.id, sessionID: run.sessionID, ...data, tokens: input.tokens },
            { expectedSequence: input.expectedSequence, commit: input.commit },
          )
          return
        }
        yield* events.publish(
          AgentRuntime.Event.ControlRunAttemptFinished,
          { runID: run.id, subject: run.subject, ...data, tokens: input.tokens },
          { expectedSequence: input.expectedSequence },
        )
      })

    const publishLeaseAcquired = (run: AgentRuntime.Run, lease: AgentRuntime.RunLease, expectedSequence: number) =>
      Effect.gen(function* () {
        if (sessionRun(run)) {
          yield* events.publish(
            AgentRuntime.Event.RunLeaseAcquired,
            { runID: run.id, sessionID: run.sessionID, lease },
            { expectedSequence },
          )
          return
        }
        yield* events.publish(
          AgentRuntime.Event.ControlRunLeaseAcquired,
          { runID: run.id, subject: run.subject, lease },
          { expectedSequence },
        )
      })

    const publishHeartbeat = (
      run: AgentRuntime.Run,
      input: {
        readonly leaseID: AgentRuntime.LeaseID
        readonly ownerID: string
        readonly generation: number
        readonly heartbeatAt: AgentRuntime.Run["time"]["updated"]
        readonly expiresAt: AgentRuntime.Run["time"]["updated"]
        readonly expectedSequence: number
      },
    ) =>
      Effect.gen(function* () {
        if (sessionRun(run)) {
          yield* events.publish(
            AgentRuntime.Event.RunHeartbeatRecorded,
            {
              runID: run.id,
              sessionID: run.sessionID,
              leaseID: input.leaseID,
              ownerID: input.ownerID,
              heartbeatAt: input.heartbeatAt,
              expiresAt: input.expiresAt,
            },
            { expectedSequence: input.expectedSequence },
          )
          return
        }
        yield* events.publish(
          AgentRuntime.Event.ControlRunHeartbeatRecorded,
          {
            runID: run.id,
            subject: run.subject,
            leaseID: input.leaseID,
            ownerID: input.ownerID,
            generation: input.generation,
            heartbeatAt: input.heartbeatAt,
            expiresAt: input.expiresAt,
          },
          { expectedSequence: input.expectedSequence },
        )
      })

    const publishLeaseReleased = (
      run: AgentRuntime.Run,
      input: {
        readonly leaseID: AgentRuntime.LeaseID
        readonly ownerID: string
        readonly generation: number
        readonly releasedAt: AgentRuntime.Run["time"]["updated"]
        readonly reason: string
        readonly expectedSequence: number
      },
    ) =>
      Effect.gen(function* () {
        if (sessionRun(run)) {
          yield* events.publish(
            AgentRuntime.Event.RunLeaseReleased,
            {
              runID: run.id,
              sessionID: run.sessionID,
              leaseID: input.leaseID,
              ownerID: input.ownerID,
              releasedAt: input.releasedAt,
              reason: input.reason,
            },
            { expectedSequence: input.expectedSequence },
          )
          return
        }
        yield* events.publish(
          AgentRuntime.Event.ControlRunLeaseReleased,
          {
            runID: run.id,
            subject: run.subject,
            leaseID: input.leaseID,
            ownerID: input.ownerID,
            generation: input.generation,
            releasedAt: input.releasedAt,
            reason: input.reason,
          },
          { expectedSequence: input.expectedSequence },
        )
      })

    const transitionInternal = Effect.fnUntraced(function* (
      input: {
        readonly runID: AgentRuntime.RunID
        readonly to: AgentRuntime.RunStatus
        readonly reason: string
        readonly execution?: CheckpointExecution
      },
      capability?: RunLeaseCapability,
    ) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const current = capability ? yield* validateControlLeaseFor(capability, input.runID) : yield* load(input.runID)
        if (!capability && controlSnapshot(current))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: input.runID,
            reason: "Control run transitions require an active control lease capability.",
          })
        if (current.activeAttempt !== undefined)
          return yield* new InvalidTransitionError({
            runID: input.runID,
            from: current.run.status,
            to: input.to,
          })
        if (!canTransition(current.run.status, input.to))
          return yield* new InvalidTransitionError({ runID: input.runID, from: current.run.status, to: input.to })
        const changedAt = yield* DateTime.now
        if (
          input.execution &&
          (!sessionRun(current.run) ||
            current.run.budget.attemptsUsed !== input.execution.attempt ||
            current.lease?.id !== input.execution.leaseID ||
            current.lease.ownerID !== input.execution.ownerID ||
            DateTime.toEpochMillis(current.lease.expiresAt) <= DateTime.toEpochMillis(changedAt))
        )
          return yield* new InvalidRunLeaseCapabilityError({
            runID: input.runID,
            reason: "State transition execution no longer owns the settled attempt and live lease.",
          })
        if (capability) {
          const fresh = yield* validateControlLeaseFor(capability, input.runID)
          if (fresh.lastSequence !== current.lastSequence) continue
        }
        const exit = yield* publishState(current.run, {
          to: input.to,
          reason: input.reason,
          changedAt,
          expectedSequence: current.lastSequence,
        }).pipe(Effect.exit)
        if (exit._tag === "Failure") {
          if (sequenceConflict(exit.cause)) continue
          return yield* Effect.failCause(exit.cause)
        }
        RuntimeInsight.auditRecord({
          actor: current.run.initiator,
          action: "run.state.changed",
          resource: input.runID,
          reason: input.reason,
          metadata: {
            ...(sessionRun(current.run) ? { sessionID: current.run.sessionID } : { subject: current.run.subject.id }),
            runID: input.runID,
            from: current.run.status,
            to: input.to,
          },
        })
        return yield* load(input.runID)
      }
      return yield* Effect.die(new Error(`Run state transition contention did not converge for ${input.runID}`))
    })

    const list: Interface["list"] = Effect.fn("DurableRun.list")(function* (input) {
      if (input?.sessionID !== undefined && input.subject !== undefined) return []
      const rows = yield* db
        .select({ aggregateID: EventTable.aggregate_id, data: EventTable.data, type: EventTable.type })
        .from(EventTable)
        .where(
          inArray(EventTable.type, [
            EventV2.versionedType(AgentRuntime.Event.RunCreated.type, 1),
            EventV2.versionedType(AgentRuntime.Event.ChildRunCreated.type, 1),
            EventV2.versionedType(AgentRuntime.Event.ControlRunCreated.type, 2),
          ]),
        )
        .orderBy(desc(EventTable.id))
        .all()
        .pipe(Effect.orDie)
      const seen = new Set<AgentRuntime.RunID>()
      const result: Snapshot[] = []
      for (const row of rows) {
        let created:
          | typeof AgentRuntime.Event.RunCreated.data.Type
          | typeof AgentRuntime.Event.ChildRunCreated.data.Type
          | typeof AgentRuntime.Event.ControlRunCreated.data.Type
        try {
          created =
            row.type === EventV2.versionedType(AgentRuntime.Event.RunCreated.type, 1)
              ? Schema.decodeUnknownSync(AgentRuntime.Event.RunCreated.data)(row.data)
              : row.type === EventV2.versionedType(AgentRuntime.Event.ChildRunCreated.type, 1)
                ? Schema.decodeUnknownSync(AgentRuntime.Event.ChildRunCreated.data)(row.data)
                : Schema.decodeUnknownSync(AgentRuntime.Event.ControlRunCreated.data)(row.data)
        } catch (cause) {
          if (!input?.skipCorrupt)
            return yield* new CorruptHistoryError({
              runID: Option.getOrElse(decodeRunID(row.aggregateID), () => unknownCorruptRunID),
              sequence: -1,
              reason: "A run-created event failed strict schema decoding.",
            })
          yield* Effect.logError("Skipping malformed run-created event during recovery scan", {
            aggregateID: row.aggregateID,
            cause,
          })
          continue
        }
        if (seen.has(created.runID)) continue
        seen.add(created.runID)
        if (input?.sessionID !== undefined && ("subject" in created || created.sessionID !== input.sessionID)) continue
        if (
          input?.subject !== undefined &&
          (!("subject" in created) || !sameControlSubject(created.subject, input.subject))
        )
          continue
        const loaded = yield* load(created.runID).pipe(
          Effect.catchTag(
            "DurableRun.NotFoundError",
            () =>
              new CorruptHistoryError({
                runID: created.runID,
                sequence: -1,
                reason: "A run-created event is indexed but its aggregate cannot be reconstructed.",
              }),
          ),
          Effect.exit,
        )
        if (loaded._tag === "Failure") {
          if (!input?.skipCorrupt) return yield* Effect.failCause(loaded.cause)
          yield* Effect.logError("Skipping corrupt durable run during recovery scan", {
            runID: created.runID,
            cause: loaded.cause,
          })
          continue
        }
        result.push(loaded.value)
        if (result.length >= (input?.limit ?? 100)) break
      }
      return result
    })

    const acquireLease: Interface["acquireLease"] = Effect.fn("DurableRun.acquireLease")(function* (input) {
      if (!validTtl(input.ttlMs)) return yield* new InvalidLeaseDurationError({ ttlMs: input.ttlMs })
      for (let attempt = 0; attempt < 6; attempt++) {
        const current = yield* load(input.runID)
        if (controlSnapshot(current))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: input.runID,
            reason: "Control runs must acquire ownership through acquireControlLease.",
          })
        const now = yield* DateTime.now
        const nowMs = DateTime.toEpochMillis(now)
        if (leaseActive(current.lease, nowMs)) {
          if (input.reuseExisting === false || current.lease!.ownerID !== input.ownerID)
            return yield* new LeaseHeldError({
              runID: input.runID,
              ownerID: current.lease!.ownerID,
              expiresAtMs: DateTime.toEpochMillis(current.lease!.expiresAt),
            })
          return current
        }
        const lease = AgentRuntime.RunLease.make({
          id: AgentRuntime.LeaseID.create(),
          runID: input.runID,
          ownerID: input.ownerID,
          generation: (current.lastLeaseGeneration ?? -1) + 1,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt: DateTime.makeUnsafe(nowMs + input.ttlMs),
        })
        const exit = yield* publishLeaseAcquired(current.run, lease, current.lastSequence).pipe(Effect.exit)
        if (exit._tag === "Success") {
          RuntimeInsight.auditRecord({
            actor: "recovery",
            action: "run.lease.acquired",
            resource: input.runID,
            reason: "Worker acquired exclusive durable execution lease",
            metadata: { runID: input.runID, leaseID: lease.id, ownerID: input.ownerID, generation: lease.generation },
          })
          return yield* load(input.runID)
        }
        if (!sequenceConflict(exit.cause)) return yield* Effect.failCause(exit.cause)
      }
      return yield* Effect.die(new Error(`Run lease contention did not converge for ${input.runID}`))
    })

    const validateControlLease: Interface["validateControlLease"] = Effect.fn("DurableRun.validateControlLease")(
      function* (capability) {
        const binding = issuedRunLeaseCapabilities.get(capability)
        if (!binding)
          return yield* new InvalidRunLeaseCapabilityError({
            reason: "The control run lease capability was not issued by this runtime.",
          })
        const snapshot = yield* load(binding.runID)
        if (!controlSnapshot(snapshot))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: binding.runID,
            reason: "A session run lease cannot authorize a control-plane operation.",
          })
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        if (
          !leaseActive(snapshot.lease, nowMs) ||
          snapshot.lease?.id !== binding.leaseID ||
          snapshot.lease.ownerID !== binding.ownerID ||
          snapshot.lease.generation !== binding.generation ||
          DateTime.toEpochMillis(snapshot.lease.heartbeatAt) !== binding.heartbeatAtMs ||
          DateTime.toEpochMillis(snapshot.lease.expiresAt) !== binding.expiresAtMs
        )
          return yield* new InvalidRunLeaseCapabilityError({
            runID: binding.runID,
            reason: "The control run lease capability is expired, superseded, or no longer owns the durable lease.",
          })
        return snapshot
      },
    )

    const validateControlLeaseFor = Effect.fnUntraced(function* (
      capability: RunLeaseCapability,
      runID: AgentRuntime.RunID,
    ) {
      const snapshot = yield* validateControlLease(capability)
      if (snapshot.run.id !== runID)
        return yield* new InvalidRunLeaseCapabilityError({
          runID,
          reason: "The control lease capability belongs to a different run.",
        })
      return snapshot
    })

    const validateLease: Interface["validateLease"] = Effect.fn("DurableRun.validateLease")(function* (input) {
      if (input.transaction) {
        // A no-op write holds the existing aggregate row until the caller's
        // transaction completes. Lease events update this same sequence row.
        yield* input.transaction
          .update(EventSequenceTable)
          .set({ seq: sql`${EventSequenceTable.seq}` })
          .where(eq(EventSequenceTable.aggregate_id, input.runID))
          .run()
          .pipe(Effect.orDie)
      }
      const snapshot = yield* load(input.runID, input.transaction)
      if (controlSnapshot(snapshot))
        return yield* new InvalidRunLeaseCapabilityError({
          runID: input.runID,
          reason: "A control run lease must be validated through validateControlLease.",
        })
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
      if (
        !leaseActive(snapshot.lease, nowMs) ||
        snapshot.lease?.id !== input.leaseID ||
        snapshot.lease.ownerID !== input.ownerID
      )
        return yield* new LeaseMismatchError({
          runID: input.runID,
          leaseID: input.leaseID,
          ownerID: input.ownerID,
        })
      return snapshot
    })

    const transition: Interface["transition"] = Effect.fn("DurableRun.transition")((input) => transitionInternal(input))
    const transitionControl: Interface["transitionControl"] = Effect.fn("DurableRun.transitionControl")(
      function* (capability, input) {
        const owned = yield* validateControlLeaseFor(capability, input.runID)
        const changed = yield* transitionInternal(input, capability)
        if (!controlSnapshot(changed))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: owned.run.id,
            reason: "The control mutation resolved to a session run.",
          })
        return changed
      },
    )

    const loadMutationSnapshot = Effect.fnUntraced(function* (
      runID: AgentRuntime.RunID,
      capability?: RunLeaseCapability,
    ) {
      if (capability) {
        return yield* validateControlLeaseFor(capability, runID)
      }
      const current = yield* load(runID)
      if (controlSnapshot(current))
        return yield* new InvalidRunLeaseCapabilityError({
          runID,
          reason: "Control run mutations require an active control lease capability.",
        })
      return current
    })

    const checkpointInternal = Effect.fnUntraced(function* (
      input: {
        readonly runID: AgentRuntime.RunID
        readonly state: CheckpointState
        readonly execution?: CheckpointExecution
        readonly lastActionID?: AgentRuntime.ActionID
      },
      capability?: RunLeaseCapability,
    ) {
      for (let contention = 0; contention < 6; contention++) {
        const current = yield* loadMutationSnapshot(input.runID, capability)
        if (controlSnapshot(current) && ["completed", "failed", "cancelled"].includes(current.run.status))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: input.runID,
            reason: `A terminal control run in state ${current.run.status} cannot create checkpoints.`,
          })
        const createdAt = yield* DateTime.now
        if (
          input.execution &&
          (!sessionRun(current.run) ||
            current.run.status !== "running" ||
            current.activeAttempt?.attempt !== input.execution.attempt ||
            current.lease?.id !== input.execution.leaseID ||
            current.lease.ownerID !== input.execution.ownerID ||
            DateTime.toEpochMillis(current.lease.expiresAt) <= DateTime.toEpochMillis(createdAt))
        )
          return yield* new InvalidRunLeaseCapabilityError({
            runID: input.runID,
            reason: "Checkpoint execution no longer owns the running attempt and live lease.",
          })
        const state = {
          ...(typeof input.state === "function" ? input.state(current.checkpoint?.state) : input.state),
        }
        const stateDigest = digest(state)
        const eventSequence = current.lastSequence + 1
        const checkpointID = AgentRuntime.CheckpointID.create()
        const checkpointIdentity = {
          id: checkpointID,
          runID: input.runID,
          ...(input.lastActionID ? { lastActionID: input.lastActionID } : {}),
          eventSequence,
          stateDigest,
          state,
          createdAt,
        }
        const checkpoint = AgentRuntime.Checkpoint.make({
          ...checkpointIdentity,
          resumeToken: checkpointResumeToken(checkpointIdentity),
        })
        if (capability) {
          const fresh = yield* validateControlLeaseFor(capability, input.runID)
          if (fresh.lastSequence !== current.lastSequence) continue
        }
        const exit = yield* publishCheckpoint(current.run, checkpoint, current.lastSequence).pipe(Effect.exit)
        if (exit._tag === "Failure") {
          if (sequenceConflict(exit.cause)) continue
          return yield* Effect.failCause(exit.cause)
        }
        RuntimeInsight.auditRecord({
          actor: current.run.initiator,
          action: "run.checkpoint.created",
          resource: input.runID,
          reason: "Semantic resume state persisted",
          metadata: {
            ...(sessionRun(current.run) ? { sessionID: current.run.sessionID } : { subject: current.run.subject.id }),
            runID: input.runID,
            checkpointID: checkpoint.id,
            eventSequence: checkpoint.eventSequence,
            stateDigest,
          },
        })
        return checkpoint
      }
      return yield* Effect.die(new Error(`Run checkpoint contention did not converge for ${input.runID}`))
    })
    const checkpoint: Interface["checkpoint"] = Effect.fn("DurableRun.checkpoint")((input) => checkpointInternal(input))
    const checkpointControl: Interface["checkpointControl"] = Effect.fn("DurableRun.checkpointControl")(
      function* (capability, input) {
        yield* validateControlLeaseFor(capability, input.runID)
        return yield* checkpointInternal(input, capability)
      },
    )

    const beginAttemptInternal = Effect.fnUntraced(function* (
      runID: AgentRuntime.RunID,
      usageBaseline?: AgentRuntime.RunUsageBaseline,
      capability?: RunLeaseCapability,
      execution?: CheckpointExecution,
    ) {
      const baseline = normalizedUsageBaseline(usageBaseline)
      for (let attempt = 0; attempt < 6; attempt++) {
        const current = yield* loadMutationSnapshot(runID, capability)
        if (current.run.status !== "running")
          return yield* new InvalidAttemptStateError({
            runID,
            status: current.run.status,
            reason: "Execution attempts may start only while the durable run is running.",
          })
        if (current.activeAttempt)
          return yield* new AttemptInProgressError({ runID, attempt: current.activeAttempt.attempt })
        if (childRun(current.run) && current.run.child.deadlineAt) {
          const now = yield* DateTime.now
          if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(current.run.child.deadlineAt)) {
            if (canTransition(current.run.status, "cancelled")) {
              yield* publishState(current.run, {
                to: "cancelled",
                reason: "Child deadline expired before a new attempt could start.",
                changedAt: now,
                expectedSequence: current.lastSequence,
              }).pipe(Effect.ignore)
            }
            return yield* new ChildDeadlineExceededError({
              runID,
              deadlineAtMs: DateTime.toEpochMillis(current.run.child.deadlineAt),
            })
          }
        }
        const nextAttempt = current.run.budget.attemptsUsed + 1
        if (nextAttempt > current.run.budget.maxAttempts)
          return yield* new BudgetExhaustedError({
            runID,
            attemptsUsed: current.run.budget.attemptsUsed,
            maxAttempts: current.run.budget.maxAttempts,
            reason: "attempt limit reached",
          })
        if (current.run.budget.durationMsUsed >= current.run.budget.maxDurationMs)
          return yield* new BudgetExhaustedError({
            runID,
            attemptsUsed: current.run.budget.attemptsUsed,
            maxAttempts: current.run.budget.maxAttempts,
            reason: `duration limit reached (${current.run.budget.durationMsUsed}/${current.run.budget.maxDurationMs} ms)`,
          })
        if (current.run.budget.costMicrosUsed >= current.run.budget.maxCostMicros)
          return yield* new BudgetExhaustedError({
            runID,
            attemptsUsed: current.run.budget.attemptsUsed,
            maxAttempts: current.run.budget.maxAttempts,
            reason: `cost limit reached (${current.run.budget.costMicrosUsed}/${current.run.budget.maxCostMicros} micros)`,
          })
        if (current.run.budget.tokensUsed >= current.run.budget.maxTokens)
          return yield* new BudgetExhaustedError({
            runID,
            attemptsUsed: current.run.budget.attemptsUsed,
            maxAttempts: current.run.budget.maxAttempts,
            reason: `token limit reached (${current.run.budget.tokensUsed}/${current.run.budget.maxTokens} tokens)`,
          })
        const startedAt = yield* DateTime.now
        if (
          execution &&
          (!sessionRun(current.run) ||
            current.run.budget.attemptsUsed !== execution.attempt ||
            current.lease?.id !== execution.leaseID ||
            current.lease.ownerID !== execution.ownerID ||
            DateTime.toEpochMillis(current.lease.expiresAt) <= DateTime.toEpochMillis(startedAt))
        )
          return yield* new InvalidRunLeaseCapabilityError({
            runID,
            reason: "Attempt admission no longer owns the original live lease and attempt count.",
          })
        if (capability) {
          const fresh = yield* validateControlLeaseFor(capability, runID)
          if (fresh.lastSequence !== current.lastSequence) continue
        }
        const exit = yield* publishAttemptStarted(
          current.run,
          nextAttempt,
          startedAt,
          current.lastSequence,
          baseline,
        ).pipe(Effect.exit)
        if (exit._tag === "Failure") {
          if (sequenceConflict(exit.cause)) continue
          return yield* Effect.failCause(exit.cause)
        }
        RuntimeInsight.auditRecord({
          actor: current.run.initiator,
          action: "run.attempt.started",
          resource: runID,
          reason: "A durable execution attempt started within the configured retry budget",
          metadata: {
            ...(sessionRun(current.run) ? { sessionID: current.run.sessionID } : { subject: current.run.subject.id }),
            runID,
            attempt: nextAttempt,
          },
        })
        return yield* load(runID)
      }
      return yield* Effect.die(new Error(`Run attempt contention did not converge for ${runID}`))
    })
    const beginAttempt: Interface["beginAttempt"] = Effect.fn("DurableRun.beginAttempt")((input) =>
      beginAttemptInternal(input.runID, input.usageBaseline, undefined, input.execution),
    )
    const beginControlAttempt: Interface["beginControlAttempt"] = Effect.fn("DurableRun.beginControlAttempt")(
      function* (capability, input) {
        const owned = yield* validateControlLeaseFor(capability, input.runID)
        const started = yield* beginAttemptInternal(input.runID, input.usageBaseline, capability)
        if (!controlSnapshot(started))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: owned.run.id,
            reason: "The control attempt resolved to a session run.",
          })
        return started
      },
    )

    const finishAttemptInternal = Effect.fnUntraced(function* (
      input: {
        readonly runID: AgentRuntime.RunID
        readonly attempt: number
        readonly execution?: CheckpointExecution
        readonly outcome: "completed" | "failed" | "interrupted"
        readonly durationMs: number
        readonly costMicros: number
        readonly tokens: number
        readonly commit?: EventV2.PublishOptions["commit"]
      },
      capability?: RunLeaseCapability,
    ) {
      for (let contention = 0; contention < 6; contention++) {
        const current = yield* loadMutationSnapshot(input.runID, capability)
        if (current.run.status !== "running")
          return yield* new InvalidAttemptStateError({
            runID: input.runID,
            status: current.run.status,
            reason: "Execution attempts may finish only while the durable run is running.",
          })
        if (current.activeAttempt?.attempt !== input.attempt)
          return yield* new AttemptMismatchError({
            runID: input.runID,
            expectedAttempt: current.activeAttempt?.attempt ?? 0,
            receivedAttempt: input.attempt,
          })
        const finishedAt = yield* DateTime.now
        if (
          input.execution &&
          (!sessionRun(current.run) ||
            input.execution.attempt !== input.attempt ||
            current.lease?.id !== input.execution.leaseID ||
            current.lease.ownerID !== input.execution.ownerID ||
            DateTime.toEpochMillis(current.lease.expiresAt) <= DateTime.toEpochMillis(finishedAt))
        )
          return yield* new InvalidRunLeaseCapabilityError({
            runID: input.runID,
            reason: "Attempt settlement execution no longer owns the running attempt and live lease.",
          })
        const durationMs = usageCounter(input.durationMs)
        const costMicros = usageCounter(input.costMicros)
        const tokens = usageCounter(input.tokens)
        if (capability) {
          const fresh = yield* validateControlLeaseFor(capability, input.runID)
          if (fresh.lastSequence !== current.lastSequence) continue
        }
        const exit = yield* publishAttemptFinished(current.run, {
          attempt: input.attempt,
          outcome: input.outcome,
          durationMs,
          costMicros,
          tokens,
          finishedAt,
          expectedSequence: current.lastSequence,
          commit: input.commit,
        }).pipe(Effect.exit)
        if (exit._tag === "Failure") {
          if (sequenceConflict(exit.cause)) continue
          return yield* Effect.failCause(exit.cause)
        }
        RuntimeInsight.auditRecord({
          actor: current.run.initiator,
          action: "run.attempt.finished",
          resource: input.runID,
          reason: `Durable attempt finished with outcome ${input.outcome}`,
          metadata: {
            ...(sessionRun(current.run) ? { sessionID: current.run.sessionID } : { subject: current.run.subject.id }),
            runID: input.runID,
            attempt: input.attempt,
            durationMs,
            costMicros,
            tokens,
          },
        })
        return yield* load(input.runID)
      }
      return yield* Effect.die(new Error(`Run attempt finish contention did not converge for ${input.runID}`))
    })
    const finishAttempt: Interface["finishAttempt"] = Effect.fn("DurableRun.finishAttempt")((input) =>
      finishAttemptInternal(input),
    )
    const finishControlAttempt: Interface["finishControlAttempt"] = Effect.fn("DurableRun.finishControlAttempt")(
      function* (capability, input) {
        const owned = yield* validateControlLeaseFor(capability, input.runID)
        const finished = yield* finishAttemptInternal(input, capability)
        if (!controlSnapshot(finished))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: owned.run.id,
            reason: "The control attempt resolved to a session run.",
          })
        return finished
      },
    )

    const heartbeatInternal = Effect.fnUntraced(function* (
      input: {
        readonly runID: AgentRuntime.RunID
        readonly leaseID?: AgentRuntime.LeaseID
        readonly ownerID?: string
        readonly ttlMs: number
      },
      capability?: RunLeaseCapability,
      onPublished?: () => void,
    ) {
      if (!validTtl(input.ttlMs)) return yield* new InvalidLeaseDurationError({ ttlMs: input.ttlMs })
      for (let attempt = 0; attempt < 6; attempt++) {
        const current = yield* loadMutationSnapshot(input.runID, capability)
        if (controlSnapshot(current) && ["completed", "failed", "cancelled"].includes(current.run.status))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: input.runID,
            reason: `A terminal control run in state ${current.run.status} cannot be heartbeated.`,
          })
        const leaseID = capability ? current.lease?.id : input.leaseID
        const ownerID = capability ? current.lease?.ownerID : input.ownerID
        if (!leaseID || !ownerID || current.lease?.id !== leaseID || current.lease.ownerID !== ownerID)
          return yield* new LeaseMismatchError({
            runID: input.runID,
            leaseID: leaseID ?? AgentRuntime.LeaseID.make("lease_missing"),
            ownerID: ownerID ?? "missing",
          })
        const heartbeatAt = yield* DateTime.now
        const heartbeatAtMs = DateTime.toEpochMillis(heartbeatAt)
        if (
          heartbeatAtMs < DateTime.toEpochMillis(current.lease.heartbeatAt) ||
          heartbeatAtMs >= DateTime.toEpochMillis(current.lease.expiresAt)
        )
          return yield* new LeaseMismatchError({ runID: input.runID, leaseID, ownerID })
        const expiresAt = DateTime.makeUnsafe(heartbeatAtMs + input.ttlMs)
        if (capability) {
          const fresh = yield* validateControlLeaseFor(capability, input.runID)
          if (fresh.lastSequence !== current.lastSequence) continue
        }
        const exit = yield* publishHeartbeat(current.run, {
          leaseID,
          ownerID,
          generation: current.lease.generation,
          heartbeatAt,
          expiresAt,
          expectedSequence: current.lastSequence,
        }).pipe(Effect.exit)
        if (exit._tag === "Success") {
          onPublished?.()
          return yield* load(input.runID)
        }
        if (!sequenceConflict(exit.cause)) return yield* Effect.failCause(exit.cause)
      }
      return yield* Effect.die(new Error(`Run heartbeat contention did not converge for ${input.runID}`))
    })
    const heartbeat: Interface["heartbeat"] = Effect.fn("DurableRun.heartbeat")((input) => heartbeatInternal(input))
    const heartbeatControl: Interface["heartbeatControl"] = Effect.fn("DurableRun.heartbeatControl")(
      function* (capability, input) {
        const owned = yield* validateControlLeaseFor(capability, input.runID)
        const renewed = yield* heartbeatInternal(input, capability, () => revokeRunLeaseCapability(capability))
        if (!controlSnapshot(renewed))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: owned.run.id,
            reason: "The control heartbeat resolved to a session run.",
          })
        const binding = controlLeaseBinding(renewed)
        if (!binding)
          return yield* new InvalidRunLeaseCapabilityError({
            runID: owned.run.id,
            reason: "The renewed control lease is missing.",
          })
        const nextCapability = mintRunLeaseCapability(binding)
        return { snapshot: renewed, capability: nextCapability }
      },
    )

    const releaseLeaseInternal = Effect.fnUntraced(function* (
      input: {
        readonly runID: AgentRuntime.RunID
        readonly leaseID?: AgentRuntime.LeaseID
        readonly ownerID?: string
        readonly reason: string
      },
      capability?: RunLeaseCapability,
      onPublished?: () => void,
    ) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const current = yield* loadMutationSnapshot(input.runID, capability)
        const leaseID = capability ? current.lease?.id : input.leaseID
        const ownerID = capability ? current.lease?.ownerID : input.ownerID
        if (!leaseID || !ownerID || current.lease?.id !== leaseID || current.lease.ownerID !== ownerID)
          return yield* new LeaseMismatchError({
            runID: input.runID,
            leaseID: leaseID ?? AgentRuntime.LeaseID.make("lease_missing"),
            ownerID: ownerID ?? "missing",
          })
        const releasedAt = yield* DateTime.now
        if (capability) {
          const fresh = yield* validateControlLeaseFor(capability, input.runID)
          if (fresh.lastSequence !== current.lastSequence) continue
        }
        const exit = yield* publishLeaseReleased(current.run, {
          leaseID,
          ownerID,
          generation: current.lease.generation,
          releasedAt,
          reason: input.reason,
          expectedSequence: current.lastSequence,
        }).pipe(Effect.exit)
        if (exit._tag === "Success") {
          onPublished?.()
          return yield* load(input.runID)
        }
        if (!sequenceConflict(exit.cause)) return yield* Effect.failCause(exit.cause)
      }
      return yield* Effect.die(new Error(`Run lease release contention did not converge for ${input.runID}`))
    })
    const releaseLease: Interface["releaseLease"] = Effect.fn("DurableRun.releaseLease")((input) =>
      releaseLeaseInternal(input),
    )
    const releaseControlLease: Interface["releaseControlLease"] = Effect.fn("DurableRun.releaseControlLease")(
      function* (capability, input) {
        const owned = yield* validateControlLeaseFor(capability, input.runID)
        const released = yield* releaseLeaseInternal(input, capability, () => revokeRunLeaseCapability(capability))
        if (!controlSnapshot(released))
          return yield* new InvalidRunLeaseCapabilityError({
            runID: owned.run.id,
            reason: "The control lease release resolved to a session run.",
          })
        return released
      },
    )

    const childReservationFor = Effect.fnUntraced(function* (
      parentRunID: AgentRuntime.RunID,
      childRunID: AgentRuntime.RunID,
    ) {
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, parentRunID),
            eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunBudgetReserved.type, 1)),
          ),
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        try {
          const data = Schema.decodeUnknownSync(AgentRuntime.Event.ChildRunBudgetReserved.data)(row.data)
          if (data.childRunID === childRunID) return data
        } catch (cause) {
          return yield* new CorruptHistoryError({
            runID: parentRunID,
            sequence: row.seq,
            reason: `Child budget reservation failed strict decoding: ${String(cause)}`,
          })
        }
      }
      return undefined
    })

    const childSettlementIntentFor = Effect.fnUntraced(function* (
      parentRunID: AgentRuntime.RunID,
      childRunID: AgentRuntime.RunID,
    ) {
      const rows = yield* db
        .select({ seq: EventTable.seq, data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, parentRunID),
            eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunSettlementIntentRecorded.type, 1)),
          ),
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        try {
          const data = Schema.decodeUnknownSync(AgentRuntime.Event.ChildRunSettlementIntentRecorded.data)(row.data)
          if (data.childRunID === childRunID) return data
        } catch (cause) {
          return yield* new CorruptHistoryError({
            runID: parentRunID,
            sequence: row.seq,
            reason: `Child settlement intent failed strict decoding: ${String(cause)}`,
          })
        }
      }
      return undefined
    })

    const childBudgetSettlement = Effect.fnUntraced(function* (
      parentRunID: AgentRuntime.RunID,
      childRunID: AgentRuntime.RunID,
    ) {
      const rows = yield* db
        .select({ seq: EventTable.seq, data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, parentRunID),
            eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunBudgetSettled.type, 1)),
          ),
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        let data: typeof AgentRuntime.Event.ChildRunBudgetSettled.data.Type
        try {
          data = Schema.decodeUnknownSync(AgentRuntime.Event.ChildRunBudgetSettled.data)(row.data)
        } catch (cause) {
          return yield* new CorruptHistoryError({
            runID: parentRunID,
            sequence: row.seq,
            reason: `Child budget settlement failed strict decoding: ${String(cause)}`,
          })
        }
        if (data.childRunID === childRunID) return data
      }
      return undefined
    })

    const childBudgetSettled = (parentRunID: AgentRuntime.RunID, childRunID: AgentRuntime.RunID) =>
      childBudgetSettlement(parentRunID, childRunID).pipe(Effect.map((value) => value !== undefined))

    const readChildSettlementFacts: Interface["readChildSettlementFacts"] = Effect.fn(
      "DurableRun.readChildSettlementFacts",
    )(function* (input) {
      const child = yield* load(input.childRunID)
      if (!sessionRun(child.run) || !childRun(child.run))
        return yield* new ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "Settlement facts require a SessionRun child binding.",
        })
      if (child.run.child.parentRunID !== input.parentRunID)
        return yield* new ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "The supplied parent does not match the child's immutable parent binding.",
        })

      const childResult: SettlementComponent = child.run.childResult
        ? {
            state: "present",
            digest: child.run.childResult.resultDigest,
            identity: String(child.run.id),
          }
        : { state: "missing" }
      const reservation = yield* childReservationFor(input.parentRunID, input.childRunID)
      if (!reservation)
        return {
          childResult,
          parentBudget: {
            state: "conflict",
            reason: "The child has no durable parent budget reservation.",
          },
        } satisfies DurableSettlementFacts
      const settlement = yield* childBudgetSettlement(input.parentRunID, input.childRunID)
      if (!settlement) return { childResult, parentBudget: { state: "missing" } } satisfies DurableSettlementFacts
      const budgetDigest = canonicalHash(settlement.actual)
      if (!budgetDigest)
        return yield* new CorruptHistoryError({
          runID: input.parentRunID,
          sequence: -1,
          reason: "The child budget settlement actual usage is not canonicalizable.",
        })
      return {
        childResult,
        parentBudget: {
          state: "present",
          digest: budgetDigest,
          identity: String(settlement.childRunID),
        },
      } satisfies DurableSettlementFacts
    })

    const ensureChildAggregate = Effect.fnUntraced(function* (
      reservation: typeof AgentRuntime.Event.ChildRunBudgetReserved.data.Type,
    ) {
      const existing = yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, reservation.childRunID))
        .get()
        .pipe(Effect.orDie)
      if (existing) return false
      const published = yield* events
        .publish(
          AgentRuntime.Event.ChildRunCreated,
          {
            runID: reservation.childRunID,
            parentRunID: reservation.runID,
            sessionID: reservation.childRun.sessionID,
            run: reservation.childRun,
          },
          {
            expectedSequence: -1,
            commit: () =>
              Effect.gen(function* () {
                yield* yield* CurrentCheck
              }).pipe(Effect.provideService(PendingSession, reservation.childRun.sessionID), Effect.orDie),
          },
        )
        .pipe(Effect.catchDefect(restoreAccessFailure), Effect.exit)
      if (published._tag === "Success") return true
      if (sequenceConflict(published.cause)) return false
      return yield* Effect.failCause(published.cause)
    })

    const settleChildBudget = Effect.fnUntraced(function* (snapshot: ChildSnapshot) {
      const child = snapshot.run
      const parentRunID = child.child.parentRunID
      const reservation = yield* childReservationFor(parentRunID, child.id)
      if (!reservation)
        return yield* new ChildAdmissionError({
          parentRunID,
          reason: "The child run has no durable parent budget reservation.",
        })
      const actual = childBudgetFromRun(child)
      if (!childBudgetWithin(actual, reservation.reserved))
        return yield* new ChildAdmissionError({
          parentRunID,
          reason: "The child run consumed more than its admitted budget.",
        })
      for (let contention = 0; contention < 6; contention++) {
        if (yield* childBudgetSettled(parentRunID, child.id)) return snapshot
        const parent = yield* load(parentRunID)
        if (!sessionSnapshot(parent))
          return yield* new ChildAdmissionError({
            parentRunID,
            reason: "Control runs cannot own child-run budget reservations.",
          })
        const previous = parent.run.childBudgetReserved ?? zeroChildBudget()
        if (!childBudgetWithin(reservation.reserved, previous))
          return yield* new CorruptHistoryError({
            runID: parentRunID,
            sequence: parent.lastSequence,
            reason: "The parent reservation projection is smaller than the child reservation being settled.",
          })
        const settledAt = yield* DateTime.now
        const published = yield* events
          .publish(
            AgentRuntime.Event.ChildRunBudgetSettled,
            {
              runID: parentRunID,
              sessionID: parent.run.sessionID,
              childRunID: child.id,
              reserved: reservation.reserved,
              actual,
              reservedTotal: subtractChildBudget(previous, reservation.reserved),
              settledAt,
            },
            { expectedSequence: parent.lastSequence },
          )
          .pipe(Effect.exit)
        if (published._tag === "Success") return snapshot
        if (!sequenceConflict(published.cause)) return yield* Effect.failCause(published.cause)
      }
      return yield* Effect.die(new Error(`Child budget settlement contention did not converge for ${child.id}`))
    })

    const listChildren: Interface["listChildren"] = Effect.fn("DurableRun.listChildren")(function* (input) {
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunCreated.type, 1)))
        .orderBy(desc(EventTable.id))
        .all()
        .pipe(Effect.orDie)
      const result: ChildSnapshot[] = []
      const seen = new Set<AgentRuntime.RunID>()
      for (const row of rows) {
        let created: typeof AgentRuntime.Event.ChildRunCreated.data.Type
        try {
          created = Schema.decodeUnknownSync(AgentRuntime.Event.ChildRunCreated.data)(row.data)
        } catch (cause) {
          return yield* new CorruptHistoryError({
            runID: AgentRuntime.RunID.make(row.aggregate_id),
            sequence: row.seq,
            reason: `Child run created event failed strict decoding: ${String(cause)}`,
          })
        }
        if (created.parentRunID !== input.parentRunID || seen.has(created.runID)) continue
        seen.add(created.runID)
        const snapshot = yield* load(created.runID)
        if (!childRun(snapshot.run))
          return yield* new CorruptHistoryError({
            runID: created.runID,
            sequence: snapshot.lastSequence,
            reason: "A child-created aggregate does not carry a child delegation binding.",
          })
        if (!input.includeTerminal && ["completed", "failed", "cancelled"].includes(snapshot.run.status)) continue
        result.push(snapshot as ChildSnapshot)
        if (result.length >= Math.min(Math.max(input.limit ?? DEFAULT_CHILD_MAX_CONCURRENCY, 1), 1_000)) break
      }
      return result
    })

    const recoverChildren: Interface["recoverChildren"] = Effect.fn("DurableRun.recoverChildren")(function* (input) {
      const where = input?.parentRunID
        ? and(
            eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunBudgetReserved.type, 1)),
            eq(EventTable.aggregate_id, input.parentRunID),
          )
        : eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunBudgetReserved.type, 1))
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(where)
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      let repaired = 0
      for (const row of rows) {
        let reservation: typeof AgentRuntime.Event.ChildRunBudgetReserved.data.Type
        try {
          reservation = Schema.decodeUnknownSync(AgentRuntime.Event.ChildRunBudgetReserved.data)(row.data)
        } catch (cause) {
          return yield* new CorruptHistoryError({
            runID: AgentRuntime.RunID.make(row.aggregate_id),
            sequence: row.seq,
            reason: `Child budget reservation failed strict decoding: ${String(cause)}`,
          })
        }
        const reservedChild = reservation.childRun
        if (
          reservation.runID !== row.aggregate_id ||
          reservedChild.id !== reservation.childRunID ||
          !childRun(reservedChild) ||
          reservedChild.child.parentRunID !== reservation.runID ||
          reservedChild.id === reservation.runID ||
          reservedChild.child.project !== reservedChild.project ||
          reservedChild.child.location !== reservedChild.location
        )
          return yield* new CorruptHistoryError({
            runID: AgentRuntime.RunID.make(row.aggregate_id),
            sequence: row.seq,
            reason: "Child budget reservation contains inconsistent aggregate or delegation bindings.",
          })
        const reservationParent = yield* load(reservation.runID)
        if (
          !sessionSnapshot(reservationParent) ||
          reservation.sessionID !== reservationParent.run.sessionID ||
          (reservationParent.run.project !== undefined && reservationParent.run.project !== reservedChild.project) ||
          (reservationParent.run.location !== undefined && reservationParent.run.location !== reservedChild.location) ||
          reservedChild.child.depth !== (childRun(reservationParent.run) ? reservationParent.run.child.depth : 0) + 1 ||
          reservedChild.child.depth > DEFAULT_CHILD_MAX_DEPTH
        )
          return yield* new CorruptHistoryError({
            runID: AgentRuntime.RunID.make(row.aggregate_id),
            sequence: row.seq,
            reason: "Child budget reservation does not match its parent session, workspace, or depth.",
          })
        // Validate the admitted ancestry before materializing a missing child.
        // Sequence numbers are local to each aggregate, not a global tree order.
        let ancestor = reservationParent
        const ancestors = new Set<AgentRuntime.RunID>([reservedChild.id])
        while (childRun(ancestor.run)) {
          const run = ancestor.run
          if (ancestors.has(run.id) || ancestors.size > DEFAULT_CHILD_MAX_DEPTH)
            return yield* new CorruptHistoryError({
              runID: run.id,
              sequence: ancestor.lastSequence,
              reason: "Child recovery ancestry contains a cycle or exceeds the depth limit.",
            })
          ancestors.add(run.id)
          const admission = yield* childReservationFor(run.child.parentRunID, run.id)
          if (
            !admission ||
            admission.runID !== run.child.parentRunID ||
            admission.childRun.id !== run.id ||
            admission.childRun.sessionID !== run.sessionID ||
            admission.childRun.project !== run.project ||
            admission.childRun.location !== run.location ||
            run.child.project !== run.project ||
            run.child.location !== run.location ||
            childAdmissionFingerprint(admission.childRun) !== childAdmissionFingerprint(run)
          )
            return yield* new CorruptHistoryError({
              runID: run.id,
              sequence: ancestor.lastSequence,
              reason: "Child recovery ancestor does not match its original budget admission.",
            })
          const next = yield* load(run.child.parentRunID)
          if (
            !sessionSnapshot(next) ||
            admission.sessionID !== next.run.sessionID ||
            (next.run.project !== undefined && next.run.project !== run.project) ||
            (next.run.location !== undefined && next.run.location !== run.location) ||
            run.child.depth !== (childRun(next.run) ? next.run.child.depth : 0) + 1
          )
            return yield* new CorruptHistoryError({
              runID: run.id,
              sequence: ancestor.lastSequence,
              reason: "Child recovery ancestor has an invalid parent session, workspace, or depth.",
            })
          ancestor = next
        }
        if (yield* ensureChildAggregate(reservation)) repaired++
        const child = yield* load(reservation.childRunID)
        // Existence is not proof of the reserved immutable contract. This also
        // checks the winner of a concurrent ChildRunCreated publication.
        if (
          !childRun(child.run) ||
          child.run.id !== reservedChild.id ||
          child.run.sessionID !== reservedChild.sessionID ||
          child.run.project !== reservedChild.project ||
          child.run.location !== reservedChild.location ||
          childAdmissionFingerprint(child.run) !== childAdmissionFingerprint(reservedChild)
        )
          return yield* new CorruptHistoryError({
            runID: reservation.childRunID,
            sequence: child.lastSequence,
            reason: "The published child does not match its original budget admission.",
          })
        if (childRun(child.run) && ["completed", "failed", "cancelled"].includes(child.run.status)) {
          const intent = yield* childSettlementIntentFor(reservation.runID, reservation.childRunID)
          // A settlement intent is the recovery outbox prefix.  Do not settle
          // the parent budget ahead of its child result; the intent pass below
          // repairs the result first, then reuses the normal budget owner.
          if (!(intent && child.run.childResult === undefined)) yield* settleChildBudget(child as ChildSnapshot)
        }
      }

      const intentWhere = input?.parentRunID
        ? and(
            eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunSettlementIntentRecorded.type, 1)),
            eq(EventTable.aggregate_id, input.parentRunID),
          )
        : eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ChildRunSettlementIntentRecorded.type, 1))
      const intents = yield* db
        .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq, data: EventTable.data })
        .from(EventTable)
        .where(intentWhere)
        .orderBy(asc(EventTable.aggregate_id), asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of intents) {
        let intent: typeof AgentRuntime.Event.ChildRunSettlementIntentRecorded.data.Type
        try {
          intent = Schema.decodeUnknownSync(AgentRuntime.Event.ChildRunSettlementIntentRecorded.data)(row.data)
        } catch (cause) {
          return yield* new CorruptHistoryError({
            runID: AgentRuntime.RunID.make(row.aggregateID),
            sequence: row.seq,
            reason: `Child settlement intent failed strict decoding during recovery: ${String(cause)}`,
          })
        }
        const child = yield* load(intent.childRunID)
        if (!sessionRun(child.run) || !childRun(child.run) || child.run.child.parentRunID !== intent.runID)
          return yield* new CorruptHistoryError({
            runID: intent.runID,
            sequence: row.seq,
            reason: "Child settlement intent points at a child with a different immutable parent.",
          })
        let expected: ChildSettlement.SettlementIntent
        try {
          expected = settlementIntentFromReceipt({
            parentRunID: intent.runID,
            childRunID: intent.childRunID,
            idempotencyKey: intent.idempotencyKey,
            result: intent.result,
            intentAt: intent.intentAt,
            ...(intent.admissionEvidence === undefined ? {} : { admissionEvidence: intent.admissionEvidence }),
          })
        } catch (cause) {
          return yield* new CorruptHistoryError({
            runID: intent.runID,
            sequence: row.seq,
            reason: `Child settlement intent failed immutable validation during recovery: ${String(cause)}`,
          })
        }
        if (
          expected.intentID !== intent.intentID ||
          expected.idempotencyDigest !== intent.idempotencyDigest ||
          expected.resultDigest !== intent.result.resultDigest
        )
          return yield* new CorruptHistoryError({
            runID: intent.runID,
            sequence: row.seq,
            reason: "Child settlement intent identity or result digest drifted during recovery.",
          })
        if (child.run.childResult) {
          if (
            child.run.childResult.resultDigest !== intent.result.resultDigest ||
            child.run.childResult.status !== intent.result.status ||
            child.run.childResult.summary !== intent.result.summary ||
            !sameChildBudget(child.run.childResult.usage, intent.result.usage) ||
            JSON.stringify(child.run.childResult.artifactRefs) !== JSON.stringify(intent.result.artifactRefs) ||
            JSON.stringify(child.run.childResult.evidenceRefs) !== JSON.stringify(intent.result.evidenceRefs)
          )
            return yield* new CorruptHistoryError({
              runID: intent.childRunID,
              sequence: child.lastSequence,
              reason: "The child result conflicts with its immutable settlement intent.",
            })
        } else {
          if (
            !["completed", "failed", "cancelled"].includes(child.run.status) ||
            child.run.status !== intent.result.status
          )
            return yield* new CorruptHistoryError({
              runID: intent.childRunID,
              sequence: child.lastSequence,
              reason: "The child settlement intent cannot be replayed before its terminal status.",
            })
          const resultPublished = yield* events
            .publish(
              AgentRuntime.Event.ChildRunResultRecorded,
              {
                runID: intent.childRunID,
                parentRunID: intent.runID,
                sessionID: child.run.sessionID,
                result: intent.result,
              },
              { expectedSequence: child.lastSequence },
            )
            .pipe(Effect.exit)
          if (resultPublished._tag === "Failure") {
            if (sequenceConflict(resultPublished.cause)) continue
            return yield* Effect.failCause(resultPublished.cause)
          }
          repaired++
        }
        const repairedChild = (yield* load(intent.childRunID)) as ChildSnapshot
        if (["completed", "failed", "cancelled"].includes(repairedChild.run.status))
          yield* settleChildBudget(repairedChild)
      }
      return repaired
    })

    const createChild: Interface["createChild"] = Effect.fn("DurableRun.createChild")(function* (input) {
      if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 256)
        return yield* new ChildAdmissionError({
          parentRunID: input.parentRunID,
          reason: "Child idempotencyKey must contain 1-256 characters.",
        })
      if (input.delegatedObjective.length === 0 || input.delegatedObjective.length > 8_000)
        return yield* new ChildAdmissionError({
          parentRunID: input.parentRunID,
          reason: "Child delegatedObjective must contain 1-8000 characters.",
        })
      if (
        input.runtimeDescriptorDigest !== undefined &&
        !runtimeDescriptorDigestPattern.test(input.runtimeDescriptorDigest)
      )
        return yield* new ChildAdmissionError({
          parentRunID: input.parentRunID,
          reason: "Child runtime descriptor digest must be a 64-character hexadecimal value.",
        })
      if (
        input.runtimeAdmission !== undefined &&
        (!validRuntimeAdmission({
          runtimeDescriptorDigest: input.runtimeDescriptorDigest,
          runtimeAdmission: input.runtimeAdmission,
        }) ||
          input.runtimeAdmission.evidence.kind !== "custom-agent-admission")
      )
        return yield* new ChildAdmissionError({
          parentRunID: input.parentRunID,
          reason: "Child runtime admission evidence must be a valid admitted receipt bound to its descriptor digest.",
        })
      const capabilities =
        input.allowedCapabilities.length > 0 ? [...input.allowedCapabilities] : [defaultReadOnlyCapability()]
      if (
        capabilities.length > 64 ||
        capabilities.some(
          (capability) =>
            capability.action.length === 0 ||
            capability.action.length > 256 ||
            capability.resources.length === 0 ||
            capability.resources.length > 128 ||
            capability.resources.some((resource) => resource.length === 0 || resource.length > 1_024),
        )
      )
        return yield* new ChildAdmissionError({
          parentRunID: input.parentRunID,
          reason: "Child capability scope is empty or exceeds the bounded admission contract.",
        })
      const childRunID = childRunIDFor(input.parentRunID, input.idempotencyKey)
      if (!childRunID)
        return yield* new ChildAdmissionError({
          parentRunID: input.parentRunID,
          reason: "Child idempotency identity could not be canonically derived.",
        })

      for (let contention = 0; contention < 6; contention++) {
        const existing = yield* load(childRunID).pipe(
          Effect.catchTag("DurableRun.NotFoundError", () => Effect.succeed(undefined)),
        )
        if (existing) {
          if (!childRun(existing.run))
            return yield* new ChildIdempotencyConflictError({
              parentRunID: input.parentRunID,
              idempotencyKey: input.idempotencyKey,
              childRunID,
              reason: "The deterministic child identity belongs to a non-child run.",
            })
          const parent = yield* load(input.parentRunID)
          const expectedDepth = (childRun(parent.run) ? parent.run.child.depth : 0) + 1
          if (
            existing.run.child.parentRunID !== input.parentRunID ||
            existing.run.child.idempotencyKey !== input.idempotencyKey ||
            childAdmissionFingerprint(existing.run) !== childRequestFingerprint(input, capabilities, expectedDepth)
          )
            return yield* new ChildIdempotencyConflictError({
              parentRunID: input.parentRunID,
              idempotencyKey: input.idempotencyKey,
              childRunID,
              reason: "The idempotency key was reused with a different immutable child contract.",
            })
          if (!(yield* childReservationFor(input.parentRunID, childRunID)))
            return yield* new ChildAdmissionError({
              parentRunID: input.parentRunID,
              reason: "The child exists without its parent budget reservation; recovery is required.",
            })
          return existing as ChildSnapshot
        }

        const parent = yield* load(input.parentRunID)
        if (!sessionSnapshot(parent))
          return yield* new ChildAdmissionError({
            parentRunID: input.parentRunID,
            reason: "Only SessionRun may admit a child SessionRun; ControlRun is not a child parent.",
          })
        if (["completed", "failed", "cancelled"].includes(parent.run.status))
          return yield* new ChildAdmissionError({
            parentRunID: input.parentRunID,
            reason: `A terminal parent run cannot admit a child (${parent.run.status}).`,
          })
        const now = yield* DateTime.now
        if (input.deadlineAt && DateTime.toEpochMillis(input.deadlineAt) <= DateTime.toEpochMillis(now))
          return yield* new ChildAdmissionError({
            parentRunID: input.parentRunID,
            reason: "Child deadline must be in the future at admission.",
          })
        const depth = (childRun(parent.run) ? parent.run.child.depth : 0) + 1
        if (depth > DEFAULT_CHILD_MAX_DEPTH)
          return yield* new ChildAdmissionError({
            parentRunID: input.parentRunID,
            reason: `Child depth ${depth} exceeds the maximum ${DEFAULT_CHILD_MAX_DEPTH}.`,
          })
        if (parent.run.project !== undefined && parent.run.project !== input.project)
          return yield* new ChildAdmissionError({
            parentRunID: input.parentRunID,
            reason: "Child project scope does not match its parent.",
          })
        if (parent.run.location !== undefined && parent.run.location !== input.location)
          return yield* new ChildAdmissionError({
            parentRunID: input.parentRunID,
            reason: "Child location scope does not match its parent.",
          })
        const parentCapabilities: ReadonlyArray<AgentRuntime.ChildCapability> =
          parent.run.delegableCapabilities ??
          (childRun(parent.run) ? parent.run.child.allowedCapabilities : [defaultReadOnlyCapability()])
        for (const requested of capabilities) {
          if (!parentCapabilities.some((grant) => capabilityContains(grant, requested)))
            return yield* new ChildCapabilityDeniedError({
              parentRunID: input.parentRunID,
              action: requested.action,
              resources: [...requested.resources],
              reason: "Child capabilities must be an explicit subset of the parent delegation scope.",
            })
        }
        const requestedBudget: AgentRuntime.ChildBudgetAmount = {
          attempts: input.budget.maxAttempts,
          durationMs: input.budget.maxDurationMs,
          costMicros: input.budget.maxCostMicros,
          tokens: input.budget.maxTokens,
        }
        if (
          input.budget.attemptsUsed !== 0 ||
          input.budget.durationMsUsed !== 0 ||
          input.budget.costMicrosUsed !== 0 ||
          input.budget.tokensUsed !== 0 ||
          !childBudgetWithin(requestedBudget, {
            attempts: Number.MAX_SAFE_INTEGER,
            durationMs: Number.MAX_SAFE_INTEGER,
            costMicros: Number.MAX_SAFE_INTEGER,
            tokens: Number.MAX_SAFE_INTEGER,
          })
        )
          return yield* new ChildBudgetExceededError({
            parentRunID: input.parentRunID,
            reason: "A child must enter with zero usage and safe integer budget limits.",
          })
        const reserved = parent.run.childBudgetReserved ?? zeroChildBudget()
        const remaining = {
          attempts: parent.run.budget.maxAttempts - parent.run.budget.attemptsUsed - reserved.attempts,
          durationMs: parent.run.budget.maxDurationMs - parent.run.budget.durationMsUsed - reserved.durationMs,
          costMicros: parent.run.budget.maxCostMicros - parent.run.budget.costMicrosUsed - reserved.costMicros,
          tokens: parent.run.budget.maxTokens - parent.run.budget.tokensUsed - reserved.tokens,
        }
        if (
          remaining.attempts < 0 ||
          remaining.durationMs < 0 ||
          remaining.costMicros < 0 ||
          remaining.tokens < 0 ||
          !childBudgetWithin(requestedBudget, remaining)
        )
          return yield* new ChildBudgetExceededError({
            parentRunID: input.parentRunID,
            reason: `Child budget exceeds remaining parent budget: requested ${JSON.stringify(requestedBudget)}, remaining ${JSON.stringify(remaining)}.`,
          })

        const binding = AgentRuntime.ChildRunBinding.make({
          version: 1,
          parentRunID: input.parentRunID,
          idempotencyKey: input.idempotencyKey,
          ...(input.runtimeDescriptorDigest === undefined
            ? {}
            : { runtimeDescriptorDigest: input.runtimeDescriptorDigest }),
          ...(input.runtimeAdmission === undefined ? {} : { runtimeAdmission: input.runtimeAdmission }),
          delegatedObjective: input.delegatedObjective,
          allowedCapabilities: capabilities,
          project: input.project,
          location: input.location,
          expectedDeliverable: input.expectedDeliverable,
          ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
          depth,
        })
        const run = AgentRuntime.SessionRun.make({
          id: childRunID,
          sessionID: input.sessionID,
          ...(input.goalID ? { goalID: input.goalID } : {}),
          ...(input.taskID ? { taskID: input.taskID } : {}),
          project: input.project,
          location: input.location,
          status: "draft",
          delegableCapabilities: capabilities,
          child: binding,
          initiator: input.initiator,
          authority: input.authority,
          riskTier: input.riskTier,
          reasonSummary: input.reasonSummary,
          budget: input.budget,
          traceID: input.traceID,
          ...(input.parentTraceID ? { parentTraceID: input.parentTraceID } : {}),
          visibility: input.visibility,
          time: { created: now, updated: now },
        })
        const reservation = yield* childReservationFor(input.parentRunID, childRunID)
        if (reservation) continue
        const published = yield* events
          .publish(
            AgentRuntime.Event.ChildRunBudgetReserved,
            {
              runID: input.parentRunID,
              sessionID: parent.run.sessionID,
              childRunID,
              childRun: run,
              reserved: requestedBudget,
              reservedTotal: addChildBudget(reserved, requestedBudget),
              reservedAt: now,
            },
            { expectedSequence: parent.lastSequence },
          )
          .pipe(Effect.exit)
        if (published._tag === "Failure") {
          if (sequenceConflict(published.cause)) continue
          return yield* Effect.failCause(published.cause)
        }
        const created = yield* events
          .publish(
            AgentRuntime.Event.ChildRunCreated,
            { runID: childRunID, parentRunID: input.parentRunID, sessionID: run.sessionID, run },
            { expectedSequence: -1 },
          )
          .pipe(Effect.exit)
        if (created._tag === "Failure") {
          if (sequenceConflict(created.cause)) return (yield* load(childRunID)) as ChildSnapshot
          return yield* Effect.failCause(created.cause)
        }
        RuntimeInsight.auditRecord({
          actor: run.initiator,
          action: "child-run.created",
          resource: childRunID,
          reason: run.reasonSummary,
          metadata: {
            runID: childRunID,
            parentRunID: input.parentRunID,
            sessionID: run.sessionID,
            depth,
            capabilityCount: capabilities.length,
          },
        })
        return { run, lastSequence: 0 } as ChildSnapshot
      }
      return yield* Effect.die(new Error(`Child admission contention did not converge for ${input.parentRunID}`))
    })

    const prepareSettlementOutbox = Effect.fn("DurableRun.prepareSettlementOutbox")(function* (
      intent: ChildSettlement.SettlementIntent,
      observedAtMs: number,
    ) {
      let plan: ChildSettlement.SettlementCommitPlan
      try {
        plan = ChildSettlement.planSettlementCommit(intent, {
          mode: "recovery-outbox",
          atomicDatabaseTransaction: false,
          durableRecoveryOutbox: true,
        })
      } catch (cause) {
        return yield* new ChildResultConflictError({
          runID: intent.childRunID,
          reason: `Child settlement outbox plan is invalid: ${String(cause)}`,
        })
      }
      const identity = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
      const prepared = yield* settlementOutbox.prepare({ identity, plan, observedAtMs }).pipe(Effect.exit)
      if (prepared._tag === "Failure")
        return yield* new ChildResultConflictError({
          runID: intent.childRunID,
          reason: "Child settlement recovery outbox could not be prepared; recovery is required.",
        })
      if (prepared.value.record.status === "recovery-required")
        return yield* new ChildResultConflictError({
          runID: intent.childRunID,
          reason: "Child settlement recovery outbox requires an explicit operator reopen.",
        })
      return { identity, plan, record: prepared.value.record }
    })

    const commitLegacySettlementOutbox = Effect.fn("DurableRun.commitLegacySettlementOutbox")(function* (input: {
      readonly identity: SettlementOutbox.SettlementOutboxIdentity
      readonly plan: ChildSettlement.SettlementCommitPlan
      readonly observedAtMs: number
    }) {
      if (input.plan.ownerOrder.includes("admission-evidence")) return
      for (const owner of input.plan.ownerOrder) {
        const ownerDigest =
          owner === "child-result" ? input.plan.expectedDigests.childResult : input.plan.expectedDigests.parentBudget
        const promoted = yield* settlementOutbox
          .promoteOwner({
            identity: input.identity,
            plan: input.plan,
            owner,
            ownerDigest,
            observedAtMs: input.observedAtMs,
          })
          .pipe(Effect.exit)
        if (promoted._tag === "Failure") {
          yield* settlementOutbox
            .markRecoveryRequired({
              identity: input.identity,
              plan: input.plan,
              observedAtMs: input.observedAtMs,
              reason: "Child settlement owner promotion failed; manual recovery is required.",
            })
            .pipe(Effect.ignore)
          return
        }
      }
      const committed = yield* settlementOutbox
        .commitPromoted({ identity: input.identity, plan: input.plan, observedAtMs: input.observedAtMs })
        .pipe(Effect.exit)
      if (committed._tag === "Success") return
      // The intent, child result, and parent budget are already durable at
      // this point. Keep the row discoverable for a later recovery worker;
      // never report a fabricated rollback or authorize provider execution.
      yield* settlementOutbox
        .markRecoveryRequired({
          identity: input.identity,
          plan: input.plan,
          observedAtMs: input.observedAtMs,
          reason: "Child settlement owners converged but outbox commit failed; manual recovery is required.",
        })
        .pipe(Effect.ignore)
    })

    /**
     * A result may have been committed by an older build before the durable
     * SettlementOutbox became part of the terminal path.  An exact idempotent
     * replay must repair that metadata receipt, but it may not invent an
     * intent when the parent aggregate never recorded one.
     */
    const ensureSettlementOutboxForExistingResult = Effect.fn("DurableRun.ensureSettlementOutboxForExistingResult")(
      function* (snapshot: ChildSnapshot) {
        const child = snapshot.run
        const parentRunID = child.child.parentRunID
        const raw = yield* childSettlementIntentFor(parentRunID, child.id)
        if (raw === undefined) return
        let intent: ChildSettlement.SettlementIntent
        try {
          intent = settlementIntentFromReceipt({
            parentRunID,
            childRunID: child.id,
            idempotencyKey: raw.idempotencyKey,
            result: raw.result,
            intentAt: raw.intentAt,
            ...(raw.admissionEvidence === undefined ? {} : { admissionEvidence: raw.admissionEvidence }),
          })
        } catch (cause) {
          return yield* new ChildResultConflictError({
            runID: child.id,
            reason: `Stored child settlement intent cannot be reconstructed: ${String(cause)}`,
          })
        }
        const prepared = yield* prepareSettlementOutbox(intent, DateTime.toEpochMillis(raw.intentAt))
        yield* commitLegacySettlementOutbox({
          identity: prepared.identity,
          plan: prepared.plan,
          observedAtMs: DateTime.toEpochMillis(raw.intentAt),
        })
      },
    )

    const recordChildResult: Interface["recordChildResult"] = Effect.fn("DurableRun.recordChildResult")(
      function* (input) {
        const resultDigest = childResultDigest(input.result)
        if (!resultDigest)
          return yield* new ChildResultConflictError({
            runID: input.runID,
            reason: "Child result fields are not canonically hashable.",
          })
        const requestedSettlementMode = input.settlementMode ?? "auto"
        if (
          requestedSettlementMode !== "auto" &&
          requestedSettlementMode !== "recovery-outbox" &&
          requestedSettlementMode !== "same-transaction"
        )
          return yield* new ChildResultConflictError({
            runID: input.runID,
            reason: "Child settlement mode is invalid.",
          })
        for (let contention = 0; contention < 6; contention++) {
          const current = yield* load(input.runID)
          if (!childRun(current.run))
            return yield* new ChildResultConflictError({
              runID: input.runID,
              reason: "Only a child SessionRun may record a child result.",
            })
          if (input.execution) {
            const now = yield* DateTime.now
            if (
              current.activeAttempt !== undefined ||
              current.run.budget.attemptsUsed !== input.execution.attempt ||
              current.lease?.id !== input.execution.leaseID ||
              current.lease.ownerID !== input.execution.ownerID ||
              DateTime.toEpochMillis(current.lease.expiresAt) <= DateTime.toEpochMillis(now)
            )
              return yield* new InvalidRunLeaseCapabilityError({
                runID: input.runID,
                reason: "Result receipt execution no longer owns the settled attempt and live lease.",
              })
          }
          if (requestedSettlementMode === "same-transaction") {
            const gate = ChildSettlement.settlementCommitEnableGate()
            if (!gate.ready)
              return yield* new ChildResultConflictError({
                runID: input.runID,
                reason: `Same-transaction child settlement is disabled: ${gate.blocking_gate_ids.join(", ")}. Use the durable recovery outbox.`,
              })
            if (input.admissionEvidence !== undefined)
              if (input.settlementIdentity === undefined)
                return yield* new ChildResultConflictError({
                  runID: input.runID,
                  reason: "Evidence-bearing same-transaction settlement requires a trusted settlement identity.",
                })
          }
          if (current.run.childResult) {
            const existing = current.run.childResult
            const same =
              existing.resultDigest === resultDigest &&
              existing.status === input.result.status &&
              existing.summary === input.result.summary &&
              JSON.stringify(existing.artifactRefs) === JSON.stringify(input.result.artifactRefs) &&
              JSON.stringify(existing.evidenceRefs) === JSON.stringify(input.result.evidenceRefs) &&
              sameChildBudget(existing.usage, input.result.usage)
            if (same) {
              yield* settleChildBudget(current as ChildSnapshot)
              yield* ensureSettlementOutboxForExistingResult(current as ChildSnapshot)
              return (yield* load(input.runID)) as ChildSnapshot
            }
            return yield* new ChildResultConflictError({
              runID: input.runID,
              reason: "A child result already exists with a different digest.",
            })
          }
          if (!["completed", "failed", "cancelled"].includes(current.run.status))
            return yield* new ChildResultConflictError({
              runID: input.runID,
              reason: "A child result may be recorded only after a terminal run state.",
            })
          if (
            input.result.status !== current.run.status ||
            !validRuntimeEvidenceReferences(current.run.child, input.result) ||
            !childBudgetWithin(input.result.usage, childBudgetMaxFromRun(current.run)) ||
            !sameChildBudget(input.result.usage, childBudgetFromRun(current.run))
          )
            return yield* new ChildResultConflictError({
              runID: input.runID,
              reason: "Child result status, evidence references, or usage does not match the terminal run.",
            })
          const recordedAt = yield* DateTime.now
          const result = AgentRuntime.ChildRunResult.make({
            ...input.result,
            resultDigest,
            recordedAt,
          })
          const parentRunID = current.run.child.parentRunID
          const parent = yield* load(parentRunID)
          if (!sessionSnapshot(parent))
            return yield* new ChildResultConflictError({
              runID: input.runID,
              reason: "A child settlement intent requires a SessionRun parent aggregate.",
            })
          let intent: ChildSettlement.SettlementIntent
          try {
            intent = settlementIntentFromReceipt({
              parentRunID,
              childRunID: current.run.id,
              idempotencyKey: current.run.child.idempotencyKey,
              result,
              ...(input.admissionEvidence === undefined ? {} : { admissionEvidence: input.admissionEvidence }),
              intentAt: recordedAt,
            })
          } catch (cause) {
            return yield* new ChildResultConflictError({
              runID: input.runID,
              reason: `Child settlement intent is invalid: ${String(cause)}`,
            })
          }
          const existingIntent = yield* childSettlementIntentFor(parentRunID, current.run.id)
          let settlementResult = result
          if (existingIntent) {
            try {
              const expected = settlementIntentFromReceipt({
                parentRunID,
                childRunID: existingIntent.childRunID,
                idempotencyKey: existingIntent.idempotencyKey,
                result: existingIntent.result,
                intentAt: existingIntent.intentAt,
                ...(existingIntent.admissionEvidence === undefined
                  ? {}
                  : { admissionEvidence: existingIntent.admissionEvidence }),
              })
              if (
                intent.intentID !== existingIntent.intentID ||
                intent.resultDigest !== existingIntent.result.resultDigest ||
                expected.intentID !== existingIntent.intentID ||
                expected.idempotencyDigest !== existingIntent.idempotencyDigest ||
                expected.resultDigest !== existingIntent.result.resultDigest ||
                existingIntent.childRunID !== current.run.id
              )
                throw new Error("stored settlement intent drifted")
              settlementResult = existingIntent.result
            } catch (cause) {
              return yield* new ChildResultConflictError({
                runID: input.runID,
                reason: `Stored child settlement intent conflicts with the requested result: ${String(cause)}`,
              })
            }
          } else {
            const intentPublished = yield* events
              .publish(
                AgentRuntime.Event.ChildRunSettlementIntentRecorded,
                {
                  runID: parentRunID,
                  sessionID: parent.run.sessionID,
                  childRunID: current.run.id,
                  idempotencyKey: current.run.child.idempotencyKey,
                  intentID: intent.intentID,
                  idempotencyDigest: intent.idempotencyDigest,
                  result,
                  ...(input.admissionEvidence === undefined ? {} : { admissionEvidence: input.admissionEvidence }),
                  intentAt: recordedAt,
                },
                { expectedSequence: parent.lastSequence },
              )
              .pipe(Effect.exit)
            if (intentPublished._tag === "Failure") {
              if (sequenceConflict(intentPublished.cause)) continue
              return yield* Effect.failCause(intentPublished.cause)
            }
          }
          if (requestedSettlementMode === "same-transaction") {
            // The gate above is the authoritative production switch. Once it
            // is enabled, legacy (no-admission-Evidence) children are committed
            // through the same coordinator used by the concrete adapter tests;
            // no provider or ActionGateway capability crosses this boundary.
            const reservation = yield* childReservationFor(parentRunID, current.run.id)
            if (!reservation)
              return yield* new ChildAdmissionError({
                parentRunID,
                reason: "The child run has no durable parent budget reservation.",
              })
            const actual = settlementResult.usage
            if (!childBudgetWithin(actual, reservation.reserved))
              return yield* new ChildAdmissionError({
                parentRunID,
                reason: "The child run consumed more than its admitted budget.",
              })
            const parentAfterIntent = (yield* load(parentRunID)) as SessionSnapshot
            const previous = parentAfterIntent.run.childBudgetReserved ?? zeroChildBudget()
            if (!childBudgetWithin(reservation.reserved, previous))
              return yield* new CorruptHistoryError({
                runID: parentRunID,
                sequence: parentAfterIntent.lastSequence,
                reason: "The parent reservation projection is smaller than the child reservation being settled.",
              })
            const childEventID = EventV2.ID.create()
            const parentBudgetEventID = EventV2.ID.create()
            const transactionID = `tx_${intent.intentID}`
            const committedEvents: EventV2.SerializedEvent[] = []
            const childSnapshot = current as ChildSnapshot
            if (input.admissionEvidence !== undefined) {
              // Evidence-bearing settlement is wired through the same
              // coordinator as the controlled PostgreSQL proof. It remains
              // unreachable while the authoritative gate is false, but the
              // production-shaped branch is complete: it reconstructs the
              // immutable child admission, resolves the real settled Action
              // Observation, and binds all three owners to one principal
              // transaction without carrying provider payloads.
              const identity = input.settlementIdentity
              if (identity === undefined)
                return yield* new ChildResultConflictError({
                  runID: input.runID,
                  reason: "Evidence-bearing same-transaction settlement requires a trusted settlement identity.",
                })
              const settlementPrincipal = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
              if (identity.tenantID !== settlementPrincipal.tenantID || identity.userID !== settlementPrincipal.userID)
                return yield* new ChildResultConflictError({
                  runID: input.runID,
                  reason: "Settlement identity does not match the current database principal.",
                })
              const binding = childSnapshot.run.child
              const receipt = input.admissionEvidence
              if (binding.runtimeAdmission === undefined || receipt.actionID === undefined)
                return yield* new ChildResultConflictError({
                  runID: input.runID,
                  reason:
                    "Evidence-bearing same-transaction settlement requires an immutable admission receipt and Action ID.",
                })
              const action = yield* actions.load(receipt.actionID).pipe(
                Effect.mapError(
                  (error) =>
                    new ChildResultConflictError({
                      runID: input.runID,
                      reason: `Admission Action could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
                    }),
                ),
              )
              if (
                action.action.runID !== childSnapshot.run.id ||
                action.action.status !== "settled" ||
                action.observation === undefined
              )
                return yield* new ChildResultConflictError({
                  runID: input.runID,
                  reason: "Admission Evidence requires a settled Action belonging to the child run.",
                })
              if (
                receipt.observationID !== undefined &&
                String(receipt.observationID) !== String(action.observation.id)
              )
                return yield* new ChildResultConflictError({
                  runID: input.runID,
                  reason: "Admission Evidence observation does not match the settled Action.",
                })
              let admissionPlan: AdmissionEvidence.Plan
              let materialized: AdmissionEvidence.Materialized
              try {
                admissionPlan = AdmissionEvidence.plan({
                  identity,
                  parentRunID,
                  childRunID: childSnapshot.run.id,
                  idempotencyKey: binding.idempotencyKey,
                  admission: binding.runtimeAdmission.evidence,
                  evidenceRefs: binding.runtimeAdmission.evidenceRefs,
                })
                materialized = AdmissionEvidence.materialize({
                  plan: admissionPlan,
                  actionID: receipt.actionID,
                  observation: action.observation,
                })
              } catch (cause) {
                return yield* new ChildResultConflictError({
                  runID: input.runID,
                  reason: `Admission Evidence cannot be reconstructed: ${String(cause)}`,
                })
              }
              if (
                String(admissionPlan.evidenceID) !== String(receipt.evidenceID) ||
                materialized.recordDigest.toLowerCase() !== receipt.recordDigest.toLowerCase() ||
                (receipt.observationID !== undefined &&
                  String(materialized.observationID) !== String(receipt.observationID))
              )
                return yield* new ChildResultConflictError({
                  runID: input.runID,
                  reason:
                    "Admission Evidence receipt does not match the immutable child admission or Action Observation.",
                })
              const sharedTransactionEvidence = ChildSettlement.makeSettlementSharedTransactionEvidence({
                transactionKey: `settlement:${intent.intentID}`,
                transactionID,
                ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
              })
              const plan = ChildSettlement.planSettlementCommit(intent, {
                mode: "same-transaction",
                atomicDatabaseTransaction: true,
                durableRecoveryOutbox: false,
                sharedTransactionEvidence,
              })
              const { createSettlementOwnerWriters } = yield* Effect.promise(
                () => import("./settlement-owner-adapters"),
              )
              const writers = createSettlementOwnerWriters({
                plan,
                admission: {
                  identity,
                  plan: admissionPlan,
                  actionID: receipt.actionID,
                  observation: action.observation,
                },
                childResult: {
                  eventID: childEventID,
                  sessionID: childSnapshot.run.sessionID,
                  result: settlementResult,
                  expectedSequence: current.lastSequence,
                },
                parentBudget: {
                  eventID: parentBudgetEventID,
                  sessionID: parentAfterIntent.run.sessionID,
                  reserved: reservation.reserved,
                  actual,
                  reservedTotal: subtractChildBudget(previous, reservation.reserved),
                  settledAt: settlementResult.recordedAt,
                  expectedSequence: parentAfterIntent.lastSequence,
                },
                onOwnerWrite: ({ owner, aggregateID, seq }) => {
                  if (owner === "child-result")
                    committedEvents.push({
                      id: childEventID,
                      type: EventV2.versionedType(AgentRuntime.Event.ChildRunResultRecorded.type, 1),
                      seq,
                      aggregateID,
                      data: {
                        runID: childSnapshot.run.id,
                        parentRunID,
                        sessionID: childSnapshot.run.sessionID,
                        result: settlementResult,
                      },
                    })
                  else
                    committedEvents.push({
                      id: parentBudgetEventID,
                      type: EventV2.versionedType(AgentRuntime.Event.ChildRunBudgetSettled.type, 1),
                      seq,
                      aggregateID,
                      data: {
                        runID: parentRunID,
                        sessionID: parentAfterIntent.run.sessionID,
                        childRunID: childSnapshot.run.id,
                        reserved: reservation.reserved,
                        actual,
                        reservedTotal: subtractChildBudget(previous, reservation.reserved),
                        settledAt: settlementResult.recordedAt,
                      },
                    })
                },
              })
              const execution = yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
                database,
                plan,
                sharedTransactionEvidence,
                writers,
                principal: settlementPrincipal,
                beforeCommit: ({ transaction, execution }) =>
                  SettlementObservationJournal.appendInTransaction({
                    transaction,
                    parentRunID,
                    sessionID: parentAfterIntent.run.sessionID,
                    childRunID: childSnapshot.run.id,
                    observerID: `durable-run:${parentRunID}`,
                    execution,
                    plan,
                    sharedTransactionEvidence,
                    minimumSamples: 8,
                  }).pipe(
                    Effect.tap((record) => Effect.sync(() => committedEvents.push(record.serializedEvent))),
                    Effect.asVoid,
                  ),
                observedAtMs: DateTime.toEpochMillis(settlementResult.recordedAt),
              }).pipe(
                Effect.mapError(
                  (error) =>
                    new ChildResultConflictError({
                      runID: input.runID,
                      reason: `Same-transaction settlement failed: ${error instanceof Error ? error.message : String(error)}`,
                    }),
                ),
              )
              SettlementCoordinator.assertSettlementTransactionExecution(execution, {
                plan,
                sharedTransactionEvidence,
              })
              yield* Effect.forEach(
                committedEvents,
                (event) =>
                  events.replay(event, { publish: true }).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Evidence settlement notification replay failed", {
                        eventID: event.id,
                        aggregateID: event.aggregateID,
                        cause,
                      }).pipe(Effect.asVoid),
                    ),
                  ),
                { concurrency: 1, discard: true },
              )
              return (yield* load(input.runID)) as ChildSnapshot
            }
            const plan = ChildSettlement.planSettlementCommit(intent, {
              mode: "same-transaction",
              atomicDatabaseTransaction: true,
              durableRecoveryOutbox: false,
            })
            // Keep the adapter module lazy: its Evidence-bearing branch loads
            // ExperienceStore, whose service graph references DurableRun. A
            // dynamic import here avoids an eager module-cycle while keeping
            // the gate-ready legacy path on the one canonical adapter factory.
            const { createLegacySettlementOwnerWriters } = yield* Effect.promise(
              () => import("./settlement-owner-adapters"),
            )
            const writers = createLegacySettlementOwnerWriters({
              plan,
              childResult: {
                eventID: childEventID,
                sessionID: childSnapshot.run.sessionID,
                result: settlementResult,
                expectedSequence: current.lastSequence,
              },
              parentBudget: {
                eventID: parentBudgetEventID,
                sessionID: parentAfterIntent.run.sessionID,
                reserved: reservation.reserved,
                actual,
                reservedTotal: subtractChildBudget(previous, reservation.reserved),
                settledAt: settlementResult.recordedAt,
                expectedSequence: parentAfterIntent.lastSequence,
              },
              onOwnerWrite: ({ owner, aggregateID, seq }) => {
                if (owner === "child-result")
                  committedEvents.push({
                    id: childEventID,
                    type: EventV2.versionedType(AgentRuntime.Event.ChildRunResultRecorded.type, 1),
                    seq,
                    aggregateID,
                    data: {
                      runID: childSnapshot.run.id,
                      parentRunID,
                      sessionID: childSnapshot.run.sessionID,
                      result: settlementResult,
                    },
                  })
                else
                  committedEvents.push({
                    id: parentBudgetEventID,
                    type: EventV2.versionedType(AgentRuntime.Event.ChildRunBudgetSettled.type, 1),
                    seq,
                    aggregateID,
                    data: {
                      runID: parentRunID,
                      sessionID: parentAfterIntent.run.sessionID,
                      childRunID: childSnapshot.run.id,
                      reserved: reservation.reserved,
                      actual,
                      reservedTotal: subtractChildBudget(previous, reservation.reserved),
                      settledAt: settlementResult.recordedAt,
                    },
                  })
              },
            })
            const settlementPrincipal = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
            const execution = yield* SettlementCoordinator.executeLegacySettlementTransactionAsPrincipal({
              database,
              plan,
              transactionID,
              writers,
              // The helper binds this principal and all owner writes through
              // one canonical Database.transactionAsPrincipal runner. The
              // gate remains the authority for whether this branch is
              // reachable; the helper only prevents a future production
              // caller from forgetting the RLS context.
              principal: settlementPrincipal,
              observedAtMs: DateTime.toEpochMillis(settlementResult.recordedAt),
            }).pipe(
              Effect.mapError(
                (error) =>
                  new ChildResultConflictError({
                    runID: input.runID,
                    reason: `Same-transaction settlement failed: ${error instanceof Error ? error.message : String(error)}`,
                  }),
              ),
            )
            SettlementCoordinator.assertLegacySettlementTransactionExecution(execution, {
              plan,
              transactionID,
            })
            // EventV2 intentionally separates SQL commit from notifications.
            // Replay is exact/idempotent and only publishes after the outer
            // transaction has committed; a notification failure cannot cause
            // a provider retry or fabricate a rollback.
            yield* Effect.forEach(
              committedEvents,
              (event) =>
                events.replay(event, { publish: true }).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Legacy settlement notification replay failed", {
                      eventID: event.id,
                      aggregateID: event.aggregateID,
                      cause,
                    }).pipe(Effect.asVoid),
                  ),
                ),
              { concurrency: 1, discard: true },
            )
            return (yield* load(input.runID)) as ChildSnapshot
          }
          const preparedSettlement = yield* prepareSettlementOutbox(intent, DateTime.toEpochMillis(recordedAt))
          const published = yield* events
            .publish(
              AgentRuntime.Event.ChildRunResultRecorded,
              {
                runID: input.runID,
                parentRunID: current.run.child.parentRunID,
                sessionID: current.run.sessionID,
                result: settlementResult,
              },
              { expectedSequence: current.lastSequence },
            )
            .pipe(Effect.exit)
          if (published._tag === "Success") {
            const child = (yield* load(input.runID)) as ChildSnapshot
            yield* settleChildBudget(child)
            yield* commitLegacySettlementOutbox({
              identity: preparedSettlement.identity,
              plan: preparedSettlement.plan,
              observedAtMs: DateTime.toEpochMillis(recordedAt),
            })
            return child
          }
          if (!sequenceConflict(published.cause)) return yield* Effect.failCause(published.cause)
        }
        return yield* Effect.die(new Error(`Child result contention did not converge for ${input.runID}`))
      },
    )

    const restoreAccessFailure = (defect: unknown) =>
      defect instanceof AccessDeniedError || defect instanceof TreeScopeError ? Effect.fail(defect) : Effect.die(defect)

    const pendingCancellationBlocker = Effect.fnUntraced(function* (current: SessionSnapshot) {
      if (current.run.child) return "child-run" as const
      if (leaseActive(current.lease, DateTime.toEpochMillis(yield* DateTime.now))) return "lease-held" as const
      if (!["draft", "preflight", "awaiting_authorization", "queued"].includes(current.run.status))
        return "not-pending" as const
      const budget = current.run.budget
      if (
        current.activeAttempt ||
        budget.attemptsUsed ||
        budget.durationMsUsed ||
        budget.tokensUsed ||
        budget.costMicrosUsed
      )
        return "execution-started" as const
      if (current.checkpoint || current.run.childBudgetReserved) return "dependent-work" as const
      const runID = current.run.id
      // Cross-aggregate request, action and child facts must be checked again
      // inside the original cancellation event transaction, not just in a UI.
      const references = usesPostgres
        ? sql`(${EventTable.data}::jsonb ->> 'runID' = ${runID} OR ${EventTable.data}::jsonb ->> 'parentRunID' = ${runID} OR ${EventTable.data}::jsonb #>> '{action,runID}' = ${runID})`
        : sql`(json_extract(${EventTable.data}, '$.runID') = ${runID} OR json_extract(${EventTable.data}, '$.parentRunID') = ${runID} OR json_extract(${EventTable.data}, '$.action.runID') = ${runID})`
      const work = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(and(sql`${EventTable.aggregate_id} <> ${runID}`, references))
        .get()
        .pipe(Effect.orDie)
      const usage = yield* db
        .select({ id: SessionRunUsageTable.id })
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      return work || usage ? ("dependent-work" as const) : null
    })

    const unknownSessionRequest = Effect.fnUntraced(function* (current: SessionSnapshot) {
      const dispatch = yield* Effect.try({
        try: () => {
          const checkpoint =
            current.checkpoint && SessionCheckpoint.fromContainer(current.checkpoint.state, current.run.sessionID)
          if (!checkpoint || checkpoint.legacy || checkpoint.kind !== SessionCheckpoint.KIND) return undefined
          const dispatch = checkpoint.dispatch
          if (!dispatch || dispatch.phase !== "dispatching") return undefined
          if (
            dispatch.requestDigest !== checkpoint.lastTurn.requestDigest ||
            dispatch.turnStep !== checkpoint.lastTurn.turnStep
          )
            throw new Error("Invalid dispatch binding")
          return dispatch
        },
        catch: () => new RequestAbandonmentError({ code: "request-unverified" }),
      })
      if (!dispatch) return undefined
      const rows = yield* EventV2.readSerialized(db, {
        aggregateIDs: [current.run.sessionID],
        types: [EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)],
      })
      yield* Effect.try({
        try: () => {
          const row = rows.find((row) => row.id === dispatch.requestEventID)
          if (!row) throw new Error("Missing original request")
          const data = Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(row.data)
          const envelope = parseRequestEnvelopeJson(data.envelope)
          if (
            data.sessionID !== current.run.sessionID ||
            data.runID !== current.run.id ||
            data.turnStep !== dispatch.turnStep ||
            data.attempt === undefined ||
            data.attempt !== dispatch.attempt ||
            data.attempt !== envelope.execution.attempt ||
            data.schemaVersion !== envelope.schema_version ||
            data.requestDigest !== dispatch.requestDigest ||
            envelope.request_digest !== dispatch.requestDigest ||
            envelope.execution.run_id !== current.run.id ||
            envelope.execution.turn_step !== dispatch.turnStep
          )
            throw new Error("Original request binding mismatch")
        },
        catch: () => new RequestAbandonmentError({ code: "request-unverified" }),
      })
      return dispatch
    })

    const requestAbandonmentBlocker = Effect.fnUntraced(function* (
      current: SessionSnapshot,
    ): Effect.fn.Return<
      RequestAbandonmentBlocker | null,
      CorruptHistoryError | NotFoundError | DurableAction.CorruptHistoryError
    > {
      if (current.run.child) return "child-run"
      if (current.run.admission?.personalJob) return "owned-job"
      if (current.lease) return "lease-held"
      if (current.run.status !== "paused") return "not-paused"
      if (
        current.activeAttempt ||
        (yield* listChildren({ parentRunID: current.run.id, includeTerminal: false })).length > 0
      )
        return "dependent-work"
      const reserved = current.run.childBudgetReserved
      if (reserved && Object.values(reserved).some((value) => value > 0)) return "dependent-work"
      if (
        (yield* actions.list({ runID: current.run.id, limit: Number.MAX_SAFE_INTEGER })).some(
          (item) => !["settled", "cancelled"].includes(item.action.status),
        )
      )
        return "dependent-work"
      return null
    })

    const sessionRecovery: Interface["sessionRecovery"] = Effect.fn("DurableRun.sessionRecovery")(
      function* (sessionID) {
        yield* yield* CurrentCheck
        const pending = (yield* list({ sessionID, limit: Number.MAX_SAFE_INTEGER }))
          .filter(sessionSnapshot)
          .filter((item) => !["completed", "failed", "cancelled"].includes(item.run.status))
        return yield* Effect.forEach(pending, (item) =>
          Effect.gen(function* () {
            const request = yield* unknownSessionRequest(item)
            return {
              runID: item.run.id,
              sessionID: item.run.sessionID,
              status: item.run.status,
              revision: item.lastSequence,
              admissionRecorded: item.run.admission !== undefined,
              leaseExpiresAt: item.lease ? DateTime.toEpochMillis(item.lease.expiresAt) : null,
              cancellationBlocker: yield* pendingCancellationBlocker(item),
              ...(request
                ? {
                    request: {
                      eventID: request.requestEventID,
                      digest: request.requestDigest,
                      outcome: "unknown" as const,
                      abandonmentBlocker: yield* requestAbandonmentBlocker(item),
                    },
                  }
                : {}),
            } satisfies SessionRecoveryItem
          }),
        )
      },
    )

    const cancelPendingSession: Interface["cancelPendingSession"] = Effect.fn("DurableRun.cancelPendingSession")(
      function* (input) {
        yield* yield* CurrentCheck
        const current = yield* load(input.runID)
        if (!sessionSnapshot(current) || current.run.sessionID !== input.sessionID)
          return yield* new PendingCancellationError({ code: "foreign-session" })
        if (
          !Number.isSafeInteger(input.expectedSequence) ||
          input.expectedSequence < 0 ||
          current.lastSequence !== input.expectedSequence
        )
          return yield* new PendingCancellationError({ code: "stale-revision" })
        const blocker = yield* pendingCancellationBlocker(current)
        if (blocker) return yield* new PendingCancellationError({ code: blocker })
        const changedAt = yield* DateTime.now
        yield* publishState(current.run, {
          to: "cancelled",
          reason: "User explicitly cancelled the inspected unstarted task; accepted input and history retained",
          changedAt,
          expectedSequence: input.expectedSequence,
          commit: () =>
            Effect.gen(function* () {
              const latest = yield* load(input.runID)
              if (!sessionSnapshot(latest) || latest.lastSequence !== input.expectedSequence)
                return yield* Effect.die(new PendingCancellationError({ code: "stale-revision" }))
              const changed = yield* pendingCancellationBlocker(latest)
              if (changed) return yield* Effect.die(new PendingCancellationError({ code: changed }))
              return yield* Effect.void
            }).pipe(Effect.orDie),
        }).pipe(
          Effect.catchDefect(
            (error): Effect.Effect<never, PendingCancellationError | AccessDeniedError | TreeScopeError> =>
              error instanceof EventV2.AggregateSequenceConflictError
                ? Effect.fail(new PendingCancellationError({ code: "stale-revision" }))
                : error instanceof PendingCancellationError
                  ? Effect.fail(error)
                  : restoreAccessFailure(error),
          ),
        )
        const cancelled = yield* load(input.runID)
        if (!sessionSnapshot(cancelled)) return yield* new PendingCancellationError({ code: "foreign-session" })
        return cancelled
      },
    )

    const abandonSessionRequest: Interface["abandonSessionRequest"] = Effect.fn("DurableRun.abandonSessionRequest")(
      function* (input) {
        const validate = Effect.gen(function* () {
          yield* yield* CurrentCheck
          if (input.acknowledgeUnknownOutcome !== true)
            return yield* new RequestAbandonmentError({ code: "confirmation-required" })
          const current = yield* load(input.runID)
          if (!sessionSnapshot(current) || current.run.sessionID !== input.sessionID)
            return yield* new RequestAbandonmentError({ code: "foreign-session" })
          if (
            !Number.isSafeInteger(input.expectedSequence) ||
            input.expectedSequence < 0 ||
            current.lastSequence !== input.expectedSequence
          )
            return yield* new RequestAbandonmentError({ code: "stale-revision" })
          const blocker = yield* requestAbandonmentBlocker(current)
          if (blocker) return yield* new RequestAbandonmentError({ code: blocker })
          const dispatch = yield* unknownSessionRequest(current)
          if (!dispatch) return yield* new RequestAbandonmentError({ code: "request-unverified" })
          if (dispatch.requestEventID !== input.requestEventID || dispatch.requestDigest !== input.requestDigest)
            return yield* new RequestAbandonmentError({ code: "request-mismatch" })
          return current
        })
        const current = yield* validate
        yield* publishState(current.run, {
          to: "cancelled",
          reason: REQUEST_ABANDONED_REASON,
          changedAt: yield* DateTime.now,
          expectedSequence: input.expectedSequence,
          // Repeat authorization, request, live-work and revision checks in
          // the original Run event transaction. There is no new decision store.
          commit: () => validate.pipe(Effect.asVoid, Effect.orDie),
        }).pipe(
          Effect.catchDefect(
            (error): Effect.Effect<never, RequestAbandonmentError | AccessDeniedError | TreeScopeError> => {
              if (error instanceof EventV2.AggregateSequenceConflictError)
                return Effect.fail(new RequestAbandonmentError({ code: "stale-revision" }))
              if (error instanceof RequestAbandonmentError) return Effect.fail(error)
              return restoreAccessFailure(error)
            },
          ),
        )
        const abandoned = yield* load(input.runID)
        if (!sessionSnapshot(abandoned)) return yield* new RequestAbandonmentError({ code: "foreign-session" })
        return abandoned
      },
    )

    const cancelOne = Effect.fnUntraced(function* (runID: AgentRuntime.RunID, reason: string) {
      yield* yield* CurrentCheck
      let current = yield* load(runID)
      if (controlSnapshot(current))
        return yield* new ChildAdmissionError({
          parentRunID: runID,
          reason: "ControlRun cancellation is not part of the SessionRun child-run contract.",
        })
      if (["completed", "failed", "cancelled"].includes(current.run.status)) {
        if (childRun(current.run)) yield* settleChildBudget(current as ChildSnapshot)
        return current
      }
      if (current.activeAttempt) {
        const now = yield* DateTime.now
        yield* yield* CurrentCheck
        yield* finishAttemptInternal({
          runID,
          attempt: current.activeAttempt.attempt,
          outcome: "interrupted",
          durationMs: Math.max(
            0,
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(current.activeAttempt.startedAt),
          ),
          costMicros: 0,
          tokens: 0,
          commit: () =>
            Effect.gen(function* () {
              yield* yield* CurrentCheck
            }).pipe(Effect.orDie),
        }).pipe(Effect.catchDefect(restoreAccessFailure))
        current = yield* load(runID)
      }
      if (!canTransition(current.run.status, "cancelled"))
        return yield* new InvalidTransitionError({ runID, from: current.run.status, to: "cancelled" })
      yield* yield* CurrentCheck
      yield* transitionInternal({ runID, to: "cancelled", reason }).pipe(
        // EventV2's transaction callback has a no-error contract. Restore
        // known authorization failures after rollback; preserve other defects.
        Effect.catchDefect(restoreAccessFailure),
      )
      const cancelled = yield* load(runID)
      if (childRun(cancelled.run)) yield* settleChildBudget(cancelled as ChildSnapshot)
      return cancelled
    })

    type ChildCancelError =
      | AccessDeniedError
      | TreeScopeError
      | NotFoundError
      | CorruptHistoryError
      | InvalidTransitionError
      | AttemptMismatchError
      | InvalidAttemptStateError
      | ChildAdmissionError
    let cancelTree: (runID: AgentRuntime.RunID, reason: string) => Effect.Effect<Snapshot, ChildCancelError>
    cancelTree = Effect.fnUntraced(function* (runID: AgentRuntime.RunID, reason: string) {
      yield* yield* CurrentCheck
      yield* recoverChildren({ parentRunID: runID })
      yield* yield* CurrentCheck
      const children = yield* listChildren({ parentRunID: runID, includeTerminal: false })
      for (const child of children) yield* cancelTree(child.run.id, `parent ${runID} cancelled: ${reason}`)
      const result = yield* cancelOne(runID, reason)
      // Close the admission race: after the parent cancellation commits, no
      // new child can reserve against it, so a final sweep is complete.
      const lateChildren = yield* listChildren({ parentRunID: runID, includeTerminal: false })
      for (const child of lateChildren) yield* cancelTree(child.run.id, `parent ${runID} cancelled: ${reason}`)
      return result
    }) as (runID: AgentRuntime.RunID, reason: string) => Effect.Effect<Snapshot, ChildCancelError>

    const cancel: Interface["cancel"] = Effect.fn("DurableRun.cancel")(function* (input) {
      if (input.recursive === false) return yield* cancelOne(input.runID, input.reason)
      return yield* cancelTree(input.runID, input.reason)
    })

    const cancelChild: Interface["cancelChild"] = Effect.fn("DurableRun.cancelChild")(function* (input) {
      const child = yield* load(input.childRunID)
      if (!sessionRun(child.run) || !childRun(child.run))
        return yield* new ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "Parent-scoped cancellation requires a SessionRun child binding.",
        })
      if (child.run.child.parentRunID !== input.parentRunID)
        return yield* new ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "The supplied parent does not match the child's immutable parent binding.",
        })
      yield* cancel({
        runID: input.childRunID,
        reason: input.reason,
        recursive: input.recursive,
      })

      const result = yield* load(input.childRunID)
      if (!sessionRun(result.run) || !childRun(result.run))
        return yield* new ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "The child changed to a non-child run while cancellation was being committed.",
        })
      return result as ChildSnapshot
    })

    const readChildSettlementIntent: Interface["readChildSettlementIntent"] = Effect.fn(
      "DurableRun.readChildSettlementIntent",
    )(function* (input) {
      const parent = yield* load(input.parentRunID)
      if (!sessionSnapshot(parent) || childRun(parent.run))
        return yield* new CorruptHistoryError({
          runID: input.parentRunID,
          sequence: parent.lastSequence,
          reason: "Settlement intent requires a parent SessionRun aggregate.",
        })
      const child = yield* load(input.childRunID)
      if (!sessionRun(child.run) || !childRun(child.run))
        return yield* new ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "Settlement intent requires a SessionRun child binding.",
        })
      if (child.run.child.parentRunID !== input.parentRunID)
        return yield* new ChildParentMismatchError({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          reason: "The supplied parent does not match the child's immutable parent binding.",
        })
      const raw = yield* childSettlementIntentFor(input.parentRunID, input.childRunID)
      if (!raw) return undefined
      if (
        raw.runID !== input.parentRunID ||
        raw.sessionID !== parent.run.sessionID ||
        raw.childRunID !== input.childRunID ||
        raw.childRunID === input.parentRunID
      )
        return yield* new CorruptHistoryError({
          runID: input.parentRunID,
          sequence: parent.lastSequence,
          reason: "Settlement intent does not match its parent or requested child identity.",
        })
      try {
        return settlementIntentFromReceipt({
          parentRunID: raw.runID,
          childRunID: raw.childRunID,
          idempotencyKey: raw.idempotencyKey,
          result: raw.result,
          intentAt: raw.intentAt,
          ...(raw.admissionEvidence === undefined ? {} : { admissionEvidence: raw.admissionEvidence }),
        })
      } catch (cause) {
        return yield* new CorruptHistoryError({
          runID: input.parentRunID,
          sequence: parent.lastSequence,
          reason: `Settlement intent failed immutable validation: ${String(cause)}`,
        })
      }
    })

    const readSettlementObservation: Interface["readSettlementObservation"] = Effect.fn(
      "DurableRun.readSettlementObservation",
    )(function* (input) {
      const parent = yield* load(input.parentRunID)
      if (!sessionSnapshot(parent) || childRun(parent.run))
        return yield* new CorruptHistoryError({
          runID: input.parentRunID,
          sequence: parent.lastSequence,
          reason: "Settlement observation requires a parent SessionRun aggregate.",
        })
      return yield* SettlementObservationJournal.load(db, {
        parentRunID: input.parentRunID,
        observerID: input.observerID,
        ...(input.minimumSamples === undefined ? {} : { minimumSamples: input.minimumSamples }),
      }).pipe(
        Effect.mapError(
          (error) =>
            new CorruptHistoryError({
              runID: input.parentRunID,
              sequence:
                error instanceof SettlementObservationJournal.SettlementObservationJournalError
                  ? (error.sequence ?? parent.lastSequence)
                  : parent.lastSequence,
              reason: `Settlement observation journal failed strict recovery: ${error instanceof Error ? error.message : String(error)}`,
            }),
        ),
      )
    })

    return Service.of({
      sessionRecovery,
      cancelPendingSession,
      abandonSessionRequest,
      create: Effect.fn("DurableRun.create")(function* (input, options) {
        if (input.admission && (!options?.exclusiveSession || !options.initialLease))
          return yield* Effect.die(
            new Error("Root Runner admission requires exclusive creation with its initial lease"),
          )
        if (options?.initialLease && (!validTtl(options.initialLease.ttlMs) || !options.initialLease.ownerID))
          return yield* Effect.die(new Error("Initial admission lease requires an owner and a valid duration"))
        const now = yield* DateTime.now
        const run = AgentRuntime.SessionRun.make({
          ...input,
          id: input.id ?? AgentRuntime.RunID.create(),
          status: "draft",
          time: { created: now, updated: now },
        })
        const initialLease = options?.initialLease
          ? AgentRuntime.RunLease.make({
              id: AgentRuntime.LeaseID.create(),
              runID: run.id,
              ownerID: options.initialLease.ownerID,
              generation: 0,
              acquiredAt: now,
              heartbeatAt: now,
              expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + options.initialLease.ttlMs),
            })
          : undefined
        yield* events.publish(
          AgentRuntime.Event.RunCreated,
          { runID: run.id, sessionID: run.sessionID, run, initialLease },
          options?.exclusiveSession
            ? {
                // EventV2 executes this inside the original RunCreated transaction,
                // before publishing the event or notifying observers. SQLite uses
                // BEGIN IMMEDIATE. PostgreSQL additionally locks the existing Session
                // row so different new run IDs cannot both pass the admission read.
                commit: () =>
                  Effect.gen(function* () {
                    if (usesPostgres) {
                      yield* db
                        .run(
                          sql`SELECT ${SessionTable.id} FROM ${SessionTable}
                  WHERE ${SessionTable.id} = ${run.sessionID} FOR UPDATE`,
                        )
                        .pipe(Effect.orDie)
                      const session = yield* db
                        .select({ id: SessionTable.id })
                        .from(SessionTable)
                        .where(eq(SessionTable.id, run.sessionID))
                        .get()
                        .pipe(Effect.orDie)
                      if (!session)
                        return yield* Effect.die(new Error("Session admission requires its existing session row"))
                    }
                    const sessionRuns = yield* list({
                      sessionID: run.sessionID,
                      limit: Number.MAX_SAFE_INTEGER,
                    }).pipe(Effect.orDie)
                    const origin = run.admission?.personalJob
                    const previousOccurrence =
                      origin &&
                      sessionRuns.find(
                        ({ run: previous }) =>
                          "admission" in previous &&
                          previous.admission?.personalJob?.jobID === origin.jobID &&
                          previous.admission.personalJob.occurrence.messageID === origin.occurrence.messageID,
                      )
                    // Same transaction as RunCreated: a caller's earlier read
                    // must not race with the original occurrence becoming terminal.
                    if (previousOccurrence)
                      return yield* Effect.die(
                        new SessionAdmissionConflictError({
                          sessionID: run.sessionID,
                          runID: previousOccurrence.run.id,
                          reason:
                            "This PersonalJob occurrence already owns a run; recover its original execution or result instead of creating another run.",
                        }),
                      )
                    const unfinished = sessionRuns.find(
                      (existing) => !["completed", "failed", "cancelled"].includes(existing.run.status),
                    )
                    if (unfinished)
                      return yield* Effect.die(
                        new SessionAdmissionConflictError({
                          sessionID: run.sessionID,
                          runID: unfinished.run.id,
                          reason:
                            "Session already has an unfinished run; another process must not start a parallel execution.",
                        }),
                      )
                  }),
              }
            : undefined,
        )
        RuntimeInsight.auditRecord({
          actor: run.initiator,
          action: "run.created",
          resource: run.id,
          reason: run.reasonSummary,
          metadata: { sessionID: run.sessionID, runID: run.id, riskTier: run.riskTier, authority: run.authority },
        })
        return {
          run,
          lastSequence: 0,
          ...(initialLease ? { lease: initialLease, lastLeaseGeneration: 0 } : {}),
        } satisfies Snapshot
      }),
      createChild,
      listChildren,
      recoverChildren,
      recordChildResult,
      readChildSettlementFacts,
      readChildSettlementIntent,
      readSettlementObservation,
      cancel,
      cancelChild,
      claimControl: Effect.fn("DurableRun.claimControl")(function* (input, options) {
        const expectedOperationID = controlOperationID({
          subject: input.subject,
          claimDigest: input.operation.claimDigest,
          generation: input.operation.generation,
        })
        if (expectedOperationID === undefined || expectedOperationID !== input.operation.id)
          return yield* new InvalidControlClaimError({
            operationID: input.operation.id,
            reason: "The control operation ID does not match its request-independent claim and generation.",
          })
        const runID = controlRunID(input)
        if (runID === undefined)
          return yield* new InvalidControlClaimError({
            operationID: input.operation.id,
            reason: "The control claim identity is not canonically hashable.",
          })
        const payloadDigest = canonicalHash(input.operation.payload)
        if (payloadDigest === undefined || payloadDigest !== input.operation.payloadDigest)
          return yield* new InvalidControlClaimError({
            operationID: input.operation.id,
            reason: "The frozen control payload does not match its declared payload digest.",
          })
        const now = yield* DateTime.now
        const run: AgentRuntime.ControlRun = AgentRuntime.ControlRun.make({
          ...input,
          id: runID,
          status: "draft",
          time: { created: now, updated: now },
        })
        const published = yield* events
          .publish(
            AgentRuntime.Event.ControlRunCreated,
            { runID, subject: run.subject, run },
            {
              expectedSequence: -1,
              ...(options?.onCreated
                ? { commit: (sequence: number) => options.onCreated?.({ run, sequence }) ?? Effect.void }
                : {}),
            },
          )
          .pipe(Effect.exit)
        if (published._tag === "Success") {
          RuntimeInsight.auditRecord({
            actor: run.initiator,
            action: "control-run.claimed",
            resource: run.id,
            reason: run.reasonSummary,
            metadata: {
              runID: run.id,
              subject: run.subject.id,
              operationID: run.operation.id,
              generation: run.operation.generation,
              claimDigest: run.operation.claimDigest,
              authorizationDigest: run.operation.authorizationDigest,
              actionID: run.operation.actionID,
            },
          })
          return {
            kind: "claimed",
            snapshot: { run, lastSequence: 0 },
            presentedRequestID: input.subject.requestID,
          } satisfies ControlClaimResult
        }
        if (!sequenceConflict(published.cause)) return yield* Effect.die(published.cause)
        const existing = yield* load(runID).pipe(Effect.exit)
        if (existing._tag === "Failure")
          return yield* new ControlClaimConflictError({
            runID,
            reason: "A concurrent control claim won, but its durable run could not be reconstructed.",
          })
        if (!controlRun(existing.value.run) || !sameControlClaim(existing.value.run, run))
          return yield* new ControlClaimConflictError({
            runID,
            reason: "The deterministic control claim ID is already bound to a different subject or frozen snapshot.",
          })
        return {
          kind: "existing",
          snapshot: { ...existing.value, run: existing.value.run },
          presentedRequestID: input.subject.requestID,
        } satisfies ControlClaimResult
      }),
      load,
      transition,
      transitionControl,
      checkpoint,
      checkpointControl,
      beginAttempt,
      beginControlAttempt,
      finishAttempt,
      finishControlAttempt,
      acquireLease,
      acquireControlLease: Effect.fn("DurableRun.acquireControlLease")(function* (input) {
        if (!validTtl(input.ttlMs)) return yield* new InvalidLeaseDurationError({ ttlMs: input.ttlMs })
        for (let contention = 0; contention < 6; contention++) {
          const current = yield* load(input.runID)
          if (!controlSnapshot(current))
            return yield* new InvalidRunLeaseCapabilityError({
              runID: input.runID,
              reason: "Only a control-plane run can issue a control run lease capability.",
            })
          const now = yield* DateTime.now
          const nowMs = DateTime.toEpochMillis(now)
          if (leaseActive(current.lease, nowMs))
            return yield* new LeaseHeldError({
              runID: input.runID,
              ownerID: current.lease!.ownerID,
              expiresAtMs: DateTime.toEpochMillis(current.lease!.expiresAt),
            })
          const lease = AgentRuntime.RunLease.make({
            id: AgentRuntime.LeaseID.create(),
            runID: input.runID,
            ownerID: input.ownerID,
            generation: (current.lastLeaseGeneration ?? -1) + 1,
            acquiredAt: now,
            heartbeatAt: now,
            expiresAt: DateTime.makeUnsafe(nowMs + input.ttlMs),
          })
          const exit = yield* publishLeaseAcquired(current.run, lease, current.lastSequence).pipe(Effect.exit)
          if (exit._tag === "Failure") {
            if (sequenceConflict(exit.cause)) continue
            return yield* Effect.failCause(exit.cause)
          }
          const snapshot = yield* load(input.runID)
          if (!controlSnapshot(snapshot))
            return yield* new InvalidRunLeaseCapabilityError({
              runID: input.runID,
              reason: "The acquired control lease resolved to a session run.",
            })
          const binding = controlLeaseBinding(snapshot)
          if (
            !binding ||
            binding.leaseID !== lease.id ||
            binding.ownerID !== lease.ownerID ||
            binding.generation !== lease.generation
          )
            return yield* new InvalidRunLeaseCapabilityError({
              runID: input.runID,
              reason: "The acquired control lease was superseded before a capability could be issued.",
            })
          const capability = mintRunLeaseCapability(binding)
          RuntimeInsight.auditRecord({
            actor: "recovery",
            action: "run.lease.acquired",
            resource: input.runID,
            reason: "Worker acquired exclusive durable control execution lease",
            metadata: {
              runID: input.runID,
              leaseID: lease.id,
              ownerID: input.ownerID,
              generation: lease.generation,
            },
          })
          return { snapshot, capability }
        }
        return yield* Effect.die(new Error(`Control run lease contention did not converge for ${input.runID}`))
      }),
      validateControlLease,
      validateLease,
      heartbeat,
      heartbeatControl,
      releaseLease,
      releaseControlLease,
      list,
      recoverable: Effect.fn("DurableRun.recoverable")(function* (sessionID) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        return (yield* list({ sessionID, limit: Number.MAX_SAFE_INTEGER }).pipe(Effect.orDie))
          .filter(sessionSnapshot)
          .filter(
            (item) =>
              ["paused", "recovering"].includes(item.run.status) ||
              ((item.run.status === "running" || pendingSessionAdmission(item)) && !leaseActive(item.lease, nowMs)),
          )
      }),
      recoverableControl: Effect.fn("DurableRun.recoverableControl")(function* (subject) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        // Recovery is exhaustive rather than a presentation page. Newer
        // session/terminal runs must not hide an older control run forever.
        return (yield* list({
          ...(subject ? { subject } : {}),
          limit: Number.MAX_SAFE_INTEGER,
          skipCorrupt: true,
        }).pipe(Effect.orDie))
          .filter(controlSnapshot)
          .filter(
            (item) =>
              ["draft", "preflight", "awaiting_authorization", "queued", "recovering"].includes(item.run.status) ||
              (item.run.status === "running" && !leaseActive(item.lease, nowMs)),
          )
      }),
      orphaned: Effect.fn("DurableRun.orphaned")(function* (sessionID, options) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        const snapshots = (yield* list({
          sessionID,
          limit: Number.MAX_SAFE_INTEGER,
        }).pipe(Effect.orDie)).filter(sessionSnapshot)
        if (!options?.includePendingChildren)
          return snapshots.filter(
            (item) =>
              (["running", "recovering"].includes(item.run.status) || pendingSessionAdmission(item)) &&
              !leaseActive(item.lease, nowMs),
          )
        // list is in durable creation-event order, newest first. Do not sort
        // hashed child IDs or wall-clock milliseconds to infer queue order.
        const heads = new Set<AgentRuntime.SessionRun["sessionID"]>()
        return snapshots.reverse().filter((item) => {
          if (item.run.child) {
            if (["completed", "failed", "cancelled"].includes(item.run.status)) return false
            if (heads.has(item.run.sessionID)) return false
            heads.add(item.run.sessionID)
            // Even a paused/leased head fences later continuations.
            return (
              ["draft", "preflight", "queued", "running", "recovering"].includes(item.run.status) &&
              !leaseActive(item.lease, nowMs)
            )
          }
          return (
            (["running", "recovering"].includes(item.run.status) || pendingSessionAdmission(item)) &&
            !leaseActive(item.lease, nowMs)
          )
        })
      }),
      orphanedControl: Effect.fn("DurableRun.orphanedControl")(function* (subject) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        return (yield* list({
          ...(subject ? { subject } : {}),
          limit: Number.MAX_SAFE_INTEGER,
          skipCorrupt: true,
        }).pipe(Effect.orDie))
          .filter(controlSnapshot)
          .filter(
            (item) =>
              ["running", "recovering", "verifying"].includes(item.run.status) && !leaseActive(item.lease, nowMs),
          )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, DurableAction.globalNode, SettlementOutbox.globalNode],
})
export const globalNode = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, DurableAction.globalNode, SettlementOutbox.globalNode],
})
