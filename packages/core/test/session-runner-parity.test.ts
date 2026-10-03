import { describe, expect, it } from "bun:test"
import { LLMEvent } from "@arforge-ai/llm"
import {
  compare,
  fromCoreMessages,
  fromMatureMessages,
  fromProviderEvents,
  make,
} from "@arforge-ai/core/session/runner/parity"
import type { CheckpointSummary } from "@arforge-ai/core/session/runner/parity"
import * as ParityMatrix from "@arforge-ai/core/session/runner/parity-matrix"
import type { Message as CoreMessage } from "@arforge-ai/schema/session-message"
import type { WithParts as MatureMessage } from "@arforge-ai/schema/session-v1"

const textEvents = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text: "provider output is intentionally not retained" }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const toolEvents = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-1", name: "write", input: { path: "redacted" } }),
  LLMEvent.toolResult({ id: "call-1", name: "write", result: { type: "json", value: { ok: true } } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
  LLMEvent.stepStart({ index: 1 }),
  LLMEvent.textStart({ id: "text-2" }),
  LLMEvent.textDelta({ id: "text-2", text: "done" }),
  LLMEvent.textEnd({ id: "text-2" }),
  LLMEvent.stepFinish({ index: 1, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const coreMessage = (input: {
  readonly finish: string
  readonly text?: string
  readonly tool?: { readonly name: string; readonly status: "completed" | "pending" }
  readonly structured?: boolean
}) =>
  ({
    type: "assistant",
    id: "msg_core",
    agent: "build",
    model: { providerID: "fixture", modelID: "fixture" },
    content: [
      ...(input.text === undefined ? [] : [{ type: "text", id: "text-core", text: input.text }]),
      ...(input.tool === undefined
        ? []
        : [
            {
              type: "tool",
              id: "call-core",
              name: input.tool.name,
              state:
                input.tool.status === "completed"
                  ? {
                      status: "completed",
                      input: {},
                      content: [],
                      structured: {},
                    }
                  : { status: "pending", input: "{}" },
              time: { created: 0 },
            },
          ]),
    ],
    ...(input.structured ? { structured: { ok: true } } : {}),
    finish: input.finish,
    time: { created: 0 },
  }) as unknown as CoreMessage

const matureMessage = (input: {
  readonly finish: string
  readonly text?: string
  readonly tool?: { readonly name: string; readonly status: "completed" | "pending" }
  readonly structured?: boolean
  readonly summary?: boolean
}) =>
  ({
    info: {
      role: "assistant",
      id: "msg_mature",
      sessionID: "ses_parity",
      parentID: "msg_parent",
      modelID: "fixture",
      providerID: "fixture",
      mode: "build",
      agent: "build",
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0 },
      ...(input.structured ? { structured: { ok: true } } : {}),
      ...(input.summary ? { summary: true } : {}),
      finish: input.finish,
    },
    parts: [
      ...(input.text === undefined
        ? []
        : [{ type: "text", id: "prt_text", messageID: "msg_mature", sessionID: "ses_parity", text: input.text }]),
      ...(input.tool === undefined
        ? []
        : [
            {
              type: "tool",
              id: "prt_tool",
              messageID: "msg_mature",
              sessionID: "ses_parity",
              callID: "call-mature",
              tool: input.tool.name,
              state:
                input.tool.status === "completed"
                  ? {
                      status: "completed",
                      input: {},
                      output: "redacted",
                      title: input.tool.name,
                      metadata: {},
                      time: { start: 0, end: 1 },
                    }
                  : { status: "pending", input: {}, raw: "{}" },
            },
          ]),
    ],
  }) as unknown as MatureMessage

describe("SessionRunner semantic parity contract", () => {
  const executionEvidence = (
    overrides: {
      readonly checkpoint?: Partial<CheckpointSummary>
      readonly budget?: Partial<ParityMatrix.BudgetEvidence>
    } = {},
  ): ParityMatrix.ExecutionEvidence =>
    ParityMatrix.makeExecutionEvidence({
      checkpoint: {
        phase: "idle",
        nextStep: 1,
        needsContinuation: false,
        ...overrides.checkpoint,
      },
      budget: {
        attemptsUsed: 1,
        maxAttempts: 3,
        durationMsUsed: 100,
        maxDurationMs: 1_000,
        costMicrosUsed: 10,
        maxCostMicros: 100,
        tokensUsed: 20,
        maxTokens: 200,
        ...overrides.budget,
      },
    })

  const requestProjection = (
    overrides: Partial<ParityMatrix.RequestProjection> = {},
  ): ParityMatrix.RequestProjection => ({
    schemaVersion: 1,
    runID: "run_parity_matrix",
    turnStep: 1,
    attempt: 1,
    requestDigest: "a".repeat(64),
    contextDigest: "b".repeat(64),
    toolSetRevision: "c".repeat(64),
    routeConfigRevision: "d".repeat(64),
    compilerRevision: "context-compiler/v1",
    ...overrides,
  })

  it("projects text and tool turns from provider, formal, and mature shapes identically", () => {
    const provider = fromProviderEvents(textEvents, {
      adapter: "provider-replay",
      terminalStatus: "completed",
      requestCount: 1,
    })
    const formal = fromCoreMessages([coreMessage({ finish: "stop", text: "different formal text" })], {
      adapter: "formal-runner",
      terminalStatus: "completed",
      requestCount: 1,
    })
    const mature = fromMatureMessages([matureMessage({ finish: "stop", text: "different mature text" })], {
      adapter: "mature-prompt",
      terminalStatus: "completed",
      requestCount: 1,
    })

    expect(compare(provider, formal).equivalent).toBe(true)
    expect(compare(formal, mature).equivalent).toBe(true)
    expect(JSON.stringify(formal)).not.toContain("different formal text")
    expect(JSON.stringify(mature)).not.toContain("different mature text")

    const providerTool = fromProviderEvents(toolEvents, {
      adapter: "provider-replay",
      terminalStatus: "completed",
      requestCount: 2,
    })
    const formalTool = fromCoreMessages(
      [
        coreMessage({ finish: "tool-calls", tool: { name: "write", status: "completed" } }),
        coreMessage({ finish: "stop", text: "done" }),
      ],
      { adapter: "formal-runner", terminalStatus: "completed", requestCount: 2 },
    )
    const matureTool = fromMatureMessages(
      [
        matureMessage({ finish: "tool-calls", tool: { name: "write", status: "completed" } }),
        matureMessage({ finish: "stop", text: "done" }),
      ],
      { adapter: "mature-prompt", terminalStatus: "completed", requestCount: 2 },
    )
    expect(compare(providerTool, formalTool).equivalent).toBe(true)
    expect(compare(formalTool, matureTool).equivalent).toBe(true)
  })

  it("excludes mature compaction summary assistants from user-visible semantic steps", () => {
    const mature = fromMatureMessages(
      [
        matureMessage({ finish: "stop", text: "internal summary", summary: true }),
        matureMessage({ finish: "stop", text: "continued" }),
      ],
      { adapter: "mature-prompt", terminalStatus: "completed", requestCount: 2 },
    )

    expect(mature.steps).toHaveLength(1)
    expect(mature.steps[0]).toMatchObject({ finish: "stop", hasText: true })
  })

  it("compares checkpoint, retry, compaction, and action metadata without IDs or payloads", () => {
    const baseline = make({
      adapter: "formal-runner",
      terminalStatus: "completed",
      steps: [{ finish: "stop", hasText: true, hasReasoning: false, structured: true, failed: false, tools: [] }],
      requestCount: 2,
      transportRetryCount: 1,
      compactionCount: 1,
      actionStatusCounts: { proposed: 1, executing: 1, observed: 1, settled: 1 },
      checkpoint: { phase: "idle", nextStep: 1, needsContinuation: false },
    })
    const candidate = make({
      adapter: "mature-prompt",
      terminalStatus: "completed",
      steps: [{ finish: "stop", hasText: true, hasReasoning: false, structured: true, failed: false, tools: [] }],
      requestCount: 2,
      transportRetryCount: 1,
      compactionCount: 1,
      actionStatusCounts: { proposed: 1, executing: 1, observed: 1, settled: 1 },
      checkpoint: { phase: "idle", nextStep: 999, needsContinuation: false },
    })
    expect(compare(baseline, candidate)).toMatchObject({ equivalent: false, differences: ["checkpoint"] })
    expect(baseline.traceDigest).toHaveLength(64)
  })

  it("preserves failed tool settlement semantics without retaining the error payload", () => {
    const failed = fromProviderEvents(
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-failed", name: "write", input: { path: "redacted" } }),
        LLMEvent.toolResult({
          id: "call-failed",
          name: "write",
          result: { type: "error", value: "sensitive failure detail" },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      { adapter: "provider-replay", terminalStatus: "failed", requestCount: 1 },
    )

    expect(failed.steps[0]).toMatchObject({
      finish: "error",
      failed: true,
      tools: [{ name: "write", status: "failed" }],
    })
    expect(JSON.stringify(failed)).not.toContain("sensitive failure detail")
  })

  it("normalizes one successful StructuredOutput provider tool call to the shared terminal stop", () => {
    const structured = fromProviderEvents(
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-structured", name: "StructuredOutput", input: { answer: "ok" } }),
        LLMEvent.toolResult({
          id: "call-structured",
          name: "StructuredOutput",
          result: { type: "json", value: { answer: "ok" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      { adapter: "provider-replay", terminalStatus: "completed", requestCount: 1 },
    )

    expect(structured.steps).toEqual([
      {
        finish: "stop",
        hasText: false,
        hasReasoning: false,
        structured: true,
        failed: false,
        tools: [{ name: "StructuredOutput", status: "completed" }],
      },
    ])
  })

  it("requires one equivalent provider/formal/mature trace for every switch gate scenario", () => {
    const scenarios = ParityMatrix.requiredScenarios.map((scenario, index) => {
      const steps =
        scenario === "cancel"
          ? [
              {
                finish: "error" as const,
                hasText: false,
                hasReasoning: false,
                structured: false,
                failed: true,
                tools: [],
              },
            ]
          : scenario === "structured-output"
            ? [
                {
                  finish: "stop" as const,
                  hasText: false,
                  hasReasoning: false,
                  structured: true,
                  failed: false,
                  tools: [{ name: "StructuredOutput", status: "completed" as const }],
                },
              ]
            : scenario === "steer"
              ? [
                  {
                    finish: "tool-calls" as const,
                    hasText: false,
                    hasReasoning: false,
                    structured: false,
                    failed: false,
                    tools: [{ name: "write", status: "completed" as const }],
                  },
                  {
                    finish: "stop" as const,
                    hasText: true,
                    hasReasoning: false,
                    structured: false,
                    failed: false,
                    tools: [],
                  },
                ]
              : [
                  {
                    finish: "stop" as const,
                    hasText: true,
                    hasReasoning: false,
                    structured: false,
                    failed: false,
                    tools: [],
                  },
                ]
      const provider = make({
        adapter: "provider-replay",
        terminalStatus: scenario === "cancel" ? "paused" : "completed",
        steps,
        requestCount: scenario === "steer" || scenario === "compaction" ? 2 : 1,
        transportRetryCount: scenario === "cancel" ? 1 : 0,
        compactionCount: scenario === "compaction" ? 1 : 0,
        actionStatusCounts:
          scenario === "action-replay"
            ? { proposed: 1, authorized: 1, executing: 1, observed: 1, settled: 1 }
            : undefined,
        checkpoint: {
          phase: scenario === "compaction" ? "continuation" : "idle",
          nextStep: index + 1,
          needsContinuation: scenario === "cancel",
        },
      })
      return {
        scenario,
        provider,
        formal: make({ ...provider, adapter: "formal-runner" }),
        mature: make({ ...provider, adapter: "mature-prompt" }),
      } satisfies ParityMatrix.Entry
    })

    const result = ParityMatrix.assertComplete(scenarios)
    expect(result.complete).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.duplicate).toEqual([])
    expect(result.unknown).toEqual([])
    expect(result.differences).toEqual([])
    expect(result.comparisons).toHaveLength(ParityMatrix.requiredScenarios.length)
  })

  it("requires checkpoint and budget evidence when the formal switch gate is enabled", () => {
    const base = make({
      adapter: "provider-replay",
      terminalStatus: "completed",
      steps: [{ finish: "stop", hasText: true, hasReasoning: false, structured: false, failed: false, tools: [] }],
    })
    const entries = ParityMatrix.requiredScenarios.map((scenario): ParityMatrix.Entry => {
      const evidence = executionEvidence()
      return {
        scenario,
        provider: base,
        formal: make({ ...base, adapter: "formal-runner" }),
        mature: make({ ...base, adapter: "mature-prompt" }),
        evidence: { provider: evidence, formal: evidence, mature: evidence },
      }
    })

    const result = ParityMatrix.assertComplete(entries, { requireEvidence: true })
    expect(result.complete).toBe(true)
    expect(result.evidenceMissing).toEqual([])
  })

  it("enforces request projection parity as a first-class matrix gate", () => {
    const base = make({
      adapter: "provider-replay",
      terminalStatus: "completed",
      steps: [{ finish: "stop", hasText: true, hasReasoning: false, structured: false, failed: false, tools: [] }],
    })
    const projection = requestProjection()
    const entries = ParityMatrix.requiredScenarios.map(
      (scenario): ParityMatrix.Entry => ({
        scenario,
        provider: base,
        formal: make({ ...base, adapter: "formal-runner" }),
        mature: make({ ...base, adapter: "mature-prompt" }),
        requestProjections: { provider: projection, formal: projection, mature: projection },
      }),
    )

    const complete = ParityMatrix.assertComplete(entries, { requireRequestProjections: true })
    expect(complete.complete).toBe(true)
    expect(complete.differences).toEqual([])
    expect(complete.requestProjectionMissing).toEqual([])

    const missingProjectionEntries = entries.map((entry) => ({ ...entry, requestProjections: undefined }))
    const missingProjection = ParityMatrix.evaluate(missingProjectionEntries, { requireRequestProjections: true })
    expect(missingProjection.complete).toBe(false)
    expect(missingProjection.requestProjectionMissing).toEqual(ParityMatrix.requiredScenarios)
    expect(() => ParityMatrix.assertComplete(missingProjectionEntries, { requireRequestProjections: true })).toThrow(
      "requestProjectionMissing=queue,steer,cancel,compaction,structured-output,action-replay",
    )

    const divergent = ParityMatrix.evaluate(
      entries.map((entry) =>
        entry.scenario === "queue"
          ? {
              ...entry,
              requestProjections: {
                ...entry.requestProjections!,
                formal: requestProjection({ requestDigest: "e".repeat(64) }),
              },
            }
          : entry,
      ),
    )
    expect(divergent.complete).toBe(false)
    expect(divergent.differences).toContain("queue: provider/formal request.requestDigest")

    const invalid = ParityMatrix.evaluate([
      {
        ...entries[0]!,
        requestProjections: {
          provider: projection,
          formal: requestProjection({ requestDigest: "invalid" }),
          mature: projection,
        },
      },
    ])
    expect(invalid.complete).toBe(false)
    expect(invalid.differences).toContain("queue: formal request projection requestDigest is not a sha256 hex digest")
  })

  it("accepts owner-specific projections only with matching exact transport digests", () => {
    const trace = make({
      adapter: "provider-replay",
      terminalStatus: "completed",
      requestCount: 1,
      steps: [{ finish: "stop", hasText: true, hasReasoning: false, structured: false, failed: false, tools: [] }],
    })
    const digest = "e".repeat(64)
    const entry: ParityMatrix.Entry = {
      scenario: "queue",
      provider: trace,
      formal: make({ ...trace, adapter: "formal-runner" }),
      mature: make({ ...trace, adapter: "mature-prompt" }),
      requestProjections: {
        provider: requestProjection(),
        formal: requestProjection({ runID: "run_formal" }),
        mature: requestProjection({
          runID: "run_mature",
          requestDigest: "f".repeat(64),
          contextDigest: "1".repeat(64),
          toolSetRevision: "2".repeat(64),
          routeConfigRevision: "3".repeat(64),
          compilerRevision: "mature-request-projection/v1",
        }),
      },
      transportRequestDigests: { provider: digest, formal: digest, mature: digest },
    }
    const accepted = ParityMatrix.evaluate([entry], { requireRequestProjections: true })
    expect(accepted.differences).toEqual([])
    const rejected = ParityMatrix.evaluate(
      [{ ...entry, transportRequestDigests: { ...entry.transportRequestDigests!, mature: "d".repeat(64) } }],
      { requireRequestProjections: true },
    )
    expect(rejected.differences).toContain("queue: provider/mature transport request.digest")
  })

  it("fails closed for missing, invalid, or divergent switch evidence", () => {
    const base = make({
      adapter: "provider-replay",
      terminalStatus: "completed",
      steps: [{ finish: "stop", hasText: true, hasReasoning: false, structured: false, failed: false, tools: [] }],
    })
    const completeEntry = (scenario: ParityMatrix.Scenario): ParityMatrix.Entry => {
      const providerEvidence = executionEvidence()
      return {
        scenario,
        provider: base,
        formal: make({ ...base, adapter: "formal-runner" }),
        mature: make({ ...base, adapter: "mature-prompt" }),
        evidence: {
          provider: providerEvidence,
          formal: executionEvidence(),
          mature: executionEvidence(),
        },
      }
    }

    const missingEvidenceEntries = ParityMatrix.requiredScenarios.map(completeEntry)
    missingEvidenceEntries[0] = { ...missingEvidenceEntries[0], evidence: undefined }
    const missing = ParityMatrix.evaluate(missingEvidenceEntries, { requireEvidence: true })
    expect(missing.complete).toBe(false)
    expect(missing.evidenceMissing).toEqual(["queue"])
    expect(() => ParityMatrix.assertComplete(missingEvidenceEntries, { requireEvidence: true })).toThrow(
      "evidenceMissing=queue",
    )

    const invalidEntries = ParityMatrix.requiredScenarios.map(completeEntry)
    invalidEntries[1] = {
      ...invalidEntries[1],
      evidence: {
        ...invalidEntries[1].evidence!,
        formal: {
          ...invalidEntries[1].evidence!.formal,
          checkpoint: { ...invalidEntries[1].evidence!.formal.checkpoint, digest: "b".repeat(64) },
        },
      },
    }
    const invalid = ParityMatrix.evaluate(invalidEntries, { requireEvidence: true })
    expect(invalid.complete).toBe(false)
    expect(invalid.differences).toContain("steer: formal evidence checkpoint digest does not match checkpoint fields")

    const divergentEntries = ParityMatrix.requiredScenarios.map(completeEntry)
    divergentEntries[2] = {
      ...divergentEntries[2],
      evidence: {
        ...divergentEntries[2].evidence!,
        mature: {
          ...divergentEntries[2].evidence!.mature,
          budget: { ...divergentEntries[2].evidence!.mature.budget, tokensUsed: 21 },
        },
      },
    }
    const divergent = ParityMatrix.evaluate(divergentEntries, { requireEvidence: true })
    expect(divergent.complete).toBe(false)
    expect(divergent.differences).toContain("cancel: provider/mature evidence budget.tokensUsed")

    const malformedEntries = ParityMatrix.requiredScenarios.map(completeEntry)
    malformedEntries[3] = {
      ...malformedEntries[3],
      evidence: { ...malformedEntries[3].evidence!, formal: undefined as never },
    }
    const malformed = ParityMatrix.evaluate(malformedEntries, { requireEvidence: true })
    expect(malformed.complete).toBe(false)
    expect(malformed.differences).toContain("compaction: formal evidence is invalid")
  })

  it("compares real replay evidence semantically across owner phases and wall-clock duration", () => {
    const trace = make({
      adapter: "provider-replay",
      terminalStatus: "completed",
      requestCount: 1,
      steps: [{ finish: "stop", hasText: true, hasReasoning: false, structured: false, failed: false, tools: [] }],
      checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
    })
    const provider = executionEvidence({ checkpoint: { nextStep: 2 }, budget: { durationMsUsed: 12 } })
    const mature = executionEvidence({
      checkpoint: { phase: "mature-session-loop", nextStep: 2 },
      budget: { durationMsUsed: 845 },
    })
    const result = ParityMatrix.evaluate(
      [
        {
          scenario: "queue",
          provider: trace,
          formal: make({ ...trace, adapter: "formal-runner" }),
          mature: make({ ...trace, adapter: "mature-prompt" }),
          evidence: { provider, formal: provider, mature },
        },
      ],
      { requireEvidence: true },
    )
    expect(result.differences).toEqual([])
    expect(result.evidenceMissing).toEqual([])
  })

  it("fails closed for missing, duplicate, unknown, or semantically divergent entries", () => {
    const base = make({
      adapter: "provider-replay",
      terminalStatus: "completed",
      steps: [{ finish: "stop", hasText: true, hasReasoning: false, structured: false, failed: false, tools: [] }],
    })
    const completeEntry = (scenario: ParityMatrix.Scenario): ParityMatrix.Entry => ({
      scenario,
      provider: base,
      formal: make({ ...base, adapter: "formal-runner" }),
      mature: make({ ...base, adapter: "mature-prompt" }),
    })
    const withoutQueue = ParityMatrix.requiredScenarios.filter((scenario) => scenario !== "queue").map(completeEntry)
    const missing = ParityMatrix.evaluate(withoutQueue)
    expect(missing.complete).toBe(false)
    expect(missing.missing).toEqual(["queue"])
    expect(() => ParityMatrix.assertComplete(withoutQueue)).toThrow("missing=queue")

    const duplicate = ParityMatrix.evaluate([
      ...ParityMatrix.requiredScenarios.map(completeEntry),
      completeEntry("queue"),
    ])
    expect(duplicate.duplicate).toEqual(["queue"])

    const unknown = ParityMatrix.evaluate([
      ...ParityMatrix.requiredScenarios.map(completeEntry),
      { ...completeEntry("queue"), scenario: "future" as ParityMatrix.Scenario },
    ])
    expect(unknown.unknown).toEqual(["future"])

    const divergent = ParityMatrix.evaluate([
      ...ParityMatrix.requiredScenarios.map((scenario) =>
        scenario === "cancel"
          ? {
              ...completeEntry(scenario),
              mature: make({ ...base, adapter: "mature-prompt", terminalStatus: "paused" }),
            }
          : completeEntry(scenario),
      ),
    ])
    expect(divergent.complete).toBe(false)
    expect(divergent.differences).toContain("cancel: provider/mature terminalStatus")
  })
})
