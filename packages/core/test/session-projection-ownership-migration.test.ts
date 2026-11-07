import { describe, expect } from "bun:test"
import { asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { ProjectV2 } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionProjector } from "../src/session/projector"
import { SessionStore } from "../src/session/store"
import { SessionInputTable, SessionMessageTable } from "../src/session/sql"
import fixture from "./fixture/session-projection-pre18.json"
import { testEffect } from "./lib/effect"

const migrationID = "20261031010000_session_projection_ownership"
const projects = Layer.succeed(ProjectV2.Service, ProjectV2.Service.of({
  resolve: directory => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  directories: () => Effect.succeed([]), commit: () => Effect.void,
}))
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
  [[ProjectV2.node, projects], [SessionExecution.node, SessionExecution.noopLayer]],
))
const restore = Effect.gen(function* () {
  const { db } = yield* Database.Service
  // Restore unchanged snapshots produced by the real old canonical projector.
  // No ownership correction or fabricated successful HTTP response occurs here.
  for (const [table, rows] of Object.entries(fixture.tables)) for (const row of rows) {
    yield* db.run(sql`INSERT OR IGNORE INTO ${sql.identifier(table)} (${sql.join(Object.keys(row).map(name => sql.identifier(name)), sql`, `)}) VALUES (${sql.join(Object.values(row).map(value => sql`${value}`), sql`, `)})`)
  }
  yield* db.run(sql`DELETE FROM migration WHERE id = ${migrationID}`)
  return db
})
const snapshot = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const result: Record<string, Record<string, unknown>[]> = {}
  for (const table of ["session", "event_sequence", "event", "session_input", "session_message", "session_checkpoint", "migration"]) {
    result[table] = yield* db.all<Record<string, unknown>>(sql`SELECT * FROM ${sql.identifier(table)} ORDER BY ${sql.identifier(table === "event_sequence" ? "aggregate_id" : "id")}`)
  }
  return result
})
const target = () => {
  const input = fixture.tables.session_input[0]!
  const session = fixture.tables.session.find(row => row.id === input.session_id)!
  return { sessionID: SessionV2.ID.make(session.id), messageID: SessionMessage.ID.make(input.id), expectedDirectory: AbsolutePath.make(session.directory) }
}
const applyMigration = (db: Database.Interface["db"]) => DatabaseMigration.applyOnly(db, migrations.filter(item => item.id === migrationID))
const sessionRows = (value: Record<string, Record<string, unknown>[]>, id: string) => Object.fromEntries(
  Object.entries(value).filter(([table]) => table !== "migration").map(([table, rows]) => [table,
    rows.filter(row => row.session_id === id || row.aggregate_id === id || row.id === id),
  ]),
)

