export * as AgentRuntime from "./agent-runtime"

import { Effect, Schema } from "effect"
import { ascending } from "./identifier"
import { AbsolutePath, DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { define, inventory } from "./event"
import { Goal } from "./goal"
import { Permission } from "./permission"
import { Project } from "./project"
import { SessionID } from "./session-id"
import { TaskGraph } from "./task-graph"
import { Billing } from "./billing"
import { Credential } from "./credential"
import * as PersonalJobInput from "./personal-job-input"

const brandedID = <Prefix extends string, Brand extends string>(prefix: Prefix, brand: Brand) =>
  Schema.String.check(Schema.isStartsWith(prefix)).pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )

export const RunID = brandedID("run_", "AgentRuntime.RunID")
export type RunID = typeof RunID.Type
export const StepID = brandedID("stp_", "AgentRuntime.StepID")
export type StepID = typeof StepID.Type
export const ActionID = brandedID("act_", "AgentRuntime.ActionID")
export type ActionID = typeof ActionID.Type
export const MutationTransactionID = brandedID("mut_", "AgentRuntime.MutationTransactionID")
export type MutationTransactionID = typeof MutationTransactionID.Type
export const ObservationID = brandedID("obs_", "AgentRuntime.ObservationID")
export type ObservationID = typeof ObservationID.Type
export const EvidenceID = brandedID("evd_", "AgentRuntime.EvidenceID")
export type EvidenceID = typeof EvidenceID.Type
export const ArtifactID = brandedID("art_", "AgentRuntime.ArtifactID")
export type ArtifactID = typeof ArtifactID.Type
export const CheckpointID = brandedID("chk_", "AgentRuntime.CheckpointID")
export type CheckpointID = typeof CheckpointID.Type
export const LeaseID = brandedID("lea_", "AgentRuntime.LeaseID")
export type LeaseID = typeof LeaseID.Type
export const AuthorizationGrantID = brandedID("grn_", "AgentRuntime.AuthorizationGrantID")
export type AuthorizationGrantID = typeof AuthorizationGrantID.Type
export const ExperienceID = brandedID("exp_", "AgentRuntime.ExperienceID")
export type ExperienceID = typeof ExperienceID.Type
export const EvaluationID = brandedID("eva_", "AgentRuntime.EvaluationID")
export type EvaluationID = typeof EvaluationID.Type
export const EvolutionProposalID = brandedID("evo_", "AgentRuntime.EvolutionProposalID")
export type EvolutionProposalID = typeof EvolutionProposalID.Type

/**
 * Canonical business-task identity. The current durable authority remains
 * TaskGraph; this alias prevents Run contracts from naming the product
 * adapter instead of the AgentRuntime concept without changing the wire ID.
 */
export const TaskID = TaskGraph.ID
export type TaskID = TaskGraph.ID

export const Initiator = Schema.Literals(["user", "agent", "schedule", "trigger", "recovery", "evolution"]).annotate({
  identifier: "AgentRuntime.Initiator",
})
export type Initiator = typeof Initiator.Type

/**
 * Control-plane approval actor. A1 opens exactly one actor: the local user.
 * No other actor value can be constructed.
 */
export const ControlPlaneActor = Schema.Literal("user").annotate({
  identifier: "AgentRuntime.ControlPlaneActor",
})
export type ControlPlaneActor = typeof ControlPlaneActor.Type

/**
 * First-class control-plane subject identity. Independent of the chat Session
 * model: its ID brand is distinct from SessionID and it must never be stored
 * in a sessionID field. All fields are required so a subject missing
 * location, project, actor, principal, or request identity cannot be
 * constructed.
 */
export const ControlPlaneID = brandedID("ctl_", "AgentRuntime.ControlPlaneID")
export type ControlPlaneID = typeof ControlPlaneID.Type

/** Per-request identity of one control-plane action; a fresh request mints a fresh identity. */
export const ControlPlaneRequestID = brandedID("cpr_", "AgentRuntime.ControlPlaneRequestID")
export type ControlPlaneRequestID = typeof ControlPlaneRequestID.Type

/** Opaque server-derived identity for the authenticated control principal. */
export const ControlPrincipalRef = brandedID("prn_", "AgentRuntime.ControlPrincipalRef")
export type ControlPrincipalRef = typeof ControlPrincipalRef.Type

/**
 * Server-owned identity of one durable control-plane operation.  The server
 * derives this from its canonical binding and the durable run derives its
 * deterministic aggregate ID from it.  A renderer request ID is deliberately
 * not a replacement for this identity.
 */
export const ControlOperationID = brandedID("cop_", "AgentRuntime.ControlOperationID")
export type ControlOperationID = typeof ControlOperationID.Type

export const ControlPlaneSubject = Schema.Struct({
  type: Schema.Literal("control-plane"),
  id: ControlPlaneID,
  location: AbsolutePath,
  project: Project.ID,
  actor: ControlPlaneActor,
  principalRef: ControlPrincipalRef,
  requestID: ControlPlaneRequestID,
}).annotate({ identifier: "AgentRuntime.ControlPlaneSubject" })
export interface ControlPlaneSubject extends Schema.Schema.Type<typeof ControlPlaneSubject> {}

/**
 * Session subject: the existing real chat identity tuple. The branded values
 * are plain string-typed here (like AuthorizationGrant's legacy fields) so
 * the contract stays usable by both the gateway and permission layers.
 */
export const SessionSubject = Schema.Struct({
  type: Schema.Literal("session"),
  sessionID: SessionID,
  agent: Schema.String,
  assistantMessageID: Schema.String,
  toolCallID: Schema.String,
}).annotate({ identifier: "AgentRuntime.SessionSubject" })
export interface SessionSubject extends Schema.Schema.Type<typeof SessionSubject> {}

/**
 * Discriminated authorization subject. A value is either a real chat session
 * subject or a control-plane subject; the two must never be conflated. A
 * record that carries both a control-plane subject and a sessionID field is
 * contradictory and every resolution path must fail closed.
 */
export const Subject = Schema.Union([SessionSubject, ControlPlaneSubject]).annotate({
  identifier: "AgentRuntime.Subject",
})
export type Subject = typeof Subject.Type

export const Authority = Schema.Literals(["automatic", "scoped_grant", "human", "forbidden"]).annotate({
  identifier: "AgentRuntime.Authority",
})
export type Authority = typeof Authority.Type

export const RiskTier = Schema.Literals(["L0", "L1", "L2", "L3", "L4"]).annotate({
  identifier: "AgentRuntime.RiskTier",
})
export type RiskTier = typeof RiskTier.Type

export const Visibility = Schema.Literals(["summary", "details", "audit"]).annotate({
  identifier: "AgentRuntime.Visibility",
})
export type Visibility = typeof Visibility.Type

/** Backward-compatible token ceiling used when an older run omitted tokens. */
export const DEFAULT_MAX_TOKENS = 1_000_000

