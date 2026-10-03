import { HttpRecorderInternal } from "@arforge-ai/http-recorder/internal"
import {
  LLM as NativeLLM,
  LLMClient,
  LLMEvent,
  Message as NativeMessage,
  SystemPart,
  Tool as NativeTool,
  ToolCallPart,
  ToolDefinition,
  ToolFailure,
  ToolResultPart,
  ToolRuntime,
} from "@arforge-ai/llm"
import * as OpenAICompatibleChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import { Auth } from "@arforge-ai/llm/route"
import { Database } from "@arforge-ai/core/database/database"
import { EventTable } from "@arforge-ai/core/event/sql"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@arforge-ai/core/effect/app-node-platform"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import * as SessionRunnerHistory from "@arforge-ai/core/session/runner/history"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { EventV2 } from "@arforge-ai/core/event"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Config as CoreConfig } from "@arforge-ai/core/config"
import { ConfigCompaction } from "@arforge-ai/core/config/compaction"
import { Project as CoreProject } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionInput } from "@arforge-ai/core/session/input"
import { Snapshot as CoreSnapshot } from "@arforge-ai/core/snapshot"
import { Prompt } from "@arforge-ai/core/session/prompt"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"
import { SessionRunner } from "@arforge-ai/core/session/runner"
import * as SessionRunnerParity from "@arforge-ai/core/session/runner/parity"
import * as SessionRunnerParityMatrix from "@arforge-ai/core/session/runner/parity-matrix"
import * as SessionRunnerLLM from "@arforge-ai/core/session/runner/llm"
import * as CoreSessionCompaction from "@arforge-ai/core/session/compaction"
import * as SessionCompactionCheckpoint from "@arforge-ai/core/session/compaction-checkpoint"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { Tool as CoreTool } from "@arforge-ai/core/tool/tool"
import { StructuredOutput as CoreStructuredOutput } from "@arforge-ai/core/tool/structured-output"
import { interruptedErrorMessage } from "@arforge-ai/core/tool/execution-state"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionStore } from "@arforge-ai/core/session/store"
import { Location } from "@arforge-ai/core/location"
import { SystemContextRegistry } from "@arforge-ai/core/system-context/registry"
import { SystemContext } from "@arforge-ai/core/system-context"
import { SkillGuidance } from "@arforge-ai/core/skill/guidance"
import { ReferenceGuidance } from "@arforge-ai/core/reference/guidance"
import { EvolutionV2 } from "@arforge-ai/core/evolution"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import * as Scope from "effect/Scope"
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { RequestExecutor } from "@arforge-ai/llm/route"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { subagentOrchestrationPrompt } from "@arforge-ai/core/reasoning-profile"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { testEffect } from "../lib/effect"
import historicalBaseline from "../fixtures/recordings/session/historical-runner-baseline.v1.json"

const cassetteDirectory = path.resolve(import.meta.dir, "../fixtures/recordings")
const cassetteName = "session/full-runner-queue-parity-openai-text"
const steerCassetteName = "session/full-runner-steer-parity-openai-tool"
const cancelCassetteName = "session/full-runner-cancel-parity-openai-tool"
const compactionCassetteName = "session/full-runner-compaction-parity-openai-text"
const structuredOutputCassetteName = "session/full-runner-structured-output-parity-openai-tool"
const actionReplayCassetteName = "session/full-runner-action-replay-parity-openai-tool"
const canonicalCassetteURL = "http://arforge-queue-parity.invalid/v1"
const parityAgentPrompt = "You are the deterministic queue parity agent. Answer the user directly and concisely."
const paritySystemPrompt = [
  parityAgentPrompt,
  subagentOrchestrationPrompt({ variant: "default", background: false, child: false }),
].join("\n")
const requestScopedSystem = "Request-scoped instruction: answer this turn without tools."
const steerInitialPrompt = "Start the deterministic steer scenario."
const steerPrompt = "Change direction using the durable steer."
const steerFinalText = "steer absorbed"
const steerToolName = "inject_steer"
const steerToolDescription = "Admit one deterministic durable steer for this session."
const steerToolOutput = "durable steer admitted"
const cancelInitialPrompt = "Start the deterministic cancel scenario."
const cancelToolName = "hold_for_cancel"
const cancelToolDescription = "Hold one deterministic tool execution until the session is cancelled."
const cancelRecoveredText = "cancel recovered"
const compactionOldText = `old deterministic context ${"x".repeat(4_000)}`
const compactionRecentText = "retain this exact recent turn"
const compactionSummaryText = "## Objective\n- Continue the deterministic compaction parity scenario"
const compactionContinueText =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
const compactionFinalText = "compaction continued"
const structuredOutputPrompt = "Return the deterministic company record."
const structuredOutputSchema = {
  type: "object" as const,
  properties: {
    company: { type: "string" as const },
    founded: { type: "number" as const },
  },
  required: ["company", "founded"],
  additionalProperties: false,
}
const structuredOutputInvalid = { company: "Arforge" }
const structuredOutputFinal = { company: "Arforge", founded: 2026 }
const actionReplayPrompt = "Apply the deterministic durable action exactly once, even if the provider repeats it."
const actionReplayToolName = "apply_durable_marker"
const actionReplayToolDescription =
  "Apply one deterministic session marker and return its durable result without repeating the effect."
const actionReplayToolInput = { marker: "stable-action" }
const actionReplayToolOutput = "durable marker applied once"
const actionReplayFinalText = "durable action recovered without duplication"
const steerToolInputSchema = {
  type: "object" as const,
  properties: {},
  required: [] as string[],
  additionalProperties: false,
}
const actionReplayToolInputSchema = {
  type: "object" as const,
  properties: { marker: { type: "string" as const } },
  required: ["marker"],
  additionalProperties: false,
}
type HistoricalResult = {
  scenario: SessionRunnerParityMatrix.Scenario
  trace: SessionRunnerParity.SemanticExecutionTrace
  evidence: SessionRunnerParityMatrix.ExecutionEvidence
  request: SessionRunnerParityMatrix.RequestProjection
  transportRequestDigest: string
}
const completedParityEntries = new Map<SessionRunnerParityMatrix.Scenario, HistoricalResult>()

const assertFormalHistoricalBaseline = (
  scenario: SessionRunnerParityMatrix.Scenario,
  trace: SessionRunnerParity.SemanticExecutionTrace,
  evidence: SessionRunnerParityMatrix.ExecutionEvidence,
  request: SessionRunnerParityMatrix.RequestProjection,
  transportRequestDigest: string,
  baseline = historicalBaseline.scenarios,
) => {
  const matches = baseline.filter((item) => item.scenario === scenario)
  expect(matches).toHaveLength(1)
  const expected = matches[0]!
  expect<unknown>(trace).toEqual({ ...expected.trace, adapter: "formal-runner" })
  expect(evidence.budget).toMatchObject(expected.budget)
  expect(evidence.checkpoint).toMatchObject({
    phase: expected.checkpoint.needsContinuation ? "continuation" : "idle",
    nextStep: expected.checkpoint.nextStep,
    needsContinuation: expected.checkpoint.needsContinuation,
  })
  expect(request).toMatchObject(expected.requestCursor)
  expect(transportRequestDigest).toBe(expected.transportRequestDigest)
}

const admitHistoricalResult = (entry: HistoricalResult) => {
  if (completedParityEntries.has(entry.scenario))
    throw new Error(`duplicate full-runner parity evidence for ${entry.scenario}`)
  assertFormalHistoricalBaseline(
    entry.scenario,
    entry.trace,
    entry.evidence,
    entry.request,
    entry.transportRequestDigest,
  )
  completedParityEntries.set(entry.scenario, entry)
}

const redact = {
  url: (url: string) => url.replace(/^http:\/\/127\.0\.0\.1:\d+\/v1/, canonicalCassetteURL),
}

const durableSteerPrompt = () =>
  Prompt.make({
    text: steerPrompt,
    route: {
      agent: "build",
      model: {
        id: ModelV2.ID.make("gpt-4o-mini"),
        providerID: ProviderV2.ID.make("openai"),
      },
    },
  })

