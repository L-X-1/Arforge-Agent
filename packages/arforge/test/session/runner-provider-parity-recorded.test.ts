import { HttpRecorder } from "@arforge-ai/http-recorder"
import {
  LLM,
  LLMClient,
  LLMEvent,
  Message,
  Tool,
  ToolRuntime,
  toDefinitions,
  type LLMRequest,
  type ToolCallPart,
  type ToolDispatchResult,
} from "@arforge-ai/llm"
import { Auth, RequestExecutor } from "@arforge-ai/llm/route"
import * as OpenAICompatibleChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { isJSONValue } from "@ai-sdk/provider"
import * as SessionEvent from "@arforge-ai/schema/session-event"
import { SessionID } from "@arforge-ai/schema/session-id"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as SessionRunnerParity from "@arforge-ai/core/session/runner/parity"
import * as SessionRunnerParityMatrix from "@arforge-ai/core/session/runner/parity-matrix"
import * as SessionRunnerEvidence from "@arforge-ai/core/session/runner/evidence"
import * as SessionRunnerHistory from "@arforge-ai/core/session/runner/history"
import * as SessionCheckpoint from "@arforge-ai/core/session/checkpoint"
import { DateTime, Schema, Stream, Effect, Layer } from "effect"
import { describe, expect, test } from "bun:test"
import path from "node:path"

import { LLMNative } from "@/session/llm/native-request"
import * as MatureRequestBinding from "@/session/llm/mature-binding"
import { ProviderTest } from "../fake/provider"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { subagentOrchestrationPrompt } from "@arforge-ai/core/reasoning-profile"
import {
  assertRequestEnvelope,
  createRequestEnvelope,
  parseRequestEnvelopeJson,
  rebuildRequest,
  requestEnvelopeJson,
} from "@arforge-ai/core/session/request-envelope"

const cassetteDirectory = path.resolve(import.meta.dir, "../../../core/test/fixtures/recordings")
const llmCassetteDirectory = path.resolve(import.meta.dir, "../../../llm/test/fixtures/recordings")
const cassetteName = "session-runner/openai-chat-streams-text"
const toolCassetteName = "openai-chat/drives-a-tool-loop-end-to-end"
const fullQueueCassetteName = "session/full-runner-queue-parity-openai-text"
const fullQueueCassetteDirectory = path.resolve(import.meta.dir, "../fixtures/recordings")
const endpoint = "https://api.openai.com/v1"
const prompt = "Say hello in one short sentence."
const paritySessionID = "ses_parity_recorded"
const parityRunID = "run_parity_recorded"

const makeClientLayer = (name = cassetteName, directory = cassetteDirectory) => {
  const cassette = HttpRecorder.http(name, { directory })
  return LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(cassette))))
}

const formalModel = OpenAICompatibleChat.route
  .with({ endpoint: { baseURL: endpoint }, auth: Auth.bearer("fixture-api-key") })
  .model({ id: "gpt-4o-mini", provider: "openai" })

