import { describe, expect } from "bun:test"
import { and, asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { ProjectV2 } from "../src/project"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionOrganization } from "../src/session/organization"
import { SessionProjector } from "../src/session/projector"
import { Prompt } from "../src/session/prompt"
import { SessionStore } from "../src/session/store"
import { SessionCheckpointTable, SessionInputTable, SessionMessageTable, SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const active = new Set<SessionV2.ID>()
const execution = Layer.effect(SessionExecution.Service, Effect.gen(function* () {
  const idle = yield* SessionExecution.Service
  return SessionExecution.Service.of({ ...idle, active: Effect.sync(() => active) })
})).pipe(Layer.provide(SessionExecution.noopLayer))
const projects = Layer.succeed(ProjectV2.Service, ProjectV2.Service.of({
  resolve: directory => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  directories: () => Effect.succeed([]), commit: () => Effect.void,
}))
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
  [[ProjectV2.node, projects], [SessionExecution.node, execution]],
))
const directory = AbsolutePath.make("/owned-nongit-regenerate")

const fixture = Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const session = yield* sessions.create({ location: { directory } })
  return { sessions, session, db: (yield* Database.Service).db }
})
const turn = (sessionID: SessionV2.ID, sequence: number, admittedSequence = sequence - 2) => Effect.gen(function* () {
  const { db } = yield* Database.Service
  const id = SessionMessage.ID.create()
  yield* db.insert(SessionInputTable).values({
    id, session_id: sessionID, admitted_seq: admittedSequence, promoted_seq: sequence,
    delivery: "steer", prompt: Prompt.make({ text: `original-${sequence}` }),
  }).run()
  yield* db.insert(SessionMessageTable).values({
    id, session_id: sessionID, type: "user", seq: sequence,
    data: Schema.encodeSync(SessionMessage.User)(SessionMessage.User.make({ id, type: "user", ...Prompt.make({ text: `original-${sequence}` }), time: { created: DateTime.makeUnsafe(1) } })),
  }).run()
  const assistantID = SessionMessage.ID.create()
  yield* db.insert(SessionMessageTable).values({
    id: assistantID, session_id: sessionID, type: "assistant", seq: sequence + 3,
    data: Schema.encodeSync(SessionMessage.Assistant)(SessionMessage.Assistant.make({ id: assistantID, type: "assistant", agent: "build", model: { id: ModelV2.ID.make("original"), providerID: ProviderV2.ID.make("owned") }, content: [], time: { created: DateTime.makeUnsafe(1) } })),
  }).run()
  return id
})
const stored = (db: Database.Interface["db"]) => Effect.gen(function* () {
  return {
    checkpoints: yield* db.select().from(SessionCheckpointTable).all(),
    messages: yield* db.select().from(SessionMessageTable).orderBy(asc(SessionMessageTable.seq)).all(),
    inputs: yield* db.select().from(SessionInputTable).orderBy(asc(SessionInputTable.admitted_seq)).all(),
  }
})

