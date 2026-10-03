import { HttpRecorder } from "@arforge-ai/http-recorder"
import { HttpRecorderInternal } from "@arforge-ai/http-recorder/internal"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@arforge-ai/llm/route"
import { Database } from "@arforge-ai/core/database/database"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@arforge-ai/core/effect/app-node-platform"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Config } from "@arforge-ai/core/config"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { Snapshot } from "@arforge-ai/core/snapshot"
import { Prompt } from "@arforge-ai/core/session/prompt"
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
import { parseRequestEnvelopeJson, rebuildRequest } from "@arforge-ai/core/session/request-envelope"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import * as SessionCheckpoint from "@arforge-ai/core/session/checkpoint"
import * as SessionRunnerEvidence from "@arforge-ai/core/session/runner/evidence"
import * as SessionRunnerHistory from "@arforge-ai/core/session/runner/history"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import * as DurableRun from "@arforge-ai/core/runtime/durable-run"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionStore } from "@arforge-ai/core/session/store"
import { Location } from "@arforge-ai/core/location"
import { SystemContextRegistry } from "@arforge-ai/core/system-context/registry"
import { SystemContext } from "@arforge-ai/core/system-context"
import { SkillGuidance } from "@arforge-ai/core/skill/guidance"
import { ReferenceGuidance } from "@arforge-ai/core/reference/guidance"
import { EvolutionV2 } from "@arforge-ai/core/evolution"
import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "node:path"
import { testEffect } from "./lib/effect"

const cassette =
  process.env.RECORD === "true"
    ? HttpRecorderInternal.cassetteLayer("session-runner/openai-chat-streams-text", {
        directory: path.resolve(import.meta.dir, "fixtures/recordings"),
        mode: "record",
      })
    : HttpRecorder.http("session-runner/openai-chat-streams-text", {
        directory: path.resolve(import.meta.dir, "fixtures/recordings"),
      })
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini" })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
  route: () => Effect.succeed(undefined),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const recordedProjectDirectory = AbsolutePath.make(import.meta.dir)
const evolution = Layer.mock(EvolutionV2.Service, {
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
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: recordedProjectDirectory })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [EvolutionV2.node, evolution],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
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
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      DurableRun.node,
      ToolRegistry.node,
      RuntimeInvariants.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      EvolutionV2.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: recordedProjectDirectory })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [EvolutionV2.node, evolution],
      [Config.node, config],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_recorded")

