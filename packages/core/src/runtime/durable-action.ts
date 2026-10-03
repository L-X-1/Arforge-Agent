export * as DurableAction from "./durable-action"

import { createHash } from "node:crypto"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DurableEventManifest } from "@arforge-ai/schema/durable-event-manifest"
import { Cause, Context, DateTime, Effect, Layer, Schema } from "effect"
import { and, asc, desc, eq, lt } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { EventSequenceTable, EventTable } from "../event/sql"
import { canTransition, isTerminal } from "./action-state"
import * as MutationIntentRuntime from "./mutation-intent"
import { parseActionRequestEnvelope } from "../session/request-envelope"
import { OpaqueArtifact } from "./artifact-ref"
import { canonicalHash } from "../util/canonical-hash"

/** The frozen Action identity, never a caller-supplied receipt, owns its bytes. */
export const outputOwner = (action: AgentRuntime.Action): AgentRuntime.ArtifactOwner =>
  "sessionID" in action
    ? { scope: "session", id: String(action.sessionID) }
    : { scope: "profile", id: `control_${canonicalHash(action.subject)}` }

const validOutput = (output: AgentRuntime.ActionOutput, action: AgentRuntime.Action): boolean => {
  try {
    if (output.encoding === "artifact") {
      const reference = OpaqueArtifact.validate(output.value)
      const owner = outputOwner(action)
      return (
        reference.kind === "action_output" &&
        reference.mime === "application/json" &&
        reference.owner.scope === owner.scope &&
        reference.owner.id === owner.id &&
        reference.digest === output.digest &&
        reference.sizeBytes === output.byteLength
      )
    }
    const serialized = JSON.stringify(output.value)
    return (
      serialized !== undefined &&
      Buffer.byteLength(serialized, "utf8") === output.byteLength &&
      createHash("sha256").update(serialized).digest("hex") === output.digest
    )
  } catch {
    return false
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("DurableAction.NotFoundError", {
  actionID: AgentRuntime.ActionID,
}) {}

export class LeaseHeldError extends Schema.TaggedErrorClass<LeaseHeldError>()("DurableAction.LeaseHeldError", {
  actionID: AgentRuntime.ActionID,
  ownerID: Schema.String,
  expiresAtMs: Schema.Number,
}) {}

export class LeaseMismatchError extends Schema.TaggedErrorClass<LeaseMismatchError>()(
  "DurableAction.LeaseMismatchError",
  {
    actionID: AgentRuntime.ActionID,
    leaseID: AgentRuntime.LeaseID,
    ownerID: Schema.String,
    generation: Schema.Number,
  },
) {}

export class InvalidActionLeaseCapabilityError extends Schema.TaggedErrorClass<InvalidActionLeaseCapabilityError>()(
  "DurableAction.InvalidActionLeaseCapabilityError",
  { actionID: Schema.optional(AgentRuntime.ActionID), reason: Schema.String },
) {}

export class InvalidLeaseDurationError extends Schema.TaggedErrorClass<InvalidLeaseDurationError>()(
  "DurableAction.InvalidLeaseDurationError",
  { ttlMs: Schema.Number },
) {}

export class CorruptHistoryError extends Schema.TaggedErrorClass<CorruptHistoryError>()(
  "DurableAction.CorruptHistoryError",
  {
    actionID: AgentRuntime.ActionID,
    sequence: Schema.Number,
    reason: Schema.String,
  },
) {}

export class InvalidListCursorError extends Schema.TaggedErrorClass<InvalidListCursorError>()(
  "DurableAction.InvalidListCursorError",
  { cursor: Schema.String },
) {}

/**
 * A reconciliation record may only be attached to the exact immutable action
 * intent which produced the external evidence.  This is deliberately a
 * separate failure from corrupt replay history: callers can present a stale
 * or forged review without being allowed to append it to another action.
 */
export class ReconciliationMismatchError extends Schema.TaggedErrorClass<ReconciliationMismatchError>()(
  "DurableAction.ReconciliationMismatchError",
  {
    actionID: AgentRuntime.ActionID,
    reason: Schema.String,
  },
) {}

/**
 * An external operation reference may only be appended to the exact action
 * that created it.  Conflicting or late bindings fail closed and never
 * rewrite the immutable action identity.
 */
export class ExternalOperationBindingMismatchError extends Schema.TaggedErrorClass<ExternalOperationBindingMismatchError>()(
  "DurableAction.ExternalOperationBindingMismatchError",
  {
    actionID: AgentRuntime.ActionID,
    reason: Schema.String,
  },
) {}

export class MutationIntentMismatchError extends Schema.TaggedErrorClass<MutationIntentMismatchError>()(
  "DurableAction.MutationIntentMismatchError",
  {
    actionID: AgentRuntime.ActionID,
    reason: Schema.String,
  },
) {}

/**
 * A progress update is metadata only, but it is still bound to the current
 * Action aggregate.  A stale sequence, clock, or terminal-state update must
 * never be allowed to make an old operation look live after recovery.
 */
export class ProgressMismatchError extends Schema.TaggedErrorClass<ProgressMismatchError>()(
  "DurableAction.ProgressMismatchError",
  {
    actionID: AgentRuntime.ActionID,
    reason: Schema.String,
  },
) {}

export interface Snapshot {
  readonly action: AgentRuntime.Action
  readonly policyDecision?: AgentRuntime.PolicyDecision
  readonly authorization?: AgentRuntime.AuthorizationGrant
  readonly observation?: AgentRuntime.Observation
  readonly postProcessing?: AgentRuntime.ActionPostProcessing
  /** Latest read-only external-state evidence; it never changes action.status. */
  readonly reconciliation?: AgentRuntime.ActionReconciliation
  /** Content-free reference to an externally created operation. */
  readonly externalOperation?: AgentRuntime.ActionExternalOperationBinding
  /** Latest content-free file mutation intent; it never authorizes retry. */
  readonly mutationIntent?: AgentRuntime.MutationIntent
  /** Latest bounded operation progress; it never changes Action status. */
  readonly progress?: AgentRuntime.ActionProgress
  readonly modelRequest?: (typeof AgentRuntime.Event.ActionModelRequestPrepared.Type)["data"]
  readonly lease?: AgentRuntime.ActionLease
  readonly lastLeaseGeneration?: number
  readonly activeAttempt?: {
    readonly attempt: number
    readonly startedAt: AgentRuntime.Action["time"]["updated"]
  }
  readonly lastSequence: number
}

/** A bounded, deterministic page over the durable action proposal index. */
export interface ListPage {
  readonly items: ReadonlyArray<Snapshot>
  /** Opaque event id to pass back as `cursor`; absent means the scan is complete. */
  readonly nextCursor?: string
}

const ActionLeaseCapabilityBrand: unique symbol = Symbol("@arforge/v2/DurableAction/lease-capability")
export interface ActionLeaseCapability {
  readonly [ActionLeaseCapabilityBrand]: typeof ActionLeaseCapabilityBrand
}

export interface LeaseAcquisition {
  readonly snapshot: Snapshot
  readonly capability?: ActionLeaseCapability
}

export interface Interface {
  readonly load: (actionID: AgentRuntime.ActionID) => Effect.Effect<Snapshot, NotFoundError | CorruptHistoryError>
  readonly listPage: (input?: {
    readonly sessionID?: AgentRuntime.SessionAction["sessionID"]
    readonly runID?: AgentRuntime.RunID
    readonly limit?: number
    readonly cursor?: string
  }) => Effect.Effect<ListPage, CorruptHistoryError | InvalidListCursorError>
  readonly list: (input?: {
    readonly sessionID?: AgentRuntime.SessionAction["sessionID"]
    readonly runID?: AgentRuntime.RunID
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<Snapshot>, CorruptHistoryError>
  /**
   * Append a read-only external-state observation to the same Action
   * aggregate.  This method has no execution or retry capability and does
   * not mutate the action state; replay simply projects the latest evidence.
   */
  readonly recordReconciliation: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly intentDigest: string
    readonly idempotencyKey: string
    readonly state: AgentRuntime.ActionReconciliation["state"]
    readonly evidenceDigest: string
    readonly source: string
    readonly observedAt: DateTime.Utc
    readonly summary?: string
  }) => Effect.Effect<Snapshot, ReconciliationMismatchError | NotFoundError | CorruptHistoryError>
  /**
   * Append a content-free external operation reference to the executing
   * action.  This is used when a protocol acknowledges a server-side task
   * before returning its final result; it never authorizes retry or persists
   * the task result body.
   */
  readonly bindExternalOperation: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly binding: AgentRuntime.ActionExternalOperationBinding
  }) => Effect.Effect<Snapshot, ExternalOperationBindingMismatchError | NotFoundError | CorruptHistoryError>
  /**
   * Append a content-free file mutation intent to the same Action aggregate.
   * The intent is immutable in identity and manifest; only its phase may
   * advance through the deterministic recovery state machine.
   */
  readonly recordMutationIntent: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly intent: AgentRuntime.MutationIntent
  }) => Effect.Effect<Snapshot, MutationIntentMismatchError | NotFoundError | CorruptHistoryError>
  /**
   * Append one bounded progress record to the same Action aggregate.  Core
   * assigns the sequence/timestamp and treats an identical update as
   * idempotent; progress is never an execution or retry authority.
   */
  readonly recordProgress: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly update: AgentRuntime.ActionProgressUpdate
  }) => Effect.Effect<Snapshot, ProgressMismatchError | NotFoundError | CorruptHistoryError>
  readonly acquireLease: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly ownerID: string
    readonly ttlMs: number
  }) => Effect.Effect<
    LeaseAcquisition,
    NotFoundError | CorruptHistoryError | LeaseHeldError | InvalidLeaseDurationError | InvalidActionLeaseCapabilityError
  >
  readonly heartbeat: (input: {
    readonly capability: ActionLeaseCapability
    readonly actionID: AgentRuntime.ActionID
    readonly ttlMs: number
  }) => Effect.Effect<
    LeaseAcquisition,
    | NotFoundError
    | CorruptHistoryError
    | LeaseMismatchError
    | InvalidLeaseDurationError
    | InvalidActionLeaseCapabilityError
  >
  readonly assertLease: (
    capability: ActionLeaseCapability,
    input: { readonly actionID: AgentRuntime.ActionID },
  ) => Effect.Effect<
    Snapshot,
    NotFoundError | CorruptHistoryError | LeaseMismatchError | InvalidActionLeaseCapabilityError
  >
  readonly releaseLease: (
    capability: ActionLeaseCapability,
    input: {
      readonly actionID: AgentRuntime.ActionID
      readonly reason: string
    },
  ) => Effect.Effect<
    Snapshot,
    NotFoundError | CorruptHistoryError | LeaseMismatchError | InvalidActionLeaseCapabilityError
  >
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/DurableAction") {}

