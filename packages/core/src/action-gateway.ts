export * as ActionGateway from "./action-gateway"

import { createHash, randomUUID } from "node:crypto"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { AgentV2 } from "./agent"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { RuntimeInsight } from "./runtime/insight"
import { DurableAction } from "./runtime/durable-action"
import { DurableRun } from "./runtime/durable-run"
import { canTransition } from "./runtime/action-state"
import { Authorizer } from "./authorizer"
import { PermissionV2 } from "./permission"
import { SecretProvider } from "./secret-provider"
import { ToolOutputStore } from "./tool-output-store"
import { SessionMessage } from "./session/message"
import { SessionSchema } from "./session/schema"
import { canonicalEffectSemantics } from "./tool/effect-semantics"
import { mutationRecoveryMessage, project as projectToolExecution, recoveryMessage } from "./tool/execution-state"
import type { ProjectionMode, ToolExecutionProjection } from "./tool/execution-state"
import type { ReconciliationDecision, ReconciliationRequest } from "./runtime/reconciliation"
import * as MutationIntentRuntime from "./runtime/mutation-intent"
import { parseActionRequestEnvelope, requestEnvelopeJson, type RequestEnvelope } from "./session/request-envelope"
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"

export const POLICY_VERSION = "arforge-risk/1"
export const MAX_DURABLE_OUTPUT_BYTES = AgentRuntime.ActionOutputMaxBytes
export const L2_GRANT_TTL_MS = 5 * 60_000
export const L3_GRANT_TTL_MS = 60_000
export const ACTION_LEASE_TTL_MS = 30_000
export const MAX_AUTHORIZATION_METADATA_BYTES = 16 * 1024
const POSTPROCESSING_RESOURCE = AgentRuntime.ActionPostProcessingResource
const MAX_AUTHORIZATION_METADATA_DEPTH = 16
const configuredActionLeaseTtlMs = Number(process.env.ARFORGE_ACTION_LEASE_TTL_MS)
const actionLeaseTtlMs =
  process.env.ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE === "1" &&
  Number.isFinite(configuredActionLeaseTtlMs) &&
  configuredActionLeaseTtlMs >= 1_000
    ? configuredActionLeaseTtlMs
    : ACTION_LEASE_TTL_MS

/**
 * Deterministic crash-boundary pause used only by the isolated packaged
 * acceptance harness. Production processes never enter this branch because
 * the desktop acceptance marker is required in addition to the boundary name.
 */
const testCrashBoundaryPause = (boundary: "authorized-before-spawn" | "effect-before-observation") =>
  process.env.ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE === "1" && process.env.ARFORGE_TEST_CRASH_BOUNDARY === boundary
    ? Effect.sleep("60 seconds")
    : Effect.void

const sequenceConflict = (cause: Cause.Cause<unknown>) =>
  cause.reasons
    .filter(Cause.isDieReason)
    .some((reason) => reason.defect instanceof EventV2.AggregateSequenceConflictError)

const reconciliationDigest = /^[a-f0-9]{64}$/
const reconciliationIdentifier = /^[a-z][a-z0-9._:-]{0,63}$/
const reconciliationVersion = /^[a-z0-9][a-z0-9._:-]{0,63}$/
const reconciliationActionID = /^act_[A-Za-z0-9._:-]{1,160}$/
const reconciliationText = (value: unknown, maximumBytes: number) =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximumBytes && !/[\u0000-\u001f\u007f]/.test(value)

const invalidReconciliationRequest = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return "The reconciliation request is not an object."
  const request = value as Record<string, unknown>
  if (typeof request.actionID !== "string" || !reconciliationActionID.test(request.actionID))
    return "The reconciliation action identity is invalid."
  if (typeof request.actionKind !== "string" || !reconciliationIdentifier.test(request.actionKind))
    return "The reconciliation action kind is invalid."
  if (typeof request.actionVersion !== "string" || !reconciliationVersion.test(request.actionVersion))
    return "The reconciliation action version is invalid."
  if (typeof request.intentDigest !== "string" || !reconciliationDigest.test(request.intentDigest))
    return "The reconciliation intent digest is invalid."
  if (!reconciliationText(request.idempotencyKey, 160) || (request.idempotencyKey as string).length === 0)
    return "The reconciliation idempotency key is invalid."
  return undefined
}

const invalidReconciliationDecision = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return "The reconciliation decision is not an object."
  const decision = value as Record<string, unknown>
  if (decision.kind !== "confirmed" && decision.kind !== "manual_review")
    return "The reconciliation decision kind is invalid."
  if (decision.state !== "known_success" && decision.state !== "known_failure" && decision.state !== "unknown")
    return "The reconciliation decision state is invalid."
  if (decision.automaticRetryAllowed !== false) return "Reconciliation evidence cannot authorize automatic retry."
  if (!reconciliationText(decision.reason, 2_000) || (decision.reason as string).length === 0)
    return "The reconciliation reason is invalid."
  if (decision.adapterFailure !== undefined && typeof decision.adapterFailure !== "boolean")
    return "The reconciliation adapter-failure marker is invalid."
  if (decision.evidence === null || typeof decision.evidence !== "object")
    return "The reconciliation evidence is missing."
  const evidence = decision.evidence as Record<string, unknown>
  if (evidence.state !== decision.state) return "The reconciliation decision and evidence states differ."
  if (typeof evidence.evidenceDigest !== "string" || !reconciliationDigest.test(evidence.evidenceDigest))
    return "The reconciliation evidence digest is invalid."
  if (typeof evidence.source !== "string" || !reconciliationIdentifier.test(evidence.source))
    return "The reconciliation evidence source is invalid."
  if (!Number.isSafeInteger(evidence.observedAt) || (evidence.observedAt as number) < 0)
    return "The reconciliation evidence timestamp is invalid."
  if (evidence.summary !== undefined && !reconciliationText(evidence.summary, 512))
    return "The reconciliation evidence summary is invalid."
  return undefined
}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("ActionGateway.BlockedError", {
  actionID: AgentRuntime.ActionID,
  reason: Schema.String,
}) {}

export class AlreadySettledError extends Schema.TaggedErrorClass<AlreadySettledError>()(
  "ActionGateway.AlreadySettledError",
  {
    actionID: AgentRuntime.ActionID,
    summary: Schema.String,
  },
) {}

export class RecoveryRequiredError extends Schema.TaggedErrorClass<RecoveryRequiredError>()(
  "ActionGateway.RecoveryRequiredError",
  {
    actionID: AgentRuntime.ActionID,
    reason: Schema.String,
  },
) {}

/** The effect succeeded durably; a subsequent notification did not complete. */
export class PostProcessingError extends Schema.TaggedErrorClass<PostProcessingError>()(
  "ActionGateway.PostProcessingError",
  {
    actionID: AgentRuntime.ActionID,
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason
  }
}

/** A different live worker holds the durable action lease; callers may attach to its result. */
export class ActionInProgressError extends Schema.TaggedErrorClass<ActionInProgressError>()(
  "ActionGateway.ActionInProgressError",
  {
    actionID: AgentRuntime.ActionID,
    ownerID: Schema.String,
    expiresAtMs: Schema.Number,
  },
) {}

/**
 * Raised before any PermissionV2 request, attempt, hook, or tool body when a
 * presented actionID already belongs to a durable action with a different
 * canonical intent. The previous result is never replayed for changed intent.
 */
export class ActionIntentMismatchError extends Schema.TaggedErrorClass<ActionIntentMismatchError>()(
  "ActionGateway.ActionIntentMismatchError",
  {
    actionID: AgentRuntime.ActionID,
    reason: Schema.String,
  },
) {}

/**
 * Raised when a presented authorization subject is contradictory or
 * incomplete: a control-plane subject mixed with session identity fields, a
 * session action missing its session identity, a control-plane action with a
 * forged actionID, or control-plane options not opened in this release. The
 * action fails closed before any permission request, attempt, or side effect.
 */
export class InvalidSubjectError extends Schema.TaggedErrorClass<InvalidSubjectError>()(
  "ActionGateway.InvalidSubjectError",
  {
    reason: Schema.String,
  },
) {}

/**
 * A reconciliation response is evidence for a human/operator review, not a
 * permission to execute. Invalid or forged evidence is rejected before it can
 * enter the durable Action aggregate or the audit projection.
 */
export class InvalidReconciliationError extends Schema.TaggedErrorClass<InvalidReconciliationError>()(
  "ActionGateway.InvalidReconciliationError",
  {
    actionID: AgentRuntime.ActionID,
    reason: Schema.String,
  },
) {}

/**
 * Gateway input. The authorization subject is an explicit discriminated
 * variant: session actions carry the original session identity fields;
 * control-plane actions carry only the control-plane subject. The type
 * forbids mixing the two, so no runtime undefined-combination validation is
 * needed. Session callers may omit `kind` (legacy session variant).
 */
export type Input = {
  readonly actionID: AgentRuntime.ActionID
  readonly parentActionID?: AgentRuntime.ActionID
  readonly runID?: AgentRuntime.RunID
  readonly stepID?: AgentRuntime.StepID
  readonly name: string
  readonly resources: ReadonlyArray<string>
  readonly semantics: AgentRuntime.EffectSemantics
  readonly reasonSummary: string
  readonly initiator?: AgentRuntime.Initiator
  readonly traceID?: string
  /**
   * Canonical hash of the complete decoded tool input. The gateway binds it
   * into the durable intent fingerprint so a replayed actionID with changed
   * input fails closed before any permission, attempt, or side effect.
   */
  readonly inputDigest: string
} & (
  | {
      readonly kind?: "session"
      readonly sessionID: SessionSchema.ID
      readonly agent: AgentV2.ID
      readonly assistantMessageID: SessionMessage.ID
      readonly toolCallID: string
      readonly runLease?: never
    }
  | {
      readonly kind: "control-plane"
      readonly controlPlane: AgentRuntime.ControlPlaneSubject
      /**
       * Opaque proof that the coordinator currently owns this ControlRun.
       * Omitted only by the legacy control path that has no `runID`.
       */
      readonly runLease?: DurableRun.RunLeaseCapability
      /**
       * Internal, read-only replay permission for a completed ControlRun.
       * This flag is not part of the action intent: it only permits the
       * coordinator to present the already-settled durable result again after
       * it has reacquired the run lease. A missing action/result still fails
       * closed and can never start a second operation.
       */
      readonly allowSettledReplay?: boolean
      /**
       * Internal recovery permission for a safely retryable control action
       * whose ControlRun was interrupted in running/verifying/recovering.
       * The coordinator must first close any prior control attempt and prove
       * the same opaque lease; this flag never changes intent identity.
       */
      readonly allowControlRecovery?: boolean
    }
)

export type AuthorizationRequest = {
  readonly action: string
  readonly resources: ReadonlyArray<string>
}

/**
 * A canonical, order-insensitive set of permission requests. The gateway
 * asserts every request atomically before any side effect starts, and binds
 * the complete canonical set into the durable grant so recovery can prove the
 * scope did not grow, shrink, or change.
 */
export type AuthorizationPlan = {
  readonly requests: ReadonlyArray<AuthorizationRequest>
  readonly metadata?: Readonly<Record<string, unknown>>
}

const GrantCapability: unique symbol = Symbol("@arforge/v2/ActionGateway/grant-capability")
const GrantCapabilityValidation: unique symbol = Symbol("@arforge/v2/ActionGateway/grant-capability-validation")

/**
 * Unforgeable capability handed to an operation body only after the gateway
 * verified or freshly sealed the durable authorization grant. The runtime
 * token and a module-private WeakSet identity make forgery impossible
 * outside this module: constructors are never exported, every accessor
 * verifies WeakSet membership and fails closed, and the capability and its
 * request arrays are frozen. Automatic (L0/L1) actions receive an
 * `automatic` capability without a grant.
 */
export type AuthorizationGrantCapability =
  | {
      readonly [GrantCapability]: typeof GrantCapability
      readonly authority: "automatic"
      readonly grant: undefined
    }
  | {
      readonly [GrantCapability]: typeof GrantCapability
      readonly authority: "granted"
      readonly grant: AgentRuntime.AuthorizationGrant
    }

const frozenRequests = (requests: ReadonlyArray<AuthorizationRequest>): ReadonlyArray<AuthorizationRequest> =>
  Object.freeze(
    requests.map((request) => Object.freeze({ ...request, resources: Object.freeze([...request.resources]) })),
  )

const isIssuedCapability = (value: unknown): value is AuthorizationGrantCapability =>
  typeof value === "object" &&
  value !== null &&
  GrantCapabilityValidation in value &&
  typeof (value as { readonly [GrantCapabilityValidation]?: unknown })[GrantCapabilityValidation] === "function" &&
  (
    value as {
      readonly [GrantCapabilityValidation]: (presented: object) => boolean
    }
  )[GrantCapabilityValidation](value)

export function capabilityAuthority(capability: AuthorizationGrantCapability): AgentRuntime.Authority {
  if (!isIssuedCapability(capability)) throw new Error("Invalid authorization grant capability")
  return capability.authority === "granted" ? capability.grant.authority : "automatic"
}

export function capabilityGrant(capability: AuthorizationGrantCapability): AgentRuntime.AuthorizationGrant | undefined {
  if (!isIssuedCapability(capability)) throw new Error("Invalid authorization grant capability")
  return capability.grant
}

export function capabilityRequests(capability: AuthorizationGrantCapability): ReadonlyArray<AuthorizationRequest> {
  if (!isIssuedCapability(capability)) throw new Error("Invalid authorization grant capability")
  return capability.grant?.requests ?? []
}

/**
 * Narrow capability exposed to an operation while its durable Action attempt
 * is executing.  The operation may bind a server-issued external operation
 * (for example an MCP taskCreated reference), but it cannot mutate Action
 * identity, status, lease or retry policy through this seam.
 */
export type OperationExecutionContext = {
  readonly actionID: AgentRuntime.ActionID
  /** Persist an immutable model request while holding this operation's current lease. */
  readonly recordModelRequest: (envelope: RequestEnvelope) => Effect.Effect<void, unknown>
  readonly bindExternalOperation: (binding: AgentRuntime.ActionExternalOperationBinding) => Effect.Effect<void, unknown>
  /**
   * Append bounded, metadata-only operation progress to the same durable
   * Action aggregate.  The gateway assigns sequence/timestamp and keeps this
   * path observational: it cannot change action status or retry authority.
   */
  readonly reportProgress: (update: AgentRuntime.ActionProgressUpdate) => Effect.Effect<void, unknown>
}

export type Operation<A, E, R> = {
  /** Pure scope declaration. Identity, source, persistence, and fresh-confirmation rules are bound by the gateway. */
  readonly authorization?: AuthorizationPlan
  /**
   * The operation body receives the gateway-verified authorization
   * capability and may only run after preflight completed. Leaf permission
   * gates inside the body must be validated against the capability's grant,
   * never against a caller-side plan.
   */
  readonly execute: (
    capability: AuthorizationGrantCapability,
    context?: OperationExecutionContext,
  ) => Effect.Effect<A, E, R>
  /**
   * Classifies a post-dispatch failure whose external effect may have happened
   * even though no durable observation was returned. The gateway records the
   * attempt, leaves the Action without a fabricated Observation, and blocks it
   * through the existing `outcome_unknown` recovery projection. Returning true
   * is fail-closed: it never authorizes an automatic retry.
   */
  readonly outcomeUnknownOnFailure?: (error: unknown) => boolean
  /**
   * Optional postprocessor after the successful Observation and settlement
   * commit. Receives a detached structured clone, not a mutable result owner
   * or an execution capability. Failure/cancellation cannot rewrite the
   * effect's outcome. Neither execution nor this callback runs on replay.
   * Default notification delivery is at-most-once: a crash may omit it.
   * Projection mode records its start and validated result in the same Action;
   * incomplete projection blocks replay rather than fabricating a final result.
   * Additional side effects still require their own authorized domain operation.
   */
  readonly afterSuccess?: (value: NoInfer<A>) => Effect.Effect<NoInfer<A> | void, unknown, R>
  /** Projection mode durably records the returned value separately from the raw Observation. */
  readonly afterSuccessMode?: "notification" | "projection"
  readonly successSummary?: (value: A) => string
  readonly estimatedCostMicros?: number
  /** Called after operation cleanup on every outcome; undefined requires reconciliation. */
  readonly costMicros?: (result: Exit.Exit<A, E | RecoveryRequiredError>) => number | undefined
  /** Upper-bound admission estimate, checked against the existing durable Action budget. */
  readonly estimatedTokens?: number
  /** Measured usage on success, failure or interruption; never infer zero from failure. */
  readonly tokens?: (result: Exit.Exit<A, E | RecoveryRequiredError>) => number | undefined
  /**
   * Opt-in codec for replaying an already-settled tool result after process
   * recovery. The gateway JSON-normalizes and size-limits the encoded value
   * before it is appended to the durable action stream.
   */
  readonly durableResult?: {
    readonly encode: (value: A) => unknown
    readonly decode: (value: unknown) => A
  }
}

