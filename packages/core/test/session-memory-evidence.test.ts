import { createServer } from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { afterAll, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import { LLMClient, RequestExecutor } from "@arforge-ai/llm/route"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@arforge-ai/core/effect/app-node-platform"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Config } from "@arforge-ai/core/config"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { Snapshot } from "@arforge-ai/core/snapshot"
import { Prompt } from "@arforge-ai/core/session/prompt"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"
import { SessionRunner } from "@arforge-ai/core/session/runner"
import * as SessionRunnerLLM from "@arforge-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import * as DurableRun from "@arforge-ai/core/runtime/durable-run"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import * as WriteTool from "@arforge-ai/core/tool/write"
import { SessionTable, SessionInputTable, SessionMessageTable } from "@arforge-ai/core/session/sql"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionStore } from "@arforge-ai/core/session/store"
import { Location } from "@arforge-ai/core/location"
import { SystemContextRegistry } from "@arforge-ai/core/system-context/registry"
import { SystemContext } from "@arforge-ai/core/system-context"
import { SkillGuidance } from "@arforge-ai/core/skill/guidance"
import { ReferenceGuidance } from "@arforge-ai/core/reference/guidance"
import { EvolutionV2 } from "@arforge-ai/core/evolution"
import {
  MemoryCandidateTable,
  MemoryTable,
  MemoryRevisionTable,
  MemoryCandidateAuditTable,
} from "@arforge-ai/core/memory/sql"
import { ExperienceEvidenceTable } from "@arforge-ai/core/experience-store/sql"
import { ExperienceStoreV1 } from "@arforge-ai/core/experience-store"
import { MemoryV2 } from "@arforge-ai/core/memory"
import * as MemoryKernel from "@arforge-ai/core/memory-kernel"
import * as MemoryRunEvidence from "@arforge-ai/core/memory-run-evidence"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make(path.resolve(import.meta.dir, "../../../.tmp/u08-memory46/owned-project"))
await fs.mkdir(directory, { recursive: true })
let activeModel = OpenAIChat.route.model({ id: "owned-memory-model" })
let wireCount = 0
const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const models = SessionRunnerModel.layerWith(() => Effect.succeed(activeModel))
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
  route: () => Effect.succeed(undefined),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const recordedProjectDirectory = directory
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
      WriteTool.node,
      MemoryV2.node,
      ExperienceStoreV1.node,
      MemoryKernel.node,
      DurableAction.globalNode,
      MemoryRunEvidence.node,
      Location.node,
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

// The server speaks real OpenAI SSE through the installed transport. No paid endpoint.
const text =
  "Please remember that all schema changes require migration tests. Write owned.txt with exactly verified memory fixture."
type Scenario = "write" | "plain" | "failed" | "drift" | "external"
let scenario: Scenario = "write"
let liveListeners = 0
const externalPath = path.resolve(directory, "../owned-external.txt")
const listen = Effect.acquireRelease(
  Effect.promise(async () => {
    wireCount = 0
    await fs.mkdir(directory, { recursive: true })
    await fs.rm(path.join(directory, "owned.txt"), { force: true })
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* consume only this test's request */
      }
      wireCount++
      if (scenario === "failed" && wireCount === 2) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({ error: { message: "Owned fixture rejects continuation", type: "invalid_request_error" } }),
        )
        return
      }
      if (scenario === "drift" && wireCount === 2)
        await fs.writeFile(path.join(directory, "owned.txt"), "unrelated later bytes")
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const call = scenario !== "plain" && wireCount % 2 === 1
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: "owned_write_" + wireCount,
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    path: scenario === "external" ? externalPath : "owned.txt",
                    content: "verified memory fixture",
                  }),
                },
              },
            ],
          }
        : { content: "The owned request is complete." }
      res.end(
        "data: " +
          JSON.stringify({
            id: "owned",
            object: "chat.completion.chunk",
            created: 1,
            model: "owned-memory-model",
            choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      )
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    liveListeners++
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Owned listener has no TCP address")
    activeModel = OpenAIChat.route
      .with({ endpoint: { baseURL: `http://127.0.0.1:${address.port}/v1` } })
      .model({ id: "owned-memory-model" })
    return server
  }),
  (server) =>
    Effect.promise(
      () =>
        new Promise<void>((done, reject) =>
          server.close((error) => {
            liveListeners--
            error ? reject(error) : done()
          }),
        ),
    ),
)
afterAll(() => expect(liveListeners).toBe(0))
let serial = 0
const runSession = (kind: Scenario = "write") =>
  Effect.gen(function* () {
    scenario = kind
    yield* listen
    const { db } = yield* Database.Service
    const ownedLocation = yield* Location.Service
    const sessionID = SessionV2.ID.make("ses_u08_real_memory_" + ++serial)
    yield* db
      .insert(ProjectTable)
      .values({ id: ownedLocation.project.id, worktree: ownedLocation.project.directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ownedLocation.project.id,
        slug: "owned",
        directory,
        title: "Owned memory",
        version: "test",
      })
      .run()
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text }), resume: false })
    yield* session.resumeWithCredentials({ sessionID, credentialIDs: [] }).pipe(Effect.exit)
    const rows = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.RunCreated.type, 1)))
      .all()
    const row = rows.find((value) => value.data.sessionID === sessionID)
    const runID = AgentRuntime.RunID.make(String(row?.data.runID))
    const run = yield* (yield* DurableRun.Service).load(runID)
    return { db, runID, run, sessionID }
  })

