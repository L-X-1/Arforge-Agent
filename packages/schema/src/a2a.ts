export * as A2A from "./a2a"

import { Agent } from "./agent"
import { AgentRuntime } from "./agent-runtime"
import { Event as EventDefinition } from "./event"
import { NonNegativeInt, PositiveInt, optional } from "./schema"
import { Schema } from "effect"

const BoundedText = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000))
const ShortText = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i))
const Resources = Schema.Array(ShortText).check(Schema.isMaxLength(32))
const Artifacts = Schema.Array(AgentRuntime.ArtifactID).check(Schema.isMaxLength(64))
const Evidence = Schema.Array(AgentRuntime.EvidenceID).check(Schema.isMaxLength(64))

export const ProtocolVersion = Schema.Literal(1)

export const TaskID = Schema.String.check(Schema.isPattern(/^a2a_task_[a-f0-9]{32}$/i))
export type TaskID = typeof TaskID.Type

export const RequestID = Schema.String.check(Schema.isPattern(/^a2a_req_[a-f0-9]{32}$/i))
export type RequestID = typeof RequestID.Type

export const IdempotencyKey = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128))
export type IdempotencyKey = typeof IdempotencyKey.Type

export const Nonce = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128))
export type Nonce = typeof Nonce.Type

export const Signature = Schema.Struct({
  algorithm: Schema.Literals(["ed25519", "hmac-sha256"]),
  keyID: ShortText,
  payloadDigest: Digest,
  value: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
}).annotate({ identifier: "A2A.Signature" })
export interface Signature extends Schema.Schema.Type<typeof Signature> {}

export const PeerIdentity = Schema.Struct({
  agentID: Agent.ID,
  tenantID: ShortText,
  principalID: ShortText,
  channelID: ShortText,
}).annotate({ identifier: "A2A.PeerIdentity" })
export interface PeerIdentity extends Schema.Schema.Type<typeof PeerIdentity> {}

export const ChannelPolicy = Schema.Struct({
  channelID: ShortText,
  transport: Schema.Literals(["tls", "loopback"]),
  authentication: Schema.Literals(["mtls", "signed"]),
  purpose: Schema.Literal("a2a-private-v1"),
  allowedEgress: Schema.Array(ShortText).check(Schema.isMaxLength(16)),
}).annotate({ identifier: "A2A.ChannelPolicy" })
export interface ChannelPolicy extends Schema.Schema.Type<typeof ChannelPolicy> {}

export const CapabilityReference = Schema.Struct({
  referenceID: Schema.String.check(Schema.isPattern(/^cap_[A-Za-z0-9_-]{1,127}$/)),
  grantDigest: Digest,
  issuer: Agent.ID,
  action: ShortText,
  resources: Resources,
  access: Schema.Literals(["read", "write"]),
  expiresAt: PositiveInt,
}).annotate({ identifier: "A2A.CapabilityReference" })
export interface CapabilityReference extends Schema.Schema.Type<typeof CapabilityReference> {}