const matureModel = ProviderTest.model({
  id: ModelV2.ID.make("gpt-4o-mini"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-4o-mini", url: endpoint, npm: "@ai-sdk/openai-compatible" },
  options: { apiKey: "fixture-api-key", baseURL: endpoint },
})

const formalRequest = LLM.request({
  model: formalModel,
  prompt,
  generation: { maxTokens: 20, temperature: 0 },
})

const matureRequest = LLMNative.request({
  model: matureModel,
  apiKey: "fixture-api-key",
  baseURL: endpoint,
  messages: [{ role: "user", content: prompt }],
  maxOutputTokens: 20,
  temperature: 0,
})

const fullQueueSystem = [
  "You are the deterministic queue parity agent. Answer the user directly and concisely.",
  subagentOrchestrationPrompt({ variant: "default", background: false, child: false }),
].join("\n")
const fullQueueRequestSystem = "Request-scoped instruction: answer this turn without tools."
const fullQueueEndpoint = "http://arforge-queue-parity.invalid/v1"
const fullQueueFormalModel = OpenAICompatibleChat.route
  .with({ endpoint: { baseURL: fullQueueEndpoint }, auth: Auth.bearer("fixture-api-key") })
  .model({ id: "gpt-4o-mini", provider: "openai" })
const fullQueueFormalRequest = LLM.request({
  model: fullQueueFormalModel,
  system: `${fullQueueSystem}\n${fullQueueRequestSystem}`,
  prompt,
  providerOptions: { openai: { store: false } },
  generation: { maxTokens: 20, temperature: 0 },
})
const fullQueueMatureRequest = LLMNative.request({
  model: matureModel,
  apiKey: "fixture-api-key",
  baseURL: fullQueueEndpoint,
  system: [fullQueueSystem, fullQueueRequestSystem],
  messages: [{ role: "user", content: prompt }],
  providerOptions: { openai: { store: false } },
  maxOutputTokens: 20,
  temperature: 0,
})

const weatherTool = Tool.make({
  description: "Get current weather for a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
  execute: ({ city }) =>
    Effect.succeed(
      city === "Paris" ? { temperature: 22, condition: "sunny" } : { temperature: 0, condition: "unknown" },
    ),
})

const weatherDefinitions = toDefinitions({ get_weather: weatherTool })
const weatherSystem = "Use the get_weather tool, then answer in one short sentence."
const weatherPrompt = "What is the weather in Paris?"
const formalToolRequest = LLM.request({
  model: formalModel,
  system: weatherSystem,
  prompt: weatherPrompt,
  tools: weatherDefinitions,
  generation: { maxTokens: 80, temperature: 0 },
})
const matureToolRequest = LLMNative.request({
  model: matureModel,
  apiKey: "fixture-api-key",
  baseURL: endpoint,
  messages: [{ role: "user", content: weatherPrompt }],
  system: [weatherSystem],
  tools: {
    get_weather: {
      description: weatherTool.description,
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      outputSchema: weatherDefinitions[0]!.outputSchema,
    },
  },
  maxOutputTokens: 80,
  temperature: 0,
})

const replay = (request: typeof formalRequest, name = cassetteName, directory = cassetteDirectory) =>
  Effect.gen(function* () {
    const client = yield* LLMClient.Service
    const prepared = yield* client.prepare(request)
    const events = yield* client.stream(request).pipe(Stream.runCollect)
    return { prepared, events: Array.from(events) }
  }).pipe(Effect.provide(makeClientLayer(name, directory)))

const replayToolTurn = (request: typeof formalToolRequest) => replay(request, toolCassetteName, llmCassetteDirectory)

const replayToolLoop = (
  initial: LLMRequest,
  nextRequest: (call: ToolCallPart, dispatched: ToolDispatchResult) => LLMRequest,
) =>
  Effect.gen(function* () {
    const client = yield* LLMClient.Service
    const firstPrepared = yield* client.prepare(initial)
    const firstEvents = Array.from(yield* client.stream(initial).pipe(Stream.runCollect))
    const call = firstEvents.find(LLMEvent.is.toolCall)
    if (!call) throw new Error("recorded tool cassette did not emit a tool call")
    const dispatched = yield* ToolRuntime.dispatch({ get_weather: weatherTool }, call)
    const next = nextRequest(call, dispatched)
    const secondPrepared = yield* client.prepare(next)
    const secondEvents = Array.from(yield* client.stream(next).pipe(Stream.runCollect))
    return {
      first: { prepared: firstPrepared, events: firstEvents },
      dispatched,
      second: { prepared: secondPrepared, events: secondEvents },
    }
  }).pipe(Effect.provide(makeClientLayer(toolCassetteName, llmCassetteDirectory)))

const usageTokens = (events: ReadonlyArray<LLMEvent>) => {
  const finish = events.findLast((event) => event.type === "finish")
  return finish?.usage?.totalTokens ?? 0
}

type DurableSideInput = {
  readonly side: "provider" | "formal" | "mature"
  readonly sessionID: string
  readonly runID: string
  readonly tokens: number
  readonly checkpoint: Readonly<Record<string, unknown>>
  readonly envelope: string
  readonly requestDigest: string
  readonly formalTurnStep: number
  readonly formalAttempt: number
  readonly binding: MatureRequestBinding.Binding
  readonly outcome?: "completed" | "interrupted"
  readonly terminalStatus?: "completed" | "paused"
}

type DurableSideWriteContext = Readonly<{
  readonly runtime: DurableRun.Interface
  readonly events: EventV2.Interface
  readonly runID: AgentRuntime.RunID
  readonly sessionID: SessionID
}>

/**
 * Acceptance-only writer that deliberately goes through the production
 * DurableRun and EventV2 owners. It has no read or evidence responsibilities;
 * callers may replace the reader without changing this write contract.
 */
const writeDurableSide = (input: DurableSideInput, context: DurableSideWriteContext) =>
  Effect.gen(function* () {
    const { runtime, events, runID, sessionID } = context
    const budget = AgentRuntime.Budget.make({
      maxAttempts: 3,
      maxDurationMs: 30_000,
      maxCostMicros: 5_000_000,
      maxTokens: Math.max(1_000_000, input.tokens),
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
      tokensUsed: 0,
    })
    const created = yield* runtime.create({
      id: runID,
      sessionID,
      initiator: "user",
      authority: "automatic",
      riskTier: "L0",
      reasonSummary: "recorded cassette parity",
      budget,
      traceID: "trace_parity_recorded",
      visibility: "summary",
    })
    yield* runtime.transition({ runID, to: "preflight", reason: `${input.side} acceptance preflight` })
    yield* runtime.transition({ runID, to: "queued", reason: `${input.side} acceptance queued` })
    yield* runtime.transition({ runID, to: "running", reason: `${input.side} acceptance running` })
    yield* runtime.beginAttempt({ runID })
    if (input.side === "formal")
      yield* events.publish(SessionEvent.RequestEnvelopePrepared, {
        timestamp: DateTime.makeUnsafe(1),
        sessionID,
        runID,
        turnStep: input.formalTurnStep,
        attempt: input.formalAttempt,
        schemaVersion: "1.0",
        requestDigest: input.requestDigest,
        envelope: input.envelope,
      })
    if (input.side === "mature")
      yield* events.publish(SessionEvent.RequestBindingPrepared, {
        timestamp: DateTime.makeUnsafe(2),
        sessionID,
        runID,
        turnStep: input.binding.turnStep,
        attempt: input.binding.attempt,
        schemaVersion: 1,
        runtime: "native",
        mode: input.binding.mode,
        requestDigest: input.binding.requestDigest,
        contextDigest: input.binding.contextDigest,
        toolSetRevision: input.binding.toolSetRevision,
        routeConfigRevision: input.binding.routeConfigRevision,
        compilerRevision: input.binding.compilerRevision,
      })
    yield* runtime.checkpoint({ runID, state: input.checkpoint })
    yield* runtime.finishAttempt({
      runID,
      attempt: 1,
      outcome: input.outcome ?? "completed",
      durationMs: 0,
      costMicros: 0,
      tokens: input.tokens,
    })
    if ((input.terminalStatus ?? "completed") === "completed") {
      yield* runtime.transition({ runID, to: "verifying", reason: `${input.side} acceptance verification` })
      yield* runtime.transition({ runID, to: "completed", reason: `${input.side} acceptance completed` })
    } else {
      yield* runtime.transition({ runID, to: "paused", reason: `${input.side} acceptance cancelled` })
    }
    return created
  })

type DurableSideReaderInput = Readonly<{
  readonly events: EventV2.Interface
  readonly db: Database.Interface["db"]
  readonly sessionID: string
  readonly runID: string
}>

type DurableSideReader = (
  input: DurableSideReaderInput,
) => Effect.Effect<ReadonlyArray<EventV2.SerializedEvent>, unknown, never>

/** Default reader; production EventV2 remains the sole storage owner. */
const readDurableSide: DurableSideReader = (input) =>
  SessionRunnerHistory.runnerEventRowSourceFromEventV2(input.events).collect({
    sessionID: input.sessionID,
    runID: input.runID,
  })

/**
 * Compose the isolated writer with an injected reader. The default path is
 * EventV2 service-backed, while a future full-loop harness can supply its own
 * committed-row source without reimplementing evidence projection.
 */
const recordDurableSide = (input: DurableSideInput, reader: DurableSideReader = readDurableSide) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const runID = AgentRuntime.RunID.make(input.runID)
      const sessionID = SessionID.make(input.sessionID)
      const created = yield* writeDurableSide(input, { runtime, events, runID, sessionID })
      let rows: ReadonlyArray<EventV2.SerializedEvent> | undefined
      const source = SessionRunnerHistory.makeRunnerEventRowSource((query) =>
        reader({ events, db, sessionID: query.sessionID, runID: query.runID }).pipe(
          Effect.tap((value) => Effect.sync(() => void (rows = value))),
        ),
      )
      const terminal = yield* SessionRunnerHistory.collectTerminalHistory(
        source,
        { sessionID: input.sessionID, runID: input.runID },
        {
          status: input.terminalStatus ?? "completed",
          attempt: 1,
          requireCheckpoint: (input.terminalStatus ?? "completed") === "completed",
        },
      )
      if (!rows) throw new Error("Recorded durable side source did not return committed rows")
      expect(created.run.id).toBe(runID)
      expect(terminal).toMatchObject({
        sessionID: input.sessionID,
        runID: input.runID,
        status: input.terminalStatus ?? "completed",
        attempt: 1,
      })
      return rows
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.node]), [
          [Database.node, Database.layerFromPath(":memory:")],
        ]),
      ),
    ),
  )