const formalRecordedHttp = HttpRecorderInternal.cassetteLayer(cassetteName, {
  directory: cassetteDirectory,
  mode: "replay",
  redactor: HttpRecorderInternal.Redactor.make(redact),
})
const formalExecutor = RequestExecutor.layer.pipe(Layer.provide(formalRecordedHttp))
const formalClient = LLMClient.layer.pipe(Layer.provide(formalExecutor))
const steerFormalRecordedHttp = HttpRecorderInternal.cassetteLayer(steerCassetteName, {
  directory: cassetteDirectory,
  mode: "replay",
  redactor: HttpRecorderInternal.Redactor.make(redact),
})
const steerFormalExecutor = RequestExecutor.layer.pipe(Layer.provide(steerFormalRecordedHttp))
const steerFormalClient = LLMClient.layer.pipe(Layer.provide(steerFormalExecutor))
const cancelFormalRecordedHttp = HttpRecorderInternal.cassetteLayer(cancelCassetteName, {
  directory: cassetteDirectory,
  mode: "replay",
  redactor: HttpRecorderInternal.Redactor.make(redact),
})
const cancelFormalExecutor = RequestExecutor.layer.pipe(Layer.provide(cancelFormalRecordedHttp))
const cancelFormalClient = LLMClient.layer.pipe(Layer.provide(cancelFormalExecutor))
const compactionFormalRecordedHttp = HttpRecorderInternal.cassetteLayer(compactionCassetteName, {
  directory: cassetteDirectory,
  mode: "replay",
  redactor: HttpRecorderInternal.Redactor.make(redact),
})
const compactionFormalExecutor = RequestExecutor.layer.pipe(Layer.provide(compactionFormalRecordedHttp))
const compactionFormalClient = LLMClient.layer.pipe(Layer.provide(compactionFormalExecutor))
const structuredOutputFormalRecordedHttp = HttpRecorderInternal.cassetteLayer(structuredOutputCassetteName, {
  directory: cassetteDirectory,
  mode: "replay",
  redactor: HttpRecorderInternal.Redactor.make(redact),
})
const structuredOutputFormalExecutor = RequestExecutor.layer.pipe(Layer.provide(structuredOutputFormalRecordedHttp))
const structuredOutputFormalClient = LLMClient.layer.pipe(Layer.provide(structuredOutputFormalExecutor))
const actionReplayFormalRecordedHttp = HttpRecorderInternal.cassetteLayer(actionReplayCassetteName, {
  directory: cassetteDirectory,
  mode: "replay",
  redactor: HttpRecorderInternal.Redactor.make(redact),
})
const actionReplayFormalExecutor = RequestExecutor.layer.pipe(Layer.provide(actionReplayFormalRecordedHttp))
const actionReplayFormalClient = LLMClient.layer.pipe(Layer.provide(actionReplayFormalExecutor))
const formalPermission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused formal parity permission request"),
    reply: () => Effect.die("unused formal parity permission reply"),
    get: () => Effect.die("unused formal parity permission lookup"),
    forSession: () => Effect.die("unused formal parity session permission lookup"),
    list: () => Effect.die("unused formal parity permission list"),
  }),
)
const formalModel = OpenAICompatibleChat.route
  .with({
    endpoint: { baseURL: canonicalCassetteURL },
    auth: Auth.bearer("fixture-openai-key"),
    limits: { context: 1_000_000, output: 1_000_000 },
    generation: { maxTokens: 20, temperature: 0 },
    providerOptions: { openai: { store: false } },
  })
  .model({ id: "gpt-4o-mini", provider: "openai" })
const formalModels = SessionRunnerModel.layerWith(() => Effect.succeed(formalModel))
const compactionFormalModel = OpenAICompatibleChat.route
  .with({
    endpoint: { baseURL: canonicalCassetteURL },
    auth: Auth.bearer("fixture-openai-key"),
    limits: { context: 4_000, output: 1_000_000 },
    generation: { maxTokens: 20, temperature: 0 },
    providerOptions: { openai: { store: false } },
  })
  .model({ id: "gpt-4o-mini", provider: "openai" })
const compactionFormalModels = SessionRunnerModel.layerWith(() => Effect.succeed(compactionFormalModel))
const formalContextValue = SystemContext.make({
  key: SystemContext.Key.make("test/full-runner-queue-parity"),
  codec: Schema.toCodecJson(Schema.String),
  load: Effect.succeed(paritySystemPrompt),
  baseline: String,
  update: (_previous, current) => current,
})
const formalSystemContext = Layer.succeed(
  SystemContextRegistry.Service,
  SystemContextRegistry.Service.of({
    register: () => Effect.void,
    load: () => Effect.succeed(formalContextValue),
  }),
)
const formalSkillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
  route: () => Effect.succeed(undefined),
})
const formalReferenceGuidance = Layer.mock(ReferenceGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const formalEvolution = Layer.mock(EvolutionV2.Service, {
  prepare: () => Effect.succeed(EvolutionV2.emptyContext),
  recordOutcome: () => Effect.succeed(0),
  syncLearningPatterns: (patterns) =>
    Effect.succeed({
      schema_version: 1 as const,
      seen: patterns.length,
      created: 0,
      existing: 0,
      skipped: patterns.length,
      failed: 0,
      items: [],
    }),
})
const formalConfig = Layer.succeed(CoreConfig.Service, CoreConfig.Service.of({ entries: () => Effect.succeed([]) }))
const compactionFormalConfig = Layer.succeed(
  CoreConfig.Service,
  CoreConfig.Service.of({
    entries: () =>
      Effect.succeed([
        new CoreConfig.Document({
          type: "document",
          info: new CoreConfig.Info({
            compaction: new ConfigCompaction.Info({
              auto: true,
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 100 }),
            }),
          }),
        }),
      ]),
  }),
)
const formalDirectory = AbsolutePath.make(import.meta.dir)
const buildFormalRunnerLayer = (
  client: LayerNode.Replacement[1],
  modelLayer: LayerNode.Replacement[1] = formalModels,
  configLayer: LayerNode.Replacement[1] = formalConfig,
) =>
  AppNodeBuilder.build(SessionRunnerLLM.node, [
    [CoreSnapshot.node, CoreSnapshot.noopLayer],
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, modelLayer],
    [SystemContextRegistry.node, formalSystemContext],
    [Location.node, Location.boundNode({ directory: formalDirectory })],
    [SkillGuidance.node, formalSkillGuidance],
    [ReferenceGuidance.node, formalReferenceGuidance],
    [EvolutionV2.node, formalEvolution],
    [CoreConfig.node, configLayer],
    [PermissionV2.node, formalPermission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])
const formalRunnerLayer = buildFormalRunnerLayer(formalClient)
const steerFormalRunnerLayer = buildFormalRunnerLayer(steerFormalClient)
const cancelFormalRunnerLayer = buildFormalRunnerLayer(cancelFormalClient)
const compactionFormalRunnerLayer = buildFormalRunnerLayer(
  compactionFormalClient,
  compactionFormalModels,
  compactionFormalConfig,
)
const structuredOutputFormalRunnerLayer = buildFormalRunnerLayer(structuredOutputFormalClient)
const actionReplayFormalRunnerLayer = buildFormalRunnerLayer(actionReplayFormalClient)
const buildFormalExecution = (runnerLayer: typeof formalRunnerLayer) =>
  Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<
        SessionV2.ID,
        SessionRunner.RunError,
        SessionExecution.RunOptions
      >({
        drain: (sessionID, force, options) =>
          sessionRunner.run({
            sessionID,
            force,
            billing: options?.billing,
            onSettled: options?.onSettled,
            settlementCollector: options?.settlementCollector,
          }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        exclusive: coordinator.exclusive,
        resume: coordinator.run,
        resumeWith: ({ sessionID, options }) => coordinator.runWith(sessionID, options),
        wake: coordinator.wake,
        wakeAndWait: coordinator.wakeAndWait,
        interrupt: coordinator.interrupt,
      })
    }),
  ).pipe(Layer.provide(runnerLayer))
const formalExecution = buildFormalExecution(formalRunnerLayer)
const steerFormalExecution = buildFormalExecution(steerFormalRunnerLayer)
const cancelFormalExecution = buildFormalExecution(cancelFormalRunnerLayer)
const compactionFormalExecution = buildFormalExecution(compactionFormalRunnerLayer)
const structuredOutputFormalExecution = buildFormalExecution(structuredOutputFormalRunnerLayer)
const actionReplayFormalExecution = buildFormalExecution(actionReplayFormalRunnerLayer)
const formalRootNode = LayerNode.group([
  LayerNodePlatform.llmClient,
  Database.node,
  EventV2.node,
  SessionProjector.node,
  SessionStore.node,
  AgentV2.node,
  DurableRun.node,
  CoreToolRegistry.node,
  RuntimeInvariants.node,
  SessionRunnerModel.node,
  SystemContextRegistry.node,
  SkillGuidance.node,
  ReferenceGuidance.node,
  EvolutionV2.node,
  CoreConfig.node,
  CoreSnapshot.node,
  SessionRunnerLLM.node,
  SessionV2.node,
])
const buildFormalRoot = (
  client: LayerNode.Replacement[1],
  executionLayer: LayerNode.Replacement[1],
  modelLayer: LayerNode.Replacement[1] = formalModels,
  configLayer: LayerNode.Replacement[1] = formalConfig,
) =>
  AppNodeBuilder.build(formalRootNode, [
    [LayerNodePlatform.llmClient, client],
    [PermissionV2.node, formalPermission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [SessionRunnerModel.node, modelLayer],
    [SystemContextRegistry.node, formalSystemContext],
    [Location.node, Location.boundNode({ directory: formalDirectory })],
    [SkillGuidance.node, formalSkillGuidance],
    [ReferenceGuidance.node, formalReferenceGuidance],
    [EvolutionV2.node, formalEvolution],
    [CoreConfig.node, configLayer],
    [CoreSnapshot.node, CoreSnapshot.noopLayer],
    [SessionExecution.node, executionLayer],
  ])
const formalRoot = buildFormalRoot(formalClient, formalExecution)
const steerFormalRoot = buildFormalRoot(steerFormalClient, steerFormalExecution)
const cancelFormalRoot = buildFormalRoot(cancelFormalClient, cancelFormalExecution)
const compactionFormalRoot = buildFormalRoot(
  compactionFormalClient,
  compactionFormalExecution,
  compactionFormalModels,
  compactionFormalConfig,
)
const structuredOutputFormalRoot = buildFormalRoot(structuredOutputFormalClient, structuredOutputFormalExecution)
const actionReplayFormalRoot = buildFormalRoot(actionReplayFormalClient, actionReplayFormalExecution)

const formalSessionID = SessionV2.ID.make("ses_full_runner_queue_parity")
const inFreshLayer = <A, E, R, E2>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R, E2>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope)
    const exit = yield* effect.pipe(Effect.provide(context), Effect.exit)
    yield* Scope.close(scope, exit).pipe(Effect.provide(context))
    return yield* exit
  })

