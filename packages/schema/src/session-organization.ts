export * as SessionOrganization from "./session-organization"

import { Schema } from "effect"
import { descending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const Tag = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(48),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
).annotate({
  identifier: "SessionTag",
  description: "A display-safe, trimmed session tag of at most 48 characters.",
})
export type Tag = typeof Tag.Type

export const Tags = Schema.Array(Tag).check(Schema.isMaxLength(16)).annotate({ identifier: "SessionTags" })
export type Tags = typeof Tags.Type

export const CheckpointID = Schema.String.check(Schema.isStartsWith("chk_")).pipe(
  Schema.brand("SessionCheckpointID"),
  statics((schema) => ({
    create: () => schema.make("chk_" + descending()),
  })),
)
export type CheckpointID = typeof CheckpointID.Type

export const CheckpointLabel = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(120),
).annotate({ identifier: "SessionCheckpointLabel" })
export type CheckpointLabel = typeof CheckpointLabel.Type

export const Checkpoint = Schema.Struct({
  id: CheckpointID,
  sessionID: SessionID,
  label: CheckpointLabel,
  sequence: NonNegativeInt,
  messageID: SessionMessage.ID.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "SessionCheckpoint" })
export interface Checkpoint extends Schema.Schema.Type<typeof Checkpoint> {}

export const RewindPreview = Schema.Struct({
  checkpoint: Checkpoint,
  affectedMessages: NonNegativeInt,
  expectedLastSequence: NonNegativeInt,
  workspaceEffectsUnchanged: Schema.Literal(true),
}).annotate({ identifier: "SessionRewindPreview" })
export interface RewindPreview extends Schema.Schema.Type<typeof RewindPreview> {}

export const RewindResult = Schema.Struct({
  checkpoint: Checkpoint,
  rewoundMessages: NonNegativeInt,
  lastSequence: NonNegativeInt,
  workspaceEffectsUnchanged: Schema.Literal(true),
}).annotate({ identifier: "SessionRewindResult" })
export interface RewindResult extends Schema.Schema.Type<typeof RewindResult> {}
