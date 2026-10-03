import { describe, expect, it } from "bun:test"
import { LLMClient, LLMEvent, LLMRequest, Model } from "@arforge-ai/llm"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Cause, Effect, Exit, Stream } from "effect"
import {
  GOLDEN_CASES,
  compareGoldenRegression,
  decodeRecordedProviderFixture,
  makeRecordedProviderFixture,
  replayDeterministic,
  replayLiveModel,
  replayRecordedProvider,
} from "@arforge-ai/core/runtime/golden"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"

const digest = "a".repeat(64)

const replayDeterministicCase = (caseID: string, runID: string, actual: Readonly<Record<string, unknown>>) =>
  Effect.runPromise(
    replayDeterministic({
      kind: "deterministic-tool-fixture",
      goldenCase: GOLDEN_CASES[caseID]!,
      runID: AgentRuntime.RunID.make(runID),
      traceID: `trace_${runID}`,
      sessionID: `ses_${runID}`,
      toolCallID: `tool_${runID}`,
      baselineArtifactDigest: digest,
      candidateArtifactDigest: "b".repeat(64),
      environmentDigest: "c".repeat(64),
      toolchainDigest: "d".repeat(64),
      evidenceIDs: [AgentRuntime.EvidenceID.make(`evd_${runID}`)],
      baselinePassed: false,
      actual,
      checks: [{ command: "python -m pytest tests/test_regression.py", exitCode: 0, output: "2 passed" }],
    }),
  )