const leaseActive = (lease: AgentRuntime.ActionLease | undefined, nowMs: number) =>
  lease !== undefined && DateTime.toEpochMillis(lease.expiresAt) > nowMs

const validTtl = (ttlMs: number) => Number.isSafeInteger(ttlMs) && ttlMs > 0

const sameExternalOperationBinding = (
  left: AgentRuntime.ActionExternalOperationBinding,
  right: AgentRuntime.ActionExternalOperationBinding,
) =>
  left.version === right.version &&
  left.kind === right.kind &&
  left.server === right.server &&
  left.operation === right.operation &&
  left.taskID === right.taskID &&
  DateTime.toEpochMillis(left.boundAt) === DateTime.toEpochMillis(right.boundAt)

const sameSubject = (left: AgentRuntime.Subject, right: AgentRuntime.Subject) => {
  if (left.type !== right.type) return false
  if (left.type === "session" && right.type === "session")
    return (
      left.sessionID === right.sessionID &&
      left.agent === right.agent &&
      left.assistantMessageID === right.assistantMessageID &&
      left.toolCallID === right.toolCallID
    )
  if (left.type === "control-plane" && right.type === "control-plane")
    return (
      left.id === right.id &&
      left.location === right.location &&
      left.project === right.project &&
      left.actor === right.actor &&
      left.principalRef === right.principalRef &&
      left.requestID === right.requestID
    )
  return false
}

type ActionEventIdentity = {
  readonly actionID: AgentRuntime.ActionID
  readonly sessionID?: AgentRuntime.SessionAction["sessionID"]
  readonly subject?: AgentRuntime.Subject
}

interface ActionLeaseCapabilityBinding {
  readonly actionID: AgentRuntime.ActionID
  readonly leaseID: AgentRuntime.LeaseID
  readonly ownerID: string
  readonly generation: number
  readonly heartbeatAtMs: number
  readonly expiresAtMs: number
}

const identityMismatch = (action: AgentRuntime.Action, data: ActionEventIdentity) => {
  if (data.actionID !== action.id) return "The event actionID does not match the durable action."
  if ("sessionID" in action) {
    if (data.sessionID !== action.sessionID) return "The event sessionID does not match the durable session action."
    if (action.subject !== undefined) {
      if (data.subject === undefined) return "A subject-bound session action event must carry its canonical subject."
      if (data.subject.type !== "session" || !sameSubject(data.subject, action.subject))
        return "The event subject does not match the embedded session subject."
    } else if (data.subject !== undefined) {
      if (data.subject.type !== "session" || data.subject.sessionID !== action.sessionID)
        return "The event subject does not match the durable session action."
    }
    return undefined
  }
  if (data.sessionID !== undefined) return "A control action event cannot carry a sessionID."
  if (data.subject?.type !== "control-plane" || !sameSubject(data.subject, action.subject))
    return "The event subject does not match the durable control-plane action."
  return undefined
}

const sequenceConflict = (cause: Cause.Cause<unknown>) =>
  cause.reasons
    .filter(Cause.isDieReason)
    .some((reason) => reason.defect instanceof EventV2.AggregateSequenceConflictError)

const reconciliationDigest = /^[a-f0-9]{64}$/
const reconciliationSource = /^[a-z][a-z0-9._:-]{0,63}$/
const reconciliationIdempotencyKey = (value: string) =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 160
const reconciliationSummary = (value: string | undefined) =>
  value === undefined || (Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/.test(value))