export const Budget = Schema.Struct({
  maxAttempts: NonNegativeInt,
  maxDurationMs: NonNegativeInt,
  maxCostMicros: NonNegativeInt,
  maxTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_MAX_TOKENS))),
  attemptsUsed: NonNegativeInt,
  durationMsUsed: NonNegativeInt,
  costMicrosUsed: NonNegativeInt,
  tokensUsed: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
}).annotate({ identifier: "AgentRuntime.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

/**
 * Cumulative provider usage captured immediately before a durable attempt.
 * Keeping this on the attempt-start event makes crash recovery able to
 * settle usage that was persisted by the session projector before the worker
 * disappeared.
 */
export const RunUsageBaseline = Schema.Struct({
  costMicros: NonNegativeInt,
  tokens: NonNegativeInt,
}).annotate({ identifier: "AgentRuntime.RunUsageBaseline" })
export interface RunUsageBaseline extends Schema.Schema.Type<typeof RunUsageBaseline> {}

export const EffectSemantics = Schema.Struct({
  riskTier: RiskTier,
  authority: Authority,
  idempotency: Schema.Literals(["idempotent", "conditional", "non_idempotent"]),
  retryability: Schema.Literals(["safe", "guarded", "never"]),
  reversibility: Schema.Literals(["not_applicable", "reversible", "compensatable", "irreversible"]),
  filesystemScope: Schema.Array(Schema.String),
  networkScope: Schema.Array(Schema.String),
  secretScope: Schema.Array(Schema.String),
  externalServices: Schema.Array(Schema.String),
  compensation: Schema.String.pipe(optional),
  expectedArtifacts: Schema.Array(Schema.String),
  successCriteria: Schema.Array(Schema.String),
}).annotate({ identifier: "AgentRuntime.EffectSemantics" })
export interface EffectSemantics extends Schema.Schema.Type<typeof EffectSemantics> {}

/** A bounded amount reserved or consumed by a child run. */
export const ChildBudgetAmount = Schema.Struct({
  attempts: NonNegativeInt,
  durationMs: NonNegativeInt,
  costMicros: NonNegativeInt,
  tokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
}).annotate({ identifier: "AgentRuntime.ChildBudgetAmount" })
export interface ChildBudgetAmount extends Schema.Schema.Type<typeof ChildBudgetAmount> {}

/**
 * The only capability shape a child run may receive.  `access` is explicit so
 * a read-only grant can never be interpreted as permission to perform a write.
 */
export const ChildCapability = Schema.Struct({
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  access: Schema.Literals(["read", "write"]),
}).annotate({ identifier: "AgentRuntime.ChildCapability" })
export interface ChildCapability extends Schema.Schema.Type<typeof ChildCapability> {}

export const ChildExpectedDeliverable = Schema.Struct({
  summaryRequired: Schema.Boolean,
  artifactKinds: Schema.Array(Schema.String),
  evidenceKinds: Schema.Array(Schema.String),
  verifier: Schema.String.pipe(optional),
}).annotate({ identifier: "AgentRuntime.ChildExpectedDeliverable" })
export interface ChildExpectedDeliverable extends Schema.Schema.Type<typeof ChildExpectedDeliverable> {}

/**
 * Payload-free admission evidence captured when a project custom-agent enters
 * the provider-neutral child path.  This is intentionally metadata only: the
 * profile prompt, tool arguments, credentials and lease owner never become a
 * durable child binding.  The evidence refs point at the existing Evidence
 * owner; the child result/parent budget events remain the settlement owner.
 */
const CustomAgentAdmissionDescriptorDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i))
export const CustomAgentAdmissionEvidence = Schema.Struct({
  schema_version: Schema.Literal(1),
  kind: Schema.Literal("custom-agent-admission"),
  role: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(160)),
  profile_path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  status: Schema.Literals(["admitted", "opt_in_required", "workspace_untrusted", "unsupported_tools", "collision"]),
  decision: Schema.Literals(["admitted", "blocked"]),
  reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  ready: Schema.Boolean,
  descriptor_digest: CustomAgentAdmissionDescriptorDigest.pipe(optional),
  checks: Schema.Struct({
    status_consistent: Schema.Boolean,
    descriptor_digest_consistent: Schema.Boolean,
    tool_projection_consistent: Schema.Boolean,
    payload_free: Schema.Boolean,
  }),
  declared_tool_count: NonNegativeInt,
  canonical_tool_count: NonNegativeInt,
  unsupported_tool_count: NonNegativeInt,
  valid: Schema.Boolean,
  violations: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(8)),
}).annotate({ identifier: "AgentRuntime.CustomAgentAdmissionEvidence" })
export interface CustomAgentAdmissionEvidence extends Schema.Schema.Type<typeof CustomAgentAdmissionEvidence> {}

/**
 * Immutable binding between admission evidence and the existing evidence
 * store.  A child may carry this only for a successful, admitted profile;
 * actual budget/result settlement is still represented by ChildRunResult and
 * ChildRunBudgetSettled rather than a second child state machine.
 */
export const ChildRuntimeAdmission = Schema.Struct({
  evidence: CustomAgentAdmissionEvidence,
  evidenceRefs: Schema.Array(EvidenceID).check(Schema.isMaxLength(32)),
}).annotate({ identifier: "AgentRuntime.ChildRuntimeAdmission" })
export interface ChildRuntimeAdmission extends Schema.Schema.Type<typeof ChildRuntimeAdmission> {}

/** Immutable delegation contract captured by the child-created event. */
export const ChildRunBinding = Schema.Struct({
  version: Schema.Literal(1),
  parentRunID: RunID,
  idempotencyKey: Schema.String,
  /** Optional digest of a profile/runtime descriptor; absent on legacy children. */
  runtimeDescriptorDigest: Schema.String.pipe(optional),
  /** Optional payload-free custom-agent admission evidence; absent on legacy children. */
  runtimeAdmission: ChildRuntimeAdmission.pipe(optional),
  delegatedObjective: Schema.String,
  allowedCapabilities: Schema.Array(ChildCapability),
  project: Project.ID,
  location: AbsolutePath,
  expectedDeliverable: ChildExpectedDeliverable,
  deadlineAt: DateTimeUtcFromMillis.pipe(optional),
  depth: NonNegativeInt,
}).annotate({ identifier: "AgentRuntime.ChildRunBinding" })
export interface ChildRunBinding extends Schema.Schema.Type<typeof ChildRunBinding> {}

/** Safe, durable receipt for one terminal child result. */
export const ChildRunResult = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  resultDigest: Schema.String,
  summary: Schema.String,
  artifactRefs: Schema.Array(ArtifactID),
  evidenceRefs: Schema.Array(EvidenceID),
  usage: ChildBudgetAmount,
  recordedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.ChildRunResult" })
export interface ChildRunResult extends Schema.Schema.Type<typeof ChildRunResult> {}

export const RunStatus = Schema.Literals([
  "draft",
  "preflight",
  "awaiting_authorization",
  "queued",
  "running",
  "paused",
  "recovering",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]).annotate({ identifier: "AgentRuntime.RunStatus" })
export type RunStatus = typeof RunStatus.Type

export const ActionStatus = Schema.Literals([
  "proposed",
  "policy_evaluated",
  "awaiting_approval",
  "authorized",
  "executing",
  "observed",
  "verifying",
  "settled",
  "compensating",
  "blocked",
  "cancelled",
]).annotate({ identifier: "AgentRuntime.ActionStatus" })
export type ActionStatus = typeof ActionStatus.Type

export const TaskStatus = TaskGraph.Status.annotate({ identifier: "AgentRuntime.TaskStatus" })
export type TaskStatus = typeof TaskStatus.Type

const Common = {
  initiator: Initiator,
  authority: Authority,
  riskTier: RiskTier,
  reasonSummary: Schema.String,
  budget: Budget,
  traceID: Schema.String,
  parentTraceID: Schema.String.pipe(optional),
  visibility: Visibility,
}

/**
 * A Task is the business objective being pursued. Planning graph fields,
 * ownership, and dependency edges remain TaskGraph projections; execution
 * state belongs to Run/Step and is never duplicated here.
 */
export const Task = Schema.Struct({
  id: TaskID,
  sessionID: SessionID,
  objective: TaskGraph.Title,
  status: TaskStatus,
  revision: PositiveInt,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "AgentRuntime.Task" })
export interface Task extends Schema.Schema.Type<typeof Task> {}

/** Immutable, non-secret recovery constraints of the original root Runner. */
export const SessionRunAdmission = Schema.Struct({
  version: Schema.Literal(1),
  owner: Schema.Literal("session-runner"),
  credentialIDs: Schema.NullOr(Schema.Array(Credential.ID)),
  billing: Schema.NullOr(Schema.Struct({ budget: Billing.Budget, estimatorID: Schema.NonEmptyString })),
  /** Original caller/input identity, never permission to reconstruct credentials. */
  personalJob: Schema.Struct({ jobID: PersonalJobInput.ID, occurrence: PersonalJobInput.Occurrence }).pipe(optional),
}).annotate({ identifier: "AgentRuntime.SessionRunAdmission" })
export interface SessionRunAdmission extends Schema.Schema.Type<typeof SessionRunAdmission> {}