const formalQueueEffect = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: CoreProject.ID.global, worktree: formalDirectory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: formalSessionID,
      project_id: CoreProject.ID.global,
      slug: "full-runner-queue-parity",
      directory: formalDirectory,
      title: "full-runner-queue-parity",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const sessions = yield* SessionV2.Service
  yield* sessions.prompt({
    sessionID: formalSessionID,
    delivery: "queue",
    prompt: Prompt.make({
      text: "Say hello in one short sentence.",
      system: { text: requestScopedSystem, source: "request", scope: "turn" },
      route: {
        agent: "build",
        model: { id: ModelV2.ID.make("gpt-4o-mini"), providerID: ProviderV2.ID.make("openai") },
      },
    }),
    resume: false,
  })
  expect(yield* SessionInput.listPending(db, formalSessionID, "queue")).toMatchObject([
    {
      prompt: {
        text: "Say hello in one short sentence.",
        system: { text: requestScopedSystem, source: "request", scope: "turn" },
        route: { agent: "build", model: { id: "gpt-4o-mini", providerID: "openai" } },
      },
    },
  ])
  const summaries: SessionRunnerHistory.TerminalHistorySummary[] = []
  const committedRows: Array<ReadonlyArray<EventV2.SerializedEvent>> = []
  yield* sessions.resumeWithCredentials({
    sessionID: formalSessionID,
    credentialIDs: [],
    onSettled: (summary) => Effect.sync(() => void summaries.push(summary)),
    settlementCollector: ({ query, source }) =>
      source.collect(query).pipe(Effect.tap((rows) => Effect.sync(() => void committedRows.push(rows)))),
  })
  if (summaries.length !== 1 || committedRows.length !== 1)
    throw new Error(
      `formal full-runner queue did not settle exactly once: summaries=${summaries.length} rows=${committedRows.length}`,
    )
  const persisted = yield* SessionRunnerHistory.runnerEventRowSourceFromDatabase(db).collect({
    sessionID: formalSessionID,
    runID: summaries[0]!.runID,
  })
  expect(committedRows[0]).toEqual(persisted)
  expect((yield* sessions.active).has(formalSessionID)).toBe(false)
  expect(yield* SessionInput.listPending(db, formalSessionID, "queue")).toHaveLength(0)
  const history = SessionRunnerHistory.fromEventRows(committedRows[0]!, {
    sessionID: formalSessionID,
    runID: summaries[0]!.runID,
    owner: "formal",
  })
  const messages = yield* sessions.context(formalSessionID)
  return {
    history,
    messages,
    rows: committedRows[0]!,
    summary: summaries[0]!,
    trace: SessionRunnerParity.fromCoreMessages(messages, {
      terminalStatus: "completed",
      requestCount: 1,
      checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
    }),
    durable: SessionRunnerHistory.formalEvidenceFromHistory(history),
  }
})
const runFormalQueue = inFreshLayer(formalQueueEffect, formalRoot)

const formalSteerSessionID = SessionV2.ID.make("ses_full_runner_steer_parity")
const formalSteerEffect = Effect.scoped(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const registry = yield* CoreToolRegistry.Service
    const toolEntered = yield* Deferred.make<void>()
    const releaseTool = yield* Deferred.make<void>()
    yield* registry.register({
      [steerToolName]: CoreTool.make({
        description: steerToolDescription,
        input: Schema.Struct({}),
        inputJsonSchema: { ...steerToolInputSchema },
        output: Schema.String,
        metadata: { sideEffect: "none", concurrency: "exclusive" },
        execute: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(toolEntered, void 0)
            yield* Deferred.await(releaseTool)
            return "durable steer admitted"
          }),
        toModelOutput: ({ output }) => [{ type: "text", text: output }],
      }),
    })
    yield* db
      .insert(ProjectTable)
      .values({ id: CoreProject.ID.global, worktree: formalDirectory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: formalSteerSessionID,
        project_id: CoreProject.ID.global,
        slug: "full-runner-steer-parity",
        directory: formalDirectory,
        title: "full-runner-steer-parity",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const sessions = yield* SessionV2.Service
    yield* sessions.prompt({
      sessionID: formalSteerSessionID,
      prompt: Prompt.make({ text: steerInitialPrompt }),
      resume: false,
    })
    const summaries: SessionRunnerHistory.TerminalHistorySummary[] = []
    const committedRows: Array<ReadonlyArray<EventV2.SerializedEvent>> = []
    const resumeFiber = yield* sessions
      .resumeWithCredentials({
        sessionID: formalSteerSessionID,
        credentialIDs: [],
        onSettled: (summary) => Effect.sync(() => void summaries.push(summary)),
        settlementCollector: ({ query, source }) =>
          source.collect(query).pipe(Effect.tap((rows) => Effect.sync(() => void committedRows.push(rows)))),
      })
      .pipe(Effect.forkChild)
    yield* Deferred.await(toolEntered).pipe(Effect.timeout("10 seconds"))
    yield* SessionInput.admit(db, events, {
      id: SessionMessage.ID.make("msg_full_runner_formal_steer"),
      sessionID: formalSteerSessionID,
      delivery: "steer",
      prompt: durableSteerPrompt(),
    })
    expect(yield* SessionInput.listPending(db, formalSteerSessionID, "steer")).toMatchObject([
      { id: "msg_full_runner_formal_steer", prompt: { text: steerPrompt } },
    ])
    expect((yield* sessions.active).has(formalSteerSessionID)).toBe(true)
    yield* Deferred.succeed(releaseTool, void 0)
    yield* Fiber.join(resumeFiber).pipe(Effect.timeout("15 seconds"))
    if (summaries.length !== 1 || committedRows.length !== 1)
      throw new Error(
        `formal full-runner steer did not settle exactly once: summaries=${summaries.length} rows=${committedRows.length}`,
      )
    expect((yield* sessions.active).has(formalSteerSessionID)).toBe(false)
    expect(yield* SessionInput.listPending(db, formalSteerSessionID, "steer")).toEqual([])
    expect(committedRows[0]).toEqual(
      yield* SessionRunnerHistory.runnerEventRowSourceFromDatabase(db).collect({
        sessionID: formalSteerSessionID,
        runID: summaries[0]!.runID,
      }),
    )
    const history = SessionRunnerHistory.fromEventRows(committedRows[0]!, {
      sessionID: formalSteerSessionID,
      runID: summaries[0]!.runID,
      owner: "formal",
    })
    const messages = yield* sessions.context(formalSteerSessionID)
    return {
      history,
      messages,
      rows: committedRows[0]!,
      summary: summaries[0]!,
      trace: SessionRunnerParity.fromCoreMessages(messages, {
        terminalStatus: "completed",
        requestCount: 2,
        checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
      }),
      durable: SessionRunnerHistory.formalEvidenceFromHistory(history),
    }
  }),
)
const runFormalSteer = inFreshLayer(formalSteerEffect, steerFormalRoot)

const formalCancelSessionID = SessionV2.ID.make("ses_full_runner_cancel_parity")
const formalCancelEffect = Effect.scoped(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const registry = yield* CoreToolRegistry.Service
    const toolEntered = yield* Deferred.make<void>()
    yield* registry.register({
      [cancelToolName]: CoreTool.make({
        description: cancelToolDescription,
        input: Schema.Struct({}),
        inputJsonSchema: { ...steerToolInputSchema },
        output: Schema.String,
        metadata: { sideEffect: "none", concurrency: "exclusive" },
        execute: () => Deferred.succeed(toolEntered, void 0).pipe(Effect.andThen(Effect.never)),
        toModelOutput: ({ output }) => [{ type: "text", text: output }],
      }),
    })
    yield* db
      .insert(ProjectTable)
      .values({ id: CoreProject.ID.global, worktree: formalDirectory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: formalCancelSessionID,
        project_id: CoreProject.ID.global,
        slug: "full-runner-cancel-parity",
        directory: formalDirectory,
        title: "full-runner-cancel-parity",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const sessions = yield* SessionV2.Service
    yield* sessions.prompt({
      sessionID: formalCancelSessionID,
      prompt: Prompt.make({ text: cancelInitialPrompt }),
      resume: false,
    })
    const summaries: SessionRunnerHistory.TerminalHistorySummary[] = []
    const committedRows: Array<ReadonlyArray<EventV2.SerializedEvent>> = []
    const resumeFiber = yield* sessions
      .resumeWithCredentials({
        sessionID: formalCancelSessionID,
        credentialIDs: [],
        onSettled: (summary) => Effect.sync(() => void summaries.push(summary)),
        settlementCollector: ({ query, source }) =>
          source.collect(query).pipe(Effect.tap((rows) => Effect.sync(() => void committedRows.push(rows)))),
      })
      .pipe(Effect.forkChild)
    yield* Deferred.await(toolEntered).pipe(Effect.timeout("10 seconds"))
    yield* sessions.interrupt(formalCancelSessionID)
    const resumeExit = yield* Fiber.await(resumeFiber).pipe(Effect.timeout("15 seconds"))
    if (summaries.length !== 1 || committedRows.length !== 1)
      throw new Error(
        `formal full-runner cancel did not settle exactly once: summaries=${summaries.length} rows=${committedRows.length}`,
      )
    expect((yield* sessions.active).has(formalCancelSessionID)).toBe(false)
    expect(committedRows[0]).toEqual(
      yield* SessionRunnerHistory.runnerEventRowSourceFromDatabase(db).collect({
        sessionID: formalCancelSessionID,
        runID: summaries[0]!.runID,
      }),
    )
    const history = SessionRunnerHistory.fromEventRows(committedRows[0]!, {
      sessionID: formalCancelSessionID,
      runID: summaries[0]!.runID,
      owner: "formal",
    })
    const messages = yield* sessions.context(formalCancelSessionID)
    yield* sessions.resumeWithCredentials({
      sessionID: formalCancelSessionID,
      credentialIDs: [],
      onSettled: (summary) => Effect.sync(() => void summaries.push(summary)),
      settlementCollector: ({ query, source }) =>
        source.collect(query).pipe(Effect.tap((rows) => Effect.sync(() => void committedRows.push(rows)))),
    })
    const recoveredRecordedSummary = summaries.at(1)
    const recoveredRows = committedRows.at(1)
    if (recoveredRecordedSummary === undefined || recoveredRows === undefined)
      throw new Error(
        `formal full-runner cancel recovery did not settle exactly once: summaries=${summaries.length} rows=${committedRows.length}`,
      )
    expect(summaries).toHaveLength(2)
    expect(committedRows).toHaveLength(2)
    expect((yield* sessions.active).has(formalCancelSessionID)).toBe(false)
    expect(recoveredRows).toEqual(
      yield* SessionRunnerHistory.runnerEventRowSourceFromDatabase(db).collect({
        sessionID: formalCancelSessionID,
        runID: recoveredRecordedSummary.runID,
      }),
    )
    const recoveredHistory = SessionRunnerHistory.fromEventRows(recoveredRows, {
      sessionID: formalCancelSessionID,
      runID: recoveredRecordedSummary.runID,
      owner: "formal",
    })
    const recoveredMessages = yield* sessions.context(formalCancelSessionID)
    return {
      history,
      messages,
      rows: committedRows[0]!,
      summary: summaries[0]!,
      resumeExit,
      trace: SessionRunnerParity.fromCoreMessages(messages, {
        terminalStatus: "paused",
        requestCount: 1,
        checkpoint: { phase: "continuation", nextStep: 2, needsContinuation: true },
      }),
      durable: SessionRunnerHistory.formalEvidenceFromHistory(history),
      recovered: {
        history: recoveredHistory,
        messages: recoveredMessages,
        rows: recoveredRows,
        summary: recoveredRecordedSummary,
      },
    }
  }),
)
const runFormalCancel = inFreshLayer(formalCancelEffect, cancelFormalRoot)

