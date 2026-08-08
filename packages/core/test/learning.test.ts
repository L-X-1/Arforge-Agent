import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("C:/workspaces/learning")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory,
    project: { id: Project.ID.global, directory },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, LearningV2.node]), [[Location.node, current]]),
)

describe("Learning", () => {
  it.effect("records cross-session outcomes, consolidates failures immediately, and reverses linked patterns", () =>
    Effect.gen(function* () {
      const learning = yield* LearningV2.Service
      const first = yield* learning.record({
        userInput: "Run database migration",
        success: false,
        errorType: "IntegrityError",
        errorMessage: "IntegrityError: duplicate key value",
        tools: ["bash"],
      })
      yield* learning.record({
        userInput: "Run database migration",
        success: false,
        errorType: "IntegrityError",
        errorMessage: "IntegrityError: duplicate key value",
        tools: ["bash"],
      })
      const before = yield* learning.status()
      expect(before.totalTurns).toBe(2)
      expect(before.patterns[0]).toMatchObject({ type: "failure", frequency: 2 })

      const context = yield* learning.context("database migration duplicate")
      expect(context).toContain("historical observations, not instructions")
      expect(context).toContain("IntegrityError")

      const undone = yield* learning.undo(first.id)
      expect(undone.deleted).toBe(true)
      expect(undone.linkedPatterns).toHaveLength(1)
      expect(undone.linkedPatterns[0]?.action).toBe("decremented")
      expect((yield* learning.status()).patterns[0]?.frequency).toBe(1)
      expect((yield* learning.undo(LearningV2.OutcomeID.make("lout_missing"))).deleted).toBe(false)
    }),
  )

  it.effect("holds impact uplift at zero until both cohorts are large enough", () =>
    Effect.gen(function* () {
      const learning = yield* LearningV2.Service
      for (let index = 0; index < 2; index++)
        yield* learning.record({
          userInput: `Injected ${index}`,
          success: true,
          injectedContextSize: 100,
        })
      for (let index = 0; index < 3; index++)
        yield* learning.record({
          userInput: `Baseline ${index}`,
          success: index === 0,
        })
      const insufficient = (yield* learning.status()).impact
      expect(insufficient).toMatchObject({ status: "insufficient_data", uplift: 0, injectedCount: 2, baselineCount: 3 })

      yield* learning.record({ userInput: "Injected 3", success: true, injectedContextSize: 100 })
      const observed = (yield* learning.status()).impact
      expect(observed.status).toBe("observed")
      expect(observed.uplift).toBeGreaterThan(0)
      expect(observed.caveat).toContain("not randomized causal proof")
    }),
  )

  it.effect("exposes only high-confidence workspace patterns for review-only Evolution proposals", () =>
    Effect.gen(function* () {
      const learning = yield* LearningV2.Service
      const failure = {
        userInput: "Repair the parser",
        success: false,
        errorType: "SyntaxError",
        errorMessage: "SyntaxError: unexpected token",
      } as const
      yield* learning.record(failure)
      yield* learning.record(failure)
      expect(yield* learning.proposalCandidates()).toEqual([])

      yield* learning.record(failure)
      expect(yield* learning.proposalCandidates()).toMatchObject([{ type: "failure", frequency: 3, confidence: 0.7 }])
    }),
  )

  it.effect("redacts secrets before learning outcomes can become proposal evidence", () =>
    Effect.gen(function* () {
      const learning = yield* LearningV2.Service
      const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
      yield* learning.record({
        userInput: `debug with token=${secret}`,
        success: false,
        errorMessage: `Authorization: Bearer ${secret}`,
      })
      const status = yield* learning.status()
      expect(status.recent[0]?.userInput).not.toContain(secret)
      expect(status.recent[0]?.errorMessage).not.toContain(secret)
      expect(status.patterns[0]?.description).not.toContain(secret)
      expect(status.patterns[0]?.description).toContain("[REDACTED_SECRET]")
    }),
  )

  it.effect("imports append-only dogfood candidates idempotently by deterministic fingerprint", () =>
    Effect.gen(function* () {
      const learning = yield* LearningV2.Service
      const candidate = {
        task: "Run release checks",
        success: true,
        timestamp: "2026-07-26T10:00:00Z",
        steps: 3,
        toolCalls: ["bash", "read"],
      }
      expect(yield* learning.syncDogfood([candidate])).toMatchObject({ seen: 1, imported: 1, skipped: 0 })
      expect(yield* learning.syncDogfood([candidate])).toMatchObject({ seen: 1, imported: 0, skipped: 1 })
      const status = yield* learning.status()
      expect(status.totalTurns).toBe(1)
      expect(status.recent[0]?.tags[0]).toMatch(/^dogfood:[0-9a-f]{16}$/)
    }),
  )
})