export interface Interface {
  readonly execute: <A, E, R>(
    input: Input,
    operation: Operation<A, E, R>,
  ) => Effect.Effect<
    A,
    | E
    | BlockedError
    | AlreadySettledError
    | PostProcessingError
    | RecoveryRequiredError
    | ActionInProgressError
    | ActionIntentMismatchError
    | InvalidSubjectError
    | DurableAction.CorruptHistoryError,
    R
  >
  /**
   * Binds read-only external-state evidence to the original durable action.
   * It never invokes the operation, changes Action.status, grants a lease, or
   * infers retry permission from a known-success/known-failure result.
   */
  readonly reconcile: (
    request: ReconciliationRequest,
    decision: ReconciliationDecision,
  ) => Effect.Effect<
    ReconciliationDecision,
    | InvalidReconciliationError
    | ActionIntentMismatchError
    | BlockedError
    | DurableAction.NotFoundError
    | DurableAction.CorruptHistoryError
    | DurableAction.ReconciliationMismatchError
  >
  /**
   * Read-only semantic recovery projection for operator/API surfaces. It
   * loads the existing Action aggregate and never acquires a lease, executes
   * a tool, changes Action status, or authorizes retry.
   */
  readonly inspectRecovery?: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly mode?: ProjectionMode
  }) => Effect.Effect<ToolExecutionProjection, DurableAction.NotFoundError | DurableAction.CorruptHistoryError>
  /**
   * Records the content-free mutation phase for the currently executing
   * durable action. Binding fields are read from the action itself so mature
   * tools cannot manufacture a second intent identity; this method only
   * appends metadata to the existing Action/EventV2 aggregate.
   */
  readonly recordMutationIntent?: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly transactionID: AgentRuntime.MutationTransactionID
    readonly phase: AgentRuntime.MutationIntentPhase
    readonly entries: ReadonlyArray<AgentRuntime.MutationIntentEntry>
    readonly manifestDigest: string
    readonly createdAt: DateTime.Utc
    readonly updatedAt: DateTime.Utc
    /** Append-only semantic side-effect checkpoints for postprocessing. */
    readonly postProcessing?: ReadonlyArray<AgentRuntime.MutationPostProcessingCheckpoint>
    readonly summary?: string
  }) => Effect.Effect<
    DurableAction.Snapshot,
    DurableAction.NotFoundError | DurableAction.CorruptHistoryError | DurableAction.MutationIntentMismatchError
  >
  /**
   * Records an evidence-bound human mutation review. The fresh inspection
   * decision is supplied by the workspace observer; this seam only validates
   * the exact transaction/phase and appends the next durable phase. It never
   * writes files, changes Action.status, or grants retry authority.
   */
  readonly reviewMutationIntent?: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly transactionID: AgentRuntime.MutationTransactionID
    readonly expectedPhase: AgentRuntime.MutationIntentPhase
    readonly decision: MutationIntentRuntime.MutationReviewDecision
    readonly inspectedDecision: MutationIntentRuntime.MutationInspectionDecision
    /** SHA-256 digest of the exact fresh fingerprint observation used by the reviewer. */
    readonly observationDigest: string
    readonly reviewedAt: DateTime.Utc
  }) => Effect.Effect<
    DurableAction.Snapshot,
    DurableAction.NotFoundError | DurableAction.CorruptHistoryError | DurableAction.MutationIntentMismatchError
  >
  /** Read-only ancestry check; this does not mint an execution capability or authorize new child effects. */
  readonly validateDelegationParent: (input: {
    readonly actionID: AgentRuntime.ActionID
    readonly runID: AgentRuntime.RunID
    readonly subject: AgentRuntime.SessionSubject
    readonly toolName: string
  }) => Effect.Effect<void, RecoveryRequiredError | DurableAction.NotFoundError | DurableAction.CorruptHistoryError>
  /**
   * Atomically cancels a control-plane action before its execution handoff.
   * Once `authorized → executing` has committed, the side effect may already
   * have started, so this method returns ActionInProgressError instead of
   * falsely recording a successful cancellation. The owning adapter must
   * interrupt or compensate the real operation and let its observation settle
   * honestly.
   */
  readonly settleSupersededAction: (
    input: Input,
    authorization: AuthorizationPlan,
    reason: string,
  ) => Effect.Effect<
    void,
    | InvalidSubjectError
    | ActionInProgressError
    | ActionIntentMismatchError
    | BlockedError
    | RecoveryRequiredError
    | DurableAction.NotFoundError
    | DurableAction.CorruptHistoryError
    | DurableAction.LeaseMismatchError
  >
  /**
   * Cancels a not-yet-executing durable action after re-binding the exact
   * original input and authorization scope. This is deliberately narrower
   * than general action cancellation: once the execution handoff has
   * occurred, adapters must interrupt/compensate the real effect and let the
   * gateway record its observation instead of claiming it was cancelled.
   */
  readonly cancelPendingAction: (
    input: Input,
    authorization: AuthorizationPlan,
    reason: string,
  ) => Effect.Effect<
    void,
    | InvalidSubjectError
    | ActionInProgressError
    | ActionIntentMismatchError
    | BlockedError
    | RecoveryRequiredError
    | DurableAction.NotFoundError
    | DurableAction.CorruptHistoryError
    | DurableAction.LeaseMismatchError
  >
  /**
   * Records the uncertain `authorized` handoff of an explicitly cancelled
   * session action as blocked. It is intentionally narrower than ordinary
   * cancellation: it never writes `cancelled`, never touches executing work,
   * and requires the same full stable subject and immutable intent binding.
   */
  readonly blockAuthorizedHandoff: (
    input: Input,
    authorization: AuthorizationPlan,
    reason: string,
  ) => Effect.Effect<
    void,
    | InvalidSubjectError
    | ActionInProgressError
    | ActionIntentMismatchError
    | BlockedError
    | RecoveryRequiredError
    | DurableAction.NotFoundError
    | DurableAction.CorruptHistoryError
    | DurableAction.LeaseMismatchError
  >
  /**
   * Cancels every currently registered, pre-execution session action owned by
   * this gateway instance. The registry stores the exact canonical input and
   * authorization plan captured by `execute`; callers therefore cannot
   * cancel by presenting an action ID alone or by rebuilding a broader scope.
   * Actions which already crossed the `authorized → executing` handoff are
   * left for the live worker to observe and are never reported as safely
   * cancelled. This is an optional compatibility seam for older test and
   * embedding layers; the canonical runtime always provides it.
   */
  readonly cancelPendingSessionActions?: (sessionID: SessionSchema.ID, reason?: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ActionGateway") {}

export function authorityFor(riskTier: AgentRuntime.RiskTier): AgentRuntime.Authority {
  switch (riskTier) {
    case "L0":
    case "L1":
      return "automatic"
    case "L2":
      return "scoped_grant"
    case "L3":
      return "human"
    case "L4":
      return "forbidden"
  }
}

export function stableActionID(input: {
  readonly runID?: AgentRuntime.RunID
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly toolCallID: string
}) {
  // The durable identity always binds the full identity tuple: sessionID,
  // the optional runID, assistantMessageID, and toolCallID. The same tuple
  // recomputes stably; a difference in any single dimension must never
  // collide. In particular a run may legitimately reuse provider-local tool
  // call IDs across provider turns, so the assistant message must stay part
  // of the identity even when a runID is present. The no-runID branch is
  // preserved byte-for-byte so legacy recovery semantics stay stable.
  const identity = input.runID
    ? `${input.sessionID}\0${input.runID}\0${input.assistantMessageID}\0${input.toolCallID}`
    : `${input.sessionID}\0${input.assistantMessageID}\0${input.toolCallID}`
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32)
  return AgentRuntime.ActionID.make(`act_${digest}`)
}

/** Exact pre-v2 run-bound identity retained only for settled-result migration. */
export function legacyStableActionIDV1(input: {
  readonly runID?: AgentRuntime.RunID
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly toolCallID: string
}) {
  const identity = input.runID
    ? `${input.sessionID}\0${input.runID}\0${input.toolCallID}`
    : `${input.sessionID}\0${input.assistantMessageID}\0${input.toolCallID}`
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32)
  return AgentRuntime.ActionID.make(`act_${digest}`)
}

/**
 * Stable identity for a child durable action created for one real MCP call.
 * The same parent, server, tool, argument digest, and deterministic
 * invocation key always recover the same child action, so replaying the same
 * invocation reuses its settled result without repeating the side effect,
 * while two intentional identical calls (distinct invocation keys) each get
 * their own child action.
 */
export function stableChildActionID(input: {
  readonly parentActionID: AgentRuntime.ActionID
  readonly server: string
  readonly tool: string
  readonly argsDigest: string
  readonly invocation: string
}) {
  const identity = `${input.parentActionID}\0${input.server}\0${input.tool}\0${input.argsDigest}\0${input.invocation}`
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32)
  return AgentRuntime.ActionID.make(`act_${digest}`)
}

/**
 * Resolves the canonical authorization subject of an input. The type
 * discriminates the variant, but TypeScript unions are not a JS runtime
 * boundary: own-property conflict checks fail closed before any durable
 * record, permission request, attempt, or execution. A control-plane input
 * carrying any session identity field, or a session input carrying a
 * control-plane subject, is rejected; the session branch requires the
 * complete identity (sessionID, agent, assistantMessageID, toolCallID) with
 * no fallback values; an unknown discriminator value is rejected; and
 * control-plane steps and parent identity are rejected. A control-plane
 * `runID`, when provided, is verified against the immutable ControlRun before
 * permission, attempt, or execution can begin.
 */
const subjectOf = Effect.fnUntraced(function* (input: Input) {
  if (input.kind === "control-plane") {
    if ("sessionID" in input || "agent" in input || "assistantMessageID" in input || "toolCallID" in input)
      return yield* new InvalidSubjectError({
        reason: "A control-plane subject cannot be combined with session identity fields.",
      })
    if (input.controlPlane === undefined)
      return yield* new InvalidSubjectError({
        reason: "A control-plane input requires its control-plane subject.",
      })
    if (input.stepID !== undefined || input.parentActionID !== undefined)
      return yield* new InvalidSubjectError({
        reason: "Control-plane actions do not support step or parent identity.",
      })
    if ((input.runID === undefined) !== (input.runLease === undefined))
      return yield* new InvalidSubjectError({
        reason: "A durable control-plane run requires its opaque active lease capability.",
      })
    return input.controlPlane
  }
  if ("controlPlane" in input)
    return yield* new InvalidSubjectError({
      reason: "A session subject cannot be combined with a control-plane identity.",
    })
  if ("runLease" in input)
    return yield* new InvalidSubjectError({
      reason: "A session action cannot carry a control-run lease capability.",
    })
  if (input.kind !== undefined && input.kind !== "session")
    return yield* new InvalidSubjectError({
      reason: "Unknown authorization subject discriminator.",
    })
  if ("controlPlane" in input)
    return yield* new InvalidSubjectError({
      reason: "A session subject cannot be combined with a control-plane identity.",
    })
  if (
    input.sessionID === undefined ||
    input.agent === undefined ||
    input.assistantMessageID === undefined ||
    input.toolCallID === undefined
  )
    return yield* new InvalidSubjectError({
      reason:
        "A session action requires its complete session identity (sessionID, agent, assistantMessageID, toolCallID).",
    })
  return AgentRuntime.SessionSubject.make({
    type: "session",
    sessionID: input.sessionID,
    agent: input.agent.toString(),
    assistantMessageID: input.assistantMessageID,
    toolCallID: input.toolCallID,
  })
})

const canonicalControlSubject = (subject: AgentRuntime.ControlPlaneSubject) => ({
  type: subject.type,
  id: subject.id,
  location: subject.location,
  project: subject.project,
  actor: subject.actor,
  principalRef: subject.principalRef,
  requestID: subject.requestID,
})

/**
 * Stable durable identity for a control-plane action. Every dimension binds
 * into the identity: subject kind and ID, location/project, the per-request
 * identity, the action name, the complete canonical scope, the canonical
 * input digest, and the policy version. A change in any dimension derives a
 * different actionID, so a grant or settled action can never replay across
 * subjects, scopes, or intents.
 */
export function stableControlPlaneActionID(input: {
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly name: string
  readonly resources: ReadonlyArray<string>
  readonly inputDigest: string
  readonly policyVersion: string
}) {
  const identity = JSON.stringify({
    subject: canonicalControlSubject(input.subject),
    name: input.name,
    resources: canonicalResources(input.resources),
    inputDigest: input.inputDigest,
    policyVersion: input.policyVersion,
  })
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32)
  return AgentRuntime.ActionID.make(`act_${digest}`)
}

/**
 * Canonical intent fingerprint of one tool call: the canonical hash of the
 * complete decoded input, the tool name, the canonical request set, effect
 * semantics, invocation identity, and policy version. For a run-bound session
 * action, the provider-local assistant message envelope is deliberately not
 * part of the fingerprint: a crash recovery may ask the provider to replay the
 * same tool call in a new assistant message while the durable action identity
 * still distinguishes intentional repeated calls. The same actionID with a
 * different fingerprint fails closed on recovery; the same fingerprint may
 * resume or replay according to durable semantics. Control-plane intents bind
 * the full control subject.
 */
/** Exact pre-v2 fingerprint retained only for read-only settled-result compatibility. */
export const legacyIntentDigestV1Of = (input: Input, plan: AuthorizationPlan | undefined) => {
  const session = input.kind === "control-plane" ? undefined : input
  const payload = JSON.stringify({
    inputDigest: input.inputDigest,
    name: input.name,
    resources: canonicalResources(input.resources),
    requests: plan ? canonicalRequests(plan.requests) : [],
    semantics: {
      riskTier: input.semantics.riskTier,
      authority: input.semantics.authority,
      idempotency: input.semantics.idempotency,
      retryability: input.semantics.retryability,
      reversibility: input.semantics.reversibility,
      compensation: input.semantics.compensation ?? null,
      filesystemScope: canonicalResources(input.semantics.filesystemScope),
      networkScope: canonicalResources(input.semantics.networkScope),
      secretScope: canonicalResources(input.semantics.secretScope),
      externalServices: canonicalResources(input.semantics.externalServices),
      expectedArtifacts: canonicalResources(input.semantics.expectedArtifacts),
      successCriteria: canonicalResources(input.semantics.successCriteria),
    },
    sessionID: session?.sessionID,
    agent: session?.agent,
    assistantMessageID: input.runID ? null : session?.assistantMessageID,
    toolCallID: session?.toolCallID,
    runID: input.runID ?? null,
    ...(input.parentActionID ? { parentActionID: input.parentActionID } : {}),
    ...(input.kind === "control-plane" ? { controlPlane: canonicalControlSubject(input.controlPlane) } : {}),
    policyVersion: POLICY_VERSION,
  })
  return createHash("sha256").update(payload).digest("hex")
}

export const intentDigestOf = (input: Input, plan: AuthorizationPlan | undefined) => {
  const session = input.kind === "control-plane" ? undefined : input
  const payload = JSON.stringify({
    domain: "arforge.action-intent/v2",
    version: 2,
    inputDigest: input.inputDigest,
    name: input.name,
    resources: canonicalResources(input.resources),
    requests: plan ? canonicalRequests(plan.requests) : [],
    metadata: plan?.metadata ?? null,
    semantics: {
      riskTier: input.semantics.riskTier,
      authority: input.semantics.authority,
      idempotency: input.semantics.idempotency,
      retryability: input.semantics.retryability,
      reversibility: input.semantics.reversibility,
      compensation: input.semantics.compensation ?? null,
      filesystemScope: canonicalResources(input.semantics.filesystemScope),
      networkScope: canonicalResources(input.semantics.networkScope),
      secretScope: canonicalResources(input.semantics.secretScope),
      externalServices: canonicalResources(input.semantics.externalServices),
      expectedArtifacts: canonicalResources(input.semantics.expectedArtifacts),
      successCriteria: canonicalResources(input.semantics.successCriteria),
    },
    sessionID: session?.sessionID,
    agent: session?.agent,
    assistantMessageID: input.runID ? null : session?.assistantMessageID,
    toolCallID: session?.toolCallID,
    runID: input.runID ?? null,
    ...(input.parentActionID ? { parentActionID: input.parentActionID } : {}),
    ...(input.stepID ? { stepID: input.stepID } : {}),
    ...(input.kind === "control-plane" ? { controlPlane: canonicalControlSubject(input.controlPlane) } : {}),
    policyVersion: POLICY_VERSION,
  })
  return createHash("sha256").update(payload).digest("hex")
}

/**
 * Model-visible failure summary without stack, path, or secret leakage.
 * Typed expected errors expose their bounded message; unexpected defects
 * (non-Error causes or mixed causes) surface a generic stable message plus an
 * internal audit correlation ID. Full diagnostics go to protected audit logs
 * only, keyed by the same correlation ID.
 */
const failedSummary = (cause: Cause.Cause<unknown>, correlationID: string) => {
  const failures = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
  if (failures.length > 0 && failures.every((failure) => failure instanceof Error)) {
    const first = failures[0]
    if (first instanceof Error && typeof first.message === "string" && first.message.length > 0)
      return first.message.slice(0, 2_000)
  }
  return `The action failed with an unexpected error (correlation: ${correlationID})`
}

const budgetFor = (semantics: AgentRuntime.EffectSemantics) =>
  AgentRuntime.Budget.make({
    maxAttempts: semantics.retryability === "safe" ? 3 : semantics.retryability === "guarded" ? 2 : 1,
    maxDurationMs: 5 * 60_000,
    maxCostMicros: 0,
    maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
    attemptsUsed: 0,
    durationMsUsed: 0,
    costMicrosUsed: 0,
    tokensUsed: 0,
  })

const nonNegativeBudget = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)

/**
 * Caps a child action's budget at the parent's allowance so a child can never
 * out-attempt, out-duration, or out-cost the parent action it belongs to. The
 * parent's used amounts are its own consumption, not a shared pool.
 */
const cappedBudget = (budget: AgentRuntime.Budget, parent: AgentRuntime.Budget | undefined): AgentRuntime.Budget =>
  parent
    ? AgentRuntime.Budget.make({
        ...budget,
        maxAttempts: Math.min(budget.maxAttempts, nonNegativeBudget(parent.maxAttempts)),
        maxDurationMs: Math.min(budget.maxDurationMs, nonNegativeBudget(parent.maxDurationMs)),
        maxCostMicros: Math.min(budget.maxCostMicros, nonNegativeBudget(parent.maxCostMicros)),
        maxTokens: Math.min(budget.maxTokens, nonNegativeBudget(parent.maxTokens)),
      })
    : budget

const encodeDurableOutput = <A>(
  codec: NonNullable<Operation<A, unknown, unknown>["durableResult"]>,
  value: A,
  owner: AgentRuntime.ArtifactOwner,
  store: ToolOutputStore.Interface,
) =>
  Effect.gen(function* () {
    const serialized = yield* Effect.try({
      try: () => {
        const text = JSON.stringify(codec.encode(value))
        if (text === undefined) throw new Error("The encoded tool result is not JSON serializable.")
        if (Buffer.byteLength(text, "utf8") > AgentRuntime.ManagedArtifactMaxBytes)
          throw new Error("The encoded tool result exceeds the managed artifact limit.")
        return text
      },
      catch: (cause) => cause,
    })
    const byteLength = Buffer.byteLength(serialized, "utf8")
    const digest = createHash("sha256").update(serialized).digest("hex")
    if (byteLength <= MAX_DURABLE_OUTPUT_BYTES)
      return AgentRuntime.ActionOutput.make({
        encoding: "json",
        value: JSON.parse(serialized) as unknown,
        digest,
        byteLength,
      })
    const reference = yield* store.bindBytes({
      bytes: Buffer.from(serialized, "utf8"),
      owner,
      kind: "action_output",
      mime: "application/json",
      // A confirmed Action must not outlive its only exact replay payload.
      // Action/history retirement remains the owner of eventual reclamation.
      retention: { mode: "durable" },
    })
    return AgentRuntime.ActionOutput.make({ encoding: "artifact", value: reference, digest, byteLength })
  })

const decodeDurableOutput = <A>(
  codec: NonNullable<Operation<A, unknown, unknown>["durableResult"]>,
  output: AgentRuntime.ActionOutput,
  owner: AgentRuntime.ArtifactOwner,
  store: ToolOutputStore.Interface,
) =>
  Effect.gen(function* () {
    if (output.encoding === "json")
      return yield* Effect.try({ try: () => codec.decode(output.value), catch: (cause) => cause })
    const retained = yield* store.read({
      reference: output.value,
      owner,
      maxBytes: AgentRuntime.ManagedArtifactMaxBytes,
    })
    return yield* Effect.try({
      try: () => codec.decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained.bytes))),
      catch: (cause) => cause,
    })
  })