it.live(
  "U08 real Session + owned write + loopback -> canonical Evidence, one review-only candidate, replay preserves manual revision",
  () =>
    Effect.gen(function* () {
      const { db, runID, run, sessionID } = yield* runSession()
      expect(wireCount).toBe(2)
      expect(run.run.status).toBe("completed") // Reduced snapshot, never the RunCreated payload.
      expect("location" in run.run && run.run.location).toBe(directory)
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "owned.txt"), "utf8"))).toBe(
        "verified memory fixture",
      )
      const candidates = yield* db.select().from(MemoryCandidateTable).all()
      expect(candidates).toHaveLength(1)
      expect(candidates[0].status).toBe("proposed")
      expect(candidates[0].source_evidence_ids.length).toBeGreaterThan(0)
      expect(candidates[0].run_id).toBe(runID)
      const evidence = yield* db.select().from(ExperienceEvidenceTable).all()
      expect(evidence).toHaveLength(1)
      const sourceEvidenceIDs = candidates[0].source_evidence_ids.map((id) => AgentRuntime.EvidenceID.make(id))
      const sources = yield* (yield* ExperienceStoreV1.Service).resolveEvidenceIDs(
        { ...Database.DefaultLocalPrincipal, actor: "owned-memory-review" },
        sourceEvidenceIDs,
      )
      expect(sources.present).toEqual(sourceEvidenceIDs)
      expect(sources.missing).toEqual([])
      expect(evidence[0].run_id).toBe(runID)
      expect(evidence[0].record).toMatchObject({
        verificationStatus: "verified",
        trust: "verified",
        instructionAllowed: false,
        runID,
      })
      expect(Schema.decodeUnknownSync(AgentRuntime.Evidence)(evidence[0].record).summary).toContain(
        "does not verify the semantic truth",
      )
      const action = yield* (yield* DurableAction.Service).load(evidence[0].action_id)
      expect(action.observation?.id).toBe(evidence[0].observation_id)
      expect(action.action.subject).toMatchObject({ sessionID })
      expect(yield* db.select().from(MemoryTable).all()).toHaveLength(0)
      const memory = yield* MemoryV2.Service
      yield* Effect.all([memory.extractRun(runID), memory.extractRun(runID)], { concurrency: 2 })
      const refreshedLogin = {
        ...Database.DefaultLocalPrincipal,
        loginSessionID: "owned-second-login",
        email: "owned@example.invalid",
        role: "owned-test-role",
      }
      yield* Database.principalContext(refreshedLogin, memory.extractRun(runID))
      expect(yield* db.select().from(MemoryCandidateTable).all()).toHaveLength(1)
      expect(yield* db.select().from(ExperienceEvidenceTable).all()).toHaveLength(1)
      const kernel = yield* MemoryKernel.Service
      const review = yield* kernel.reviewCandidate(candidates[0].id)
      const approved = yield* kernel.approve({
        candidateID: candidates[0].id,
        actor: { kind: "user" },
        policyVersion: "memory-v1",
        expectedUpdatedAt: DateTime.toEpochMillis(review.candidate.time.updated),
        reason: "Owned manual review",
      })
      yield* memory.extractRun(runID)
      expect((yield* kernel.reviewCandidate(candidates[0].id)).candidate).toEqual(approved)
      const active = yield* kernel.promote({
        candidateID: candidates[0].id,
        actor: { kind: "user" },
        policyVersion: "memory-v1",
        evidenceIDs: [],
      })
      const corrected = yield* kernel.correctActive({
        memoryID: active.id,
        content: MemoryV2.Content.make("User corrected the retained constraint."),
        reason: MemoryV2.CorrectionReason.make("Owned manual correction"),
        expectedUpdatedAt: DateTime.toEpochMillis(active.time.updated),
        actor: { kind: "user" },
        policyVersion: "memory-v1",
        evidenceIDs: [],
      })
      expect(corrected.successor.content).toBe("User corrected the retained constraint.")
      yield* Effect.promise(() => fs.unlink(path.join(directory, "owned.txt")))
      yield* memory.extractRun(runID)
      const current = yield* kernel.read(corrected.successor.id)
      expect(current).toMatchObject({ content: "User corrected the retained constraint.", version: 1 })
      expect(yield* kernel.read(active.id)).toMatchObject({ lifecycle: "superseded", version: 2 })
      expect(yield* db.select().from(MemoryCandidateTable).all()).toHaveLength(1)
      expect(yield* db.select().from(ExperienceEvidenceTable).all()).toHaveLength(1)
      expect(yield* db.select().from(MemoryRevisionTable).all()).toHaveLength(3)
      expect(yield* db.select().from(MemoryCandidateAuditTable).all()).toHaveLength(3)
    }),
  30_000,
)