const formalCompactionSessionID = SessionV2.ID.make("ses_full_runner_compaction_parity")
const formalCompactionEffect = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const invariants = yield* RuntimeInvariants.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: CoreProject.ID.global, worktree: formalDirectory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: formalCompactionSessionID,
      project_id: CoreProject.ID.global,
      slug: "full-runner-compaction-parity",
      directory: formalDirectory,
      title: "full-runner-compaction-parity",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  yield* events.publish(SessionEvent.Prompted, {
    sessionID: formalCompactionSessionID,
    messageID: SessionMessage.ID.make("msg_formal_compaction_old"),
    timestamp: DateTime.makeUnsafe(1),
    prompt: Prompt.make({ text: compactionOldText }),
    delivery: "queue",
  })
  yield* events.publish(SessionEvent.Prompted, {
    sessionID: formalCompactionSessionID,
    messageID: SessionMessage.ID.make("msg_formal_compaction_recent"),
    timestamp: DateTime.makeUnsafe(2),
    prompt: Prompt.make({ text: compactionRecentText }),
    delivery: "queue",
  })

  const sessions = yield* SessionV2.Service
  const summaries: SessionRunnerHistory.TerminalHistorySummary[] = []
  const committedRows: Array<ReadonlyArray<EventV2.SerializedEvent>> = []
  yield* sessions.resumeWithCredentials({
    sessionID: formalCompactionSessionID,
    credentialIDs: [],
    onSettled: (summary) => Effect.sync(() => void summaries.push(summary)),
    settlementCollector: ({ query, source }) =>
      source.collect(query).pipe(Effect.tap((rows) => Effect.sync(() => void committedRows.push(rows)))),
  })
  if (summaries.length !== 1 || committedRows.length !== 1)
    throw new Error(
      `formal full-runner compaction did not settle exactly once: summaries=${summaries.length} rows=${committedRows.length}`,
    )
  expect((yield* sessions.active).has(formalCompactionSessionID)).toBe(false)
  expect(committedRows[0]).toEqual(
    yield* SessionRunnerHistory.runnerEventRowSourceFromDatabase(db).collect({
      sessionID: formalCompactionSessionID,
      runID: summaries[0]!.runID,
    }),
  )
  const history = SessionRunnerHistory.fromEventRows(committedRows[0]!, {
    sessionID: formalCompactionSessionID,
    runID: summaries[0]!.runID,
    owner: "formal",
  })
  const messages = yield* sessions.context(formalCompactionSessionID)
  const operations = yield* SessionCompactionCheckpoint.scan(db, formalCompactionSessionID, invariants)
  if (operations.length !== 1) throw new Error(`formal compaction produced ${operations.length} checkpoint operations`)
  const checkpoints = yield* SessionCompactionCheckpoint.load(
    db,
    formalCompactionSessionID,
    operations[0]!.operationID,
    invariants,
  )
  return {
    history,
    messages,
    rows: committedRows[0]!,
    summary: summaries[0]!,
    checkpoints,
    operations,
    trace: SessionRunnerParity.fromCoreMessages(messages, {
      terminalStatus: "completed",
      requestCount: 2,
      checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
    }),
    durable: SessionRunnerHistory.formalEvidenceFromHistory(history),
  }
})
const runFormalCompaction = inFreshLayer(formalCompactionEffect, compactionFormalRoot)

const formalStructuredOutputSessionID = SessionV2.ID.make("ses_full_runner_structured_output_parity")
const formalStructuredOutputEffect = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: CoreProject.ID.global, worktree: formalDirectory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: formalStructuredOutputSessionID,
      project_id: CoreProject.ID.global,
      slug: "full-runner-structured-output-parity",
      directory: formalDirectory,
      title: "full-runner-structured-output-parity",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  const sessions = yield* SessionV2.Service
  yield* sessions.prompt({
    sessionID: formalStructuredOutputSessionID,
    prompt: Prompt.make({
      text: structuredOutputPrompt,
      format: { type: "json_schema", schema: structuredOutputSchema, retryCount: 1 },
    }),
    resume: false,
  })
  const summaries: SessionRunnerHistory.TerminalHistorySummary[] = []
  const committedRows: Array<ReadonlyArray<EventV2.SerializedEvent>> = []
  yield* sessions.resumeWithCredentials({
    sessionID: formalStructuredOutputSessionID,
    credentialIDs: [],
    onSettled: (summary) => Effect.sync(() => void summaries.push(summary)),
    settlementCollector: ({ query, source }) =>
      source.collect(query).pipe(Effect.tap((rows) => Effect.sync(() => void committedRows.push(rows)))),
  })
  if (summaries.length !== 1 || committedRows.length !== 1)
    throw new Error(
      `formal full-runner structured output did not settle exactly once: summaries=${summaries.length} rows=${committedRows.length}`,
    )
  expect((yield* sessions.active).has(formalStructuredOutputSessionID)).toBe(false)
  expect(committedRows[0]).toEqual(
    yield* SessionRunnerHistory.runnerEventRowSourceFromDatabase(db).collect({
      sessionID: formalStructuredOutputSessionID,
      runID: summaries[0]!.runID,
    }),
  )
  const history = SessionRunnerHistory.fromEventRows(committedRows[0]!, {
    sessionID: formalStructuredOutputSessionID,
    runID: summaries[0]!.runID,
    owner: "formal",
  })
  const messages = yield* sessions.context(formalStructuredOutputSessionID)
  return {
    history,
    messages,
    rows: committedRows[0]!,
    summary: summaries[0]!,
    trace: SessionRunnerParity.fromCoreMessages(messages, {
      terminalStatus: "completed",
      requestCount: 2,
      checkpoint: { phase: "idle", nextStep: 3, needsContinuation: false },
    }),
    durable: SessionRunnerHistory.formalEvidenceFromHistory(history),
  }
})
const runFormalStructuredOutput = inFreshLayer(formalStructuredOutputEffect, structuredOutputFormalRoot)