describe("RuntimeGolden", () => {
  it("replays the migrated Python pricing case as a deterministic fixture", async () => {
    RuntimeInsight.reset()
    const goldenCase = GOLDEN_CASES["formal-pricing-01"]!
    const result = await Effect.runPromise(
      replayDeterministic({
        kind: "deterministic-tool-fixture",
        goldenCase,
        runID: AgentRuntime.RunID.make("run_golden"),
        traceID: "trace_golden",
        sessionID: "ses_golden",
        toolCallID: "tool_golden",
        baselineArtifactDigest: digest,
        candidateArtifactDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        toolchainDigest: "d".repeat(64),
        evidenceIDs: [AgentRuntime.EvidenceID.make("evd_golden")],
        baselinePassed: false,
        actual: { discountThenTax: 114.95, belowThreshold: 55, negativeRejected: true },
        checks: [{ command: "python -m pytest tests/test_regression.py", exitCode: 0, output: "3 passed" }],
      }),
    )
    expect(result.passed).toBe(true)
    expect(result.score).toBe(1)
    expect(result.evaluation.successDelta).toBe(1)
    expect(RuntimeInsight.metrics().map((metric) => metric.name)).toEqual(
      expect.arrayContaining(["verification.result", "evaluation.replay"]),
    )
  })

  it("routes a migrated multistack SQL case through the same Evaluation Core draft", async () => {
    const goldenCase = GOLDEN_CASES["multistack-sql-01"]!
    const result = await Effect.runPromise(
      replayDeterministic({
        kind: "deterministic-tool-fixture",
        goldenCase,
        runID: AgentRuntime.RunID.make("run_multistack_sql"),
        traceID: "trace_multistack_sql",
        sessionID: "ses_multistack_sql",
        toolCallID: "tool_multistack_sql",
        baselineArtifactDigest: digest,
        candidateArtifactDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        toolchainDigest: "d".repeat(64),
        evidenceIDs: [AgentRuntime.EvidenceID.make("evd_multistack_sql")],
        baselinePassed: false,
        actual: { constraintsEnforced: true, regressionPassed: true, databaseConstraint: true },
        checks: [{ command: "sqlite3 :memory: schema contract regression", exitCode: 0, output: "passed" }],
      }),
    )
    expect(result.passed).toBe(true)
    expect(result.evaluation.suiteID).toBe("multistack-formal")
    expect(result.evaluation.caseID).toBe("multistack-sql-01")
  })

  it("replays the migrated Python slug case through the deterministic lane", async () => {
    const result = await Effect.runPromise(
      replayDeterministic({
        kind: "deterministic-tool-fixture",
        goldenCase: GOLDEN_CASES["formal-slug-01"]!,
        runID: AgentRuntime.RunID.make("run_slug"),
        traceID: "trace_slug",
        sessionID: "ses_slug",
        toolCallID: "tool_slug",
        baselineArtifactDigest: digest,
        candidateArtifactDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        toolchainDigest: "d".repeat(64),
        evidenceIDs: [AgentRuntime.EvidenceID.make("evd_slug")],
        baselinePassed: false,
        actual: { unicodeSlug: "arforge-中文-agent", boundedWithoutDash: true, emptySlug: false },
        checks: [{ command: "python -m pytest tests/test_regression.py", exitCode: 0, output: "2 passed" }],
      }),
    )
    expect(result.passed).toBe(true)
    expect(result.evaluation.caseID).toBe("formal-slug-01")
  })

  it("replays the migrated Python retry case through the deterministic lane", async () => {
    const result = await Effect.runPromise(
      replayDeterministic({
        kind: "deterministic-tool-fixture",
        goldenCase: GOLDEN_CASES["formal-retry-01"]!,
        runID: AgentRuntime.RunID.make("run_retry"),
        traceID: "trace_retry",
        sessionID: "ses_retry",
        toolCallID: "tool_retry",
        baselineArtifactDigest: digest,
        candidateArtifactDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        toolchainDigest: "d".repeat(64),
        evidenceIDs: [AgentRuntime.EvidenceID.make("evd_retry")],
        baselinePassed: false,
        actual: { retryReturnsValue: true, exactCallCount: 4, nonRetryExceptionPropagates: true },
        checks: [{ command: "python -m pytest tests/test_regression.py", exitCode: 0, output: "2 passed" }],
      }),
    )
    expect(result.passed).toBe(true)
    expect(result.evaluation.caseID).toBe("formal-retry-01")
  })

  it("replays the migrated Python state case with its service boundary", async () => {
    const result = await replayDeterministicCase("formal-state-01", "run_state", {
      happyPath: true,
      serviceUsesTransition: true,
      invalidRejected: true,
    })
    expect(result.passed).toBe(true)
    expect(result.evaluation.caseID).toBe("formal-state-01")
  })

  it("replays the migrated Python refactor case with compatibility preserved", async () => {
    const result = await replayDeterministicCase("formal-refactor-01", "run_refactor", {
      compatibilityEntry: true,
      normalizedName: "Ada Lovelace",
      legacyBehaviorChanged: false,
    })
    expect(result.passed).toBe(true)
    expect(result.evaluation.caseID).toBe("formal-refactor-01")
  })

  it("replays the migrated Python architecture case with an import-safe contract", async () => {
    const result = await replayDeterministicCase("formal-architecture-01", "run_architecture", {
      createUserApi: true,
      architectureDocumented: true,
      circularImport: false,
    })
    expect(result.passed).toBe(true)
    expect(result.evaluation.caseID).toBe("formal-architecture-01")
  })

  it("replays the migrated JavaScript multistack case through the deterministic lane", async () => {
    const result = await replayDeterministicCase("multistack-javascript-01", "run_multistack_javascript", {
      thresholdPass: true,
      customThreshold: true,
      invalidRange: true,
      serviceBypassesPolicy: false,
    })
    expect(result.passed).toBe(true)
    expect(result.evaluation.suiteID).toBe("multistack-formal")
    expect(result.evaluation.caseID).toBe("multistack-javascript-01")
  })

  it("replays the migrated Java multistack case through the deterministic lane", async () => {
    const result = await replayDeterministicCase("multistack-java-01", "run_multistack_java", {
      thresholdPass: true,
      customThreshold: true,
      invalidRange: true,
      serviceBypassesPolicy: false,
    })
    expect(result.passed).toBe(true)
    expect(result.evaluation.suiteID).toBe("multistack-formal")
    expect(result.evaluation.caseID).toBe("multistack-java-01")
  })

  it("replays the available native multistack toolchains through one deterministic contract", async () => {
    const cases = [
      "multistack-rust-01",
      "multistack-c-01",
      "multistack-cpp-01",
      "multistack-csharp-01",
      "multistack-go-01",
      "multistack-php-01",
      "multistack-ruby-01",
    ] as const
    for (const caseID of cases) {
      const result = await replayDeterministicCase(caseID, `run_${caseID}`, {
        thresholdPass: true,
        customThreshold: true,
        invalidRange: true,
        serviceBypassesPolicy: false,
      })
      expect(result.passed).toBe(true)
      expect(result.evaluation.caseID).toBe(caseID)
      expect(result.evaluation.sampleSize).toBe(1)
    }
  })

  it("replays all 50 multistack manifests through one deterministic contract", async () => {
    const cases = Object.values(GOLDEN_CASES).filter((goldenCase) => goldenCase.sourceFamily === "multistack")
    expect(cases).toHaveLength(50)
    for (const goldenCase of cases) {
      const actual = goldenCase.caseID.includes("-sql-")
        ? { constraintsEnforced: true, regressionPassed: true, databaseConstraint: true }
        : {
            thresholdPass: true,
            customThreshold: true,
            invalidRange: true,
            serviceBypassesPolicy: false,
          }
      const result = await replayDeterministicCase(goldenCase.caseID, `run_${goldenCase.caseID}`, {
        ...actual,
      })
      expect(result.passed).toBe(true)
      expect(result.evaluation.suiteID).toBe("multistack-formal")
      expect(result.evaluation.caseID).toBe(goldenCase.caseID)
      expect(result.evaluation.sampleSize).toBe(1)
    }
  })

  it("replays all capability-eval contracts without model invocation", async () => {
    const cases = Object.values(GOLDEN_CASES).filter((goldenCase) => goldenCase.sourceFamily === "capability-eval")
    expect(cases).toHaveLength(26)
    for (const goldenCase of cases) {
      const result = await replayDeterministicCase(goldenCase.caseID, `run_${goldenCase.caseID}`, {
        passed: true,
        modelInvoked: false,
      })
      expect(result.passed).toBe(true)
      expect(result.evaluation.suiteID).toBe("capability-eval")
      expect(result.evaluation.caseID).toBe(goldenCase.caseID)
    }
  })

  it("runs the complete Golden manifest and blocks candidate regression", async () => {
    const cases = Object.values(GOLDEN_CASES)
    const baselines = []
    for (const [index, goldenCase] of cases.entries()) {
      const actual = Object.fromEntries(
        [...goldenCase.positiveAssertions, ...goldenCase.negativeAssertions].map((assertion) => [
          assertion.actualKey,
          assertion.expected,
        ]),
      )
      const result = await replayDeterministicCase(goldenCase.caseID, `run_golden_manifest_${index}`, actual)
      expect(result.passed).toBe(true)
      baselines.push({
        caseID: result.evaluation.caseID,
        suiteID: result.evaluation.suiteID,
        suiteRevision: result.evaluation.suiteRevision,
        caseRevision: result.evaluation.caseRevision,
        fixtureDigest: result.fixtureDigest,
        passed: result.passed,
        score: result.score,
      })
    }
    expect(baselines).toHaveLength(cases.length)
    const baseline = baselines[0]!
    expect(compareGoldenRegression({ baseline, candidate: baseline }).equivalent).toBe(true)
    const degraded = compareGoldenRegression({
      baseline,
      candidate: { ...baseline, passed: false, score: baseline.score - 0.1 },
    })
    expect(degraded.equivalent).toBe(false)
    expect(degraded.blockingReasons).toEqual(["candidate-not-passing", "score-regression"])
  })

  it("fails closed when the immutable fixture is tampered", async () => {
    const goldenCase = GOLDEN_CASES["formal-pricing-01"]!
    const exit = await Effect.runPromise(
      Effect.exit(
        replayDeterministic({
          kind: "deterministic-tool-fixture",
          goldenCase: { ...goldenCase, fixtureDigest: "f".repeat(64) },
          runID: AgentRuntime.RunID.make("run_golden_bad"),
          traceID: "trace_golden_bad",
          sessionID: "ses_golden",
          toolCallID: "tool_golden",
          baselineArtifactDigest: digest,
          candidateArtifactDigest: "b".repeat(64),
          environmentDigest: "c".repeat(64),
          toolchainDigest: "d".repeat(64),
          evidenceIDs: [AgentRuntime.EvidenceID.make("evd_golden")],
          baselinePassed: false,
          actual: {},
          checks: [],
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("RuntimeGolden.InvalidGoldenCaseError")
  })

  it("rejects duplicate assertion IDs before evaluation", async () => {
    const goldenCase = GOLDEN_CASES["formal-pricing-01"]!
    const firstAssertion = goldenCase.positiveAssertions[0]!
    const exit = await Effect.runPromise(
      Effect.exit(
        replayDeterministic({
          kind: "deterministic-tool-fixture",
          goldenCase: {
            ...goldenCase,
            positiveAssertions: [...goldenCase.positiveAssertions, { ...firstAssertion }],
          },
          runID: AgentRuntime.RunID.make("run_duplicate_assertion"),
          traceID: "trace_duplicate_assertion",
          sessionID: "ses_duplicate_assertion",
          toolCallID: "tool_duplicate_assertion",
          baselineArtifactDigest: digest,
          candidateArtifactDigest: "b".repeat(64),
          environmentDigest: "c".repeat(64),
          toolchainDigest: "d".repeat(64),
          evidenceIDs: [AgentRuntime.EvidenceID.make("evd_duplicate_assertion")],
          baselinePassed: false,
          actual: {},
          checks: [],
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("RuntimeGolden.InvalidGoldenCaseError")
  })

  it("replays DeepSeek-compatible recorded events without network access", async () => {
    RuntimeInsight.reset()
    const baseCase = GOLDEN_CASES["formal-pricing-01"]!
    const goldenCase = {
      ...baseCase,
      positiveAssertions: [
        { id: "answer_contains_done", kind: "contains" as const, actualKey: "text", expected: "Done" },
        { id: "finish_is_stop", kind: "equals" as const, actualKey: "finishReason", expected: "stop" },
      ],
      negativeAssertions: [
        { id: "no_provider_error", kind: "equals" as const, actualKey: "hasProviderError", expected: false },
      ],
    }
    const requestDigest = "e".repeat(64)
    const fixture = makeRecordedProviderFixture({
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      requestDigest,
      events: [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-recorded" }),
        LLMEvent.textDelta({ id: "text-recorded", text: "Done" }),
        LLMEvent.textEnd({ id: "text-recorded" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
        LLMEvent.finish({ reason: "stop", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
      ],
    })
    const archivedFixture = decodeRecordedProviderFixture(JSON.parse(JSON.stringify(fixture)))
    expect(archivedFixture.fixtureDigest).toBe(fixture.fixtureDigest)
    const result = await Effect.runPromise(
      replayRecordedProvider({
        kind: "recorded-provider",
        goldenCase,
        fixture: archivedFixture,
        requestDigest,
        runID: AgentRuntime.RunID.make("run_recorded"),
        traceID: "trace_recorded",
        sessionID: "ses_recorded",
        toolCallID: "tool_recorded",
        actionID: "action_recorded",
        baselineArtifactDigest: digest,
        candidateArtifactDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        toolchainDigest: "d".repeat(64),
        evidenceIDs: [AgentRuntime.EvidenceID.make("evd_recorded")],
        baselinePassed: false,
        checks: [{ command: "replay fixture reducer", exitCode: 0, output: "terminal finish reconstructed" }],
      }),
    )
    expect(result.passed).toBe(true)
    expect(result.score).toBe(1)
    expect(result.evaluation.providerID).toBe("deepseek")
    expect(result.evaluation.modelID).toBe("deepseek-v4-flash")
    expect(result.evaluation.inputTokens).toBe(10)
    expect(result.evaluation.outputTokens).toBe(2)
    const metrics = RuntimeInsight.metrics()
    expect(metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining(["verification.result", "evaluation.replay"]),
    )
    expect(JSON.stringify(metrics)).not.toContain("Done")
  })

  it("rejects a recorded fixture when the caller request digest does not match", async () => {
    const baseCase = GOLDEN_CASES["formal-pricing-01"]!
    const fixture = makeRecordedProviderFixture({
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      requestDigest: "e".repeat(64),
      events: [LLMEvent.finish({ reason: "stop" })],
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        replayRecordedProvider({
          kind: "recorded-provider",
          goldenCase: baseCase,
          fixture,
          requestDigest: "f".repeat(64),
          runID: AgentRuntime.RunID.make("run_recorded_bad"),
          traceID: "trace_recorded_bad",
          sessionID: "ses_recorded",
          toolCallID: "tool_recorded",
          baselineArtifactDigest: digest,
          candidateArtifactDigest: "b".repeat(64),
          environmentDigest: "c".repeat(64),
          toolchainDigest: "d".repeat(64),
          evidenceIDs: [AgentRuntime.EvidenceID.make("evd_recorded")],
          baselinePassed: false,
          checks: [],
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("RuntimeGolden.InvalidGoldenCaseError")
  })

  it("runs an explicitly authorized live-model lane through the same reducer without leaking content", async () => {
    RuntimeInsight.reset()
    const baseCase = GOLDEN_CASES["formal-pricing-01"]!
    const goldenCase = {
      ...baseCase,
      budget: { maxTokens: 32, maxCostMinor: 500, maxDurationMs: 1_000 },
      positiveAssertions: [
        { id: "answer_contains_done", kind: "contains" as const, actualKey: "text", expected: "Done" },
        { id: "finish_is_stop", kind: "equals" as const, actualKey: "finishReason", expected: "stop" },
      ],
      negativeAssertions: [
        { id: "no_provider_error", kind: "equals" as const, actualKey: "hasProviderError", expected: false },
      ],
    }
    const events = [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-live" }),
      LLMEvent.textDelta({ id: "text-live", text: "Done" }),
      LLMEvent.textEnd({ id: "text-live" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
      LLMEvent.finish({ reason: "stop", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
    ]
    const model = Model.make({ id: "deepseek-v4-flash", provider: "deepseek", route: OpenAIChat.route })
    const request = new LLMRequest({ model, system: [], messages: [], tools: [] })
    let calls = 0
    const client = LLMClient.Service.of({
      prepare: () => Effect.die("unused"),
      streamPrepared: () => Stream.die("unused"),
      stream: () => {
        calls += 1
        return Stream.fromIterable(events)
      },
      generate: () => Effect.die("unused"),
    })
    const result = await Effect.runPromise(
      replayLiveModel({
        kind: "live-model",
        goldenCase,
        client,
        request,
        requestDigest: "e".repeat(64),
        authorization: {
          approved: true,
          actorID: "local-reviewer",
          reason: "step-3-10-golden-live-probe",
          maxCostMinor: 500,
          currency: "CNY",
        },
        estimatedCostMinor: 2,
        actualCostMinor: 2,
        runID: AgentRuntime.RunID.make("run_live_model"),
        traceID: "trace_live_model",
        sessionID: "ses_live_model",
        toolCallID: "tool_live_model",
        actionID: "action_live_model",
        baselineArtifactDigest: digest,
        candidateArtifactDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        toolchainDigest: "d".repeat(64),
        evidenceIDs: [AgentRuntime.EvidenceID.make("evd_live_model")],
        baselinePassed: false,
        checks: [{ command: "fake provider replay", exitCode: 0, output: "terminal finish reconstructed" }],
      }),
    )
    expect(calls).toBe(1)
    expect(result.kind).toBe("live-model")
    expect(result.passed).toBe(true)
    expect(result.evaluation.costMinor).toBe(2)
    expect(result.evaluation.currency).toBe("CNY")
    expect(result.evaluation.inputTokens).toBe(10)
    expect(result.evaluation.outputTokens).toBe(2)
    expect(JSON.stringify(RuntimeInsight.metrics())).not.toContain("Done")
  })

  it("does not construct a provider stream without explicit live authorization", async () => {
    const baseCase = GOLDEN_CASES["formal-pricing-01"]!
    const goldenCase = { ...baseCase, budget: { maxTokens: 32, maxCostMinor: 500, maxDurationMs: 1_000 } }
    const model = Model.make({ id: "deepseek-v4-flash", provider: "deepseek", route: OpenAIChat.route })
    const request = new LLMRequest({ model, system: [], messages: [], tools: [] })
    let calls = 0
    const client = LLMClient.Service.of({
      prepare: () => Effect.die("unused"),
      streamPrepared: () => Stream.die("unused"),
      stream: () => {
        calls += 1
        return Stream.fromIterable([
          LLMEvent.finish({ reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
        ])
      },
      generate: () => Effect.die("unused"),
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        replayLiveModel({
          kind: "live-model",
          goldenCase,
          client,
          request,
          requestDigest: "e".repeat(64),
          authorization: { approved: false, actorID: "", reason: "", maxCostMinor: 500, currency: "CNY" },
          estimatedCostMinor: 2,
          actualCostMinor: 2,
          runID: AgentRuntime.RunID.make("run_live_unauthorized"),
          traceID: "trace_live_unauthorized",
          sessionID: "ses_live_unauthorized",
          toolCallID: "tool_live_unauthorized",
          baselineArtifactDigest: digest,
          candidateArtifactDigest: "b".repeat(64),
          environmentDigest: "c".repeat(64),
          toolchainDigest: "d".repeat(64),
          evidenceIDs: [AgentRuntime.EvidenceID.make("evd_live_unauthorized")],
          baselinePassed: false,
          checks: [],
        }),
      ),
    )
    expect(calls).toBe(0)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("RuntimeGolden.InvalidGoldenCaseError")
  })
})
