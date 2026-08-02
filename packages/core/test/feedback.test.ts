import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { FeedbackV2 } from "@arforge-ai/core/feedback"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("C:/workspaces/feedback")
const sessionID = SessionV2.ID.make("ses_feedback")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory,
    project: { id: Project.ID.global, directory },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, LearningV2.node, FeedbackV2.node]), [[Location.node, current]]),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "feedback",
      directory,
      title: "feedback",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("Feedback", () => {
  it.effect("stores only redacted local records, lists newest first, summarizes, and feeds non-neutral learning", () =>
    Effect.gen(function* () {
      yield* setup
      const feedback = yield* FeedbackV2.Service
      const secret = `sk-${"Q".repeat(38)}`
      const first = yield* feedback.submit({
        category: "bug",
        rating: FeedbackV2.Rating.make(2),
        message: FeedbackV2.Message.make(`Command failed with api_key=${secret}`),
        sessionID,
      })
      yield* feedback.submit({
        category: "experience",
        rating: FeedbackV2.Rating.make(3),
        message: FeedbackV2.Message.make("Neutral observation"),
      })
      yield* feedback.submit({
        category: "feature",
        rating: FeedbackV2.Rating.make(5),
        message: FeedbackV2.Message.make("Please add a compact report"),
      })

      expect(first.storedLocally).toBe(true)
      expect(first.feedback.message).not.toContain(secret)
      expect(first.feedback.message).toContain("[REDACTED_SECRET]")
      expect(first.feedback.learningOutcomeID).toBeDefined()
      const listed = yield* feedback.list({ limit: 10 })
      expect(listed.items.map((item) => item.category)).toEqual(["feature", "experience", "bug"])
      expect(yield* feedback.summary()).toMatchObject({
        storedLocally: true,
        total: 3,
        averageRating: 3.33,
        byCategory: [
          { category: "bug", count: 1 },
          { category: "experience", count: 1 },
          { category: "feature", count: 1 },
        ],
      })
      const learning = yield* (yield* LearningV2.Service).status()
      expect(learning.totalTurns).toBe(2)
      expect(learning.recent.map((item) => item.userFeedback).sort()).toEqual(["helpful", "unhelpful"])
      expect(learning.recent.every((item) => item.tags.includes("explicit-feedback"))).toBe(true)
      yield* feedback.delete(first.feedback.id)
      expect((yield* (yield* LearningV2.Service).status()).totalTurns).toBe(1)
    }),
  )

  it.effect("fails closed on control characters or cross-workspace session linkage", () =>
    Effect.gen(function* () {
      yield* setup
      const feedback = yield* FeedbackV2.Service
      expect(
        yield* Effect.flip(
          feedback.submit({
            category: "other",
            rating: FeedbackV2.Rating.make(4),
            message: FeedbackV2.Message.make("bad\u0000message"),
          }),
        ),
      ).toBeInstanceOf(FeedbackV2.InvalidMessageError)
      expect(
        yield* Effect.flip(
          feedback.submit({
            category: "other",
            rating: FeedbackV2.Rating.make(4),
            message: FeedbackV2.Message.make("valid message"),
            sessionID: SessionV2.ID.make("ses_missing"),
          }),
        ),
      ).toBeInstanceOf(FeedbackV2.InvalidSessionError)
    }),
  )

  it.effect("deletes explicitly and idempotently", () =>
    Effect.gen(function* () {
      yield* setup
      const feedback = yield* FeedbackV2.Service
      const entry = yield* feedback.submit({
        category: "other",
        rating: FeedbackV2.Rating.make(3),
        message: FeedbackV2.Message.make("Neutral"),
      })
      expect(yield* feedback.delete(entry.feedback.id)).toMatchObject({ deleted: true, status: "deleted" })
      expect(yield* feedback.delete(entry.feedback.id)).toMatchObject({ deleted: false, status: "not_found" })
      expect((yield* feedback.summary()).total).toBe(0)
    }),
  )
})