for (const kind of ["plain", "failed", "drift", "external"] as const)
  it.live(
    "U08 " + kind + ": no verified promotion; ordinary remember candidate remains available",
    () =>
      Effect.gen(function* () {
        const { db, run } = yield* runSession(kind)
        expect(run.run.status).toBe(kind === "failed" ? "failed" : "completed")
        const candidates = yield* db.select().from(MemoryCandidateTable).all()
        expect(candidates).toHaveLength(1)
        expect(candidates[0].status).toBe("proposed")
        expect(candidates[0].source_evidence_ids).toEqual([])
        expect(yield* db.select().from(ExperienceEvidenceTable).all()).toHaveLength(0)
        expect(yield* db.select().from(MemoryTable).all()).toHaveLength(0)
      }),
    30_000,
  )

it.live(
  "U08 tenant/owner/location/source/input binding negatives use the real completed Session receipts",
  () =>
    Effect.gen(function* () {
      const { db, runID, sessionID } = yield* runSession()
      const producer = yield* MemoryRunEvidence.Service
      const baseline = yield* producer.collect(runID)
      expect(baseline?.evidence).toHaveLength(1)
      if (!baseline) throw Error("Missing issued settlement")
      expect(Object.isFrozen(baseline)).toBe(true)
      expect(Object.isFrozen(baseline.identity)).toBe(true)
      expect(Object.isFrozen(baseline.prompts[0])).toBe(true)
      expect(Object.isFrozen(baseline.prompts[0].evidenceIDs)).toBe(true)
      expect(Object.isFrozen(baseline.evidence[0])).toBe(true)
      expect(Object.isFrozen(baseline.evidence[0].observationIDs)).toBe(true)
      expect(Reflect.set(baseline.identity, "userID", "usr_forged")).toBe(false)
      expect(Reflect.set(baseline.prompts[0].evidenceIDs, "0", "evd_forged")).toBe(false)
      expect(Reflect.set(baseline.evidence[0], "verificationStatus", "unverified")).toBe(false)
      const foreignTenant = yield* Database.principalContext(
        { tenantID: "ten_other", userID: "usr_local" },
        producer.collect(runID),
      )
      const foreignOwner = yield* Database.principalContext(
        { tenantID: "ten_local", userID: "usr_other" },
        producer.collect(runID),
      )
      expect(foreignTenant).toBeUndefined()
      expect(foreignOwner).toBeUndefined()
      yield* db
        .update(SessionTable)
        .set({ directory: path.dirname(directory) })
        .where(eq(SessionTable.id, sessionID))
        .run()
      expect(yield* producer.collect(runID)).toBeUndefined()
      yield* db.update(SessionTable).set({ directory }).where(eq(SessionTable.id, sessionID)).run()
      const source = (yield* db.select().from(SessionInputTable).all())[0]
      yield* db
        .update(SessionInputTable)
        .set({ prompt: Prompt.make({ text: "Please remember an unrelated prompt." }) })
        .where(eq(SessionInputTable.id, source.id))
        .run()
      expect(yield* producer.collect(runID)).toBeUndefined()
      yield* db
        .update(SessionInputTable)
        .set({ prompt: source.prompt })
        .where(eq(SessionInputTable.id, source.id))
        .run()
      const assistants = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.type, "assistant"))
        .all()
      const assistant = assistants.find((row) => {
        const value = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
        return value.type === "assistant" && value.content.some((part) => part.type === "tool")
      })!
      const message = Schema.decodeUnknownSync(SessionMessage.Message)({
        ...assistant.data,
        id: assistant.id,
        type: "assistant",
      })
      if (message.type !== "assistant") throw Error("Missing actual tool source")
      const content = message.content.map((part) =>
        part.type === "tool" && part.state.status === "completed"
          ? { ...part, state: { ...part.state, input: { path: "owned.txt", content: "different sealed input" } } }
          : part,
      )
      yield* db
        .update(SessionMessageTable)
        .set({ data: Schema.encodeSync(SessionMessage.Assistant)({ ...message, content }) })
        .where(eq(SessionMessageTable.id, assistant.id))
        .run()
      const mismatched = yield* producer.collect(runID)
      expect(mismatched?.evidence).toHaveLength(0) // Actual file still matches the original input; caller replacement does not.
      const memory = yield* MemoryV2.Service
      yield* memory.extractRun(runID)
      expect(yield* db.select().from(MemoryCandidateTable).all()).toHaveLength(1)
      expect(yield* db.select().from(ExperienceEvidenceTable).all()).toHaveLength(1)
    }),
  30_000,
)

