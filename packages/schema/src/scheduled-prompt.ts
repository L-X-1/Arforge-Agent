export * as ScheduledPrompt from "./scheduled-prompt"

import { Schema } from "effect"
import { descending } from "./identifier"
import { DateTimeUtcFromMillis, optional, PositiveInt, statics } from "./schema"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("sch_")).pipe(
  Schema.brand("ScheduledPromptID"),
  statics((schema) => ({
    create: () => schema.make("sch_" + descending()),
  })),
)
export type ID = typeof ID.Type

export const Name = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
).annotate({ identifier: "ScheduledPromptName" })
export type Name = typeof Name.Type

export const Cron = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(120),
).annotate({
  identifier: "ScheduledPromptCron",
  description: "A bounded five-field local-time cron expression.",
})
export type Cron = typeof Cron.Type

export const Prompt = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(20_000),
).annotate({ identifier: "ScheduledPromptText" })
export type Prompt = typeof Prompt.Type

export const Status = Schema.Literals(["scheduled", "missed", "running", "completed", "failed", "expired"]).annotate({
  identifier: "ScheduledPromptStatus",
})
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  name: Name,
  cron: Cron,
  prompt: Prompt,
  recurring: Schema.Boolean,
  durable: Schema.Boolean,
  enabled: Schema.Boolean,
  status: Status,
  revision: PositiveInt,
  lastError: Schema.String,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    nextRun: DateTimeUtcFromMillis.pipe(optional),
    lastRun: DateTimeUtcFromMillis.pipe(optional),
    expires: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "ScheduledPrompt.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