/** Existing @1 histories remain valid; admission is absent in older records. */
export const SessionRun = Schema.Struct({
  id: RunID,
  sessionID: SessionID,
  goalID: Goal.ID.pipe(optional),
  taskID: TaskID.pipe(optional),
  project: Project.ID.pipe(optional),
  location: AbsolutePath.pipe(optional),
  status: RunStatus,
  admission: SessionRunAdmission.pipe(optional),
  /** Root runs may explicitly declare what they are allowed to delegate. */
  delegableCapabilities: Schema.Array(ChildCapability).pipe(optional),
  /** Present only for a child SessionRun; absent on legacy/root runs. */
  child: ChildRunBinding.pipe(optional),
  childResult: ChildRunResult.pipe(optional),
  childBudgetReserved: ChildBudgetAmount.pipe(optional),
  ...Common,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    finished: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "AgentRuntime.SessionRun" })
export interface SessionRun extends Schema.Schema.Type<typeof SessionRun> {}

/**
 * Immutable envelope captured before a control-plane action can ask for
 * approval. `payload` is deliberately JSON only: the operation-specific
 * server codec owns its structure, but a mutable closure, host object, or
 * renderer-local value can never become recovery state. `payloadDigest` and
 * `inputDigest` are both re-checked by the coordinator before execution.
 */
export const ControlOperationSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  id: ControlOperationID,
  kind: Schema.String,
  /** Monotonic generation of this canonical control binding. */
  generation: NonNegativeInt,
  /** Policy revision evaluated during preflight; recovery must re-preflight on change. */
  policyVersion: Schema.String,
  /**
   * Request-independent canonical operation binding. Claim indexes use it to
   * deduplicate one active generation without conflating approval identities.
   */
  claimDigest: Schema.String,
  /** Exact gateway intent digest, including request, run, policy, and authorization scope. */
  authorizationDigest: Schema.String,
  inputDigest: Schema.String,
  actionID: ActionID,
  resources: Schema.Array(Schema.String),
  semantics: EffectSemantics,
  payload: Schema.Json,
  payloadDigest: Schema.String,
}).annotate({ identifier: "AgentRuntime.ControlOperationSnapshot" })
export interface ControlOperationSnapshot extends Schema.Schema.Type<typeof ControlOperationSnapshot> {}

/**
 * A control-plane run is independent of chat Session identity. It carries a
 * frozen, versioned operation snapshot from its first durable event, so a
 * restart must resume the originally reviewed preflight rather than inspect a
 * changed worktree and silently ask or execute a different action.
 */
export const ControlRun = Schema.Struct({
  id: RunID,
  subject: ControlPlaneSubject,
  operation: ControlOperationSnapshot,
  goalID: Goal.ID.pipe(optional),
  taskID: TaskID.pipe(optional),
  status: RunStatus,
  ...Common,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    finished: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "AgentRuntime.ControlRun" })
export interface ControlRun extends Schema.Schema.Type<typeof ControlRun> {}

/** A durable execution run has exactly one identity family. */
export const Run = Schema.Union([SessionRun, ControlRun], { mode: "oneOf" }).annotate({
  identifier: "AgentRuntime.Run",
})
export type Run = typeof Run.Type

export const Step = Schema.Struct({
  id: StepID,
  runID: RunID,
  title: Schema.String,
  status: RunStatus,
  sequence: NonNegativeInt,
  checkpointID: CheckpointID.pipe(optional),
  ...Common,
}).annotate({ identifier: "AgentRuntime.Step" })
export interface Step extends Schema.Schema.Type<typeof Step> {}

export const PermissionRequest = Schema.Struct({
  action: Schema.String,
  resources: Schema.Array(Schema.String),
}).annotate({ identifier: "AgentRuntime.PermissionRequest" })
export interface PermissionRequest extends Schema.Schema.Type<typeof PermissionRequest> {}

const ActionCommon = {
  id: ActionID,
  runID: RunID.pipe(optional),
  stepID: StepID.pipe(optional),
  parentActionID: ActionID.pipe(optional),
  name: Schema.String,
  status: ActionStatus,
  semantics: EffectSemantics,
  resources: Schema.Array(Schema.String),
  idempotencyKey: Schema.String,
  /**
   * Canonical intent fingerprint of the tool call (name, canonical request
   * set, effect semantics, identity, and policy version). Recovery fails
   * closed when a presented actionID carries a different intent.
   */
  intentDigest: Schema.String.pipe(optional),
  /** Original decoded input binding; absent only on older action proposals. */
  inputDigest: Schema.String.pipe(optional),
  ...Common,
  time: Schema.Struct({ created: DateTimeUtcFromMillis, updated: DateTimeUtcFromMillis }),
}

/**
 * Session action: the existing real chat-session action shape with its
 * original required sessionID field and reading semantics. Legacy stored
 * actions (without a subject) decode unchanged; new session actions also
 * carry the matching session subject.
 */
export const SessionAction = Schema.Struct({
  ...ActionCommon,
  sessionID: SessionID,
  subject: Subject.pipe(optional),
}).check(Schema.makeFilter((action) => action.subject === undefined || action.subject.type === "session"))
export interface SessionAction extends Schema.Schema.Type<typeof SessionAction> {}

/**
 * Control-plane action: only the control-plane subject; a sessionID field
 * can never appear in this variant.
 */
export const ControlAction = Schema.Struct({
  ...ActionCommon,
  subject: ControlPlaneSubject,
}).annotate({ identifier: "AgentRuntime.ControlAction" })
export interface ControlAction extends Schema.Schema.Type<typeof ControlAction> {}

export const Action = Schema.Union([SessionAction, ControlAction], { mode: "oneOf" }).annotate({
  identifier: "AgentRuntime.Action",
})
export type Action = typeof Action.Type

export const ActionOutputMaxBytes = 1024 * 1024
/** Existing managed-store import ceiling, shared with durable result receipts. */
export const ManagedArtifactMaxBytes = 50 * 1024 * 1024
const InlineActionOutput = Schema.Struct({
  encoding: Schema.Literal("json"),
  value: Schema.Unknown,
  digest: Schema.String,
  byteLength: NonNegativeInt.check(Schema.isLessThanOrEqualTo(ActionOutputMaxBytes)),
})
const ArtifactActionOutput = Schema.Struct({
  encoding: Schema.Literal("artifact"),
  value: Schema.suspend(() => OpaqueArtifactRef),
  digest: Schema.String,
  byteLength: NonNegativeInt.check(Schema.isLessThanOrEqualTo(ManagedArtifactMaxBytes)),
})
export const ActionOutput = Schema.Union([InlineActionOutput, ArtifactActionOutput], { mode: "oneOf" }).annotate({
  identifier: "AgentRuntime.ActionOutput",
})
export type ActionOutput = typeof ActionOutput.Type

