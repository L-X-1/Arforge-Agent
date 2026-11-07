import path from "node:path"
import { afterAll, expect, spyOn } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { LLM } from "@arforge-ai/llm"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionTable, SessionMessageTable, SessionInputTable } from "@arforge-ai/core/session/sql"
import { Prompt } from "@arforge-ai/core/session/prompt"
import { PromptSystem } from "@arforge-ai/core/session/prompt-system"
import { createRequestEnvelope, requestEnvelopeJson } from "@arforge-ai/core/session/request-envelope"
import * as Producer from "@arforge-ai/core/memory-run-evidence"
import { extractCandidates } from "@arforge-ai/core/memory-extraction"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import * as WriteTool from "@arforge-ai/core/tool/write"
import { ReadToolFileSystem } from "@arforge-ai/core/tool/read-filesystem"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const workspace = await tmpdir()
afterAll(() => workspace[Symbol.asyncDispose]())
const directory = AbsolutePath.make(path.resolve(workspace.path))
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory, project: { id: Project.ID.global, directory } }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      DurableRun.globalNode,
      DurableAction.globalNode,
      Producer.node,
      ToolRegistry.node,
      WriteTool.node,
      ReadToolFileSystem.node,
      FSUtil.node,
      Location.node,
    ]),
    [
      [Location.node, current],
      [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)
const remember = "Please remember that schema changes require migration tests."
const ordinary = "Summarize this ordinary file."
const model = OpenAIChat.route.model({ id: "owned-pure-envelope-fixture" })
const budget = AgentRuntime.Budget.make({
  maxAttempts: 3,
  maxDurationMs: 60_000,
  maxCostMicros: 100_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})
let serial = 0
// Performance/projection fixture only: canonical real Run and built-in write,
// seeded historical request rows. No server/model/network/GUI process.
const seed = (text: string, options: { decoys?: number; write?: boolean; mixed?: boolean } = {}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service,
      runs = yield* DurableRun.Service
    const sessionID = SessionSchema.ID.make("ses_memory_scope47_" + ++serial)
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        directory,
        slug: "owned",
        title: "Owned scope fixture",
        version: "test",
      })
      .run()
    const created = yield* runs.create({
      sessionID,
      project: Project.ID.global,
      location: directory,
      initiator: "user",
      authority: "automatic",
      riskTier: "L0",
      reasonSummary: "Owned projection fixture",
      budget,
      traceID: "trace_owned_scope47",
      visibility: "details",
    })
    const runID = created.run.id
    for (const to of ["preflight", "queued", "running"] as const)
      yield* runs.transition({ runID, to, reason: "owned fixture" })
    yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 10_000 }).onConflictDoNothing().run()
    const addUser = (id: string, text: string, seq: number, admitted: number) =>
      Effect.gen(function* () {
        const messageID = SessionMessage.ID.make(id),
          prompt = Prompt.make({ text })
        const user = Schema.decodeUnknownSync(SessionMessage.Message)({
          id: messageID,
          type: "user",
          text,
          time: { created: 0 },
        })
        yield* db
          .insert(SessionMessageTable)
          .values({
            id: messageID,
            session_id: sessionID,
            type: "user",
            seq,
            data: Schema.encodeSync(SessionMessage.Message)(user),
          })
          .run()
        // Deliberately unrelated numeric promoted/admitted/message sequences.
        yield* db
          .insert(SessionInputTable)
          .values({
            id: messageID,
            session_id: sessionID,
            prompt,
            delivery: "steer",
            admitted_seq: admitted,
            promoted_seq: 90_000 + admitted,
            time_created: 0,
          })
          .run()
        return { messageID, prompt }
      })
    for (let i = 0; i < (options.decoys ?? 0); i++) {
      yield* addUser("msg_decoy_" + serial + "_" + i, remember, i * 10, 1_000 + i)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_decoy_" + serial + "_" + i),
          aggregate_id: sessionID,
          seq: i * 10 + 1,
          type: EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1),
          data: { runID: "run_other_" + i, envelope: "retained foreign envelope " + "x".repeat(16_384) },
        })
        .run()
    }
    const user = yield* addUser("msg_current_" + serial, text, 2_000, 2_000)
    const addRequest = (prompt: Prompt, seq: number, step: number) =>
      Effect.gen(function* () {
        const envelope = createRequestEnvelope({
          request: LLM.request({ model, messages: [] }),
          execution: { run_id: runID, turn_step: step, attempt: 1, prompt_digest: PromptSystem.promptDigest(prompt) },
        })
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.make("evt_current_" + serial + "_" + seq),
            aggregate_id: sessionID,
            seq,
            type: EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1),
            data: {
              sessionID,
              timestamp: 0,
              runID,
              turnStep: step,
              attempt: 1,
              schemaVersion: "1.0",
              requestDigest: envelope.request_digest,
              envelope: requestEnvelopeJson(envelope),
            },
          })
          .run()
      })
    yield* addRequest(user.prompt, 2_010, 1)
    let writeUser = user
    if (options.mixed) {
      writeUser = yield* addUser("msg_plain_" + serial, ordinary, 2_020, 2_001)
      yield* addRequest(writeUser.prompt, 2_030, 2)
    }
    if (options.write) {
      const registry = yield* ToolRegistry.Service,
        materialized = yield* registry.materialize([], sessionID)
      const assistantMessageID = SessionMessage.ID.make("msg_write_" + serial),
        callID = "owned_write_scope47"
      const input = { path: "untouched-" + serial + ".txt", content: "owned sealed bytes" }
      const result = yield* materialized.settle({
        runID,
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID,
        call: { type: "tool-call", id: callID, name: "write", input },
      })
      expect(result.result.type).not.toBe("error")
      const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({
        id: assistantMessageID,
        type: "assistant",
        agent: "build",
        model: { id: "owned", providerID: "owned" },
        time: { created: 0 },
        content: [
          {
            type: "tool",
            id: callID,
            name: "write",
            time: { created: 0, completed: 1 },
            state: {
              status: "completed",
              input,
              structured: result.output!.structured,
              content: result.output!.content,
            },
          },
        ],
      })
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: assistantMessageID,
          session_id: sessionID,
          type: "assistant",
          seq: 2_040,
          data: Schema.encodeSync(SessionMessage.Assistant)(assistant),
        })
        .run()
    }
    // A later/future user with the same text must not be selected for an earlier request.
    yield* addUser("msg_future_" + serial, remember, 3_000, 3_000)
    yield* runs.transition({ runID, to: "completed", reason: "owned terminal fixture" })
    expect((yield* runs.load(runID)).run.status).toBe("completed")
    return { db, runID, sessionID, messageID: user.messageID, addUser, addRequest }
  })

