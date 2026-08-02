export * as Team from "./team"

import { Schema } from "effect"
import { Agent } from "./agent"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("team_")).pipe(
  Schema.brand("TeamID"),
  statics((schema) => ({
    create: () => schema.make("team_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const MessageID = Schema.String.check(Schema.isStartsWith("tmsg_")).pipe(
  Schema.brand("TeamMessageID"),
  statics((schema) => ({
    create: () => schema.make("tmsg_" + ascending()),
  })),
)
export type MessageID = typeof MessageID.Type

export const ShutdownID = Schema.String.check(Schema.isStartsWith("tsh_")).pipe(
  Schema.brand("TeamShutdownID"),
  statics((schema) => ({
    create: () => schema.make("tsh_" + ascending()),
  })),
)
export type ShutdownID = typeof ShutdownID.Type

export const Name = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)).annotate({
  identifier: "TeamName",
})
export type Name = typeof Name.Type

export const Description = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(1_000)).annotate({
  identifier: "TeamDescription",
})
export type Description = typeof Description.Type

export const MemberName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
).annotate({ identifier: "TeamMemberName" })
export type MemberName = typeof MemberName.Type

export const CollaboratorName = MemberName.check(Schema.isPattern(/^(?!lead$)[A-Za-z][A-Za-z0-9_-]{0,31}$/i)).annotate({
  identifier: "TeamCollaboratorName",
})
export type CollaboratorName = typeof CollaboratorName.Type

export const MemberStatus = Schema.Literals(["active", "shutdown_requested", "stopped"]).annotate({
  identifier: "TeamMemberStatus",
})
export type MemberStatus = typeof MemberStatus.Type

export const MessageKind = Schema.Literals([
  "info",
  "request",
  "result",
  "alert",
  "shutdown_request",
  "shutdown_response",
]).annotate({ identifier: "TeamMessageKind" })
export type MessageKind = typeof MessageKind.Type

export const Summary = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(160)).annotate({
  identifier: "TeamMessageSummary",
})
export type Summary = typeof Summary.Type

export const MessageText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(8_000),
).annotate({ identifier: "TeamMessageText" })
export type MessageText = typeof MessageText.Type

export const ShutdownReason = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(1_000)).annotate({
  identifier: "TeamShutdownReason",
})
export type ShutdownReason = typeof ShutdownReason.Type

export const Member = Schema.Struct({
  name: MemberName,
  agentID: Agent.ID,
  status: MemberStatus,
  revision: PositiveInt,
  time: Schema.Struct({
    joined: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Team.Member" })
export interface Member extends Schema.Schema.Type<typeof Member> {}

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  name: Name,
  description: Description,
  revision: PositiveInt,
  nextSequence: PositiveInt,
  members: Schema.Array(Member),
  memberCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  pendingShutdowns: NonNegativeInt,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Team.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Message = Schema.Struct({
  id: MessageID,
  teamID: ID,
  sequence: PositiveInt,
  sender: MemberName,
  recipient: Schema.String,
  recipients: Schema.Array(MemberName),
  kind: MessageKind,
  summary: Summary,
  message: MessageText,
  shutdownID: ShutdownID.pipe(optional),
  approve: Schema.Boolean.pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}).annotate({ identifier: "Team.Message" })
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const Inbox = Schema.Struct({
  teamID: ID,
  member: MemberName,
  messages: Schema.Array(Message),
  count: NonNegativeInt,
  lastSequence: NonNegativeInt,
}).annotate({ identifier: "Team.Inbox" })
export interface Inbox extends Schema.Schema.Type<typeof Inbox> {}

export const ShutdownStatus = Schema.Literals(["pending", "approved", "rejected"]).annotate({
  identifier: "TeamShutdownStatus",
})
export type ShutdownStatus = typeof ShutdownStatus.Type

export const Shutdown = Schema.Struct({
  id: ShutdownID,
  teamID: ID,
  member: MemberName,
  status: ShutdownStatus,
  reason: ShutdownReason,
  responseReason: ShutdownReason,
  revision: PositiveInt,
  time: Schema.Struct({
    requested: DateTimeUtcFromMillis,
    responded: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Team.Shutdown" })
export interface Shutdown extends Schema.Schema.Type<typeof Shutdown> {}

const Created = define({ type: "team.created", schema: { sessionID: SessionID, team: Info } })
const Updated = define({ type: "team.updated", schema: { sessionID: SessionID, team: Info } })
const Deleted = define({ type: "team.deleted", schema: { sessionID: SessionID, teamID: ID } })
const MessageSent = define({ type: "team.message.sent", schema: { sessionID: SessionID, message: Message } })

export const Event = {
  Created,
  Updated,
  Deleted,
  MessageSent,
  Definitions: inventory(Created, Updated, Deleted, MessageSent),
}