export const Observation = Schema.Struct({
  id: ObservationID,
  actionID: ActionID,
  status: Schema.Literals(["succeeded", "failed", "interrupted"]),
  summary: Schema.String,
  outputDigest: Schema.String.pipe(optional),
  output: ActionOutput.pipe(optional),
  artifactIDs: Schema.Array(ArtifactID),
  observedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.Observation" })
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

/** Append-only presentation processing; never replaces the effect Observation. */
/** Reserved frozen-intent resource: a final result requires a confirmed projection receipt. */
export const ActionPostProcessingResource = "postprocessing:projection"
export const ActionPostProcessing = Schema.Struct({
  observationID: ObservationID,
  state: Schema.Literals(["started", "completed", "failed", "interrupted"]),
  output: ActionOutput.pipe(optional),
  recordedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.ActionPostProcessing" })
export interface ActionPostProcessing extends Schema.Schema.Type<typeof ActionPostProcessing> {}

/**
 * A read-only external-state observation bound to one durable Action intent.
 * Reconciliation never authorizes a second side effect; the literal false is
 * part of the durable contract so a forged writer cannot turn evidence into a
 * retry capability during replay.
 */
export const ActionReconciliation = Schema.Struct({
  actionID: ActionID,
  intentDigest: Schema.String,
  idempotencyKey: Schema.String,
  state: Schema.Literals(["known_success", "known_failure", "unknown"]),
  evidenceDigest: Schema.String,
  source: Schema.String,
  observedAt: DateTimeUtcFromMillis,
  summary: Schema.String.pipe(optional),
  automaticRetryAllowed: Schema.Literal(false),
}).annotate({ identifier: "AgentRuntime.ActionReconciliation" })
export interface ActionReconciliation extends Schema.Schema.Type<typeof ActionReconciliation> {}

/**
 * Bounded, metadata-only progress for one durable Action attempt.  Progress
 * is deliberately separate from ActionStatus: an operation may report a
 * fetching/planning/commit phase while the durable aggregate is still
 * executing, and the final ActionObserved/ActionStateChanged events remain
 * the authority for outcome and retry semantics.
 */
export const ActionProgressPhase = Schema.Literals([
  "executing",
  "fetching",
  "planning",
  "prepared",
  "committing",
  "committed",
  "settled",
  "failed",
  "cancelled",
  "outcome_unknown",
])
export type ActionProgressPhase = typeof ActionProgressPhase.Type

const ActionProgressDetail = Schema.String.check(Schema.isMaxLength(240), Schema.isPattern(/^[^\u0000-\u001f\u007f]*$/))

/** Update supplied by an operation; Core assigns sequence and timestamp. */
export const ActionProgressUpdate = Schema.Struct({
  phase: ActionProgressPhase,
  completed: NonNegativeInt,
  total: NonNegativeInt,
  detail: ActionProgressDetail.pipe(optional),
})
export interface ActionProgressUpdate extends Schema.Schema.Type<typeof ActionProgressUpdate> {}

/** Durable progress record appended to the same Action/EventV2 aggregate. */
export const ActionProgress = Schema.Struct({
  phase: ActionProgressPhase,
  completed: NonNegativeInt,
  total: NonNegativeInt,
  sequence: NonNegativeInt,
  updatedAt: DateTimeUtcFromMillis,
  detail: ActionProgressDetail.pipe(optional),
})
export interface ActionProgress extends Schema.Schema.Type<typeof ActionProgress> {}

/**
 * A content-free reference to an operation created by an external protocol.
 *
 * The binding is deliberately narrower than an external result: it records
 * only the provider identity, operation kind and server-issued reference
 * needed for a later read-only lookup. Result bodies, request arguments and
 * credentials never become part of this durable contract.
 */
const ExternalOperationText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(160),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
)
const ExternalOperationTaskID = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(160),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
)

export const ActionExternalOperationBinding = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("mcp_task"),
  server: ExternalOperationText,
  operation: ExternalOperationText,
  taskID: ExternalOperationTaskID,
  boundAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.ActionExternalOperationBinding" })
export interface ActionExternalOperationBinding extends Schema.Schema.Type<typeof ActionExternalOperationBinding> {}

const MutationDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const MutationTarget = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
)

/** Immutable reference to inverse bytes held outside the workspace. */
export const MutationRollbackArtifact = Schema.Struct({
  version: Schema.Literal(1),
  artifactID: Schema.String.check(Schema.isPattern(/^rollback-[a-f0-9]{64}$/)),
  digest: MutationDigest,
  byteLength: NonNegativeInt,
}).annotate({ identifier: "AgentRuntime.MutationRollbackArtifact" })
export interface MutationRollbackArtifact extends Schema.Schema.Type<typeof MutationRollbackArtifact> {}
const MutationSummary = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
)

/** A durable, content-free description of one file mutation transaction. */
export const MutationIntentEntry = Schema.Struct({
  target: MutationTarget,
  operation: Schema.Literals(["create", "write", "remove"]),
  beforeDigest: MutationDigest.pipe(optional),
  afterDigest: MutationDigest.pipe(optional),
  afterByteLength: NonNegativeInt.pipe(optional),
  /** Profile-owned inverse bytes, never embedded in the durable event. */
  rollbackArtifact: MutationRollbackArtifact.pipe(optional),
  /** How a recovery worker may classify the inverse without holding file bytes. */
  recovery: Schema.Literals([
    "remove-if-matching",
    "restore-from-volatile-journal",
    "restore-from-artifact",
    "manual-review",
  ]),
}).annotate({ identifier: "AgentRuntime.MutationIntentEntry" })
export interface MutationIntentEntry extends Schema.Schema.Type<typeof MutationIntentEntry> {}

export const MutationIntentPhase = Schema.Literals([
  "prepared",
  "committed",
  "postprocessing",
  "settled",
  "rollback_required",
  "rolled_back",
  "rollback_blocked",
  "outcome_unknown",
]).annotate({ identifier: "AgentRuntime.MutationIntentPhase" })
export type MutationIntentPhase = typeof MutationIntentPhase.Type

/**
 * Durable side-effect checkpoints for a file mutation transaction.
 *
 * The checkpoint is deliberately metadata-only: it records which adapter
 * stage was entered/completed and, when applicable, the relative workspace
 * target.  It never stores file bytes, formatter output, diagnostics, or
 * provider/tool arguments.  A trailing `started` checkpoint is valid and is
 * the evidence used after a hard process stop to distinguish an in-flight
 * side effect from a completed one.
 */
export const MutationPostProcessingStage = Schema.Literals([
  "formatter",
  "bom",
  "lsp_touch",
  "diagnostics",
  "event_v2",
  "watcher",
]).annotate({ identifier: "AgentRuntime.MutationPostProcessingStage" })
export type MutationPostProcessingStage = typeof MutationPostProcessingStage.Type

export const MutationPostProcessingStatus = Schema.Literals(["started", "completed"]).annotate({
  identifier: "AgentRuntime.MutationPostProcessingStatus",
})
export type MutationPostProcessingStatus = typeof MutationPostProcessingStatus.Type

export const MutationPostProcessingCheckpoint = Schema.Struct({
  /** Contiguous zero-based sequence; it prevents in-place checkpoint rewrites. */
  sequence: NonNegativeInt,
  stage: MutationPostProcessingStage,
  status: MutationPostProcessingStatus,
  /** Relative workspace resource; omitted for transaction-wide diagnostics. */
  target: Schema.String.check(Schema.isMaxLength(4_096)).pipe(optional),
}).annotate({ identifier: "AgentRuntime.MutationPostProcessingCheckpoint" })
export interface MutationPostProcessingCheckpoint extends Schema.Schema.Type<typeof MutationPostProcessingCheckpoint> {}

/**
 * Durable mutation intent. It stores only target/version metadata and never
 * stores original or post-mutation file bytes. A restart therefore has enough
 * evidence to classify the transaction, but never enough authority to invent
 * a retry or overwrite a changed file.
 */
export const MutationIntent = Schema.Struct({
  version: Schema.Literal(1),
  transactionID: MutationTransactionID,
  actionID: ActionID,
  intentDigest: Schema.String,
  idempotencyKey: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(160)),
  phase: MutationIntentPhase,
  entries: Schema.Array(MutationIntentEntry).check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  manifestDigest: MutationDigest,
  automaticRetryAllowed: Schema.Literal(false),
  createdAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
  /** Append-only semantic checkpoints for formatter/BOM/LSP/event side effects. */
  postProcessing: Schema.Array(MutationPostProcessingCheckpoint).check(Schema.isMaxLength(4_096)).pipe(optional),
  summary: MutationSummary.pipe(optional),
}).annotate({ identifier: "AgentRuntime.MutationIntent" })
export interface MutationIntent extends Schema.Schema.Type<typeof MutationIntent> {}