it.effect("only current Run envelopes and nearest owned user/input rows are materialized from long history", () =>
  Effect.gen(function* () {
    const { runID, messageID } = yield* seed(remember, { decoys: 96 })
    let envelopeRows = 0,
      inputRows = 0,
      userRows = 0
    const eventDecode = EventTable.data.mapFromDriverValue.bind(EventTable.data)
    const inputDecode = SessionInputTable.prompt.mapFromDriverValue.bind(SessionInputTable.prompt)
    const idDecode = SessionMessageTable.id.mapFromDriverValue.bind(SessionMessageTable.id)
    const e = spyOn(EventTable.data, "mapFromDriverValue").mockImplementation((value) => {
      const decoded = eventDecode(value)
      if (decoded && typeof decoded === "object" && "envelope" in decoded) envelopeRows++
      return decoded
    })
    const p = spyOn(SessionInputTable.prompt, "mapFromDriverValue").mockImplementation((value) => {
      inputRows++
      return inputDecode(value)
    })
    const u = spyOn(SessionMessageTable.id, "mapFromDriverValue").mockImplementation((value) => {
      userRows++
      return idDecode(value)
    })
    yield* Effect.gen(function* () {
      const facts = yield* (yield* Producer.Service).collect(runID)
      expect(facts?.prompts.map((value) => value.messageID)).toEqual([messageID])
      expect({ envelopeRows, inputRows, userRows }).toEqual({ envelopeRows: 1, inputRows: 1, userRows: 1 })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          e.mockRestore()
          p.mockRestore()
          u.mockRestore()
        }),
      ),
    )
  }),
)

