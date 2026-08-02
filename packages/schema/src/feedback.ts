export * as Feedback from "./feedback"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { Learning } from "./learning"

export const ID = Schema.String.check(Schema.isStartsWith("fdb_")).pipe(
  Schema.brand("FeedbackID"),
  statics((schema) => ({
    create: () => schema.make("fdb_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const Category = Schema.Literals(["bug", "feature", "experience", "other"]).annotate({
  identifier: "FeedbackCategory",
})
export type Category = typeof Category.Type

export const Rating = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).annotate({
  identifier: "FeedbackRating",
})
export type Rating = typeof Rating.Type

export const Message = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000)).annotate(
  { identifier: "FeedbackMessage" },
)
export type Message = typeof Message.Type

export const Entry = Schema.Struct({
  id: ID,
  category: Category,
  rating: Rating,
  message: Message,
  sessionID: SessionID.pipe(optional),
  learningOutcomeID: Learning.OutcomeID.pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}).annotate({ identifier: "Feedback.Entry" })
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

export const SubmitResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  storedLocally: Schema.Literal(true),
  feedback: Entry,
}).annotate({ identifier: "Feedback.SubmitResult" })
export interface SubmitResult extends Schema.Schema.Type<typeof SubmitResult> {}

export const Page = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  storedLocally: Schema.Literal(true),
  category: Category.pipe(optional),
  items: Schema.Array(Entry),
  count: NonNegativeInt,
  total: NonNegativeInt,
}).annotate({ identifier: "Feedback.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

export const Summary = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  storedLocally: Schema.Literal(true),
  total: NonNegativeInt,
  averageRating: Schema.Finite.pipe(optional),
  byCategory: Schema.Array(Schema.Struct({ category: Category, count: NonNegativeInt })),
}).annotate({ identifier: "Feedback.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const DeleteResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  feedbackID: ID,
  deleted: Schema.Boolean,
  status: Schema.Literals(["deleted", "not_found"]),
}).annotate({ identifier: "Feedback.DeleteResult" })
export interface DeleteResult extends Schema.Schema.Type<typeof DeleteResult> {}