export const Evidence = Schema.Struct({
  id: EvidenceID,
  /** Legacy field retained as the canonical sourceID wire slot. */
  source: Schema.String,
  sourceDigest: Schema.String,
  trust: Schema.Literals(["trusted", "verified", "untrusted", "hostile"]),
  instructionAllowed: Schema.Boolean,
  summary: Schema.String.check(Schema.isMaxLength(2_000)),
  capturedAt: DateTimeUtcFromMillis,
  /** The digest of extracted content; sourceDigest remains the compatibility name. */
  contentDigest: Schema.String.pipe(optional),
  artifactDigest: Schema.String.pipe(optional),
  extractionMethod: Schema.String.pipe(optional),
  extractionVersion: Schema.String.pipe(optional),
  observationIDs: Schema.Array(ObservationID).pipe(optional),
  runID: RunID.pipe(optional),
  actionID: ActionID.pipe(optional),
  sensitivity: Schema.Literals(["public", "internal", "confidential", "secret"]).pipe(optional),
  validAt: DateTimeUtcFromMillis.pipe(optional),
  artifactRef: Schema.String.pipe(optional),
  verificationStatus: Schema.Literals(["unverified", "verified", "rejected", "expired"]).pipe(optional),
}).annotate({ identifier: "AgentRuntime.Evidence" })
export interface Evidence extends Schema.Schema.Type<typeof Evidence> {}

export const Artifact = Schema.Struct({
  id: ArtifactID,
  actionID: ActionID,
  kind: Schema.String,
  uri: Schema.String,
  digest: Schema.String,
  reversible: Schema.Boolean,
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.Artifact" })
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

/**
 * Owner identity for an opaque artifact.  The identifier is deliberately a
 * bounded opaque token rather than a filesystem path, URL, or profile
 * directory.  Storage implementations resolve it only inside their own
 * already-authorized namespace.
 */
export const ArtifactOwner = Schema.Struct({
  scope: Schema.Literals(["session", "profile", "tenant"]),
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,160}$/)),
}).annotate({ identifier: "AgentRuntime.ArtifactOwner" })
export interface ArtifactOwner extends Schema.Schema.Type<typeof ArtifactOwner> {}

export const ArtifactRetention = Schema.Struct({
  mode: Schema.Literals(["ephemeral", "session", "durable"]),
  expiresAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "AgentRuntime.ArtifactRetention" })
export interface ArtifactRetention extends Schema.Schema.Type<typeof ArtifactRetention> {}

/**
 * A resolver-owned handle.  It may be persisted and sent over the wire, but
 * it cannot encode a path or URL.  The resolver must still enforce owner and
 * digest checks before reading bytes.
 */
export const ArtifactRetrievalHint = Schema.Struct({
  kind: Schema.Literal("managed"),
  handle: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/)),
}).annotate({ identifier: "AgentRuntime.ArtifactRetrievalHint" })
export interface ArtifactRetrievalHint extends Schema.Schema.Type<typeof ArtifactRetrievalHint> {}

const OpaqueArtifactDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

/**
 * Public/storage-safe artifact receipt.  It contains metadata and a resolver
 * hint only: no path, URI, file bytes, credentials, or provider payload can be
 * represented by this contract.
 */
export const OpaqueArtifactRef = Schema.Struct({
  version: Schema.Literal(1),
  artifactID: ArtifactID,
  kind: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(96)),
  digest: OpaqueArtifactDigest,
  mime: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  sizeBytes: NonNegativeInt,
  owner: ArtifactOwner,
  retention: ArtifactRetention,
  retrievalHint: ArtifactRetrievalHint,
  label: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(240)).pipe(optional),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.OpaqueArtifactRef" })
export interface OpaqueArtifactRef extends Schema.Schema.Type<typeof OpaqueArtifactRef> {}

