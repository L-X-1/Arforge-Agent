export * as FeedbackV2 from "./feedback"

import { Feedback } from "@arforge-ai/schema/feedback"
import { and, desc, eq, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { FeedbackTable } from "./feedback/sql"
import { LearningV2 } from "./learning"
import { Location } from "./location"
import { redact } from "./redact"
import { SessionSchema } from "./session/schema"
import { SessionTable } from "./session/sql"

export const ID = Feedback.ID
export type ID = Feedback.ID
export const Category = Feedback.Category
export type Category = Feedback.Category
export const Rating = Feedback.Rating
export type Rating = Feedback.Rating
export const Message = Feedback.Message
export type Message = Feedback.Message
export const Entry = Feedback.Entry
export type Entry = Feedback.Entry
export const SubmitResult = Feedback.SubmitResult
export type SubmitResult = Feedback.SubmitResult
export const Page = Feedback.Page
export type Page = Feedback.Page
export const Summary = Feedback.Summary
export type Summary = Feedback.Summary
export const DeleteResult = Feedback.DeleteResult
export type DeleteResult = Feedback.DeleteResult

export class InvalidMessageError extends Schema.TaggedErrorClass<InvalidMessageError>()(
  "Feedback.InvalidMessageError",
  {
    message: Schema.String,
  },
) {}

export class InvalidSessionError extends Schema.TaggedErrorClass<InvalidSessionError>()(
  "Feedback.InvalidSessionError",
  {
    sessionID: SessionSchema.ID,
    message: Schema.String,
  },
) {}

export interface Interface {
  readonly submit: (input: {
    readonly category: Category
    readonly rating: Rating
    readonly message: Message
    readonly sessionID?: SessionSchema.ID
  }) => Effect.Effect<SubmitResult, InvalidMessageError | InvalidSessionError>
  readonly list: (input?: { readonly limit?: number; readonly category?: Category }) => Effect.Effect<Page>
  readonly summary: () => Effect.Effect<Summary>
  readonly delete: (feedbackID: ID) => Effect.Effect<DeleteResult>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Feedback") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const location = yield* Location.Service
    const learning = yield* LearningV2.Service
    const currentDirectory = canonicalPath(location.directory)

    const submit: Interface["submit"] = Effect.fn("Feedback.submit")(function* (input) {
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.message))
        return yield* new InvalidMessageError({ message: "Feedback must not contain control characters." })
      const cleaned = redact(input.message).trim()
      if (!cleaned) return yield* new InvalidMessageError({ message: "Feedback must not be empty after redaction." })
      if (cleaned.length > 2_000)
        return yield* new InvalidMessageError({ message: "Feedback must contain at most 2,000 characters." })
      if (input.sessionID) {
        const session = yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!session || canonicalPath(session.directory) !== currentDirectory)
          return yield* new InvalidSessionError({
            sessionID: input.sessionID,
            message: "Feedback session must exist in the selected workspace.",
          })
      }
      const row = yield* db
        .insert(FeedbackTable)
        .values({
          id: ID.create(),
          category: input.category,
          rating: input.rating,
          message: Message.make(cleaned),
          workspace_path: currentDirectory,
          session_id: input.sessionID,
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (input.rating !== 3) {
        const outcome = yield* learning
          .record({
            sessionID: input.sessionID,
            userInput: `Explicit ${input.category} feedback: ${cleaned}`,
            intent: "product_feedback",
            route: "feedback",
            success: input.rating >= 4,
            errorType: input.rating >= 4 ? "" : "explicit_feedback",
            errorMessage: input.rating >= 4 ? "" : cleaned,
            userFeedback: input.rating >= 4 ? "helpful" : "unhelpful",
            tags: ["explicit-feedback", input.category, `rating-${input.rating}`],
            importance: Math.max(1, Math.round(Math.abs(input.rating - 3) / 2)),
          })
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (outcome)
          yield* db
            .update(FeedbackTable)
            .set({ learning_outcome_id: outcome.id })
            .where(eq(FeedbackTable.id, row.id))
            .run()
            .pipe(Effect.orDie)
      }
      const stored = yield* db.select().from(FeedbackTable).where(eq(FeedbackTable.id, row.id)).get().pipe(Effect.orDie)
      return SubmitResult.make({ schemaVersion: 1, storedLocally: true, feedback: toEntry(stored!) })
    })

    const list: Interface["list"] = Effect.fn("Feedback.list")(function* (input = {}) {
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)))
      const scope = input.category
        ? and(eq(FeedbackTable.workspace_path, currentDirectory), eq(FeedbackTable.category, input.category))
        : eq(FeedbackTable.workspace_path, currentDirectory)
      const rows = yield* db
        .select()
        .from(FeedbackTable)
        .where(scope)
        .orderBy(desc(FeedbackTable.time_created), desc(FeedbackTable.id))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      const total = yield* db
        .select({ value: sql<number>`count(*)` })
        .from(FeedbackTable)
        .where(scope)
        .get()
        .pipe(Effect.orDie)
      return Page.make({
        schemaVersion: 1,
        storedLocally: true,
        ...(input.category ? { category: input.category } : {}),
        items: rows.map(toEntry),
        count: rows.length,
        // PostgreSQL returns count(*) as bigint text while SQLite returns a
        // number. Normalize at the storage boundary so the shared HTTP schema
        // remains dialect-independent.
        total: toFiniteNumber(total?.value),
      })
    })

    const summary: Interface["summary"] = Effect.fn("Feedback.summary")(function* () {
      const stats = yield* db
        .select({
          total: sql<number>`count(*)`,
          average: sql<number | null>`avg(${FeedbackTable.rating})`,
        })
        .from(FeedbackTable)
        .where(eq(FeedbackTable.workspace_path, currentDirectory))
        .get()
        .pipe(Effect.orDie)
      const categories = yield* db
        .select({ category: FeedbackTable.category, count: sql<number>`count(*)` })
        .from(FeedbackTable)
        .where(eq(FeedbackTable.workspace_path, currentDirectory))
        .groupBy(FeedbackTable.category)
        .orderBy(FeedbackTable.category)
        .all()
        .pipe(Effect.orDie)
      return Summary.make({
        schemaVersion: 1,
        storedLocally: true,
        total: toFiniteNumber(stats?.total),
        ...(stats?.average === null || stats?.average === undefined
          ? {}
          : { averageRating: Math.round(toFiniteNumber(stats.average) * 100) / 100 }),
        byCategory: categories.map((item) => ({
          category: item.category,
          count: toFiniteNumber(item.count),
        })),
      })
    })

    const remove: Interface["delete"] = Effect.fn("Feedback.delete")(function* (feedbackID) {
      const current = yield* db
        .select({ outcomeID: FeedbackTable.learning_outcome_id })
        .from(FeedbackTable)
        .where(and(eq(FeedbackTable.id, feedbackID), eq(FeedbackTable.workspace_path, currentDirectory)))
        .get()
        .pipe(Effect.orDie)
      if (current?.outcomeID) yield* learning.undo(current.outcomeID).pipe(Effect.ignore)
      const deleted = yield* db
        .delete(FeedbackTable)
        .where(and(eq(FeedbackTable.id, feedbackID), eq(FeedbackTable.workspace_path, currentDirectory)))
        .returning({ id: FeedbackTable.id })
        .get()
        .pipe(Effect.orDie)
      return DeleteResult.make({
        schemaVersion: 1,
        feedbackID,
        deleted: deleted !== undefined,
        status: deleted ? "deleted" : "not_found",
      })
    })

    return Service.of({ submit, list, summary, delete: remove })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Location.node, LearningV2.node],
})

type Row = typeof FeedbackTable.$inferSelect

function toEntry(row: Row): Entry {
  return Entry.make({
    id: row.id,
    category: row.category,
    rating: row.rating,
    message: row.message,
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    ...(row.learning_outcome_id ? { learningOutcomeID: row.learning_outcome_id } : {}),
    time: { created: DateTime.makeUnsafe(row.time_created) },
  })
}

function canonicalPath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized
}

function toFiniteNumber(value: number | string | bigint | null | undefined) {
  if (value === null || value === undefined) return 0
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : 0
}

export { redact } from "./redact"