const formalActionReplaySessionID = SessionV2.ID.make("ses_full_runner_action_replay_parity")
const formalActionReplayEffect = Effect.scoped(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const registry = yield* CoreToolRegistry.Service
    let executions = 0
    yield* registry.register({
      [actionReplayToolName]: CoreTool.make({
        description: actionReplayToolDescription,
        input: Schema.Struct({ marker: Schema.String }),
        inputJsonSchema: { ...actionReplayToolInputSchema },
        output: Schema.String,
        metadata: { sideEffect: "none", concurrency: "exclusive" },
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return actionReplayToolOutput
          }),
        toModelOutput: ({ output }) => [{ type: "text", text: output }],
      }),
    })
    yield* db
      .insert(ProjectTable)
      .values({ id: CoreProject.ID.global, worktree: formalDirectory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: formalActionReplaySessionID,
        project_id: CoreProject.ID.global,
        slug: "full-runner-action-replay-parity",
        directory: formalDirectory,
        title: "full-runner-action-replay-parity",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    const sessions = yield* SessionV2.Service
    yield* sessions.prompt({
      sessionID: formalActionReplaySessionID,
      prompt: Prompt.make({ text: actionReplayPrompt }),
      resume: false,
    })
    const summaries: SessionRunnerHistory.TerminalHistorySummary[] = []
    const committedRows: Array<ReadonlyArray<EventV2.SerializedEvent>> = []
    yield* sessions.resumeWithCredentials({
      sessionID: formalActionReplaySessionID,
      credentialIDs: [],
      onSettled: (summary) => Effect.sync(() => void summaries.push(summary)),
      settlementCollector: ({ query, source }) =>
        source.collect(query).pipe(Effect.tap((rows) => Effect.sync(() => void committedRows.push(rows)))),
    })
    if (summaries.length !== 1 || committedRows.length !== 1)
      throw new Error(
        `formal full-runner action replay did not settle exactly once: summaries=${summaries.length} rows=${committedRows.length}`,
      )
    expect((yield* sessions.active).has(formalActionReplaySessionID)).toBe(false)
    expect(committedRows[0]).toEqual(
      yield* SessionRunnerHistory.runnerEventRowSourceFromDatabase(db).collect({
        sessionID: formalActionReplaySessionID,
        runID: summaries[0]!.runID,
      }),
    )
    const history = SessionRunnerHistory.fromEventRows(committedRows[0]!, {
      sessionID: formalActionReplaySessionID,
      runID: summaries[0]!.runID,
      owner: "formal",
    })
    const messages = yield* sessions.context(formalActionReplaySessionID)
    const actionRows = yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .all()
      .pipe(Effect.orDie)
    return {
      executions,
      actionRows: actionRows.filter((row) => row.type.startsWith("agent.action.")),
      history,
      messages,
      rows: committedRows[0]!,
      summary: summaries[0]!,
      trace: SessionRunnerParity.fromCoreMessages(messages, {
        terminalStatus: "completed",
        requestCount: 3,
        checkpoint: { phase: "idle", nextStep: 4, needsContinuation: false },
      }),
      durable: SessionRunnerHistory.formalEvidenceFromHistory(history),
    }
  }),
)
const runFormalActionReplay = inFreshLayer(formalActionReplayEffect, actionReplayFormalRoot)