function providerJSON(value: unknown) {
  if (!isJSONValue(value)) throw new Error("Recorded provider parity tool result is not JSON")
  return value
}

describe("SessionRunner formal/mature provider cassette parity", () => {
  test("rebuilds the aligned full-runner queue request identically before loop integration", async () => {
    const [formal, mature] = await Effect.runPromise(
      Effect.all(
        [
          replay(fullQueueFormalRequest, fullQueueCassetteName, fullQueueCassetteDirectory),
          replay(fullQueueMatureRequest, fullQueueCassetteName, fullQueueCassetteDirectory),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect(formal.prepared.body).toEqual(mature.prepared.body)
    expect(JSON.stringify(formal.prepared.body).split(fullQueueRequestSystem)).toHaveLength(2)
    expect(formal.events).toEqual(mature.events)
  })

  test("replays the recorded tool continuation through formal and mature request adapters", async () => {
    const formalLoop = await Effect.runPromise(
      replayToolLoop(formalToolRequest, (call, dispatched) =>
        LLM.request({
          model: formalModel,
          system: weatherSystem,
          messages: [
            Message.user(weatherPrompt),
            Message.assistant([{ type: "tool-call", id: call.id, name: call.name, input: call.input }]),
            Message.tool({ id: call.id, name: call.name, result: dispatched.result }),
          ],
          tools: weatherDefinitions,
          generation: { maxTokens: 80, temperature: 0 },
        }),
      ),
    )
    const matureLoop = await Effect.runPromise(
      replayToolLoop(matureToolRequest, (call, dispatched) =>
        LLMNative.request({
          model: matureModel,
          apiKey: "fixture-api-key",
          baseURL: endpoint,
          messages: [
            { role: "user", content: weatherPrompt },
            {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input }],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: call.id,
                  toolName: call.name,
                  output: {
                    type: "json",
                    value: providerJSON(dispatched.result.value),
                  },
                },
              ],
            },
          ],
          system: [weatherSystem],
          tools: {
            get_weather: {
              description: weatherTool.description,
              inputSchema: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
                additionalProperties: false,
              },
              outputSchema: weatherDefinitions[0]!.outputSchema,
            },
          },
          maxOutputTokens: 80,
          temperature: 0,
        }),
      ),
    )
    expect(formalLoop.first.prepared.body).toEqual(matureLoop.first.prepared.body)
    expect(formalLoop.second.prepared.body).toEqual(matureLoop.second.prepared.body)
    expect(formalLoop.first.events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
    expect(matureLoop.first.events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
    expect(formalLoop.second.events.filter(LLMEvent.is.toolCall)).toHaveLength(0)
    expect(matureLoop.second.events.filter(LLMEvent.is.toolCall)).toHaveLength(0)
    expect(formalLoop.dispatched.events.filter(LLMEvent.is.toolResult)).toHaveLength(1)
    expect(matureLoop.dispatched.events).toEqual(formalLoop.dispatched.events)

    const project = (events: ReadonlyArray<LLMEvent>) =>
      events.map((event) => ({
        type: event.type,
        ...(event.type === "text-delta" ? { hasText: event.text.length > 0 } : {}),
        ...(event.type === "tool-call" ? { name: event.name } : {}),
        ...(event.type === "finish" ? { finish: event.reason } : {}),
      }))
    const offsetStep = (events: ReadonlyArray<LLMEvent>, offset: number) =>
      events.map((event) =>
        event.type === "step-start" || event.type === "step-finish" ? { ...event, index: event.index + offset } : event,
      )
    const formalEvents = [
      ...formalLoop.first.events,
      ...formalLoop.dispatched.events,
      ...offsetStep(formalLoop.second.events, 1),
    ]
    const matureEvents = [
      ...matureLoop.first.events,
      ...matureLoop.dispatched.events,
      ...offsetStep(matureLoop.second.events, 1),
    ]
    const formalTrace = SessionRunnerParity.fromProviderEvents(formalEvents, {
      adapter: "formal-runner",
      terminalStatus: "completed",
      requestCount: 2,
      checkpoint: { phase: "idle", nextStep: 3, needsContinuation: false },
    })
    const matureTrace = SessionRunnerParity.fromProviderEvents(matureEvents, {
      adapter: "mature-prompt",
      terminalStatus: "completed",
      requestCount: 2,
      checkpoint: { phase: "idle", nextStep: 3, needsContinuation: false },
    })
    const providerTrace = SessionRunnerParity.fromProviderEvents(formalEvents, {
      adapter: "provider-replay",
      terminalStatus: "completed",
      requestCount: 2,
      checkpoint: { phase: "idle", nextStep: 3, needsContinuation: false },
    })
    expect(project(formalEvents)).toEqual(project(matureEvents))
    expect(SessionRunnerParity.compare(formalTrace, matureTrace).equivalent).toBe(true)
    expect(formalTrace.steps).toMatchObject([
      { finish: "tool-calls", tools: [{ name: "get_weather", status: "completed" }] },
      { finish: "stop", hasText: true },
    ])

    const toolBinding = MatureRequestBinding.fromRequest({
      request: matureToolRequest,
      binding: { runID: "run_parity_tool_loop", turnStep: 1, attempt: 1 },
    })
    const toolEnvelope = createRequestEnvelope({
      request: formalToolRequest,
      execution: {
        run_id: toolBinding.runID,
        turn_step: toolBinding.turnStep,
        attempt: toolBinding.attempt,
        context_digest: toolBinding.contextDigest,
        tool_set_revision: toolBinding.toolSetRevision,
        route_config_revision: toolBinding.routeConfigRevision,
        compiler_revision: toolBinding.compilerRevision,
      },
    })
    const toolProjection = SessionRunnerEvidence.fromFormalEnvelope(toolEnvelope, toolBinding.runID)
    const toolCheckpoint = SessionCheckpoint.make({
      sessionID: "ses_parity_tool_loop",
      nextStep: 3,
      needsContinuation: false,
      lastTurn: {
        turnStep: toolProjection.turnStep,
        requestDigest: toolProjection.requestDigest,
        contextDigest: toolProjection.contextDigest,
        toolSetRevision: toolProjection.toolSetRevision,
        routeConfigRevision: toolProjection.routeConfigRevision,
        compilerRevision: toolProjection.compilerRevision,
      },
    })
    const toolWriterInput = {
      sessionID: "ses_parity_tool_loop",
      runID: "run_parity_tool_loop",
      tokens: usageTokens(formalLoop.first.events) + usageTokens(formalLoop.second.events),
      checkpoint: toolCheckpoint,
      envelope: requestEnvelopeJson(toolEnvelope),
      requestDigest: toolProjection.requestDigest,
      formalTurnStep: toolProjection.turnStep,
      formalAttempt: toolProjection.attempt,
      binding: toolBinding,
    } as const
    const [providerRows, formalRows, matureRows] = await Promise.all([
      recordDurableSide({ ...toolWriterInput, side: "provider" }),
      recordDurableSide({ ...toolWriterInput, side: "formal" }),
      recordDurableSide({ ...toolWriterInput, side: "mature" }),
    ])
    const durableEvidence = SessionRunnerHistory.evidenceFromEventRows({
      providerRows,
      formalRows,
      matureRows,
      sessionID: toolWriterInput.sessionID,
      runID: toolWriterInput.runID,
      providerRequest: Object.freeze({ ...toolProjection }),
    })
    const gate = SessionRunnerParityMatrix.evaluate(
      [
        {
          scenario: "steer",
          provider: providerTrace,
          formal: formalTrace,
          mature: matureTrace,
          evidence: durableEvidence.evidence,
          requestProjections: durableEvidence.requestProjections,
        },
      ],
      { requireEvidence: true, requireRequestProjections: true },
    )
    expect(gate.comparisons[0]?.formal.equivalent).toBe(true)
    expect(gate.comparisons[0]?.mature.equivalent).toBe(true)
    expect(gate.evidenceMissing).toEqual([])
    expect(gate.requestProjectionMissing).toEqual([])
    expect(gate.differences).toEqual([])
    expect(gate.missing).toEqual(["queue", "cancel", "compaction", "structured-output", "action-replay"])
  })

  test("rebuilds the formal request and replays the same redacted Provider cassette through both adapters", async () => {
    const binding = MatureRequestBinding.fromRequest({
      request: matureRequest,
      binding: { runID: parityRunID, turnStep: 1, attempt: 1 },
    })
    const envelope = createRequestEnvelope({
      request: formalRequest,
      execution: {
        run_id: binding.runID,
        turn_step: binding.turnStep,
        attempt: binding.attempt,
        context_digest: binding.contextDigest,
        tool_set_revision: binding.toolSetRevision,
        route_config_revision: binding.routeConfigRevision,
        compiler_revision: binding.compilerRevision,
      },
    })
    const restored = rebuildRequest(parseRequestEnvelopeJson(requestEnvelopeJson(envelope)), formalModel)
    assertRequestEnvelope(envelope, restored)
    const formalProjection = SessionRunnerEvidence.fromFormalEnvelope(envelope, binding.runID)
    const matureProjection = SessionRunnerEvidence.fromMatureBinding(binding, binding.runID)
    expect(SessionRunnerEvidence.compareRequestProjection(formalProjection, matureProjection)).toEqual([])

    const [provider, formal, mature] = await Effect.runPromise(
      Effect.all([replay(restored), replay(restored), replay(matureRequest)], { concurrency: "unbounded" }),
    )
    expect(formal.prepared.body).toEqual(mature.prepared.body)
    expect(provider.prepared.body).toEqual(formal.prepared.body)

    const project = (events: ReadonlyArray<LLMEvent>) =>
      events.map((event) => ({
        type: event.type,
        ...(event.type === "text-delta" ? { hasText: event.text.length > 0 } : {}),
        ...(event.type === "finish" ? { finish: event.reason } : {}),
      }))
    expect(project(provider.events)).toEqual(project(formal.events))
    expect(project(formal.events)).toEqual(project(mature.events))
    expect(formal.events.some((event) => event.type === "finish")).toBe(true)

    const providerTrace = SessionRunnerParity.fromProviderEvents(provider.events, {
      adapter: "provider-replay",
      terminalStatus: "completed",
      requestCount: 1,
      checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
    })
    const formalTrace = SessionRunnerParity.fromProviderEvents(formal.events, {
      adapter: "formal-runner",
      terminalStatus: "completed",
      requestCount: 1,
      checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
    })
    const matureTrace = SessionRunnerParity.fromProviderEvents(mature.events, {
      adapter: "mature-prompt",
      terminalStatus: "completed",
      requestCount: 1,
      checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
    })
    const tokens = usageTokens(provider.events)
    expect(tokens).toBe(usageTokens(formal.events))
    expect(tokens).toBe(usageTokens(mature.events))
    // The request and usage above come from the same recorded Provider run.
    // Wrap those actual outputs in the narrow durable event shapes so the
    // queue gate consumes the production history/evidence owner rather than a
    // hand-written ExecutionEvidence fixture.
    const semanticCheckpoint = SessionCheckpoint.make({
      sessionID: paritySessionID,
      nextStep: 2,
      needsContinuation: false,
      lastTurn: {
        turnStep: formalProjection.turnStep,
        requestDigest: formalProjection.requestDigest,
        contextDigest: formalProjection.contextDigest,
        toolSetRevision: formalProjection.toolSetRevision,
        routeConfigRevision: formalProjection.routeConfigRevision,
        compilerRevision: formalProjection.compilerRevision,
      },
    })
    const durableBaseRows = [
      {
        aggregateID: binding.runID,
        sequence: 0,
        type: SessionRunnerHistory.runnerHistoryTypes.runCreated,
        data: {
          runID: binding.runID,
          sessionID: paritySessionID,
          run: {
            id: binding.runID,
            sessionID: paritySessionID,
            status: "completed",
            initiator: "user",
            authority: "automatic",
            riskTier: "L0",
            reasonSummary: "recorded cassette parity",
            budget: {
              maxAttempts: 3,
              maxDurationMs: 30_000,
              maxCostMicros: 5_000_000,
              maxTokens: Math.max(1_000_000, tokens),
              attemptsUsed: 0,
              durationMsUsed: 0,
              costMicrosUsed: 0,
              tokensUsed: 0,
            },
            traceID: "trace_parity_recorded",
            visibility: "summary",
            time: { created: 1, updated: 1 },
          },
        },
      },
      {
        aggregateID: binding.runID,
        sequence: 1,
        type: SessionRunnerHistory.runnerHistoryTypes.attemptFinished,
        data: {
          runID: binding.runID,
          sessionID: paritySessionID,
          attempt: 1,
          outcome: "completed",
          durationMs: 0,
          costMicros: 0,
          tokens,
          finishedAt: 1,
        },
      },
      {
        aggregateID: binding.runID,
        sequence: 2,
        type: SessionRunnerHistory.runnerHistoryTypes.checkpoint,
        data: {
          runID: binding.runID,
          sessionID: paritySessionID,
          checkpoint: {
            id: "chk_parity_recorded",
            runID: binding.runID,
            eventSequence: 2,
            stateDigest: formalProjection.requestDigest,
            resumeToken: "resume_parity_recorded",
            state: semanticCheckpoint,
            createdAt: 1,
          },
        },
      },
    ]
    const formalHistory = SessionRunnerHistory.fromRows(
      [
        ...durableBaseRows,
        {
          aggregateID: paritySessionID,
          sequence: 0,
          type: SessionRunnerHistory.runnerHistoryTypes.formalRequest,
          data: {
            timestamp: 1,
            sessionID: paritySessionID,
            runID: binding.runID,
            turnStep: formalProjection.turnStep,
            attempt: formalProjection.attempt,
            schemaVersion: "1.0",
            requestDigest: envelope.request_digest,
            envelope: requestEnvelopeJson(envelope),
          },
        },
      ],
      { sessionID: paritySessionID, runID: binding.runID },
    )
    const matureHistory = SessionRunnerHistory.fromRows(
      [
        ...durableBaseRows,
        {
          aggregateID: paritySessionID,
          sequence: 0,
          type: SessionRunnerHistory.runnerHistoryTypes.matureBinding,
          data: {
            timestamp: 2,
            sessionID: paritySessionID,
            runID: binding.runID,
            turnStep: binding.turnStep,
            attempt: binding.attempt,
            schemaVersion: 1,
            runtime: "native",
            mode: binding.mode,
            requestDigest: binding.requestDigest,
            contextDigest: binding.contextDigest,
            toolSetRevision: binding.toolSetRevision,
            routeConfigRevision: binding.routeConfigRevision,
            compilerRevision: binding.compilerRevision,
          },
        },
      ],
      { sessionID: paritySessionID, runID: binding.runID },
    )
    const providerHistory = SessionRunnerHistory.fromRows(durableBaseRows, {
      sessionID: paritySessionID,
      runID: binding.runID,
    })
    const parityEvidence = SessionRunnerHistory.evidenceFromHistories({
      provider: providerHistory,
      formal: formalHistory,
      mature: matureHistory,
      providerRequest: Object.freeze({ ...formalProjection }),
    })
    expect(providerHistory.formalRequest).toBeUndefined()
    expect(providerHistory.matureBinding).toBeUndefined()
    expect(formalHistory.matureBinding).toBeUndefined()
    expect(matureHistory.formalRequest).toBeUndefined()
    const scene = SessionRunnerParityMatrix.evaluate(
      [
        {
          scenario: "queue",
          provider: providerTrace,
          formal: formalTrace,
          mature: matureTrace,
          evidence: parityEvidence.evidence,
          requestProjections: parityEvidence.requestProjections,
        },
      ],
      { requireEvidence: true, requireRequestProjections: true },
    )
    expect(scene.comparisons[0]?.formal.equivalent).toBe(true)
    expect(scene.comparisons[0]?.mature.equivalent).toBe(true)
    expect(scene.evidenceMissing).toEqual([])
    expect(scene.requestProjectionMissing).toEqual([])
    expect(scene.differences).toEqual([])
    expect(scene.complete).toBe(false)
    expect(scene.missing).toEqual(["steer", "cancel", "compaction", "structured-output", "action-replay"])
  })

  test("writes queue evidence through isolated production EventV2 roots", async () => {
    const binding = MatureRequestBinding.fromRequest({
      request: matureRequest,
      binding: { runID: parityRunID, turnStep: 1, attempt: 1 },
    })
    const envelope = createRequestEnvelope({
      request: formalRequest,
      execution: {
        run_id: parityRunID,
        turn_step: 1,
        attempt: 1,
        context_digest: binding.contextDigest,
        tool_set_revision: binding.toolSetRevision,
        route_config_revision: binding.routeConfigRevision,
        compiler_revision: binding.compilerRevision,
      },
    })
    const formalProjection = SessionRunnerEvidence.fromFormalEnvelope(envelope, parityRunID)
    const semanticCheckpoint = SessionCheckpoint.make({
      sessionID: paritySessionID,
      nextStep: 2,
      needsContinuation: false,
      lastTurn: {
        turnStep: formalProjection.turnStep,
        requestDigest: formalProjection.requestDigest,
        contextDigest: formalProjection.contextDigest,
        toolSetRevision: formalProjection.toolSetRevision,
        routeConfigRevision: formalProjection.routeConfigRevision,
        compilerRevision: formalProjection.compilerRevision,
      },
    })
    const writerInput = {
      sessionID: paritySessionID,
      runID: parityRunID,
      tokens: 2,
      checkpoint: semanticCheckpoint,
      envelope: requestEnvelopeJson(envelope),
      requestDigest: envelope.request_digest,
      formalTurnStep: formalProjection.turnStep,
      formalAttempt: formalProjection.attempt,
      binding,
    } as const
    const [providerRows, formalRows, matureRows] = await Promise.all([
      recordDurableSide({ ...writerInput, side: "provider" }),
      recordDurableSide({ ...writerInput, side: "formal" }),
      recordDurableSide({ ...writerInput, side: "mature" }),
    ])
    expect(providerRows.some((row) => row.type === SessionRunnerHistory.runnerHistoryTypes.formalRequest)).toBe(false)
    expect(formalRows.some((row) => row.type === SessionRunnerHistory.runnerHistoryTypes.formalRequest)).toBe(true)
    expect(matureRows.some((row) => row.type === SessionRunnerHistory.runnerHistoryTypes.matureBinding)).toBe(true)
    const evidence = SessionRunnerHistory.evidenceFromEventRows({
      providerRows,
      formalRows,
      matureRows,
      sessionID: paritySessionID,
      runID: parityRunID,
      providerRequest: Object.freeze({ ...formalProjection }),
    })
    const step = {
      finish: "stop" as const,
      hasText: true,
      hasReasoning: false,
      structured: false,
      failed: false,
      tools: [],
    }
    const result = SessionRunnerParityMatrix.evaluate(
      [
        {
          scenario: "queue",
          provider: SessionRunnerParity.make({
            adapter: "provider-replay",
            terminalStatus: "completed",
            requestCount: 1,
            steps: [step],
            checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
          }),
          formal: SessionRunnerParity.make({
            adapter: "formal-runner",
            terminalStatus: "completed",
            requestCount: 1,
            steps: [step],
            checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
          }),
          mature: SessionRunnerParity.make({
            adapter: "mature-prompt",
            terminalStatus: "completed",
            requestCount: 1,
            steps: [step],
            checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
          }),
          evidence: evidence.evidence,
          requestProjections: evidence.requestProjections,
        },
      ],
      { requireEvidence: true, requireRequestProjections: true },
    )
    expect(result.comparisons[0]?.formal.equivalent).toBe(true)
    expect(result.comparisons[0]?.mature.equivalent).toBe(true)
    expect(result.evidenceMissing).toEqual([])
    expect(result.requestProjectionMissing).toEqual([])
    expect(result.differences).toEqual([])
  })

  test("keeps steer and cancel durable evidence equivalent across the three owners", async () => {
    const scenarios = [
      {
        scenario: "steer" as const,
        sessionID: "ses_parity_steer",
        runID: "run_parity_steer",
        tokens: 3,
        terminalStatus: "completed" as const,
        outcome: "completed" as const,
        requestCount: 2,
        transportRetryCount: 0,
        checkpoint: (projection: SessionRunnerEvidence.RequestProjection) =>
          SessionCheckpoint.make({
            sessionID: "ses_parity_steer",
            nextStep: 3,
            needsContinuation: false,
            lastTurn: {
              turnStep: projection.turnStep,
              requestDigest: projection.requestDigest,
              contextDigest: projection.contextDigest,
              toolSetRevision: projection.toolSetRevision,
              routeConfigRevision: projection.routeConfigRevision,
              compilerRevision: projection.compilerRevision,
            },
          }),
        steps: [
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
        ],
      },
      {
        scenario: "cancel" as const,
        sessionID: "ses_parity_cancel",
        runID: "run_parity_cancel",
        tokens: 1,
        terminalStatus: "paused" as const,
        outcome: "interrupted" as const,
        requestCount: 1,
        transportRetryCount: 1,
        checkpoint: (projection: SessionRunnerEvidence.RequestProjection) =>
          SessionCheckpoint.make({
            sessionID: "ses_parity_cancel",
            nextStep: 2,
            needsContinuation: true,
            lastTurn: {
              turnStep: projection.turnStep,
              requestDigest: projection.requestDigest,
              contextDigest: projection.contextDigest,
              toolSetRevision: projection.toolSetRevision,
              routeConfigRevision: projection.routeConfigRevision,
              compilerRevision: projection.compilerRevision,
            },
          }),
        steps: [
          {
            finish: "error" as const,
            hasText: false,
            hasReasoning: false,
            structured: false,
            failed: true,
            tools: [],
          },
        ],
      },
    ]

    const entries: SessionRunnerParityMatrix.Entry[] = []
    for (const scenario of scenarios) {
      const binding = MatureRequestBinding.fromRequest({
        request: matureRequest,
        binding: { runID: scenario.runID, turnStep: 1, attempt: 1 },
      })
      const envelope = createRequestEnvelope({
        request: formalRequest,
        execution: {
          run_id: scenario.runID,
          turn_step: 1,
          attempt: 1,
          context_digest: binding.contextDigest,
          tool_set_revision: binding.toolSetRevision,
          route_config_revision: binding.routeConfigRevision,
          compiler_revision: binding.compilerRevision,
        },
      })
      const formalProjection = SessionRunnerEvidence.fromFormalEnvelope(envelope, scenario.runID)
      const [providerRows, formalRows, matureRows] = await Promise.all([
        recordDurableSide({
          side: "provider",
          sessionID: scenario.sessionID,
          runID: scenario.runID,
          tokens: scenario.tokens,
          checkpoint: scenario.checkpoint(formalProjection),
          envelope: requestEnvelopeJson(envelope),
          requestDigest: envelope.request_digest,
          formalTurnStep: formalProjection.turnStep,
          formalAttempt: formalProjection.attempt,
          binding,
          outcome: scenario.outcome,
          terminalStatus: scenario.terminalStatus,
        }),
        recordDurableSide({
          side: "formal",
          sessionID: scenario.sessionID,
          runID: scenario.runID,
          tokens: scenario.tokens,
          checkpoint: scenario.checkpoint(formalProjection),
          envelope: requestEnvelopeJson(envelope),
          requestDigest: envelope.request_digest,
          formalTurnStep: formalProjection.turnStep,
          formalAttempt: formalProjection.attempt,
          binding,
          outcome: scenario.outcome,
          terminalStatus: scenario.terminalStatus,
        }),
        recordDurableSide({
          side: "mature",
          sessionID: scenario.sessionID,
          runID: scenario.runID,
          tokens: scenario.tokens,
          checkpoint: scenario.checkpoint(formalProjection),
          envelope: requestEnvelopeJson(envelope),
          requestDigest: envelope.request_digest,
          formalTurnStep: formalProjection.turnStep,
          formalAttempt: formalProjection.attempt,
          binding,
          outcome: scenario.outcome,
          terminalStatus: scenario.terminalStatus,
        }),
      ])
      const evidence = SessionRunnerHistory.evidenceFromEventRows({
        providerRows,
        formalRows,
        matureRows,
        sessionID: scenario.sessionID,
        runID: scenario.runID,
        providerRequest: Object.freeze({ ...formalProjection }),
      })
      const makeTrace = (adapter: SessionRunnerParity.SemanticExecutionTrace["adapter"]) =>
        SessionRunnerParity.make({
          adapter,
          terminalStatus: scenario.terminalStatus,
          requestCount: scenario.requestCount,
          transportRetryCount: scenario.transportRetryCount,
          steps: scenario.steps,
          checkpoint: {
            phase: scenario.scenario === "cancel" ? "continuation" : "idle",
            nextStep: scenario.scenario === "cancel" ? 2 : 3,
            needsContinuation: scenario.scenario === "cancel",
          },
        })
      entries.push({
        scenario: scenario.scenario,
        provider: makeTrace("provider-replay"),
        formal: makeTrace("formal-runner"),
        mature: makeTrace("mature-prompt"),
        evidence: evidence.evidence,
        requestProjections: evidence.requestProjections,
      })
    }

    const result = SessionRunnerParityMatrix.evaluate(entries, {
      requireEvidence: true,
      requireRequestProjections: true,
    })
    expect(result.comparisons).toHaveLength(2)
    expect(result.comparisons.every((comparison) => comparison.formal.equivalent && comparison.mature.equivalent)).toBe(
      true,
    )
    expect(result.evidenceMissing).toEqual([])
    expect(result.requestProjectionMissing).toEqual([])
    expect(result.differences).toEqual([])
    expect(result.missing).toEqual(["queue", "compaction", "structured-output", "action-replay"])
  })
})
