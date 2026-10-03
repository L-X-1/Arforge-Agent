import { beforeEach, describe, expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  TransportReason,
  InvalidRequestReason,
  type LLMClientShape,
  type LLMRequest,
  type PreparedRequest,
} from "@arforge-ai/llm"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import * as AnthropicMessages from "@arforge-ai/llm/protocols/anthropic-messages"
import { Database } from "@arforge-ai/core/database/database"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { ContextSurface } from "@arforge-ai/core/context-surface"
import { makeLocationNode } from "@arforge-ai/core/effect/app-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@arforge-ai/core/effect/app-node-platform"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { PrimaryDeliveryState } from "@arforge-ai/core/primary-delivery-state"
import { EventTable } from "@arforge-ai/core/event/sql"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { QuestionV2 } from "@arforge-ai/core/question"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { Snapshot } from "@arforge-ai/core/snapshot"
import { ContextSnapshotDecodeError } from "@arforge-ai/core/session/error"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionCompactionCheckpoint } from "@arforge-ai/core/session/compaction-checkpoint"
import { SessionCompaction } from "@arforge-ai/core/session/compaction"
import { ResultPruner } from "@arforge-ai/core/session/result-pruner"
import { parseRequestEnvelopeJson } from "@arforge-ai/core/session/request-envelope"
import { SessionInput } from "@arforge-ai/core/session/input"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionOrganization } from "@arforge-ai/core/session/organization"
import { Prompt, RequestSystem } from "@arforge-ai/core/session/prompt"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"
import { SessionRunner } from "@arforge-ai/core/session/runner"
import {
  compare as compareSessionParity,
  fromCoreMessages as fromCoreParity,
  make as makeSessionParity,
} from "@arforge-ai/core/session/runner/parity"
import * as SessionRunnerLLM from "@arforge-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { Tools } from "@arforge-ai/core/tool/tools"
import { ApplicationTools } from "@arforge-ai/core/tool/application-tools"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Config } from "@arforge-ai/core/config"
import { ConfigCompaction } from "@arforge-ai/core/config/compaction"
import { GoalV2 } from "@arforge-ai/core/goal"
import { Tool } from "@arforge-ai/core/tool/tool"
import { StructuredOutput } from "@arforge-ai/core/tool/structured-output"
import { TurnToolCarrier } from "@arforge-ai/core/tool/turn-carrier"
import { scopedChange } from "@arforge-ai/core/tool/effect-semantics"
import {
  SessionContextEpochTable,
  SessionCompactionCheckpointTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@arforge-ai/core/session/sql"
import { SessionStore } from "@arforge-ai/core/session/store"
import { SystemContext } from "@arforge-ai/core/system-context"
import { SystemContextRegistry } from "@arforge-ai/core/system-context/registry"
import { SkillGuidance } from "@arforge-ai/core/skill/guidance"
import { ReferenceGuidance } from "@arforge-ai/core/reference/guidance"
import { ModelV2 } from "@arforge-ai/core/model"
import { Location } from "@arforge-ai/core/location"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { MemoryV2 } from "@arforge-ai/core/memory"
import { MemoryCandidateTable } from "@arforge-ai/core/memory/sql"
import { LearningV2 } from "@arforge-ai/core/learning"
import { EvolutionV2 } from "@arforge-ai/core/evolution"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"
import { SubagentProvider } from "@arforge-ai/core/runtime/subagent-provider"
import * as SessionCheckpoint from "@arforge-ai/core/session/checkpoint"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { SessionRunUsageTable } from "@arforge-ai/core/runtime/sql"
import * as RuntimeBilling from "@arforge-ai/core/runtime/billing"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Billing } from "@arforge-ai/schema/billing"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Schema, Stream } from "effect"
import { fileURLToPath } from "node:url"
import * as TestClock from "effect/testing/TestClock"
import { asc, eq, sql } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
const preparedRequests = new WeakMap<PreparedRequest, LLMRequest>()
const preparedSends: PreparedRequest[] = []
const preparations: PreparedRequest[] = []
let forbidLegacyStream = false
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
let evolutionPrepared: EvolutionV2.PreparedContext = EvolutionV2.emptyContext
let evolutionPrepareFailure = false
const evolutionOutcomes: Array<{
  readonly exposureID: string
  readonly success: boolean
  readonly stopReason?: string
}> = []
const evolutionLearningSyncs: Array<ReadonlyArray<EvolutionV2.LearningPatternEvidence>> = []

beforeEach(() => {
  preparedSends.length = 0
  preparations.length = 0
  forbidLegacyStream = false
  evolutionPrepared = EvolutionV2.emptyContext
  evolutionPrepareFailure = false
  evolutionOutcomes.length = 0
  evolutionLearningSyncs.length = 0
})
const fixtureStream = (request: LLMRequest) => {
  requests.push(request)
  if (responseStream) {
    const stream = responseStream
    responseStream = undefined
    return stream
  }
  const events = streamFailure
    ? Stream.fail(streamFailure)
    : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
  if (!streamGate) return events
  return Stream.unwrap(
    (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
      Effect.andThen(Deferred.await(streamGate)),
      Effect.as(events),
    ),
  )
}
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: <Body = unknown>(request: LLMRequest) =>
      LLMClient.prepare<Body>(request).pipe(
        Effect.tap((prepared) =>
          Effect.sync(() => {
            preparedRequests.set(prepared, request)
            preparations.push(prepared)
          }),
        ),
      ),
    streamPrepared: (prepared) =>
      Stream.suspend(() => {
        const request = preparedRequests.get(prepared)
        if (!request) return Stream.die("Unknown or consumed fixture preparation")
        preparedRequests.delete(prepared)
        preparedSends.push(prepared)
        return fixtureStream(request)
      }),
    stream: ((request: LLMRequest) => {
      if (forbidLegacyStream) return Stream.die("Legacy stream was called instead of the preparation")
      return fixtureStream(request)
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
let fallbackModel: Model | undefined
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const prunerModel = Model.make({
  id: "result-pruner",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 8_000, output: 50 } }),
})
const authorizations: Tool.Context[] = []
const executions: string[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    // The gateway evaluates every L2/L3 authorization as one atomic preflight
    // through PermissionV2.assert (forceAsk for human tiers). The denial and
    // interruption behaviors under test live in the tool executors below;
    // this mock approves the preflight so those executors are reached.
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const secretLayer = Layer.succeed(
  SecretProvider.Service,
  SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(7), "test-session-runner-authorization-aes-256-gcm"),
)
let defectExecutions = 0
const echo = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const primary = yield* PrimaryDeliveryState.Service
    const events = yield* EventV2.Service
    yield* registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        // Exercise the real bounded safe lane in the runner integration
        // test. Tools without this declaration remain exclusive by default.
        metadata: { concurrency: "safe", sideEffect: "none" },
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({ typed: Schema.optional(Schema.Boolean) }),
        output: Schema.Struct({}),
        execute: ({ typed }) =>
          Effect.sync(() => {
            defectExecutions++
          }).pipe(
            Effect.andThen(
              typed
                ? Effect.fail(new Tool.Failure({ message: "confirmed tool failure" }))
                : Effect.die("unexpected tool defect"),
            ),
          ),
      }),
      deliver_test: Tool.make({
        description: "Deliver a test primary response",
        input: Schema.Struct({ message: Schema.String }),
        output: Schema.Struct({ delivered: Schema.Literal(true) }),
        execute: ({ message }, context) =>
          Effect.gen(function* () {
            const sentAt = yield* DateTime.now
            primary.mark(context.sessionID)
            yield* events.publish(SessionEvent.PrimaryDelivered, {
              sessionID: context.sessionID,
              timestamp: sentAt,
              assistantMessageID: context.assistantMessageID,
              callID: context.toolCallID,
              message,
              delivery: {
                status: "normal",
                sentAt,
                attachmentCount: 0,
                attachments: [],
                localOnly: true,
                uploaded: false,
              },
            })
            return { delivered: true as const }
          }),
      }),
    })
  }),
)
const echoNode = makeLocationNode({
  name: "test/session-runner-tools",
  layer: echo,
  deps: [ToolRegistry.node, PrimaryDeliveryState.node, EventV2.node],
})
let modelResolveHook = Effect.void
let currentModel = model
const models = SessionRunnerModel.layerWith(
  (session) => modelResolveHook.pipe(Effect.as(session.model?.id === "replacement" ? replacementModel : currentModel)),
  (_session, _failedModel, _category) => Effect.succeed(fallbackModel),
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  route: () => Effect.succeed(undefined),
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const evolution = Layer.mock(EvolutionV2.Service, {
  prepare: () => (evolutionPrepareFailure ? Effect.fail("capability unavailable") : Effect.succeed(evolutionPrepared)),
  recordOutcome: (input) =>
    Effect.sync(() => {
      evolutionOutcomes.push(input)
      return 1
    }),
  syncLearningPatterns: (patterns) =>
    Effect.sync(() => {
      evolutionLearningSyncs.push(patterns)
      return {
        schema_version: 1 as const,
        seen: patterns.length,
        created: patterns.length,
        existing: 0,
        skipped: 0,
        failed: 0,
        items: patterns.map((pattern) => ({
          source_ref: `core-learning-pattern:${pattern.id}`,
          status: "created" as const,
          candidate_id: "ev_mock",
          reason: "test",
        })),
      }
    }),
})
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
// Deterministic real test Location: the test file's own directory exists on
// every platform. This suite registers only in-memory echo/question test
// tools and never writes files, so a read-only existing directory is safe.
const testProjectDirectory = AbsolutePath.make(import.meta.dir)
const testLocationNode = Location.boundNode({ directory: testProjectDirectory })
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, testLocationNode],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [EvolutionV2.node, evolution],
  [PermissionV2.node, permission],
  [SecretProvider.node, secretLayer],
  [Config.node, config],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<
      SessionV2.ID,
      SessionRunner.RunError,
      SessionExecution.RunOptions
    >({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
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
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      LayerNodePlatform.filesystem,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      ToolRegistry.builtInsNode,
      echoNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      GoalV2.node,
      DurableAction.node,
      DurableRun.node,
      SubagentChildExecutor.node,
      SubagentProvider.node,
      Authorizer.node,
      ActionGateway.node,
      Snapshot.node,
      MemoryV2.node,
      LearningV2.node,
      EvolutionV2.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SecretProvider.node, secretLayer],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, testLocationNode],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [EvolutionV2.node, evolution],
      [Snapshot.node, Snapshot.noopLayer],
      [
        SubagentChildExecutor.node,
        {
          ...SubagentChildExecutor.node,
          dependencies: [...SubagentChildExecutor.node.dependencies, SubagentProvider.node],
        },
      ],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: testProjectDirectory,
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = []
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  currentModel = model
  fallbackModel = undefined
  skillBaselines.clear()
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: testProjectDirectory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  preparedSends.length = 0
  preparations.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerUnavailable()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [fixture.expectedContent],
      },
    ])
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider turn interrupted" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

