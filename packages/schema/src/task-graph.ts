export * as TaskGraph from "./task-graph"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("tsk_")).pipe(
  Schema.brand("TaskGraphID"),
  statics((schema) => ({
    create: () => schema.make("tsk_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const Title = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(240)).annotate({
  identifier: "TaskGraphTitle",
})
export type Title = typeof Title.Type

export const Description = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(8_000)).annotate({
  identifier: "TaskGraphDescription",
})
export type Description = typeof Description.Type

export const ActiveForm = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(240)).annotate({
  identifier: "TaskGraphActiveForm",
})
export type ActiveForm = typeof ActiveForm.Type

export const Owner = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
).annotate({ identifier: "TaskGraphOwner" })
export type Owner = typeof Owner.Type

export const Metadata = Schema.Record(
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
  Schema.String.check(Schema.isMaxLength(1_000)),
).annotate({ identifier: "TaskGraphMetadata" })
export type Metadata = typeof Metadata.Type

export const Status = Schema.Literals(["pending", "in_progress", "completed", "cancelled"]).annotate({
  identifier: "TaskGraphStatus",
})
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  title: Title,
  description: Description,
  activeForm: ActiveForm,
  status: Status,
  owner: Owner.pipe(optional),
  metadata: Metadata,
  blocks: Schema.Array(ID),
  blockedBy: Schema.Array(ID),
  unresolvedBlockers: NonNegativeInt,
  revision: PositiveInt,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "TaskGraph.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Page = Schema.Struct({
  items: Schema.Array(Info),
  total: NonNegativeInt,
}).annotate({ identifier: "TaskGraph.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

const Created = define({
  type: "task.created",
  schema: { sessionID: SessionID, task: Info },
})
const Updated = define({
  type: "task.updated",
  schema: { sessionID: SessionID, task: Info },
})
const Deleted = define({
  type: "task.deleted",
  schema: { sessionID: SessionID, taskID: ID },
})

export const Event = {
  Created,
  Updated,
  Deleted,
  Definitions: inventory(Created, Updated, Deleted),
}