const nonNegativeInteger = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0

const canonicalResources = (resources: ReadonlyArray<string>) => [...new Set(resources)].sort()

const sameCanonicalResources = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  JSON.stringify(canonicalResources(left)) === JSON.stringify(canonicalResources(right))

const sameControlSubject = (left: AgentRuntime.ControlPlaneSubject, right: AgentRuntime.ControlPlaneSubject) =>
  left.type === right.type &&
  left.id === right.id &&
  left.location === right.location &&
  left.project === right.project &&
  left.actor === right.actor &&
  left.principalRef === right.principalRef &&
  left.requestID === right.requestID

const sameSessionSubject = (left: AgentRuntime.SessionSubject, right: AgentRuntime.SessionSubject) =>
  left.type === right.type &&
  left.sessionID === right.sessionID &&
  left.agent === right.agent &&
  left.assistantMessageID === right.assistantMessageID &&
  left.toolCallID === right.toolCallID

const sameSubject = (left: AgentRuntime.Subject | undefined, right: AgentRuntime.Subject) =>
  left?.type === "control-plane" && right.type === "control-plane"
    ? sameControlSubject(left, right)
    : left?.type === "session" && right.type === "session"
      ? sameSessionSubject(left, right)
      : false

const sameEffectSemantics = (left: AgentRuntime.EffectSemantics, right: AgentRuntime.EffectSemantics) =>
  left.riskTier === right.riskTier &&
  left.authority === right.authority &&
  left.idempotency === right.idempotency &&
  left.retryability === right.retryability &&
  left.reversibility === right.reversibility &&
  (left.compensation ?? null) === (right.compensation ?? null) &&
  sameCanonicalResources(left.filesystemScope, right.filesystemScope) &&
  sameCanonicalResources(left.networkScope, right.networkScope) &&
  sameCanonicalResources(left.secretScope, right.secretScope) &&
  sameCanonicalResources(left.externalServices, right.externalServices) &&
  sameCanonicalResources(left.expectedArtifacts, right.expectedArtifacts) &&
  sameCanonicalResources(left.successCriteria, right.successCriteria)

const sameStoredActionFields = (action: AgentRuntime.Action, input: Input, semantics: AgentRuntime.EffectSemantics) =>
  action.name === input.name &&
  (action.runID ?? undefined) === (input.runID ?? undefined) &&
  (action.parentActionID ?? undefined) === (input.parentActionID ?? undefined) &&
  (action.stepID ?? undefined) === (input.stepID ?? undefined) &&
  action.authority === semantics.authority &&
  action.riskTier === semantics.riskTier &&
  sameCanonicalResources(action.resources, input.resources) &&
  sameEffectSemantics(action.semantics, semantics)

const sameStoredActionIntent = (
  action: AgentRuntime.Action,
  input: Input,
  subject: AgentRuntime.Subject,
  semantics: AgentRuntime.EffectSemantics,
  intentDigest: string,
) =>
  action.intentDigest === intentDigest &&
  (action.inputDigest === undefined || action.inputDigest === input.inputDigest) &&
  sameStoredActionFields(action, input, semantics) &&
  sameSubject(action.subject, subject)

const sameLegacySettledActionIntent = (
  action: AgentRuntime.Action,
  input: Input,
  subject: AgentRuntime.Subject,
  semantics: AgentRuntime.EffectSemantics,
  legacyIntentDigest: string,
) =>
  action.status === "settled" &&
  subject.type === "session" &&
  input.kind !== "control-plane" &&
  "sessionID" in action &&
  action.sessionID === subject.sessionID &&
  (input.runID === undefined
    ? action.subject === undefined || (action.subject.type === "session" && sameSessionSubject(action.subject, subject))
    : action.subject?.type === "session" && sameSessionSubject(action.subject, subject)) &&
  action.intentDigest === legacyIntentDigest &&
  legacyStableActionIDV1({
    ...(input.runID ? { runID: input.runID } : {}),
    sessionID: subject.sessionID,
    assistantMessageID: subject.assistantMessageID,
    toolCallID: subject.toolCallID,
  }) === input.actionID &&
  sameStoredActionFields(action, input, semantics)

// Upgrading a tool to durable postprocessing must not invalidate its previous
// final result. Remove only the new protocol marker when comparing historical
// identity; every original subject, scope, input and authorization still binds.
// This comparison also finds pending historical aliases, which are rejected
// below rather than accidentally creating a second action under a new message.
const samePrePostProcessingActionIntent = (
  snapshot: DurableAction.Snapshot,
  input: Input,
  subject: AgentRuntime.Subject,
  semantics: AgentRuntime.EffectSemantics,
  authorization: AuthorizationPlan | undefined,
) => {
  if (
    subject.type !== "session" ||
    input.kind === "control-plane" ||
    !input.resources.includes(POSTPROCESSING_RESOURCE) ||
    snapshot.action.resources.includes(POSTPROCESSING_RESOURCE) ||
    snapshot.postProcessing !== undefined
  )
    return false
  const original = { ...input, resources: input.resources.filter((resource) => resource !== POSTPROCESSING_RESOURCE) }
  return (
    sameStoredActionIntent(snapshot.action, original, subject, semantics, intentDigestOf(original, authorization)) ||
    sameLegacySettledActionIntent(
      snapshot.action,
      original,
      subject,
      semantics,
      legacyIntentDigestV1Of(original, authorization),
    )
  )
}

const currentPolicyDecisionError = (snapshot: DurableAction.Snapshot) => {
  const { action, policyDecision } = snapshot
  if (action.status === "proposed" && policyDecision === undefined) return undefined
  if (!policyDecision || !action.subject) return "The durable action has no complete policy decision."
  const expectedDecision =
    action.authority === "forbidden" ? "deny" : action.authority === "automatic" ? "allow" : "ask"
  if (
    policyDecision.actionID !== action.id ||
    !policyDecision.subject ||
    !sameSubject(action.subject, policyDecision.subject) ||
    policyDecision.authority !== action.authority ||
    policyDecision.riskTier !== action.riskTier ||
    policyDecision.decision !== expectedDecision ||
    policyDecision.policyVersion !== POLICY_VERSION
  )
    return "The durable policy decision does not match the action identity or current policy version."
  return undefined
}

const executableControlRun = (
  status: AgentRuntime.RunStatus,
  allowSettledReplay = false,
  allowControlRecovery = false,
) =>
  status === "awaiting_authorization" ||
  status === "queued" ||
  status === "recovering" ||
  (allowSettledReplay && status === "completed") ||
  (allowControlRecovery && (status === "running" || status === "verifying"))

const canonicalRequest = (request: AuthorizationRequest) => ({
  action: request.action,
  resources: canonicalResources(request.resources),
})

/**
 * Normalizes a plan into a deduplicated, sorted request set. Reordering the
 * input requests never changes the result, so a grant digest stays stable
 * across request reordering; deleting, adding, or mutating a request always
 * changes the canonical set and therefore fails recovery.
 */
export const canonicalRequests = (requests: ReadonlyArray<AuthorizationRequest>) => {
  const unique = new Map<string, ReturnType<typeof canonicalRequest>>()
  for (const request of requests) {
    const canonical = canonicalRequest(request)
    const key = JSON.stringify(canonical)
    if (!unique.has(key)) unique.set(key, canonical)
  }
  return [...unique.values()].sort(
    (a, b) => a.action.localeCompare(b.action) || a.resources.join("\u0000").localeCompare(b.resources.join("\u0000")),
  )
}

const canonicalMetadata = (metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const visiting = new WeakSet<object>()
  const normalize = (value: unknown, depth: number): unknown => {
    if (depth > MAX_AUTHORIZATION_METADATA_DEPTH)
      throw new Error(`Authorization metadata exceeds depth ${MAX_AUTHORIZATION_METADATA_DEPTH}.`)
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Authorization metadata numbers must be finite.")
      return Object.is(value, -0) ? 0 : value
    }
    if (typeof value !== "object")
      throw new Error("Authorization metadata must contain only JSON values without undefined or executable data.")
    if (visiting.has(value)) throw new Error("Authorization metadata cannot contain cycles.")
    visiting.add(value)
    try {
      if (Array.isArray(value)) return Object.freeze(value.map((item) => normalize(item, depth + 1)))
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("Authorization metadata objects must be plain JSON records.")
      if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
        throw new Error("Authorization metadata cannot contain symbol keys.")
      const record = value as Record<string, unknown>
      const normalized: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (!descriptor || !("value" in descriptor))
          throw new Error("Authorization metadata cannot contain accessor properties.")
        normalized[key] = normalize(descriptor.value, depth + 1)
      }
      return Object.freeze(normalized)
    } finally {
      visiting.delete(value)
    }
  }
  const normalized = normalize(metadata, 0) as Readonly<Record<string, unknown>>
  const serialized = JSON.stringify(normalized)
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUTHORIZATION_METADATA_BYTES)
    throw new Error(`Authorization metadata exceeds ${MAX_AUTHORIZATION_METADATA_BYTES} bytes.`)
  return normalized
}

export const canonicalPlan = (plan: AuthorizationPlan): AuthorizationPlan => {
  const requests = Object.freeze(
    canonicalRequests(plan.requests).map((request) =>
      Object.freeze({ action: request.action, resources: Object.freeze([...request.resources]) }),
    ),
  )
  return Object.freeze({
    requests,
    ...(plan.metadata ? { metadata: canonicalMetadata(plan.metadata) } : {}),
  })
}

const invalidAuthorizationPlan = (plan: AuthorizationPlan | undefined) => {
  if (!plan || plan.requests.length === 0) return "The action declared no enforceable authorization request."
  for (const request of plan.requests) {
    if (request.action.length === 0) return "The action declared an authorization request without a permission action."
    if (request.resources.length === 0 || request.resources.some((resource) => resource.length === 0))
      return `The ${request.action} authorization request declared no enforceable resource scope.`
  }
  return undefined
}

/** True when every child request is covered by a parent request of the same action. */
export function requestsContained(
  child: ReadonlyArray<AuthorizationRequest>,
  parent: ReadonlyArray<AuthorizationRequest>,
) {
  return child.every((request) =>
    parent.some(
      (granted) =>
        granted.action === request.action &&
        request.resources.every((resource) => granted.resources.includes("*") || granted.resources.includes(resource)),
    ),
  )
}

const grantBinding = (
  input: Input,
  plan: AuthorizationPlan,
  authority: AgentRuntime.Authority,
  riskTier: AgentRuntime.RiskTier,
  parentGrantID?: AgentRuntime.AuthorizationGrantID,
) => {
  const session = input.kind === "control-plane" ? undefined : input
  return {
    domain: "arforge.authorization-grant/v2",
    actionID: input.actionID,
    runID: input.runID ?? null,
    sessionID: session?.sessionID,
    agent: session?.agent,
    assistantMessageID: session?.assistantMessageID,
    toolCallID: session?.toolCallID,
    toolName: input.name,
    requests: canonicalRequests(plan.requests),
    metadata: plan.metadata ?? null,
    intentDigest: intentDigestOf(input, plan),
    authority,
    riskTier,
    policyVersion: POLICY_VERSION,
    ...(input.kind === "control-plane" ? { subject: canonicalControlSubject(input.controlPlane) } : {}),
    ...(input.parentActionID ? { parentActionID: input.parentActionID } : {}),
    ...(input.stepID ? { stepID: input.stepID } : {}),
    ...(parentGrantID ? { parentGrantID } : {}),
  }
}

const bindingDigest = (binding: ReturnType<typeof grantBinding>) =>
  createHash("sha256").update(JSON.stringify(binding)).digest("hex")