describe("SessionRunnerLLM recorded", () => {
  it.effect("executes one recorded V2 prompt through the recorded HTTP transport", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const eventOwner = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: recordedProjectDirectory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: recordedProjectDirectory,
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const prompt = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Say hello in one short sentence." }),
        resume: false,
      })

      const settlements: SessionRunnerHistory.TerminalHistorySummary[] = []
      const committedRows: Array<ReadonlyArray<EventV2.SerializedEvent>> = []
      yield* session.resumeWithCredentials({
        sessionID,
        credentialIDs: [],
        onSettled: (summary) => Effect.sync(() => void settlements.push(summary)),
        settlementCollector: ({ query, source }) =>
          source.collect(query).pipe(
            Effect.tap((rows) => Effect.sync(() => void committedRows.push(rows))),
            Effect.andThen(Effect.fail("collector regression")),
          ),
      })
      expect(settlements).toHaveLength(1)
      expect(committedRows).toHaveLength(1)
      expect(committedRows[0]?.some((row) => row.type === SessionRunnerHistory.runnerHistoryTypes.runCreated)).toBe(
        true,
      )
      expect(committedRows[0]?.every((row) => row.id.startsWith("evt_"))).toBe(true)
      expect(settlements[0]).toMatchObject({
        sessionID,
        status: "completed",
        attempt: 1,
        checkpointPresent: true,
      })
      expect(settlements[0]?.transition).not.toHaveProperty("reason")

      const durableRuns = yield* DurableRun.Service
      const createdRuns = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.RunCreated.type, 1)))
        .orderBy(asc(EventTable.id))
        .all()
      const createdRun = createdRuns.findLast(
        (row) => (row.data as { readonly sessionID?: string }).sessionID === sessionID,
      )
      const runID = (createdRun?.data as { readonly runID?: string } | undefined)?.runID
      expect(runID).toBeDefined()
      const durableSnapshot = yield* durableRuns.load(AgentRuntime.RunID.make(runID!))
      expect(durableSnapshot.checkpoint).toBeDefined()
      const semanticCheckpoint = SessionCheckpoint.decode(durableSnapshot.checkpoint!.state, sessionID)
      const evidence = SessionRunnerEvidence.fromDurable({
        checkpoint: semanticCheckpoint,
        budget: durableSnapshot.run.budget,
      })
      expect(evidence.checkpoint.phase).toBe("idle")
      expect(evidence.checkpoint.nextStep).toBe(2)
      expect(evidence.checkpoint.needsContinuation).toBe(false)
      expect(evidence.budget.attemptsUsed).toBe(1)

      const invariants = yield* RuntimeInvariants.Service
      expect(invariants.list("session-runner").map((item) => item.key)).toEqual([
        "execution-input",
        "checkpoint-cursor",
        "mature-checkpoint",
        "request-projection",
        "terminal",
      ])

      const messages = yield* session.context(sessionID)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ id: prompt.id, type: "user", text: "Say hello in one short sentence." })
      expect(messages[1]).toMatchObject({ type: "assistant", agent: "build", finish: "stop" })
      expect(messages[1]?.type === "assistant" ? messages[1].content : []).toMatchObject([
        { type: "text", text: "Hello!" },
      ])
      const parity = fromCoreParity(messages, { terminalStatus: "completed", requestCount: 1 })
      const expectedParity = makeSessionParity({
        adapter: "provider-replay",
        terminalStatus: "completed",
        requestCount: 1,
        steps: [
          {
            finish: "stop",
            hasText: true,
            hasReasoning: false,
            structured: false,
            failed: false,
            tools: [],
          },
        ],
      })
      expect(compareSessionParity(expectedParity, parity).equivalent).toBe(true)
      expect(parity.traceDigest).toHaveLength(64)
      const eventRows = yield* db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(EventTable.seq)
        .all()
      expect(eventRows.map((event) => event.type)).toEqual([
        "session.next.prompt.admitted.1",
        "session.next.prompted.1",
        "session.next.memory.context.prepared.1",
        "session.next.context.fusion.prepared.1",
        "session.next.request.envelope.prepared.1",
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
      ])
      const historyRows = yield* SessionRunnerHistory.runnerEventRowSourceFromEventV2(eventOwner).collect({
        sessionID,
        runID: runID!,
      })
      expect(committedRows[0]).toEqual(historyRows)
      const history = SessionRunnerHistory.fromEventRows(historyRows, { sessionID, runID: runID! })
      expect(history.runCreated?.runID as string | undefined).toBe(runID)
      expect(history.checkpoint).toBeDefined()
      expect(history.formalRequest).toBeDefined()
      const terminalHistory = SessionRunnerHistory.assertTerminalHistory(history, {
        status: "completed",
        attempt: 1,
      })
      expect(terminalHistory).toMatchObject({ status: "completed", attempt: 1, checkpointPresent: true })
      const historyCheckpoint = SessionRunnerHistory.checkpointFromHistory(history)
      expect(historyCheckpoint).toEqual(semanticCheckpoint)
      const historyBudget = SessionRunnerHistory.budgetFromHistory(history)
      expect(historyBudget).toEqual(durableSnapshot.run.budget)
      const requestData = history.formalRequest!
      const formalEventEvidence = SessionRunnerHistory.formalEvidenceFromHistory(history)
      const persistedEnvelope = parseRequestEnvelopeJson(requestData.envelope)
      expect(persistedEnvelope.request_digest).toBe(requestData.requestDigest)
      expect(persistedEnvelope.schema_version).toBe("1.0")
      expect(persistedEnvelope.execution.turn_step).toBe(requestData.turnStep)
      expect(persistedEnvelope.execution.attempt).toBe(requestData.attempt)
      expect(persistedEnvelope.execution.attempt).toBe(1)
      expect(formalEventEvidence.request).toMatchObject({ runID, turnStep: 1, attempt: 1 })
      expect(formalEventEvidence.execution).toEqual(evidence)
      const formalProjection = SessionRunnerEvidence.fromFormalEvent(requestData, runID)
      expect(formalProjection).toMatchObject({
        runID,
        turnStep: requestData.turnStep,
        attempt: 1,
      })
      expect(SessionRunnerEvidence.compareRequestProjection(formalProjection, formalProjection)).toEqual([])
      expect(persistedEnvelope.request.generation).toEqual({ maxTokens: 20 })
      expect(rebuildRequest(persistedEnvelope, model).generation).toEqual({ maxTokens: 20 })
    }),
  )
})