describe("retained SQLite canonical projection ownership", () => {
  it.effect("old real projector rows reject owner preview until the explicit migration, then preview writes nothing", () => Effect.gen(function* () {
    const db = yield* restore
    const database = yield* Database.Service
    const sessions = yield* SessionV2.Service
    const before = yield* snapshot
    const old = yield* database.runAsPrincipal(fixture.owner, sessions.rewind.preview(target()).pipe(Effect.result))
    expect(old).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RewindMessageNotFoundError" } })
    expect(yield* snapshot).toEqual(before)
    yield* applyMigration(db)
    const migrated = yield* snapshot
    const result = yield* database.runAsPrincipal(fixture.owner, sessions.rewind.preview(target()).pipe(Effect.result))
    expect(result).toMatchObject({ _tag: "Success", success: { workspaceEffectsUnchanged: true } })
    expect(yield* snapshot).toEqual(migrated)
    const ownership = { tenant_id: fixture.owner.tenantID, owner_user_id: fixture.owner.userID }
    for (const row of yield* db.select().from(SessionInputTable).orderBy(asc(SessionInputTable.id)).all()) expect(row).toMatchObject(ownership)
    for (const row of yield* db.select().from(SessionMessageTable).orderBy(asc(SessionMessageTable.id)).all()) expect(row).toMatchObject(ownership)
    for (const table of ["session", "event_sequence", "event"]) expect(migrated[table]).toEqual(before[table])
    for (const table of ["session_input", "session_message"]) {
      const payloads = (rows: Record<string, unknown>[]) => rows.map(({ tenant_id: _tenant, owner_user_id: _owner, ...row }) => row)
      expect(payloads(migrated[table]!)).toEqual(payloads(before[table]!))
    }
    yield* applyMigration(db)
    expect(yield* snapshot).toEqual(migrated)
  }))

  it.effect("repaired retained requests allow owner apply while both foreign scopes remain denied without writes", () => Effect.gen(function* () {
    const db = yield* restore
    const database = yield* Database.Service
    const sessions = yield* SessionV2.Service
    yield* applyMigration(db)
    const request = target()
    const preview = yield* database.runAsPrincipal(fixture.owner, sessions.rewind.preview(request))
    const apply = { ...request, expectedLastSequence: preview.expectedLastSequence, expectedRevision: preview.expectedRevision }
    const before = yield* snapshot
    for (const foreign of [
      { tenantID: "ten_retained_foreign", userID: fixture.owner.userID },
      { tenantID: fixture.owner.tenantID, userID: "usr_retained_foreign" },
    ]) {
      const deniedPreview = yield* database.runAsPrincipal(foreign, sessions.rewind.preview(request).pipe(Effect.result))
      expect(deniedPreview).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.NotFoundError" } })
      expect(yield* snapshot).toEqual(before)
      const deniedApply = yield* database.runAsPrincipal(foreign, sessions.rewind.apply(apply).pipe(Effect.result))
      expect(deniedApply).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.NotFoundError" } })
      expect(yield* snapshot).toEqual(before)
    }
    yield* database.runAsPrincipal(fixture.owner, sessions.rewind.apply(apply))
    const after = yield* snapshot
    expect(after.session_checkpoint).toHaveLength(1)
    expect(after.session_message!.filter(row => row.session_id === request.sessionID && row.time_rewound !== null)).toHaveLength(preview.affectedMessages)
    // Rewind consumes its promoted original so it can be admitted again. Other
    // Sessions and pending siblings must remain byte-for-byte unchanged.
    expect(after.session_input).toEqual(before.session_input!.filter(row => row.id !== request.messageID))
  }))

  for (const defect of ["foreign-child", "missing-origin", "foreign-origin", "wrong-sequence", "wrong-prompt", "ambiguous-origin"] as const) {
    it.effect(`retained ${defect} authority is left intact rather than partially assigned`, () => Effect.gen(function* () {
      const db = yield* restore
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const request = target()
      const input = fixture.tables.session_input[0]!
      if (defect === "foreign-child") yield* db.run(sql`UPDATE session_input SET owner_user_id = ${"usr_retained_foreign"} WHERE id = ${input.id}`)
      if (defect === "missing-origin") yield* db.run(sql`DELETE FROM event WHERE aggregate_id = ${input.session_id} AND seq = ${input.admitted_seq}`)
      if (defect === "foreign-origin") yield* db.run(sql`UPDATE event SET owner_user_id = ${"usr_retained_foreign"} WHERE aggregate_id = ${input.session_id} AND seq = ${input.admitted_seq}`)
      if (defect === "wrong-sequence") yield* db.run(sql`UPDATE session_input SET admitted_seq = ${input.admitted_seq + 1} WHERE id = ${input.id}`)
      if (defect === "wrong-prompt") {
        const prompt = JSON.parse(input.prompt)
        yield* db.run(sql`UPDATE session_input SET prompt = ${JSON.stringify({ ...prompt, text: "Not proved by the original durable event" })} WHERE id = ${input.id}`)
      }
      if (defect === "ambiguous-origin") {
        const origin = fixture.tables.event.find(row => row.aggregate_id === input.session_id && row.seq === input.admitted_seq)!
        const sequence = Math.max(...fixture.tables.event.filter(row => row.aggregate_id === input.session_id).map(row => row.seq)) + 1
        const duplicate = { ...origin, id: origin.id + "duplicate", seq: sequence }
        yield* db.run(sql`INSERT INTO event (${sql.join(Object.keys(duplicate).map(name => sql.identifier(name)), sql`, `)}) VALUES (${sql.join(Object.values(duplicate).map(value => sql`${value}`), sql`, `)})`)
        yield* db.run(sql`UPDATE event_sequence SET seq = ${sequence} WHERE aggregate_id = ${input.session_id}`)
      }
      const before = sessionRows(yield* snapshot, request.sessionID)
      yield* applyMigration(db)
      const after = yield* snapshot
      expect(sessionRows(after, request.sessionID)).toEqual(before)
      const denied = yield* database.runAsPrincipal(fixture.owner, sessions.rewind.preview(request).pipe(Effect.result))
      expect(denied._tag).toBe("Failure")
      expect(yield* snapshot).toEqual(after)
    }))
  }

  for (const failure of ["write-error", "owner-changed", "origin-changed"] as const) {
    it.effect(`retained migration rolls back ownership and its ledger on ${failure}`, () => Effect.gen(function* () {
      const db = yield* restore
      const request = target()
      const input = fixture.tables.session_input[0]!
      const before = yield* snapshot
      if (failure === "write-error") yield* db.run(sql`CREATE TRIGGER retained_owned_failure BEFORE UPDATE OF owner_user_id ON session_message BEGIN SELECT RAISE(ABORT, 'owned-retained-migration-failure'); END`)
      if (failure === "owner-changed") yield* db.run(sql`CREATE TRIGGER retained_owned_failure AFTER UPDATE OF owner_user_id ON session_input BEGIN UPDATE session SET owner_user_id = 'usr_changed_during_migration' WHERE id = NEW.session_id; END`)
      if (failure === "origin-changed") yield* db.run(sql`CREATE TRIGGER retained_owned_failure AFTER UPDATE OF owner_user_id ON session_input BEGIN UPDATE event SET data = '{}' WHERE aggregate_id = NEW.session_id AND seq = NEW.admitted_seq; END`)
      const failed = yield* applyMigration(db).pipe(Effect.exit, Effect.ensuring(db.run(sql`DROP TRIGGER retained_owned_failure`).pipe(Effect.orDie)))
      expect(failed._tag).toBe("Failure")
      expect(yield* snapshot).toEqual(before)
      yield* applyMigration(db)
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      expect(yield* database.runAsPrincipal(fixture.owner, sessions.rewind.preview(request).pipe(Effect.result))).toMatchObject({ _tag: "Success" })
      const repaired = yield* snapshot
      yield* applyMigration(db)
      expect(yield* snapshot).toEqual(repaired)
      expect(input.id).toBe(request.messageID)
    }))
  }

  it.effect("additional canonical message kinds and an edited pending PNG queue retain content and order", () => Effect.gen(function* () {
    const db = yield* restore
    const database = yield* Database.Service
    const request = target()
    const pending: SessionMessage.ID[] = []
    yield* database.runAsPrincipal(fixture.owner, Effect.gen(function* () {
      const events = yield* EventV2.Service
      const base = { sessionID: request.sessionID, timestamp: DateTime.makeUnsafe(1000) }
      yield* events.publish(SessionEvent.ContextUpdated, { ...base, messageID: SessionMessage.ID.create(), text: "Retained system context" })
      yield* events.publish(SessionEvent.Synthetic, { ...base, messageID: SessionMessage.ID.create(), text: "Retained synthetic context" })
      yield* events.publish(SessionEvent.Shell.Started, { ...base, messageID: SessionMessage.ID.create(), callID: "retained-shell", command: "Projection only; never executed" })
      yield* events.publish(SessionEvent.Compaction.Ended, { ...base, messageID: SessionMessage.ID.create(), reason: "manual", text: "Retained summary", recent: "Retained recent" })
      const original = Schema.decodeUnknownSync(Prompt)(JSON.parse(fixture.tables.session_input[0]!.prompt))
      for (const text of ["Pending first", "Pending second"]) {
        const messageID = SessionMessage.ID.create()
        pending.push(messageID)
        const admitted = yield* events.publish(SessionEvent.PromptAdmitted, { ...base, messageID, delivery: "queue", prompt: Prompt.make({ ...original, text }) })
        if (text === "Pending first") {
          yield* events.publish(SessionEvent.PromptQueueUpdated, {
            ...base, messageID, delivery: "queue", expectedAdmittedSeq: admitted.durable!.seq,
            prompt: Prompt.make({ ...original, text: "Pending first edited" }),
          })
        }
      }
    }))
    // Additional kinds use the actual current projector, then reproduce only
    // the known old default-column defect in this owned fixture variant. The
    // untouched historical fixture separately proves the original failure.
    yield* db.run(sql`UPDATE session_input SET tenant_id = 'ten_local', owner_user_id = 'usr_local' WHERE session_id = ${request.sessionID}`)
    yield* db.run(sql`UPDATE session_message SET tenant_id = 'ten_local', owner_user_id = 'usr_local' WHERE session_id = ${request.sessionID}`)
    const before = yield* snapshot
    yield* applyMigration(db)
    const after = yield* snapshot
    const ownedRows = after.session_message!.filter(row => row.session_id === request.sessionID)
    expect(ownedRows.map(row => row.type).sort()).toEqual(["agent-switched", "assistant", "compaction", "model-switched", "shell", "synthetic", "system", "user"])
    for (const row of ownedRows) expect(row).toMatchObject({ tenant_id: fixture.owner.tenantID, owner_user_id: fixture.owner.userID })
    const queue = after.session_input!.filter(row => row.session_id === request.sessionID && row.promoted_seq === null).sort((a, b) => Number(a.admitted_seq) - Number(b.admitted_seq))
    expect(queue.map(row => row.id)).toEqual(pending)
    expect(queue.map(row => JSON.parse(String(row.prompt)).text)).toEqual(["Pending first edited", "Pending second"])
    for (const row of queue) expect(row).toMatchObject({ tenant_id: fixture.owner.tenantID, owner_user_id: fixture.owner.userID })
    for (const table of ["session_input", "session_message"]) {
      const payloads = (rows: Record<string, unknown>[]) => rows.map(({ tenant_id: _tenant, owner_user_id: _owner, ...row }) => row)
      expect(payloads(after[table]!)).toEqual(payloads(before[table]!))
    }
    expect(after.event).toEqual(before.event)
    const sessions = yield* SessionV2.Service
    const privateSession = yield* sessions.create({ location: { directory: AbsolutePath.make("/owned-retained-local") } })
    yield* (yield* EventV2.Service).publish(SessionEvent.Prompted, {
      sessionID: privateSession.id, messageID: SessionMessage.ID.create(),
      timestamp: DateTime.makeUnsafe(1500), delivery: "steer", prompt: Prompt.make({ text: "Keep actual private rows local" }),
    })
    const localBefore = sessionRows(yield* snapshot, privateSession.id)
    // An explicit repeat exercises the migration itself, rather than only its
    // already-completed ledger fast path, and retains genuine local ownership.
    yield* db.run(sql`DELETE FROM migration WHERE id = ${migrationID}`)
    yield* applyMigration(db)
    expect(sessionRows(yield* snapshot, privateSession.id)).toEqual(localBefore)
  }))
})
