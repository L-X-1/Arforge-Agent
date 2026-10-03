// Shared leaf prevents PersonalJob -> AgentRuntime -> PersonalJob cycles.
import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"
import { SessionMessage } from "./session-message"

export const ID = Schema.String.check(Schema.isStartsWith("pjob_")).pipe(
  Schema.brand("PersonalJobID"),
  statics((schema) => ({ create: () => schema.make("pjob_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Digest = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isPattern(/^[a-f0-9]{64}$/i),
).annotate({ identifier: "PersonalJobDigest" })
export type Digest = typeof Digest.Type

/** The same canonical occurrence contract is consumed by the job and its run admission. */
export const Occurrence = Schema.Struct({
  version: Schema.Literal(1),
  messageID: Schema.suspend(() => SessionMessage.ID),
  digest: Digest,
}).annotate({ identifier: "PersonalJob.Occurrence" })
export interface Occurrence extends Schema.Schema.Type<typeof Occurrence> {}
