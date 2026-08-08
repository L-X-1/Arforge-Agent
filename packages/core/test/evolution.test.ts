import { describe, expect } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { EvolutionV2 } from "@arforge-ai/core/evolution"
import { EvolutionRuntime } from "@arforge-ai/core/evolution/runtime"
import { Effect } from "effect"
import { it } from "./lib/effect"

const evolutionLayer = (root: string) =>
  AppNodeBuilder.build(EvolutionV2.node, [[EvolutionV2.node, EvolutionV2.layer({ root })]])

const tmpEvolutionRoot = () => {
  const root = join(tmpdir(), `arforge-evolution-service-test-${randomUUID().replace(/-/g, "")}`)
  mkdirSync(root, { recursive: true })
  return root
}

function createActiveCanary(runtime: EvolutionRuntime) {
  const created = runtime.createCandidate({
    title: "Prefer targeted tests after a syntax failure",
    target: "tool.advice",
    instruction: "After a syntax failure, run the smallest relevant test first.",
    rationale: "Repeated broad reruns waste time and hide the first causal error.",
    evidenceRefs: ["self-correct:syntax", "run:failed-001"],
    createdBy: "runtime:failure-miner",
  })
  const passing = () => [
    { case_id: "quality", category: "quality", passed: true, score: 1.0, baseline_score: 0.7, detail: "ok", required: true },
  ]
  const evaluated = runtime.evaluateCandidate(created.manifest.candidate_id, created.state.revision, passing)
  const approved = runtime.approveCandidate(evaluated.candidate_id, evaluated.state.revision, "user:owner", "ok")
  runtime.startCanary(approved.candidate_id, approved.state.revision, "user:owner", "ok", 100)
  return created
}

describe("EvolutionV2", () => {
  it.live("prepares and records an exposure natively without the Python capability boundary", () => {
    const root = tmpEvolutionRoot()
    return Effect.gen(function* () {
      const runtime = new EvolutionRuntime({ root })
      createActiveCanary(runtime)
      const evolution = yield* EvolutionV2.Service

      const prepared = yield* evolution.prepare({
        userInput: "Fix the parser",
        cohortKey: "ses_native_cohort",
        source: { sessionID: "ses_1234567890abcdef", userMessageID: "msg_1234567890abcdef", turnStep: 1 },
      })
      expect(prepared.exposureID).toMatch(/^ex-[0-9a-f]{32}$/)
      expect(prepared.activeCandidateIDs.length).toBe(1)
      expect(prepared.injectedCandidateIDs.length).toBe(1)
      expect(prepared.text).toContain("## Governed Evolution Context")

      const count = yield* evolution.recordOutcome({
        exposureID: prepared.exposureID!,
        success: true,
        stopReason: "completed",
        assistantMessageID: "msg_feedbeef1234567890abcdef12345678",
      })
      expect(count).toBe(1)

      const status = yield* evolution.status()
      expect(status).toMatchObject({ schema_version: 1, total: 1, active: 1 })
      expect((status as Record<string, unknown>).audit).toMatchObject({ valid: true, events: 6 })
    }).pipe(Effect.provide(evolutionLayer(root)))
  })

  it.live("records a safety incident as an automatic rollback through the service", () => {
    const root = tmpEvolutionRoot()
    return Effect.gen(function* () {
      const runtime = new EvolutionRuntime({ root })
      const created = createActiveCanary(runtime)
      const evolution = yield* EvolutionV2.Service

      const prepared = yield* evolution.prepare({ userInput: "unsafe", cohortKey: "safety-cohort" })
      yield* evolution.recordOutcome({
        exposureID: prepared.exposureID!,
        success: false,
        stopReason: "destructive command attempted",
        safetyIncident: true,
      })
      const candidate = yield* evolution.getCandidate(created.manifest.candidate_id)
      expect(candidate.state.status).toBe("rolled_back")
    }).pipe(Effect.provide(evolutionLayer(root)))
  })

  it.live("syncs learning patterns into review-only candidates natively", () => {
    const root = tmpEvolutionRoot()
    return Effect.gen(function* () {
      const evolution = yield* EvolutionV2.Service
      const result = yield* evolution.syncLearningPatterns([
        { id: "lpat_native_1", type: "failure", description: "syntax failures repeat", frequency: 5, confidence: 0.9 },
        { id: "lpat_native_2", type: "failure", description: "below policy", frequency: 1, confidence: 0.2 },
      ])
      expect(result).toMatchObject({ seen: 2, created: 1, existing: 0, skipped: 1, failed: 0 })
      expect(result.items[0]).toMatchObject({ status: "created" })

      const candidates = yield* evolution.listCandidates({ status: "evaluated" })
      expect((candidates as Record<string, unknown>).count).toBe(1)

      const opportunities = yield* evolution.listOpportunities({
        evidence: [{ id: "lpat_native_1", type: "failure", description: "syntax failures repeat", frequency: 5, confidence: 0.9 }],
      })
      expect((opportunities as Record<string, unknown>).items).toHaveLength(1)
    }).pipe(Effect.provide(evolutionLayer(root)))
  })
})