export const Checkpoint = Schema.Struct({
  id: CheckpointID,
  runID: RunID,
  lastActionID: ActionID.pipe(optional),
  eventSequence: NonNegativeInt,
  stateDigest: Schema.String,
  resumeToken: Schema.String,
  state: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.Checkpoint" })
export interface Checkpoint extends Schema.Schema.Type<typeof Checkpoint> {}

export const RunLease = Schema.Struct({
  id: LeaseID,
  runID: RunID,
  ownerID: Schema.String,
  generation: NonNegativeInt,
  acquiredAt: DateTimeUtcFromMillis,
  heartbeatAt: DateTimeUtcFromMillis,
  expiresAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.RunLease" })
export interface RunLease extends Schema.Schema.Type<typeof RunLease> {}

/** Exclusive, replayable worker lease for a durable action aggregate. */
export const ActionLease = Schema.Struct({
  id: LeaseID,
  actionID: ActionID,
  ownerID: Schema.String,
  generation: NonNegativeInt,
  acquiredAt: DateTimeUtcFromMillis,
  heartbeatAt: DateTimeUtcFromMillis,
  expiresAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.ActionLease" })
export interface ActionLease extends Schema.Schema.Type<typeof ActionLease> {}

export const ExperienceRecord = Schema.Struct({
  id: ExperienceID,
  runID: RunID,
  outcome: Schema.Literals(["success", "failure", "partial"]),
  summary: Schema.String,
  evidenceIDs: Schema.Array(EvidenceID),
  reusable: Schema.Boolean,
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.ExperienceRecord" })
export interface ExperienceRecord extends Schema.Schema.Type<typeof ExperienceRecord> {}

export const PolicyDecision = Schema.Struct({
  actionID: ActionID,
  subject: Subject.pipe(optional),
  authority: Authority,
  riskTier: RiskTier,
  decision: Schema.Literals(["allow", "ask", "deny"]),
  reason: Schema.String,
  policyVersion: Schema.String,
  decidedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.PolicyDecision" })
export interface PolicyDecision extends Schema.Schema.Type<typeof PolicyDecision> {}

const GrantCommon = {
  id: AuthorizationGrantID,
  actionID: ActionID,
  parentActionID: ActionID.pipe(optional),
  parentGrantID: AuthorizationGrantID.pipe(optional),
  runID: RunID.pipe(optional),
  toolName: Schema.String,
  requests: Schema.Array(PermissionRequest),
  authority: Authority,
  riskTier: RiskTier,
  policyVersion: Schema.String,
  bindingDigest: Schema.String,
  proofProvider: Schema.String,
  proof: Schema.String,
  issuedAt: DateTimeUtcFromMillis,
  expiresAt: DateTimeUtcFromMillis,
}

/**
 * Session grant: the existing session-shaped grant with its original
 * required identity fields and reading semantics. Legacy grants (without a
 * subject) decode unchanged; new session grants also carry the matching
 * session subject.
 */
export const SessionGrant = Schema.Struct({
  ...GrantCommon,
  sessionID: SessionID,
  agent: Schema.String,
  assistantMessageID: Schema.String,
  toolCallID: Schema.String,
  subject: Subject.pipe(optional),
}).check(Schema.makeFilter((grant) => grant.subject === undefined || grant.subject.type === "session"))
export interface SessionGrant extends Schema.Schema.Type<typeof SessionGrant> {}

/** Control-plane grant: only the control-plane subject; session identity fields never appear. */
export const ControlGrant = Schema.Struct({
  ...GrantCommon,
  subject: ControlPlaneSubject,
}).annotate({ identifier: "AgentRuntime.ControlGrant" })
export interface ControlGrant extends Schema.Schema.Type<typeof ControlGrant> {}

export const AuthorizationGrant = Schema.Union([SessionGrant, ControlGrant], { mode: "oneOf" }).annotate({
  identifier: "AgentRuntime.AuthorizationGrant",
})
export type AuthorizationGrant = typeof AuthorizationGrant.Type

export const EvaluationResult = Schema.Struct({
  id: EvaluationID,
  baseline: Schema.String,
  candidate: Schema.String,
  sampleSize: NonNegativeInt,
  successDelta: Schema.Finite,
  costDelta: Schema.Finite,
  latencyDelta: Schema.Finite,
  passed: Schema.Boolean,
  evidenceIDs: Schema.Array(EvidenceID),
  evaluatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "AgentRuntime.EvaluationResult" })
export interface EvaluationResult extends Schema.Schema.Type<typeof EvaluationResult> {}

export const EvolutionStatus = Schema.Literals([
  "signal",
  "proposal",
  "candidate",
  "sandbox_evaluation",
  "rejected",
  "eligible",
  "canary",
  "promoted",
  "monitoring",
  "retained",
  "rolled_back",
  "archived",
]).annotate({ identifier: "AgentRuntime.EvolutionStatus" })
export type EvolutionStatus = typeof EvolutionStatus.Type

/**
 * Evolution capability levels are distinct from ActionGateway risk tiers.
 * L5 is represented so attempts can be rejected deterministically; it is
 * never an executable capability.
 */
export const EvolutionLevel = Schema.Literals(["L0", "L1", "L2", "L3", "L4", "L5"]).annotate({
  identifier: "AgentRuntime.EvolutionLevel",
})
export type EvolutionLevel = typeof EvolutionLevel.Type

/** Canonical proposal envelope. Existing strategy candidates are adapted into this shape at the runtime boundary. */
export const EvolutionProposal = Schema.Struct({
  id: EvolutionProposalID,
  sourceExperienceIDs: Schema.Array(ExperienceID),
  candidateKind: Schema.Literals(["skill", "prompt", "router", "workflow", "code"]),
  evolutionLevel: EvolutionLevel,
  target: Schema.String,
  status: EvolutionStatus,
  candidateDigest: Schema.String,
  baseline: Schema.String,
  evaluationID: EvaluationID.pipe(optional),
  rollbackArtifactID: ArtifactID.pipe(optional),
  constitutionVersion: Schema.String,
  ...Common,
  time: Schema.Struct({ created: DateTimeUtcFromMillis, updated: DateTimeUtcFromMillis }),
}).annotate({ identifier: "AgentRuntime.EvolutionProposal" })
export interface EvolutionProposal extends Schema.Schema.Type<typeof EvolutionProposal> {}

const EvolutionProposalCreated = define({
  type: "agent.evolution.proposal-created",
  durable: { version: 1, aggregate: "proposalID" },
  schema: {
    proposalID: EvolutionProposalID,
    candidateID: Schema.String,
    artifactDigest: Schema.String,
    actor: Schema.String,
    proposal: EvolutionProposal,
  },
})
const EvolutionStatusChanged = define({
  type: "agent.evolution.status-changed",
  durable: { version: 1, aggregate: "proposalID" },
  schema: {
    proposalID: EvolutionProposalID,
    from: EvolutionStatus,
    to: EvolutionStatus,
    revision: NonNegativeInt,
    actor: Schema.String,
    reason: Schema.String,
    metadata: Schema.Record(Schema.String, Schema.Unknown),
  },
})
const EvolutionEvaluationRecorded = define({
  type: "agent.evolution.evaluation-recorded",
  durable: { version: 1, aggregate: "proposalID" },
  schema: {
    proposalID: EvolutionProposalID,
    evaluation: EvaluationResult,
    actor: Schema.String,
  },
})
const EvolutionExposurePrepared = define({
  type: "agent.evolution.exposure-prepared",
  durable: { version: 1, aggregate: "exposureID" },
  schema: {
    exposureID: Schema.String,
    ticketDigest: Schema.String,
    proposalIDs: Schema.Array(EvolutionProposalID),
    actor: Schema.String,
  },
})
const EvolutionExposureOutcomeRecorded = define({
  type: "agent.evolution.exposure-outcome-recorded",
  durable: { version: 1, aggregate: "exposureID" },
  schema: {
    exposureID: Schema.String,
    ticketDigest: Schema.String,
    outcomeDigest: Schema.String,
    success: Schema.Boolean,
    safetyIncident: Schema.Boolean,
    actor: Schema.String,
  },
})
const EvolutionExposureArchived = define({
  type: "agent.evolution.exposure-archived",
  durable: { version: 1, aggregate: "archiveID" },
  schema: {
    archiveID: Schema.String,
    planDigest: Schema.String,
    archivedCount: NonNegativeInt,
    actor: Schema.String,
  },
})
const EvolutionExposureRestored = define({
  type: "agent.evolution.exposure-restored",
  durable: { version: 1, aggregate: "restoreID" },
  schema: {
    restoreID: Schema.String,
    archiveID: Schema.String,
    planDigest: Schema.String,
    restoredCount: NonNegativeInt,
    actor: Schema.String,
  },
})

const ActionProposed = define({
  type: "agent.action.proposed",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    action: Action,
  },
})
const ActionPolicyEvaluated = define({
  type: "agent.action.policy-evaluated",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    decision: PolicyDecision,
  },
})
const ActionAuthorizationGranted = define({
  type: "agent.action.authorization-granted",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    grant: AuthorizationGrant,
  },
})
const ActionStateChanged = define({
  type: "agent.action.state-changed",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    from: ActionStatus,
    to: ActionStatus,
    reason: Schema.String,
    changedAt: DateTimeUtcFromMillis,
  },
})
const ActionObserved = define({
  type: "agent.action.observed",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    observation: Observation,
  },
})
const ActionPostProcessingRecorded = define({
  type: "agent.action.postprocessing-recorded",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    processing: ActionPostProcessing,
  },
})
const ActionReconciled = define({
  type: "agent.action.reconciled",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    reconciliation: ActionReconciliation,
  },
})
const ActionExternalOperationBound = define({
  type: "agent.action.external-operation-bound",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    binding: ActionExternalOperationBinding,
  },
})
const ActionMutationIntentRecorded = define({
  type: "agent.action.mutation-intent-recorded",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    intent: MutationIntent,
  },
})
const ActionProgressRecorded = define({
  type: "agent.action.progress-recorded",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    progress: ActionProgress,
  },
})

/** Exact model request on the existing Action aggregate, not conversation history. */
const ActionModelRequestPrepared = define({
  type: "agent.action.model-request-prepared",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    attempt: PositiveInt,
    leaseID: LeaseID,
    generation: NonNegativeInt,
    envelope: Schema.String.check(Schema.isMaxLength(65_536)),
    recordedAt: DateTimeUtcFromMillis,
  },
})
const ActionAttemptStarted = define({
  type: "agent.action.attempt-started",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    attempt: NonNegativeInt,
    startedAt: DateTimeUtcFromMillis,
  },
})
const ActionAttemptFinished = define({
  type: "agent.action.attempt-finished",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    sessionID: SessionID.pipe(optional),
    subject: Subject.pipe(optional),
    attempt: NonNegativeInt,
    outcome: Schema.Literals(["succeeded", "failed", "interrupted"]),
    durationMs: NonNegativeInt,
    /** Absent means unmeasured, including failed or interrupted external requests. */
    costMicros: NonNegativeInt.pipe(optional),
    /** Omitted for historical or unmetered operations; absence is not a measured zero. */
    tokens: NonNegativeInt.pipe(optional),
    finishedAt: DateTimeUtcFromMillis,
  },
})
const ActionLeaseAcquired = define({
  type: "agent.action.lease-acquired",
  durable: { version: 1, aggregate: "actionID" },
  schema: { actionID: ActionID, lease: ActionLease },
})
const ActionHeartbeatRecorded = define({
  type: "agent.action.heartbeat-recorded",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    leaseID: LeaseID,
    ownerID: Schema.String,
    generation: NonNegativeInt,
    heartbeatAt: DateTimeUtcFromMillis,
    expiresAt: DateTimeUtcFromMillis,
  },
})
const ActionLeaseReleased = define({
  type: "agent.action.lease-released",
  durable: { version: 1, aggregate: "actionID" },
  schema: {
    actionID: ActionID,
    leaseID: LeaseID,
    ownerID: Schema.String,
    generation: NonNegativeInt,
    releasedAt: DateTimeUtcFromMillis,
    reason: Schema.String,
  },
})