const providerQueueEffect = Effect.gen(function* () {
  const request = NativeLLM.request({
    model: formalModel,
    system: `${paritySystemPrompt}\n${requestScopedSystem}`,
    prompt: "Say hello in one short sentence.",
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const client = yield* LLMClient.Service
  const prepared = yield* client.prepare(request)
  const events = Array.from(yield* client.stream(request).pipe(Stream.runCollect))
  return { request, prepared, events }
})
const replayProviderQueue = inFreshLayer(providerQueueEffect, formalClient)

const providerCompactionEffect = Effect.gen(function* () {
  const summaryPrompt = CoreSessionCompaction.buildPrompt({
    context: [CoreSessionCompaction.serializeUserContext({ text: compactionOldText })],
  })
  const summaryRequest = NativeLLM.request({
    model: formalModel,
    system: [SystemPart.make(CoreSessionCompaction.SYSTEM_PROMPT)],
    messages: [NativeMessage.user(summaryPrompt)],
    tools: [],
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const recent = CoreSessionCompaction.serializeUserContext({ text: compactionRecentText })
  const continuationRequest = NativeLLM.request({
    model: formalModel,
    system: [SystemPart.make(paritySystemPrompt)],
    messages: [
      NativeMessage.user(CoreSessionCompaction.checkpointText({ summary: compactionSummaryText, recent })),
      NativeMessage.user(compactionContinueText),
    ],
    tools: [],
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const client = yield* LLMClient.Service
  const summaryPrepared = yield* client.prepare(summaryRequest)
  const summaryEvents = Array.from(yield* client.stream(summaryRequest).pipe(Stream.runCollect))
  const continuationPrepared = yield* client.prepare(continuationRequest)
  const continuationEvents = Array.from(yield* client.stream(continuationRequest).pipe(Stream.runCollect))
  return {
    requests: [summaryRequest, continuationRequest] as const,
    prepared: [summaryPrepared, continuationPrepared] as const,
    summaryEvents,
    events: continuationEvents,
  }
})
const replayProviderCompaction = inFreshLayer(providerCompactionEffect, compactionFormalClient)

const providerStructuredOutputTool = NativeTool.make({
  description: CoreStructuredOutput.description,
  jsonSchema: structuredOutputSchema,
  execute: (input) =>
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { company?: unknown }).company === "string" &&
    typeof (input as { founded?: unknown }).founded === "number"
      ? Effect.succeed(input)
      : Effect.fail(new ToolFailure({ message: "Invalid tool input: $.founded: is required" })),
  toModelOutput: () => [{ type: "text", text: "Structured output captured successfully." }],
  toStructuredOutput: (output) => output,
})
const nativeStructuredOutputTool = NativeTool.toDefinitions({
  [CoreStructuredOutput.name]: providerStructuredOutputTool,
})[0]!
const providerStructuredOutputEffect = Effect.gen(function* () {
  const firstRequest = NativeLLM.request({
    model: formalModel,
    system: [
      SystemPart.make(paritySystemPrompt),
      SystemPart.make(CoreStructuredOutput.systemPrompt({ retriesUsed: 0, retryCount: 1 })),
    ],
    messages: [NativeMessage.user(structuredOutputPrompt)],
    tools: [nativeStructuredOutputTool],
    toolChoice: { type: "required" },
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const client = yield* LLMClient.Service
  const firstPrepared = yield* client.prepare(firstRequest)
  const firstEvents = Array.from(yield* client.stream(firstRequest).pipe(Stream.runCollect))
  const invalidCall = firstEvents.find(LLMEvent.is.toolCall)
  if (!invalidCall) throw new Error("structured-output cassette did not emit the invalid tool call")
  const invalidSettlement = yield* ToolRuntime.dispatch(
    { [CoreStructuredOutput.name]: providerStructuredOutputTool },
    invalidCall,
  )
  if (invalidSettlement.result.type !== "error")
    throw new Error("structured-output invalid provider call unexpectedly passed validation")

  const secondRequest = NativeLLM.request({
    model: formalModel,
    system: [
      SystemPart.make(paritySystemPrompt),
      SystemPart.make(CoreStructuredOutput.systemPrompt({ retriesUsed: 1, retryCount: 1 })),
    ],
    messages: [
      NativeMessage.user(structuredOutputPrompt),
      NativeMessage.assistant([
        ToolCallPart.make({
          id: invalidCall.id,
          name: CoreStructuredOutput.name,
          input: structuredOutputInvalid,
        }),
      ]),
      NativeMessage.tool(
        ToolResultPart.make({
          id: invalidCall.id,
          name: CoreStructuredOutput.name,
          result: invalidSettlement.result.value,
          resultType: "error",
        }),
      ),
    ],
    tools: [nativeStructuredOutputTool],
    toolChoice: { type: "required" },
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const secondPrepared = yield* client.prepare(secondRequest)
  const secondEvents = Array.from(yield* client.stream(secondRequest).pipe(Stream.runCollect))
  const validCall = secondEvents.find(LLMEvent.is.toolCall)
  if (!validCall) throw new Error("structured-output cassette did not emit the corrected tool call")
  const validSettlement = yield* ToolRuntime.dispatch(
    { [CoreStructuredOutput.name]: providerStructuredOutputTool },
    validCall,
  )
  if (validSettlement.result.type === "error")
    throw new Error(`structured-output corrected provider call failed: ${String(validSettlement.result.value)}`)
  return {
    requests: [firstRequest, secondRequest] as const,
    prepared: [firstPrepared, secondPrepared] as const,
    events: [
      ...firstEvents,
      ...invalidSettlement.events,
      ...offsetProviderSteps(secondEvents, 1),
      ...validSettlement.events,
    ],
  }
})
const replayProviderStructuredOutput = inFreshLayer(providerStructuredOutputEffect, structuredOutputFormalClient)

const nativeActionReplayTool = ToolDefinition.make({
  name: actionReplayToolName,
  description: actionReplayToolDescription,
  inputSchema: { ...actionReplayToolInputSchema },
})
const providerActionReplayTool = NativeTool.make({
  description: actionReplayToolDescription,
  parameters: Schema.Struct({ marker: Schema.String }),
  success: Schema.String,
  execute: () => Effect.succeed(actionReplayToolOutput),
})
const providerActionReplayEffect = Effect.gen(function* () {
  const client = yield* LLMClient.Service
  const firstRequest = NativeLLM.request({
    model: formalModel,
    system: paritySystemPrompt,
    prompt: actionReplayPrompt,
    tools: [nativeActionReplayTool],
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const firstPrepared = yield* client.prepare(firstRequest)
  const firstEvents = Array.from(yield* client.stream(firstRequest).pipe(Stream.runCollect))
  const firstCall = firstEvents.find(LLMEvent.is.toolCall)
  if (!firstCall) throw new Error("action-replay cassette did not emit the initial tool call")
  const firstSettlement = yield* ToolRuntime.dispatch({ [actionReplayToolName]: providerActionReplayTool }, firstCall)

  const firstHistory = [
    NativeMessage.user(actionReplayPrompt),
    NativeMessage.assistant([
      ToolCallPart.make({ id: firstCall.id, name: actionReplayToolName, input: actionReplayToolInput }),
    ]),
    NativeMessage.tool(
      ToolResultPart.make({
        id: firstCall.id,
        name: actionReplayToolName,
        result: firstSettlement.result.value,
        resultType: "text",
      }),
    ),
  ] as const
  const secondRequest = NativeLLM.request({
    model: formalModel,
    system: paritySystemPrompt,
    messages: firstHistory,
    tools: [nativeActionReplayTool],
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const secondPrepared = yield* client.prepare(secondRequest)
  const secondEvents = Array.from(yield* client.stream(secondRequest).pipe(Stream.runCollect))
  const secondCall = secondEvents.find(LLMEvent.is.toolCall)
  if (!secondCall) throw new Error("action-replay cassette did not repeat the tool call")
  if (secondCall.id !== firstCall.id || canonicalHash(secondCall.input) !== canonicalHash(firstCall.input))
    throw new Error("action-replay cassette changed the stable tool-call identity")
  const replayResult = LLMEvent.toolResult({
    id: secondCall.id,
    name: actionReplayToolName,
    result: firstSettlement.result,
    output: firstSettlement.output,
  })

  const thirdRequest = NativeLLM.request({
    model: formalModel,
    system: paritySystemPrompt,
    messages: [
      ...firstHistory,
      NativeMessage.assistant([
        ToolCallPart.make({ id: secondCall.id, name: actionReplayToolName, input: actionReplayToolInput }),
      ]),
      NativeMessage.tool(
        ToolResultPart.make({
          id: secondCall.id,
          name: actionReplayToolName,
          result: firstSettlement.result.value,
          resultType: "text",
        }),
      ),
    ],
    tools: [nativeActionReplayTool],
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const thirdPrepared = yield* client.prepare(thirdRequest)
  const thirdEvents = Array.from(yield* client.stream(thirdRequest).pipe(Stream.runCollect))
  return {
    requests: [firstRequest, secondRequest, thirdRequest] as const,
    prepared: [firstPrepared, secondPrepared, thirdPrepared] as const,
    events: [
      ...firstEvents,
      ...firstSettlement.events,
      ...offsetProviderSteps(secondEvents, 1),
      replayResult,
      ...offsetProviderSteps(thirdEvents, 2),
    ],
  }
})
const replayProviderActionReplay = inFreshLayer(providerActionReplayEffect, actionReplayFormalClient)

const nativeSteerTool = ToolDefinition.make({
  name: steerToolName,
  description: steerToolDescription,
  inputSchema: { ...steerToolInputSchema },
})
const providerSteerTool = NativeTool.make({
  description: steerToolDescription,
  parameters: Schema.Struct({}),
  success: Schema.String,
  execute: () => Effect.succeed(steerToolOutput),
})
const offsetProviderSteps = (events: ReadonlyArray<LLMEvent>, offset: number) =>
  events.map((event) =>
    event.type === "step-start" || event.type === "step-finish" ? { ...event, index: event.index + offset } : event,
  )
const providerSteerEffect = Effect.gen(function* () {
  const firstRequest = NativeLLM.request({
    model: formalModel,
    system: paritySystemPrompt,
    prompt: steerInitialPrompt,
    tools: [nativeSteerTool],
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const client = yield* LLMClient.Service
  const firstPrepared = yield* client.prepare(firstRequest)
  const firstEvents = Array.from(yield* client.stream(firstRequest).pipe(Stream.runCollect))
  const toolCall = firstEvents.find(LLMEvent.is.toolCall)
  if (!toolCall) throw new Error("full-runner steer cassette did not emit the expected tool call")
  const dispatched = yield* ToolRuntime.dispatch({ [steerToolName]: providerSteerTool }, toolCall)
  const secondRequest = NativeLLM.request({
    model: formalModel,
    system: paritySystemPrompt,
    messages: [
      NativeMessage.user(steerInitialPrompt),
      NativeMessage.assistant([ToolCallPart.make({ id: "call_1", name: steerToolName, input: {} })]),
      NativeMessage.tool(
        ToolResultPart.make({
          id: "call_1",
          name: steerToolName,
          result: dispatched.result.value,
          resultType: "text",
        }),
      ),
      NativeMessage.user(steerPrompt),
    ],
    tools: [nativeSteerTool],
    providerOptions: { openai: { store: false } },
    generation: { maxTokens: 20, temperature: 0 },
  })
  const secondPrepared = yield* client.prepare(secondRequest)
  const secondEvents = Array.from(yield* client.stream(secondRequest).pipe(Stream.runCollect))
  return {
    requests: [firstRequest, secondRequest] as const,
    prepared: [firstPrepared, secondPrepared] as const,
    events: [...firstEvents, ...dispatched.events, ...offsetProviderSteps(secondEvents, 1)],
  }
})
const replayProviderSteer = inFreshLayer(providerSteerEffect, steerFormalClient)

const nativeCancelTool = ToolDefinition.make({
  name: cancelToolName,
  description: cancelToolDescription,
  inputSchema: { ...steerToolInputSchema },
})
const providerCancelEffect = Effect.scoped(
  Effect.gen(function* () {
    const request = NativeLLM.request({
      model: formalModel,
      system: paritySystemPrompt,
      prompt: cancelInitialPrompt,
      tools: [nativeCancelTool],
      providerOptions: { openai: { store: false } },
      generation: { maxTokens: 20, temperature: 0 },
    })
    const client = yield* LLMClient.Service
    const prepared = yield* client.prepare(request)
    const providerEvents = Array.from(yield* client.stream(request).pipe(Stream.runCollect))
    const toolCall = providerEvents.find(LLMEvent.is.toolCall)
    if (!toolCall) throw new Error("full-runner cancel cassette did not emit the expected tool call")
    const toolEntered = yield* Deferred.make<void>()
    const providerCancelTool = NativeTool.make({
      description: cancelToolDescription,
      parameters: Schema.Struct({}),
      success: Schema.String,
      execute: () => Deferred.succeed(toolEntered, void 0).pipe(Effect.andThen(Effect.never)),
    })
    const dispatchFiber = yield* ToolRuntime.dispatch({ [cancelToolName]: providerCancelTool }, toolCall).pipe(
      Effect.forkChild,
    )
    yield* Deferred.await(toolEntered)
    yield* Fiber.interrupt(dispatchFiber)
    const dispatchExit = yield* Fiber.await(dispatchFiber)
    if (!Exit.isFailure(dispatchExit) || !Cause.hasInterruptsOnly(dispatchExit.cause))
      throw new Error("provider cancel tool did not terminate through interruption")
    const interruptionResult = { type: "error" as const, value: interruptedErrorMessage }
    const recoveryRequest = NativeLLM.request({
      model: formalModel,
      system: paritySystemPrompt,
      messages: [
        NativeMessage.user(cancelInitialPrompt),
        NativeMessage.assistant([ToolCallPart.make({ id: toolCall.id, name: cancelToolName, input: {} })]),
        NativeMessage.tool(
          ToolResultPart.make({
            id: toolCall.id,
            name: cancelToolName,
            result: interruptionResult.value,
            resultType: "error",
          }),
        ),
      ],
      tools: [nativeCancelTool],
      providerOptions: { openai: { store: false } },
      generation: { maxTokens: 20, temperature: 0 },
    })
    const recoveryPrepared = yield* client.prepare(recoveryRequest)
    const recoveryEvents = Array.from(yield* client.stream(recoveryRequest).pipe(Stream.runCollect))
    return {
      requests: [request, recoveryRequest] as const,
      prepared: [prepared, recoveryPrepared] as const,
      events: [
        ...providerEvents,
        LLMEvent.toolError({
          id: toolCall.id,
          name: toolCall.name,
          message: interruptionResult.value,
        }),
        LLMEvent.toolResult({ id: toolCall.id, name: toolCall.name, result: interruptionResult }),
      ],
      recoveryEvents,
    }
  }),
)
const replayProviderCancel = inFreshLayer(providerCancelEffect, cancelFormalClient)

describe("full SessionRunner queue historical cassette", () => {
  const run = testEffect(Layer.empty, { git: true }).instance
  run(
    "runs provider and Formal against the frozen queue baseline without Mature execution",
    () =>
      Effect.gen(function* () {
        const formal = yield* runFormalQueue
        const provider = yield* replayProviderQueue
        const providerTrace = SessionRunnerParity.fromProviderEvents(provider.events, {
          terminalStatus: "completed",
          requestCount: 1,
          checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
        })
        expect(SessionRunnerParity.compare(providerTrace, formal.trace).differences).toEqual([])
        expect(formal.summary).toMatchObject({
          sessionID: formalSessionID,
          status: "completed",
          attempt: 1,
          checkpointPresent: true,
        })
        expect(formal.summary.transition).not.toHaveProperty("reason")
        expect(
          SessionRunnerHistory.assertTerminalHistory(formal.history, { status: "completed", attempt: 1 }),
        ).toMatchObject({
          status: "completed",
          checkpointPresent: true,
        })
        expect(SessionRunnerHistory.checkpointFromHistory(formal.history)).toMatchObject({
          version: 1,
          sessionID: formalSessionID,
          phase: "idle",
          nextStep: 2,
          needsContinuation: false,
          legacy: false,
        })
        expect(formal.rows.every((row) => row.id.startsWith("evt_"))).toBe(true)
        expect(formal.rows.some((row) => row.type === SessionRunnerHistory.runnerHistoryTypes.runCreated)).toBe(true)
        expect(
          formal.rows.some(
            (row) =>
              row.aggregateID === formal.summary.runID &&
              row.type === SessionRunnerHistory.runnerHistoryTypes.stateChanged &&
              row.data.to === "completed",
          ),
        ).toBe(true)
        expect(formal.messages.filter((message) => message.type === "user")).toHaveLength(1)
        const assistants = formal.messages.filter((message) => message.type === "assistant")
        expect(assistants).toHaveLength(1)
        const assistant = assistants[0]!
        expect(assistant.finish).toBe("stop")
        expect(assistant.error).toBeUndefined()
        expect(assistant.time.completed).toBeDefined()
        expect(assistant.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }))
        const fixture = yield* Effect.promise(() =>
          Bun.file(path.join(cassetteDirectory, `${cassetteName}.json`)).json(),
        )
        const recordedBody = fixture.interactions?.[0]?.request?.body
        if (typeof recordedBody !== "string") throw new Error("queue cassette request body missing")
        expect(fixture.interactions).toHaveLength(1)
        expect(recordedBody.split(requestScopedSystem)).toHaveLength(2)
        expect(recordedBody.indexOf(paritySystemPrompt)).toBeLessThan(recordedBody.indexOf(requestScopedSystem))
        const transportRequestDigest = canonicalHash(JSON.parse(recordedBody))
        if (!transportRequestDigest) throw new Error("queue request cannot be canonicalized")
        admitHistoricalResult({
          scenario: "queue",
          trace: formal.trace,
          evidence: formal.durable.execution,
          request: formal.durable.request,
          transportRequestDigest,
        })
      }),
    40_000,
  )
})

describe("full SessionRunner steer historical cassette", () => {
  const run = testEffect(Layer.empty, { git: true }).instance
  run(
    "absorbs a running-tool steer through Formal and the frozen historical baseline",
    () =>
      Effect.gen(function* () {
        const formal = yield* runFormalSteer
        const provider = yield* replayProviderSteer
        const providerTrace = SessionRunnerParity.fromProviderEvents(provider.events, {
          terminalStatus: "completed",
          requestCount: 2,
          checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
        })
        expect(SessionRunnerParity.compare(providerTrace, formal.trace).differences).toEqual([])
        expect(formal.summary).toMatchObject({ status: "completed", attempt: 1, checkpointPresent: true })
        expect(SessionRunnerHistory.checkpointFromHistory(formal.history)).toMatchObject({
          version: 1,
          phase: "idle",
          nextStep: 2,
          needsContinuation: false,
          legacy: false,
        })
        const users = formal.messages.filter((message) => message.type === "user")
        const assistants = formal.messages.filter((message) => message.type === "assistant")
        expect(users).toHaveLength(2)
        expect(assistants).toHaveLength(2)
        expect(users.at(-1)).toMatchObject({ id: "msg_full_runner_formal_steer" })
        expect(users.at(-1)).toMatchObject({ text: steerPrompt })
        expect(assistants[0]?.content).toContainEqual(
          expect.objectContaining({
            type: "tool",
            name: steerToolName,
            state: expect.objectContaining({ status: "completed" }),
          }),
        )
        expect(assistants.at(-1)?.content).toContainEqual(
          expect.objectContaining({ type: "text", text: steerFinalText }),
        )
        expect(assistants.every((message) => message.error === undefined && message.time.completed !== undefined)).toBe(
          true,
        )
        const fixture = (yield* Effect.promise(() =>
          Bun.file(path.join(cassetteDirectory, `${steerCassetteName}.json`)).json(),
        )) as { interactions?: Array<{ request?: { body?: string } }> }
        const bodies = fixture.interactions?.map((interaction) => interaction.request?.body)
        if (!bodies || bodies.length !== 2 || bodies.some((body) => typeof body !== "string"))
          throw new Error("steer cassette must contain exactly two request bodies")
        expect(bodies[1]).toContain(steerPrompt)
        const transportRequestDigest = canonicalHash(bodies.map((body) => JSON.parse(body!)))
        if (!transportRequestDigest) throw new Error("steer request cannot be canonicalized")
        admitHistoricalResult({
          scenario: "steer",
          trace: formal.trace,
          evidence: formal.durable.execution,
          request: formal.durable.request,
          transportRequestDigest,
        })
      }),
    40_000,
  )
})

describe("full SessionRunner cancel historical cassette", () => {
  const run = testEffect(Layer.empty, { git: true }).instance
  run(
    "interrupts a tool and resumes the same Formal run against the frozen baseline",
    () =>
      Effect.gen(function* () {
        const formal = yield* runFormalCancel
        const provider = yield* replayProviderCancel
        const providerTrace = SessionRunnerParity.fromProviderEvents(provider.events, {
          terminalStatus: "paused",
          requestCount: 1,
          checkpoint: { phase: "continuation", nextStep: 2, needsContinuation: true },
        })
        expect(Exit.isFailure(formal.resumeExit) && Cause.hasInterruptsOnly(formal.resumeExit.cause)).toBe(true)
        expect(formal.summary).toMatchObject({ status: "paused", attempt: 1, checkpointPresent: true })
        expect(SessionRunnerHistory.checkpointFromHistory(formal.history)).toMatchObject({
          version: 1,
          phase: "continuation",
          nextStep: 2,
          needsContinuation: true,
          legacy: false,
        })
        expect(formal.messages.filter((message) => message.type === "user")).toHaveLength(1)
        const cancelled = formal.messages.filter((message) => message.type === "assistant")
        expect(cancelled).toHaveLength(1)
        // The provider turn completed before the tool was interrupted; the
        // failure belongs to the tool result, not a fabricated provider error.
        expect(cancelled[0]?.error).toBeUndefined()
        expect(cancelled[0]?.time.completed).toBeDefined()
        expect(cancelled[0]?.content).toContainEqual(
          expect.objectContaining({
            type: "tool",
            name: cancelToolName,
            state: expect.objectContaining({
              status: "error",
              error: expect.objectContaining({ message: interruptedErrorMessage }),
            }),
            time: expect.objectContaining({ completed: expect.anything() }),
          }),
        )
        expect(formal.recovered.summary).toMatchObject({
          runID: formal.summary.runID,
          status: "failed",
          attempt: 2,
          checkpointPresent: true,
        })
        expect(SessionRunnerHistory.checkpointFromHistory(formal.recovered.history)).toMatchObject({
          phase: "idle",
          nextStep: 3,
          needsContinuation: false,
        })
        const recoveredRequest = SessionRunnerHistory.formalEvidenceFromHistory(formal.recovered.history).request
        expect(recoveredRequest).toMatchObject({ runID: formal.summary.runID, turnStep: 2, attempt: 2 })
        expect(formal.recovered.messages.slice(0, formal.messages.length)).toEqual(formal.messages)
        expect(formal.recovered.messages.filter((message) => message.type === "user")).toHaveLength(1)
        const answers = formal.recovered.messages.filter((message) => message.type === "assistant")
        expect(answers).toHaveLength(2)
        expect(answers.at(-1)?.content).toContainEqual(
          expect.objectContaining({ type: "text", text: cancelRecoveredText }),
        )
        expect(answers.at(-1)?.error).toBeUndefined()
        expect(answers.at(-1)?.time.completed).toBeDefined()
        expect(provider.recoveryEvents).toContainEqual(
          expect.objectContaining({ type: "text-delta", text: cancelRecoveredText }),
        )
        expect(SessionRunnerParity.compare(providerTrace, formal.trace).differences).toEqual([])
        const fixture = (yield* Effect.promise(() =>
          Bun.file(path.join(cassetteDirectory, `${cancelCassetteName}.json`)).json(),
        )) as { interactions?: Array<{ request?: { body?: string } }> }
        const bodies = fixture.interactions?.map((interaction) => interaction.request?.body)
        if (!bodies || bodies.length !== 2 || bodies.some((body) => typeof body !== "string"))
          throw new Error("cancel cassette must contain exactly two request bodies")
        const transportRequestDigest = canonicalHash(bodies.map((body) => JSON.parse(body!)))
        if (!transportRequestDigest) throw new Error("cancel request cannot be canonicalized")
        admitHistoricalResult({
          scenario: "cancel",
          trace: formal.trace,
          evidence: formal.durable.execution,
          request: formal.durable.request,
          transportRequestDigest,
        })
      }),
    40_000,
  )
})

describe("full SessionRunner compaction historical cassette", () => {
  const run = testEffect(Layer.empty, { git: true }).instance
  run(
    "commits one Formal compaction and continues from the frozen recorded summary",
    () =>
      Effect.gen(function* () {
        const formal = yield* runFormalCompaction
        const provider = yield* replayProviderCompaction
        const providerTrace = SessionRunnerParity.fromProviderEvents(provider.events, {
          terminalStatus: "completed",
          requestCount: 2,
          checkpoint: { phase: "idle", nextStep: 2, needsContinuation: false },
        })
        expect(formal.summary).toMatchObject({ status: "completed", attempt: 1, checkpointPresent: true })
        expect(formal.operations).toHaveLength(1)
        expect(formal.operations[0]).toMatchObject({ status: "committed", lastPhase: "closed" })
        expect(formal.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
          "prepared",
          "summarizing",
          "summarized",
          "revalidated",
          "committed",
          "closed",
        ])
        expect(formal.checkpoints.map((checkpoint) => checkpoint.reason)).toEqual([
          undefined,
          undefined,
          undefined,
          undefined,
          "compacted",
          "compacted",
        ])
        const compactions = formal.messages.filter((message) => message.type === "compaction")
        expect(compactions).toHaveLength(1)
        expect(compactions[0]).toMatchObject({ reason: "auto", summary: compactionSummaryText })
        const answer = formal.messages.findLast((message) => message.type === "assistant")
        expect(answer?.content).toContainEqual(expect.objectContaining({ type: "text", text: compactionFinalText }))
        expect(answer?.finish).toBe("stop")
        expect(answer?.error).toBeUndefined()
        expect(answer?.time.completed).toBeDefined()
        expect(SessionRunnerParity.compare(providerTrace, formal.trace).differences).toEqual([])
        const fixture = (yield* Effect.promise(() =>
          Bun.file(path.join(cassetteDirectory, `${compactionCassetteName}.json`)).json(),
        )) as { interactions?: Array<{ request?: { body?: string } }> }
        const bodies = fixture.interactions?.map((interaction) => interaction.request?.body)
        if (!bodies || bodies.length !== 2 || bodies.some((body) => typeof body !== "string"))
          throw new Error("compaction cassette must contain exactly two request bodies")
        expect(bodies[0]).toContain(compactionOldText)
        expect(bodies[1]).toContain(JSON.stringify(compactionSummaryText).slice(1, -1))
        expect(bodies[1]).toContain(compactionRecentText)
        expect(bodies[1]).not.toContain(compactionOldText)
        const transportRequestDigest = canonicalHash(bodies.map((body) => JSON.parse(body!)))
        if (!transportRequestDigest) throw new Error("compaction request cannot be canonicalized")
        admitHistoricalResult({
          scenario: "compaction",
          trace: formal.trace,
          evidence: formal.durable.execution,
          request: formal.durable.request,
          transportRequestDigest,
        })
      }),
    40_000,
  )
})

describe("full SessionRunner structured-output historical cassette", () => {
  const run = testEffect(Layer.empty, { git: true }).instance
  run(
    "retries one invalid Formal result and persists the exact structured answer",
    () =>
      Effect.gen(function* () {
        const formal = yield* runFormalStructuredOutput
        const provider = yield* replayProviderStructuredOutput
        const providerTrace = SessionRunnerParity.fromProviderEvents(provider.events, {
          terminalStatus: "completed",
          requestCount: 2,
          checkpoint: { phase: "idle", nextStep: 3, needsContinuation: false },
        })
        expect(formal.summary).toMatchObject({ status: "completed", attempt: 1, checkpointPresent: true })
        expect(SessionRunnerParity.compare(providerTrace, formal.trace).differences).toEqual([])
        const assistants = formal.messages.filter((message) => message.type === "assistant")
        expect(assistants).toHaveLength(2)
        expect(assistants[0]?.content).toContainEqual(
          expect.objectContaining({
            type: "tool",
            name: CoreStructuredOutput.name,
            state: expect.objectContaining({
              status: "error",
              error: expect.objectContaining({ message: expect.stringContaining("founded") }),
            }),
          }),
        )
        expect(assistants[0]?.structured).toBeUndefined()
        expect(assistants[1]).toMatchObject({ finish: "stop", structured: structuredOutputFinal })
        expect(assistants[1]?.structured).toEqual(structuredOutputFinal)
        expect(assistants[1]?.error).toBeUndefined()
        expect(assistants.every((assistant) => assistant.time.completed !== undefined)).toBe(true)
        expect(
          assistants
            .flatMap((assistant) => assistant.content)
            .filter(
              (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
            ),
        ).toHaveLength(0)
        const fixture = (yield* Effect.promise(() =>
          Bun.file(path.join(cassetteDirectory, `${structuredOutputCassetteName}.json`)).json(),
        )) as { interactions?: Array<{ request?: { body?: string } }> }
        const bodies = fixture.interactions?.flatMap((interaction) =>
          interaction.request?.body ? [JSON.parse(interaction.request.body)] : [],
        ) as
          | Array<{
              messages?: Array<Record<string, unknown>>
              tools?: Array<Record<string, unknown>>
              tool_choice?: unknown
            }>
          | undefined
        if (bodies?.length !== 2) throw new Error("structured-output cassette must contain exactly two request bodies")
        expect(bodies[0]?.tool_choice).toBe("required")
        expect(bodies[1]?.tool_choice).toBe("required")
        expect(bodies[0]?.tools).toHaveLength(1)
        expect(bodies[1]?.tools).toEqual(bodies[0]?.tools)
        expect(JSON.stringify(bodies[0]?.messages)).toContain("1 structured-output retry")
        expect(JSON.stringify(bodies[1]?.messages)).toContain("0 structured-output retries")
        expect(JSON.stringify(bodies[1]?.messages)).toContain("Invalid tool input: $.founded: is required")
        expect(JSON.stringify(bodies[1]?.messages)).not.toContain(JSON.stringify(structuredOutputFinal))
        const transportRequestDigest = canonicalHash(bodies)
        if (!transportRequestDigest) throw new Error("structured-output request cannot be canonicalized")
        admitHistoricalResult({
          scenario: "structured-output",
          trace: formal.trace,
          evidence: formal.durable.execution,
          request: formal.durable.request,
          transportRequestDigest,
        })
      }),
    40_000,
  )
})

describe("full SessionRunner action-replay historical cassette", () => {
  const run = testEffect(Layer.empty, { git: true }).instance
  run(
    "reuses one settled Formal action for repeated calls without executing Mature",
    () =>
      Effect.gen(function* () {
        const formal = yield* runFormalActionReplay
        const provider = yield* replayProviderActionReplay
        const providerTrace = SessionRunnerParity.fromProviderEvents(provider.events, {
          terminalStatus: "completed",
          requestCount: 3,
          checkpoint: { phase: "idle", nextStep: 4, needsContinuation: false },
        })
        expect(formal.executions).toBe(1)
        expect(formal.summary).toMatchObject({ status: "completed", attempt: 1, checkpointPresent: true })
        expect(SessionRunnerHistory.checkpointFromHistory(formal.history)).toMatchObject({
          phase: "idle",
          nextStep: 4,
          needsContinuation: false,
          legacy: false,
        })
        const assistants = formal.messages.filter((message) => message.type === "assistant")
        expect(assistants).toHaveLength(3)
        const tools = assistants
          .flatMap((assistant) => assistant.content)
          .filter((part) => part.type === "tool" && part.name === actionReplayToolName)
        expect(tools).toHaveLength(2)
        for (const tool of tools) {
          if (tool.type !== "tool") throw new Error("expected a replayed tool")
          expect(tool.state.status).toBe("completed")
          if (tool.state.status !== "completed") throw new Error("replayed tool did not complete")
          expect(tool.state.content).toContainEqual(
            expect.objectContaining({ type: "text", text: actionReplayToolOutput }),
          )
          expect(tool.time.completed).toBeDefined()
        }
        expect(assistants.at(-1)?.content).toContainEqual(
          expect.objectContaining({ type: "text", text: actionReplayFinalText }),
        )
        expect(
          assistants.every((assistant) => assistant.error === undefined && assistant.time.completed !== undefined),
        ).toBe(true)
        expect(formal.actionRows.filter((row) => row.type === "agent.action.proposed.1")).toHaveLength(1)
        expect(formal.actionRows.filter((row) => row.type === "agent.action.observed.1")).toHaveLength(1)
        expect(
          formal.actionRows.filter(
            (row) => row.type === "agent.action.state-changed.1" && (row.data as { to?: string }).to === "settled",
          ),
        ).toHaveLength(1)
        expect(SessionRunnerParity.compare(providerTrace, formal.trace).differences).toEqual([])
        const fixture = (yield* Effect.promise(() =>
          Bun.file(path.join(cassetteDirectory, `${actionReplayCassetteName}.json`)).json(),
        )) as { interactions?: Array<{ request?: { body?: string } }> }
        const bodies = fixture.interactions?.flatMap((interaction) =>
          interaction.request?.body ? [JSON.parse(interaction.request.body)] : [],
        ) as Array<{ messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> }> | undefined
        if (bodies?.length !== 3) throw new Error("action-replay cassette must contain exactly three request bodies")
        expect(bodies[0]?.tools).toHaveLength(1)
        expect(bodies[1]?.tools).toEqual(bodies[0]?.tools)
        expect(bodies[2]?.tools).toEqual(bodies[0]?.tools)
        expect(JSON.stringify(bodies[1]?.messages)).toContain(actionReplayToolOutput)
        expect(JSON.stringify(bodies[2]?.messages).match(new RegExp(actionReplayToolOutput, "g"))).toHaveLength(2)
        const transportRequestDigest = canonicalHash(bodies)
        if (!transportRequestDigest) throw new Error("action-replay request cannot be canonicalized")
        admitHistoricalResult({
          scenario: "action-replay",
          trace: formal.trace,
          evidence: formal.durable.execution,
          request: formal.durable.request,
          transportRequestDigest,
        })
      }),
    40_000,
  )
})

describe("full SessionRunner historical completion gate", () => {
  test("requires all six Formal results against the fixed historical baseline", () => {
    expect([...completedParityEntries.keys()]).toEqual([...SessionRunnerParityMatrix.requiredScenarios])
    expect(historicalBaseline.schemaVersion).toBe(1)
    expect(historicalBaseline.scenarios.map((entry) => entry.scenario)).toEqual([
      ...SessionRunnerParityMatrix.requiredScenarios,
    ])
    for (const entry of completedParityEntries.values()) {
      assertFormalHistoricalBaseline(
        entry.scenario,
        entry.trace,
        entry.evidence,
        entry.request,
        entry.transportRequestDigest,
      )
    }
  })

  test("rejects historical baseline changes without running the legacy adapter again", () => {
    const entry = completedParityEntries.get("queue")
    if (!entry) throw new Error("queue must complete before historical mutation checks")
    for (const change of ["tokens", "requests", "cursor", "transport", "missing", "duplicate"] as const) {
      const baseline = structuredClone(historicalBaseline.scenarios)
      const queue = baseline.find((item) => item.scenario === "queue")!
      if (change === "tokens") queue.budget.tokensUsed += 1
      if (change === "requests") queue.trace.requestCount += 1
      if (change === "cursor") queue.requestCursor.turnStep += 1
      if (change === "transport") queue.transportRequestDigest = "0".repeat(64)
      if (change === "missing") baseline.splice(baseline.indexOf(queue), 1)
      if (change === "duplicate") baseline.push(queue)
      expect(() =>
        assertFormalHistoricalBaseline(
          entry.scenario,
          entry.trace,
          entry.evidence,
          entry.request,
          entry.transportRequestDigest,
          baseline,
        ),
      ).toThrow()
    }
  })
})
