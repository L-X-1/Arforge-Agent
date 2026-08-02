export * as CooperativeWait from "./wait"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, statics } from "./schema"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("wait_")).pipe(
  Schema.brand("CooperativeWaitID"),
  statics((schema) => ({
    create: () => schema.make("wait_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const Reason = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(200)).annotate({
  identifier: "CooperativeWaitReason",
})
export type Reason = typeof Reason.Type

export const Info = Schema.Struct({
  waitID: ID,
  sessionID: SessionID,
  reason: Reason,
  durationSeconds: Schema.Finite,
  checkInInterval: Schema.Finite,
  startedAt: DateTimeUtcFromMillis,
  elapsedSeconds: Schema.Finite,
  remainingSeconds: Schema.Finite,
  checkInCount: NonNegativeInt,
}).annotate({ identifier: "CooperativeWait.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Status = Schema.Literals(["completed", "woken", "cancelled", "timed_out"])
export type Status = typeof Status.Type

export const Result = Schema.Struct({
  ...Info.fields,
  status: Status,
  finishedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "CooperativeWait.Result" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

const Started = define({ type: "wait.started", schema: { wait: Info } })
const CheckIn = define({ type: "wait.check_in", schema: { wait: Info } })
const Completed = define({ type: "wait.completed", schema: { wait: Result } })
const Woken = define({ type: "wait.woken", schema: { wait: Result } })
const Cancelled = define({ type: "wait.cancelled", schema: { wait: Result } })
const TimedOut = define({ type: "wait.timed_out", schema: { wait: Result } })

export const Event = {
  Started,
  CheckIn,
  Completed,
  Woken,
  Cancelled,
  TimedOut,
  Definitions: inventory(Started, CheckIn, Completed, Woken, Cancelled, TimedOut),
}
