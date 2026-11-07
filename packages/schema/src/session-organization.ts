export * as SessionOrganization from "./session-organization"

import { Schema } from "effect"
import { descending } from "./identifier"
import { AbsolutePath, DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
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

/** A message target is resolved by the server; callers never supply a boundary sequence. */
const RewindTargetFields = { checkpointID: optional(CheckpointID), messageID: optional(SessionMessage.ID), expectedDirectory: optional(AbsolutePath) }
export const RewindTarget = Schema.Struct(RewindTargetFields).annotate({ identifier: "SessionRewindTarget", description: "Provide exactly one checkpointID or messageID. Message targets require the captured expectedDirectory; the Session owner validates this combination." })
export type RewindTarget = typeof RewindTarget.Type

const RewindRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const RewindApplyInput = Schema.Struct({ ...RewindTargetFields, expectedLastSequence: NonNegativeInt, expectedRevision: optional(RewindRevision) })
  .annotate({ identifier: "SessionRewindApplyInput", description: "Message targets require the source and expectedRevision returned by their read-only preview. No caller boundary sequence is accepted." })
export type RewindApplyInput = typeof RewindApplyInput.Type

export const RewindPreview = Schema.Struct({
  checkpoint: Checkpoint,
  affectedMessages: NonNegativeInt,
  expectedLastSequence: NonNegativeInt,
  expectedRevision: RewindRevision,
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
