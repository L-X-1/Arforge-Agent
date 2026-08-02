export * as Goal from "./goal"

import { Schema } from "effect"
import { descending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const ID = Schema.String.check(Schema.isStartsWith("gol_")).pipe(
  Schema.brand("GoalID"),
  statics((schema) => ({
    create: () => schema.make("gol_" + descending()),
  })),
)
export type ID = typeof ID.Type

export const Objective = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(20_000),
).annotate({
  identifier: "GoalObjective",
  description: "A non-empty autonomous goal objective of at most 20,000 characters.",
})
export type Objective = typeof Objective.Type

export const Status = Schema.Literals([
  "queued",
  "active",
  "running",
  "paused",
  "blocked",
  "completed",
  "cancelled",
]).annotate({ identifier: "GoalStatus" })
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  objective: Objective,
  status: Status,
  queuePosition: NonNegativeInt,
  revision: PositiveInt,
  promptID: SessionMessage.ID.pipe(optional),
  lastError: Schema.String,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    finished: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Goal.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Page = Schema.Struct({
  active: Info.pipe(optional),
  queued: Schema.Array(Info),
  history: Schema.Array(Info),
  items: Schema.Array(Info),
}).annotate({ identifier: "Goal.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

const Created = define({
  type: "goal.created",
  schema: {
    sessionID: SessionID,
    goal: Info,
  },
})

const Updated = define({
  type: "goal.updated",
  schema: {
    sessionID: SessionID,
    goal: Info,
  },
})

const Deleted = define({
  type: "goal.deleted",
  schema: {
    sessionID: SessionID,
    goalID: ID,
  },
})

export const Event = {
  Created,
  Updated,
  Deleted,
  Definitions: inventory(Created, Updated, Deleted),
}