describe("conversation-only Regenerate rewind", () => {
  it.effect("a prompt enqueued at 10 and promoted at 20 retains the preceding answer at 15 and pending FIFO inputs", () => Effect.gen(function* () {
    const { sessions, session, db } = yield* fixture
    const prior = yield* turn(session.id, 5)
    yield* db.update(SessionMessageTable).set({ seq: 15 }).where(and(eq(SessionMessageTable.session_id, session.id), eq(SessionMessageTable.type, "assistant"))).run()
    const target = yield* turn(session.id, 20, 10)
    for (const sequence of [12, 13]) yield* db.insert(SessionInputTable).values({ id: SessionMessage.ID.create(), session_id: session.id, admitted_seq: sequence, delivery: "queue", prompt: Prompt.make({ text: `FIFO-${sequence}`, files: [{ uri: "file:///owned/queued.txt", name: "queued.txt", mime: "text/plain" }] }) }).run()
    const before = yield* stored(db)
    const request = { sessionID: session.id, messageID: target, expectedDirectory: directory }
    const preview = yield* sessions.rewind.preview(request)
    expect(preview.checkpoint.sequence).toBe(15)
    expect(preview.affectedMessages).toBe(2)
    expect(yield* stored(db)).toEqual(before)
    yield* sessions.rewind.apply({ ...request, expectedLastSequence: preview.expectedLastSequence, expectedRevision: preview.expectedRevision })
    const after = yield* stored(db)
    expect(after.messages.filter(row => row.time_rewound === null).map(row => row.seq)).toEqual([5, 15])
    expect(after.inputs.find(row => row.id === target)).toBeUndefined()
    expect(after.inputs.find(row => row.id === prior)).toEqual(before.inputs.find(row => row.id === prior))
    expect(after.inputs.filter(row => row.promoted_seq === null)).toEqual(before.inputs.filter(row => row.promoted_seq === null))
  }))
  for (const previous of [false, true]) it.effect(`${previous ? "later" : "first"} non-Git prompt: preview/cancel writes nothing; apply archives the exact turn`, () => Effect.gen(function* () {
    const { sessions, session, db } = yield* fixture
    const prior = previous ? yield* turn(session.id, 5) : undefined
    const target = yield* turn(session.id, 15)
    const pending = SessionMessage.ID.create()
    const pendingPrompt = Prompt.make({ text: "queued with attachment", files: [{ uri: "file:///owned/keep.txt", name: "keep.txt", mime: "text/plain" }] })
    yield* db.insert(SessionInputTable).values({ id: pending, session_id: session.id, admitted_seq: 20, delivery: "queue", prompt: pendingPrompt }).run()
    yield* db.insert(SessionInputTable).values([
      { id: SessionMessage.ID.create(), session_id: session.id, admitted_seq: 21, delivery: "queue", prompt: Prompt.make({ text: "next FIFO entry" }) },
      { id: SessionMessage.ID.create(), session_id: session.id, admitted_seq: 22, delivery: "steer", prompt: pendingPrompt },
    ]).run()
    const before = yield* stored(db)
    const request = { sessionID: session.id, messageID: target, expectedDirectory: directory }
    const preview = yield* sessions.rewind.preview(request)
    expect(preview.workspaceEffectsUnchanged).toBe(true)
    expect(preview.affectedMessages).toBe(2)
    expect(preview.expectedLastSequence).toBe(18)
    expect(preview.expectedRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(yield* stored(db)).toEqual(before)
    const result = yield* sessions.rewind.apply({ ...request, expectedLastSequence: preview.expectedLastSequence, expectedRevision: preview.expectedRevision })
    expect(result.rewoundMessages).toBe(2)
    expect(result.workspaceEffectsUnchanged).toBe(true)
    const after = yield* stored(db)
    expect(after.checkpoints).toHaveLength(1)
    expect(after.messages.filter(row => row.time_rewound === null && row.type === "user").map(row => row.id)).toEqual(prior ? [prior] : [])
    expect(after.inputs.find(row => row.id === target)).toBeUndefined()
    expect(after.inputs.find(row => row.id === pending)).toEqual(before.inputs.find(row => row.id === pending))
    expect(after.inputs.filter(row => row.promoted_seq === null)).toEqual(before.inputs.filter(row => row.promoted_seq === null))
    if (prior) expect(after.inputs.find(row => row.id === prior)).toEqual(before.inputs.find(row => row.id === prior))
  }))

  it.effect("foreign owner, wrong session message, busy and changed source fail without writing a checkpoint", () => Effect.gen(function* () {
    const { sessions, session, db } = yield* fixture
    const target = yield* turn(session.id, 15)
    const request = { sessionID: session.id, messageID: target, expectedDirectory: directory }
    const before = yield* stored(db)
    for (const principal of [{ tenantID: "ten_foreign", userID: "usr_local" }, { tenantID: "ten_local", userID: "usr_foreign" }]) {
      expect(yield* (yield* Database.Service).runAsPrincipal(principal, sessions.rewind.preview(request).pipe(Effect.result))).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.NotFoundError" } })
    }
    const other = yield* sessions.create({ location: { directory } })
    expect(yield* sessions.rewind.preview({ ...request, sessionID: other.id }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RewindMessageNotFoundError" } })
    const preview = yield* sessions.rewind.preview(request)
    active.add(session.id)
    expect(yield* sessions.rewind.preview(request).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.BusyError" } })
    const busy = yield* sessions.rewind.apply({ ...request, expectedLastSequence: preview.expectedLastSequence, expectedRevision: preview.expectedRevision }).pipe(Effect.result, Effect.ensuring(Effect.sync(() => active.delete(session.id))))
    expect(busy).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.BusyError" } })
    yield* db.update(SessionTable).set({ directory: "/moved-source" }).where(eq(SessionTable.id, session.id)).run()
    expect(yield* sessions.rewind.apply({ ...request, expectedLastSequence: preview.expectedLastSequence, expectedRevision: preview.expectedRevision }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RewindConflictError" } })
    expect(yield* stored(db)).toEqual(before)
  }))

  it.effect("a changed assistant at the same sequence invalidates the preview token and cannot partially archive", () => Effect.gen(function* () {
    const { sessions, session, db } = yield* fixture
    const target = yield* turn(session.id, 15)
    const request = { sessionID: session.id, messageID: target, expectedDirectory: directory }
    const preview = yield* sessions.rewind.preview(request)
    yield* db.update(SessionMessageTable).set({ time_updated: 9999 }).where(and(eq(SessionMessageTable.session_id, session.id), eq(SessionMessageTable.type, "assistant"))).run()
    const before = yield* stored(db)
    expect(yield* sessions.rewind.apply({ ...request, expectedLastSequence: preview.expectedLastSequence, expectedRevision: preview.expectedRevision }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RewindConflictError" } })
    expect(yield* stored(db)).toEqual(before)
  }))

  for (const change of ["directory = '/moved-inside-archive'", "owner_user_id = 'usr_changed_inside_archive'"]) it.effect(`settlement rechecks ${change.split(" =")[0]} and rolls back every archive/checkpoint write`, () => Effect.gen(function* () {
    const { sessions, session, db } = yield* fixture
    const target = yield* turn(session.id, 15)
    const request = { sessionID: session.id, messageID: target, expectedDirectory: directory }
    const preview = yield* sessions.rewind.preview(request)
    const before = yield* stored(db)
    yield* db.run(sql.raw(`CREATE TRIGGER regenerate_scope_change AFTER UPDATE OF time_rewound ON session_message WHEN NEW.time_rewound IS NOT NULL BEGIN UPDATE session SET ${change} WHERE id = NEW.session_id; END`))
    expect(yield* sessions.rewind.apply({ ...request, expectedLastSequence: preview.expectedLastSequence, expectedRevision: preview.expectedRevision }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RewindConflictError" } })
    expect(yield* stored(db)).toEqual(before)
    expect((yield* sessions.get(session.id)).location.directory).toBe(directory)
  }))

  it.effect("rejects ambiguous targets and message applies without a preview token", () => Effect.gen(function* () {
    const { sessions, session, db } = yield* fixture
    const target = yield* turn(session.id, 15)
    const request = { sessionID: session.id, messageID: target, expectedDirectory: directory }
    const before = yield* stored(db)
    expect(yield* sessions.rewind.preview({ ...request, checkpointID: SessionOrganization.CheckpointID.make("chk_not_a_caller_boundary") }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RewindConflictError" } })
    expect(yield* sessions.rewind.apply({ ...request, expectedLastSequence: 18 }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RewindConflictError" } })
    expect(yield* stored(db)).toEqual(before)
  }))
})
