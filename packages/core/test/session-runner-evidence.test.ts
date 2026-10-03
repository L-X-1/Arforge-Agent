import { describe, expect, it } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as SessionCheckpoint from "@arforge-ai/core/session/checkpoint"
import * as Evidence from "@arforge-ai/core/session/runner/evidence"
import { checkpointDigest } from "@arforge-ai/core/session/runner/parity-matrix"
import { createRequestEnvelope, requestEnvelopeJson } from "@arforge-ai/core/session/request-envelope"
import { LLM } from "@arforge-ai/llm"
import * as OpenAICompatibleChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import { Auth } from "@arforge-ai/llm/route"

const sessionID = "ses_evidence"
const runID = "run_evidence"
const digest = "a".repeat(64)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 3,
  maxDurationMs: 1_000,
  maxCostMicros: 100,
  maxTokens: 200,
  attemptsUsed: 1,
  durationMsUsed: 100,
  costMicrosUsed: 10,
  tokensUsed: 20,
})

const checkpoint = SessionCheckpoint.decode(
  SessionCheckpoint.make({
    sessionID,
    nextStep: 2,
    nextPromotion: "steer",
    needsContinuation: true,
    lastTurn: {
      turnStep: 1,
      requestDigest: digest,
      contextDigest: digest,
      toolSetRevision: digest,
      routeConfigRevision: digest,
      compilerRevision: "context-compiler/v1",
    },
  }),
  sessionID,
)

const matureCheckpoint = SessionCheckpoint.decode(
  SessionCheckpoint.makeMature({
    sessionID,
    nextStep: 2,
    needsContinuation: false,
    admittedThroughSequence: 8,
  }),
  sessionID,
)

const matureBinding: Evidence.MatureRequestBinding = {
  schemaVersion: 1,
  runID,
  turnStep: 1,
  attempt: 1,
  runtime: "ai-sdk",
  mode: "prepared-projection",
  requestDigest: digest,
  contextDigest: digest,
  toolSetRevision: digest,
  routeConfigRevision: digest,
  skillSnapshotDigest: digest,
  compilerRevision: "mature-request-projection/v1",
}