const invalidReconciliation = (record: AgentRuntime.ActionReconciliation): string | undefined => {
  if (!reconciliationDigest.test(record.intentDigest)) return "The reconciliation intent digest is invalid."
  if (!reconciliationIdempotencyKey(record.idempotencyKey))
    return "The reconciliation idempotency key is missing or too long."
  if (!reconciliationDigest.test(record.evidenceDigest)) return "The reconciliation evidence digest is invalid."
  if (!reconciliationSource.test(record.source)) return "The reconciliation source is invalid."
  if (!(record.state === "known_success" || record.state === "known_failure" || record.state === "unknown"))
    return "The reconciliation state is invalid."
  if (record.automaticRetryAllowed !== false) return "Reconciliation evidence cannot authorize automatic retry."
  if (!Number.isSafeInteger(DateTime.toEpochMillis(record.observedAt)) || DateTime.toEpochMillis(record.observedAt) < 0)
    return "The reconciliation observation timestamp is invalid."
  if (!reconciliationSummary(record.summary)) return "The reconciliation summary is invalid."
  return undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const issuedActionLeaseCapabilities = new WeakMap<object, ActionLeaseCapabilityBinding>()
    const mintActionLeaseCapability = (binding: ActionLeaseCapabilityBinding): ActionLeaseCapability => {
      const capability: ActionLeaseCapability = {
        [ActionLeaseCapabilityBrand]: ActionLeaseCapabilityBrand,
      }
      Object.freeze(capability)
      issuedActionLeaseCapabilities.set(capability, binding)
      return capability
    }
    const revokeActionLeaseCapability = (capability: ActionLeaseCapability) => {
      issuedActionLeaseCapabilities.delete(capability)
    }

    const load = Effect.fn("DurableAction.load")(function* (actionID: AgentRuntime.ActionID) {
      const stored = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const sequence = yield* tx
              .select({ seq: EventSequenceTable.seq })
              .from(EventSequenceTable)
              .where(eq(EventSequenceTable.aggregate_id, actionID))
              .get()
              .pipe(Effect.orDie)
            const rows = yield* tx
              .select()
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, actionID))
              .orderBy(asc(EventTable.seq))
              .all()
              .pipe(Effect.orDie)
            return { latest: sequence?.seq ?? -1, rows }
          }),
        )
        .pipe(Effect.orDie)
      const collected: AgentRuntime.ActionDurableEvent[] = []
      if (stored.rows.length !== stored.latest + 1)
        return yield* new CorruptHistoryError({
          actionID,
          sequence: stored.latest,
          reason: "The event sequence projection does not match the durable action event count.",
        })
      for (let expected = 0; expected < stored.rows.length; expected++) {
        const row = stored.rows[expected]!
        if (row.seq !== expected)
          return yield* new CorruptHistoryError({
            actionID,
            sequence: row.seq,
            reason: `Durable action history is not contiguous; expected sequence ${expected}.`,
          })
        const definition = DurableEventManifest.AgentActionDurable.definitions.get(row.type)
        if (!definition?.durable)
          return yield* new CorruptHistoryError({
            actionID,
            sequence: row.seq,
            reason: `Unknown durable event type ${row.type} exists in the action aggregate.`,
          })
        const decoded = yield* Schema.decodeUnknownEffect(AgentRuntime.ActionDurableEvent, {
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
                actionID,
                sequence: row.seq,
                reason: `Durable action event ${row.type} failed strict schema decoding.`,
              }),
          ),
        )
        collected.push(decoded)
      }

      let action: AgentRuntime.Action | undefined
      let authorization: AgentRuntime.AuthorizationGrant | undefined
      let observation: AgentRuntime.Observation | undefined
      let postProcessing: AgentRuntime.ActionPostProcessing | undefined
      let reconciliation: AgentRuntime.ActionReconciliation | undefined
      let externalOperation: AgentRuntime.ActionExternalOperationBinding | undefined
      let mutationIntent: AgentRuntime.MutationIntent | undefined
      let progress: AgentRuntime.ActionProgress | undefined
      let modelRequest: Snapshot["modelRequest"]
      let lease: AgentRuntime.ActionLease | undefined
      let lastLeaseGeneration: number | undefined
      let activeAttempt: Snapshot["activeAttempt"]
      let lastFinishedAttempt:
        | {
            readonly attempt: number
            readonly outcome: "succeeded" | "failed" | "interrupted"
            readonly finishedAt: DateTime.Utc
          }
        | undefined
      let policyDecision: AgentRuntime.PolicyDecision | undefined
      for (const event of collected) {
        const sequence = event.durable?.seq ?? -1
        if (event.type === AgentRuntime.Event.ActionProposed.type) {
          let reason: string | undefined
          if (action !== undefined) reason = "A durable action aggregate may contain exactly one proposal."
          else if (sequence !== 0) reason = "The action proposal must be the first durable aggregate event."
          else if (event.data.actionID !== actionID)
            reason = "The proposal payload actionID does not match the durable aggregate identity."
          else if (event.data.action.id !== actionID)
            reason = "The embedded action id does not match the durable aggregate identity."
          else if (event.data.action.status !== "proposed")
            reason = "The embedded action in an ActionProposed event must have proposed status."
          else if ("sessionID" in event.data.action) {
            const embeddedSubject = event.data.action.subject
            if (event.data.sessionID !== event.data.action.sessionID)
              reason = "The proposal sessionID does not match the embedded session action."
            else if (event.data.subject !== undefined && event.data.subject.type !== "session")
              reason = "A session action proposal cannot carry a control-plane event subject."
            else if (
              event.data.subject?.type === "session" &&
              event.data.subject.sessionID !== event.data.action.sessionID
            )
              reason = "The proposal event subject does not match the embedded sessionID."
            else if (embeddedSubject !== undefined && embeddedSubject.type !== "session")
              reason = "A session action cannot embed a control-plane subject."
            else if (embeddedSubject?.type === "session" && embeddedSubject.sessionID !== event.data.action.sessionID)
              reason = "The embedded action subject does not match the embedded sessionID."
            else if (embeddedSubject !== undefined && event.data.subject === undefined)
              reason = "A subject-bound session action proposal must carry its canonical outer subject."
            else if (
              event.data.subject !== undefined &&
              embeddedSubject !== undefined &&
              !sameSubject(event.data.subject, embeddedSubject)
            )
              reason = "The proposal event subject does not match the embedded action subject."
          } else if (event.data.sessionID !== undefined)
            reason = "A control-plane action proposal cannot carry a sessionID."
          else if (event.data.subject?.type !== "control-plane")
            reason = "A control-plane action proposal requires its canonical control-plane subject."
          else if (!sameSubject(event.data.subject, event.data.action.subject))
            reason = "The proposal event subject does not match the embedded control-plane subject."

          if (reason)
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason,
            })
          action = event.data.action
          continue
        }
        if (!action)
          return yield* new CorruptHistoryError({
            actionID,
            sequence,
            reason: "The action proposal must be the first durable aggregate event.",
          })
        if (event.type === AgentRuntime.Event.ActionPolicyEvaluated.type) {
          const mismatch = identityMismatch(action, event.data)
          const decisionMismatch = identityMismatch(action, {
            actionID: event.data.decision.actionID,
            ...(event.data.sessionID ? { sessionID: event.data.sessionID } : {}),
            subject: event.data.decision.subject,
          })
          if (
            mismatch ||
            decisionMismatch ||
            policyDecision !== undefined ||
            action.status !== "proposed" ||
            event.data.decision.authority !== action.authority ||
            event.data.decision.riskTier !== action.riskTier ||
            event.data.decision.decision !==
              (action.authority === "forbidden" ? "deny" : action.authority === "automatic" ? "allow" : "ask")
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason:
                mismatch ??
                decisionMismatch ??
                (policyDecision !== undefined
                  ? "A durable action may contain exactly one policy decision."
                  : "The policy decision does not match the proposed action or its legal state."),
            })
          policyDecision = event.data.decision
          continue
        }
        if (event.type === AgentRuntime.Event.ActionAuthorizationGranted.type) {
          const mismatch = identityMismatch(action, event.data)
          const grant = event.data.grant
          let grantMismatch: string | undefined
          if (grant.actionID !== actionID) grantMismatch = "The authorization grant actionID does not match the action."
          else if ((grant.runID ?? undefined) !== (action.runID ?? undefined))
            grantMismatch = "The authorization grant runID does not match the action."
          else if ((grant.parentActionID ?? undefined) !== (action.parentActionID ?? undefined))
            grantMismatch = "The authorization grant parent action does not match the action."
          else if (grant.toolName !== action.name)
            grantMismatch = "The authorization grant tool name does not match the action."
          else if (grant.authority !== action.authority || grant.riskTier !== action.riskTier)
            grantMismatch = "The authorization grant policy does not match the action."
          else if (
            policyDecision === undefined ||
            grant.authority !== policyDecision.authority ||
            grant.riskTier !== policyDecision.riskTier ||
            grant.policyVersion !== policyDecision.policyVersion
          )
            grantMismatch = "The authorization grant does not match the durable policy decision."
          else if (grant.requests.length === 0)
            grantMismatch = "The authorization grant contains no enforceable permission plan."
          else if ("sessionID" in action) {
            if (!("sessionID" in grant) || grant.sessionID !== action.sessionID)
              grantMismatch = "The authorization grant does not match the session action."
            else if (action.subject !== undefined) {
              const actionSubject = action.subject
              if (
                actionSubject.type !== "session" ||
                grant.subject?.type !== "session" ||
                !sameSubject(grant.subject, actionSubject) ||
                grant.agent !== actionSubject.agent ||
                grant.assistantMessageID !== actionSubject.assistantMessageID ||
                grant.toolCallID !== actionSubject.toolCallID
              )
                grantMismatch = "The authorization grant session identity does not match the action subject."
            }
          } else if ("sessionID" in grant || !sameSubject(grant.subject, action.subject))
            grantMismatch = "The authorization grant does not match the control-plane action subject."
          if (mismatch || grantMismatch || authorization !== undefined || action.status !== "awaiting_approval")
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason:
                mismatch ??
                grantMismatch ??
                (authorization !== undefined
                  ? "A durable action may contain exactly one authorization grant."
                  : "An authorization grant can only be recorded while awaiting approval."),
            })
          authorization = event.data.grant
          continue
        }
        if (event.type === AgentRuntime.Event.ActionStateChanged.type) {
          const mismatch = identityMismatch(action, event.data)
          if (
            mismatch ||
            event.data.from !== action.status ||
            !canTransition(event.data.from, event.data.to) ||
            (event.data.from === "proposed" && event.data.to === "policy_evaluated" && policyDecision === undefined) ||
            (event.data.to === "authorized" &&
              (action.authority === "scoped_grant" || action.authority === "human") &&
              authorization === undefined) ||
            (event.data.from === "executing" &&
              event.data.to === "observed" &&
              (observation === undefined || activeAttempt !== undefined)) ||
            (event.data.from === "observed" &&
              (observation === undefined ||
                ((event.data.to === "settled" || event.data.to === "verifying") && observation.status !== "succeeded")))
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason:
                mismatch ??
                `Invalid durable action transition ${event.data.from} → ${event.data.to}; replay state was ${action.status}.`,
            })
          action = AgentRuntime.Action.make({
            ...action,
            status: event.data.to,
            time: { ...action.time, updated: event.data.changedAt },
          })
          continue
        }
        if (event.type === AgentRuntime.Event.ActionAttemptStarted.type) {
          const mismatch = identityMismatch(action, event.data)
          if (
            mismatch ||
            action.status !== "executing" ||
            activeAttempt !== undefined ||
            event.data.attempt !== action.budget.attemptsUsed + 1 ||
            event.data.attempt > action.budget.maxAttempts
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason:
                mismatch ??
                "An action attempt must start once, in order, while the action is executing and no attempt is active.",
            })
          activeAttempt = { attempt: event.data.attempt, startedAt: event.data.startedAt }
          lastFinishedAttempt = undefined
          action = AgentRuntime.Action.make({
            ...action,
            budget: { ...action.budget, attemptsUsed: event.data.attempt },
            time: { ...action.time, updated: event.data.startedAt },
          })
          continue
        }
        if (event.type === AgentRuntime.Event.ActionAttemptFinished.type) {
          const mismatch = identityMismatch(action, event.data)
          const startedAt = activeAttempt?.startedAt
          const elapsedMs =
            startedAt === undefined
              ? -1
              : DateTime.toEpochMillis(event.data.finishedAt) - DateTime.toEpochMillis(startedAt)
          if (
            mismatch ||
            action.status !== "executing" ||
            activeAttempt?.attempt !== event.data.attempt ||
            elapsedMs < 0 ||
            event.data.durationMs !== elapsedMs
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason: mismatch ?? "An action attempt finish must match the one active executing attempt.",
            })
          activeAttempt = undefined
          lastFinishedAttempt = {
            attempt: event.data.attempt,
            outcome: event.data.outcome,
            finishedAt: event.data.finishedAt,
          }
          action = AgentRuntime.Action.make({
            ...action,
            budget: {
              ...action.budget,
              durationMsUsed: action.budget.durationMsUsed + event.data.durationMs,
              costMicrosUsed: action.budget.costMicrosUsed + (event.data.costMicros ?? 0),
              tokensUsed: action.budget.tokensUsed + (event.data.tokens ?? 0),
            },
            time: { ...action.time, updated: event.data.finishedAt },
          })
          continue
        }
        if (event.type === AgentRuntime.Event.ActionObserved.type) {
          const mismatch = identityMismatch(action, event.data)
          let outputInvalid = false
          if (event.data.observation.output) {
            outputInvalid =
              !validOutput(event.data.observation.output, action) ||
              event.data.observation.outputDigest !== event.data.observation.output.digest
          } else if (event.data.observation.outputDigest !== undefined) outputInvalid = true
          if (
            mismatch ||
            outputInvalid ||
            observation !== undefined ||
            event.data.observation.actionID !== actionID ||
            action.status !== "executing" ||
            activeAttempt !== undefined ||
            action.budget.attemptsUsed === 0 ||
            lastFinishedAttempt?.attempt !== action.budget.attemptsUsed ||
            event.data.observation.status !== lastFinishedAttempt.outcome ||
            DateTime.toEpochMillis(event.data.observation.observedAt) <
              DateTime.toEpochMillis(lastFinishedAttempt.finishedAt)
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason:
                mismatch ??
                (outputInvalid
                  ? "The durable observation output digest or byte length is invalid."
                  : observation !== undefined
                    ? "A durable action may contain exactly one observation."
                    : "An observation must match one finished execution attempt for this action."),
            })
          observation = event.data.observation
          continue
        }
        if (event.type === AgentRuntime.Event.ActionPostProcessingRecorded.type) {
          const record = event.data.processing
          const mismatch = identityMismatch(action, event.data)
          let outputInvalid = (record.state === "completed") !== (record.output !== undefined)
          if (record.output) outputInvalid ||= !validOutput(record.output, action)
          if (
            mismatch ||
            !action.resources.includes(AgentRuntime.ActionPostProcessingResource) ||
            action.status !== "settled" ||
            observation?.status !== "succeeded" ||
            !observation.output ||
            record.observationID !== observation.id ||
            outputInvalid ||
            (record.state === "started" ? postProcessing !== undefined : postProcessing?.state !== "started") ||
            DateTime.toEpochMillis(record.recordedAt) <
              DateTime.toEpochMillis(postProcessing?.recordedAt ?? observation.observedAt)
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason:
                mismatch ??
                "Postprocessing must follow one successful observation and one immutable start/terminal sequence.",
            })
          postProcessing = record
          continue
        }
        if (event.type === AgentRuntime.Event.ActionReconciled.type) {
          const mismatch = identityMismatch(action, event.data)
          const record = event.data.reconciliation
          const recordMismatch =
            record.actionID !== actionID
              ? "The reconciliation record actionID does not match the durable action."
              : action.intentDigest === undefined
                ? "A reconciliation record cannot be attached to an action without an intent digest."
                : record.intentDigest !== action.intentDigest
                  ? "The reconciliation record intent digest does not match the durable action."
                  : record.idempotencyKey !== action.idempotencyKey
                    ? "The reconciliation record idempotency key does not match the durable action."
                    : invalidReconciliation(record)
          if (mismatch || recordMismatch)
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason: mismatch ?? recordMismatch ?? "The reconciliation record is invalid.",
            })
          reconciliation = record
          continue
        }
        if (event.type === AgentRuntime.Event.ActionExternalOperationBound.type) {
          const mismatch = identityMismatch(action, event.data)
          const binding = event.data.binding
          let bindingMismatch: string | undefined
          if (action.intentDigest === undefined)
            bindingMismatch = "An external operation binding cannot be attached to an action without an intent digest."
          else if (!action.resources.includes("mcp:child-action"))
            bindingMismatch = "An external operation binding requires an MCP child action marker."
          else if (!action.resources.includes(`mcp-server:${binding.server}`))
            bindingMismatch = "The external operation server does not match the durable MCP action scope."
          else {
            const taskMarkers = action.resources
              .filter((resource) => resource.startsWith("mcp-task:"))
              .map((resource) => resource.slice("mcp-task:".length))
            if (taskMarkers.length > 0 && (taskMarkers.length !== 1 || taskMarkers[0] !== binding.taskID))
              bindingMismatch = "The external operation task reference does not match the durable MCP action scope."
            else if (externalOperation !== undefined && !sameExternalOperationBinding(externalOperation, binding))
              bindingMismatch = "An action may contain only one immutable external operation binding."
            else if (action.status !== "executing" && externalOperation === undefined)
              bindingMismatch = "An external operation binding must be recorded while the action is executing."
          }
          if (mismatch || bindingMismatch)
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason: mismatch ?? bindingMismatch ?? "The external operation binding is invalid.",
            })
          externalOperation = binding
          continue
        }
        if (event.type === AgentRuntime.Event.ActionMutationIntentRecorded.type) {
          const mismatch = identityMismatch(action, event.data)
          const invalid = MutationIntentRuntime.validate(
            event.data.intent,
            {
              actionID,
              intentDigest: action.intentDigest,
              idempotencyKey: action.idempotencyKey,
            },
            mutationIntent,
          )
          if (mismatch || invalid)
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason: mismatch ?? invalid ?? "The durable mutation intent is invalid.",
            })
          mutationIntent = event.data.intent
          continue
        }
        if (event.type === AgentRuntime.Event.ActionModelRequestPrepared.type) {
          const data = event.data
          const recordedAt = DateTime.toEpochMillis(data.recordedAt)
          let valid = true
          try {
            parseActionRequestEnvelope(data.envelope, action)
          } catch {
            valid = false
          }
          if (
            identityMismatch(action, data) ||
            modelRequest !== undefined ||
            !valid ||
            action.status !== "executing" ||
            activeAttempt?.attempt !== data.attempt ||
            lease?.id !== data.leaseID ||
            lease.generation !== data.generation ||
            recordedAt < DateTime.toEpochMillis(activeAttempt.startedAt) ||
            recordedAt >= DateTime.toEpochMillis(lease.expiresAt)
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason: "Invalid or duplicate model request binding.",
            })
          modelRequest = data
          continue
        }
        if (event.type === AgentRuntime.Event.ActionProgressRecorded.type) {
          const mismatch = identityMismatch(action, event.data)
          const candidate = event.data.progress
          const previous = progress
          const candidateTime = DateTime.toEpochMillis(candidate.updatedAt)
          const previousTime = previous === undefined ? -1 : DateTime.toEpochMillis(previous.updatedAt)
          const invalid =
            candidate.completed > candidate.total
              ? "Action progress completed count cannot exceed its total."
              : isTerminal(action.status)
                ? "Action progress cannot be appended after the durable action is terminal."
                : previous !== undefined && candidate.sequence !== previous.sequence + 1
                  ? "Action progress sequence must advance exactly once from the previous record."
                  : previous !== undefined && candidateTime <= previousTime
                    ? "Action progress timestamp must advance monotonically."
                    : undefined
          if (mismatch || invalid)
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason: mismatch ?? invalid ?? "The durable action progress record is invalid.",
            })
          progress = candidate
          continue
        }
        if (event.type === AgentRuntime.Event.ActionLeaseAcquired.type) {
          if (
            event.data.actionID !== actionID ||
            event.data.lease.actionID !== actionID ||
            event.data.lease.generation !== (lastLeaseGeneration ?? -1) + 1 ||
            isTerminal(action.status) ||
            (lease !== undefined &&
              DateTime.toEpochMillis(lease.expiresAt) > DateTime.toEpochMillis(event.data.lease.acquiredAt))
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason:
                "The action lease acquisition has invalid identity, generation, state, or overlaps an active lease.",
            })
          lease = event.data.lease
          lastLeaseGeneration = lease.generation
          continue
        }
        if (event.type === AgentRuntime.Event.ActionHeartbeatRecorded.type) {
          if (
            event.data.actionID !== actionID ||
            lease?.id !== event.data.leaseID ||
            lease.ownerID !== event.data.ownerID ||
            lease.generation !== event.data.generation ||
            DateTime.toEpochMillis(event.data.heartbeatAt) < DateTime.toEpochMillis(lease.heartbeatAt) ||
            DateTime.toEpochMillis(event.data.heartbeatAt) >= DateTime.toEpochMillis(lease.expiresAt) ||
            DateTime.toEpochMillis(event.data.expiresAt) <= DateTime.toEpochMillis(event.data.heartbeatAt)
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason: "The action lease heartbeat does not match the active lease identity or monotonic time.",
            })
          lease = AgentRuntime.ActionLease.make({
            ...lease,
            heartbeatAt: event.data.heartbeatAt,
            expiresAt: event.data.expiresAt,
          })
          continue
        }
        if (event.type === AgentRuntime.Event.ActionLeaseReleased.type) {
          if (
            event.data.actionID !== actionID ||
            lease?.id !== event.data.leaseID ||
            lease.ownerID !== event.data.ownerID ||
            lease.generation !== event.data.generation ||
            DateTime.toEpochMillis(event.data.releasedAt) < DateTime.toEpochMillis(lease.heartbeatAt)
          )
            return yield* new CorruptHistoryError({
              actionID,
              sequence,
              reason: "The action lease release does not match the active lease identity.",
            })
          lease = undefined
          continue
        }
        return yield* new CorruptHistoryError({
          actionID,
          sequence,
          reason: "Unknown action event in durable history.",
        })
      }
      if (!action) return yield* new NotFoundError({ actionID })
      return {
        action,
        ...(policyDecision ? { policyDecision } : {}),
        ...(authorization ? { authorization } : {}),
        ...(observation ? { observation } : {}),
        ...(postProcessing ? { postProcessing } : {}),
        ...(reconciliation ? { reconciliation } : {}),
        ...(externalOperation ? { externalOperation } : {}),
        ...(mutationIntent ? { mutationIntent } : {}),
        ...(progress ? { progress } : {}),
        ...(modelRequest ? { modelRequest } : {}),
        ...(lease ? { lease } : {}),
        ...(lastLeaseGeneration === undefined ? {} : { lastLeaseGeneration }),
        ...(activeAttempt ? { activeAttempt } : {}),
        lastSequence: stored.latest,
      }
    })

    const actionLeaseBinding = (snapshot: Snapshot): ActionLeaseCapabilityBinding | undefined => {
      const lease = snapshot.lease
      if (!lease) return undefined
      return {
        actionID: snapshot.action.id,
        leaseID: lease.id,
        ownerID: lease.ownerID,
        generation: lease.generation,
        heartbeatAtMs: DateTime.toEpochMillis(lease.heartbeatAt),
        expiresAtMs: DateTime.toEpochMillis(lease.expiresAt),
      }
    }

    const resolveActionLeaseCapability = Effect.fnUntraced(function* (
      capability: ActionLeaseCapability,
      actionID: AgentRuntime.ActionID,
    ) {
      const binding = issuedActionLeaseCapabilities.get(capability)
      if (!binding)
        return yield* new InvalidActionLeaseCapabilityError({
          actionID,
          reason: "The action lease capability was not issued by this runtime layer or was already revoked.",
        })
      if (binding.actionID !== actionID)
        return yield* new InvalidActionLeaseCapabilityError({
          actionID,
          reason: "The action lease capability belongs to a different durable action.",
        })
      const snapshot = yield* load(actionID)
      const lease = snapshot.lease
      if (
        lease?.id !== binding.leaseID ||
        lease.ownerID !== binding.ownerID ||
        lease.generation !== binding.generation ||
        DateTime.toEpochMillis(lease.heartbeatAt) !== binding.heartbeatAtMs ||
        DateTime.toEpochMillis(lease.expiresAt) !== binding.expiresAtMs
      )
        return yield* new InvalidActionLeaseCapabilityError({
          actionID,
          reason: "The action lease capability is superseded, released, or no longer current.",
        })
      return { snapshot, binding }
    })

    const validateActionLeaseCapability = Effect.fnUntraced(function* (
      capability: ActionLeaseCapability,
      actionID: AgentRuntime.ActionID,
    ) {
      const current = yield* resolveActionLeaseCapability(capability, actionID)
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
      if (isTerminal(current.snapshot.action.status) || !leaseActive(current.snapshot.lease, nowMs))
        return yield* new InvalidActionLeaseCapabilityError({
          actionID,
          reason: "The action lease capability is expired or the action is terminal.",
        })
      return current
    })

    const listPage: Interface["listPage"] = Effect.fn("DurableAction.listPage")(function* (input) {
      const cursor = input?.cursor
      if (cursor !== undefined && !cursor.startsWith("evt_")) return yield* new InvalidListCursorError({ cursor })
      const rows = yield* db
        .select({ id: EventTable.id, data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ActionProposed.type, 1)),
            cursor === undefined ? undefined : lt(EventTable.id, EventV2.ID.make(cursor)),
          ),
        )
        .orderBy(desc(EventTable.id))
        .all()
        .pipe(Effect.orDie)
      const result: Snapshot[] = []
      const seen = new Set<AgentRuntime.ActionID>()
      let lastExaminedID: string | undefined
      const limit = input?.limit ?? 100
      for (const row of rows) {
        lastExaminedID = row.id
        const proposed = Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(row.data)
        if (seen.has(proposed.actionID)) continue
        seen.add(proposed.actionID)
        if (input?.sessionID !== undefined && proposed.sessionID !== input.sessionID) continue
        if (input?.runID !== undefined && proposed.action.runID !== input.runID) continue
        result.push(
          yield* load(proposed.actionID).pipe(
            Effect.catchTag(
              "DurableAction.NotFoundError",
              () =>
                new CorruptHistoryError({
                  actionID: proposed.actionID,
                  sequence: -1,
                  reason: "The action proposal is indexed but its aggregate cannot be reconstructed.",
                }),
            ),
          ),
        )
        if (result.length >= limit) break
      }
      return {
        items: result,
        nextCursor: lastExaminedID !== undefined && lastExaminedID !== rows.at(-1)?.id ? lastExaminedID : undefined,
      }
    })

    const list: Interface["list"] = (input) =>
      listPage(input).pipe(
        Effect.catchTag("DurableAction.InvalidListCursorError", (error) => Effect.die(error)),
        Effect.map((page) => page.items),
      )

    const recordReconciliation: Interface["recordReconciliation"] = Effect.fn("DurableAction.recordReconciliation")(
      function* (input) {
        for (let contention = 0; contention < 6; contention++) {
          const current = yield* load(input.actionID)
          if (current.action.intentDigest === undefined || current.action.intentDigest !== input.intentDigest)
            return yield* new ReconciliationMismatchError({
              actionID: input.actionID,
              reason: "The reconciliation intent digest does not match the immutable durable action intent.",
            })
          if (current.action.idempotencyKey !== input.idempotencyKey)
            return yield* new ReconciliationMismatchError({
              actionID: input.actionID,
              reason: "The reconciliation idempotency key does not match the immutable durable action identity.",
            })

          const record = AgentRuntime.ActionReconciliation.make({
            actionID: input.actionID,
            intentDigest: input.intentDigest,
            idempotencyKey: input.idempotencyKey,
            state: input.state,
            evidenceDigest: input.evidenceDigest,
            source: input.source,
            observedAt: input.observedAt,
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            automaticRetryAllowed: false,
          })
          const invalid = invalidReconciliation(record)
          if (invalid)
            return yield* new ReconciliationMismatchError({
              actionID: input.actionID,
              reason: invalid,
            })

          const previous = current.reconciliation
          if (previous?.evidenceDigest === record.evidenceDigest) {
            if (
              previous.state !== record.state ||
              previous.source !== record.source ||
              previous.intentDigest !== record.intentDigest ||
              previous.idempotencyKey !== record.idempotencyKey
            )
              return yield* new ReconciliationMismatchError({
                actionID: input.actionID,
                reason: "The reconciliation evidence digest was reused with different immutable identity fields.",
              })
            return current
          }

          const data =
            "sessionID" in current.action
              ? {
                  actionID: input.actionID,
                  sessionID: current.action.sessionID,
                  ...(current.action.subject === undefined ? {} : { subject: current.action.subject }),
                  reconciliation: record,
                }
              : {
                  actionID: input.actionID,
                  subject: current.action.subject,
                  reconciliation: record,
                }
          const published = yield* events
            .publish(AgentRuntime.Event.ActionReconciled, data, { expectedSequence: current.lastSequence })
            .pipe(Effect.exit)
          if (published._tag === "Success") return yield* load(input.actionID)
          if (!sequenceConflict(published.cause)) return yield* Effect.failCause(published.cause)
        }
        return yield* Effect.die(new Error(`Action reconciliation contention did not converge for ${input.actionID}`))
      },
    )

    const bindExternalOperation: Interface["bindExternalOperation"] = Effect.fn("DurableAction.bindExternalOperation")(
      function* (input) {
        for (let contention = 0; contention < 6; contention++) {
          const current = yield* load(input.actionID)
          const binding = yield* Effect.try({
            try: () => AgentRuntime.ActionExternalOperationBinding.make(input.binding),
            catch: () =>
              new ExternalOperationBindingMismatchError({
                actionID: input.actionID,
                reason: "The external operation binding failed strict schema validation.",
              }),
          })
          if (current.action.intentDigest === undefined)
            return yield* new ExternalOperationBindingMismatchError({
              actionID: input.actionID,
              reason: "An external operation binding cannot be attached to an action without an intent digest.",
            })
          if (!current.action.resources.includes("mcp:child-action"))
            return yield* new ExternalOperationBindingMismatchError({
              actionID: input.actionID,
              reason: "An external operation binding requires an MCP child action marker.",
            })
          if (!current.action.resources.includes(`mcp-server:${binding.server}`))
            return yield* new ExternalOperationBindingMismatchError({
              actionID: input.actionID,
              reason: "The external operation server does not match the durable MCP action scope.",
            })
          const taskMarkers = current.action.resources
            .filter((resource) => resource.startsWith("mcp-task:"))
            .map((resource) => resource.slice("mcp-task:".length))
          if (taskMarkers.length > 0 && (taskMarkers.length !== 1 || taskMarkers[0] !== binding.taskID))
            return yield* new ExternalOperationBindingMismatchError({
              actionID: input.actionID,
              reason: "The external operation task reference does not match the durable MCP action scope.",
            })
          if (current.externalOperation !== undefined) {
            if (sameExternalOperationBinding(current.externalOperation, binding)) return current
            return yield* new ExternalOperationBindingMismatchError({
              actionID: input.actionID,
              reason: "An action may contain only one immutable external operation binding.",
            })
          }
          if (current.action.status !== "executing" || current.activeAttempt === undefined)
            return yield* new ExternalOperationBindingMismatchError({
              actionID: input.actionID,
              reason: "An external operation binding must be recorded while the action is executing.",
            })
          const data =
            "sessionID" in current.action
              ? {
                  actionID: input.actionID,
                  sessionID: current.action.sessionID,
                  ...(current.action.subject === undefined ? {} : { subject: current.action.subject }),
                  binding,
                }
              : {
                  actionID: input.actionID,
                  subject: current.action.subject,
                  binding,
                }
          const published = yield* events
            .publish(AgentRuntime.Event.ActionExternalOperationBound, data, { expectedSequence: current.lastSequence })
            .pipe(Effect.exit)
          if (published._tag === "Success") return yield* load(input.actionID)
          if (!sequenceConflict(published.cause)) return yield* Effect.failCause(published.cause)
        }
        return yield* Effect.die(
          new Error(`External operation binding contention did not converge for ${input.actionID}`),
        )
      },
    )

    const recordMutationIntent: Interface["recordMutationIntent"] = Effect.fn("DurableAction.recordMutationIntent")(
      function* (input) {
        for (let contention = 0; contention < 6; contention++) {
          const current = yield* load(input.actionID)
          const invalid = MutationIntentRuntime.validate(
            input.intent,
            {
              actionID: input.actionID,
              intentDigest: current.action.intentDigest,
              idempotencyKey: current.action.idempotencyKey,
            },
            current.mutationIntent,
          )
          if (invalid)
            return yield* new MutationIntentMismatchError({
              actionID: input.actionID,
              reason: invalid,
            })
          if (current.mutationIntent !== undefined) {
            if (JSON.stringify(current.mutationIntent) === JSON.stringify(input.intent)) return current
            if (
              current.mutationIntent.phase === input.intent.phase &&
              !MutationIntentRuntime.canAppendPostProcessing(current.mutationIntent, input.intent)
            )
              return yield* new MutationIntentMismatchError({
                actionID: input.actionID,
                reason:
                  "A mutation intent phase can only be recorded once unless the record is byte-identical or appends one validated post-processing checkpoint.",
              })
          }
          const data =
            "sessionID" in current.action
              ? {
                  actionID: input.actionID,
                  sessionID: current.action.sessionID,
                  ...(current.action.subject === undefined ? {} : { subject: current.action.subject }),
                  intent: input.intent,
                }
              : {
                  actionID: input.actionID,
                  subject: current.action.subject,
                  intent: input.intent,
                }
          const published = yield* events
            .publish(AgentRuntime.Event.ActionMutationIntentRecorded, data, { expectedSequence: current.lastSequence })
            .pipe(Effect.exit)
          if (published._tag === "Success") return yield* load(input.actionID)
          if (!sequenceConflict(published.cause)) return yield* Effect.failCause(published.cause)
        }
        return yield* Effect.die(new Error(`Mutation intent contention did not converge for ${input.actionID}`))
      },
    )

    const recordProgress: Interface["recordProgress"] = Effect.fn("DurableAction.recordProgress")(function* (input) {
      for (let contention = 0; contention < 6; contention++) {
        const current = yield* load(input.actionID)
        if (isTerminal(current.action.status))
          return yield* new ProgressMismatchError({
            actionID: input.actionID,
            reason: "Progress cannot be appended after the durable action is terminal.",
          })
        const update = yield* Effect.try({
          try: () => AgentRuntime.ActionProgressUpdate.make(input.update),
          catch: () =>
            new ProgressMismatchError({
              actionID: input.actionID,
              reason: "The action progress update failed strict schema validation.",
            }),
        })
        if (update.completed > update.total)
          return yield* new ProgressMismatchError({
            actionID: input.actionID,
            reason: "Action progress completed count cannot exceed its total.",
          })
        const previous = current.progress
        if (
          previous &&
          previous.phase === update.phase &&
          previous.completed === update.completed &&
          previous.total === update.total &&
          previous.detail === update.detail
        )
          return current
        const previousTime = previous === undefined ? Date.now() : DateTime.toEpochMillis(previous.updatedAt)
        const updatedAt = DateTime.makeUnsafe(Math.max(Date.now(), previousTime + 1))
        const next = AgentRuntime.ActionProgress.make({
          ...update,
          sequence: (previous?.sequence ?? -1) + 1,
          updatedAt,
        })
        const data =
          "sessionID" in current.action
            ? {
                actionID: input.actionID,
                sessionID: current.action.sessionID,
                ...(current.action.subject === undefined ? {} : { subject: current.action.subject }),
                progress: next,
              }
            : {
                actionID: input.actionID,
                subject: current.action.subject,
                progress: next,
              }
        const published = yield* events
          .publish(AgentRuntime.Event.ActionProgressRecorded, data, { expectedSequence: current.lastSequence })
          .pipe(Effect.exit)
        if (published._tag === "Success") return yield* load(input.actionID)
        if (!sequenceConflict(published.cause)) return yield* Effect.failCause(published.cause)
      }
      return yield* Effect.die(new Error(`Action progress contention did not converge for ${input.actionID}`))
    })

    const assertLease: Interface["assertLease"] = Effect.fn("DurableAction.assertLease")(function* (capability, input) {
      return (yield* validateActionLeaseCapability(capability, input.actionID)).snapshot
    })

    const acquireLease: Interface["acquireLease"] = Effect.fn("DurableAction.acquireLease")(function* (input) {
      if (!validTtl(input.ttlMs)) return yield* new InvalidLeaseDurationError({ ttlMs: input.ttlMs })
      for (let contention = 0; contention < 6; contention++) {
        const current = yield* load(input.actionID)
        if (isTerminal(current.action.status)) return { snapshot: current }
        const now = yield* DateTime.now
        const nowMs = DateTime.toEpochMillis(now)
        if (leaseActive(current.lease, nowMs)) {
          if (current.lease!.ownerID !== input.ownerID)
            return yield* new LeaseHeldError({
              actionID: input.actionID,
              ownerID: current.lease!.ownerID,
              expiresAtMs: DateTime.toEpochMillis(current.lease!.expiresAt),
            })
          const binding = actionLeaseBinding(current)
          if (!binding)
            return yield* new InvalidActionLeaseCapabilityError({
              actionID: input.actionID,
              reason: "The active durable action lease could not be bound to an opaque capability.",
            })
          return { snapshot: current, capability: mintActionLeaseCapability(binding) }
        }
        const lease = AgentRuntime.ActionLease.make({
          id: AgentRuntime.LeaseID.create(),
          actionID: input.actionID,
          ownerID: input.ownerID,
          generation: (current.lastLeaseGeneration ?? -1) + 1,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt: DateTime.makeUnsafe(nowMs + input.ttlMs),
        })
        const exit = yield* events
          .publish(
            AgentRuntime.Event.ActionLeaseAcquired,
            { actionID: input.actionID, lease },
            { expectedSequence: current.lastSequence },
          )
          .pipe(Effect.exit)
        if (exit._tag === "Success") {
          const snapshot = yield* load(input.actionID)
          const binding = actionLeaseBinding(snapshot)
          if (!binding)
            return yield* new InvalidActionLeaseCapabilityError({
              actionID: input.actionID,
              reason: "The acquired durable action lease could not be bound to an opaque capability.",
            })
          return { snapshot, capability: mintActionLeaseCapability(binding) }
        }
        if (!sequenceConflict(exit.cause)) return yield* Effect.failCause(exit.cause)
      }
      return yield* Effect.die(new Error(`Action lease contention did not converge for ${input.actionID}`))
    })

    const heartbeat: Interface["heartbeat"] = Effect.fn("DurableAction.heartbeat")(function* (input) {
      if (!validTtl(input.ttlMs)) return yield* new InvalidLeaseDurationError({ ttlMs: input.ttlMs })
      for (let contention = 0; contention < 6; contention++) {
        const current = yield* validateActionLeaseCapability(input.capability, input.actionID)
        const heartbeatAt = yield* DateTime.now
        const expiresAt = DateTime.makeUnsafe(DateTime.toEpochMillis(heartbeatAt) + input.ttlMs)
        const exit = yield* events
          .publish(
            AgentRuntime.Event.ActionHeartbeatRecorded,
            {
              actionID: input.actionID,
              leaseID: current.binding.leaseID,
              ownerID: current.binding.ownerID,
              generation: current.binding.generation,
              heartbeatAt,
              expiresAt,
            },
            { expectedSequence: current.snapshot.lastSequence },
          )
          .pipe(Effect.exit)
        if (exit._tag === "Success") {
          const snapshot = yield* load(input.actionID)
          const binding = actionLeaseBinding(snapshot)
          if (!binding)
            return yield* new InvalidActionLeaseCapabilityError({
              actionID: input.actionID,
              reason: "The renewed durable action lease could not be bound to an opaque capability.",
            })
          revokeActionLeaseCapability(input.capability)
          return { snapshot, capability: mintActionLeaseCapability(binding) }
        }
        if (!sequenceConflict(exit.cause)) return yield* Effect.failCause(exit.cause)
      }
      return yield* Effect.die(new Error(`Action lease heartbeat contention did not converge for ${input.actionID}`))
    })

    const releaseLeaseBody: Interface["releaseLease"] = Effect.fn("DurableAction.releaseLease")(
      function* (capability, input) {
        for (let contention = 0; contention < 6; contention++) {
          // A terminal transition deliberately invalidates heartbeat/assert, but
          // its finalizer must still record a matching lease release for an
          // honest replay/UI projection. Release checks the full identity and
          // CAS only; it never renews authority after terminal state.
          const current = yield* resolveActionLeaseCapability(capability, input.actionID)
          const releasedAt = yield* DateTime.now
          const exit = yield* events
            .publish(
              AgentRuntime.Event.ActionLeaseReleased,
              {
                actionID: input.actionID,
                leaseID: current.binding.leaseID,
                ownerID: current.binding.ownerID,
                generation: current.binding.generation,
                releasedAt,
                reason: input.reason,
              },
              { expectedSequence: current.snapshot.lastSequence },
            )
            .pipe(Effect.exit)
          if (exit._tag === "Success") {
            revokeActionLeaseCapability(capability)
            return yield* load(input.actionID)
          }
          if (!sequenceConflict(exit.cause)) return yield* Effect.failCause(exit.cause)
        }
        return yield* Effect.die(new Error(`Action lease release contention did not converge for ${input.actionID}`))
      },
    )
    const releaseLease: Interface["releaseLease"] = (capability, input) =>
      releaseLeaseBody(capability, input).pipe(
        Effect.ensuring(Effect.sync(() => revokeActionLeaseCapability(capability))),
      )

    return Service.of({
      load,
      listPage,
      list,
      recordReconciliation,
      bindExternalOperation,
      recordMutationIntent,
      recordProgress,
      acquireLease,
      heartbeat,
      assertLease,
      releaseLease,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
export const globalNode = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