const grantProofPayload = (
  binding: ReturnType<typeof grantBinding>,
  digest: string,
  issuedAt: DateTime.Utc,
  expiresAt: DateTime.Utc,
) =>
  JSON.stringify({
    ...binding,
    bindingDigest: digest,
    issuedAt: DateTime.toEpochMillis(issuedAt),
    expiresAt: DateTime.toEpochMillis(expiresAt),
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const durableActions = yield* DurableAction.Service
    const durableRuns = yield* DurableRun.Service
    const authorizer = yield* Authorizer.Service
    const secrets = yield* SecretProvider.Service
    const outputStore = yield* ToolOutputStore.Service
    const issuedCapabilities = new WeakMap<object, { active: boolean }>()
    /**
     * Exact pre-execution bindings for active session actions. This is an
     * adapter-facing index only: durable Action/EventV2 remains the authority
     * for state and the cancellation methods below re-check every identity
     * and intent dimension before writing a transition. Keeping the index in
     * the same ActionGateway closure prevents SessionExecution, ToolRegistry,
     * and UI adapters from growing independent cancellation owners.
     */
    type PendingSessionAction = {
      readonly input: Input
      readonly authorization: AuthorizationPlan
      /** Resolves once the durable proposal exists or execution has finalized. */
      readonly ready: Deferred.Deferred<void, never>
    }
    const pendingSessionActions = new Map<string, Map<string, PendingSessionAction>>()

    const registerPendingSessionAction = (input: Input, authorization: AuthorizationPlan | undefined) => {
      if (input.kind === "control-plane" || authorization === undefined) return undefined
      const sessionID = String(input.sessionID)
      const entry = {
        input,
        authorization,
        ready: Deferred.makeUnsafe<void>(),
      } satisfies PendingSessionAction
      const actions = pendingSessionActions.get(sessionID) ?? new Map<string, PendingSessionAction>()
      actions.set(String(input.actionID), entry)
      pendingSessionActions.set(sessionID, actions)
      return entry
    }

    const markPendingSessionActionReady = (entry: PendingSessionAction | undefined) => {
      if (entry) Deferred.doneUnsafe(entry.ready, Effect.void)
    }

    const unregisterPendingSessionAction = (entry: PendingSessionAction | undefined) => {
      if (!entry || entry.input.kind === "control-plane") return
      const sessionID = String(entry.input.sessionID)
      const actions = pendingSessionActions.get(sessionID)
      if (!actions || actions.get(String(entry.input.actionID)) !== entry) return
      actions.delete(String(entry.input.actionID))
      if (actions.size === 0) pendingSessionActions.delete(sessionID)
    }

    const mintCapability = (
      authority: "automatic" | "granted",
      grant: AgentRuntime.AuthorizationGrant | undefined,
    ): AuthorizationGrantCapability => {
      let capability: AuthorizationGrantCapability
      const validator = (presented: object) =>
        presented === capability && issuedCapabilities.get(presented)?.active === true
      capability = Object.freeze({
        [GrantCapability]: GrantCapability,
        [GrantCapabilityValidation]: validator,
        authority,
        ...(grant
          ? { grant: Object.freeze({ ...grant, requests: frozenRequests(grant.requests) }) }
          : { grant: undefined }),
      }) as AuthorizationGrantCapability
      issuedCapabilities.set(capability, { active: true })
      return capability
    }
    const revokeCapability = (capability: AuthorizationGrantCapability) => {
      const issued = issuedCapabilities.get(capability)
      if (issued) issued.active = false
      issuedCapabilities.delete(capability)
    }

    /**
     * Re-check the immutable child delegation at the last effect boundary.
     * Legacy/root session runs keep their existing contract; a loaded child
     * run must prove session identity, executable state, deadline, and every
     * action/resource request before the durable action is even proposed.
     */
    const assertSessionChildRun = Effect.fnUntraced(function* (
      input: Input,
      session: AgentRuntime.SessionSubject | undefined,
      authorization: AuthorizationPlan | undefined,
      semantics: AgentRuntime.EffectSemantics,
    ) {
      if (input.runID === undefined || session === undefined || input.kind === "control-plane") return
      const loaded = yield* durableRuns
        .load(input.runID)
        .pipe(Effect.catchTag("DurableRun.NotFoundError", () => Effect.succeed(undefined)))
      if (!loaded || !("sessionID" in loaded.run)) return
      if (loaded.run.sessionID !== session.sessionID)
        return yield* new BlockedError({
          actionID: input.actionID,
          reason: "The session action does not belong to the durable run session.",
        })
      if (!loaded.run.child) return
      if (!["queued", "running", "recovering"].includes(loaded.run.status))
        return yield* new BlockedError({
          actionID: input.actionID,
          reason: `The child run is not executable in state ${loaded.run.status}.`,
        })
      if (
        loaded.run.child.deadlineAt &&
        DateTime.toEpochMillis(yield* DateTime.now) >= DateTime.toEpochMillis(loaded.run.child.deadlineAt)
      )
        return yield* new BlockedError({
          actionID: input.actionID,
          reason: "The child run deadline has expired.",
        })
      const requests = authorization?.requests ?? [{ action: input.name, resources: input.resources }]
      for (const request of requests) {
        const grant = loaded.run.child.allowedCapabilities.find(
          (candidate) =>
            (candidate.action === "*" || candidate.action === request.action) &&
            request.resources.every((resource) =>
              candidate.resources.some((allowed) => allowed === "*" || allowed === resource),
            ),
        )
        if (!grant || (grant.access === "read" && !["L0", "L1"].includes(semantics.riskTier)))
          return yield* new BlockedError({
            actionID: input.actionID,
            reason: `The child capability does not authorize ${request.action} for the requested resources.`,
          })
      }
    })

    const assertControlRunBinding = Effect.fnUntraced(function* (
      input: Input & {
        readonly kind: "control-plane"
        readonly runID: AgentRuntime.RunID
        readonly runLease: DurableRun.RunLeaseCapability
      },
      authorization: AuthorizationPlan | undefined,
      semantics: AgentRuntime.EffectSemantics,
    ) {
      const loaded = yield* durableRuns.validateControlLease(input.runLease).pipe(
        Effect.mapError(
          () =>
            new InvalidSubjectError({
              reason: "The control-plane run lease is missing, expired, superseded, or its history cannot be trusted.",
            }),
        ),
      )
      if (loaded.run.id !== input.runID)
        return yield* new InvalidSubjectError({
          reason: "The control-plane lease capability belongs to a different durable run.",
        })
      const run = loaded.run
      if (!executableControlRun(run.status, input.allowSettledReplay === true, input.allowControlRecovery === true))
        return yield* new BlockedError({
          actionID: input.actionID,
          reason: `The coordinator has not placed the control-plane run in an executable state (${run.status}).`,
        })
      if (!sameControlSubject(run.subject, input.controlPlane))
        return yield* new InvalidSubjectError({
          reason: "The control-plane subject does not match the durable run subject.",
        })
      if (run.operation.actionID !== input.actionID)
        return yield* new InvalidSubjectError({
          reason: "The control-plane action ID does not match the frozen durable run operation.",
        })
      if (run.operation.policyVersion !== POLICY_VERSION)
        return yield* new BlockedError({
          actionID: input.actionID,
          reason: "The control-plane run was preflighted under a different policy revision and must be re-preflighted.",
        })
      if (run.operation.inputDigest !== input.inputDigest)
        return yield* new InvalidSubjectError({
          reason: "The control-plane input digest does not match the frozen durable run operation.",
        })
      if (!sameCanonicalResources(run.operation.resources, input.resources))
        return yield* new InvalidSubjectError({
          reason: "The control-plane resource scope does not match the frozen durable run operation.",
        })
      if (!sameEffectSemantics(run.operation.semantics, semantics))
        return yield* new InvalidSubjectError({
          reason: "The control-plane effect semantics do not match the frozen durable run operation.",
        })
      if (run.operation.authorizationDigest !== intentDigestOf(input, authorization))
        return yield* new InvalidSubjectError({
          reason: "The control-plane authorization intent does not match the frozen durable run operation.",
        })
    })

    const revalidateControlRun = Effect.fnUntraced(function* (
      input: Input,
      authorization: AuthorizationPlan | undefined,
      semantics: AgentRuntime.EffectSemantics,
    ) {
      if (input.kind !== "control-plane" || input.runID === undefined) return
      const runLease = input.runLease
      if (runLease === undefined)
        return yield* new InvalidSubjectError({
          reason: "A durable control-plane run requires its opaque active lease capability.",
        })
      yield* assertControlRunBinding(
        {
          ...input,
          runID: input.runID,
          runLease,
        },
        authorization,
        semantics,
      )
    })

    const issueGrant = Effect.fnUntraced(function* (
      input: Input,
      plan: AuthorizationPlan,
      authority: AgentRuntime.Authority,
      riskTier: AgentRuntime.RiskTier,
      subject: AgentRuntime.Subject,
      parentGrantID?: AgentRuntime.AuthorizationGrantID,
    ) {
      yield* revalidateControlRun(input, plan, AgentRuntime.EffectSemantics.make({ ...input.semantics, authority }))
      const issuedAt = yield* DateTime.now
      const ttl = authority === "human" ? L3_GRANT_TTL_MS : L2_GRANT_TTL_MS
      const expiresAt = DateTime.makeUnsafe(DateTime.toEpochMillis(issuedAt) + ttl)
      const binding = grantBinding(input, plan, authority, riskTier, parentGrantID)
      const digest = bindingDigest(binding)
      const proof = yield* secrets.protect(Buffer.from(grantProofPayload(binding, digest, issuedAt, expiresAt), "utf8"))
      const common = {
        id: AgentRuntime.AuthorizationGrantID.create(),
        actionID: input.actionID,
        ...(input.parentActionID ? { parentActionID: input.parentActionID } : {}),
        ...(parentGrantID ? { parentGrantID } : {}),
        ...(input.runID ? { runID: input.runID } : {}),
        toolName: input.name,
        requests: binding.requests,
        authority,
        riskTier,
        policyVersion: POLICY_VERSION,
        bindingDigest: digest,
        proofProvider: secrets.id,
        proof,
        issuedAt,
        expiresAt,
      }
      return subject.type === "session"
        ? AgentRuntime.SessionGrant.make({
            ...common,
            sessionID: subject.sessionID,
            agent: subject.agent,
            assistantMessageID: subject.assistantMessageID,
            toolCallID: subject.toolCallID,
            subject,
          })
        : AgentRuntime.ControlGrant.make({ ...common, subject })
    })

    /**
     * Decrypts and cryptographically re-verifies a durable grant's protected
     * binding. Returns the exact binding that was sealed at issue time, or
     * undefined when the proof provider, digest, or timestamps do not match
     * the stored grant fields.
     */
    const parseProtectedBinding = Effect.fnUntraced(function* (grant: AgentRuntime.AuthorizationGrant) {
      if (grant.proofProvider !== secrets.id) return undefined
      const proof = yield* Effect.exit(secrets.unprotect(grant.proof))
      if (Exit.isFailure(proof)) return undefined
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.from(proof.value).toString("utf8"))
      } catch {
        return undefined
      }
      if (!parsed || typeof parsed !== "object") return undefined
      const record = parsed as Record<string, unknown>
      const { bindingDigest, issuedAt, expiresAt, ...binding } = record
      if (typeof bindingDigest !== "string" || typeof issuedAt !== "number" || typeof expiresAt !== "number")
        return undefined
      if (createHash("sha256").update(JSON.stringify(binding)).digest("hex") !== bindingDigest) return undefined
      if (bindingDigest !== grant.bindingDigest) return undefined
      if (issuedAt !== DateTime.toEpochMillis(grant.issuedAt) || expiresAt !== DateTime.toEpochMillis(grant.expiresAt))
        return undefined
      return {
        binding: binding as ReturnType<typeof grantBinding>,
        bindingDigest,
        issuedAt,
        expiresAt,
      }
    })

    const validateParentGrantContract = Effect.fnUntraced(function* (
      parent: DurableAction.Snapshot,
      now: DateTime.Utc,
    ) {
      const { action, authorization: grant } = parent
      if (
        !("sessionID" in action) ||
        action.subject?.type !== "session" ||
        !grant ||
        !("sessionID" in grant) ||
        grant.subject?.type !== "session"
      )
        return undefined
      const policyError = currentPolicyDecisionError(parent)
      if (policyError) return undefined
      const nowMs = DateTime.toEpochMillis(now)
      const executingWithOwnership =
        action.status === "executing" &&
        parent.activeAttempt !== undefined &&
        parent.lease !== undefined &&
        DateTime.toEpochMillis(parent.lease.expiresAt) > nowMs
      const settledSuccessfully = action.status === "settled" && parent.observation?.status === "succeeded"
      if (!executingWithOwnership && !settledSuccessfully) return undefined
      if (
        grant.actionID !== action.id ||
        grant.sessionID !== action.sessionID ||
        grant.agent !== action.subject.agent ||
        grant.assistantMessageID !== action.subject.assistantMessageID ||
        grant.toolCallID !== action.subject.toolCallID ||
        !sameSessionSubject(grant.subject, action.subject) ||
        grant.toolName !== action.name ||
        (grant.runID ?? null) !== (action.runID ?? null) ||
        (grant.parentActionID ?? null) !== (action.parentActionID ?? null) ||
        grant.authority !== action.authority ||
        grant.riskTier !== action.riskTier ||
        grant.policyVersion !== POLICY_VERSION ||
        DateTime.toEpochMillis(grant.issuedAt) > nowMs ||
        DateTime.toEpochMillis(grant.issuedAt) >= DateTime.toEpochMillis(grant.expiresAt) ||
        nowMs >= DateTime.toEpochMillis(grant.expiresAt)
      )
        return undefined
      const stored = yield* parseProtectedBinding(grant)
      if (!stored) return undefined
      const binding = stored.binding
      if (
        binding.domain !== "arforge.authorization-grant/v2" ||
        binding.actionID !== action.id ||
        binding.intentDigest !== action.intentDigest ||
        binding.sessionID !== action.subject.sessionID ||
        binding.agent !== action.subject.agent ||
        binding.assistantMessageID !== action.subject.assistantMessageID ||
        binding.toolCallID !== action.subject.toolCallID ||
        binding.toolName !== action.name ||
        binding.runID !== (action.runID ?? null) ||
        (binding.parentActionID ?? null) !== (action.parentActionID ?? null) ||
        (binding.stepID ?? null) !== (action.stepID ?? null) ||
        (binding.parentGrantID ?? null) !== (grant.parentGrantID ?? null) ||
        binding.authority !== action.authority ||
        binding.riskTier !== action.riskTier ||
        binding.policyVersion !== POLICY_VERSION ||
        JSON.stringify(grant.requests) !== JSON.stringify(binding.requests) ||
        JSON.stringify(binding.requests) !== JSON.stringify(canonicalRequests(binding.requests))
      )
        return undefined
      return { grant, requests: binding.requests }
    })

    const validateGrant = Effect.fnUntraced(function* (
      grant: AgentRuntime.AuthorizationGrant | undefined,
      input: Input,
      plan: AuthorizationPlan | undefined,
      authority: AgentRuntime.Authority,
      riskTier: AgentRuntime.RiskTier,
    ) {
      if (!grant) return "The action has no durable authorization grant."
      if (!plan) return "The resumed action did not declare its authorization scope."
      const expected = grantBinding(input, plan, authority, riskTier, grant.parentGrantID)
      if (JSON.stringify(grant.requests) !== JSON.stringify(expected.requests))
        return "The durable authorization grant does not match this action identity, scope, or policy."
      const stored = yield* parseProtectedBinding(grant)
      if (!stored) return "The durable authorization proof could not be verified."
      if (JSON.stringify(stored.binding) !== JSON.stringify(expected))
        return "The durable authorization grant does not match this action identity, scope, or policy."
      const sessionGrant = "sessionID" in grant && grant.subject?.type !== "control-plane" ? grant : undefined
      // The grant's subject contract must be consistent: a control-plane
      // grant never carries session identity fields, and a session grant's
      // subject must agree with its legacy session fields.
      if (grant.subject?.type === "session" && sessionGrant?.sessionID !== grant.subject.sessionID)
        return "The durable authorization grant subject contradicts its session identity."
      if (input.kind === "control-plane") {
        if (
          "sessionID" in grant ||
          grant.subject?.type !== "control-plane" ||
          !sameControlSubject(grant.subject, input.controlPlane)
        )
          return "The durable authorization grant does not match the complete control-plane subject."
      } else {
        const expectedSubject = AgentRuntime.SessionSubject.make({
          type: "session",
          sessionID: input.sessionID,
          agent: input.agent.toString(),
          assistantMessageID: input.assistantMessageID,
          toolCallID: input.toolCallID,
        })
        if (grant.subject?.type !== "session" || !sameSessionSubject(grant.subject, expectedSubject))
          return "The durable authorization grant does not match the complete session subject."
      }
      const storedMatches =
        grant.actionID === expected.actionID &&
        (grant.runID ?? null) === (expected.runID ?? null) &&
        (sessionGrant?.sessionID ?? null) === (expected.sessionID ?? null) &&
        (sessionGrant?.agent ?? null) === (expected.agent ?? null) &&
        (sessionGrant?.assistantMessageID ?? null) === (expected.assistantMessageID ?? null) &&
        (sessionGrant?.toolCallID ?? null) === (expected.toolCallID ?? null) &&
        grant.toolName === expected.toolName &&
        (grant.parentActionID ?? null) === (expected.parentActionID ?? null) &&
        grant.authority === expected.authority &&
        grant.riskTier === expected.riskTier &&
        grant.policyVersion === expected.policyVersion &&
        grant.bindingDigest === stored.bindingDigest
      if (!storedMatches)
        return "The durable authorization grant does not match this action identity, scope, or policy."
      const now = yield* DateTime.now
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(grant.expiresAt))
        return "The durable authorization grant has expired."
      if (grant.parentGrantID && !grant.parentActionID)
        return "The durable authorization grant references a parent grant without a parent action."
      if (grant.parentActionID) {
        const parent = yield* durableActions.load(grant.parentActionID).pipe(Effect.option)
        if (parent._tag === "None") return "The parent durable action could not be found."
        const parentContract = yield* validateParentGrantContract(parent.value, now)
        if (!parentContract) return "The parent durable authorization contract is no longer valid."
        if (grant.parentGrantID) {
          if (parentContract.grant.id !== grant.parentGrantID)
            return "The parent durable authorization grant no longer matches this child grant."
          if (!requestsContained(grant.requests, parentContract.requests))
            return "The child durable authorization scope exceeds its parent grant."
        }
      }
      return undefined
    })

    /**
     * Cryptographically validates the parent durable action and its grant
     * before a child may inherit the parent's approval. The protected proof
     * must still describe the parent action's identity, authority, risk tier,
     * policy version, and request set, and the grant must not have expired.
     * Returns undefined when any check fails so inheritance is never granted
     * on an invalid or missing parent grant.
     */
    const validateParentScope = Effect.fnUntraced(function* (parent: DurableAction.Snapshot, input: Input) {
      const subject = yield* subjectOf(input)
      if (parent.action.id !== input.parentActionID) return undefined
      if (subject.type === "control-plane" || parent.action.subject?.type !== "session") return undefined
      // Scope inheritance is limited to the same durable task/assistant. The
      // child has its own tool-call identity, but may not move a parent's grant
      // to another session, agent, assistant, or run.
      if (
        subject.sessionID !== parent.action.subject.sessionID ||
        subject.agent !== parent.action.subject.agent ||
        subject.assistantMessageID !== parent.action.subject.assistantMessageID ||
        (input.runID ?? null) !== (parent.action.runID ?? null)
      )
        return undefined
      const now = yield* DateTime.now
      return yield* validateParentGrantContract(parent, now)
    })

    type OwnershipAssertion = () => Effect.Effect<
      DurableAction.Snapshot,
      | RecoveryRequiredError
      | DurableAction.NotFoundError
      | DurableAction.CorruptHistoryError
      | DurableAction.LeaseMismatchError
    >

    const change = (
      input: Input,
      from: AgentRuntime.ActionStatus,
      to: AgentRuntime.ActionStatus,
      reason: string,
      assertOwnership?: OwnershipAssertion,
    ) =>
      Effect.gen(function* () {
        const presentedSubject = yield* subjectOf(input)
        for (let contention = 0; contention < 6; contention++) {
          const current = yield* assertOwnership ? assertOwnership() : durableActions.load(input.actionID)
          const subject = current.action.subject ?? presentedSubject
          const session = subject.type === "session" ? subject : undefined
          const actualFrom = current.action.status
          if (actualFrom === to) return
          if (["settled", "blocked", "cancelled"].includes(actualFrom))
            return yield* new BlockedError({
              actionID: input.actionID,
              reason: `The durable action is already terminal in state ${actualFrom}; it cannot transition to ${to}.`,
            })
          if (actualFrom !== from)
            return yield* new RecoveryRequiredError({
              actionID: input.actionID,
              reason: `Expected durable action state ${from}, found ${actualFrom}; refusing an out-of-order transition to ${to}.`,
            })
          if (!canTransition(actualFrom, to))
            return yield* new BlockedError({
              actionID: input.actionID,
              reason: `Illegal durable action transition from ${actualFrom} to ${to}.`,
            })
          const changedAt = yield* DateTime.now
          const committed = yield* events
            .publish(
              AgentRuntime.Event.ActionStateChanged,
              {
                actionID: input.actionID,
                ...(session ? { sessionID: session.sessionID } : {}),
                subject,
                from: actualFrom,
                to,
                reason,
                changedAt,
              },
              { expectedSequence: current.lastSequence },
            )
            .pipe(Effect.exit)
          if (committed._tag === "Success") return
          if (!sequenceConflict(committed.cause)) return yield* Effect.failCause(committed.cause)
        }
        return yield* Effect.die(new Error(`Action transition contention did not converge for ${input.actionID}`))
      })

    /**
     * Runs the complete L2/L3 authorization for one action: parent-scope
     * inheritance, the atomic PermissionV2/Authorizer preflight, the sealed
     * durable grant, the durable transitions, and the minted capability.
     * Shared by the fresh path and the awaiting_approval recovery re-ask so
     * both bind the same durable action and the same trusted authorization.
     */
    const authorizeAction = Effect.fnUntraced(function* (
      input: Input,
      plan: AuthorizationPlan,
      authority: AgentRuntime.Authority,
      riskTier: AgentRuntime.RiskTier,
      parent: DurableAction.Snapshot | undefined,
      session: AgentRuntime.SessionSubject | undefined,
      subject: AgentRuntime.Subject,
      intentDigest: string,
      assertOwnership: OwnershipAssertion,
    ) {
      // A child inherits the parent's approval only when its canonical
      // request set is fully contained in a cryptographically valid
      // parent grant. A missing, expired, forged, or policy-mismatched
      // parent grant fails closed before any permission request or
      // executor runs: a broken parent chain must never be laundered
      // into a fresh child authorization.
      const parentScope = parent ? yield* validateParentScope(parent, input) : undefined
      if (input.parentActionID && !parentScope) {
        const reason =
          "The parent durable authorization grant is missing, expired, or invalid; the child action cannot be trusted."
        RuntimeInsight.auditRecord({
          actor: input.initiator ?? "agent",
          action: "action.authorization.failed",
          resource: input.name,
          reason,
          metadata: {
            ...(session ? { sessionID: session.sessionID } : {}),
            actionID: input.actionID,
            parentActionID: input.parentActionID,
            ...(session ? { toolCallID: session.toolCallID } : {}),
          },
        })
        yield* change(input, "awaiting_approval", "blocked", reason, assertOwnership)
        return yield* new BlockedError({ actionID: input.actionID, reason })
      }
      const inherited =
        parentScope && requestsContained(plan.requests, parentScope.requests) ? parentScope.grant.id : undefined
      if (inherited) {
        RuntimeInsight.auditRecord({
          actor: input.initiator ?? "agent",
          action: "action.authorization.granted",
          resource: input.name,
          reason: "Child action inherited the validated parent authorization grant.",
          metadata: {
            ...(session ? { sessionID: session.sessionID } : {}),
            actionID: input.actionID,
            parentActionID: input.parentActionID,
            parentGrantID: inherited,
            policyVersion: POLICY_VERSION,
          },
        })
      } else {
        // A valid parent whose scope does not contain the requested
        // child scope: the child runs its own complete atomic
        // preflight under the same shared permission evaluation as
        // every other action.
        const authorization = yield* Effect.exit(
          Effect.forEach(
            plan.requests,
            (request) =>
              authorizer.assert({
                subject,
                action: request.action,
                resources: [...request.resources],
                ...(authority === "scoped_grant" ? { save: [...request.resources] } : {}),
                ...(authority === "human" ? { forceAsk: true } : {}),
                ...(plan.metadata ? { metadata: { ...plan.metadata } } : {}),
                ...(subject.type === "control-plane"
                  ? { binding: { actionID: input.actionID, intentDigest, policyVersion: POLICY_VERSION } }
                  : {}),
                ...(session
                  ? {
                      source: {
                        type: "tool" as const,
                        messageID: session.assistantMessageID,
                        callID: session.toolCallID,
                      },
                    }
                  : {}),
              }),
            { discard: true },
          ),
        )
        if (Exit.isFailure(authorization)) {
          const interrupted = Cause.hasInterruptsOnly(authorization.cause)
          const reason = interrupted
            ? "The approval request was interrupted; the action remains awaiting approval and can be re-presented."
            : `Permission denied for ${plan.requests
                .map((request) => `${request.action}: ${request.resources.join(", ")}`)
                .join("; ")}`
          RuntimeInsight.auditRecord({
            actor: input.initiator ?? "agent",
            action: "action.authorization.failed",
            resource: input.name,
            reason,
            metadata: {
              ...(session ? { sessionID: session.sessionID } : {}),
              actionID: input.actionID,
              ...(session ? { toolCallID: session.toolCallID } : {}),
            },
          })
          // An interrupted ask must never poison a pending action: dropping
          // the ask (e.g. a runtime rebuild or a cancelled attempt) leaves it
          // awaiting_approval so it can be re-presented and re-asked under
          // the SAME durable identity. A real denial or permission error
          // blocks the action as before.
          if (interrupted) {
            return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
          }
          const current = yield* assertOwnership()
          if (current.action.status !== "blocked")
            yield* change(input, current.action.status, "blocked", reason, assertOwnership)
          // An explicit human refusal is a stop signal, not a recoverable
          // policy error. Persist the blocked action first, then preserve the
          // original cause so SessionRunner can stop its provider continuation.
          // A replay still sees the blocked action and cannot ask or execute again.
          if (
            authorization.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
            )
          )
            return yield* Effect.failCause(authorization.cause)
          return yield* new BlockedError({ actionID: input.actionID, reason })
        }
      }
      const issued = yield* Effect.exit(issueGrant(input, plan, authority, riskTier, subject, inherited))
      if (Exit.isFailure(issued)) {
        const reason = "Authorization succeeded, but its durable proof could not be protected and persisted."
        yield* change(input, "awaiting_approval", "blocked", reason, assertOwnership)
        return yield* new BlockedError({ actionID: input.actionID, reason })
      }
      // A human reply can arrive concurrently with cancellation/supersession.
      // Re-read immediately before appending the grant and CAS the exact
      // sequence, so an old approval fiber cannot authorize a terminal action.
      let granted = false
      for (let contention = 0; contention < 6; contention++) {
        const beforeGrant = yield* assertOwnership()
        yield* revalidateControlRun(input, plan, AgentRuntime.EffectSemantics.make({ ...input.semantics, authority }))
        if (beforeGrant.action.status !== "awaiting_approval") {
          const reason = "The action was cancelled or otherwise changed before the approval could be durably granted."
          return yield* new BlockedError({ actionID: input.actionID, reason })
        }
        const committed = yield* events
          .publish(
            AgentRuntime.Event.ActionAuthorizationGranted,
            {
              actionID: input.actionID,
              ...(session ? { sessionID: session.sessionID } : {}),
              subject,
              grant: issued.value,
            },
            { expectedSequence: beforeGrant.lastSequence },
          )
          .pipe(Effect.exit)
        if (committed._tag === "Success") {
          granted = true
          break
        }
        if (!sequenceConflict(committed.cause)) return yield* Effect.failCause(committed.cause)
      }
      if (!granted)
        return yield* new RecoveryRequiredError({
          actionID: input.actionID,
          reason: "Authorization grant CAS contention did not converge.",
        })
      RuntimeInsight.auditRecord({
        actor: input.initiator ?? "agent",
        action: "action.authorization.granted",
        resource: input.name,
        reason: "Trusted permission scope was durably bound to this action.",
        metadata: {
          ...(session ? { sessionID: session.sessionID } : {}),
          actionID: input.actionID,
          grantID: issued.value.id,
          bindingDigest: issued.value.bindingDigest,
          policyVersion: issued.value.policyVersion,
          expiresAt: DateTime.toEpochMillis(issued.value.expiresAt),
        },
      })
      yield* change(
        input,
        "awaiting_approval",
        "authorized",
        "Trusted permission service authorized scope",
        assertOwnership,
      )
      yield* testCrashBoundaryPause("authorized-before-spawn")
      yield* change(input, "authorized", "executing", "Authorized action started", assertOwnership)
      return mintCapability("granted", issued.value)
    })

    type AuthorizeActionArgs = Parameters<typeof authorizeAction>
    const authorizeActionObserved = (...args: AuthorizeActionArgs) => {
      const startedAt = Date.now()
      const input = args[0]
      return authorizeAction(...args).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            RuntimeInsight.recordMetric({
              name: "approval.wait",
              value: Math.max(0, Date.now() - startedAt),
              unit: "milliseconds",
              attributes: {
                actionID: input.actionID,
                ...(input.runID ? { runID: input.runID } : {}),
                ...(input.traceID ? { traceID: input.traceID } : {}),
                status: Exit.isSuccess(exit)
                  ? "granted"
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? "interrupted"
                    : "failed",
              },
            })
          }),
        ),
      )
    }

    const recordMutationIntent: Interface["recordMutationIntent"] = Effect.fn("ActionGateway.recordMutationIntent")(
      function* (input) {
        const current = yield* durableActions.load(input.actionID)
        const intent = AgentRuntime.MutationIntent.make({
          version: 1,
          transactionID: input.transactionID,
          actionID: input.actionID,
          intentDigest: current.action.intentDigest ?? "",
          idempotencyKey: current.action.idempotencyKey,
          phase: input.phase,
          entries: input.entries,
          manifestDigest: input.manifestDigest,
          automaticRetryAllowed: false,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
          ...(input.postProcessing === undefined ? {} : { postProcessing: input.postProcessing }),
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        })
        return yield* durableActions.recordMutationIntent({ actionID: input.actionID, intent })
      },
    )

    const reviewMutationIntent: Interface["reviewMutationIntent"] = Effect.fn("ActionGateway.reviewMutationIntent")(
      function* (input) {
        const current = yield* durableActions.load(input.actionID)
        const mutation = current.mutationIntent
        if (mutation === undefined)
          return yield* new DurableAction.MutationIntentMismatchError({
            actionID: input.actionID,
            reason: "The durable action has no mutation intent to review.",
          })
        const nextPhase = MutationIntentRuntime.reviewPhase(input.decision)
        const invalid = MutationIntentRuntime.validateReview(input, mutation)
        if (invalid)
          return yield* new DurableAction.MutationIntentMismatchError({
            actionID: input.actionID,
            reason: invalid,
          })
        const nextIntent = AgentRuntime.MutationIntent.make({
          ...mutation,
          phase: nextPhase,
          updatedAt: input.reviewedAt,
        })
        const reviewed = yield* durableActions.recordMutationIntent({
          actionID: input.actionID,
          intent: nextIntent,
        })
        RuntimeInsight.auditRecord({
          actor: "human",
          action: "action.mutation.reviewed",
          resource: "durable-mutation",
          reason: "A human mutation review advanced a digest-bound phase; no file operation or retry was executed.",
          metadata: {
            actionID: input.actionID,
            transactionID: input.transactionID,
            expectedPhase: input.expectedPhase,
            phase: nextPhase,
            decision: input.decision,
            inspectedDecision: input.inspectedDecision,
            observationDigest: input.observationDigest,
          },
        })
        return reviewed
      },
    )

    const reconcile: Interface["reconcile"] = Effect.fn("ActionGateway.reconcile")(function* (
      request: ReconciliationRequest,
      decision: ReconciliationDecision,
    ) {
      const rawRequest = request as unknown as Record<string, unknown>
      const rawActionID = rawRequest?.actionID
      const errorActionID =
        typeof rawActionID === "string" && reconciliationActionID.test(rawActionID)
          ? AgentRuntime.ActionID.make(rawActionID)
          : AgentRuntime.ActionID.make("act_reconciliation_invalid")
      const invalidRequest = invalidReconciliationRequest(request)
      if (invalidRequest)
        return yield* new InvalidReconciliationError({ actionID: errorActionID, reason: invalidRequest })
      const actionID = AgentRuntime.ActionID.make(request.actionID)
      const invalidDecision = invalidReconciliationDecision(decision)
      if (invalidDecision) return yield* new InvalidReconciliationError({ actionID, reason: invalidDecision })

      const current = yield* durableActions.load(actionID)
      if (current.action.intentDigest !== request.intentDigest)
        return yield* new ActionIntentMismatchError({
          actionID,
          reason: "Reconciliation requires the exact immutable intent digest recorded on the durable action.",
        })
      if (current.action.idempotencyKey !== request.idempotencyKey)
        return yield* new ActionIntentMismatchError({
          actionID,
          reason: "Reconciliation requires the exact immutable idempotency key recorded on the durable action.",
        })

      const evidence = decision.evidence
      yield* durableActions.recordReconciliation({
        actionID,
        intentDigest: request.intentDigest,
        idempotencyKey: request.idempotencyKey,
        state: decision.state,
        evidenceDigest: evidence.evidenceDigest,
        source: evidence.source,
        observedAt: DateTime.makeUnsafe(evidence.observedAt),
        ...(evidence.summary === undefined ? {} : { summary: evidence.summary }),
      })
      RuntimeInsight.auditRecord({
        actor: "recovery",
        action: "action.reconciliation.recorded",
        resource: current.action.name,
        reason:
          decision.kind === "confirmed"
            ? "Read-only external state was recorded; no retry or second side effect was executed."
            : "Read-only external state requires manual review; no retry or second side effect was executed.",
        metadata: {
          actionID: request.actionID,
          actionKind: request.actionKind,
          actionVersion: request.actionVersion,
          state: decision.state,
          decisionKind: decision.kind,
          source: evidence.source,
          evidenceDigest: evidence.evidenceDigest,
          automaticRetryAllowed: false,
          ...(decision.adapterFailure ? { adapterFailure: true } : {}),
        },
      })
      // This method intentionally returns the review decision only.  The
      // durable action status and operation execution are untouched; any
      // later retry must pass the normal gateway authorization/recovery path.
      return decision
    })

    const inspectRecovery: NonNullable<Interface["inspectRecovery"]> = Effect.fn("ActionGateway.inspectRecovery")(
      function* (input) {
        const snapshot = yield* durableActions.load(input.actionID)
        return projectToolExecution(snapshot, input.mode ?? "recovery")
      },
    )

    const settleSupersededAction = Effect.fn("ActionGateway.settleSupersededAction")(function* (
      input: Input,
      authorization: AuthorizationPlan,
      reason: string,
    ) {
      const subject = yield* subjectOf(input)
      if (subject.type !== "control-plane") {
        return yield* new InvalidSubjectError({
          reason: "Only control-plane actions can be settled as superseded.",
        })
      }
      const expected = stableControlPlaneActionID({
        subject,
        name: input.name,
        resources: input.resources,
        inputDigest: input.inputDigest,
        policyVersion: POLICY_VERSION,
      })
      if (expected !== input.actionID)
        return yield* new InvalidSubjectError({
          reason: "Supersession requires the complete control-plane action identity and intent binding.",
        })
      const snapshot = yield* durableActions.load(input.actionID).pipe(
        Effect.map((value) => value as DurableAction.Snapshot | undefined),
        Effect.catchTag("DurableAction.NotFoundError", () => Effect.succeed(undefined)),
      )
      if (!snapshot) return
      const presentedIntent = intentDigestOf(input, canonicalPlan(authorization))
      if (!snapshot.action.intentDigest || snapshot.action.intentDigest !== presentedIntent)
        return yield* new ActionIntentMismatchError({
          actionID: input.actionID,
          reason: "Supersession requires the action's complete stored subject, semantics, and authorization intent.",
        })
      const status = snapshot.action.status
      if (status === "settled" || status === "blocked" || status === "cancelled" || status === "observed") return
      // `authorized → executing` is the execution handoff linearization point.
      // Before it, cancellation may win the aggregate CAS and the old owner
      // fails its next lease assertion. After it, recording `cancelled` would
      // lie: the external side effect may already be in flight.
      if (status === "executing" || status === "verifying" || status === "compensating") {
        const lease = snapshot.lease
        return yield* new ActionInProgressError({
          actionID: input.actionID,
          ownerID: lease?.ownerID ?? "unknown",
          expiresAtMs: lease ? DateTime.toEpochMillis(lease.expiresAt) : 0,
        })
      }
      yield* change(input, status, "cancelled", reason)
    })

    const cancelPendingAction = Effect.fn("ActionGateway.cancelPendingAction")(function* (
      input: Input,
      authorization: AuthorizationPlan,
      reason: string,
    ) {
      // Cancellation is itself an authority-sensitive state change. Rebuild
      // the exact canonical intent before touching durable state so a caller
      // cannot cancel a different action merely by knowing its ID.
      const subject = yield* subjectOf(input)
      // This adapter is intentionally opened for direct session actions only.
      // Recompute the session's stable ID as an additional proof that a caller
      // did not retain a different action ID and pair it with a matching
      // looking plan.
      if (subject.type !== "session")
        return yield* new InvalidSubjectError({
          reason: "Pending-action cancellation is available only to a complete session action subject.",
        })
      const expectedActionID = stableActionID({
        ...(input.runID ? { runID: input.runID } : {}),
        sessionID: subject.sessionID,
        assistantMessageID: subject.assistantMessageID,
        toolCallID: subject.toolCallID,
      })
      if (expectedActionID !== input.actionID)
        return yield* new InvalidSubjectError({
          reason: "Pending-action cancellation requires the session action's stable durable identity.",
        })
      const plan = canonicalPlan(authorization)
      const current = yield* durableActions.load(input.actionID)
      const storedSubject = current.action.subject
      // Do not retrofit cancellation authority onto legacy/incomplete action
      // records. The stored subject must prove every session identity
      // dimension is identical to the caller that is attempting cancellation.
      if (
        storedSubject?.type !== "session" ||
        storedSubject.sessionID !== subject.sessionID ||
        storedSubject.agent !== subject.agent ||
        storedSubject.assistantMessageID !== subject.assistantMessageID ||
        storedSubject.toolCallID !== subject.toolCallID ||
        (current.action.runID ?? undefined) !== (input.runID ?? undefined)
      )
        return yield* new InvalidSubjectError({
          reason: "The stored durable action subject does not match the complete session cancellation subject.",
        })
      const expectedIntent = intentDigestOf(input, plan)
      if (!current.action.intentDigest || current.action.intentDigest !== expectedIntent)
        return yield* new ActionIntentMismatchError({
          actionID: input.actionID,
          reason: "Pending-action cancellation requires the original durable action identity, scope, and intent.",
        })

      const status = current.action.status
      if (status === "cancelled") return
      if (status === "settled" || status === "blocked")
        return yield* new BlockedError({
          actionID: input.actionID,
          reason: `The durable action is already terminal in state ${status}.`,
        })
      // `authorized → executing` is the side-effect handoff. Never append a
      // cancelled transition once that boundary was crossed: the executor may
      // have started and only its real observation can describe the outcome.
      if (["authorized", "executing", "verifying", "compensating", "observed"].includes(status))
        return yield* new ActionInProgressError({
          actionID: input.actionID,
          ownerID: current.lease?.ownerID ?? "unknown",
          expiresAtMs: current.lease ? DateTime.toEpochMillis(current.lease.expiresAt) : 0,
        })

      // A human reply can win after the first snapshot but before this CAS.
      // Normalize that precise race into ActionInProgress instead of leaking a
      // generic recovery error to a caller which would otherwise believe the
      // action was safely cancelled and hide its durable handoff state.
      const cancelled = yield* change(input, status, "cancelled", reason).pipe(Effect.exit)
      if (Exit.isSuccess(cancelled)) return
      const error = Cause.squash(cancelled.cause)
      if (!(error instanceof RecoveryRequiredError)) return yield* Effect.failCause(cancelled.cause)
      const latest = yield* durableActions.load(input.actionID)
      if (["authorized", "executing", "verifying", "compensating", "observed"].includes(latest.action.status))
        return yield* new ActionInProgressError({
          actionID: input.actionID,
          ownerID: latest.lease?.ownerID ?? "unknown",
          expiresAtMs: latest.lease ? DateTime.toEpochMillis(latest.lease.expiresAt) : 0,
        })
      if (latest.action.status === "cancelled") return
      if (latest.action.status === "settled" || latest.action.status === "blocked")
        return yield* new BlockedError({
          actionID: input.actionID,
          reason: `The durable action became terminal in state ${latest.action.status} while cancellation was requested.`,
        })
      return yield* Effect.failCause(cancelled.cause)
    })

    const blockAuthorizedHandoff = Effect.fn("ActionGateway.blockAuthorizedHandoff")(function* (
      input: Input,
      authorization: AuthorizationPlan,
      reason: string,
    ) {
      const subject = yield* subjectOf(input)
      if (subject.type !== "session")
        return yield* new InvalidSubjectError({
          reason: "Authorized-handoff blocking is available only to a complete session action subject.",
        })
      const expectedActionID = stableActionID({
        ...(input.runID ? { runID: input.runID } : {}),
        sessionID: subject.sessionID,
        assistantMessageID: subject.assistantMessageID,
        toolCallID: subject.toolCallID,
      })
      if (expectedActionID !== input.actionID)
        return yield* new InvalidSubjectError({
          reason: "Authorized-handoff blocking requires the session action's stable durable identity.",
        })
      const plan = canonicalPlan(authorization)
      const current = yield* durableActions.load(input.actionID)
      const storedSubject = current.action.subject
      if (
        storedSubject?.type !== "session" ||
        storedSubject.sessionID !== subject.sessionID ||
        storedSubject.agent !== subject.agent ||
        storedSubject.assistantMessageID !== subject.assistantMessageID ||
        storedSubject.toolCallID !== subject.toolCallID ||
        (current.action.runID ?? undefined) !== (input.runID ?? undefined)
      )
        return yield* new InvalidSubjectError({
          reason: "The stored durable action subject does not match the complete session handoff subject.",
        })
      const expectedIntent = intentDigestOf(input, plan)
      if (!current.action.intentDigest || current.action.intentDigest !== expectedIntent)
        return yield* new ActionIntentMismatchError({
          actionID: input.actionID,
          reason: "Authorized-handoff blocking requires the original durable action identity, scope, and intent.",
        })
      if (current.action.status === "blocked") return
      if (current.action.status === "settled" || current.action.status === "cancelled")
        return yield* new BlockedError({
          actionID: input.actionID,
          reason: `The durable action is already terminal in state ${current.action.status}.`,
        })
      if (current.action.status !== "authorized")
        return yield* new ActionInProgressError({
          actionID: input.actionID,
          ownerID: current.lease?.ownerID ?? "unknown",
          expiresAtMs: current.lease ? DateTime.toEpochMillis(current.lease.expiresAt) : 0,
        })
      const blocked = yield* change(input, "authorized", "blocked", reason).pipe(Effect.exit)
      if (Exit.isSuccess(blocked)) return
      const error = Cause.squash(blocked.cause)
      if (!(error instanceof RecoveryRequiredError)) return yield* Effect.failCause(blocked.cause)
      const latest = yield* durableActions.load(input.actionID)
      if (latest.action.status === "blocked") return
      return yield* new ActionInProgressError({
        actionID: input.actionID,
        ownerID: latest.lease?.ownerID ?? "unknown",
        expiresAtMs: latest.lease ? DateTime.toEpochMillis(latest.lease.expiresAt) : 0,
      })
    })

    const cancelPendingSessionActions: NonNullable<Interface["cancelPendingSessionActions"]> = Effect.fn(
      "ActionGateway.cancelPendingSessionActions",
    )(function* (sessionID, reason = "The originating session was interrupted before action execution.") {
      // Snapshot the handles before executing any effect. A successful
      // settlement can remove an entry while the cancellation loop is
      // running; the durable CAS below remains the final authority for that
      // race and a stale handle is treated as a no-op.
      const pending = [...(pendingSessionActions.get(String(sessionID))?.values() ?? [])]
      let cancelled = 0
      let handoff = 0
      for (const entry of pending) {
        // A session interrupt can arrive in the tiny interval between the
        // gateway registering a handle and publishing `ActionProposed`.
        // Wait for that proposal (or for execution finalization) so the
        // cancellation CAS cannot observe NotFound and then lose a late
        // proposal to the coordinator interrupt.
        yield* Deferred.await(entry.ready)
        const result = yield* cancelPendingAction(entry.input, entry.authorization, reason).pipe(
          Effect.as("cancelled" as const),
          Effect.catchTag("ActionGateway.ActionInProgressError", () =>
            blockAuthorizedHandoff(
              entry.input,
              entry.authorization,
              "The originating session was interrupted at the action execution handoff; recovery is blocked pending review.",
            ).pipe(
              Effect.as("handoff" as const),
              // The worker may already be executing (or may have settled) by
              // the time the session interrupt reaches this index. Neither
              // outcome proves a safe pre-execution cancellation, so retain a
              // best-effort handoff marker and let the live worker observe it.
              Effect.catch(() => Effect.succeed("handoff" as const)),
            ),
          ),
          // A stale/terminal entry must not make the public interrupt route
          // fail. Any non-cancellation failure is still visible in the audit
          // record below and the normal durable recovery projection.
          Effect.catch(() => Effect.succeed("ignored" as const)),
        )
        if (result === "cancelled") cancelled += 1
        else if (result === "handoff") handoff += 1
      }
      if (pending.length > 0)
        RuntimeInsight.auditRecord({
          actor: "user",
          action: "action.session-cancellation.requested",
          resource: "session-actions",
          reason,
          metadata: {
            sessionID,
            registered: pending.length,
            cancelled,
            handoff,
            // This index is observational; it never grants or infers retry
            // authority and is intentionally not exposed as a user-controlled
            // action ID list.
          },
        })
    })

    return Service.of({
      validateDelegationParent: Effect.fn("ActionGateway.validateDelegationParent")(function* (input) {
        const parent = yield* durableActions.load(input.actionID)
        const action = parent.action
        const now = yield* DateTime.now
        const nowMs = DateTime.toEpochMillis(now)
        const identityMatches =
          "sessionID" in action &&
          action.subject?.type === "session" &&
          sameSessionSubject(action.subject, input.subject) &&
          action.sessionID === input.subject.sessionID &&
          action.runID === input.runID &&
          action.name === input.toolName
        const handedOff =
          action.status === "executing" &&
          parent.activeAttempt !== undefined &&
          parent.lease !== undefined &&
          DateTime.toEpochMillis(parent.lease.expiresAt) > nowMs
        const settled = action.status === "settled" && parent.observation?.status === "succeeded"
        if (!identityMatches || (!handedOff && !settled) || currentPolicyDecisionError(parent))
          return yield* new RecoveryRequiredError({
            actionID: input.actionID,
            reason: "Delegation parent identity, lifecycle, or policy is not valid.",
          })
        if (action.authority === "automatic" && parent.authorization === undefined) return
        if (
          (action.authority === "scoped_grant" || action.authority === "human") &&
          (yield* validateParentGrantContract(parent, now))
        )
          return
        return yield* new RecoveryRequiredError({
          actionID: input.actionID,
          reason: "Delegation parent authorization is no longer valid.",
        })
      }),
      reconcile,
      inspectRecovery,
      recordMutationIntent,
      reviewMutationIntent,
      settleSupersededAction,
      cancelPendingAction,
      blockAuthorizedHandoff,
      cancelPendingSessionActions,
      execute: (<A, E, R>(input: Input, operation: Operation<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            if (operation.afterSuccessMode === "projection" && (!operation.afterSuccess || !operation.durableResult))
              return yield* new BlockedError({
                actionID: input.actionID,
                reason: "Durable postprocessing requires a result codec and a processor before execution.",
              })
            if (operation.afterSuccessMode === "projection")
              input = { ...input, resources: [...new Set([...input.resources, POSTPROCESSING_RESOURCE])] }
            const estimatedTokens = operation.estimatedTokens ?? 0
            let presentedSubject = yield* subjectOf(input)
            let subject = presentedSubject
            let session = subject.type === "session" ? subject : undefined
            const authority = authorityFor(input.semantics.riskTier)
            const semantics = canonicalEffectSemantics(input.semantics, authority)
            // Snapshot and canonicalize the caller-owned plan before the first
            // asynchronous boundary. Permission requests, the durable intent,
            // grant issuance, and recovery all use this one immutable scope.
            let authorization: AuthorizationPlan | undefined
            try {
              authorization = operation.authorization ? canonicalPlan(operation.authorization) : undefined
            } catch (cause) {
              return yield* new BlockedError({
                actionID: input.actionID,
                reason: `Authorization metadata is not a bounded canonical JSON record: ${cause instanceof Error ? cause.message : "invalid metadata"}`,
              })
            }
            let intentDigest = intentDigestOf(input, authorization)
            let legacyIntentDigest = legacyIntentDigestV1Of(input, authorization)
            if (authority === "scoped_grant" || authority === "human") {
              const invalid = invalidAuthorizationPlan(authorization)
              if (invalid) return yield* new BlockedError({ actionID: input.actionID, reason: invalid })
            }
            yield* assertSessionChildRun(input, session, authorization, semantics)
            if (subject.type === "control-plane") {
              // The presented identity must equal the deterministic durable
              // identity of this control-plane action; a forged actionID can
              // never reuse another subject's grant or settled action.
              const expected = stableControlPlaneActionID({
                subject,
                name: input.name,
                resources: input.resources,
                inputDigest: input.inputDigest,
                policyVersion: POLICY_VERSION,
              })
              if (expected !== input.actionID)
                return yield* new InvalidSubjectError({
                  reason: "The control-plane action identity does not match its durable identity binding.",
                })
              // Bound L1 control runs may commit automatic, reversible
              // internal projections. They still require the coordinator's
              // opaque run lease; an unbound control-plane caller can never
              // manufacture automatic authority. L3 remains fresh-human and
              // every other control tier stays closed in this release.
              const automaticProjection = input.semantics.riskTier === "L1"
              const freshHuman = input.semantics.riskTier === "L3"
              if (!automaticProjection && !freshHuman)
                return yield* new BlockedError({
                  actionID: input.actionID,
                  reason: "Control-plane actions require a bound automatic L1 run or fresh L3 human approval.",
                })
              if (automaticProjection && (input.runID === undefined || input.runLease === undefined))
                return yield* new BlockedError({
                  actionID: input.actionID,
                  reason: "Automatic control-plane projections require a bound durable run and active lease.",
                })
              yield* revalidateControlRun(input, authorization, semantics)
            }
            let existing = yield* durableActions.load(input.actionID).pipe(
              Effect.map((snapshot) => snapshot as DurableAction.Snapshot | undefined),
              Effect.catchTag("DurableAction.NotFoundError", () => Effect.succeed(undefined)),
            )
            if (
              input.kind === "control-plane" &&
              input.allowSettledReplay === true &&
              input.runID !== undefined &&
              existing === undefined
            )
              return yield* new BlockedError({
                actionID: input.actionID,
                reason: "A completed control run has no durable Action result to replay.",
              })
            if (
              input.kind === "control-plane" &&
              input.allowSettledReplay === true &&
              input.runID !== undefined &&
              existing !== undefined &&
              (existing.action.status !== "settled" || existing.observation?.output === undefined)
            )
              return yield* new BlockedError({
                actionID: input.actionID,
                reason: "A completed control run is missing a settled durable result and cannot be replayed.",
              })
            if (!existing && session && input.runID !== undefined) {
              const replaySession = session
              const recoveryCandidates = yield* durableActions.list({
                sessionID: replaySession.sessionID,
                runID: input.runID,
                limit: 100,
              })
              const matchingCandidates = recoveryCandidates.filter((candidate) => {
                const candidateSubject = candidate.action.subject
                if (
                  candidate.action.name !== input.name ||
                  candidate.action.runID !== input.runID ||
                  candidate.action.parentActionID !== input.parentActionID ||
                  candidate.action.stepID !== input.stepID ||
                  candidateSubject?.type !== "session" ||
                  candidateSubject.sessionID !== replaySession.sessionID ||
                  candidateSubject.agent !== replaySession.agent ||
                  candidateSubject.toolCallID !== replaySession.toolCallID
                )
                  return false
                const candidateInput = {
                  ...input,
                  actionID: candidate.action.id,
                  assistantMessageID: candidateSubject.assistantMessageID,
                } as Input
                return (
                  candidate.action.intentDigest === intentDigestOf(candidateInput, authorization) ||
                  (operation.afterSuccessMode === "projection" &&
                    samePrePostProcessingActionIntent(
                      candidate,
                      candidateInput,
                      candidateSubject,
                      semantics,
                      authorization,
                    ))
                )
              })
              if (matchingCandidates.length > 1)
                return yield* new RecoveryRequiredError({
                  actionID: input.actionID,
                  reason:
                    "Recovery found multiple durable actions for the same Run and tool-call identity; automatic aliasing is unsafe.",
                })
              const recovered = matchingCandidates[0]
              if (recovered?.action.subject?.type === "session") {
                const recoveredIntentDigest = recovered.action.intentDigest
                if (!recoveredIntentDigest)
                  return yield* new RecoveryRequiredError({
                    actionID: input.actionID,
                    reason: "The recovered durable action has no intent fingerprint and cannot be safely aliased.",
                  })
                input = {
                  ...input,
                  actionID: recovered.action.id,
                  assistantMessageID: recovered.action.subject.assistantMessageID,
                } as Input
                presentedSubject = recovered.action.subject
                subject = presentedSubject
                session = presentedSubject
                intentDigest = recoveredIntentDigest
                legacyIntentDigest = legacyIntentDigestV1Of(input, authorization)
                existing = recovered
                RuntimeInsight.auditRecord({
                  actor: "recovery",
                  action: "action.identity.aliased",
                  resource: input.name,
                  reason:
                    "Recovered the original durable action after the provider replayed the same Run/tool call with a new assistant message ID.",
                  metadata: {
                    sessionID: session.sessionID,
                    actionID: recovered.action.id,
                    toolCallID: session.toolCallID,
                  },
                })
              }
            }
            if (
              existing &&
              !sameStoredActionIntent(existing.action, input, presentedSubject, semantics, intentDigest) &&
              !sameLegacySettledActionIntent(existing.action, input, presentedSubject, semantics, legacyIntentDigest) &&
              !(
                operation.afterSuccessMode === "projection" &&
                existing.action.status === "settled" &&
                existing.observation?.status === "succeeded" &&
                existing.observation.output !== undefined &&
                samePrePostProcessingActionIntent(existing, input, presentedSubject, semantics, authorization)
              )
            )
              return yield* new ActionIntentMismatchError({
                actionID: input.actionID,
                reason:
                  "The durable action's frozen subject, invocation identity, resources, semantics, authority, or intent does not match this execution request.",
              })
            if (existing && !["settled", "blocked", "cancelled"].includes(existing.action.status)) {
              const policyError = currentPolicyDecisionError(existing)
              if (policyError)
                return yield* new RecoveryRequiredError({
                  actionID: input.actionID,
                  reason: policyError,
                })
            }
            // Register the exact immutable scope before any lease/approval
            // effect can yield. SessionExecution uses this same gateway-owned
            // index to win the durable pending-action CAS before interrupting
            // the runner. Terminal actions are never registered; a replayed
            // pending action is registered again with the same canonical
            // identity and plan after recovery aliasing above.
            let pendingRegistration: PendingSessionAction | undefined
            if (
              session &&
              authorization &&
              (existing === undefined || !["settled", "blocked", "cancelled"].includes(existing.action.status))
            ) {
              pendingRegistration = registerPendingSessionAction(input, authorization)
              if (existing !== undefined) markPendingSessionActionReady(pendingRegistration)
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  markPendingSessionActionReady(pendingRegistration)
                  unregisterPendingSessionAction(pendingRegistration)
                }),
              )
            }
            if (existing?.action.subject !== undefined) {
              subject = existing.action.subject
              session = subject.type === "session" ? subject : undefined
            }
            const leaseOwnerID = randomUUID()
            let lease: AgentRuntime.ActionLease | undefined
            let leaseCapability: DurableAction.ActionLeaseCapability | undefined
            let leaseLost: Deferred.Deferred<never, RecoveryRequiredError> | undefined
            const beginLease = Effect.fnUntraced(function* () {
              const claimed = yield* durableActions
                .acquireLease({ actionID: input.actionID, ownerID: leaseOwnerID, ttlMs: actionLeaseTtlMs })
                .pipe(
                  Effect.catchTag("DurableAction.LeaseHeldError", (held) =>
                    Effect.fail(
                      new ActionInProgressError({
                        actionID: input.actionID,
                        ownerID: held.ownerID,
                        expiresAtMs: held.expiresAtMs,
                      }) as never,
                    ),
                  ),
                )
              if (!claimed.snapshot.lease || !claimed.capability || claimed.snapshot.lease.ownerID !== leaseOwnerID)
                return yield* new BlockedError({
                  actionID: input.actionID,
                  reason: "The durable action became terminal before this worker acquired its execution lease.",
                })
              lease = claimed.snapshot.lease
              leaseCapability = claimed.capability
              leaseLost = yield* Deferred.make<never, RecoveryRequiredError>()
              const lost = leaseLost
              // The lease spans human approval and operation.execute. A failed
              // durable heartbeat races the operation and interrupts this owner;
              // no timer/mutex exists in process memory as authority.
              yield* Effect.sleep(`${Math.max(1, Math.floor(actionLeaseTtlMs / 3))} millis`).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    const currentCapability = leaseCapability
                    if (!currentCapability)
                      return yield* Deferred.fail(
                        lost,
                        new RecoveryRequiredError({
                          actionID: input.actionID,
                          reason: "The durable action lease capability was lost while this worker was active.",
                        }),
                      )
                    const renewed = yield* durableActions.heartbeat({
                      capability: currentCapability,
                      actionID: input.actionID,
                      ttlMs: actionLeaseTtlMs,
                    })
                    if (!renewed.capability || !renewed.snapshot.lease)
                      return yield* Deferred.fail(
                        lost,
                        new RecoveryRequiredError({
                          actionID: input.actionID,
                          reason: "The durable action lease heartbeat returned no current capability.",
                        }),
                      )
                    lease = renewed.snapshot.lease
                    leaseCapability = renewed.capability
                  }).pipe(
                    Effect.catch(() =>
                      Deferred.fail(
                        lost,
                        new RecoveryRequiredError({
                          actionID: input.actionID,
                          reason: "The durable action lease was lost while this worker was active.",
                        }),
                      ),
                    ),
                  ),
                ),
                Effect.forever,
                Effect.forkScoped,
              )
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  const currentLease = lease
                  const currentCapability = leaseCapability
                  if (!currentLease || !currentCapability) return
                  yield* durableActions
                    .releaseLease(currentCapability, {
                      actionID: input.actionID,
                      reason: "Action gateway worker finished",
                    })
                    .pipe(Effect.ignore)
                }),
              )
            })
            const assertOwnership: OwnershipAssertion = Effect.fnUntraced(function* () {
              if (!lease || !leaseCapability)
                return yield* new RecoveryRequiredError({
                  actionID: input.actionID,
                  reason: "No durable action lease is held by this worker.",
                })
              return yield* durableActions.assertLease(leaseCapability, { actionID: input.actionID }).pipe(
                Effect.catchTag(
                  "DurableAction.InvalidActionLeaseCapabilityError",
                  () =>
                    new RecoveryRequiredError({
                      actionID: input.actionID,
                      reason: "The durable action lease capability is no longer current.",
                    }),
                ),
              )
            })
            const commitOwned = <A, E, R>(
              expectedStatus: AgentRuntime.ActionStatus,
              commit: (snapshot: DurableAction.Snapshot) => Effect.Effect<A, E, R>,
            ) =>
              Effect.gen(function* () {
                for (let contention = 0; contention < 6; contention++) {
                  const current = yield* assertOwnership()
                  if (current.action.status !== expectedStatus)
                    return yield* new RecoveryRequiredError({
                      actionID: input.actionID,
                      reason: `Expected durable action state ${expectedStatus}, found ${current.action.status}; the owned commit was not written.`,
                    })
                  const committed = yield* commit(current).pipe(Effect.exit)
                  if (committed._tag === "Success") return committed.value
                  if (!sequenceConflict(committed.cause)) return yield* Effect.failCause(committed.cause)
                }
                return yield* new RecoveryRequiredError({
                  actionID: input.actionID,
                  reason: `Owned durable commit contention did not converge in state ${expectedStatus}.`,
                })
              })
            if (existing && !["settled", "blocked", "cancelled"].includes(existing.action.status)) {
              yield* beginLease()
              existing = yield* assertOwnership()
            }
            let resumingSafeExecution = false
            let recoveredCapability: AuthorizationGrantCapability | undefined
            if (existing) {
              const { action, observation } = existing
              const semanticState = projectToolExecution(existing, "recovery")
              if (semanticState.repair.required) {
                RuntimeInsight.auditRecord({
                  actor: "recovery",
                  action: "action.repair.required",
                  resource: input.name,
                  reason: semanticState.repair.reason,
                  metadata: {
                    ...(session ? { sessionID: session.sessionID } : {}),
                    actionID: input.actionID,
                    state: semanticState.state,
                    actionStatus: semanticState.actionStatus,
                    ...(semanticState.attempt === undefined ? {} : { attempt: semanticState.attempt }),
                    lastSequence: semanticState.lastSequence,
                    repairSource: semanticState.repair.source,
                  },
                })
              }
              // A presented actionID with a different canonical intent fails
              // closed before any PermissionV2 request, attempt, hook, or tool
              // body; the previous result is never replayed for changed intent.
              const existingSessionID =
                action.subject?.type === "control-plane"
                  ? undefined
                  : action.subject?.type === "session"
                    ? action.subject.sessionID
                    : "sessionID" in action
                      ? action.sessionID
                      : undefined
              if (existingSessionID !== session?.sessionID || action.name !== input.name) {
                return yield* new BlockedError({
                  actionID: input.actionID,
                  reason: "The durable action identity does not match this tool call.",
                })
              }
              const mutationRecoveryNeedsReview =
                semanticState.mutationRecovery !== undefined &&
                !(
                  semanticState.mutationRecovery.phase === "settled" &&
                  action.status === "settled" &&
                  observation?.status !== undefined
                )
              if (mutationRecoveryNeedsReview) {
                const reason = mutationRecoveryMessage(semanticState)
                RuntimeInsight.auditRecord({
                  actor: "recovery",
                  action: "action.mutation.recovery.required",
                  resource: input.name,
                  reason,
                  metadata: {
                    ...(session ? { sessionID: session.sessionID } : {}),
                    actionID: input.actionID,
                    mutationDecision: semanticState.mutationRecovery?.decision,
                    mutationPhase: semanticState.mutationRecovery?.phase,
                    transactionID: semanticState.mutationRecovery?.transactionID,
                  },
                })
                // A terminal Action record cannot be moved backwards, but a
                // non-terminal record must become visibly blocked before the
                // caller receives the recovery error. In both cases the
                // mutation transaction—not retry policy—remains authoritative.
                if (!["settled", "blocked", "cancelled"].includes(action.status))
                  yield* change(input, action.status, "blocked", reason, assertOwnership)
                return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
              }
              if (action.status === "settled" || observation?.status === "succeeded") {
                if (action.status !== "settled")
                  yield* change(input, action.status, "settled", "Recovered completed observation", assertOwnership)
                const processing = existing.postProcessing
                if (
                  (processing && processing.state !== "completed") ||
                  (!processing && action.resources.includes(POSTPROCESSING_RESOURCE))
                )
                  return yield* new PostProcessingError({
                    actionID: input.actionID,
                    reason:
                      !processing || processing.state === "started"
                        ? "The action completed, but postprocessing has no confirmed result. Inspect the original result; do not repeat the action."
                        : "The action completed and its success was recorded, but postprocessing failed. Inspect the recorded result; do not repeat the action.",
                  })
                if (observation?.output && operation.durableResult) {
                  try {
                    const replayOutput = processing?.output ?? observation.output
                    const restored = yield* decodeDurableOutput(
                      operation.durableResult,
                      replayOutput,
                      DurableAction.outputOwner(action),
                      outputStore,
                    ).pipe(
                      Effect.mapError(
                        () =>
                          new RecoveryRequiredError({
                            actionID: input.actionID,
                            reason:
                              "The action is settled, but its durable result is unavailable or invalid. Inspect the original action; do not repeat it.",
                          }),
                      ),
                    )
                    RuntimeInsight.auditRecord({
                      actor: "recovery",
                      action: "action.result.replayed",
                      resource: input.name,
                      reason: "Reused the durably observed tool result without repeating its side effect.",
                      metadata: {
                        ...(session ? { sessionID: session.sessionID } : {}),
                        actionID: input.actionID,
                        outputDigest: replayOutput.digest,
                        byteLength: replayOutput.byteLength,
                      },
                    })
                    return restored
                  } catch (cause) {
                    return yield* new RecoveryRequiredError({
                      actionID: input.actionID,
                      reason: `The action is settled, but its durable result could not be decoded: ${String(cause)}`,
                    })
                  }
                }
                return yield* new AlreadySettledError({
                  actionID: input.actionID,
                  summary: observation?.summary ?? "The action was already completed and was not executed again.",
                })
              }
              if (action.status === "blocked") {
                return yield* new BlockedError({
                  actionID: input.actionID,
                  reason:
                    semanticState.state === "outcome_unknown"
                      ? recoveryMessage(semanticState)
                      : (observation?.summary ?? "The durable action is blocked and needs user review."),
                })
              }
              if (action.status === "cancelled") {
                return yield* new BlockedError({
                  actionID: input.actionID,
                  reason: "The durable action was cancelled before execution and cannot be resumed.",
                })
              }
              // Legacy actions without an intent fingerprint cannot be safely
              // resumed: completed records stay readable above, but any pending
              // side-effecting state requires re-preflight under a new identity.
              if (!action.intentDigest) {
                const reason =
                  "The durable action has no intent fingerprint and cannot be resumed safely; re-issue the call under a new action identity."
                yield* change(input, action.status, "blocked", reason, assertOwnership)
                return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
              }
              if (action.authority === "scoped_grant" || action.authority === "human") {
                // An awaiting_approval action with no grant has a dead ask (e.g.
                // after a rebuild): it is re-presented through a fresh human
                // approval below, so the missing grant is not a defect to block
                // on. Every other resumable state must hold a valid grant.
                if (action.status !== "awaiting_approval" || existing.authorization) {
                  const invalid = yield* validateGrant(
                    existing.authorization,
                    input,
                    authorization,
                    authority,
                    semantics.riskTier,
                  )
                  if (invalid) {
                    yield* change(input, action.status, "blocked", invalid, assertOwnership)
                    return yield* new RecoveryRequiredError({ actionID: input.actionID, reason: invalid })
                  }
                }
              }
              if (action.status === "executing") {
                if (action.semantics.idempotency === "idempotent" && action.semantics.retryability === "safe") {
                  resumingSafeExecution = true
                  RuntimeInsight.auditRecord({
                    actor: "recovery",
                    action: "action.execution.resumed",
                    resource: input.name,
                    reason: "A safely retryable idempotent action was interrupted before observation.",
                    metadata: {
                      ...(session ? { sessionID: session.sessionID } : {}),
                      actionID: input.actionID,
                      ...(session ? { toolCallID: session.toolCallID } : {}),
                      state: semanticState.state,
                      repairSource: semanticState.repair.source,
                    },
                  })
                } else {
                  const reason = `${recoveryMessage(semanticState)} Automatic retry is blocked to prevent a duplicate side effect.`
                  yield* change(input, "executing", "blocked", reason, assertOwnership)
                  return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
                }
              } else if (action.status === "authorized") {
                yield* change(
                  input,
                  "authorized",
                  "executing",
                  "Recovered a verified authorization grant",
                  assertOwnership,
                )
                resumingSafeExecution = true
              } else if (action.status === "awaiting_approval" && existing.authorization) {
                yield* change(
                  input,
                  "awaiting_approval",
                  "authorized",
                  "Recovered a verified authorization grant",
                  assertOwnership,
                )
                yield* change(input, "authorized", "executing", "Authorized action resumed", assertOwnership)
                resumingSafeExecution = true
              } else if (action.status === "awaiting_approval") {
                // Trusted recovery re-approval: the durable intent is unchanged
                // and the previous ask is gone (e.g. after a restart). Re-run the
                // fresh L3 human approval under the SAME durable action — no new
                // action identity is minted, the old action is never orphaned,
                // and no event replay or forged grant can start execution.
                if (!authorization) {
                  const reason = "The action declared an approval but provided no enforceable permission gate."
                  yield* change(input, action.status, "blocked", reason, assertOwnership)
                  return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
                }
                const parentSnapshot = input.parentActionID
                  ? yield* durableActions.load(input.parentActionID).pipe(Effect.option)
                  : undefined
                const parent = parentSnapshot?._tag === "Some" ? parentSnapshot.value : undefined
                recoveredCapability = yield* authorizeActionObserved(
                  input,
                  authorization,
                  authority,
                  semantics.riskTier,
                  parent,
                  session,
                  subject,
                  intentDigest,
                  assertOwnership,
                )
                resumingSafeExecution = true
              } else if (action.status === "proposed") {
                // A worker can crash after durably proposing an action but
                // before recording the policy decision. The lease acquired
                // above makes this worker the only process allowed to resume
                // that exact proposal; continue through the normal policy and
                // authorization path without publishing a second proposal.
              } else {
                const reason = semanticState.repair.required
                  ? `Recovery found ${semanticState.state}: ${semanticState.repair.reason} User review is required before execution can continue.`
                  : `Recovery found action state ${action.status}; user review is required before execution can continue.`
                yield* change(input, action.status, "blocked", reason, assertOwnership)
                return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
              }
            }

            const now = yield* DateTime.now
            // The operation body only ever receives a gateway-verified capability:
            // the freshly sealed grant on the first run, or the durable grant that
            // recovery just re-validated. Automatic (L0/L1) actions get an
            // `automatic` capability without a grant.
            let capability: AuthorizationGrantCapability = mintCapability("automatic", undefined)
            if (existing?.authorization) capability = mintCapability("granted", existing.authorization)
            if (recoveredCapability) capability = recoveredCapability
            yield* Effect.addFinalizer(() => Effect.sync(() => revokeCapability(capability)))
            const assertCurrentGrant = Effect.fnUntraced(function* () {
              const current = yield* assertOwnership()
              const policyError = currentPolicyDecisionError(current)
              if (policyError)
                return yield* new RecoveryRequiredError({
                  actionID: input.actionID,
                  reason: policyError,
                })
              if (authority === "scoped_grant" || authority === "human") {
                const invalid = yield* validateGrant(
                  current.authorization,
                  input,
                  authorization,
                  authority,
                  semantics.riskTier,
                )
                const capabilityGrant = capability.authority === "granted" ? capability.grant : undefined
                if (invalid || capabilityGrant?.id !== current.authorization?.id)
                  return yield* new RecoveryRequiredError({
                    actionID: input.actionID,
                    reason: invalid ?? "The execution capability no longer matches the persisted authorization grant.",
                  })
              } else if (current.authorization !== undefined || capability.authority !== "automatic") {
                return yield* new RecoveryRequiredError({
                  actionID: input.actionID,
                  reason: "An automatic action cannot execute with a persisted authorization grant.",
                })
              }
              return current
            })
            const operationContext: OperationExecutionContext = {
              actionID: input.actionID,
              recordModelRequest: (envelope) =>
                Effect.gen(function* () {
                  const serialized = yield* Effect.try({
                    try: () => {
                      const serialized = requestEnvelopeJson(envelope)
                      parseActionRequestEnvelope(serialized, input)
                      return serialized
                    },
                    catch: () =>
                      new RecoveryRequiredError({
                        actionID: input.actionID,
                        reason: "Invalid model request envelope.",
                      }),
                  })
                  yield* commitOwned("executing", (snapshot) =>
                    Effect.gen(function* () {
                      if (
                        !snapshot.activeAttempt ||
                        !snapshot.lease ||
                        snapshot.action.inputDigest !== input.inputDigest
                      )
                        return yield* new RecoveryRequiredError({
                          actionID: input.actionID,
                          reason: "Model request has no active bound Action attempt.",
                        })
                      if (snapshot.modelRequest) {
                        if (snapshot.modelRequest.envelope !== serialized)
                          return yield* new RecoveryRequiredError({
                            actionID: input.actionID,
                            reason: "Model request cannot change after preparation.",
                          })
                        return
                      }
                      yield* events.publish(
                        AgentRuntime.Event.ActionModelRequestPrepared,
                        {
                          actionID: input.actionID,
                          ...(session ? { sessionID: session.sessionID } : {}),
                          subject,
                          attempt: snapshot.activeAttempt.attempt,
                          leaseID: snapshot.lease.id,
                          generation: snapshot.lease.generation,
                          envelope: serialized,
                          recordedAt: yield* DateTime.now,
                        },
                        { expectedSequence: snapshot.lastSequence },
                      )
                    }),
                  )
                }),
              bindExternalOperation: (binding) =>
                commitOwned("executing", (snapshot) =>
                  durableActions.bindExternalOperation({
                    actionID: snapshot.action.id,
                    binding,
                  }),
                ).pipe(Effect.asVoid),
              reportProgress: (update) =>
                commitOwned("executing", (snapshot) =>
                  durableActions.recordProgress({
                    actionID: snapshot.action.id,
                    update,
                  }),
                ).pipe(Effect.asVoid),
            }
            if (!resumingSafeExecution) {
              const parentSnapshot = input.parentActionID
                ? yield* durableActions.load(input.parentActionID).pipe(Effect.option)
                : undefined
              if (input.parentActionID && parentSnapshot?._tag === "None") {
                const reason = `The parent durable action ${input.parentActionID} was not found; the child action cannot be trusted.`
                RuntimeInsight.auditRecord({
                  actor: input.initiator ?? "agent",
                  action: "action.authorization.failed",
                  resource: input.name,
                  reason,
                  metadata: {
                    ...(session ? { sessionID: session.sessionID } : {}),
                    actionID: input.actionID,
                    ...(session ? { toolCallID: session.toolCallID } : {}),
                  },
                })
                return yield* new BlockedError({ actionID: input.actionID, reason })
              }
              const parent = parentSnapshot?._tag === "Some" ? parentSnapshot.value : undefined
              if (parent) {
                const parentSessionID =
                  parent.action.subject?.type === "control-plane"
                    ? undefined
                    : parent.action.subject?.type === "session"
                      ? parent.action.subject.sessionID
                      : "sessionID" in parent.action
                        ? parent.action.sessionID
                        : undefined
                const mismatch =
                  parentSessionID !== session?.sessionID ||
                  (input.runID !== undefined && parent.action.runID !== input.runID)
                if (mismatch || parent.action.status === "blocked") {
                  const reason = "The parent durable action does not match this child action's identity or is blocked."
                  RuntimeInsight.auditRecord({
                    actor: input.initiator ?? "agent",
                    action: "action.authorization.failed",
                    resource: input.name,
                    reason,
                    metadata: {
                      ...(session ? { sessionID: session.sessionID } : {}),
                      actionID: input.actionID,
                      ...(session ? { toolCallID: session.toolCallID } : {}),
                    },
                  })
                  return yield* new BlockedError({ actionID: input.actionID, reason })
                }
              }
              if (!existing) {
                const actionCommon = {
                  id: input.actionID,
                  ...(input.parentActionID ? { parentActionID: input.parentActionID } : {}),
                  ...(input.runID ? { runID: input.runID } : {}),
                  ...(input.stepID ? { stepID: input.stepID } : {}),
                  name: input.name,
                  status: "proposed" as const,
                  semantics,
                  resources: [...input.resources],
                  idempotencyKey: input.actionID,
                  intentDigest,
                  initiator: input.initiator ?? "agent",
                  inputDigest: input.inputDigest,
                  authority,
                  riskTier: semantics.riskTier,
                  reasonSummary: input.reasonSummary,
                  budget: cappedBudget(budgetFor(semantics), parent?.action.budget),
                  traceID: input.traceID ?? input.actionID,
                  visibility: "details" as const,
                  time: { created: now, updated: now },
                }
                const action =
                  subject.type === "session"
                    ? AgentRuntime.SessionAction.make({
                        ...actionCommon,
                        sessionID: subject.sessionID,
                        subject,
                        intentDigest,
                      })
                    : AgentRuntime.ControlAction.make({
                        ...actionCommon,
                        subject,
                      })
                const proposed = yield* events
                  .publish(
                    AgentRuntime.Event.ActionProposed,
                    {
                      actionID: input.actionID,
                      ...(session ? { sessionID: session.sessionID } : {}),
                      subject,
                      action,
                    },
                    { expectedSequence: -1 },
                  )
                  .pipe(Effect.exit)
                if (proposed._tag === "Failure") {
                  if (!sequenceConflict(proposed.cause)) return yield* Effect.failCause(proposed.cause)
                  const winner = yield* durableActions.load(input.actionID).pipe(Effect.option)
                  if (winner._tag === "None")
                    return yield* new RecoveryRequiredError({
                      actionID: input.actionID,
                      reason: "The concurrent proposal won its CAS, but its durable action could not be loaded.",
                    })
                  if (
                    winner.value.action.intentDigest !== intentDigest ||
                    winner.value.action.name !== input.name ||
                    (session !== undefined &&
                      (!("sessionID" in winner.value.action) || winner.value.action.sessionID !== session.sessionID))
                  )
                    return yield* new ActionIntentMismatchError({
                      actionID: input.actionID,
                      reason: "The concurrent durable proposal belongs to a different canonical action intent.",
                    })
                  if (["settled", "blocked", "cancelled"].includes(winner.value.action.status))
                    return yield* new BlockedError({
                      actionID: input.actionID,
                      reason: "The concurrent durable action already reached a terminal state.",
                    })
                  if (winner.value.action.status !== "proposed")
                    return yield* new RecoveryRequiredError({
                      actionID: input.actionID,
                      reason: `A concurrent worker advanced the action to ${winner.value.action.status}; retry through the normal recovery path.`,
                    })
                }
                yield* beginLease()
              }
              // A newly proposed action is now durable and can be atomically
              // cancelled by an originating-session interrupt. Existing
              // actions were marked ready immediately after the reload above.
              markPendingSessionActionReady(pendingRegistration)
              const persistedDecision = existing?.action.status === "proposed" ? existing.policyDecision : undefined
              const decision =
                persistedDecision ??
                AgentRuntime.PolicyDecision.make({
                  actionID: input.actionID,
                  subject,
                  authority,
                  riskTier: semantics.riskTier,
                  decision: authority === "forbidden" ? "deny" : authority === "automatic" ? "allow" : "ask",
                  reason: input.reasonSummary,
                  policyVersion: POLICY_VERSION,
                  decidedAt: now,
                })
              if (!persistedDecision) {
                yield* commitOwned("proposed", (snapshot) =>
                  events.publish(
                    AgentRuntime.Event.ActionPolicyEvaluated,
                    {
                      actionID: input.actionID,
                      ...(session ? { sessionID: session.sessionID } : {}),
                      subject,
                      decision,
                    },
                    { expectedSequence: snapshot.lastSequence },
                  ),
                )
                RuntimeInsight.auditRecord({
                  actor: input.initiator ?? "agent",
                  action: "action.policy.evaluated",
                  resource: input.name,
                  reason: decision.reason,
                  metadata: {
                    ...(session ? { sessionID: session.sessionID } : {}),
                    actionID: input.actionID,
                    authority,
                    riskTier: semantics.riskTier,
                    decision: decision.decision,
                  },
                })
              }
              yield* change(input, "proposed", "policy_evaluated", decision.reason, assertOwnership)

              if (authority === "forbidden") {
                const reason = "L4 constitutional and security boundaries cannot be changed by an Agent action."
                yield* change(input, "policy_evaluated", "blocked", reason, assertOwnership)
                return yield* new BlockedError({ actionID: input.actionID, reason })
              }

              if (authority === "scoped_grant" || authority === "human") {
                yield* change(input, "policy_evaluated", "awaiting_approval", input.reasonSummary, assertOwnership)
                if (authorization) {
                  capability = yield* authorizeActionObserved(
                    input,
                    authorization,
                    authority,
                    semantics.riskTier,
                    parent,
                    session,
                    subject,
                    intentDigest,
                    assertOwnership,
                  )
                } else {
                  const reason =
                    "The action declared a scoped or human authority but provided no enforceable permission gate."
                  yield* change(input, "awaiting_approval", "blocked", reason, assertOwnership)
                  return yield* new BlockedError({ actionID: input.actionID, reason })
                }
              } else {
                yield* change(
                  input,
                  "policy_evaluated",
                  "authorized",
                  "Automatically authorized by risk policy",
                  assertOwnership,
                )
                yield* change(input, "authorized", "executing", "Automatic action started", assertOwnership)
              }
            }

            let beforeAttempt = yield* assertCurrentGrant()
            if (!leaseLost)
              return yield* new RecoveryRequiredError({
                actionID: input.actionID,
                reason: "The durable action lease monitor was not initialized for execution.",
              })
            const monitoredLeaseLost = leaseLost
            if (beforeAttempt.activeAttempt) {
              const interruptedAt = yield* DateTime.now
              const durationMs = nonNegativeInteger(
                DateTime.toEpochMillis(interruptedAt) - DateTime.toEpochMillis(beforeAttempt.activeAttempt.startedAt),
              )
              const interruptedAttempt = beforeAttempt.activeAttempt
              yield* commitOwned("executing", (snapshot) =>
                events.publish(
                  AgentRuntime.Event.ActionAttemptFinished,
                  {
                    actionID: input.actionID,
                    ...(session ? { sessionID: session.sessionID } : {}),
                    subject,
                    attempt: interruptedAttempt.attempt,
                    outcome: "interrupted",
                    durationMs,
                    costMicros: 0,
                    finishedAt: interruptedAt,
                  },
                  { expectedSequence: snapshot.lastSequence },
                ),
              )
              RuntimeInsight.auditRecord({
                actor: "recovery",
                action: "action.execution.interrupted",
                resource: input.name,
                reason: "Recovery closed the previous active attempt before retrying the durable action.",
                metadata: {
                  ...(session ? { sessionID: session.sessionID } : {}),
                  actionID: input.actionID,
                  attempt: interruptedAttempt.attempt,
                },
              })
              beforeAttempt = yield* assertCurrentGrant()
            }
            const attempt = beforeAttempt.action.budget.attemptsUsed + 1
            if (attempt > beforeAttempt.action.budget.maxAttempts) {
              const reason = `Action retry budget exhausted after ${beforeAttempt.action.budget.attemptsUsed} attempts.`
              yield* change(input, beforeAttempt.action.status, "blocked", reason, assertOwnership)
              return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
            }
            if (beforeAttempt.action.budget.durationMsUsed >= beforeAttempt.action.budget.maxDurationMs) {
              const reason = `Action duration budget exhausted after ${beforeAttempt.action.budget.durationMsUsed} ms.`
              yield* change(input, beforeAttempt.action.status, "blocked", reason, assertOwnership)
              return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
            }
            const estimatedCostMicros = nonNegativeInteger(operation.estimatedCostMicros ?? 0)
            if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) {
              const reason = "Action token estimate must be a non-negative safe integer."
              yield* change(input, beforeAttempt.action.status, "blocked", reason, assertOwnership)
              return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
            }
            if (estimatedTokens > beforeAttempt.action.budget.maxTokens - beforeAttempt.action.budget.tokensUsed) {
              const reason = "Action token budget would be exceeded."
              yield* change(input, beforeAttempt.action.status, "blocked", reason, assertOwnership)
              return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
            }
            if (
              beforeAttempt.action.budget.costMicrosUsed + estimatedCostMicros >
              beforeAttempt.action.budget.maxCostMicros
            ) {
              const reason = `Action cost budget would be exceeded (${beforeAttempt.action.budget.costMicrosUsed} + ${estimatedCostMicros} > ${beforeAttempt.action.budget.maxCostMicros} micros).`
              yield* change(input, beforeAttempt.action.status, "blocked", reason, assertOwnership)
              return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
            }
            const attemptStartedAt = yield* DateTime.now
            yield* commitOwned("executing", (snapshot) =>
              events.publish(
                AgentRuntime.Event.ActionAttemptStarted,
                {
                  actionID: input.actionID,
                  ...(session ? { sessionID: session.sessionID } : {}),
                  subject,
                  attempt,
                  startedAt: attemptStartedAt,
                },
                { expectedSequence: snapshot.lastSequence },
              ),
            )
            // The attempt record is not authority to run: cancellation or a
            // lease takeover can win between its CAS and the executor call.
            yield* assertOwnership()
            yield* revalidateControlRun(input, authorization, semantics)
            yield* assertCurrentGrant()
            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                // The operation remains interruptible, but once it returns an
                // Exit the attempt/observation/state commits below run under
                // the mask. An external cancel therefore cannot leave an
                // owned action stuck in `executing` merely by interrupting the
                // worker between the side effect and its durable observation.
                const operationFiber = yield* operation
                  .execute(capability, operationContext)
                  .pipe(Effect.interruptible, Effect.forkChild)
                let result = yield* Effect.exit(
                  restore(Effect.raceFirst(Fiber.join(operationFiber), Deferred.await(monitoredLeaseLost))).pipe(
                    Effect.ensuring(Fiber.interrupt(operationFiber)),
                    Effect.ensuring(Effect.sync(() => revokeCapability(capability))),
                  ),
                )
                // Joining the race may be interrupted before the operation's
                // cleanup finishes. Await that owned fiber before measuring,
                // and preserve cleanup defects rather than reporting a pure cancel.
                const operationExit = yield* Fiber.await(operationFiber)
                if (
                  Exit.isFailure(result) &&
                  Exit.isFailure(operationExit) &&
                  result.cause !== operationExit.cause &&
                  !Cause.hasInterruptsOnly(operationExit.cause)
                )
                  result = Exit.failCause(Cause.combine(result.cause, operationExit.cause))
                yield* testCrashBoundaryPause("effect-before-observation")
                const observedAt = yield* DateTime.now
                let costMicros: number | undefined
                let measurementFailed = false
                if (operation.costMicros) {
                  try {
                    const measured = operation.costMicros(result)
                    if (measured === undefined || !Number.isSafeInteger(measured) || measured < 0)
                      throw new Error("Invalid action cost measurement")
                    costMicros = measured
                  } catch {
                    measurementFailed = true
                    RuntimeInsight.auditRecord({
                      actor: input.initiator ?? "agent",
                      action: "action.cost.measurement.failed",
                      resource: input.name,
                      reason: "Cost measurement unavailable; no measured zero was fabricated.",
                      metadata: {
                        ...(session ? { sessionID: session.sessionID } : {}),
                        actionID: input.actionID,
                      },
                    })
                  }
                }
                const durationMs = nonNegativeInteger(
                  DateTime.toEpochMillis(observedAt) - DateTime.toEpochMillis(attemptStartedAt),
                )
                let tokens: number | undefined
                if (operation.tokens) {
                  try {
                    const measured = operation.tokens(result)
                    if (measured === undefined || !Number.isSafeInteger(measured) || measured < 0)
                      throw new Error("Invalid action token measurement")
                    tokens = measured
                  } catch {
                    measurementFailed = true
                    // Keep absence distinguishable from a measured zero. Do
                    // not persist callback errors that could contain payloads.
                    RuntimeInsight.auditRecord({
                      actor: input.initiator ?? "agent",
                      action: "action.tokens.measurement.failed",
                      resource: input.name,
                      reason: "Token measurement unavailable; no measured zero was fabricated.",
                      metadata: { actionID: input.actionID },
                    })
                  }
                }
                yield* commitOwned("executing", (snapshot) =>
                  events.publish(
                    AgentRuntime.Event.ActionAttemptFinished,
                    {
                      actionID: input.actionID,
                      ...(session ? { sessionID: session.sessionID } : {}),
                      subject,
                      attempt,
                      outcome: Exit.isSuccess(result)
                        ? "succeeded"
                        : Cause.hasInterruptsOnly(result.cause)
                          ? "interrupted"
                          : "failed",
                      durationMs,
                      ...(costMicros === undefined ? {} : { costMicros }),
                      ...(tokens === undefined ? {} : { tokens }),
                      finishedAt: observedAt,
                    },
                    { expectedSequence: snapshot.lastSequence },
                  ),
                )
                if (measurementFailed) {
                  const reason = "Action usage measurement failed; reconciliation is required before further execution."
                  yield* change(input, "executing", "blocked", reason, assertOwnership)
                  if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
                  return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
                }
                if (Exit.isSuccess(result)) {
                  const resultOwner = DurableAction.outputOwner((yield* durableActions.load(input.actionID)).action)
                  let output: AgentRuntime.ActionOutput | undefined
                  if (operation.durableResult) {
                    try {
                      const encoded = yield* encodeDurableOutput(
                        operation.durableResult,
                        result.value,
                        resultOwner,
                        outputStore,
                      ).pipe(Effect.exit)
                      if (Exit.isFailure(encoded)) throw new Error("The exact action result could not be retained.")
                      output = encoded.value
                    } catch (cause) {
                      RuntimeInsight.auditRecord({
                        actor: input.initiator ?? "agent",
                        action: "action.result.not-persisted",
                        resource: input.name,
                        reason: cause instanceof Error ? cause.message : String(cause),
                        metadata: {
                          ...(session ? { sessionID: session.sessionID } : {}),
                          actionID: input.actionID,
                        },
                      })
                    }
                  }
                  const observation = AgentRuntime.Observation.make({
                    id: AgentRuntime.ObservationID.create(),
                    actionID: input.actionID,
                    status: "succeeded",
                    summary: operation.successSummary?.(result.value) ?? `${input.name} completed`,
                    ...(output ? { output, outputDigest: output.digest } : {}),
                    artifactIDs: [],
                    observedAt,
                  })
                  yield* commitOwned("executing", (snapshot) =>
                    events.publish(
                      AgentRuntime.Event.ActionObserved,
                      {
                        actionID: input.actionID,
                        ...(session ? { sessionID: session.sessionID } : {}),
                        subject,
                        observation,
                      },
                      { expectedSequence: snapshot.lastSequence },
                    ),
                  )
                  yield* change(input, "executing", "observed", observation.summary, assertOwnership)
                  yield* change(input, "observed", "settled", "Action settled", assertOwnership)
                  if (operation.afterSuccess) {
                    const projection = operation.afterSuccessMode === "projection"
                    const recordProcessing = (
                      state: AgentRuntime.ActionPostProcessing["state"],
                      projected?: AgentRuntime.ActionOutput,
                    ) =>
                      Effect.gen(function* () {
                        const recordedAt = yield* DateTime.now
                        // A settled action cannot grant an execution lease.
                        // This private append-only seam binds the observation
                        // just committed by this owner; it never authorizes an
                        // executor or changes the effect's terminal state.
                        for (let contention = 0; contention < 6; contention++) {
                          const snapshot = yield* durableActions.load(input.actionID)
                          if (
                            snapshot.action.status !== "settled" ||
                            snapshot.observation?.id !== observation.id ||
                            (state === "started"
                              ? snapshot.postProcessing !== undefined
                              : snapshot.postProcessing?.state !== "started")
                          )
                            return yield* new PostProcessingError({
                              actionID: input.actionID,
                              reason:
                                "The action completed, but postprocessing no longer owns its recorded result. Do not repeat the action.",
                            })
                          const written = yield* events
                            .publish(
                              AgentRuntime.Event.ActionPostProcessingRecorded,
                              {
                                actionID: input.actionID,
                                ...(session ? { sessionID: session.sessionID } : {}),
                                subject,
                                processing: {
                                  observationID: observation.id,
                                  state,
                                  ...(projected ? { output: projected } : {}),
                                  recordedAt,
                                },
                              },
                              { expectedSequence: snapshot.lastSequence },
                            )
                            .pipe(Effect.exit)
                          if (Exit.isSuccess(written)) return
                          if (!sequenceConflict(written.cause)) return yield* Effect.failCause(written.cause)
                        }
                        return yield* new PostProcessingError({
                          actionID: input.actionID,
                          reason:
                            "The action completed, but postprocessing could not be recorded. Do not repeat the action.",
                        })
                      }).pipe(
                        Effect.catchCause((cause) => {
                          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
                          const error = Cause.squash(cause)
                          // Storage/projector failures can carry private paths,
                          // SQL or plugin data. The effect already succeeded;
                          // failure to confirm its receipt is not task failure.
                          return Effect.fail(
                            error instanceof PostProcessingError
                              ? error
                              : new PostProcessingError({
                                  actionID: input.actionID,
                                  reason:
                                    "The action completed, but the postprocessing receipt could not be confirmed. Inspect the original result; do not repeat the action.",
                                }),
                          )
                        }),
                      )
                    if (projection) {
                      if (!output || !operation.durableResult)
                        return yield* new PostProcessingError({
                          actionID: input.actionID,
                          reason:
                            "The action completed, but its result could not be retained for postprocessing. Do not repeat the action.",
                        })
                      yield* recordProcessing("started")
                    }
                    const posted = yield* Effect.exit(
                      restore(Effect.suspend(() => operation.afterSuccess!(structuredClone(result.value)))).pipe(
                        Effect.flatMap((value) => {
                          if (!projection) return Effect.succeed(undefined)
                          const owner = resultOwner
                          return encodeDurableOutput(operation.durableResult!, value as A, owner, outputStore).pipe(
                            Effect.flatMap((output) =>
                              decodeDurableOutput(operation.durableResult!, output, owner, outputStore).pipe(
                                Effect.map((value) => ({ output, value })),
                              ),
                            ),
                          )
                        }),
                      ),
                    )
                    if (Exit.isFailure(posted)) {
                      const interrupted = Cause.hasInterruptsOnly(posted.cause)
                      if (projection) {
                        const recorded = yield* recordProcessing(interrupted ? "interrupted" : "failed").pipe(
                          Effect.exit,
                        )
                        if (Exit.isFailure(recorded)) {
                          if (!interrupted) return yield* Effect.failCause(recorded.cause)
                          // A secondary receipt write failure must not turn
                          // cancellation into an ordinary tool failure and
                          // allow the parent loop to continue executing.
                          RuntimeInsight.auditRecord({
                            actor: input.initiator ?? "agent",
                            action: "action.postprocessing.receipt.unconfirmed",
                            resource: input.name,
                            reason:
                              "The action completed, but its cancelled postprocessing receipt could not be confirmed. Do not repeat the action.",
                            metadata: {
                              ...(session ? { sessionID: session.sessionID } : {}),
                              actionID: input.actionID,
                              interrupted: true,
                            },
                          })
                        }
                      }
                      const reason = interrupted
                        ? "The action completed and its success was recorded, but postprocessing was cancelled. Do not repeat the action."
                        : "The action completed and its success was recorded, but postprocessing failed. Inspect the recorded result; do not repeat the action."
                      RuntimeInsight.auditRecord({
                        actor: input.initiator ?? "agent",
                        action: "action.postprocessing.failed",
                        resource: input.name,
                        reason,
                        metadata: {
                          ...(session ? { sessionID: session.sessionID } : {}),
                          actionID: input.actionID,
                          interrupted,
                        },
                      })
                      // Plugin payloads and cleanup defects can contain
                      // secrets. Preserve pure cancellation, otherwise expose
                      // only the phase-specific, content-free error.
                      if (interrupted) return yield* Effect.failCause(posted.cause)
                      return yield* new PostProcessingError({ actionID: input.actionID, reason })
                    }
                    if (projection && posted.value) {
                      yield* recordProcessing("completed", posted.value.output)
                      return posted.value.value
                    }
                  }
                  return result.value
                }
                const failure = Cause.squash(result.cause)
                let outcomeUnknown = false
                if (operation.outcomeUnknownOnFailure) {
                  try {
                    outcomeUnknown = operation.outcomeUnknownOnFailure(failure) === true
                  } catch (cause) {
                    // A classifier is advisory metadata, never a reason to
                    // leave an owned action in `executing`. If it defects,
                    // retain the ordinary sanitized failed observation.
                    RuntimeInsight.auditRecord({
                      actor: input.initiator ?? "agent",
                      action: "action.execution.classification.failed",
                      resource: input.name,
                      reason: cause instanceof Error ? cause.message : String(cause),
                      metadata: {
                        ...(session ? { sessionID: session.sessionID } : {}),
                        actionID: input.actionID,
                      },
                    })
                  }
                }
                if (outcomeUnknown) {
                  // A transport can fail after the remote side effect has
                  // started but before a durable observation is returned. Do
                  // not manufacture a failed Observation: the existing
                  // blocked terminal state plus the missing observation
                  // projects as `outcome_unknown` and forces read-only
                  // reconciliation.
                  const reason =
                    "The external action outcome is unknown; inspect or reconcile the external state before retrying."
                  RuntimeInsight.auditRecord({
                    actor: input.initiator ?? "agent",
                    action: "action.execution.outcome_unknown",
                    resource: input.name,
                    reason,
                    metadata: {
                      ...(session ? { sessionID: session.sessionID } : {}),
                      actionID: input.actionID,
                    },
                  })
                  yield* change(input, "executing", "blocked", reason, assertOwnership)
                  return yield* new RecoveryRequiredError({ actionID: input.actionID, reason })
                }
                const correlationID = randomUUID()
                const summary = failedSummary(result.cause, correlationID)
                if (Cause.hasInterruptsOnly(result.cause)) {
                  RuntimeInsight.auditRecord({
                    actor: input.initiator ?? "agent",
                    action: "action.execution.interrupted",
                    resource: input.name,
                    reason: "The action was interrupted before observation.",
                    metadata: {
                      ...(session ? { sessionID: session.sessionID } : {}),
                      actionID: input.actionID,
                    },
                  })
                } else {
                  // Full diagnostics stay in protected audit logs; the model-visible
                  // summary never exposes stacks, paths, or unexpected cause details.
                  RuntimeInsight.auditRecord({
                    actor: input.initiator ?? "agent",
                    action: "action.execution.failed",
                    resource: input.name,
                    reason: Cause.pretty(result.cause).slice(0, 4_000),
                    metadata: {
                      ...(session ? { sessionID: session.sessionID } : {}),
                      actionID: input.actionID,
                      correlationID,
                    },
                  })
                }
                const observation = AgentRuntime.Observation.make({
                  id: AgentRuntime.ObservationID.create(),
                  actionID: input.actionID,
                  status: Cause.hasInterruptsOnly(result.cause) ? "interrupted" : "failed",
                  summary,
                  artifactIDs: [],
                  observedAt,
                })
                yield* commitOwned("executing", (snapshot) =>
                  events.publish(
                    AgentRuntime.Event.ActionObserved,
                    {
                      actionID: input.actionID,
                      ...(session ? { sessionID: session.sessionID } : {}),
                      subject,
                      observation,
                    },
                    { expectedSequence: snapshot.lastSequence },
                  ),
                )
                yield* change(input, "executing", "observed", summary, assertOwnership)
                yield* change(input, "observed", "blocked", "Action did not settle successfully", assertOwnership)
                return yield* Effect.failCause(result.cause)
              }),
            )
          }),
        ).pipe(
          Effect.withSpan("Arforge.Action", {
            attributes: {
              "arforge.action_id": input.actionID,
              "arforge.run_id": input.runID ?? "",
              "arforge.trace_id": input.traceID ?? "",
              "arforge.input_digest": input.inputDigest,
              "arforge.risk_tier": input.semantics.riskTier,
            },
          }),
        )) as Interface["execute"],
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    DurableAction.node,
    DurableRun.node,
    Authorizer.node,
    SecretProvider.node,
    ToolOutputStore.nodeWithoutConfig,
  ],
})
