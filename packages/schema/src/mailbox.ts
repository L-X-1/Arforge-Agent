export * as Mailbox from "./mailbox"

import { AgentRuntime } from "./agent-runtime"
import { define, inventory } from "./event"
import { Team } from "./team"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { ascending } from "./identifier"
import { Schema } from "effect"

export const ProtocolVersion = Schema.Literal(1)
export type ProtocolVersion = typeof ProtocolVersion.Type

export const MessageID = Schema.String.check(Schema.isStartsWith("mbx_")).pipe(
  Schema.brand("MailboxMessageID"),
  statics((schema) => ({
    create: () => schema.make("mbx_" + ascending()),
  })),
)
export type MessageID = typeof MessageID.Type

export const ReceiptID = Schema.String.check(Schema.isStartsWith("mbr_")).pipe(
  Schema.brand("MailboxReceiptID"),
  statics((schema) => ({
    create: () => schema.make("mbr_" + ascending()),
  })),
)
export type ReceiptID = typeof ReceiptID.Type

export const IdempotencyKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
).annotate({ identifier: "MailboxIdempotencyKey" })
export type IdempotencyKey = typeof IdempotencyKey.Type

export const Kind = Schema.Literals(["request", "response", "result", "event", "error", "cancel"]).annotate({
  identifier: "MailboxMessageKind",
})
export type Kind = typeof Kind.Type

export const MessageStatus = Schema.Literals(["queued", "acknowledged", "rejected", "cancelled"]).annotate({
  identifier: "MailboxMessageStatus",
})
export type MessageStatus = typeof MessageStatus.Type

export const AckStatus = Schema.Literals(["accepted", "rejected", "cancelled"]).annotate({
  identifier: "MailboxAckStatus",
})
export type AckStatus = typeof AckStatus.Type

export const Summary = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)).annotate({
  identifier: "MailboxSummary",
})
export type Summary = typeof Summary.Type

export const Text = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(8_000)).annotate({
  identifier: "MailboxText",
})
export type Text = typeof Text.Type

export const Reason = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(1_000)).annotate({
  identifier: "MailboxReason",
})
export type Reason = typeof Reason.Type

export const Digest = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isPattern(/^[a-f0-9]{64}$/i),
).annotate({ identifier: "MailboxDigest" })
export type Digest = typeof Digest.Type

export const ArtifactRefs = Schema.Array(AgentRuntime.ArtifactID).check(Schema.isMaxLength(32)).annotate({
  identifier: "MailboxArtifactRefs",
})
export const EvidenceRefs = Schema.Array(AgentRuntime.EvidenceID).check(Schema.isMaxLength(32)).annotate({
  identifier: "MailboxEvidenceRefs",
})

/**
 * The mailbox payload deliberately has no capability, tool, or authorization
 * field. A message can point at already-authorized artifacts/evidence, but
 * text received from another agent never grants a new capability.
 */
export const Payload = Schema.Struct({
  summary: Summary,
  text: Text,
  artifactRefs: ArtifactRefs,
  evidenceRefs: EvidenceRefs,
}).annotate({ identifier: "Mailbox.Payload" })
export interface Payload extends Schema.Schema.Type<typeof Payload> {}

export const Message = Schema.Struct({
  version: ProtocolVersion,
  id: MessageID,
  teamID: Team.ID,
  runID: AgentRuntime.RunID,
  taskID: AgentRuntime.TaskID,
  sender: Team.MemberName,
  recipient: Team.MemberName,
  sequence: PositiveInt,
  idempotencyKey: IdempotencyKey,
  kind: Kind,
  payload: Payload,
  digest: Digest,
  status: MessageStatus,
  cancelReason: Reason.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Mailbox.Message" })
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const Receipt = Schema.Struct({
  version: ProtocolVersion,
  id: ReceiptID,
  messageID: MessageID,
  teamID: Team.ID,
  runID: AgentRuntime.RunID,
  taskID: AgentRuntime.TaskID,
  recipient: Team.MemberName,
  status: AckStatus,
  messageDigest: Digest,
  reason: Reason,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Mailbox.Receipt" })
export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}

/**
 * Durable point-in-time delivery state. The receipt is absent while a
 * message is still queued and present after acknowledgement or cancellation.
 */
export const Delivery = Schema.Struct({
  message: Message,
  receipt: Receipt.pipe(optional),
}).annotate({ identifier: "Mailbox.Delivery" })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

export const Inbox = Schema.Struct({
  teamID: Team.ID,
  runID: AgentRuntime.RunID,
  taskID: AgentRuntime.TaskID,
  recipient: Team.MemberName,
  messages: Schema.Array(Message).check(Schema.isMaxLength(100)),
  count: NonNegativeInt,
  lastSequence: NonNegativeInt,
}).annotate({ identifier: "Mailbox.Inbox" })
export interface Inbox extends Schema.Schema.Type<typeof Inbox> {}

const MessageSent = define({ type: "mailbox.message.sent", schema: { message: Message } })
const Acknowledged = define({ type: "mailbox.message.acknowledged", schema: { receipt: Receipt } })
const Cancelled = define({ type: "mailbox.message.cancelled", schema: { message: Message } })

export const Event = {
  MessageSent,
  Acknowledged,
  Cancelled,
  Definitions: inventory(MessageSent, Acknowledged, Cancelled),
}