describe("SessionRunnerLLM", () => {
  for (const ownership of [
    "owned",
    "replaced-at-completion",
    "replaced-on-stream-failure",
    "replaced-before-tool-settlement",
    "replaced-on-overflow",
    "replaced-on-fallback",
    "replaced-on-retry",
    "replaced-during-silent-stream",
  ] as const)
    it.live(`runs Core inside an existing child attempt and preserves its provider checkpoint: ${ownership}`, () =>
      Effect.gen(function* () {
        if (ownership === "replaced-on-overflow") yield* setupOverflowRecovery
        else yield* setup
        requests.length = 0
        if (ownership === "replaced-on-fallback") {
          fallbackModel = replacementModel
          RuntimeInsight.reset()
        }
        if (ownership === "replaced-on-retry") RuntimeInsight.reset()
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const runner = yield* SessionRunner.Service
        const session = yield* SessionV2.Service
        const budget = AgentRuntime.Budget.make({
          maxAttempts: 2,
          maxDurationMs: 60_000,
          maxCostMicros: 1_000_000,
          maxTokens: 100_000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        })
        const parent = yield* durable.create({
          sessionID: SessionV2.ID.create(),
          initiator: "user",
          authority: "automatic",
          riskTier: "L0",
          reasonSummary: "borrowed child fixture",
          budget,
          traceID: "borrowed-parent",
          visibility: "details",
          project: Project.ID.global,
          location: AbsolutePath.make(testProjectDirectory),
        })
        yield* durable.transition({ runID: parent.run.id, to: "preflight", reason: "test" })
        yield* durable.transition({ runID: parent.run.id, to: "queued", reason: "test" })
        yield* durable.transition({ runID: parent.run.id, to: "running", reason: "test" })
        const child = yield* durable.createChild({
          parentRunID: parent.run.id,
          sessionID,
          idempotencyKey: "borrowed-child",
          delegatedObjective: "one Core answer",
          allowedCapabilities: [],
          project: Project.ID.global,
          location: AbsolutePath.make(testProjectDirectory),
          expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
          initiator: "agent",
          authority: "automatic",
          riskTier: "L0",
          reasonSummary: "Core child fixture",
          budget,
          traceID: "borrowed-child",
          parentTraceID: parent.run.traceID,
          visibility: "details",
        })
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "one Core answer" }), resume: false })
        response = fragmentFixture("text", "borrowed-answer", ["Core child answer"]).completeEvents
        // A queued child must not become a separate, unbounded root run when a
        // normal Session wake arrives without the child ownership tuple.
        const beforeUnowned = yield* durable.load(child.run.id)
        const unowned = yield* runner.run({ sessionID, force: false }).pipe(Effect.exit)
        expect(unowned._tag).toBe("Failure")
        expect(requests).toHaveLength(0)
        expect(yield* durable.load(child.run.id)).toEqual(beforeUnowned)
        expect(
          (yield* durable.list({ sessionID })).filter((item) => "child" in item.run && item.run.child),
        ).toHaveLength(1)
        const readUsage = () => Effect.succeed({ costMicros: 0, tokens: 0 })
        let staleResult: Exit.Exit<void, unknown> | undefined
        let replacementCheckpoint: AgentRuntime.Checkpoint | undefined
        let pendingAtTakeover = 0
        let silentStreamClosed = false
        const executed = yield* executor
          .execute({
            childRunID: child.run.id,
            sessionID,
            readUsage,
            provider: {
              provider: "in-process",
              executionID: child.run.id,
              sessionID,
              modelID: "test-model",
              modelProviderID: "test",
              childRunID: child.run.id,
              parentRunID: parent.run.id,
            },
            permissionDigest: "a".repeat(64),
            readPermissionDigest: () => Effect.succeed("a".repeat(64)),
            operation: (execution) =>
              Effect.gen(function* () {
                const before = yield* durable.load(child.run.id)
                const requestCount = requests.length
                const invalid = yield* runner
                  .run({
                    sessionID,
                    force: false,
                    childAttempt: {
                      childRunID: child.run.id,
                      execution: { ...execution, attempt: execution.attempt + 1 },
                    },
                  })
                  .pipe(Effect.exit)
                expect(invalid._tag).toBe("Failure")
                expect(requests).toHaveLength(requestCount)
                expect(yield* durable.load(child.run.id)).toEqual(before)
                if (ownership !== "owned") {
                  if (ownership === "replaced-before-tool-settlement") {
                    toolExecutionGate = yield* Deferred.make<void>()
                    executions.length = 0
                    response = [
                      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                      LLMEvent.finish({ reason: "tool-calls" }),
                    ]
                  }
                  responseStream = Stream.unwrap(
                    Effect.gen(function* () {
                      if (ownership === "replaced-before-tool-settlement") {
                        yield* Effect.gen(function* () {
                          while (true) {
                            const context = yield* session.context(sessionID)
                            if (
                              context.some(
                                (message) =>
                                  message.type === "assistant" &&
                                  message.content.some(
                                    (part) =>
                                      part.type === "tool" &&
                                      part.id === "fenced-pending-tool" &&
                                      part.state.status === "running",
                                  ),
                              )
                            ) {
                              pendingAtTakeover = 1
                              return
                            }
                            yield* Effect.yieldNow
                          }
                        }).pipe(Effect.timeout("2 seconds"))
                      }
                      yield* durable.releaseLease({
                        runID: child.run.id,
                        leaseID: execution.leaseID,
                        ownerID: execution.ownerID,
                        reason: "fixture worker replaced during model stream",
                      })
                      yield* durable.acquireLease({ runID: child.run.id, ownerID: "replacement-worker", ttlMs: 60_000 })
                      replacementCheckpoint = yield* durable.checkpoint({
                        runID: child.run.id,
                        state: (current) => ({ ...current, replacement: "must survive old worker" }),
                      })
                      if (ownership === "replaced-during-silent-stream")
                        return Stream.never.pipe(
                          Stream.ensuring(
                            Effect.sync(() => {
                              silentStreamClosed = true
                            }),
                          ),
                        )
                      return ownership === "replaced-on-stream-failure"
                        ? Stream.die(new Error("fixture interrupted provider stream"))
                        : ownership === "replaced-on-fallback" || ownership === "replaced-on-retry"
                          ? Stream.fail(providerUnavailable())
                          : ownership === "replaced-on-overflow"
                            ? Stream.fromIterable([
                                LLMEvent.providerError({
                                  message: "prompt too long",
                                  classification: "context-overflow",
                                }),
                              ])
                            : Stream.fromIterable(response)
                    }).pipe(Effect.orDie),
                  )
                  if (ownership === "replaced-before-tool-settlement")
                    responseStream = Stream.concat(
                      Stream.fromIterable([
                        LLMEvent.stepStart({ index: 0 }),
                        LLMEvent.toolCall({
                          id: "fenced-pending-tool",
                          name: "echo",
                          input: { text: "blocked child tool" },
                        }),
                      ]),
                      responseStream,
                    )
                  if (ownership === "replaced-during-silent-stream")
                    responseStream = Stream.concat(
                      Stream.fromIterable(
                        fragmentFixture("text", "interrupted-child", ["Partial answer"]).partialEvents,
                      ),
                      responseStream,
                    )
                  staleResult = yield* runner
                    .run({
                      sessionID,
                      force: false,
                      childAttempt: { childRunID: child.run.id, execution },
                      retry: { maxTransportRetries: ownership === "replaced-on-retry" ? 1 : 0 },
                    })
                    .pipe(Effect.exit)
                  return "stale worker stopped"
                }
                yield* runner.run({ sessionID, force: false, childAttempt: { childRunID: child.run.id, execution } })
                const after = yield* durable.load(child.run.id)
                expect(after.run.status).toBe("running")
                expect(after.lease).toEqual(before.lease)
                expect(after.activeAttempt).toEqual(before.activeAttempt)
                expect(after.run.budget.attemptsUsed).toBe(1)
                expect(after.checkpoint?.state.phase).toBe("subagent-provider")
                expect(SessionCheckpoint.fromContainer(after.checkpoint!.state, sessionID)?.needsContinuation).toBe(
                  false,
                )
                const cursor = SubagentProvider.readContinuationCheckpointState(after.checkpoint!.state, {
                  provider: "in-process",
                  executionID: child.run.id,
                  epoch: execution.attempt,
                })
                expect(cursor.cursor.epoch).toBe(execution.attempt)
                return "Core child answer"
              }),
            onTerminal: (terminal) => Effect.succeed(terminal.summary),
            summarizeSuccess: (value) => value,
            summarizeFailure: (cause) => String(cause),
          })
          .pipe(Effect.timeout("4 seconds"), Effect.exit)
        if (
          ownership === "replaced-before-tool-settlement" &&
          !replacementCheckpoint &&
          staleResult?._tag === "Failure"
        )
          return yield* Effect.die(new Error(Cause.pretty(staleResult.cause)))
        expect(executed._tag).toBe(ownership === "owned" ? "Success" : "Failure")
        const runs = (yield* durable.list({ sessionID })).filter((item) => "child" in item.run && item.run.child)
        expect(runs).toHaveLength(1)
        if (ownership !== "owned") {
          if (ownership === "replaced-during-silent-stream") {
            if (executed._tag === "Failure")
              expect(Cause.pretty(executed.cause)).toContain("DurableRun.LeaseMismatchError")
            expect(silentStreamClosed).toBe(true)
            expect(requests).toHaveLength(1)
            expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
              type: "assistant",
              finish: "error",
              content: [{ type: "text", text: "Partial answer" }],
            })
          } else expect(staleResult?._tag).toBe("Failure")
          if (ownership === "replaced-on-retry") {
            expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model"])
            expect(RuntimeInsight.auditList().entries).toEqual(
              expect.arrayContaining([expect.objectContaining({ action: "llm.retry" })]),
            )
          }
          if (ownership === "replaced-on-fallback") {
            expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model"])
            expect(RuntimeInsight.auditList().entries).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  action: "llm.fallback",
                  metadata: expect.objectContaining({ fallbackModelID: "replacement" }),
                }),
              ]),
            )
          }
          if (ownership === "replaced-on-overflow") {
            expect(requests).toHaveLength(1)
            expect((yield* session.context(sessionID)).filter((message) => message.type === "compaction")).toHaveLength(
              0,
            )
          }
          if (staleResult?._tag === "Failure" && ownership !== "replaced-on-stream-failure")
            expect(Cause.pretty(staleResult.cause)).toContain(
              ownership === "replaced-on-overflow" ||
                ownership === "replaced-on-fallback" ||
                ownership === "replaced-on-retry"
                ? "DurableRun.LeaseMismatchError"
                : "DurableRun.InvalidRunLeaseCapabilityError",
            )
          if (ownership === "replaced-before-tool-settlement") {
            expect(pendingAtTakeover).toBe(1)
            expect(executions.length).toBeLessThanOrEqual(1)
            expect(activeToolExecutions).toBe(0)
            expect(requests).toHaveLength(1)
          }
          expect(replacementCheckpoint).toBeDefined()
          expect((yield* durable.load(child.run.id)).checkpoint).toEqual(replacementCheckpoint)
          expect(runs[0]?.run.status).toBe("running")
          expect(runs[0]?.lease?.ownerID).toBe("replacement-worker")
          return
        }
        expect(runs[0]?.run.status).toBe("completed")
        expect(runs[0]?.run.budget.attemptsUsed).toBe(1)
        expect(runs[0]?.activeAttempt).toBeUndefined()
        expect(runs[0]?.lease).toBeUndefined()
        expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
      }),
    )

  it.effect("rejects the retired scheduled-task input before creating a run or calling a provider", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const runner = yield* SessionRunner.Service
      let executions = 0
      const task = Tool.make({
        description: "Retired input guard",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () =>
          Effect.sync(() => {
            executions++
            return "unexpected"
          }),
      })
      for (const provideNative of [false, true]) {
        const input = {
          sessionID,
          force: true,
          scheduledTask: {},
          ...(provideNative ? { scheduledTaskTool: task } : {}),
        }
        expect(yield* runner.run(input).pipe(Effect.flip)).toMatchObject({
          carrier: "scheduled-task-retired-use-scheduledTaskTool",
        })
      }
      expect(requests).toHaveLength(0)
      expect(executions).toBe(0)
      expect(yield* (yield* DurableRun.Service).list({ sessionID })).toEqual([])
    }),
  )

  it.effect("rejects an invalid retry budget before creating a durable run", () =>
    Effect.gen(function* () {
      yield* setup
      const runner = yield* SessionRunner.Service
      const failure = yield* runner.run({ sessionID, force: true, retry: { maxTransportRetries: 4 } }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunner.InvariantError",
        phase: "execution-input",
      })
      const durableRuns = yield* DurableRun.Service
      expect(yield* durableRuns.list({ sessionID })).toEqual([])
    }),
  )

  it.effect("injects scoped memory and learning as untrusted system data, then records terminal maintenance", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      evolutionPrepared = {
        text: "## Governed Evolution Context\n<untrusted_evolution_context>[]</untrusted_evolution_context>",
        activeCandidateIDs: ["evo_test"],
        injectedCandidateIDs: ["evo_test"],
        exposureID: "ex-1234567890abcdef1234567890abcdef",
      }
      const memory = yield* MemoryV2.Service
      const learning = yield* LearningV2.Service
      yield* memory.create({
        content: MemoryV2.Content.make("Database migrations require a verified backup."),
        type: MemoryV2.Type.make("constraint"),
        importance: MemoryV2.Importance.make(4),
      })
      yield* learning.record({
        sessionID,
        userInput: "Run database migration",
        success: false,
        errorType: "IntegrityError",
        errorMessage: "IntegrityError: duplicate key value",
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Please remember that database migrations need a backup when duplicate key errors occur.",
        }),
        resume: false,
      })
      response = fragmentFixture("text", "memory-answer", ["Understood."]).completeEvents

      yield* session.resume(sessionID)

      const system = requests.at(-1)?.system.map((part) => part.text) ?? []
      expect(system.some((part) => part.includes("## Relevant Memories (untrusted data)"))).toBe(true)
      expect(system.some((part) => part.includes("## Learning System Context (untrusted observations)"))).toBe(true)
      expect(system.some((part) => part.includes("## Governed Evolution Context"))).toBe(true)
      expect(evolutionOutcomes).toEqual([
        expect.objectContaining({
          exposureID: "ex-1234567890abcdef1234567890abcdef",
          success: true,
          stopReason: "completed",
        }),
      ])
      const status = yield* learning.status()
      expect(status.totalTurns).toBe(2)
      expect(status.injectionCount).toBe(1)
      const { db } = yield* Database.Service
      const candidates = yield* db.select().from(MemoryCandidateTable).all().pipe(Effect.orDie)
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toMatchObject({
        content: "database migrations need a backup when duplicate key errors occur.",
        status: "proposed",
        policy_status: "review",
      })
      requests.length = 0
    }),
  )

  it.effect("keeps automatic extraction as a candidate and carries explicit memory into a different Session", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      requests.length = 0
      const session = yield* SessionV2.Service
      const memory = yield* MemoryV2.Service

      response = fragmentFixture("text", "cross-session-memory-source", [
        "I will retain that constraint.",
      ]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Please remember that production deployments require a verified rollback plan." }),
        resume: false,
      })
      yield* session.resume(sessionID)
      const { db } = yield* Database.Service
      const candidate = yield* db.select().from(MemoryCandidateTable).all().pipe(Effect.orDie)
      expect(candidate).toHaveLength(1)
      expect(candidate[0]).toMatchObject({
        content: "production deployments require a verified rollback plan.",
        status: "proposed",
        policy_status: "review",
      })

      const retained = yield* memory.create({
        content: MemoryV2.Content.make("Production deployments require a verified rollback plan."),
        type: MemoryV2.Type.make("constraint"),
        importance: MemoryV2.Importance.make(3),
      })

      requests.length = 0
      response = fragmentFixture("text", "cross-session-memory-destination", [
        "Use the verified rollback plan.",
      ]).completeEvents
      yield* session.prompt({
        sessionID: otherSessionID,
        prompt: Prompt.make({ text: "What must I verify before a production deployment?" }),
        resume: false,
      })
      yield* session.resume(otherSessionID)

      const destinationRequest = requests.at(-1)
      expect(destinationRequest?.system.some((part) => part.text.includes(retained.id))).toBe(true)
      expect(
        destinationRequest?.system.some((part) =>
          part.text.toLowerCase().includes("production deployments require a verified rollback plan"),
        ),
      ).toBe(true)
      expect(userTexts(destinationRequest!)).toEqual(["What must I verify before a production deployment?"])
      const history = yield* session.history({ sessionID: otherSessionID, limit: 100 })
      const recallEvidence = history.events.find((event) => event.type === "session.next.memory.context.prepared")
      expect(recallEvidence?.data).toMatchObject({
        sessionID: otherSessionID,
        userMessageID: expect.stringMatching(/^msg_/),
        turnStep: 1,
        status: "prepared",
        algorithm: "hybrid_bm25_hashing_vector",
        localOnly: true,
        candidates: [{ memoryID: retained!.id, rank: 1 }],
      })
      expect(recallEvidence?.data.queryDigest).toHaveLength(64)
      expect(recallEvidence?.data.contextDigest).toHaveLength(64)
      expect(recallEvidence?.data.injectedBytes).toBeGreaterThan(0)
      const fusionEvidence = history.events.find((event) => event.type === "session.next.context.fusion.prepared")
      expect(fusionEvidence?.data).toMatchObject({
        sessionID: otherSessionID,
        userMessageID: expect.stringMatching(/^msg_/),
        turnStep: 1,
        providerCallReady: true,
        degraded: false,
        assemblyProtocol: "arforge.context/2",
        runtimeTopology: "typescript-single-runtime",
        memory: {
          runtime: "typescript-core",
          status: "prepared",
          candidateCount: 1,
        },
        learning: {
          runtime: "typescript-core",
          status: "prepared",
        },
        evolution: {
          runtime: "typescript-core",
          status: "prepared",
          activeCandidateCount: 0,
          injectedCandidateCount: 0,
        },
      })
      expect(fusionEvidence?.data.queryDigest).toHaveLength(64)
      expect(fusionEvidence?.data.combinedContextDigest).toHaveLength(64)
      expect(fusionEvidence?.data.totalInjectedBytes).toBeGreaterThan(0)
    }),
  )

  it.effect("rebuilds durable context and reinjects memory after conversation rewind", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const memory = yield* MemoryV2.Service
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* memory.create({
        content: MemoryV2.Content.make("Recovery protocol requires a verified backup before migration."),
        type: MemoryV2.Type.make("constraint"),
        importance: MemoryV2.Importance.make(5),
      })

      response = fragmentFixture("text", "rewind-baseline", ["Baseline recorded."]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Record the recovery protocol for future migration work." }),
        resume: false,
      })
      yield* session.resume(sessionID)
      const checkpoint = yield* session.checkpoints.create({
        sessionID,
        label: SessionOrganization.CheckpointLabel.make("Before temporary branch"),
      })

      response = fragmentFixture("text", "rewind-temporary", ["Temporary answer."]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "This temporary branch should be removed by rewind." }),
        resume: false,
      })
      yield* session.resume(sessionID)
      const preview = yield* session.rewind.preview({ sessionID, checkpointID: checkpoint.id })
      expect(preview.affectedMessages).toBeGreaterThan(0)
      yield* session.rewind.apply({
        sessionID,
        checkpointID: checkpoint.id,
        expectedLastSequence: preview.expectedLastSequence,
      })
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      requests.length = 0
      response = fragmentFixture("text", "rewind-recovery", ["Recovery context restored."]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Before migration, remind me of the recovery protocol." }),
        resume: false,
      })
      yield* session.resume(sessionID)

      const request = requests.at(-1)
      expect(request?.system.map((part) => part.text)).toContain("Initial context")
      expect(request?.system.some((part) => part.text.includes("Recovery protocol requires a verified backup"))).toBe(
        true,
      )
      expect(userTexts(request!)).not.toContain("This temporary branch should be removed by rewind.")
      expect(userTexts(request!)).toContain("Before migration, remind me of the recovery protocol.")
    }),
  )

  it.effect("continues the desktop turn when governed evolution context is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      evolutionPrepareFailure = true
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue without optional evolution advice." }),
        resume: false,
      })
      response = fragmentFixture("text", "evolution-fallback", ["Continuing."]).completeEvents

      yield* session.resume(sessionID)

      const system = requests.at(-1)?.system.map((part) => part.text) ?? []
      expect(system.some((part) => part.startsWith("## Governed Evolution Context"))).toBe(false)
      expect(evolutionOutcomes).toEqual([])
      const history = yield* session.history({ sessionID, limit: 100 })
      const fusionEvidence = history.events.findLast((event) => event.type === "session.next.context.fusion.prepared")
      expect(fusionEvidence?.data).toMatchObject({
        providerCallReady: true,
        degraded: true,
        memory: { runtime: "typescript-core", status: "prepared" },
        learning: { runtime: "typescript-core", status: "prepared" },
        evolution: { runtime: "typescript-core", status: "unavailable", injectedBytes: 0 },
      })
      requests.length = 0
    }),
  )

  it.effect("turns a third repeated failure into a review-only Evolution proposal sync", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      evolutionLearningSyncs.length = 0
      const failure = providerUnavailable()
      const learning = yield* LearningV2.Service
      for (let index = 0; index < 2; index++)
        yield* learning.record({
          sessionID,
          userInput: "Retry the unavailable provider",
          success: false,
          errorType: failure.constructor.name,
          errorMessage: failure.message,
        })
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Retry the unavailable provider" }),
        resume: false,
      })
      streamFailure = failure

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(evolutionLearningSyncs).toHaveLength(1)
      expect(evolutionLearningSyncs[0]).toMatchObject([{ type: "failure", frequency: 3, confidence: 0.7 }])
    }),
  )

  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use application context" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(
        contexts.map(({ sessionID, agent, assistantMessageID, toolCallID }) => ({
          sessionID,
          agent,
          assistantMessageID,
          toolCallID,
        })),
      ).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      const message = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run automatically" }) })

      while (requests.length < 1) yield* Effect.yieldNow
      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
    }),
  )

  for (const missing of ["unknownInput", "textOutput"] as const)
    it.effect(`rejects unpriced ${missing} before the runner sends a provider request`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        RuntimeInsight.reset()
        requests.length = 0
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Budgeted request" }), resume: false })
        response = fragmentFixture("text", "unpriced-answer", ["Should not be requested"]).completeEvents
        const catalog = Billing.PriceCatalog.make({
          revision: "fixture-incomplete-prices-v1",
          currency: "USD",
          minorUnit: 2,
          unit: "1k-tokens",
          effectiveFrom: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
          source: "fixture:session-runner",
          rates: missing === "unknownInput" ? { textOutput: { amountMinor: 0 } } : { unknownInput: { amountMinor: 0 } },
        })
        const result = yield* runner
          .run({
            sessionID,
            force: true,
            billing: {
              budget: Billing.Budget.make({ currency: "USD", limitMinor: 100_000 }),
              resolveCatalog: () => catalog,
            },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("Unpriced token categories")
        expect(requests).toHaveLength(0)
        expect(RuntimeInsight.billing()).toHaveLength(0)
        const runs = yield* (yield* DurableRun.Service).list({ sessionID })
        expect(runs.map((item) => item.run.status)).toEqual(["failed"])
      }),
    )

  for (const usagePosition of ["step", "final"] as const)
    it.effect(
      `reserves and settles a configured billing scope around a real runner turn: ${usagePosition}`,
      () =>
        Effect.gen(function* () {
          yield* setup
          const session = yield* SessionV2.Service
          const runner = yield* SessionRunner.Service
          RuntimeInsight.reset()
          requests.length = 0
          yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Meter this turn" }), resume: false })
          response = [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "metered-answer" }),
            LLMEvent.textDelta({ id: "metered-answer", text: "Metered" }),
            LLMEvent.textEnd({ id: "metered-answer" }),
            LLMEvent.stepFinish({
              index: 0,
              reason: "stop",
              usage:
                usagePosition === "step"
                  ? { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5, totalTokens: 15 }
                  : undefined,
            }),
            LLMEvent.finish({
              reason: "stop",
              usage:
                usagePosition === "final"
                  ? { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5, totalTokens: 15 }
                  : undefined,
            }),
          ]

          const catalog = Billing.PriceCatalog.make({
            revision: "fixture-runner-prices-v1",
            currency: "USD",
            minorUnit: 2,
            unit: "1k-tokens",
            effectiveFrom: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
            source: "fixture:session-runner",
            rates: { unknownInput: { amountMinor: 1000 }, textOutput: { amountMinor: 1000 } },
          })

          yield* runner.run({
            sessionID,
            force: true,
            billing: {
              budget: Billing.Budget.make({ currency: "USD", limitMinor: 100_000 }),
              resolveCatalog: ({ providerID, modelID }) =>
                providerID === "fake" && modelID === "fake-model" ? catalog : undefined,
            },
          })

          const records = RuntimeInsight.billing()
          expect(records).toHaveLength(1)
          const recordedRunID = records[0]!.runID
          expect(records[0]).toMatchObject({
            runID: expect.any(String),
            providerID: "fake",
            modelID: "fake-model",
            charge: { currency: "USD", priceCatalogRevision: "fixture-runner-prices-v1", amountMinor: 15 },
            settlement: { overBudget: false },
          })
          expect(requests[0]?.generation?.maxTokens).toBe(32_000)
          expect(yield* session.get(sessionID)).toMatchObject({
            cost: 0.15,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          expect(yield* session.messages({ sessionID })).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: "assistant", finish: "stop", cost: 0.15 })]),
          )
          const durable = yield* (yield* DurableRun.Service).load(recordedRunID as AgentRuntime.RunID)
          expect(durable.run.budget).toMatchObject({ costMicrosUsed: 150_000, tokensUsed: 15 })
        }),
      15_000,
    )

  it.effect("retries a pre-output transport failure once and records bounded retry evidence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      RuntimeInsight.reset()
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry this turn" }), resume: false })
      response = fragmentFixture("text", "retry-answer", ["Recovered"]).completeEvents
      responseStream = Stream.fail(providerUnavailable())

      yield* runner.run({ sessionID, force: true, retry: { maxTransportRetries: 1 } })

      expect(requests).toHaveLength(2)
      expect(RuntimeInsight.modelCalls().map((call) => call.mode)).toEqual(["retry", "primary"])
      expect(new Set(RuntimeInsight.modelCalls().map((call) => call.traceID))).toEqual(
        new Set([RuntimeInsight.runs()[0]?.traceID]),
      )
      expect(RuntimeInsight.metrics().map((metric) => metric.name)).toEqual(
        expect.arrayContaining(["llm.call", "llm.retry", "llm.latency"]),
      )
      const retryRunID = RuntimeInsight.runs()[0]?.runID
      const retryActionAttempts = yield* (yield* Database.Service).db
        .select({ aggregateID: EventTable.aggregate_id, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .all()
        .pipe(Effect.orDie)
      const retryActionIDs = new Set(
        retryActionAttempts
          .filter((row) => {
            if (row.type !== "agent.action.proposed.1") return false
            const action = row.data.action
            return typeof action === "object" && action !== null && "runID" in action && action.runID === retryRunID
          })
          .map((row) => row.aggregateID),
      )
      expect(
        retryActionAttempts.filter(
          (row) => row.type === "agent.action.attempt-started.1" && retryActionIDs.has(row.aggregateID),
        ),
      ).toHaveLength(1)
      expect(RuntimeInsight.auditList().entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "llm.retry",
            metadata: expect.objectContaining({ category: "transport", retryNumber: 1 }),
          }),
        ]),
      )
    }),
  )

  for (const drift of [false, true])
    it.effect(
      `retry preparation checks committed transmission before another billing reservation: drift=${drift}`,
      () =>
        Effect.gen(function* () {
          yield* setup
          const session = yield* SessionV2.Service
          const runner = yield* SessionRunner.Service
          const { db } = yield* Database.Service
          requests.length = 0
          currentModel = Model.make({
            id: model.id,
            provider: model.provider,
            route: OpenAIChat.route.with({ generation: { temperature: 0.1 } }),
          })
          forbidLegacyStream = true
          yield* session.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Retry without changing my request" }),
            resume: false,
          })
          response = fragmentFixture("text", "stable-retry", ["Recovered"]).completeEvents
          responseStream = Stream.suspend(() => {
            if (drift) Object.assign(currentModel.route.defaults.generation!, { temperature: 0.9 })
            return Stream.fail(providerUnavailable())
          })
          const catalog = Billing.PriceCatalog.make({
            revision: "retry-drift-prices",
            currency: "USD",
            minorUnit: 2,
            unit: "token",
            effectiveFrom: DateTime.makeUnsafe(0),
            source: "fixture:retry-drift",
            rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
          })
          const settled: Parameters<RuntimeBilling.SettlementObserver>[0][] = []
          const result = yield* runner
            .run({
              sessionID,
              force: true,
              retry: { maxTransportRetries: 1 },
              billing: {
                budget: Billing.Budget.make({ currency: "USD", limitMinor: 100_000 }),
                resolveCatalog: () => catalog,
                onSettlement: (item) => {
                  settled.push(item)
                },
              },
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(drift)
          expect(preparations).toHaveLength(2)
          expect(preparedSends).toHaveLength(drift ? 1 : 2)
          expect(requests).toHaveLength(drift ? 1 : 2)
          const envelopes = yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)))
            .all()
          expect(envelopes).toHaveLength(1)
          const data = Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(envelopes[0]!.data)
          const original = parseRequestEnvelopeJson(data.envelope)
          for (const sent of preparedSends) expect(sent.transmission).toEqual(original.request.transmission)
          expect(preparations[1]?.transmission?.body).toMatchObject({ temperature: drift ? 0.9 : 0.1 })
          const rows = yield* db.select().from(SessionRunUsageTable).all()
          expect(rows).toHaveLength(drift ? 1 : 2)
          expect(settled).toHaveLength(rows.length)
          expect(rows.every((row) => row.settlement_reservation_id === row.id)).toBe(true)
          expect(settled.at(-1)?.settlement.state.activeReservationIDs).toEqual([])
        }),
    )

  for (const recovery of ["retry", "fallback"] as const)
    for (const exhausted of [false, true])
      it.effect(`settles a failed transport attempt before reserving ${recovery}: exhausted=${exhausted}`, () =>
        Effect.gen(function* () {
          yield* setup
          const session = yield* SessionV2.Service
          const runner = yield* SessionRunner.Service
          RuntimeInsight.reset()
          requests.length = 0
          yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Meter every retry" }), resume: false })
          response = fragmentFixture("text", "metered-retry", ["Recovered"]).completeEvents
          responseStream = Stream.fail(providerUnavailable())
          if (recovery === "fallback") fallbackModel = replacementModel
          const catalog = Billing.PriceCatalog.make({
            revision: "retry-prices-v1",
            currency: "USD",
            minorUnit: 2,
            unit: "token",
            effectiveFrom: DateTime.makeUnsafe(0),
            source: "fixture:retry",
            rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
          })
          const reconciled: string[] = []
          const settled: Parameters<RuntimeBilling.SettlementObserver>[0][] = []
          const sendsAtSettlement: number[] = []
          const result = yield* runner
            .run({
              sessionID,
              force: true,
              retry: { maxTransportRetries: recovery === "retry" ? 1 : 0 },
              billing: {
                budget: Billing.Budget.make({ currency: "USD", limitMinor: 100_000 }),
                resolveCatalog: () => catalog,
                reconcileUsage: (input) => {
                  reconciled.push(input.reservationID)
                  return RuntimeBilling.fromStepTokens({
                    input: exhausted ? 100_000 : 2,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  })
                },
                onSettlement: (item) => {
                  settled.push(item)
                  sendsAtSettlement.push(requests.length)
                },
              },
            })
            .pipe(Effect.exit)
          expect(reconciled).toHaveLength(1)
          expect(requests).toHaveLength(exhausted ? 1 : 2)
          expect(requests.map((item) => String(item.model.id))).toEqual(
            exhausted ? ["fake-model"] : ["fake-model", recovery === "retry" ? "fake-model" : "replacement"],
          )
          expect(Exit.isFailure(result)).toBe(exhausted)
          expect(settled).toHaveLength(exhausted ? 1 : 2)
          expect(sendsAtSettlement).toEqual(exhausted ? [1] : [1, 2])
          expect(settled[0]?.charge.amountMinor).toBe(exhausted ? 100_000 : 2)
          expect(new Set(settled.map((item) => item.settlement.reservationID)).size).toBe(settled.length)
          expect(settled.at(-1)?.settlement.state.activeReservationIDs).toEqual([])
          if (!exhausted) {
            expect(settled[1]?.usage.source).toBe("estimated")
            expect(settled[1]?.usage.estimatorID).toBe("arforge:chars-per-token-v1")
            expect(settled[1]?.charge.amountMinor).toBeGreaterThan(0)
            const total = settled.reduce((sum, item) => sum + item.charge.amountMinor, 0)
            expect(settled[1]?.settlement.state.settledMinor).toBe(total)
            expect((yield* session.get(sessionID)).cost).toBeCloseTo(total / 100)
          }
        }),
      )

  for (const runtime of ["same-process", "fresh-process"] as const) {
    for (const recovery of ["exhausted", "available", "missing-policy", "changed-policy"] as const) {
      it.live(
        `resuming a paused billed run retains spending: ${runtime}/${recovery}`,
        () =>
          Effect.gen(function* () {
            yield* setup
            const session = yield* SessionV2.Service
            const runner = yield* SessionRunner.Service
            const runs = yield* DurableRun.Service
            const db = (yield* Database.Service).db
            requests.length = 0
            RuntimeInsight.reset()
            yield* session.prompt({
              sessionID,
              prompt: Prompt.make({ text: "Preserve my budget after interruption" }),
              resume: false,
            })
            toolExecutionGate = yield* Deferred.make<void>()
            const spent = recovery === "available" ? 1 : 99_999
            response = [
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "call-budget-pause", name: "echo", input: { text: "pause after receipt" } }),
              LLMEvent.stepFinish({
                index: 0,
                reason: "tool-calls",
                usage: { inputTokens: spent, nonCachedInputTokens: spent, outputTokens: 0, totalTokens: spent },
              }),
              LLMEvent.finish({ reason: "tool-calls" }),
            ]
            const catalog = Billing.PriceCatalog.make({
              revision: "resume-prices",
              currency: "USD",
              minorUnit: 6,
              unit: "token",
              effectiveFrom: DateTime.makeUnsafe(0),
              source: "fixture:resume",
              rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
            })
            const billing: RuntimeBilling.RunConfig = {
              budget: Billing.Budget.make({ currency: "USD", limitMinor: 100_000 }),
              resolveCatalog: () => catalog,
            }
            const first = yield* runner.run({ sessionID, force: true, billing }).pipe(Effect.forkChild)
            while (RuntimeInsight.billing().length === 0) yield* Effect.yieldNow
            yield* Fiber.interrupt(first)
            toolExecutionGate = undefined
            const paused = (yield* runs.recoverable(sessionID))[0]
            expect(paused?.run.status).toBe("paused")
            const before = yield* db
              .select()
              .from(SessionRunUsageTable)
              .where(eq(SessionRunUsageTable.session_id, sessionID))
              .all()
              .pipe(Effect.orDie)
            expect(before).toHaveLength(1)
            expect(before[0]?.amount_minor).toBe(spent)
            if (runtime === "fresh-process") {
              const fs = yield* FileSystem.FileSystem
              const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "arforge-billing-recovery-" })
              const copyPath = `${temporary}/recovery.sqlite`
              yield* db.run(sql`VACUUM INTO ${copyPath}`).pipe(Effect.orDie)
              const worker = Bun.spawn(
                [
                  process.execPath,
                  fileURLToPath(new URL("./fixture/billing-recovery-worker.ts", import.meta.url)),
                  copyPath,
                  testProjectDirectory,
                  String((yield* session.get(sessionID)).projectID),
                  String(sessionID),
                  recovery,
                ],
                { stdout: "pipe", stderr: "pipe" },
              )
              yield* Effect.addFinalizer(() => Effect.sync(() => worker.kill()))
              const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
                Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]),
              )
              expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
              expect(stdout).toContain('"priorUsageUnchanged":true')
              expect(stdout).toContain('"sameRun":true')
              expect(stdout).toContain(`"providerCalls":${recovery === "available" ? 1 : 0}`)
              expect(
                yield* db
                  .select()
                  .from(SessionRunUsageTable)
                  .where(eq(SessionRunUsageTable.session_id, sessionID))
                  .all()
                  .pipe(Effect.orDie),
              ).toEqual(before)
              expect((yield* runs.recoverable(sessionID))[0]?.run.status).toBe("paused")
              return
            }
            RuntimeInsight.reset()
            response = fragmentFixture("text", "resumed-budget", ["Continued with the original budget"]).completeEvents
            const resumed = yield* runner
              .run({
                sessionID,
                force: true,
                billing:
                  recovery === "missing-policy"
                    ? undefined
                    : recovery === "changed-policy"
                      ? { ...billing, budget: { currency: "USD", limitMinor: 200_000 } }
                      : billing,
              })
              .pipe(Effect.exit)
            expect(Exit.isSuccess(resumed)).toBe(recovery === "available")
            const after = yield* db
              .select()
              .from(SessionRunUsageTable)
              .where(eq(SessionRunUsageTable.session_id, sessionID))
              .all()
              .pipe(Effect.orDie)
            if (recovery === "available") {
              expect(requests).toHaveLength(2)
              expect(after).toHaveLength(2)
              const next = after.find((row) => row.id !== before[0]?.id)
              const receipt = RuntimeBilling.decodeReceipt(next?.billing_receipt)
              expect(receipt.before.settledMinor).toBe(spent)
              expect(receipt.settlement.state.settledMinor).toBe(spent + receipt.charge.amountMinor)
              expect(after.find((row) => row.id === before[0]?.id)).toEqual(before[0])
            } else {
              const reason =
                recovery === "exhausted"
                  ? "Budget exceeded"
                  : recovery === "missing-policy"
                    ? "requires its billing policy"
                    : "budget policy changed"
              expect(Exit.isFailure(resumed) && Cause.pretty(resumed.cause)).toContain(reason)
              expect(requests).toHaveLength(1)
              expect(after).toEqual(before)
            }
            expect((yield* runs.list({ sessionID })).map((item) => item.run.id)).toEqual([paused?.run.id])
          }),
        30_000,
      )
    }
  }

  for (const reconciliation of [
    "provider",
    "async",
    "missing",
    "reject",
    "timeout",
    "timeout-missing",
    "timeout-estimated",
    "timeout-rejected",
    "timeout-takeover",
    "timeout-receipt-change",
  ] as const) {
    it.effect(`interrupted provider stream reconciles its reserved usage before returning: ${reconciliation}`, () =>
      Effect.gen(function* () {
        yield* setup
        const timedOut = reconciliation.startsWith("timeout")
        const session = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const db = (yield* Database.Service).db
        requests.length = 0
        RuntimeInsight.reset()
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Cancel after sending" }), resume: false })
        streamGate = yield* Deferred.make<void>()
        streamStarted = yield* Deferred.make<void>()
        response = fragmentFixture("text", "cancelled-billing", ["Never delivered"]).completeEvents
        const catalog = Billing.PriceCatalog.make({
          revision: "cancel-prices",
          currency: "USD",
          minorUnit: 6,
          unit: "token",
          effectiveFrom: DateTime.makeUnsafe(0),
          source: "fixture:cancel",
          rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
        })
        let reconciled = 0
        let observed = 0
        const reconciliationStarted = yield* Deferred.make<void>()
        let cancelled = false
        const receipt = RuntimeBilling.fromStepTokens({
          input: 4,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        })
        let resolveUsage: ((usage: Billing.TokenUsage) => void) | undefined
        const pendingUsage = new Promise<Billing.TokenUsage>((resolve) => {
          resolveUsage = resolve
        })
        const fiber = yield* runner
          .run({
            sessionID,
            force: true,
            billing: {
              budget: { currency: "USD", limitMinor: 100_000 },
              resolveCatalog: () => catalog,
              reconcileUsage: () => {
                reconciled++
                Deferred.doneUnsafe(reconciliationStarted, Effect.void)
                if (reconciliation === "async" || timedOut) return pendingUsage
                if (reconciliation === "reject") return Promise.reject(new Error("fixture lookup unavailable"))
                return reconciliation === "missing" ? undefined : receipt
              },
              onSettlement: () => {
                observed++
              },
            },
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(streamStarted)
        const cancellation = yield* Fiber.interrupt(fiber).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled = true
            }),
          ),
          Effect.forkChild,
        )
        yield* Deferred.await(reconciliationStarted)
        if (reconciliation === "async" || timedOut) {
          expect(cancelled).toBe(false)
          if (reconciliation === "async") resolveUsage?.(receipt)
          else yield* TestClock.adjust("6 seconds")
        }
        yield* Fiber.join(cancellation)
        expect(reconciled).toBe(1)
        expect(observed).toBe(timedOut ? 0 : 1)
        expect(requests).toHaveLength(1)
        const rows = yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        expect(rows).toHaveLength(1)
        if (timedOut) {
          expect(rows[0]).toMatchObject({
            amount_minor: null,
            settlement_reservation_id: null,
            billing_receipt: { phase: "reserved" },
          })
          resolveUsage?.(receipt)
          yield* Effect.promise(() => Promise.resolve())
          expect(
            yield* db
              .select()
              .from(SessionRunUsageTable)
              .where(eq(SessionRunUsageTable.session_id, sessionID))
              .all()
              .pipe(Effect.orDie),
          ).toEqual(rows)
          streamGate = undefined
          streamStarted = undefined
          response = fragmentFixture("text", "recovered-billing", [
            "Continue after confirmed accounting",
          ]).completeEvents
          const lookups: Parameters<RuntimeBilling.UsageReconciler>[0][] = []
          let unavailable = reconciliation !== "timeout"
          const policy: RuntimeBilling.RunConfig = {
            budget: { currency: "USD", limitMinor: 100_000 },
            resolveCatalog: () =>
              Billing.PriceCatalog.make({
                ...catalog,
                revision: "new-prices",
                rates: { unknownInput: { amountMinor: 2 }, textOutput: { amountMinor: 2 } },
              }),
            reconcileUsage: (input) => {
              lookups.push(input)
              if (unavailable) {
                if (reconciliation === "timeout-rejected") return Promise.reject(new Error("private lookup error"))
                return reconciliation === "timeout-estimated"
                  ? RuntimeBilling.estimateCallUsage({ inputText: "unconfirmed", outputTokens: 4 })
                  : undefined
              }
              return receipt
            },
          }
          if (reconciliation === "timeout-takeover" || reconciliation === "timeout-receipt-change") {
            const runs = yield* DurableRun.Service
            const lookupStarted = yield* Deferred.make<void>()
            let releaseRecovery: ((value: Billing.TokenUsage) => void) | undefined
            const recoveryUsage = new Promise<Billing.TokenUsage>((resolve) => {
              releaseRecovery = resolve
            })
            yield* Effect.addFinalizer(() => Effect.sync(() => releaseRecovery?.(receipt)))
            const recovering = yield* runner
              .run({
                sessionID,
                force: true,
                billing: {
                  ...policy,
                  reconcileUsage: () => {
                    Deferred.doneUnsafe(lookupStarted, Effect.void)
                    return recoveryUsage
                  },
                  onSettlement: () => {
                    observed++
                  },
                },
              })
              .pipe(Effect.forkChild)
            yield* Deferred.await(lookupStarted)
            const active = (yield* runs.list({ sessionID }))[0]
            if (!active?.lease) throw new Error("Expected recovery lease")
            if (reconciliation === "timeout-takeover") {
              yield* runs.releaseLease({
                runID: active.run.id,
                leaseID: active.lease.id,
                ownerID: active.lease.ownerID,
                reason: "fixture takeover during reconciliation",
              })
              yield* runs.acquireLease({ runID: active.run.id, ownerID: "billing-replacement-worker", ttlMs: 60_000 })
              yield* runs.checkpoint({
                runID: active.run.id,
                state: (current) => ({ ...current, billingReplacement: "preserve" }),
              })
            } else {
              yield* db
                .run(
                  sql`UPDATE session_run_usage SET billing_receipt = json_set(billing_receipt, '$.requestDigest', ${"d".repeat(64)}) WHERE id = ${rows[0]?.id}`,
                )
                .pipe(Effect.orDie)
            }
            const fencedSnapshot = yield* runs.load(active.run.id)
            const fencedRows = yield* db
              .select()
              .from(SessionRunUsageTable)
              .where(eq(SessionRunUsageTable.session_id, sessionID))
              .all()
              .pipe(Effect.orDie)
            releaseRecovery?.(receipt)
            const denied = yield* Fiber.await(recovering)
            expect(Exit.isFailure(denied)).toBe(true)
            if (reconciliation === "timeout-takeover") expect(yield* runs.load(active.run.id)).toEqual(fencedSnapshot)
            else
              expect(Exit.isFailure(denied) && Cause.pretty(denied.cause)).toContain(
                "Pending billing reservation changed before settlement",
              )
            expect(
              yield* db
                .select()
                .from(SessionRunUsageTable)
                .where(eq(SessionRunUsageTable.session_id, sessionID))
                .all()
                .pipe(Effect.orDie),
            ).toEqual(fencedRows)
            expect(observed).toBe(0)
            expect(requests).toHaveLength(1)
            expect(RuntimeInsight.billing()).toHaveLength(0)
            expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
            return
          }
          if (unavailable) {
            const denied = yield* runner.run({ sessionID, force: true, billing: policy }).pipe(Effect.exit)
            expect(Exit.isFailure(denied)).toBe(true)
            expect(requests).toHaveLength(1)
            expect(
              yield* db
                .select()
                .from(SessionRunUsageTable)
                .where(eq(SessionRunUsageTable.session_id, sessionID))
                .all()
                .pipe(Effect.orDie),
            ).toEqual(rows)
            expect((yield* (yield* DurableRun.Service).recoverable(sessionID))[0]?.run.status).toBe("paused")
            unavailable = false
          }
          const recovered = yield* runner.run({ sessionID, force: true, billing: policy }).pipe(Effect.exit)
          expect(Exit.isFailure(recovered) && Cause.pretty(recovered.cause)).toContain("may already have been sent")
          expect(lookups).toHaveLength(reconciliation === "timeout" ? 1 : 2)
          expect(lookups[0]).toMatchObject({
            runID: rows[0]?.run_id,
            reservationID: rows[0]?.id,
            failureCategory: "recovery",
          })
          const after = yield* db
            .select()
            .from(SessionRunUsageTable)
            .where(eq(SessionRunUsageTable.session_id, sessionID))
            .all()
            .pipe(Effect.orDie)
          expect(after).toHaveLength(1)
          expect(after.find((row) => row.id === rows[0]?.id)?.amount_minor).toBe(4)
          const confirmed = RuntimeBilling.decodeReceipt(after[0]?.billing_receipt)
          expect(confirmed.settlement.state.settledMinor).toBe(4)
          expect(confirmed.settlement.state.activeReservationIDs).toEqual([])
          expect(confirmed.catalog.revision).toBe(catalog.revision)
          expect(requests).toHaveLength(1)
          yield* runner.run({ sessionID, force: false })
          expect(lookups).toHaveLength(reconciliation === "timeout" ? 1 : 2)
          expect(requests).toHaveLength(1)
        } else {
          const settled = RuntimeBilling.decodeReceipt(rows[0]?.billing_receipt)
          expect(settled.settlement.state.activeReservationIDs).toEqual([])
          if (reconciliation === "provider" || reconciliation === "async") expect(rows[0]?.amount_minor).toBe(4)
          else {
            expect(settled.usage.source).toBe("estimated")
            expect(settled.charge.amountMinor).toBe(settled.reservation.estimatedMinor)
          }
        }
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      }),
    )
  }

  it.live(
    "recovers pending billing in fresh processes without repricing or repeating settled work",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const runs = yield* DurableRun.Service
        const db = (yield* Database.Service).db
        const fs = yield* FileSystem.FileSystem
        requests.length = 0
        RuntimeInsight.reset()
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Recover the pending request after restart" }),
          resume: false,
        })
        streamGate = yield* Deferred.make<void>()
        streamStarted = yield* Deferred.make<void>()
        response = fragmentFixture("text", "pending-cold-recovery", [
          "Interrupted before receiving usage",
        ]).completeEvents
        const catalog = Billing.PriceCatalog.make({
          revision: "pending-original-prices",
          currency: "USD",
          minorUnit: 6,
          unit: "token",
          effectiveFrom: DateTime.makeUnsafe(0),
          source: "fixture:pending-cold",
          rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
        })
        const usage = RuntimeBilling.fromStepTokens({ input: 4, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
        let releaseLookup: ((value: Billing.TokenUsage) => void) | undefined
        const unavailable = new Promise<Billing.TokenUsage>((resolve) => {
          releaseLookup = resolve
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => releaseLookup?.(usage)))
        const first = yield* runner
          .run({
            sessionID,
            force: true,
            billing: {
              budget: { currency: "USD", limitMinor: 100_000 },
              resolveCatalog: () => catalog,
              reconcileUsage: () => unavailable,
            },
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(streamStarted)
        yield* Fiber.interrupt(first)
        expect((yield* runs.recoverable(sessionID))[0]?.run.status).toBe("paused")
        const before = yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        expect(before).toHaveLength(1)
        expect(before[0]).toMatchObject({
          amount_minor: null,
          settlement_reservation_id: null,
          billing_receipt: { phase: "reserved" },
        })
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "arforge-pending-cold-" })
        const projectID = String((yield* session.get(sessionID)).projectID)
        const runWorker = Effect.fnUntraced(function* (copyPath: string, recovery: string) {
          const worker = Bun.spawn(
            [
              process.execPath,
              fileURLToPath(new URL("./fixture/billing-recovery-worker.ts", import.meta.url)),
              copyPath,
              testProjectDirectory,
              projectID,
              String(sessionID),
              recovery,
            ],
            { stdout: "pipe", stderr: "pipe" },
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => worker.kill()))
          const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
            Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]),
          )
          expect({ recovery, exitCode, stderr }).toEqual({ recovery, exitCode: 0, stderr: "" })
          expect(stdout).toContain('"sameRun":true')
          expect(stdout).toContain('"providerCalls":0')
          expect(stdout).toContain(`"reconciliationCalls":${recovery === "pending-idle" ? 0 : 1}`)
          if (recovery !== "pending-available") expect(stdout).toContain('"priorUsageUnchanged":true')
        })
        for (const recovery of ["pending-available", "pending-missing", "pending-estimated", "pending-rejected"]) {
          const copyPath = `${temporary}/${recovery}.sqlite`
          yield* db.run(sql`VACUUM INTO ${copyPath}`).pipe(Effect.orDie)
          yield* runWorker(copyPath, recovery)
          if (recovery !== "pending-available") yield* runWorker(copyPath, "pending-available")
          yield* runWorker(copyPath, "pending-idle")
        }
        expect(
          yield* db
            .select()
            .from(SessionRunUsageTable)
            .where(eq(SessionRunUsageTable.session_id, sessionID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(before)
        expect(requests).toHaveLength(1)
        expect((yield* runs.recoverable(sessionID))[0]?.run.status).toBe("paused")
      }),
    60_000,
  )

  for (const takeover of ["before-reservation", "after-send"] as const) {
    it.effect(`a replaced root worker cannot settle a normal provider response: ${takeover}`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const runs = yield* DurableRun.Service
        const db = (yield* Database.Service).db
        requests.length = 0
        RuntimeInsight.reset()
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Fence this response after takeover" }),
          resume: false,
        })
        streamGate = yield* Deferred.make<void>()
        streamStarted = yield* Deferred.make<void>()
        const modelReady = yield* Deferred.make<void>()
        const modelGate = yield* Deferred.make<void>()
        if (takeover === "before-reservation") {
          modelResolveHook = Deferred.succeed(modelReady, undefined).pipe(Effect.andThen(Deferred.await(modelGate)))
          streamGate = undefined
        }
        response = fragmentFixture("text", "old-owner-response", ["The old worker must not settle this"]).completeEvents
        const catalog = Billing.PriceCatalog.make({
          revision: "owned-prices",
          currency: "USD",
          minorUnit: 6,
          unit: "token",
          effectiveFrom: DateTime.makeUnsafe(0),
          source: "fixture:ownership",
          rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
        })
        let observed = 0
        const first = yield* runner
          .run({
            sessionID,
            force: true,
            billing: {
              budget: { currency: "USD", limitMinor: 100_000 },
              resolveCatalog: () => catalog,
              onSettlement: () => {
                observed++
              },
            },
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(takeover === "before-reservation" ? modelReady : streamStarted)
        const active = (yield* runs.list({ sessionID }))[0]
        if (!active?.lease) throw new Error("Expected active worker")
        const rows = yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        yield* runs.releaseLease({
          runID: active.run.id,
          leaseID: active.lease.id,
          ownerID: active.lease.ownerID,
          reason: "fixture takeover before response",
        })
        yield* runs.acquireLease({ runID: active.run.id, ownerID: "replacement-response-owner", ttlMs: 60_000 })
        yield* runs.checkpoint({
          runID: active.run.id,
          state: (current) => ({ ...current, replacementResponse: "keep" }),
        })
        const replacement = yield* runs.load(active.run.id)
        if (takeover === "before-reservation") yield* Deferred.succeed(modelGate, undefined)
        else if (streamGate) yield* Deferred.succeed(streamGate, undefined)
        const result = yield* Fiber.await(first)
        expect({ result: result._tag, observed, records: RuntimeInsight.billing().length }).toEqual({
          result: "Failure",
          observed: 0,
          records: 0,
        })
        expect(observed).toBe(0)
        expect(RuntimeInsight.billing()).toHaveLength(0)
        expect(
          yield* db
            .select()
            .from(SessionRunUsageTable)
            .where(eq(SessionRunUsageTable.session_id, sessionID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(rows)
        expect(yield* runs.load(active.run.id)).toEqual(replacement)
        expect(requests).toHaveLength(takeover === "before-reservation" ? 0 : 1)
      }),
    )
  }

  for (const phase of ["prepared", "dispatching"] as const)
    for (const boundary of ["interrupt-after-commit", "write-failure"] as const)
      it.effect(`request dispatch checkpoint is a durable send barrier: ${phase}/${boundary}`, () =>
        Effect.gen(function* () {
          yield* setup
          const session = yield* SessionV2.Service
          const runner = yield* SessionRunner.Service
          const runs = yield* DurableRun.Service
          const db = (yield* Database.Service).db
          requests.length = 0
          yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Persist before sending" }), resume: false })
          if (boundary === "write-failure") {
            yield* db
              .run(
                sql.raw(`CREATE TEMP TRIGGER dispatch_checkpoint_fault BEFORE INSERT ON event
              WHEN json_extract(NEW.data, '$.checkpoint.state.dispatch.phase') = '${phase}'
              BEGIN SELECT RAISE(ABORT, 'fixture dispatch checkpoint write failed'); END`),
              )
              .pipe(Effect.orDie)
            yield* Effect.addFinalizer(() =>
              db.run(sql`DROP TRIGGER IF EXISTS dispatch_checkpoint_fault`).pipe(Effect.orDie),
            )
          }
          const original = runs.checkpoint
          let reached = false
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              Object.assign(runs, { checkpoint: original })
            }),
          )
          const checkpoint: DurableRun.Interface["checkpoint"] = (input) =>
            Effect.gen(function* () {
              const active = yield* runs.load(input.runID)
              const state = typeof input.state === "function" ? input.state(active.checkpoint?.state) : input.state
              const cursor = SessionCheckpoint.fromContainer(state, sessionID)
              if (
                cursor &&
                !cursor.legacy &&
                cursor.kind === SessionCheckpoint.KIND &&
                cursor.dispatch?.phase === phase
              ) {
                reached = true
                if (boundary === "write-failure") return yield* original(input)
                yield* original(input)
                return yield* Effect.interrupt
              }
              return yield* original(input)
            })
          Object.assign(runs, { checkpoint })
          const catalog = Billing.PriceCatalog.make({
            revision: "dispatch-fixture",
            currency: "USD",
            minorUnit: 2,
            unit: "token",
            effectiveFrom: DateTime.makeUnsafe(0),
            source: "fixture:dispatch",
            rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
          })
          const result = yield* runner
            .run({
              sessionID,
              force: true,
              billing: {
                budget: { currency: "USD", limitMinor: 1_000_000 },
                resolveCatalog: () => catalog,
              },
            })
            .pipe(Effect.exit)
          expect(reached).toBe(true)
          expect(result._tag).toBe("Failure")
          if (boundary === "write-failure" && Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain("fixture dispatch checkpoint write failed")
          expect(requests).toHaveLength(0)
          const run = (yield* runs.list({ sessionID }))[0]
          if (!run) throw new Error("Expected the interrupted or failed run")
          expect(run.run.status).toBe(boundary === "write-failure" ? "failed" : "paused")
          const cursor = run.checkpoint ? SessionCheckpoint.fromContainer(run.checkpoint.state, sessionID) : undefined
          const expected = boundary === "write-failure" ? (phase === "prepared" ? undefined : "prepared") : phase
          if (expected === undefined) expect(cursor).toBeUndefined()
          else {
            const rows = (yield* db.select().from(EventTable).all()).filter(
              (row) => row.type === EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1),
            )
            expect(rows).toHaveLength(1)
            expect(cursor).toMatchObject({
              dispatch: {
                version: 1,
                requestEventID: rows[0]!.id,
                requestDigest: rows[0]!.data.requestDigest,
                attempt: 1,
                providerAttempt: 1,
                turnStep: 1,
                phase: expected,
              },
            })
          }
          const receipts = yield* db
            .select()
            .from(SessionRunUsageTable)
            .where(eq(SessionRunUsageTable.session_id, sessionID))
            .all()
          expect(receipts).toHaveLength(phase === "prepared" ? 0 : 1)
          for (const receipt of receipts) {
            expect(receipt.amount_minor).toBe(0)
            expect(receipt.settlement_reservation_id).toBe(receipt.id)
            expect(RuntimeBilling.decodeReceipt(receipt.billing_receipt).settlement.state.activeReservationIDs).toEqual(
              [],
            )
          }
        }),
      )

  it.effect("a silent interrupted provider remains dispatching, not proven unsent", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const runs = yield* DurableRun.Service
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt a silent provider" }), resume: false })
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      response = []
      const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const before = (yield* runs.list({ sessionID }))[0]
      expect(before?.checkpoint?.state).toMatchObject({
        dispatch: { phase: "dispatching", attempt: 1, providerAttempt: 1 },
      })
      yield* Fiber.interrupt(fiber)
      streamGate = undefined
      streamStarted = undefined
      const after = (yield* runs.list({ sessionID }))[0]
      expect(after?.run.status).toBe("paused")
      expect(after?.checkpoint).toEqual(before?.checkpoint)
      expect(requests).toHaveLength(1)
      expect((yield* session.context(sessionID)).some((message) => message.type === "assistant")).toBe(false)
      const resumed = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
      expect(Exit.isFailure(resumed) && Cause.pretty(resumed.cause)).toContain("may already have been sent")
      expect(requests).toHaveLength(1)
      const blocked = (yield* runs.list({ sessionID }))[0]
      expect(blocked?.run.status).toBe("paused")
      expect(blocked?.checkpoint).toEqual(after?.checkpoint)
    }),
  )

  for (const change of ["unchanged", "configuration", "missing-event", "corrupt-event", "new-input"] as const)
    it.effect(`prepared request recovery uses the original committed request: ${change}`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const runs = yield* DurableRun.Service
        const { db } = yield* Database.Service
        requests.length = 0
        forbidLegacyStream = true
        currentModel = Model.make({
          id: model.id,
          provider: model.provider,
          route: OpenAIChat.route.with({ generation: { temperature: 0.1 } }),
        })
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Resume the exact prepared request" }),
          resume: false,
        })
        const original = runs.checkpoint
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            Object.assign(runs, { checkpoint: original })
          }),
        )
        const checkpoint: DurableRun.Interface["checkpoint"] = (input) =>
          Effect.gen(function* () {
            const saved = yield* original(input)
            const cursor = SessionCheckpoint.fromContainer(saved.state, sessionID)
            if (
              cursor &&
              !cursor.legacy &&
              cursor.kind === SessionCheckpoint.KIND &&
              cursor.dispatch?.phase === "prepared"
            )
              return yield* Effect.interrupt
            return saved
          })
        Object.assign(runs, { checkpoint })
        expect((yield* runner.run({ sessionID, force: true }).pipe(Effect.exit))._tag).toBe("Failure")
        Object.assign(runs, { checkpoint: original })
        expect(requests).toHaveLength(0)
        const paused = (yield* runs.recoverable(sessionID))[0]!
        expect(paused.checkpoint?.state).toMatchObject({ dispatch: { phase: "prepared", attempt: 1 } })
        const rows = yield* EventV2.readSerialized(db, {
          aggregateIDs: [sessionID],
          types: [EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)],
        })
        expect(rows).toHaveLength(1)
        const saved = parseRequestEnvelopeJson(String(rows[0]!.data.envelope))
        if (change === "new-input")
          yield* session.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Review this queued change first" }),
            delivery: "queue",
            resume: false,
          })
        if (change === "configuration") Object.assign(currentModel.route.defaults.generation!, { temperature: 0.9 })
        if (change === "missing-event") yield* db.delete(EventTable).where(eq(EventTable.id, rows[0]!.id))
        if (change === "corrupt-event")
          yield* db
            .update(EventTable)
            .set({ data: { ...rows[0]!.data, requestDigest: "0".repeat(64) } })
            .where(eq(EventTable.id, rows[0]!.id))
        const beforeRecovery = yield* EventV2.readSerialized(db, {
          aggregateIDs: [sessionID],
          types: [EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)],
        })
        response = fragmentFixture("text", "prepared-restored", ["The prepared request was restored."]).completeEvents
        const resumed = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
        if (change === "unchanged")
          expect(Exit.isFailure(resumed) ? Cause.pretty(resumed.cause) : "success").toBe("success")
        expect(Exit.isSuccess(resumed)).toBe(change === "unchanged")
        expect(requests).toHaveLength(change === "unchanged" ? 1 : 0)
        expect(
          yield* EventV2.readSerialized(db, {
            aggregateIDs: [sessionID],
            types: [EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)],
          }),
        ).toEqual(beforeRecovery)
        const after = yield* runs.load(paused.run.id)
        expect(after.run.status).toBe(change === "unchanged" ? "completed" : "paused")
        if (change === "unchanged") {
          expect(preparedSends[0]?.transmission).toEqual(saved.request.transmission)
          expect(after.checkpoint?.state).not.toHaveProperty("dispatch")
          expect(JSON.stringify(yield* session.context(sessionID))).toContain("The prepared request was restored.")
        } else {
          expect(Exit.isFailure(resumed) && Cause.pretty(resumed.cause)).toContain("prepared request")
          expect(after.checkpoint).toEqual(paused.checkpoint)
          if (change === "new-input") expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
        }
      }),
    )

  for (const boundary of ["completed-turn", "tool-continuation"] as const)
    for (const takeover of ["lease", "attempt"] as const)
      it.effect(`root checkpoint preserves replacement execution: ${boundary}/${takeover}`, () =>
        Effect.gen(function* () {
          yield* setup
          const session = yield* SessionV2.Service
          const runner = yield* SessionRunner.Service
          const runs = yield* DurableRun.Service
          requests.length = 0
          executions.length = 0
          yield* session.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Fence the root checkpoint" }),
            resume: false,
          })
          response = fragmentFixture("text", "checkpoint-root", ["Original answer"]).completeEvents
          if (boundary === "tool-continuation")
            responseStream = Stream.fromIterable([
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "checkpoint-root-tool", name: "echo", input: { text: "original tool" } }),
              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
              LLMEvent.finish({ reason: "tool-calls" }),
            ])
          const checkpoint = runs.checkpoint
          let changed = false
          let originalExecution: DurableRun.CheckpointExecution | undefined
          let suppliedExecution: DurableRun.CheckpointExecution | undefined
          let replacement: DurableRun.Snapshot | undefined
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              Object.assign(runs, { checkpoint })
            }),
          )
          const checkpointWithTakeover: DurableRun.Interface["checkpoint"] = (input) =>
            Effect.gen(function* () {
              const before = yield* runs.load(input.runID)
              const state = typeof input.state === "function" ? input.state(before.checkpoint?.state) : input.state
              const cursor = SessionCheckpoint.fromContainer(state, sessionID)
              // This test targets completed-turn/tool-continuation writes,
              // not the earlier prepared/dispatching metadata commits.
              if (cursor && !cursor.legacy && cursor.kind === SessionCheckpoint.KIND && cursor.dispatch)
                return yield* checkpoint(input)
              if (!changed) {
                changed = true
                const active = yield* runs.load(input.runID)
                if (!active.lease || !active.activeAttempt) throw new Error("Expected the original root execution")
                originalExecution = {
                  leaseID: active.lease.id,
                  ownerID: active.lease.ownerID,
                  attempt: active.activeAttempt.attempt,
                }
                suppliedExecution = input.execution
                if (takeover === "lease") {
                  yield* runs
                    .releaseLease({
                      runID: input.runID,
                      leaseID: active.lease.id,
                      ownerID: active.lease.ownerID,
                      reason: "fixture checkpoint takeover",
                    })
                    .pipe(Effect.orDie)
                  yield* runs
                    .acquireLease({ runID: input.runID, ownerID: "checkpoint-replacement", ttlMs: 60_000 })
                    .pipe(Effect.orDie)
                } else {
                  yield* runs
                    .finishAttempt({
                      runID: input.runID,
                      attempt: active.activeAttempt.attempt,
                      outcome: "interrupted",
                      durationMs: 0,
                      costMicros: 0,
                      tokens: 0,
                    })
                    .pipe(Effect.orDie)
                  yield* runs.beginAttempt({ runID: input.runID }).pipe(Effect.orDie)
                }
                yield* checkpoint({
                  runID: input.runID,
                  state: SessionCheckpoint.make({
                    sessionID,
                    nextStep: 7,
                    needsContinuation: true,
                    lastTurn: {
                      turnStep: 6,
                      requestDigest: "a".repeat(64),
                      contextDigest: "b".repeat(64),
                      toolSetRevision: "c".repeat(64),
                      routeConfigRevision: "d".repeat(64),
                      compilerRevision: "fixture-replacement",
                    },
                  }),
                })
                replacement = yield* runs.load(input.runID)
              }
              return yield* checkpoint(input)
            })
          Object.assign(runs, { checkpoint: checkpointWithTakeover })
          const result = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
          expect(changed).toBe(true)
          expect(result._tag).toBe("Failure")
          if (!replacement) throw new Error("Expected replacement execution to have a checkpoint")
          expect(yield* runs.load(replacement.run.id)).toEqual(replacement)
          expect(suppliedExecution).toEqual(originalExecution)
          expect(requests).toHaveLength(1)
        }),
      )

  it.effect("revalidates persisted billing history before reserving the next provider request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const db = (yield* Database.Service).db
      requests.length = 0
      RuntimeInsight.reset()
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use echo then continue" }), resume: false })
      const nextModelReady = yield* Deferred.make<void>()
      const nextModelGate = yield* Deferred.make<void>()
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "billing-history-call", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: { inputTokens: 1, nonCachedInputTokens: 1, outputTokens: 0, totalTokens: 1 },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "history-second", ["Must not send with broken billing history"]).completeEvents,
      ]
      const catalog = Billing.PriceCatalog.make({
        revision: "history-prices",
        currency: "USD",
        minorUnit: 6,
        unit: "token",
        effectiveFrom: DateTime.makeUnsafe(0),
        source: "fixture:history",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
      })
      let observed = 0
      const running = yield* runner
        .run({
          sessionID,
          force: true,
          billing: {
            budget: { currency: "USD", limitMinor: 100_000 },
            resolveCatalog: () => catalog,
            onSettlement: () => {
              observed++
              modelResolveHook = Deferred.succeed(nextModelReady, undefined).pipe(
                Effect.andThen(Deferred.await(nextModelGate)),
              )
            },
          },
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(nextModelReady)
      const stored = yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(stored).toHaveLength(1)
      expect(stored[0]?.amount_minor).toBe(1)
      yield* db
        .update(SessionRunUsageTable)
        .set({ billing_receipt: null })
        .where(eq(SessionRunUsageTable.id, stored[0].id))
        .run()
        .pipe(Effect.orDie)
      yield* Deferred.succeed(nextModelGate, undefined)
      expect((yield* Fiber.await(running))._tag).toBe("Failure")
      expect(requests).toHaveLength(1)
      expect(observed).toBe(1)
      expect(
        yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ ...stored[0], billing_receipt: null }])
    }),
  )

  it.effect("persists a pending billing reservation before the provider stream starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const db = (yield* Database.Service).db
      yield* db.run(sql`CREATE TEMP TABLE billing_session_lock_probe (session_id TEXT NOT NULL)`).pipe(Effect.orDie)
      yield* Effect.addFinalizer(() =>
        db
          .run(sql`DROP TRIGGER IF EXISTS billing_session_lock_probe_trigger`)
          .pipe(Effect.andThen(db.run(sql`DROP TABLE IF EXISTS billing_session_lock_probe`)), Effect.orDie),
      )
      yield* db
        .run(
          sql`CREATE TEMP TRIGGER billing_session_lock_probe_trigger AFTER UPDATE OF id ON session
        WHEN NEW.id = OLD.id AND NEW.time_updated = OLD.time_updated
        BEGIN INSERT INTO billing_session_lock_probe(session_id) VALUES (NEW.id); END`,
        )
        .pipe(Effect.orDie)
      RuntimeInsight.reset()
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Reserve before sending" }), resume: false })
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      response = fragmentFixture("text", "reserved-answer", ["Reserved answer"]).completeEvents
      const catalog = Billing.PriceCatalog.make({
        revision: "fixture-pending",
        currency: "USD",
        minorUnit: 2,
        unit: "token",
        effectiveFrom: DateTime.makeUnsafe(0),
        source: "fixture:pending",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
      })
      const fiber = yield* runner
        .run({
          sessionID,
          force: true,
          billing: { budget: { currency: "USD", limitMinor: 100_000 }, resolveCatalog: () => catalog },
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const pending = yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(pending).toHaveLength(1)
      expect(yield* db.all(sql`SELECT session_id FROM billing_session_lock_probe`).pipe(Effect.orDie)).toEqual([
        { session_id: sessionID },
      ])
      expect(pending[0]).toMatchObject({
        amount_minor: null,
        settlement_reservation_id: null,
        usage_source: "estimated",
        billing_receipt: { phase: "reserved", version: 1 },
      })
      expect(RuntimeInsight.billing()).toHaveLength(0)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(fiber)
      const complete = yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(complete).toHaveLength(1)
      expect(complete[0]?.id).toBe(pending[0]?.id)
      expect(complete[0]?.settlement_reservation_id).toBe(pending[0]?.id)
      expect(yield* db.all(sql`SELECT session_id FROM billing_session_lock_probe`).pipe(Effect.orDie)).toEqual([
        { session_id: sessionID },
        { session_id: sessionID },
      ])
      expect(RuntimeBilling.decodeReceipt(complete[0]?.billing_receipt).settlement.state.activeReservationIDs).toEqual(
        [],
      )
      expect(requests).toHaveLength(1)
    }),
  )

  for (const writePhase of ["reservation", "settlement"] as const) {
    it.effect(`billing ${writePhase} write failure prevents retry and settlement notification`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const db = (yield* Database.Service).db
        yield* db
          .run(
            writePhase === "reservation"
              ? sql`CREATE TRIGGER fixture_reject_billing BEFORE INSERT ON session_run_usage BEGIN SELECT RAISE(ABORT, 'fixture billing write rejected'); END`
              : sql`CREATE TRIGGER fixture_reject_billing BEFORE UPDATE ON session_run_usage BEGIN SELECT RAISE(ABORT, 'fixture billing write rejected'); END`,
          )
          .pipe(Effect.orDie)
        yield* Effect.addFinalizer(() => db.run(sql`DROP TRIGGER IF EXISTS fixture_reject_billing`).pipe(Effect.orDie))
        RuntimeInsight.reset()
        requests.length = 0
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Do not retry without a receipt" }),
          resume: false,
        })
        responseStream = Stream.fail(providerUnavailable())
        response = fragmentFixture("text", "unexpected-retry", ["Must not run"]).completeEvents
        const catalog = Billing.PriceCatalog.make({
          revision: "fixture-write-failure",
          currency: "USD",
          minorUnit: 2,
          unit: "token",
          effectiveFrom: DateTime.makeUnsafe(0),
          source: "fixture:write-failure",
          rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
        })
        let observed = 0
        const result = yield* runner
          .run({
            sessionID,
            force: true,
            retry: { maxTransportRetries: 1 },
            billing: {
              budget: Billing.Budget.make({ currency: "USD", limitMinor: 100_000 }),
              resolveCatalog: () => catalog,
              onSettlement: () => {
                observed += 1
              },
            },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("fixture billing write rejected")
        expect(requests).toHaveLength(writePhase === "reservation" ? 0 : 1)
        expect(observed).toBe(0)
        expect(RuntimeInsight.billing()).toHaveLength(0)
        const rows = yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        expect(rows).toHaveLength(writePhase === "reservation" ? 0 : 1)
        if (writePhase === "settlement") {
          expect(rows[0]).toMatchObject({
            amount_minor: null,
            settlement_reservation_id: null,
            billing_receipt: { version: 1, phase: "reserved" },
          })
          for (const strict of [false, true]) {
            yield* session.prompt({
              sessionID,
              prompt: Prompt.make({ text: "Continue with unresolved usage" }),
              resume: false,
            })
            const resumed = yield* runner
              .run({
                sessionID,
                force: true,
                ...(strict
                  ? {
                      billing: {
                        budget: Billing.Budget.make({ currency: "USD", limitMinor: 100_000 }),
                        resolveCatalog: () => catalog,
                      },
                    }
                  : {}),
              })
              .pipe(Effect.exit)
            expect(Exit.isFailure(resumed)).toBe(true)
            expect(Exit.isFailure(resumed) && Cause.pretty(resumed.cause)).toContain("Unsettled billing reservation")
            expect(requests).toHaveLength(1)
            expect(
              yield* db
                .select()
                .from(SessionRunUsageTable)
                .where(eq(SessionRunUsageTable.session_id, sessionID))
                .all()
                .pipe(Effect.orDie),
            ).toEqual(rows)
          }
          yield* db.run(sql`DROP TRIGGER fixture_reject_billing`).pipe(Effect.orDie)
          yield* db
            .run(
              sql`UPDATE session_run_usage SET billing_receipt = json_set(billing_receipt, '$.runID', 'wrong-run') WHERE session_id = ${sessionID}`,
            )
            .pipe(Effect.orDie)
          yield* session.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Do not recover a mismatched receipt" }),
            resume: false,
          })
          const mismatched = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
          expect(Exit.isFailure(mismatched)).toBe(true)
          expect(Exit.isFailure(mismatched) && Cause.pretty(mismatched.cause)).toContain(
            "Pending reservation does not match its storage identity",
          )
          expect(requests).toHaveLength(1)
          expect(RuntimeInsight.billing()).toHaveLength(0)
        }
      }),
    )
  }

  it.effect("reconciles billable provider failure usage before conservative settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      RuntimeInsight.reset()
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Reconcile this failed turn" }), resume: false })
      responseStream = Stream.fail(providerUnavailable())
      let reconciliationInput: Parameters<RuntimeBilling.UsageReconciler>[0] | undefined
      const catalog = Billing.PriceCatalog.make({
        revision: "fixture-reconciliation-prices-v1",
        currency: "USD",
        minorUnit: 2,
        unit: "1k-tokens",
        effectiveFrom: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
        source: "fixture:session-runner",
        rates: { unknownInput: { amountMinor: 1000 }, textOutput: { amountMinor: 1000 } },
      })
      const reconciled = Billing.TokenUsage.make({
        source: "provider",
        estimatorID: undefined,
        tokens: {
          unknownInput: 4,
          imageInput: 0,
          audioInput: 0,
          cacheReadInput: 0,
          cacheWriteInput: 0,
          textOutput: 2,
          reasoningOutput: 0,
          audioOutput: 0,
        },
      })

      const exit = yield* runner
        .run({
          sessionID,
          force: true,
          billing: {
            budget: Billing.Budget.make({ currency: "USD", limitMinor: 100_000 }),
            resolveCatalog: ({ providerID, modelID }) =>
              providerID === "fake" && modelID === "fake-model" ? catalog : undefined,
            reconcileUsage: (input) => {
              reconciliationInput = input
              return reconciled
            },
          },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(reconciliationInput).toMatchObject({
        providerID: "fake",
        modelID: "fake-model",
        failureCategory: "transport",
      })
      expect(RuntimeInsight.billing()[0]?.usage.source).toBe("provider")
      expect(RuntimeInsight.billing()[0]?.charge?.amountMinor).toBe(6)
      const db = (yield* Database.Service).db
      const persisted = yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        amount_minor: 6,
        usage_source: "provider",
        currency: "USD",
        unknown_input: 4,
        text_output: 2,
      })
      const receipt = RuntimeBilling.decodeReceipt(persisted[0]?.billing_receipt)
      expect(receipt).toMatchObject({
        runID: persisted[0]?.run_id,
        providerID: "fake",
        modelID: "fake-model",
        catalog: { revision: "fixture-reconciliation-prices-v1", minorUnit: 2 },
        before: { settledMinor: 0 },
        settlement: { actualMinor: 6, state: { settledMinor: 6, activeReservationIDs: [] } },
      })
      expect(receipt.requestDigest).toBe(RuntimeInsight.modelCalls()[0]?.requestDigest)
      expect(JSON.stringify(persisted[0]?.billing_receipt)).not.toContain("Reconcile this failed turn")
      RuntimeInsight.reset()
      expect(
        yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(persisted)
    }),
  )

  it.effect("falls back to a second model only before visible output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      RuntimeInsight.reset()
      requests.length = 0
      fallbackModel = replacementModel
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fallback this turn" }), resume: false })
      responseStream = Stream.fail(providerUnavailable())
      response = fragmentFixture("text", "fallback-answer", ["Fallback recovered"]).completeEvents

      yield* runner.run({ sessionID, force: true, retry: { maxTransportRetries: 0 } })

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model", "replacement"])
      expect(RuntimeInsight.modelCalls().map((call) => call.mode)).toEqual(["fallback", "primary"])
      expect(new Set(RuntimeInsight.modelCalls().map((call) => call.traceID))).toEqual(
        new Set([RuntimeInsight.runs()[0]?.traceID]),
      )
      expect(RuntimeInsight.metrics().map((metric) => metric.name)).toEqual(
        expect.arrayContaining(["llm.call", "llm.fallback", "llm.latency"]),
      )
      const fallbackRunID = RuntimeInsight.runs()[0]?.runID
      const fallbackActionAttempts = yield* (yield* Database.Service).db
        .select({ aggregateID: EventTable.aggregate_id, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .all()
        .pipe(Effect.orDie)
      const fallbackActionIDs = new Set(
        fallbackActionAttempts
          .filter((row) => {
            if (row.type !== "agent.action.proposed.1") return false
            const action = row.data.action
            return typeof action === "object" && action !== null && "runID" in action && action.runID === fallbackRunID
          })
          .map((row) => row.aggregateID),
      )
      expect(
        fallbackActionAttempts.filter(
          (row) => row.type === "agent.action.attempt-started.1" && fallbackActionIDs.has(row.aggregateID),
        ),
      ).toHaveLength(1)
      expect(RuntimeInsight.auditList().entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "llm.fallback",
            metadata: expect.objectContaining({
              category: "transport",
              originalModelID: "fake-model",
              fallbackModelID: "replacement",
            }),
          }),
        ]),
      )
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect", "deliver_test"])
      expect(requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  it.effect("binds one admitted request-scoped system instruction to exactly one provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      const system = RequestSystem.create("Turn-only policy")
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "First", system }),
        resume: false,
      })

      expect((yield* SessionInput.find(db, messageID))?.prompt.system).toEqual(system)
      requests.length = 0
      response = fragmentFixture("text", "request-system", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.system.map((part) => part.text)).toEqual(["Initial context", "Turn-only policy"])
      expect(requests[0]?.system.filter((part) => part.text === "Turn-only policy")).toHaveLength(1)
      const messages = yield* session.messages({ sessionID })
      expect(messages.find((message) => message.type === "user")).toMatchObject({ id: messageID, system })
    }),
  )

  it.effect("executes one canonical scheduled task before the Formal provider turn and never duplicates it", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      let taskExecutions = 0
      const scheduled = Tool.withPermission(
        Tool.make({
          description: "Execute one admitted scheduled task",
          effects: scopedChange({
            filesystemScope: [import.meta.dir],
            idempotency: "conditional",
            retryability: "guarded",
            reversibility: "compensatable",
            compensation: "cancel the delegated child and retain its audit trail",
            successCriteria: ["the delegated result is returned once"],
          }),
          input: Schema.Struct({
            prompt: Schema.String,
            description: Schema.String,
            subagent_type: Schema.String,
            command: Schema.String.pipe(Schema.optional),
          }),
          output: Schema.Struct({ output: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            context.permission.assert({ action: "task", resources: [input.subagent_type] }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  taskExecutions += 1
                  return { output: `delegated:${input.prompt}` }
                }),
              ),
              Effect.mapError((error) => new Tool.Failure({ message: error.reason })),
            ),
        }),
        "task",
      )
      const taskID = "prt_formal_scheduled_task"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Inspect the workspace, then summarize the delegated result.",
          scheduledTasks: [
            {
              id: taskID,
              prompt: "inspect workspace",
              description: "Inspect workspace",
              agent: "reviewer",
              model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
              command: "inspect",
            },
          ],
        }),
        resume: false,
      })

      requests.length = 0
      response = fragmentFixture("text", "scheduled-task-answer", ["Delegated work summarized."]).completeEvents
      yield* runner.run({ sessionID, force: true, scheduledTaskTool: scheduled })

      expect(taskExecutions).toBe(1)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain(TurnToolCarrier.scheduledTaskName)
      const context = yield* session.context(sessionID)
      expect(
        context
          .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
          .flatMap((message) => message.content)
          .filter((part) => part.type === "tool" && part.id === taskID),
      ).toMatchObject([
        {
          name: TurnToolCarrier.scheduledTaskName,
          state: { status: "completed", structured: { output: "delegated:inspect workspace" } },
        },
      ])

      requests.length = 0
      response = fragmentFixture("text", "scheduled-task-second-answer", ["No duplicate child."]).completeEvents
      yield* runner.run({ sessionID, force: true, scheduledTaskTool: scheduled })
      expect(taskExecutions).toBe(1)
      expect(requests).toHaveLength(1)
    }),
  )

  for (const boundary of ["receipt", "presentation"] as const) {
    it.effect(`repairs a scheduled ${boundary} write failure from the original Action without replaying the task`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const events = yield* EventV2.Service
        const actions = yield* DurableAction.Service
        let executions = 0
        let hooks = 0
        let failProjection = true
        yield* events.project(SessionEvent.Tool.Success, () =>
          failProjection && boundary === "presentation"
            ? Effect.die(new Error("fixture Session projection write failure"))
            : Effect.void,
        )
        yield* events.project(AgentRuntime.Event.ActionPostProcessingRecorded, (event) =>
          failProjection && boundary === "receipt" && event.data.processing.state === "completed"
            ? Effect.die(new Error("PRIVATE_POST_RECEIPT_WRITE_FAILURE"))
            : Effect.void,
        )
        const scheduled = Tool.withPermission(
          Tool.make({
            description: "Repair one scheduled presentation",
            effects: scopedChange({
              filesystemScope: [import.meta.dir],
              idempotency: "conditional",
              retryability: "guarded",
              reversibility: "compensatable",
              compensation: "retain child audit",
              successCriteria: ["return the original task once"],
            }),
            input: Schema.Struct({ prompt: Schema.String, description: Schema.String, subagent_type: Schema.String }),
            output: Schema.Struct({ output: Schema.String }),
            toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
            execute: () =>
              Effect.sync(() => {
                executions++
                return { output: "original task result" }
              }),
            postprocess: ({ output }) =>
              Effect.sync(() => {
                hooks++
                return {
                  ...output,
                  structured: { output: "confirmed display" },
                  content: [{ type: "text" as const, text: "confirmed display" }],
                }
              }),
          }),
          "task",
        )
        const taskID = "prt_native_projection_repair"
        yield* session.prompt({
          sessionID,
          resume: false,
          prompt: Prompt.make({
            text: "Inspect then summarize.",
            scheduledTasks: [
              {
                id: taskID,
                prompt: "inspect",
                description: "inspect",
                agent: "reviewer",
                model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
              },
            ],
          }),
        })
        requests.length = 0
        expect(
          Exit.isFailure(yield* runner.run({ sessionID, force: true, scheduledTaskTool: scheduled }).pipe(Effect.exit)),
        ).toBe(boundary === "presentation")
        const before = (yield* actions.list({ sessionID })).find((item) => item.action.name === "task")
        if (!before) return yield* Effect.die("scheduled Action was not retained")
        expect(before.action.status).toBe("settled")
        expect(before.observation?.output?.value).toMatchObject({ structured: { output: "original task result" } })
        if (boundary === "presentation")
          expect(before.postProcessing).toMatchObject({
            state: "completed",
            output: { value: { structured: { output: "confirmed display" } } },
          })
        else {
          expect(before.postProcessing?.state).toBe("started")
          expect(before.postProcessing?.output).toBeUndefined()
        }
        expect(requests).toHaveLength(boundary === "presentation" ? 0 : 1)
        failProjection = false
        requests.length = 0
        response = fragmentFixture("text", "repaired-scheduled-result", ["Recovered the original task."]).completeEvents
        yield* runner.run({ sessionID, force: true, scheduledTaskTool: scheduled })
        expect([executions, hooks]).toEqual([1, 1])
        expect(requests).toHaveLength(1)
        const tools = (yield* session.context(sessionID))
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .filter((part) => part.type === "tool" && part.id === taskID)
        if (boundary === "presentation")
          expect(tools).toMatchObject([
            { name: "task", state: { status: "completed", structured: { output: "confirmed display" } } },
          ])
        else {
          expect(tools).toMatchObject([{ name: "task", state: { status: "error" } }])
          expect(JSON.stringify(tools)).toContain("postprocessing receipt could not be confirmed")
          expect(JSON.stringify(tools)).not.toContain("Scheduled task failed:")
          expect(JSON.stringify(tools)).not.toContain("PRIVATE_POST_RECEIPT_WRITE_FAILURE")
          expect(JSON.stringify(tools)).not.toContain("confirmed display")
        }
        expect(yield* actions.load(before.action.id)).toEqual(before)
      }),
    )
  }

  it.effect("fails a canonical scheduled task visibly before the provider when its native runtime is missing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const taskID = "prt_missing_scheduled_carrier"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Delegate this review.",
          scheduledTasks: [
            {
              id: taskID,
              prompt: "review workspace",
              description: "Review workspace",
              agent: "reviewer",
            },
          ],
        }),
        resume: false,
      })

      requests.length = 0
      const error = yield* runner.run({ sessionID, force: true }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(TurnToolCarrier.InvalidCarrierError)
      expect(requests).toHaveLength(0)
      const context = yield* session.context(sessionID)
      const assistant = context.find(
        (message): message is SessionMessage.Assistant =>
          message.type === "assistant" && message.content.some((part) => part.type === "tool" && part.id === taskID),
      )
      expect(assistant).toMatchObject({
        finish: "error",
        error: {
          type: "unknown",
          message:
            "The delegated task runtime is unavailable. No child task was started; retry after restoring the task runtime.",
        },
        content: [
          {
            type: "tool",
            id: taskID,
            name: TurnToolCarrier.scheduledTaskName,
            provider: { executed: false },
            state: {
              status: "error",
              error: {
                type: "unknown",
                message:
                  "The delegated task runtime is unavailable. No child task was started; retry after restoring the task runtime.",
              },
            },
          },
        ],
      })
    }),
  )

  it.effect("recovers an interrupted scheduled task through one durable action without replaying its side effect", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const durableRuns = yield* DurableRun.Service
      const durableActions = yield* DurableAction.Service
      const taskStarted = yield* Deferred.make<void>()
      let taskExecutions = 0
      const scheduled = Tool.withPermission(
        Tool.make({
          description: "Execute one interruptible scheduled task",
          effects: scopedChange({
            filesystemScope: [import.meta.dir],
            idempotency: "conditional",
            retryability: "guarded",
            reversibility: "compensatable",
            compensation: "cancel the delegated child and retain its audit trail",
            successCriteria: ["the delegated result is returned once"],
          }),
          input: Schema.Struct({
            prompt: Schema.String,
            description: Schema.String,
            subagent_type: Schema.String,
            command: Schema.String.pipe(Schema.optional),
          }),
          output: Schema.Struct({ output: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (_input, context) =>
            context.permission.assert({ action: "task", resources: ["reviewer"] }).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  taskExecutions += 1
                  yield* Deferred.succeed(taskStarted, undefined)
                  return yield* Effect.never
                }),
              ),
              Effect.mapError((error) => new Tool.Failure({ message: error.reason })),
            ),
        }),
        "task",
      )
      const taskID = "prt_interrupted_scheduled_task"
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Delegate once, then explain the recovery result.",
          scheduledTasks: [
            {
              id: taskID,
              prompt: "review workspace once",
              description: "Review workspace once",
              agent: "reviewer",
            },
          ],
        }),
        resume: false,
      })

      requests.length = 0
      const firstFiber = yield* runner
        .run({ sessionID, force: true, scheduledTaskTool: scheduled })
        .pipe(Effect.forkChild)
      yield* Deferred.await(taskStarted)
      yield* Fiber.interrupt(firstFiber)
      const firstExit = yield* Fiber.await(firstFiber)

      expect(Exit.isFailure(firstExit) && Cause.hasInterruptsOnly(firstExit.cause)).toBe(true)
      expect(taskExecutions).toBe(1)
      expect(requests).toHaveLength(0)
      const recoverable = (yield* durableRuns.recoverable(sessionID)).at(0)
      expect(recoverable?.run.status).toBe("paused")
      const firstActions = recoverable ? yield* durableActions.list({ runID: recoverable.run.id, limit: 10 }) : []
      expect(firstActions).toHaveLength(1)
      expect(firstActions[0]?.action.subject).toMatchObject({
        type: "session",
        sessionID,
        toolCallID: taskID,
      })

      requests.length = 0
      response = fragmentFixture("text", "scheduled-task-recovery", ["The delegated task needs review."]).completeEvents
      yield* runner.run({ sessionID, force: true, scheduledTaskTool: scheduled })

      expect(taskExecutions).toBe(1)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      const context = yield* session.context(sessionID)
      expect(
        context
          .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool" && part.id === taskID),
      ).toMatchObject({
        name: TurnToolCarrier.scheduledTaskName,
        provider: { executed: false },
        state: {
          status: "error",
          error: { type: "unknown" },
        },
      })
      const finalActions = recoverable ? yield* durableActions.list({ runID: recoverable.run.id, limit: 10 }) : []
      expect(finalActions).toHaveLength(1)
      expect(finalActions[0]?.action.id).toBe(firstActions[0]?.action.id)
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }) })

      while (requests.length < 1) yield* Effect.yieldNow
      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context"])
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("updates selected-agent skill guidance after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nBuild skills"],
        ["Initial context\n\nBuild skills"],
      ])
      expect(systemTexts(requests[1]!)).toContainEqual(expect.stringContaining("Reviewer skills"))
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nBuild skills"],
      ])
    }),
  )

  it.effect("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([model])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([["Initial context"]])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps the baseline and chronological System updates after a model switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
        ["Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "system",
        "model-switched",
        "user",
        "system",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves the baseline while context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
        ["Initial context"],
      ])
    }),
  )

  it.effect("rebuilds the baseline directly after completed compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Replacement context"],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect(
    "reconciles a published compaction settlement before the next model turn",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const db = (yield* Database.Service).db
        const base = ContextSurface.make({
          epoch: 37,
          nodes: [{ id: "m_runner_recovery", sourceSeq: 1, role: "user", text: "runner recovery source" }],
        })
        const operationID = ContextSurface.asyncCompactionOperationID(base, "runner-recovery/v1")
        const candidateDigest = "c".repeat(64)
        const checkpoint = (
          sequence: number,
          phase: ContextSurface.AsyncCompactionPhase,
          reason?: ContextSurface.AsyncCompactionReason,
        ): ContextSurface.AsyncCompactionCheckpoint => ({
          version: 1,
          operationID,
          sequence,
          phase,
          epoch: base.epoch,
          generation: base.generation,
          sourceHeadSeq: base.sourceHeadSeq,
          surfaceDigest: base.digest,
          providerRevision: "runner-recovery/v1",
          ...(sequence >= 3 ? { candidateDigest } : {}),
          ...(reason === undefined ? {} : { reason }),
        })
        yield* SessionCompactionCheckpoint.append(db, sessionID, checkpoint(1, "prepared"))
        yield* SessionCompactionCheckpoint.append(db, sessionID, checkpoint(2, "summarizing"))
        yield* SessionCompactionCheckpoint.append(db, sessionID, checkpoint(3, "summarized"))
        yield* SessionCompactionCheckpoint.append(db, sessionID, checkpoint(4, "revalidated"))
        yield* SessionCompactionCheckpoint.append(db, sessionID, checkpoint(5, "committed", "compacted"))

        const messageID = SessionMessage.ID.make("msg_runner_compaction_recovery")
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID,
          messageID,
          timestamp: DateTime.makeUnsafe(1),
          reason: "auto",
        })
        yield* events.publish(SessionEvent.Compaction.Ended, {
          sessionID,
          messageID,
          timestamp: DateTime.makeUnsafe(2),
          reason: "auto",
          text: "Recovered before the next turn",
          recent: "",
          operationID,
          candidateDigest,
        })
        expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, operationID)).toBe("completed_unsettled")

        response = fragmentFixture("text", "text-after-recovery", ["Continued safely"]).completeEvents
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
        yield* session.resume(sessionID)

        expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, operationID)).toBe("committed")
        expect((yield* SessionCompactionCheckpoint.load(db, sessionID, operationID)).map((item) => item.phase)).toEqual(
          ["prepared", "summarizing", "summarized", "revalidated", "committed", "closed"],
        )
        expect((yield* session.context(sessionID))[0]).toMatchObject({
          type: "compaction",
          summary: "Recovered before the next turn",
        })
      }),
    15_000,
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain("## Objective")
      expect(userTexts(requests[0])[0]?.match(/\[User\]:/g)).toHaveLength(1)
      expect(userTexts(requests[1])).toHaveLength(2)
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Objective\n- Preserve the task\n</summary>")
      expect(userTexts(requests[1])[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)
      expect(userTexts(requests[1])[1]).toBe(SessionCompaction.CONTINUE_PROMPT)

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "synthetic", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the task",
      })
      const db = (yield* Database.Service).db
      const epochAfterCompaction = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
      const compactionMessage = context.find((message) => message.type === "compaction")
      expect(epochAfterCompaction?.baseline_seq).toBeGreaterThan(0)
      expect(compactionMessage).toBeDefined()
      const checkpointRows = yield* db
        .select()
        .from(SessionCompactionCheckpointTable)
        .where(eq(SessionCompactionCheckpointTable.session_id, sessionID))
        .orderBy(asc(SessionCompactionCheckpointTable.sequence))
        .all()
      expect(checkpointRows.map((row) => row.phase)).toEqual([
        "prepared",
        "summarizing",
        "summarized",
        "revalidated",
        "committed",
        "closed",
      ])
      const ended = (yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).findLast(
        (row) => row.type === EventV2.versionedType(SessionEvent.Compaction.Ended.type, 1),
      )
      expect(ended?.data).toMatchObject({
        operationID: checkpointRows[0]?.operation_id,
        candidateDigest: checkpointRows[4]?.checkpoint.candidateDigest,
      })

      requests.length = 0
      executions.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", ["## Objective\n- Preserve the updated task"]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain(
        "<previous-summary>\n## Objective\n- Preserve the task\n</previous-summary>",
      )
      expect(userTexts(requests[0])[0]).toContain("Recent exact request")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the updated task",
      })
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      forbidLegacyStream = true
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1])[0]).toContain("## Objective")
      const { db } = yield* Database.Service
      const requestRows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Compaction.RequestPrepared.type, 1)))
        .all()
      expect(requestRows).toHaveLength(1)
      const recorded = Schema.decodeUnknownSync(SessionEvent.Compaction.RequestPrepared.data)(requestRows[0]!.data)
      const frozen = parseRequestEnvelopeJson(recorded.envelope)
      expect(frozen.request_digest).toBe(recorded.requestDigest)
      expect(frozen.execution.run_id).toBeDefined()
      expect(frozen.execution.turn_step).toBeGreaterThanOrEqual(0)
      expect(frozen.execution.attempt).toBeGreaterThan(0)
      expect(preparedSends[1]?.transmission).toEqual(frozen.request.transmission)
      expect(userTexts(requests[2])[0]).toContain("<summary>\n## Objective\n- Recover overflow\n</summary>")
      expect(userTexts(requests[2])[1]).toBe(SessionCompaction.CONTINUE_PROMPT)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover overflow" },
        { type: "synthetic", text: SessionCompaction.CONTINUE_PROMPT },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "synthetic", text: SessionCompaction.CONTINUE_PROMPT },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover once"]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "synthetic", text: SessionCompaction.CONTINUE_PROMPT },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover raw overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover raw overflow" },
        { type: "synthetic", text: SessionCompaction.CONTINUE_PROMPT },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  for (const failure of ["publish-failure", "changed-row"] as const) {
    it.effect(`compaction request persistence failure prevents summary send: ${failure}`, () =>
      Effect.gen(function* () {
        const session = yield* setupOverflowRecovery
        const { db } = yield* Database.Service
        yield* Effect.addFinalizer(() =>
          db.run(sql`DROP TRIGGER IF EXISTS compaction_request_fault`).pipe(Effect.orDie),
        )
        if (failure === "publish-failure") {
          yield* db
            .run(
              sql`CREATE TEMP TRIGGER compaction_request_fault BEFORE INSERT ON event
          WHEN NEW.type = 'session.next.compaction.request.prepared.1'
          BEGIN SELECT RAISE(ABORT, 'fixture summary request failure'); END`,
            )
            .pipe(Effect.orDie)
        } else {
          yield* db
            .run(
              sql`CREATE TEMP TRIGGER compaction_request_fault AFTER INSERT ON event
          WHEN NEW.type = 'session.next.compaction.request.prepared.1'
          BEGIN UPDATE event SET data = json_set(data, '$.envelope', '{}') WHERE id = NEW.id; END`,
            )
            .pipe(Effect.orDie)
        }
        responses = [[LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })]]
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(1)
        expect(preparedSends).toHaveLength(1)
        const context = yield* session.context(sessionID)
        expect(context.some((message) => message.type === "compaction")).toBe(false)
        expect(context.at(-1)).toMatchObject({
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
        })
      }),
    )
  }

  it.effect("settles overflow summary and continuation against the same billed run", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const runner = yield* SessionRunner.Service
      const { db } = yield* Database.Service
      const catalog = Billing.PriceCatalog.make({
        revision: "fixture-compaction-prices",
        currency: "USD",
        minorUnit: 2,
        unit: "token",
        effectiveFrom: DateTime.makeUnsafe(0),
        source: "fixture:compaction",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
      })
      const summary = fragmentFixture("text", "metered-summary", [
        "## Objective\n- Preserve billed work",
      ]).completeEvents.filter((event) => !LLMEvent.is.finish(event))
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [
          ...summary,
          LLMEvent.finish({
            reason: "stop",
            usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }),
        ],
        fragmentFixture("text", "metered-continuation", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* runner.run({
        sessionID,
        force: true,
        billing: { budget: { currency: "USD", limitMinor: 100_000 }, resolveCatalog: () => catalog },
      })
      expect(requests).toHaveLength(3)
      const rows = (yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.session_id, sessionID))
        .all()).filter((row) => row.billing_receipt !== null)
      expect(rows).toHaveLength(3)
      expect(new Set(rows.map((row) => row.run_id)).size).toBe(1)
      const events = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Compaction.RequestPrepared.type, 1)))
        .all()
      const prepared = Schema.decodeUnknownSync(SessionEvent.Compaction.RequestPrepared.data)(events[0]!.data)
      const receipt = rows
        .map((row) => RuntimeBilling.decodeReceipt(row.billing_receipt))
        .find((receipt) => receipt.requestDigest === prepared.requestDigest)
      expect(receipt).toBeDefined()
      expect(receipt?.charge.amountMinor).toBe(15)
      expect(rows.every((row) => row.settlement_reservation_id === row.id)).toBe(true)
      const completed = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Compaction.Ended.type, 1)))
        .all()
      expect(completed[0]?.data).toMatchObject({ usage: { cost: 0.15 } })
    }),
  )

  for (const fault of ["budget", "reservation", "settlement"] as const) {
    it.effect(`compaction billing prevents unaccounted continuation: ${fault}`, () =>
      Effect.gen(function* () {
        const session = yield* setupOverflowRecovery
        const runner = yield* SessionRunner.Service
        const { db } = yield* Database.Service
        const catalog = Billing.PriceCatalog.make({
          revision: "fixture-summary-fault",
          currency: "USD",
          minorUnit: 2,
          unit: "token",
          effectiveFrom: DateTime.makeUnsafe(0),
          source: "fixture:summary-fault",
          rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
        })
        if (fault !== "budget") {
          yield* Effect.addFinalizer(() => db.run(sql`DROP TRIGGER IF EXISTS summary_billing_fault`).pipe(Effect.orDie))
          if (fault === "reservation")
            yield* db
              .run(
                sql`CREATE TEMP TRIGGER summary_billing_fault BEFORE INSERT ON session_run_usage
            WHEN NEW.id LIKE '%compaction%'
            BEGIN SELECT RAISE(ABORT, 'fixture summary reservation failed'); END`,
              )
              .pipe(Effect.orDie)
          else
            yield* db
              .run(
                sql`CREATE TEMP TRIGGER summary_billing_fault BEFORE UPDATE ON session_run_usage
            WHEN OLD.id LIKE '%compaction%' AND NEW.settlement_reservation_id IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'fixture summary settlement failed'); END`,
              )
              .pipe(Effect.orDie)
        }
        responses = [
          [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
          fragmentFixture("text", "unsettled-summary", ["Summary must not commit without settlement"]).completeEvents,
        ]
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
        yield* runner
          .run({
            sessionID,
            force: true,
            billing: {
              budget: { currency: "USD", limitMinor: fault === "budget" ? 1500 : 100_000 },
              resolveCatalog: () => catalog,
              estimator: {
                id: "fixture-fixed-input",
                estimate: () =>
                  Billing.TokenBreakdown.make({
                    unknownInput: 1,
                    imageInput: 0,
                    audioInput: 0,
                    cacheReadInput: 0,
                    cacheWriteInput: 0,
                    textOutput: 0,
                    reasoningOutput: 0,
                    audioOutput: 0,
                  }),
              },
            },
          })
          .pipe(Effect.exit)
        expect(requests).toHaveLength(fault === "settlement" ? 2 : 1)
        const rows = (yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()).filter((row) => row.billing_receipt !== null)
        expect(rows).toHaveLength(fault === "settlement" ? 2 : 1)
        const pending = rows.filter((row) => row.settlement_reservation_id === null)
        expect(pending).toHaveLength(fault === "settlement" ? 1 : 0)
        if (fault === "settlement") expect(pending[0]?.billing_receipt).toMatchObject({ phase: "reserved" })
        expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
      }),
    )
  }

  it.effect("reserves summary billing before send and settles cancellation before returning", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const runner = yield* SessionRunner.Service
      const { db } = yield* Database.Service
      const catalog = Billing.PriceCatalog.make({
        revision: "fixture-summary-cancel",
        currency: "USD",
        minorUnit: 2,
        unit: "token",
        effectiveFrom: DateTime.makeUnsafe(0),
        source: "fixture:summary-cancel",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
      })
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "cancelled-billed-summary", ["Do not commit"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      const fiber = yield* runner
        .run({
          sessionID,
          force: true,
          billing: {
            budget: { currency: "USD", limitMinor: 100_000 },
            resolveCatalog: () => catalog,
          },
        })
        .pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      const pending = (yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.session_id, sessionID))
        .all()).filter((row) => row.id.includes("compaction"))
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ settlement_reservation_id: null, billing_receipt: { phase: "reserved" } })
      yield* Fiber.interrupt(fiber)
      streamGate = undefined
      const settled = yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.id, pending[0]!.id))
        .get()
      expect(settled?.settlement_reservation_id).toBe(pending[0]!.id)
      expect(RuntimeBilling.decodeReceipt(settled?.billing_receipt).usage.source).toBe("estimated")
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.live(
    "recovers timed-out summary billing in current and fresh processes without repricing or resending",
    () =>
      Effect.gen(function* () {
        const session = yield* setupOverflowRecovery
        const runner = yield* SessionRunner.Service
        const runs = yield* DurableRun.Service
        const { db } = yield* Database.Service
        const catalog = Billing.PriceCatalog.make({
          revision: "summary-original-prices",
          currency: "USD",
          minorUnit: 2,
          unit: "token",
          effectiveFrom: DateTime.makeUnsafe(0),
          source: "fixture:summary-timeout",
          rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
        })
        const firstGate = yield* Deferred.make<void>()
        const summaryGate = yield* Deferred.make<void>()
        const lookupStarted = yield* Deferred.make<void>()
        let resolveUsage: ((usage: Billing.TokenUsage) => void) | undefined
        const unresolvedUsage = new Promise<Billing.TokenUsage>((resolve) => {
          resolveUsage = resolve
        })
        const confirmedUsage = RuntimeBilling.fromStepTokens({
          input: 4,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        })
        streamGate = firstGate
        responses = [
          [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
          fragmentFixture("text", "timed-out-summary", ["Not delivered"]).completeEvents,
        ]
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
        const fiber = yield* runner
          .run({
            sessionID,
            force: true,
            billing: {
              budget: { currency: "USD", limitMinor: 100_000 },
              resolveCatalog: () => catalog,
              reconcileUsage: () => {
                Deferred.doneUnsafe(lookupStarted, Effect.void)
                return unresolvedUsage
              },
            },
          })
          .pipe(Effect.forkChild)
        while (requests.length < 1) yield* Effect.yieldNow
        streamGate = summaryGate
        yield* Deferred.succeed(firstGate, undefined)
        while (requests.length < 2) yield* Effect.yieldNow
        const cancellation = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Deferred.await(lookupStarted)
        yield* Fiber.join(cancellation)
        streamGate = undefined
        const before = yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
        const pending = before.find((row) => row.id.includes("compaction"))!
        expect(pending).toMatchObject({ settlement_reservation_id: null, billing_receipt: { phase: "reserved" } })
        const stored = RuntimeBilling.decodeReservationReceipt(pending.billing_receipt, {
          runID: pending.run_id,
          reservationID: pending.id,
          providerID: pending.provider_id,
          modelID: pending.model_id,
        })
        expect((yield* runs.load(AgentRuntime.RunID.make(pending.run_id))).run.status).toBe("paused")
        resolveUsage?.(confirmedUsage)
        yield* Effect.promise(() => Promise.resolve())
        expect(
          yield* db.select().from(SessionRunUsageTable).where(eq(SessionRunUsageTable.id, pending.id)).get(),
        ).toEqual(pending)
        const fs = yield* FileSystem.FileSystem
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "arforge-summary-cold-" })
        const projectID = String((yield* session.get(sessionID)).projectID)
        const runWorker = Effect.fnUntraced(function* (copyPath: string, recovery: string) {
          const worker = Bun.spawn(
            [
              process.execPath,
              fileURLToPath(new URL("./fixture/billing-recovery-worker.ts", import.meta.url)),
              copyPath,
              testProjectDirectory,
              projectID,
              String(sessionID),
              recovery,
            ],
            { stdout: "pipe", stderr: "pipe" },
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => worker.kill()))
          const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
            Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]),
          )
          expect({ recovery, exitCode, stderr }).toEqual({ recovery, exitCode: 0, stderr: "" })
          expect(stdout).toContain('"sameRun":true')
          expect(stdout).toContain(`"providerCalls":${recovery === "summary-available" ? 1 : 0}`)
          expect(stdout).toContain(`"reconciliationCalls":${recovery === "summary-idle" ? 0 : 1}`)
        })
        for (const mode of ["summary-missing", "summary-estimated", "summary-rejected"]) {
          const copyPath = `${temporary}/${mode}.sqlite`
          yield* db.run(sql`VACUUM INTO ${copyPath}`).pipe(Effect.orDie)
          yield* runWorker(copyPath, mode)
          yield* runWorker(copyPath, "summary-available")
          yield* runWorker(copyPath, "summary-idle")
        }
        expect(
          yield* db.select().from(SessionRunUsageTable).where(eq(SessionRunUsageTable.session_id, sessionID)).all(),
        ).toEqual(before)
        let lookups = 0
        let available = false
        const policy: RuntimeBilling.RunConfig = {
          budget: { currency: "USD", limitMinor: 100_000 },
          resolveCatalog: () =>
            Billing.PriceCatalog.make({
              ...catalog,
              revision: "summary-new-prices",
              rates: { unknownInput: { amountMinor: 2 }, textOutput: { amountMinor: 2 } },
            }),
          reconcileUsage: (input) => {
            lookups++
            expect(input).toMatchObject({
              runID: pending.run_id,
              reservationID: pending.id,
              providerID: pending.provider_id,
              modelID: pending.model_id,
              requestDigest: stored.requestDigest,
              failureCategory: "recovery",
            })
            return available ? confirmedUsage : undefined
          },
        }
        const denied = yield* runner.run({ sessionID, force: true, billing: policy }).pipe(Effect.exit)
        expect(Exit.isFailure(denied)).toBe(true)
        expect(requests).toHaveLength(2)
        expect(
          yield* db.select().from(SessionRunUsageTable).where(eq(SessionRunUsageTable.session_id, sessionID)).all(),
        ).toEqual(before)
        available = true
        responses = [
          fragmentFixture("text", "after-summary-recovery", ["Continued from retained history"]).completeEvents,
        ]
        const recovered = yield* runner.run({ sessionID, force: true, billing: policy }).pipe(Effect.exit)
        expect(Exit.isFailure(recovered) ? Cause.pretty(recovered.cause) : "success").toBe("success")
        expect(lookups).toBe(2)
        expect(requests).toHaveLength(3)
        const after = yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
        const receipt = RuntimeBilling.decodeReceipt(after.find((row) => row.id === pending.id)?.billing_receipt)
        expect(receipt.catalog.revision).toBe("summary-original-prices")
        expect(receipt.charge.amountMinor).toBe(4)
        expect(after.filter((row) => row.id.includes("compaction"))).toHaveLength(1)
        const next = after.find((row) => !before.some((prior) => prior.id === row.id))!
        expect(next.run_id).toBe(pending.run_id)
        expect(RuntimeBilling.decodeReceipt(next.billing_receipt).before.settledMinor).toBe(
          receipt.settlement.state.settledMinor,
        )
        expect(RuntimeBilling.decodeReceipt(next.billing_receipt).catalog.revision).toBe("summary-new-prices")
        yield* runner.run({ sessionID, force: false })
        expect(requests).toHaveLength(3)
        expect(lookups).toBe(2)
      }),
    60_000,
  )

  for (const target of ["primary", "summary"] as const) {
    for (const outcome of ["cancel", "takeover"] as const) {
      it.effect(`committed reservation handoff is fenced before send: ${target}/${outcome}`, () =>
        Effect.gen(function* () {
          const session = yield* setupOverflowRecovery
          const runner = yield* SessionRunner.Service
          const database = yield* Database.Service
          const { db } = database
          const committed = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let paused = false
          let reservationFiber: Fiber.Fiber<unknown, unknown> | undefined
          const original = database.transactionAsPrincipal
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              database.transactionAsPrincipal = original
            }),
          )
          database.transactionAsPrincipal = <A, E, R>(
            principal: Database.Principal,
            callback: (transaction: Database.Transaction) => Effect.Effect<A, E, R>,
          ) =>
            original(principal, callback).pipe(
              Effect.tap((result) => {
                if (
                  paused ||
                  !result ||
                  typeof result !== "object" ||
                  !("phase" in result) ||
                  result.phase !== "reserved" ||
                  requests.length !== (target === "summary" ? 1 : 0)
                )
                  return Effect.void
                paused = true
                return Effect.withFiber((fiber) => {
                  reservationFiber = fiber
                  return Deferred.succeed(committed, undefined).pipe(Effect.andThen(Deferred.await(release)))
                })
              }),
            )
          const catalog = Billing.PriceCatalog.make({
            revision: "fixture-before-send",
            currency: "USD",
            minorUnit: 2,
            unit: "token",
            effectiveFrom: DateTime.makeUnsafe(0),
            source: "fixture:before-send",
            rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
          })
          responses = [[LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })]]
          yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
          let lookups = 0
          const fiber = yield* runner
            .run({
              sessionID,
              force: true,
              billing: {
                budget: { currency: "USD", limitMinor: 100_000 },
                resolveCatalog: () => catalog,
                reconcileUsage: () => {
                  lookups++
                  return undefined
                },
              },
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(committed)
          const pending = (yield* db
            .select()
            .from(SessionRunUsageTable)
            .where(eq(SessionRunUsageTable.session_id, sessionID))
            .all()).find((row) => row.billing_receipt !== null && row.settlement_reservation_id === null)!
          expect(pending).toBeDefined()
          expect(requests).toHaveLength(target === "summary" ? 1 : 0)
          if (outcome === "takeover") {
            const runs = yield* DurableRun.Service
            const active = yield* runs.load(AgentRuntime.RunID.make(pending.run_id))
            if (!active.lease) throw new Error("Expected a live reservation owner")
            yield* runs.releaseLease({
              runID: active.run.id,
              leaseID: active.lease.id,
              ownerID: active.lease.ownerID,
              reason: "fixture reservation handoff takeover",
            })
            yield* runs.acquireLease({ runID: active.run.id, ownerID: "reservation-replacement", ttlMs: 60_000 })
            const replacement = yield* runs.load(active.run.id)
            yield* Deferred.succeed(release, undefined)
            expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
            expect(requests).toHaveLength(target === "summary" ? 1 : 0)
            expect(
              yield* db.select().from(SessionRunUsageTable).where(eq(SessionRunUsageTable.id, pending.id)).get(),
            ).toEqual(pending)
            expect(yield* runs.load(active.run.id)).toEqual(replacement)
            expect(lookups).toBe(0)
            return
          }
          // Interrupt the actual reservation consumer before releasing its handoff.
          // Summary execution crosses a Promise boundary, so merely scheduling
          // interruption of the outer waiter does not prove signal delivery here.
          expect(reservationFiber).toBeDefined()
          reservationFiber!.interruptUnsafe()
          const cancellation = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(cancellation)
          const settled = yield* db
            .select()
            .from(SessionRunUsageTable)
            .where(eq(SessionRunUsageTable.id, pending.id))
            .get()
          expect(requests).toHaveLength(target === "summary" ? 1 : 0)
          expect(settled).toMatchObject({ settlement_reservation_id: pending.id, amount_minor: 0 })
          expect(RuntimeBilling.decodeReceipt(settled?.billing_receipt).settlement.state.activeReservationIDs).toEqual(
            [],
          )
          expect(lookups).toBe(0)
          expect(requests).toHaveLength(target === "summary" ? 1 : 0)
        }),
      )
    }
  }

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  for (const terminal of ["missing", "length", "tool-calls", "duplicate", "late-text", "provider-error"] as const) {
    it.effect(`rejects an incomplete compaction summary without replacing history: ${terminal}`, () =>
      Effect.gen(function* () {
        const session = yield* setupOverflowRecovery
        const summary = fragmentFixture("text", "summary-incomplete", ["Partial summary that must not replace history"])
        const summaryEvents: LLMEvent[] = summary.completeEvents.filter((event) => !LLMEvent.is.finish(event))
        if (terminal === "length" || terminal === "tool-calls")
          summaryEvents.push(LLMEvent.finish({ reason: terminal }))
        if (terminal === "duplicate")
          summaryEvents.push(LLMEvent.finish({ reason: "stop" }), LLMEvent.finish({ reason: "stop" }))
        if (terminal === "late-text")
          summaryEvents.push(
            LLMEvent.finish({ reason: "stop" }),
            LLMEvent.textDelta({ id: "summary-incomplete", text: "late" }),
          )
        if (terminal === "provider-error")
          summaryEvents.push(
            LLMEvent.finish({ reason: "stop" }),
            LLMEvent.providerError({ message: "summary failed after finish" }),
          )
        responses = [
          [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
          summaryEvents,
        ]
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(2)
        const context = yield* session.context(sessionID)
        expect(context.some((message) => message.type === "compaction" || message.type === "synthetic")).toBe(false)
        expect(context[0]).toMatchObject({ type: "user", text: "Earlier question ".repeat(700) })
        expect(context.at(-1)).toMatchObject({
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
        })
        yield* replaySessionProjection(sessionID)
        expect(yield* session.context(sessionID)).toEqual(context)
      }),
    )
  }

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", ["## Objective\n- Interrupted"]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
      const checkpointRows = yield* (yield* Database.Service).db
        .select()
        .from(SessionCompactionCheckpointTable)
        .where(eq(SessionCompactionCheckpointTable.session_id, sessionID))
        .orderBy(asc(SessionCompactionCheckpointTable.sequence))
        .all()
      expect(checkpointRows.map((row) => row.phase)).toEqual(["prepared", "summarizing", "aborted"])
      expect(
        yield* SessionCompactionCheckpoint.reconcile(
          (yield* Database.Service).db,
          sessionID,
          checkpointRows[0]!.operation_id,
        ),
      ).toBe("aborted")
    }),
  )

  it.effect("preserves effective System updates while compaction rebaseline is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Initial context"])
      expect(systemTexts(requests.at(-1)!)).toContain("Changed context")
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use tools" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
            ],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect", "deliver_test"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: { executed: true, metadata: { fake: { source: "provider" } } },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])

      // This is the complete runtime seam, not a direct registry invocation:
      // SessionExecution materializes the model tool call, ToolRegistry binds
      // the Tool.Context, and ActionGateway persists one durable action before
      // the leaf executor is allowed to run. Verify the durable lifecycle by
      // its exact tool subject so a second bypass path cannot hide in the
      // session runner.
      const { db } = yield* Database.Service
      const actionEvents = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, "agent.action.proposed.1"))
        .all()
        .pipe(Effect.orDie)
      const proposed = actionEvents.find(
        (row) =>
          (row.data as { action?: { name?: string; subject?: { type?: string; toolCallID?: string } } }).action
            ?.name === "echo" &&
          (row.data as { action?: { subject?: { type?: string; toolCallID?: string } } }).action?.subject?.type ===
            "session" &&
          (row.data as { action?: { subject?: { toolCallID?: string } } }).action?.subject?.toolCallID === "call-echo",
      )
      expect(proposed).toBeDefined()
      const lifecycle = proposed
        ? yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, proposed.aggregate_id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)
        : []
      expect(lifecycle.map((row) => row.type)).toEqual([
        "agent.action.proposed.1",
        "agent.action.lease-acquired.1",
        "agent.action.policy-evaluated.1",
        "agent.action.state-changed.1",
        "agent.action.state-changed.1",
        "agent.action.authorization-granted.1",
        "agent.action.state-changed.1",
        "agent.action.state-changed.1",
        "agent.action.attempt-started.1",
        "agent.action.attempt-finished.1",
        "agent.action.observed.1",
        "agent.action.state-changed.1",
        "agent.action.state-changed.1",
        "agent.action.lease-released.1",
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
      ])
    }),
  )

  it.effect("finalizes validated StructuredOutput through the canonical tool pipeline and exact request envelope", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const requestedSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          answer: { type: "string", minLength: 2 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["answer", "confidence"],
        additionalProperties: false,
      }
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Return a structured answer",
          format: { type: "json_schema", schema: requestedSchema, retryCount: 2 },
        }),
        resume: false,
      })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-structured-final",
            name: StructuredOutput.name,
            input: { answer: "yes", confidence: 0.9 },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.toolChoice).toMatchObject({ type: "required" })
      expect(requests[0]?.tools.find((tool) => tool.name === StructuredOutput.name)).toMatchObject({
        description: expect.stringContaining("final answer"),
        inputSchema: {
          type: "object",
          properties: {
            answer: { type: "string", minLength: 2 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["answer", "confidence"],
          additionalProperties: false,
        },
      })
      expect(requests[0]?.system.map((part) => part.text).join("\n")).toContain("call StructuredOutput exactly once")
      expect(yield* session.context(sessionID)).toMatchObject([
        {
          type: "user",
          text: "Return a structured answer",
          format: { type: "json_schema", retryCount: 2 },
        },
        {
          type: "assistant",
          finish: "stop",
          structured: { answer: "yes", confidence: 0.9 },
          content: [
            {
              type: "tool",
              id: "call-structured-final",
              name: StructuredOutput.name,
              state: { status: "completed", input: { answer: "yes", confidence: 0.9 } },
            },
          ],
        },
      ])

      const formalParity = fromCoreParity(yield* session.context(sessionID), {
        terminalStatus: "completed",
        requestCount: 1,
      })
      const expectedParity = makeSessionParity({
        adapter: "provider-replay",
        terminalStatus: "completed",
        requestCount: 1,
        steps: [
          {
            finish: "stop",
            hasText: false,
            hasReasoning: false,
            structured: true,
            failed: false,
            tools: [{ name: StructuredOutput.name, status: "completed" }],
          },
        ],
      })
      expect(compareSessionParity(expectedParity, formalParity).equivalent).toBe(true)
      expect(formalParity.traceDigest).toHaveLength(64)

      const { db } = yield* Database.Service
      const envelopeRows = (yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)))
        .all()).filter((row) => (row.data as { sessionID?: string }).sessionID === sessionID)
      const persisted = parseRequestEnvelopeJson((envelopeRows.at(-1)!.data as { envelope: string }).envelope)
      expect(persisted.request.tools).toHaveLength(requests[0]!.tools.length)
      expect(
        (persisted.request.tools as ReadonlyArray<{ name?: string }>).find(
          (tool) => tool.name === StructuredOutput.name,
        ),
      ).toMatchObject({
        name: StructuredOutput.name,
        inputSchema: {
          type: "object",
          required: ["answer", "confidence"],
          additionalProperties: false,
        },
      })
      expect(persisted.request.tool_choice).toEqual({ type: "required" })

      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", format: { type: "json_schema", retryCount: 2 } },
        { type: "assistant", structured: { answer: "yes", confidence: 0.9 } },
      ])
    }),
  )

  it.effect("uses the declared retry budget after semantic StructuredOutput validation fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Return a valid structured answer",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
            retryCount: 1,
          },
        }),
        resume: false,
      })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-structured-invalid",
            name: StructuredOutput.name,
            input: { answer: 7, extra: true },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-structured-corrected",
            name: StructuredOutput.name,
            input: { answer: "corrected" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.messages)).toContain("Invalid tool input")
      expect(requests[0]?.system.map((part) => part.text).join("\n")).toContain("1 structured-output retry")
      expect(requests[1]?.system.map((part) => part.text).join("\n")).toContain("0 structured-output retries")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", format: { type: "json_schema", retryCount: 1 } },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-structured-invalid",
              state: { status: "error", error: { message: expect.stringContaining("Invalid tool input") } },
            },
          ],
        },
        {
          type: "assistant",
          structured: { answer: "corrected" },
          content: [{ type: "tool", id: "call-structured-corrected", state: { status: "completed" } }],
        },
      ])
    }),
  )

  it.effect("fails visibly and terminates when the model exhausts prose-only structured-output attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Do not silently ignore my structured format",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
            retryCount: 1,
          },
        }),
        resume: false,
      })
      requests.length = 0
      responses = [
        fragmentFixture("text", "structured-miss-one", ["I forgot the required tool."]).completeEvents,
        fragmentFixture("text", "structured-miss-two", ["I still returned prose."]).completeEvents,
        fragmentFixture("text", "structured-must-not-run", ["unbounded retry"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.toolChoice).toEqual({ type: "required" })
      expect(requests[1]?.toolChoice).toEqual({ type: "required" })
      expect(requests[1]?.tools).toEqual(requests[0]?.tools)
      expect(requests[0]?.system.map((part) => part.text).join("\n")).toContain("1 structured-output retry")
      expect(requests[1]?.system.map((part) => part.text).join("\n")).toContain("0 structured-output retries")
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", format: { type: "json_schema", retryCount: 1 } },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "I forgot the required tool." }] },
        {
          type: "assistant",
          finish: "error",
          error: {
            type: "unknown",
            message: StructuredOutput.exhaustedMessage(1),
          },
          content: [{ type: "text", text: "I still returned prose." }],
        },
      ])
      expect(context[0]).toMatchObject({ type: "user", format: { type: "json_schema", retryCount: 1 } })
      expect(JSON.stringify(context)).not.toContain("unbounded retry")
    }),
  )

  it.effect("stops the model loop after a primary delivery tool settles", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Deliver once" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-provisional" }),
          LLMEvent.textDelta({ id: "text-provisional", text: "Temporary" }),
          LLMEvent.toolCall({
            id: "call-deliver",
            name: "deliver_test",
            input: { message: "Durable primary answer" },
          }),
          LLMEvent.textEnd({ id: "text-provisional" }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "text-duplicate", ["Duplicate continuation"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Deliver once" },
        {
          type: "assistant",
          delivery: {
            status: "normal",
            attachmentCount: 0,
            localOnly: true,
            uploaded: false,
          },
          content: [
            { type: "tool", id: "call-deliver", state: { status: "completed" } },
            { type: "text", id: "primary:call-deliver", text: "Durable primary answer" },
          ],
        },
      ])
      expect(JSON.stringify(yield* session.context(sessionID))).not.toContain("Temporary")
      expect(JSON.stringify(yield* session.context(sessionID))).not.toContain("Duplicate continuation")
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Initial context"],
      ])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Think first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({ id: "reasoning-anthropic", providerMetadata: { anthropic: { signature: "sig_1" } } }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({ id: model.id, provider: model.provider, route: AnthropicMessages.route })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Search first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("projects a large durable tool result through ResultPruner and persists the exact provider request", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({ id: model.id, provider: model.provider, route: AnthropicMessages.route })
      const session = yield* SessionV2.Service
      const largeResult = "😀".repeat(30_000)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Inspect a large hosted result" }),
        resume: false,
      })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-large-result",
          name: "web_search",
          input: { query: "large" },
          providerExecuted: true,
        }),
        LLMEvent.toolResult({
          id: "hosted-large-result",
          name: "web_search",
          result: { type: "text", value: largeResult },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)
      expect(JSON.stringify(yield* session.context(sessionID))).toContain(largeResult)

      // A roomy route keeps the original result; pruning is pressure-driven,
      // not an unconditional 8K truncation policy.
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Use the full result while context is roomy" }),
        resume: false,
      })
      response = fragmentFixture("text", "roomy-result", ["Roomy context retained."]).completeEvents
      yield* session.resume(sessionID)
      expect(JSON.stringify(requests[1]?.messages)).toContain(largeResult)
      expect(JSON.stringify(requests[1]?.messages)).not.toContain(ResultPruner.PRUNE_MARKER)

      currentModel = Model.make({
        id: prunerModel.id,
        provider: prunerModel.provider,
        route: AnthropicMessages.route.with({ limits: { context: 8_000, output: 50 } }),
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Continue from the retained boundaries" }),
        resume: false,
      })
      response = []
      yield* session.resume(sessionID)

      const pressuredRequest = requests[2]!
      const projected = pressuredRequest.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.id === "hosted-large-result")
      expect(projected).toMatchObject({ type: "tool-result", id: "hosted-large-result" })
      expect(
        projected?.type === "tool-result" && projected.result.type === "text" ? projected.result.value : "",
      ).toContain(ResultPruner.PRUNE_MARKER)
      expect(JSON.stringify(pressuredRequest.messages)).not.toContain(largeResult)

      const { db } = yield* Database.Service
      const envelopeRows = (yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)))
        .all()).filter((row) => (row.data as { sessionID?: string }).sessionID === sessionID)
      const persisted = parseRequestEnvelopeJson((envelopeRows.at(-1)!.data as { envelope: string }).envelope)
      expect(persisted.request.messages).toEqual(JSON.parse(JSON.stringify(pressuredRequest.messages)))
    }),
  )

  it.effect("bounds recorded local tools and awaits ordered settlement before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo five times" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      // Safe work is bounded by the shared rolling pool (four permits). The
      // fifth call remains queued until one of the first four settles.
      toolExecutionsReady = 4
      const providerGate = yield* Deferred.make<void>()
      response = []
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(4)
      expect(maxActiveToolExecutions).toBe(4)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(4)
      const toolStates = (yield* session.context(sessionID))
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part) => part.type === "tool")
        .map((part) => ({ id: part.id, status: part.state.status }))
      expect(toolStates).toEqual(
        Array.from({ length: 5 }, (_, index) => ({ id: `call-echo-${index}`, status: "completed" })),
      )
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run once" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("promotes queued input after continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait until continuation ends" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Wait until continuation ends"])
    }),
  )

  it.effect("preserves queued input without replaying an interrupted unknown request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(resumed) && Cause.pretty(resumed.cause)).toContain("may already have been sent")
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const runEvents = (yield* db.select().from(EventTable).all()).filter((row) => row.type.startsWith("agent.run."))
      const created = runEvents.filter((row) => row.type === "agent.run.created.1")
      expect(created).toHaveLength(1)
      // The first lease is part of RunCreated; only takeover has a separate event.
      expect(created[0]?.data.initialLease).toMatchObject({ generation: 0 })
      expect(runEvents.filter((row) => row.type === "agent.run.lease-acquired.1")).toHaveLength(1)
      expect(runEvents.filter((row) => row.type === "agent.run.lease-released.1")).toHaveLength(2)
      expect(runEvents.filter((row) => row.type === "agent.run.state-changed.1").map((row) => row.data.to)).toEqual(
        expect.arrayContaining(["paused", "recovering", "running"]),
      )
    }),
  )

  for (const phase of ["draft", "preflight", "queued", "running"] as const) {
    it.effect(`root admission recovery preserves the original ${phase} run and budget`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const runs = yield* DurableRun.Service
        const runner = yield* SessionRunner.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover original admission" }), resume: false })
        requests.length = 0
        response = fragmentFixture("text", "admission-answer", ["Recovered original admission"]).completeEvents
        const created = yield* runs.create(
          {
            sessionID,
            initiator: "user",
            authority: "automatic",
            riskTier: "L0",
            reasonSummary: "Original accepted work",
            traceID: "trace-admission",
            visibility: "details",
            project: (yield* session.get(sessionID)).projectID,
            location: testProjectDirectory,
            admission: { version: 1, owner: "session-runner", credentialIDs: null, billing: null },
            budget: AgentRuntime.Budget.make({
              maxAttempts: 2,
              maxDurationMs: 75_000,
              maxCostMicros: 123_456,
              maxTokens: 90_000,
              attemptsUsed: 0,
              durationMsUsed: 0,
              costMicrosUsed: 0,
              tokensUsed: 0,
            }),
          },
          { exclusiveSession: true, initialLease: { ownerID: "crashed-admission", ttlMs: 1_000 } },
        )
        const runID = created.run.id
        for (const to of ["preflight", "queued", "running"] as const) {
          if (phase === "draft") break
          yield* runs.transition({ runID, to, reason: "original admission stage" })
          if (to === phase) break
        }
        const before = yield* runs.load(runID)
        const occupied = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
        expect(occupied._tag).toBe("Failure")
        expect(yield* runs.load(runID)).toEqual(before)
        expect(requests).toHaveLength(0)
        yield* TestClock.adjust("1 second")
        yield* runner.run({ sessionID, force: true })
        const recovered = yield* runs.load(runID)
        expect(yield* runs.list({ sessionID })).toHaveLength(1)
        expect(recovered.run).toMatchObject({
          id: runID,
          status: "completed",
          admission: created.run.admission,
          traceID: created.run.traceID,
          authority: created.run.authority,
          budget: { maxAttempts: 2, maxDurationMs: 75_000, maxCostMicros: 123_456, maxTokens: 90_000, attemptsUsed: 1 },
        })
        expect(recovered.activeAttempt).toBeUndefined()
        expect(recovered.lease).toBeUndefined()
        expect(recovered.lastLeaseGeneration).toBe(1)
        expect(requests).toHaveLength(1)
      }),
    )
  }

  for (const mismatch of [
    "credential-scope",
    "billing-removed",
    "budget",
    "currency",
    "estimator",
    "workspace",
    "authority",
  ] as const) {
    it.effect(`root admission recovery rejects changed ${mismatch} without consuming input or budget`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const runs = yield* DurableRun.Service
        const runner = yield* SessionRunner.Service
        const { db } = yield* Database.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Preserve scoped work" }), resume: false })
        requests.length = 0
        const admission = Schema.decodeUnknownSync(AgentRuntime.SessionRunAdmission)({
          version: 1,
          owner: "session-runner",
          credentialIDs: ["cred-original"],
          billing: {
            budget: { currency: "USD", limitMinor: 1_000 },
            estimatorID: RuntimeBilling.CharacterEstimator.id,
          },
        })
        const created = yield* runs.create(
          {
            sessionID,
            initiator: "user",
            authority: mismatch === "authority" ? "human" : "automatic",
            riskTier: "L0",
            reasonSummary: "Scoped original work",
            traceID: "trace-scoped-admission",
            visibility: "details",
            admission,
            project: (yield* session.get(sessionID)).projectID,
            location:
              mismatch === "workspace" ? AbsolutePath.make(`${testProjectDirectory}/other`) : testProjectDirectory,
            budget: AgentRuntime.Budget.make({
              maxAttempts: 2,
              maxDurationMs: 75_000,
              maxCostMicros: 123_456,
              maxTokens: 90_000,
              attemptsUsed: 0,
              durationMsUsed: 0,
              costMicrosUsed: 0,
              tokensUsed: 0,
            }),
          },
          { exclusiveSession: true, initialLease: { ownerID: "crashed-scoped-admission", ttlMs: 1_000 } },
        )
        yield* TestClock.adjust("1 second")
        const before = yield* runs.load(created.run.id)
        const queued = yield* SessionInput.listPending(db, sessionID, "queue")
        const result = yield* runner
          .run({
            sessionID,
            force: true,
            billing:
              mismatch === "billing-removed"
                ? undefined
                : {
                    budget: Billing.Budget.make({
                      currency: mismatch === "currency" ? "EUR" : "USD",
                      limitMinor: mismatch === "budget" ? 2_000 : 1_000,
                    }),
                    resolveCatalog: () => {
                      throw new Error("Changed admission must not resolve a price catalog")
                    },
                    estimator:
                      mismatch === "estimator"
                        ? { ...RuntimeBilling.CharacterEstimator, id: "changed-estimator" }
                        : undefined,
                  },
          })
          .pipe(
            Effect.provideService(
              SessionRunnerModel.CredentialScope,
              mismatch === "credential-scope" ? undefined : (admission.credentialIDs ?? undefined),
            ),
            Effect.exit,
          )
        const reason =
          mismatch === "workspace" || mismatch === "authority"
            ? "workspace or authority"
            : mismatch === "billing-removed"
              ? "requires its billing policy"
              : mismatch === "budget" || mismatch === "currency"
                ? "budget policy changed"
                : "Resume with its original credential scope and billing budget"
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain(reason)
        expect(yield* runs.load(created.run.id)).toEqual(before)
        expect(yield* SessionInput.listPending(db, sessionID, "queue")).toEqual(queued)
        expect(yield* runs.list({ sessionID })).toHaveLength(1)
        expect(requests).toHaveLength(0)
        expect(yield* db.select().from(SessionRunUsageTable).all().pipe(Effect.orDie)).toEqual([])
      }),
    )
  }

  it.effect("closes an expired worker's active attempt before recovering the same Session run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const durableRuns = yield* DurableRun.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover crashed work" }), resume: false })
      response = fragmentFixture("text", "recovered-run", ["Recovered"]).completeEvents

      const crashed = yield* durableRuns.create({
        sessionID,
        initiator: "recovery",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "Simulate a crashed Session worker",
        budget: AgentRuntime.Budget.make({
          maxAttempts: 3,
          maxDurationMs: 60_000,
          maxCostMicros: 1_000_000,
          maxTokens: 1_000_000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        }),
        traceID: `trace_${sessionID}_recovery`,
        visibility: "details",
      })
      yield* durableRuns.transition({ runID: crashed.run.id, to: "preflight", reason: "scope inspected" })
      yield* durableRuns.transition({ runID: crashed.run.id, to: "queued", reason: "ready" })
      yield* durableRuns.acquireLease({ runID: crashed.run.id, ownerID: "crashed-worker", ttlMs: 1 })
      yield* durableRuns.transition({ runID: crashed.run.id, to: "running", reason: "worker started" })
      yield* durableRuns.beginAttempt({
        runID: crashed.run.id,
        usageBaseline: AgentRuntime.RunUsageBaseline.make({ costMicros: 0, tokens: 0 }),
      })
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          cost: 0.2,
          tokens_input: 7,
          tokens_output: 3,
          tokens_reasoning: 2,
          tokens_cache_read: 1,
          tokens_cache_write: 0,
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* TestClock.adjust("2 millis")

      const originalFinish = durableRuns.finishAttempt
      const finishOwner: { finishAttempt: DurableRun.Interface["finishAttempt"] } = durableRuns
      let recoveredWithIdentity = false
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          finishOwner.finishAttempt = originalFinish
        }),
      )
      finishOwner.finishAttempt = (input) =>
        Effect.gen(function* () {
          if (input.runID === crashed.run.id && input.attempt === 1 && input.outcome === "interrupted") {
            const current = yield* durableRuns.load(input.runID)
            if (!current.lease)
              throw new Error("Recovery must hold its original lease before finishing the old attempt")
            expect(input.execution).toEqual({ leaseID: current.lease.id, ownerID: current.lease.ownerID, attempt: 1 })
            recoveredWithIdentity = true
          }
          return yield* originalFinish(input)
        })
      yield* session.resume(sessionID)
      expect(recoveredWithIdentity).toBe(true)

      const recovered = yield* durableRuns.load(crashed.run.id)
      expect(recovered.run.status).toBe("completed")
      expect(recovered.run.budget.attemptsUsed).toBe(2)
      expect(recovered.run.budget.costMicrosUsed).toBe(200_000)
      expect(recovered.run.budget.tokensUsed).toBe(13)
      expect(recovered.activeAttempt).toBeUndefined()
      expect(recovered.lease).toBeUndefined()
    }),
  )

  it.effect("preserves steering input without replaying an interrupted unknown request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(resumed) && Cause.pretty(resumed.cause)).toContain("may already have been sent")
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("promotes queued inputs one at a time in FIFO order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("promotes queued input after steering continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start steering" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue for later" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering", "Queue for later"])
    }),
  )

  it.effect("promotes steers before the next queued input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Steer before next queued input" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Also steer before next queued input" }) })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First steer" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second steer" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover with this" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      while (requests.length < 2) yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover interrupted tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({ id: model.id, provider: model.provider, route: AnthropicMessages.route })
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: { executed: true, metadata: { openai: { itemId: "call-hosted-interrupted" } } },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait in queue" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      yield* (yield* SessionExecution.Service).wakeAndWait(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait in queue"])
    }),
  )

  it.effect("sends the preparation bound to the committed envelope without calling legacy stream", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      forbidLegacyStream = true
      response = fragmentFixture("text", "prepared-answer", ["done"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Use the committed preparation" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      expect(preparedSends).toHaveLength(1)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)))
        .all()
      expect(rows).toHaveLength(1)
      const data = Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(rows[0]!.data)
      const recorded = parseRequestEnvelopeJson(data.envelope)
      expect(preparedSends[0]!.transmission).toEqual(recorded.request.transmission)
    }),
  )

  for (const scenario of ["body-mutation", "defaults-mutation"] as const) {
    it.effect(`checks the actual preparation after envelope publication: ${scenario}`, () =>
      Effect.gen(function* () {
        yield* setup
        currentModel = Model.make({
          id: model.id,
          provider: model.provider,
          route: OpenAIChat.route.with({ generation: { temperature: 0.1 } }),
        })
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* events.project(SessionEvent.RequestEnvelopePrepared, () =>
          Effect.sync(() => {
            if (scenario === "defaults-mutation") {
              Object.assign(currentModel.route.defaults.generation!, { temperature: 0.9 })
            } else {
              const body = preparations.at(-1)?.transmission?.body
              if (!body || typeof body !== "object") throw new Error("Missing fixture transmission")
              Object.assign(body, { temperature: 0.9 })
            }
          }),
        )
        forbidLegacyStream = true
        response = fragmentFixture("text", "bound-answer", ["done"]).completeEvents
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Keep the prepared request" }), resume: false })
        const exit = yield* session.resume(sessionID).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(scenario === "defaults-mutation")
        expect(preparedSends).toHaveLength(scenario === "defaults-mutation" ? 1 : 0)
        if (scenario === "defaults-mutation")
          expect(preparedSends[0]?.transmission?.body).toMatchObject({ temperature: 0.1 })
      }),
    )
  }

  for (const scenario of ["publish-failure", "changed-row"] as const) {
    it.effect(`does not send without the committed request envelope: ${scenario}`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Verify the committed request" }),
          resume: false,
        })
        yield* Effect.addFinalizer(() => db.run(sql`DROP TRIGGER IF EXISTS request_envelope_fault`).pipe(Effect.orDie))
        if (scenario === "publish-failure") {
          yield* db
            .run(
              sql`CREATE TEMP TRIGGER request_envelope_fault BEFORE INSERT ON event
          WHEN NEW.type = 'session.next.request.envelope.prepared.1'
          BEGIN SELECT RAISE(ABORT, 'fixture request publish failure'); END`,
            )
            .pipe(Effect.orDie)
        } else {
          yield* db
            .run(
              sql`CREATE TEMP TRIGGER request_envelope_fault AFTER INSERT ON event
          WHEN NEW.type = 'session.next.request.envelope.prepared.1'
          BEGIN UPDATE event SET data = json_set(data, '$.envelope', '{}') WHERE id = NEW.id; END`,
            )
            .pipe(Effect.orDie)
        }
        response = fragmentFixture("text", "unsent", ["must not send"]).completeEvents
        requests.length = 0
        const exit = yield* session.resume(sessionID).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(requests).toHaveLength(0)
        expect(preparedSends).toHaveLength(0)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)))
          .all()
        expect(rows).toHaveLength(scenario === "publish-failure" ? 0 : 1)
        if (scenario === "changed-row") expect(rows[0]?.data.envelope).toBe("{}")
      }),
    )
  }

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.Prompted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover promoted input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run first" }), resume: false })
      yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Run second" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("bounds 64-character session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
      yield* insertSession(longSessionID)
      yield* insertSession(otherLongSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: longSessionID,
        prompt: Prompt.make({ text: "Run long session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherLongSessionID,
        prompt: Prompt.make({ text: "Run other long session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(longSessionID)
      yield* session.resume(otherLongSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry after failure" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call missing" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: { status: "error", error: { message: "Unknown tool: missing" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("blocks an exact repeated tool loop after three executions and leaves a durable reminder", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Repeat this tool" }), resume: false })

      requests.length = 0
      executions.length = 0
      RuntimeInsight.reset()
      const repeatedTurn = (id: string) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id, name: "echo", input: { text: "same" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      responses = [
        repeatedTurn("repeat-1"),
        repeatedTurn("repeat-2"),
        repeatedTurn("repeat-3"),
        repeatedTurn("repeat-4"),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "repeat-final" }),
          LLMEvent.textDelta({ id: "repeat-final", text: "Stopped repeating" }),
          LLMEvent.textEnd({ id: "repeat-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(5)
      expect(executions).toEqual(["same", "same", "same"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Repeat this tool" },
        { type: "assistant", content: [{ type: "tool", id: "repeat-1", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "repeat-2", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "repeat-3", state: { status: "completed" } }] },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "repeat-4",
              state: {
                status: "error",
                error: { message: expect.stringContaining("Repeat guard blocked echo") },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Stopped repeating" }] },
      ])
      expect(RuntimeInsight.auditList().entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "tool.repeat-guard.blocked",
            resource: "tool:echo",
            metadata: expect.objectContaining({
              repeatCount: 4,
              maxRepeats: 3,
              inputDigest: expect.any(String),
            }),
          }),
        ]),
      )
    }),
  )

  for (const typed of [false, true]) {
    it.effect(
      `blocks an unchanged failed tool before its second execution and persists actionable feedback (typed=${typed})`,
      () =>
        Effect.gen(function* () {
          yield* setup
          const session = yield* SessionV2.Service
          yield* session.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Do not repeat failed work" }),
            resume: false,
          })
          requests.length = 0
          defectExecutions = 0
          RuntimeInsight.reset()
          const call = (id: string) => [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id, name: "defect", input: { typed } }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]
          responses = [
            call("failed-1"),
            call("failed-2"),
            [
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "failed-final" }),
              LLMEvent.textDelta({ id: "failed-final", text: "Inspecting the failure instead" }),
              LLMEvent.textEnd({ id: "failed-final" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop" }),
              LLMEvent.finish({ reason: "stop" }),
            ],
          ]
          yield* session.resume(sessionID)
          expect(defectExecutions).toBe(1)
          expect(requests).toHaveLength(3)
          expect(JSON.stringify(requests[2])).toContain("previous execution failed")
          expect(yield* session.context(sessionID)).toMatchObject([
            { type: "user" },
            { type: "assistant", content: [{ type: "tool", id: "failed-1", state: { status: "error" } }] },
            {
              type: "assistant",
              content: [
                {
                  type: "tool",
                  id: "failed-2",
                  state: {
                    status: "error",
                    error: { message: expect.stringContaining("previous execution failed") },
                  },
                },
              ],
            },
            { type: "assistant", finish: "stop" },
          ])
          expect(RuntimeInsight.auditList().entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                action: "tool.repeat-guard.blocked",
                metadata: expect.objectContaining({
                  blockReason: "previous-failure",
                  repeatCount: 2,
                }),
              }),
            ]),
          )
        }),
    )
  }

  it.effect("returns unexpected local tool defects to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call defect" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-defect" }),
          LLMEvent.textDelta({ id: "text-after-defect", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-defect" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns policy-blocked tools to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        blocked: Tool.make({
          description: "Fail because policy blocked execution",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.BlockedError({ rules: [] })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Permission blocked" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call blocked" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-blocked", name: "blocked", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call blocked" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-blocked", state: { status: "error", error: { message: "Permission blocked" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when permission approval is declined", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        declined: Tool.make({
          description: "Fail because the user declined approval",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new PermissionV2.DeclinedError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call declined" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("returns permission corrections to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        corrected: Tool.make({
          description: "Fail with user correction feedback",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another tool" })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Use another tool" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call corrected" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-corrected", name: "corrected", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call corrected" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-corrected", state: { status: "error", error: { message: "Use another tool" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when a question is dismissed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      yield* (yield* Tools.BuiltIns).register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "question", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      yield* questions.reject(pending[0]!.id)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("awaits started local tools before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Settle before failing" }), resume: false })
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const durableRuns = yield* DurableRun.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt blocked tool" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = []
      yield* session.resume(sessionID)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(requests[0]?.messages.at(-1)).toMatchObject({
        role: "tool",
        content: [
          {
            type: "tool-result",
            result: { type: "error", value: "Tool execution interrupted" },
          },
        ],
      })
      expect((yield* durableRuns.list({ sessionID }))[0]?.run.status).toBe("failed")
    }),
  )

  it.effect("interrupts a blocked provider turn without local tool execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt provider" }), resume: false })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("resumes from the semantic checkpoint without replaying the completed provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const durableRuns = yield* DurableRun.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Resume a durable tool turn" }), resume: false })

      requests.length = 0
      executions.length = 0
      const firstTurn = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "checkpoint-echo", name: "echo", input: { text: "checkpoint" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const finalTurn = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      // Pause after the continuation request is durably prepared but before
      // dispatch. An already dispatched silent request is tested separately
      // and must not be treated as proven unsent.
      responseStream = Stream.fromIterable(firstTurn)
      responses = [finalTurn]
      const original = durableRuns.checkpoint
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Object.assign(durableRuns, { checkpoint: original })
        }),
      )
      const checkpoint: DurableRun.Interface["checkpoint"] = (input) =>
        Effect.gen(function* () {
          const saved = yield* original(input)
          const cursor = SessionCheckpoint.fromContainer(saved.state, sessionID)
          if (
            cursor &&
            !cursor.legacy &&
            cursor.kind === SessionCheckpoint.KIND &&
            cursor.dispatch?.turnStep === 2 &&
            cursor.dispatch.phase === "prepared"
          )
            return yield* Effect.interrupt
          return saved
        })
      Object.assign(durableRuns, { checkpoint })
      expect((yield* session.resume(sessionID).pipe(Effect.exit))._tag).toBe("Failure")
      Object.assign(durableRuns, { checkpoint: original })
      const recoverable = (yield* durableRuns.list({ sessionID }))[0]
      expect(recoverable?.checkpoint?.state).toMatchObject({
        version: 1,
        kind: "session-agent-loop",
        nextStep: 2,
        nextPromotion: "steer",
        needsContinuation: true,
        lastTurn: { turnStep: 1, requestDigest: expect.any(String) },
        dispatch: { turnStep: 2, phase: "prepared" },
      })
      expect(requests).toHaveLength(1)
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(executions).toEqual(["checkpoint"])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      const { db } = yield* Database.Service
      const envelopeRows = (yield* db.select().from(EventTable).all()).filter(
        (row) => row.type === EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1),
      )
      expect(envelopeRows.map((row) => (row.data as { turnStep: number }).turnStep)).toEqual([1, 2])
    }),
  )

  it.effect("blocks a running goal when the session settles without an explicit goal update", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* GoalV2.Service
      const created = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Finish the task") })
      const promptID = SessionMessage.ID.create()
      yield* goals.start({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        promptID,
      })
      yield* session.prompt({
        sessionID,
        id: promptID,
        prompt: Prompt.make({ text: created.objective }),
        resume: false,
      })
      response = fragmentFixture("text", "goal-without-update", ["I stopped early"]).completeEvents

      yield* session.resume(sessionID)

      expect(yield* goals.get({ sessionID, goalID: created.id })).toMatchObject({
        status: "blocked",
        lastError: "Session settled without explicitly completing or blocking the active goal",
      })
      expect(JSON.stringify(yield* session.context(sessionID))).not.toContain("I stopped early")
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const durableRuns = yield* DurableRun.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt tool settlement" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const runner = yield* SessionRunner.Service
      const run = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      const paused = (yield* durableRuns.list({ sessionID }))[0]
      expect(paused?.run.status).toBe("paused")
      expect(paused?.checkpoint?.state).toMatchObject({
        version: 1,
        kind: "session-agent-loop",
        phase: "continuation",
        nextStep: 2,
        nextPromotion: "steer",
        needsContinuation: true,
        lastTurn: { turnStep: 1, requestDigest: expect.any(String) },
      })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("forces a text response on an agent's configured final step", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish at the limit" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-terminal", name: "echo", input: { text: "done" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-forbidden", name: "echo", input: { text: "forbidden" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("resets the configured step allowance when steering input promotes", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start work" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-steer", name: "echo", input: { text: "before" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-after-steer", name: "echo", input: { text: "after" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools).not.toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail durably" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail before step" }), resume: false })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail after output" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail raw stream durably" }), resume: false })
      const failure = providerUnavailable()
      responseStream = Stream.fail(failure)

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not continue automatically after a provider error follows a local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not continue failed provider" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["settled"])
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool durably" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool at EOF" }), resume: false })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-eof",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
      ]

      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        { type: "assistant", content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Two blocks" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    // Durable fragment closure can contend with the full Core matrix on
    // Windows (SQLite/process fixtures occasionally exceed Bun's 5s default).
    // Keep a bounded per-test deadline so a real hang still fails closed while
    // avoiding a false negative caused by suite-wide scheduler pressure.
    it.effect(
      `durably closes partial ${kind} when the provider stream fails`,
      () => verifyPartialFlushOnFailure(kind),
      { timeout: 15_000 },
    )

    it.effect(
      `durably closes partial ${kind} when the provider stream is interrupted`,
      () => verifyPartialFlushOnInterruption(kind),
      { timeout: 15_000 },
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call provider tool" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({ id: "call-parsed", name: "web_search", input: { query: "hello" }, providerExecuted: true }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Tool input delta before start: call-1",
      )
    }),
  )
})