const RunCreated = define({
  type: "agent.run.created",
  durable: { version: 1, aggregate: "runID" },
  schema: { runID: RunID, sessionID: SessionID, run: SessionRun, initialLease: RunLease.pipe(optional) },
})
const RunStateChanged = define({
  type: "agent.run.state-changed",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    runID: RunID,
    sessionID: SessionID,
    from: RunStatus,
    to: RunStatus,
    reason: Schema.String,
    changedAt: DateTimeUtcFromMillis,
  },
})
const RunCheckpointCreated = define({
  type: "agent.run.checkpoint-created",
  durable: { version: 1, aggregate: "runID" },
  schema: { runID: RunID, sessionID: SessionID, checkpoint: Checkpoint },
})
const RunAttemptStarted = define({
  type: "agent.run.attempt-started",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    runID: RunID,
    sessionID: SessionID,
    attempt: NonNegativeInt,
    usageBaseline: RunUsageBaseline.pipe(optional),
    startedAt: DateTimeUtcFromMillis,
  },
})
const RunAttemptFinished = define({
  type: "agent.run.attempt-finished",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    runID: RunID,
    sessionID: SessionID,
    attempt: NonNegativeInt,
    outcome: Schema.Literals(["completed", "failed", "interrupted"]),
    durationMs: NonNegativeInt,
    costMicros: NonNegativeInt,
    tokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    finishedAt: DateTimeUtcFromMillis,
  },
})
const RunLeaseAcquired = define({
  type: "agent.run.lease-acquired",
  durable: { version: 1, aggregate: "runID" },
  schema: { runID: RunID, sessionID: SessionID, lease: RunLease },
})
const RunHeartbeatRecorded = define({
  type: "agent.run.heartbeat-recorded",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    runID: RunID,
    sessionID: SessionID,
    leaseID: LeaseID,
    ownerID: Schema.String,
    heartbeatAt: DateTimeUtcFromMillis,
    expiresAt: DateTimeUtcFromMillis,
  },
})
const RunLeaseReleased = define({
  type: "agent.run.lease-released",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    runID: RunID,
    sessionID: SessionID,
    leaseID: LeaseID,
    ownerID: Schema.String,
    releasedAt: DateTimeUtcFromMillis,
    reason: Schema.String,
  },
})

/**
 * Child runs use a separate @1 family.  The created event is the first event
 * of the child aggregate; the budget events live on the parent aggregate so
 * admission remains serialized by the parent's event sequence.
 */
const ChildRunCreated = define({
  type: "agent.child-run.created",
  durable: { version: 1, aggregate: "runID" },
  schema: { runID: RunID, parentRunID: RunID, sessionID: SessionID, run: SessionRun },
})
const ChildRunCancelled = define({
  type: "agent.child-run.cancelled",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    runID: RunID,
    parentRunID: RunID,
    sessionID: SessionID,
    from: RunStatus,
    to: Schema.Literal("cancelled"),
    reason: Schema.String,
    cancelledAt: DateTimeUtcFromMillis,
  },
})
const ChildRunResultRecorded = define({
  type: "agent.child-run.result-recorded",
  durable: { version: 1, aggregate: "runID" },
  schema: { runID: RunID, parentRunID: RunID, sessionID: SessionID, result: ChildRunResult },
})
const ChildSettlementIntentID = Schema.String.check(Schema.isPattern(/^stl_[a-f0-9]{64}$/i))
const ChildSettlementAdmissionEvidence = Schema.Struct({
  evidenceID: EvidenceID,
  recordDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  actionID: ActionID.pipe(optional),
  observationID: ObservationID.pipe(optional),
}).annotate({ identifier: "AgentRuntime.ChildSettlementAdmissionEvidence" })
const ChildRunSettlementIntentRecorded = define({
  type: "agent.child-run.settlement-intent-recorded",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    /** Parent RunID; the intent is serialized by the parent aggregate. */
    runID: RunID,
    sessionID: SessionID,
    childRunID: RunID,
    idempotencyKey: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    intentID: ChildSettlementIntentID,
    idempotencyDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
    result: ChildRunResult,
    admissionEvidence: ChildSettlementAdmissionEvidence.pipe(optional),
    intentAt: DateTimeUtcFromMillis,
  },
})
const ChildRunBudgetReserved = define({
  type: "agent.child-run.budget-reserved",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    /** Parent RunID; this event belongs to the parent aggregate. */
    runID: RunID,
    sessionID: SessionID,
    childRunID: RunID,
    childRun: SessionRun,
    reserved: ChildBudgetAmount,
    reservedTotal: ChildBudgetAmount,
    reservedAt: DateTimeUtcFromMillis,
  },
})
const ChildRunBudgetSettled = define({
  type: "agent.child-run.budget-settled",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    /** Parent RunID; this event belongs to the parent aggregate. */
    runID: RunID,
    sessionID: SessionID,
    childRunID: RunID,
    reserved: ChildBudgetAmount,
    actual: ChildBudgetAmount,
    reservedTotal: ChildBudgetAmount,
    settledAt: DateTimeUtcFromMillis,
  },
})

/**
 * Payload-free settlement observation evidence.  The event belongs to the
 * parent Run aggregate and stores only the redacted sample/checkpoint
 * contract; provider output, prompts and business payloads never cross this
 * schema boundary.
 */
const SettlementObservationDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i))
const SettlementObservationObserverID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,255}$/))
const SettlementObservationTransactionID = Schema.String.check(Schema.isPattern(/^tx_[A-Za-z0-9._:-]{1,255}$/))
const SettlementObservationTransactionKey = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512))
const SettlementObservationOwner = Schema.Literals(["admission-evidence", "child-result", "parent-budget"])
const SettlementObservationSample = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  planDigest: SettlementObservationDigest,
  evidenceDigest: SettlementObservationDigest,
  transactionKey: SettlementObservationTransactionKey,
  transactionID: SettlementObservationTransactionID,
  ownerOrder: Schema.Array(SettlementObservationOwner).check(Schema.isMaxLength(3)),
  ownerCount: Schema.Literal(3),
  outcome: Schema.Literal("committed"),
  providerExecutionAllowed: Schema.Literal(false),
  executionDigest: SettlementObservationDigest,
  observedAtMs: NonNegativeInt,
}).annotate({ identifier: "AgentRuntime.SettlementObservationSample" })
const ChildRunSettlementObservationRecorded = define({
  type: "agent.child-run.settlement-observation-recorded",
  durable: { version: 1, aggregate: "runID" },
  schema: {
    /** Parent RunID; observation evidence is serialized by the parent. */
    runID: RunID,
    sessionID: SessionID,
    childRunID: RunID,
    observerID: SettlementObservationObserverID,
    sampleSequence: PositiveInt,
    minimumSamples: PositiveInt,
    sample: SettlementObservationSample,
    windowDigest: SettlementObservationDigest,
    checkpointDigest: SettlementObservationDigest,
    recordedAt: DateTimeUtcFromMillis,
  },
})

/**
 * Control runs use a dedicated @2 durable family.  Keeping these separate
 * from the session @1 definitions means old session histories retain their
 * exact wire schema while replay can reject accidental cross-family events.
 */