describe("SessionRunner durable parity evidence", () => {
  it("projects only the validated semantic cursor and bounded budget", () => {
    const evidence = Evidence.fromDurable({ checkpoint, budget })
    expect(evidence.checkpoint).toEqual({
      phase: "continuation",
      nextStep: 2,
      needsContinuation: true,
      digest: checkpointDigest({ phase: "continuation", nextStep: 2, needsContinuation: true }),
    })
    expect(evidence.budget).toEqual({
      attemptsUsed: 1,
      maxAttempts: 3,
      durationMsUsed: 100,
      maxDurationMs: 1_000,
      costMicrosUsed: 10,
      maxCostMicros: 100,
      tokensUsed: 20,
      maxTokens: 200,
    })
    expect(JSON.stringify(evidence)).not.toContain("requestDigest")
    expect(JSON.stringify(evidence)).not.toContain("contextDigest")
  })

  it("fails closed when the durable cursor is missing or legacy", () => {
    expect(() => Evidence.fromDurable({ checkpoint: undefined, budget })).toThrow(
      "versioned semantic checkpoint is required",
    )
    const legacy = SessionCheckpoint.decode({ sessionID, nextStep: 1, needsContinuation: false }, sessionID)
    expect(() => Evidence.fromDurable({ checkpoint: legacy, budget })).toThrow(
      "versioned semantic checkpoint is required",
    )
  })

  it("composes mature binding metadata with the semantic cursor and budget", () => {
    const result = Evidence.fromMatureDurable({
      checkpoint: matureCheckpoint,
      budget,
      runID,
      binding: matureBinding,
    })
    expect(result.execution.checkpoint).toMatchObject({
      phase: "mature-session-loop",
      nextStep: 2,
      needsContinuation: false,
    })
    expect(result.binding).toMatchObject({ runID, turnStep: 1, attempt: 1, mode: "prepared-projection" })
    expect(JSON.stringify(result)).not.toContain("prompt")
    expect(Object.isFrozen(result)).toBe(true)
  })

  it("rejects stale, over-budget, or ahead-of-cursor mature bindings", () => {
    expect(() =>
      Evidence.fromMatureDurable({ checkpoint: matureCheckpoint, budget, runID: "run_other", binding: matureBinding }),
    ).toThrow("does not match the durable run")
    expect(() =>
      Evidence.fromMatureDurable({
        checkpoint: matureCheckpoint,
        budget: AgentRuntime.Budget.make({ ...budget, attemptsUsed: 0 }),
        runID,
        binding: matureBinding,
      }),
    ).toThrow("not admitted by the durable budget")
    expect(() =>
      Evidence.fromMatureDurable({
        checkpoint: matureCheckpoint,
        budget,
        runID,
        binding: { ...matureBinding, turnStep: 3 },
      }),
    ).toThrow("ahead of the semantic checkpoint")
  })

  it("projects formal envelopes and mature bindings into one comparable metadata shape", () => {
    const formalModel = OpenAICompatibleChat.route
      .with({ endpoint: { baseURL: "https://api.example.test/v1" }, auth: Auth.bearer("fixture") })
      .model({ id: "fixture-model", provider: "fixture" })
    const envelope = createRequestEnvelope({
      request: LLM.request({ model: formalModel, prompt: "redacted", generation: { maxTokens: 20 } }),
      execution: {
        run_id: runID,
        turn_step: 1,
        attempt: 1,
        context_digest: digest,
        tool_set_revision: digest,
        route_config_revision: digest,
        skill_snapshot_digest: digest,
        compiler_revision: "context-compiler/v1",
      },
    })
    const formal = Evidence.fromFormalEnvelope(envelope, runID)
    const formalFromEvent = Evidence.fromFormalEvent(
      { envelope: requestEnvelopeJson(envelope), requestDigest: envelope.request_digest },
      runID,
    )
    const formalDurable = Evidence.fromFormalDurable({
      checkpoint,
      budget,
      event: { envelope: requestEnvelopeJson(envelope), requestDigest: envelope.request_digest },
      runID,
    })
    const mature = Evidence.fromMatureBinding(
      {
        ...matureBinding,
        requestDigest: formal.requestDigest,
        compilerRevision: formal.compilerRevision,
      },
      runID,
    )
    expect(formalFromEvent).toEqual(formal)
    expect(formalDurable.request).toEqual(formal)
    expect(formalDurable.execution).toEqual(Evidence.fromDurable({ checkpoint, budget }))
    expect(Evidence.compareRequestProjection(formal, mature)).toEqual([])
    expect(JSON.stringify(formal)).not.toContain("redacted")
  })

  it("fails closed when a formal durable event digest or envelope is tampered", () => {
    const formalModel = OpenAICompatibleChat.route
      .with({ endpoint: { baseURL: "https://api.example.test/v1" }, auth: Auth.bearer("fixture") })
      .model({ id: "fixture-model", provider: "fixture" })
    const envelope = createRequestEnvelope({
      request: LLM.request({ model: formalModel, prompt: "redacted", generation: { maxTokens: 20 } }),
      execution: {
        run_id: runID,
        turn_step: 1,
        attempt: 1,
        context_digest: digest,
        tool_set_revision: digest,
        route_config_revision: digest,
        compiler_revision: "context-compiler/v1",
      },
    })
    const serialized = requestEnvelopeJson(envelope)
    expect(() => Evidence.fromFormalEvent({ envelope: serialized, requestDigest: "b".repeat(64) })).toThrow(
      "does not match the persisted envelope",
    )
    expect(() =>
      Evidence.fromFormalEvent({ envelope: `${serialized} `, requestDigest: envelope.request_digest }),
    ).toThrow("request envelope JSON is not canonical")
  })

  it("fails closed for legacy formal envelopes without bounded attempt metadata", () => {
    const formalModel = OpenAICompatibleChat.route
      .with({ endpoint: { baseURL: "https://api.example.test/v1" }, auth: Auth.bearer("fixture") })
      .model({ id: "fixture-model", provider: "fixture" })
    const envelope = createRequestEnvelope({
      request: LLM.request({ model: formalModel, prompt: "redacted" }),
      execution: { run_id: runID, turn_step: 1 },
    })
    expect(() => Evidence.fromFormalEnvelope(envelope)).toThrow("positive safe integer")
  })
})