export const Budget = Schema.Struct({
  maxAttempts: PositiveInt,
  maxDurationMs: PositiveInt,
  maxCostMicros: NonNegativeInt,
  /** Optional on protocol V1 for backwards-compatible wire replay. */
  maxTokens: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "A2A.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

export const TaskEnvelope = Schema.Struct({
  version: ProtocolVersion,
  taskID: TaskID,
  requestID: RequestID,
  idempotencyKey: IdempotencyKey,
  nonce: Nonce,
  sender: PeerIdentity,
  recipient: PeerIdentity,
  parentRunID: AgentRuntime.RunID,
  objective: BoundedText,
  capability: CapabilityReference,
  budget: Budget,
  deadlineAt: PositiveInt,
  channel: ChannelPolicy,
  signature: Signature,
}).annotate({ identifier: "A2A.TaskEnvelope" })
export interface TaskEnvelope extends Schema.Schema.Type<typeof TaskEnvelope> {}

export const TaskStatus = Schema.Literals([
  "submitted",
  "accepted",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "revoked",
])
export type TaskStatus = typeof TaskStatus.Type

export const StatusEvent = Schema.Struct({
  version: ProtocolVersion,
  taskID: TaskID,
  sequence: PositiveInt,
  status: TaskStatus,
  actor: PeerIdentity,
  summary: BoundedText,
  resultDigest: Digest.pipe(optional),
  artifactRefs: Artifacts,
  evidenceRefs: Evidence,
  createdAt: PositiveInt,
  signature: Signature,
}).annotate({ identifier: "A2A.StatusEvent" })
export interface StatusEvent extends Schema.Schema.Type<typeof StatusEvent> {}

export const StatusStream = Schema.Struct({
  version: ProtocolVersion,
  taskID: TaskID,
  afterSequence: NonNegativeInt,
  nextSequence: NonNegativeInt,
  complete: Schema.Boolean,
  events: Schema.Array(StatusEvent).check(Schema.isMaxLength(100)),
  streamDigest: Digest,
}).annotate({ identifier: "A2A.StatusStream" })
export interface StatusStream extends Schema.Schema.Type<typeof StatusStream> {}

export const ResultVerification = Schema.Struct({
  mode: Schema.Literals(["local-verifier", "trusted-receipt"]),
  verifierID: ShortText,
  evidenceDigest: Digest,
}).annotate({ identifier: "A2A.ResultVerification" })
export interface ResultVerification extends Schema.Schema.Type<typeof ResultVerification> {}

export const Usage = Schema.Struct({
  attempts: NonNegativeInt,
  durationMs: NonNegativeInt,
  costMicros: NonNegativeInt,
  tokens: NonNegativeInt,
}).annotate({ identifier: "A2A.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const ResultReceipt = Schema.Struct({
  version: ProtocolVersion,
  taskID: TaskID,
  requestID: RequestID,
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  resultDigest: Digest,
  summary: BoundedText,
  artifactRefs: Artifacts,
  evidenceRefs: Evidence,
  usage: Usage,
  verification: ResultVerification,
  createdAt: PositiveInt,
  signature: Signature,
}).annotate({ identifier: "A2A.ResultReceipt" })
export interface ResultReceipt extends Schema.Schema.Type<typeof ResultReceipt> {}

export const Accepted = Schema.Struct({
  version: ProtocolVersion,
  taskID: TaskID,
  requestID: RequestID,
  status: Schema.Literal("accepted"),
  replayed: Schema.Boolean,
  statusSequence: PositiveInt,
  receiptDigest: Digest,
  acceptedAt: PositiveInt,
}).annotate({ identifier: "A2A.Accepted" })
export interface Accepted extends Schema.Schema.Type<typeof Accepted> {}

export const CancelRequest = Schema.Struct({
  version: ProtocolVersion,
  taskID: TaskID,
  requestID: RequestID,
  nonce: Nonce,
  actor: PeerIdentity,
  reason: BoundedText,
  channel: ChannelPolicy,
  signature: Signature,
}).annotate({ identifier: "A2A.CancelRequest" })
export interface CancelRequest extends Schema.Schema.Type<typeof CancelRequest> {}

export const RevokeRequest = Schema.Struct({
  version: ProtocolVersion,
  taskID: TaskID,
  requestID: RequestID,
  nonce: Nonce,
  actor: PeerIdentity,
  capabilityGrantDigest: Digest,
  reason: BoundedText,
  channel: ChannelPolicy,
  signature: Signature,
}).annotate({ identifier: "A2A.RevokeRequest" })
export interface RevokeRequest extends Schema.Schema.Type<typeof RevokeRequest> {}

/**
 * Durable A2A task aggregate.  The transport deliberately stores the signed
 * envelope and each signed status/receipt as events instead of relying on a
 * process-local pending map.  A task ID is the aggregate ID; EventV2 supplies
 * the monotonic sequence and crash-safe append boundary.
 */
const TaskAccepted = EventDefinition.define({
  type: "a2a.task.accepted",
  durable: { version: 1, aggregate: "taskID" },
  schema: {
    taskID: TaskID,
    requestID: RequestID,
    envelope: TaskEnvelope,
    childRunID: AgentRuntime.RunID,
    status: StatusEvent,
  },
})

const TaskStatusRecorded = EventDefinition.define({
  type: "a2a.task.status-recorded",
  durable: { version: 1, aggregate: "taskID" },
  schema: {
    taskID: TaskID,
    status: StatusEvent,
  },
})

const TaskResultRecorded = EventDefinition.define({
  type: "a2a.task.result-recorded",
  durable: { version: 1, aggregate: "taskID" },
  schema: {
    taskID: TaskID,
    requestID: RequestID,
    receipt: ResultReceipt,
    status: StatusEvent,
  },
})

const TaskControlApplied = EventDefinition.define({
  type: "a2a.task.control-applied",
  durable: { version: 1, aggregate: "taskID" },
  schema: {
    taskID: TaskID,
    requestID: RequestID,
    kind: Schema.Literals(["cancel", "revoke"]),
    nonce: Nonce,
    requestDigest: Digest,
    status: StatusEvent,
  },
})

/** A channel-scoped nonce claim prevents the same wire nonce crossing tasks. */
const NonceClaimed = EventDefinition.define({
  type: "a2a.nonce.claimed",
  durable: { version: 1, aggregate: "nonceDigest" },
  schema: {
    nonceDigest: Digest,
    nonce: Nonce,
    taskID: TaskID,
    requestID: RequestID,
    envelopeDigest: Digest,
    sender: PeerIdentity,
    recipient: PeerIdentity,
  },
})

export const Event = {
  TaskAccepted,
  TaskStatusRecorded,
  TaskResultRecorded,
  TaskControlApplied,
  NonceClaimed,
  Definitions: EventDefinition.inventory(
    TaskAccepted,
    TaskStatusRecorded,
    TaskResultRecorded,
    TaskControlApplied,
    NonceClaimed,
  ),
} as const

export const DurableEvent = Schema.Union(Event.Definitions, { mode: "oneOf" })
export type DurableEvent = typeof DurableEvent.Type