for (const mixed of [false, true])
  it.effect(
    "no unrelated write verification IO when " +
      (mixed ? "another prompt has a memory signal" : "the Run has no memory candidates"),
    () =>
      Effect.gen(function* () {
        const { runID, messageID } = yield* seed(mixed ? remember : ordinary, { write: true, mixed })
        const actions = yield* DurableAction.Service,
          reader = yield* ReadToolFileSystem.Service,
          filesystem = yield* FSUtil.Service
        const originalList = actions.list,
          originalRead = reader.read,
          originalStat = filesystem.stat
        let listCalls = 0,
          readCalls = 0,
          statCalls = 0
        const a = spyOn(actions, "list").mockImplementation((input) => {
          listCalls++
          return originalList(input)
        })
        const r = spyOn(reader, "read").mockImplementation((...args) => {
          readCalls++
          return originalRead(...args)
        })
        const s = spyOn(filesystem, "stat").mockImplementation((...args) => {
          statCalls++
          return originalStat(...args)
        })
        yield* Effect.gen(function* () {
          const facts = yield* (yield* Producer.Service).collect(runID)
          expect(listCalls).toBe(mixed ? 1 : 0)
          expect(readCalls).toBe(0)
          expect(statCalls).toBe(0)
          if (mixed) {
            expect(facts?.prompts.map((value) => value.messageID)).toEqual([messageID])
            expect(facts?.evidence).toHaveLength(0)
          } else expect(facts).toBeUndefined()
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              a.mockRestore()
              r.mockRestore()
              s.mockRestore()
            }),
          ),
        )
      }),
  )

it.effect("needed candidate keeps real built-in write sealed input and guarded independent reread", () =>
  Effect.gen(function* () {
    const { runID, messageID } = yield* seed(remember, { write: true })
    const reader = yield* ReadToolFileSystem.Service,
      original = reader.read
    let reads = 0
    const r = spyOn(reader, "read").mockImplementation((...args) => {
      reads++
      return original(...args)
    })
    yield* Effect.gen(function* () {
      const facts = yield* (yield* Producer.Service).collect(runID)
      expect(facts?.prompts[0].messageID).toBe(messageID)
      expect(facts?.evidence).toHaveLength(1)
      expect(facts?.evidence[0].verificationStatus).toBe("verified")
      expect(reads).toBe(1)
    }).pipe(Effect.ensuring(Effect.sync(() => r.mockRestore())))
  }),
)

it.effect("matching current Run still requires the exact owned promoted input digest", () =>
  Effect.gen(function* () {
    const { db, runID, messageID } = yield* seed(remember)
    yield* db
      .update(SessionInputTable)
      .set({ prompt: Prompt.make({ text: remember + " altered" }) })
      .where(eq(SessionInputTable.id, messageID))
      .run()
    expect(yield* (yield* Producer.Service).collect(runID)).toBeUndefined()
    yield* db
      .update(SessionInputTable)
      .set({ prompt: Prompt.make({ text: remember }), promoted_seq: null })
      .where(eq(SessionInputTable.id, messageID))
      .run()
    expect(yield* (yield* Producer.Service).collect(runID)).toBeUndefined()
  }),
)

for (const source of ["request", "input", "user"] as const)
  for (const foreign of [{ tenant_id: "ten_other" }, { owner_user_id: "usr_other" }])
    it.effect(`foreign ${Object.keys(foreign)[0]} on the ${source} cannot supply a current Run candidate`, () =>
      Effect.gen(function* () {
        const { db, runID, messageID, sessionID } = yield* seed(remember)
        if (source === "request")
          yield* db.update(EventTable).set(foreign).where(eq(EventTable.aggregate_id, sessionID)).run()
        if (source === "input")
          yield* db.update(SessionInputTable).set(foreign).where(eq(SessionInputTable.id, messageID)).run()
        if (source === "user")
          yield* db.update(SessionMessageTable).set(foreign).where(eq(SessionMessageTable.id, messageID)).run()
        expect(yield* (yield* Producer.Service).collect(runID)).toBeUndefined()
      }),
    )

it.effect("multiple current Run envelopes deduplicate a prompt and retain admission order across different users", () =>
  Effect.gen(function* () {
    const { runID, messageID, addUser, addRequest } = yield* seed(remember)
    yield* addRequest(Prompt.make({ text: remember }), 2_011, 2)
    const second = yield* addUser("msg_second_" + serial, "I prefer narrow changes.", 2_020, 1_500)
    yield* addRequest(second.prompt, 2_030, 3)
    const facts = yield* (yield* Producer.Service).collect(runID)
    expect(facts?.prompts.map((value) => value.messageID)).toEqual([second.messageID, messageID])
  }),
)

it.effect("shared extractor retains manual, transient, preference and identity semantics", () =>
  Effect.sync(() => {
    expect(extractCandidates("ordinary text")).toEqual([])
    expect(extractCandidates("For now, always skip tests.")).toEqual([])
    expect(extractCandidates(remember)[0].content).toBe("schema changes require migration tests.")
    expect(extractCandidates("I strongly prefer small changes.")[0].type).toBe("preference")
    expect(extractCandidates("Call me Owned.")[0].type).toBe("identity")
  }),
)