const ControlRunCreated = define({
  type: "agent.control-run.created",
  durable: { version: 2, aggregate: "runID" },
  schema: { runID: RunID, subject: ControlPlaneSubject, run: ControlRun },
})
const ControlRunStateChanged = define({
  type: "agent.control-run.state-changed",
  durable: { version: 2, aggregate: "runID" },
  schema: {
    runID: RunID,
    subject: ControlPlaneSubject,
    from: RunStatus,
    to: RunStatus,
    reason: Schema.String,
    changedAt: DateTimeUtcFromMillis,
  },
})
const ControlRunCheckpointCreated = define({
  type: "agent.control-run.checkpoint-created",
  durable: { version: 2, aggregate: "runID" },
  schema: { runID: RunID, subject: ControlPlaneSubject, checkpoint: Checkpoint },
})
const ControlRunAttemptStarted = define({
  type: "agent.control-run.attempt-started",
  durable: { version: 2, aggregate: "runID" },
  schema: {
    runID: RunID,
    subject: ControlPlaneSubject,
    attempt: NonNegativeInt,
    usageBaseline: RunUsageBaseline.pipe(optional),
    startedAt: DateTimeUtcFromMillis,
  },
})
const ControlRunAttemptFinished = define({
  type: "agent.control-run.attempt-finished",
  durable: { version: 2, aggregate: "runID" },
  schema: {
    runID: RunID,
    subject: ControlPlaneSubject,
    attempt: NonNegativeInt,
    outcome: Schema.Literals(["completed", "failed", "interrupted"]),
    durationMs: NonNegativeInt,
    costMicros: NonNegativeInt,
    tokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    finishedAt: DateTimeUtcFromMillis,
  },
})
const ControlRunLeaseAcquired = define({
  type: "agent.control-run.lease-acquired",
  durable: { version: 2, aggregate: "runID" },
  schema: { runID: RunID, subject: ControlPlaneSubject, lease: RunLease },
})
const ControlRunHeartbeatRecorded = define({
  type: "agent.control-run.heartbeat-recorded",
  durable: { version: 2, aggregate: "runID" },
  schema: {
    runID: RunID,
    subject: ControlPlaneSubject,
    leaseID: LeaseID,
    ownerID: Schema.String,
    generation: NonNegativeInt,
    heartbeatAt: DateTimeUtcFromMillis,
    expiresAt: DateTimeUtcFromMillis,
  },
})
const ControlRunLeaseReleased = define({
  type: "agent.control-run.lease-released",
  durable: { version: 2, aggregate: "runID" },
  schema: {
    runID: RunID,
    subject: ControlPlaneSubject,
    leaseID: LeaseID,
    ownerID: Schema.String,
    generation: NonNegativeInt,
    releasedAt: DateTimeUtcFromMillis,
    reason: Schema.String,
  },
})

/**
 * Subject-aware control-plane pending approval request. Distinct from
 * PermissionV2.Request: it carries the control-plane subject and never a
 * sessionID. A1 resolves it only through the Authorizer by requestID.
 */
export const ControlRequest = Schema.Struct({
  id: Permission.ID,
  subject: ControlPlaneSubject,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
}).annotate({ identifier: "AgentRuntime.ControlRequest" })
export interface ControlRequest extends Schema.Schema.Type<typeof ControlRequest> {}

const ControlAsked = define({
  type: "authorizer.control.asked",
  durable: { version: 1, aggregate: "id" },
  schema: ControlRequest.fields,
})
const ControlReplied = define({
  type: "authorizer.control.replied",
  durable: { version: 1, aggregate: "requestID" },
  schema: {
    subject: ControlPlaneSubject,
    requestID: Permission.ID,
    reply: Schema.Literals(["once", "always", "reject"]),
    message: Schema.String.pipe(optional),
  },
})
export const ControlEvent = {
  Asked: ControlAsked,
  Replied: ControlReplied,
  Definitions: inventory(ControlAsked, ControlReplied),
}

const ActionDefinitions = inventory(
  ActionProposed,
  ActionPolicyEvaluated,
  ActionAuthorizationGranted,
  ActionStateChanged,
  ActionAttemptStarted,
  ActionAttemptFinished,
  ActionObserved,
  ActionPostProcessingRecorded,
  ActionReconciled,
  ActionExternalOperationBound,
  ActionMutationIntentRecorded,
  ActionProgressRecorded,
  ActionModelRequestPrepared,
  ActionLeaseAcquired,
  ActionHeartbeatRecorded,
  ActionLeaseReleased,
)
const RunDefinitions = inventory(
  RunCreated,
  RunStateChanged,
  RunCheckpointCreated,
  RunAttemptStarted,
  RunAttemptFinished,
  RunLeaseAcquired,
  RunHeartbeatRecorded,
  RunLeaseReleased,
  ChildRunCreated,
  ChildRunCancelled,
  ChildRunResultRecorded,
  ChildRunSettlementIntentRecorded,
  ChildRunBudgetReserved,
  ChildRunBudgetSettled,
  ChildRunSettlementObservationRecorded,
  ControlRunCreated,
  ControlRunStateChanged,
  ControlRunCheckpointCreated,
  ControlRunAttemptStarted,
  ControlRunAttemptFinished,
  ControlRunLeaseAcquired,
  ControlRunHeartbeatRecorded,
  ControlRunLeaseReleased,
)
const EvolutionDefinitions = inventory(
  EvolutionProposalCreated,
  EvolutionStatusChanged,
  EvolutionEvaluationRecorded,
  EvolutionExposurePrepared,
  EvolutionExposureOutcomeRecorded,
  EvolutionExposureArchived,
  EvolutionExposureRestored,
)
const ControlDefinitions = ControlEvent.Definitions
export const ActionDurableEvent = Schema.Union(ActionDefinitions, { mode: "oneOf" })
export type ActionDurableEvent = typeof ActionDurableEvent.Type
export const RunDurableEvent = Schema.Union(RunDefinitions, { mode: "oneOf" })
export type RunDurableEvent = typeof RunDurableEvent.Type
export const EvolutionDurableEvent = Schema.Union(EvolutionDefinitions, { mode: "oneOf" })
export type EvolutionDurableEvent = typeof EvolutionDurableEvent.Type
export const ControlDurableEvent = Schema.Union(ControlDefinitions, { mode: "oneOf" })
export type ControlDurableEvent = typeof ControlDurableEvent.Type
export const DurableEvent = Schema.Union(
  [...ControlDefinitions, ...ActionDefinitions, ...RunDefinitions, ...EvolutionDefinitions],
  {
    mode: "oneOf",
  },
)
export type DurableEvent = typeof DurableEvent.Type

export const Event = {
  ActionProposed,
  ActionPolicyEvaluated,
  ActionAuthorizationGranted,
  ActionStateChanged,
  ActionAttemptStarted,
  ActionAttemptFinished,
  ActionObserved,
  ActionPostProcessingRecorded,
  ActionReconciled,
  ActionExternalOperationBound,
  ActionMutationIntentRecorded,
  ActionProgressRecorded,
  ActionModelRequestPrepared,
  ActionLeaseAcquired,
  ActionHeartbeatRecorded,
  ActionLeaseReleased,
  RunCreated,
  RunStateChanged,
  RunCheckpointCreated,
  RunAttemptStarted,
  RunAttemptFinished,
  RunLeaseAcquired,
  RunHeartbeatRecorded,
  RunLeaseReleased,
  ChildRunCreated,
  ChildRunCancelled,
  ChildRunResultRecorded,
  ChildRunSettlementIntentRecorded,
  ChildRunBudgetReserved,
  ChildRunBudgetSettled,
  ChildRunSettlementObservationRecorded,
  ControlRunCreated,
  ControlRunStateChanged,
  ControlRunCheckpointCreated,
  ControlRunAttemptStarted,
  ControlRunAttemptFinished,
  ControlRunLeaseAcquired,
  ControlRunHeartbeatRecorded,
  ControlRunLeaseReleased,
  ActionDefinitions,
  RunDefinitions,
  EvolutionProposalCreated,
  EvolutionStatusChanged,
  EvolutionEvaluationRecorded,
  EvolutionExposurePrepared,
  EvolutionExposureOutcomeRecorded,
  EvolutionExposureArchived,
  EvolutionExposureRestored,
  ControlDefinitions,
  EvolutionDefinitions,
  Definitions: inventory(...ControlDefinitions, ...ActionDefinitions, ...RunDefinitions, ...EvolutionDefinitions),
}
