import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Probe } from "@arforge-ai/llm"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import * as RuntimeEvaluation from "@arforge-ai/core/runtime/evaluation"
import { GOLDEN_CASES, replayDeterministic } from "@arforge-ai/core/runtime/golden"
import { Effect, Exit } from "effect"
import { ModelProbe } from "../../src/model-probe"
import { testEffect } from "../lib/effect"

const runtimeLayer = AppNodeBuilder.build(LayerNode.group([Database.node, RuntimeEvaluation.node]))
const it = testEffect(runtimeLayer)

const digest = "a".repeat(64)
const input = () => ({
  id: AgentRuntime.EvaluationID.make("eva_persisted"),
  runID: AgentRuntime.RunID.make("run_evaluation"),
  suiteID: "golden-suite",
  suiteRevision: 3,
  caseID: "case-1",
  caseRevision: 2,
  baselineArtifactDigest: digest,
  candidateArtifactDigest: "b".repeat(64),
  environmentDigest: "c".repeat(64),
  toolchainDigest: "d".repeat(64),
  sampleSize: 10,
  score: 0.9,
  successDelta: 0.1,
  costDelta: -0.02,
  latencyDelta: -12,
  passed: true,
  metrics: { accuracy: 0.9, regressions: 0 },
  evidenceIDs: [AgentRuntime.EvidenceID.make("evd_evaluation")],
  providerID: "deepseek",
  modelID: "deepseek-v4-flash",
  inputTokens: 100,
  outputTokens: 40,
  costMinor: 5,
  currency: "CNY",
  approvalStatus: "approved" as const,
  reviewerID: "usr_local",
  createdAt: 1_000,
  evaluatedAt: 1_100,
})

describe("RuntimeEvaluation", () => {
  it.effect("persists immutable evaluation references and exposes the canonical result", () =>
    Effect.gen(function* () {
      const evaluation = yield* RuntimeEvaluation.Service
      const created = yield* evaluation.create(input())
      expect(created.result.id).toBe(AgentRuntime.EvaluationID.make("eva_persisted"))
      expect(created.result.baseline).toBe(digest)
      expect(created.result.evaluatedAt).toEqual(expect.anything())
      expect(created.approvalStatus).toBe("approved")

      const loaded = yield* evaluation.get(AgentRuntime.EvaluationID.make("eva_persisted"))
      expect(loaded).toMatchObject({
        caseRevision: 2,
        candidateArtifactDigest: "b".repeat(64),
        evidenceIDs: ["evd_evaluation"],
      })
      expect(yield* evaluation.list({ runID: AgentRuntime.RunID.make("run_evaluation") })).toHaveLength(1)

      const duplicate = yield* evaluation.create(input()).pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)
      if (Exit.isFailure(duplicate)) expect(duplicate.cause).toBeDefined()
    }),
  )

  it.effect("rejects free-text or incomplete evidence/artifact input", () =>
    Effect.gen(function* () {
      const evaluation = yield* RuntimeEvaluation.Service
      const invalid = yield* evaluation
        .create({
          ...input(),
          id: AgentRuntime.EvaluationID.make("eva_invalid"),
          evidenceIDs: [],
          baselineArtifactDigest: "not-an-artifact",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBe(true)
    }),
  )

  it.effect("writes and reads EvaluationResult only inside the current tenant owner scope", () =>
    Effect.gen(function* () {
      const evaluation = yield* RuntimeEvaluation.Service
      const database = yield* Database.Service
      const owner = { tenantID: "ten_evaluation_owner", userID: "usr_evaluation_owner" }
      const other = { tenantID: "ten_evaluation_other", userID: "usr_evaluation_other" }
      const evaluationID = AgentRuntime.EvaluationID.make("eva_tenant_scoped")
      yield* database.runAsPrincipal(owner, evaluation.create({ ...input(), id: evaluationID }))

      expect(yield* database.runAsPrincipal(owner, evaluation.get(evaluationID))).toBeDefined()
      expect(yield* database.runAsPrincipal(other, evaluation.get(evaluationID))).toBeUndefined()
      expect(yield* database.runAsPrincipal(other, evaluation.list())).toEqual([])
    }),
  )

  it.effect("persists a deterministic Golden replay draft as the Evaluation Core fact", () =>
    Effect.gen(function* () {
      const evaluation = yield* RuntimeEvaluation.Service
      const replay = yield* replayDeterministic({
        kind: "deterministic-tool-fixture",
        goldenCase: GOLDEN_CASES["formal-pricing-01"]!,
        runID: AgentRuntime.RunID.make("run_replay_evaluation"),
        traceID: "trace_replay_evaluation",
        sessionID: "ses_replay_evaluation",
        toolCallID: "tool_replay_evaluation",
        baselineArtifactDigest: "a".repeat(64),
        candidateArtifactDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        toolchainDigest: "d".repeat(64),
        evidenceIDs: [AgentRuntime.EvidenceID.make("evd_replay_evaluation")],
        baselinePassed: false,
        actual: { discountThenTax: 114.95, belowThreshold: 55, negativeRejected: true },
        checks: [{ command: "python -m pytest tests/test_regression.py", exitCode: 0, output: "3 passed" }],
      })
      const created = yield* evaluation.create({
        ...replay.evaluation,
        id: AgentRuntime.EvaluationID.make("eva_replay_evaluation"),
      })
      expect(created.result.id).toBe(AgentRuntime.EvaluationID.make("eva_replay_evaluation"))
      expect(created.suiteID).toBe("python-formal")
      expect(created.metrics.assertion_pass_rate).toBe(1)
    }),
  )

  it.effect("persists a ModelProbe observation through the canonical Evaluation Core input", () =>
    Effect.gen(function* () {
      const evaluation = yield* RuntimeEvaluation.Service
      const probe = yield* ModelProbe.run({
        providerID: "deepseek",
        modelID: "deepseek-v4-flash",
        adapter: {
          id: "recorded-capability-v1",
          execute: () => Effect.succeed(new Probe.AdapterResult({ outcome: "supported", latencyMs: 7 })),
        },
        policy: ModelProbe.Policy.offline("recorded"),
        cases: [Probe.ProbeCase.fixed("text-generation"), Probe.ProbeCase.fixed("streaming")],
      })
      const created = yield* evaluation.create({
        ...RuntimeEvaluation.fromCapabilityProbe({
          result: probe,
          runID: AgentRuntime.RunID.make("run_capability_evaluation"),
          suiteRevision: 1,
          caseRevision: 1,
          baselineArtifactDigest: "a".repeat(64),
          candidateArtifactDigest: "b".repeat(64),
          environmentDigest: "c".repeat(64),
          toolchainDigest: "d".repeat(64),
          evidenceIDs: [AgentRuntime.EvidenceID.make("evd_capability_evaluation")],
          baselinePassed: false,
        }),
        id: AgentRuntime.EvaluationID.make("eva_capability_evaluation"),
      })

      expect(created.suiteID).toBe("model-capability-probe")
      expect(created.caseID).toBe("deepseek/deepseek-v4-flash")
      expect(created.sampleSize).toBe(2)
      expect(created.score).toBe(1)
      expect(created.metrics).toMatchObject({
        observation_count: 2,
        passed_count: 2,
        average_latency_ms: 7,
        source_live: 0,
      })
      expect(created.result.evidenceIDs).toEqual([AgentRuntime.EvidenceID.make("evd_capability_evaluation")])
    }),
  )
})