it.live("U08 standalone manual Please remember remains a normal unverified candidate", () =>
  Effect.gen(function* () {
    const memory = yield* MemoryV2.Service
    const { db } = yield* Database.Service
    expect(yield* memory.extract("Please remember that tests are required.")).toEqual([])
    const candidates = yield* db.select().from(MemoryCandidateTable).all()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].source_evidence_ids).toEqual([])
    expect(candidates[0].run_id).toBeNull()
    expect(candidates[0].status).toBe("proposed")
    expect(yield* db.select().from(MemoryTable).all()).toHaveLength(0)
  }),
)

it.live(
  "U08 identical text in a later real Run stays bound to its own admitted message",
  () =>
    Effect.gen(function* () {
      const { db, runID, sessionID } = yield* runSession()
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text }), resume: false })
      yield* session.resumeWithCredentials({ sessionID, credentialIDs: [] })
      const candidates = yield* db.select().from(MemoryCandidateTable).all()
      expect(candidates).toHaveLength(2)
      expect(candidates.filter((value) => value.run_id === runID)).toHaveLength(1)
      const next = candidates.find((value) => value.run_id !== runID)!
      const facts = yield* (yield* MemoryRunEvidence.Service).collect(AgentRuntime.RunID.make(next.run_id!))
      expect(facts?.prompts).toHaveLength(1)
      expect(facts?.prompts[0].messageID).not.toBe(
        (yield* (yield* MemoryRunEvidence.Service).collect(runID))?.prompts[0].messageID,
      )
      expect(yield* db.select().from(ExperienceEvidenceTable).all()).toHaveLength(2)
    }),
  30_000,
)
