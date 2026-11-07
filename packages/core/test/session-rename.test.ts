import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Layer } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventTable, EventSequenceTable } from "../src/event/sql"
import { Location } from "../src/location"
import { ProjectV2 } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionMessageUpdater } from "../src/session/message-updater"
import { SessionProjector } from "../src/session/projector"
import { SessionStore } from "../src/session/store"
import { SessionMessageTable, SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/rename-project") })
const rows = (db: Database.Interface["db"]) => db.select().from(EventTable).orderBy(asc(EventTable.seq)).all()

describe("SessionV2.rename", () => {
  it.effect("commits a narrow title event and preserves every other stored field and message", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      yield* db
        .update(SessionTable)
        .set({ cost: 7, metadata: { retained: "yes" }, time_updated: 1234 })
        .where(eq(SessionTable.id, session.id))
        .run()
      const before = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()
      if (!before) return yield* Effect.die("Missing rename fixture session")
      const title = `  手动标题 😀 ${"长".repeat(120)}\nsecond line  `
      yield* sessions.rename({ sessionID: session.id, title })
      const renamed = yield* sessions.get(session.id)
      expect(renamed.title).toBe(title)
      expect(DateTime.toEpochMillis(renamed.time.updated)).toBe(1234)
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()).toEqual({
        ...before,
        title,
      })
      expect(yield* db.select().from(SessionMessageTable).all()).toEqual([])
      expect(yield* sessions.active).toEqual(new Set())
      const committed = yield* rows(db)
      expect(committed).toHaveLength(2)
      expect(committed[1]).toMatchObject({ type: "session.next.renamed.1", aggregate_id: session.id, seq: 1 })
      expect(committed[1]?.data).toMatchObject({ sessionID: session.id, title })
      expect(committed[1]?.data).not.toHaveProperty("messageID")
    }),
  )

  it.effect("same-title selection is a no-op and authorized successive renames follow commit order", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      yield* sessions.rename({ sessionID: session.id, title: session.title })
      expect(yield* rows(db)).toHaveLength(1)
      yield* sessions.rename({ sessionID: session.id, title: "First" })
      yield* sessions.rename({ sessionID: session.id, title: "Second" })
      expect((yield* sessions.get(session.id)).title).toBe("Second")
      expect((yield* rows(db)).map((row) => row.seq)).toEqual([0, 1, 2])
    }),
  )

  it.effect("missing sessions and foreign tenant or owner are rejected without publishing", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const session = yield* sessions.create({ location })
      const before = yield* rows(database.db)
      for (const input of [
        { principal: Database.DefaultLocalPrincipal, id: SessionV2.ID.make("ses_rename_missing") },
        { principal: { tenantID: "ten_other", userID: "usr_local" }, id: session.id },
        { principal: { tenantID: "ten_local", userID: "usr_other" }, id: session.id },
      ]) {
        const outcome = yield* database.runAsPrincipal(
          input.principal,
          sessions.rename({ sessionID: input.id, title: "Must not apply" }).pipe(Effect.result),
        )
        expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.NotFoundError" } })
      }
      expect(yield* rows(database.db)).toEqual(before)
      expect((yield* sessions.get(session.id)).title).toBe(session.title)
    }),
  )

  it.effect("a mismatched active source cannot rename the stored session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const before = yield* rows(db)
      const outcome = yield* sessions.rename({ sessionID: session.id, title: "Wrong source" }).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of({
            directory: AbsolutePath.make("/other-project"),
            project: { id: ProjectV2.ID.global, directory: AbsolutePath.make("/other-project") },
          }),
        ),
        Effect.result,
      )
      expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RenameConflictError" } })
      expect(yield* rows(db)).toEqual(before)
      expect((yield* sessions.get(session.id)).title).toBe(session.title)
    }),
  )

  it.effect("revalidates source inside the projection transaction and rolls back title, events and sequence", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const before = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()
      const beforeEvents = yield* rows(db)
      const beforeSequence = yield* db.select().from(EventSequenceTable).all()
      yield* events.project(SessionEvent.Renamed, () =>
        db
          .update(SessionTable)
          .set({ directory: "/moved-during-commit" })
          .where(eq(SessionTable.id, session.id))
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      )
      const outcome = yield* sessions.rename({ sessionID: session.id, title: "Must roll back" }).pipe(Effect.result)
      expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.RenameConflictError" } })
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()).toEqual(before)
      expect(yield* rows(db)).toEqual(beforeEvents)
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual(beforeSequence)
    }),
  )

  it.effect("a failed projector commits no title or event and sends no notification", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const before = yield* rows(db)
      let notified = 0
      yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "session.next.renamed") notified++
        }),
      )
      yield* events.project(SessionEvent.Renamed, () => Effect.die(new Error("fixture rollback")))
      expect(
        Exit.isFailure(yield* sessions.rename({ sessionID: session.id, title: "Not committed" }).pipe(Effect.exit)),
      ).toBe(true)
      expect(yield* rows(db)).toEqual(before)
      expect((yield* sessions.get(session.id)).title).toBe(session.title)
      expect(notified).toBe(0)
    }),
  )

  for (const change of ["owner", "delete"] as const) {
    it.effect(`revalidates ${change} inside commit without retaining any partial write`, () =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const session = yield* sessions.create({ location })
        const before = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()
        const beforeEvents = yield* rows(db)
        const beforeSequence = yield* db.select().from(EventSequenceTable).all()
        yield* events.project(SessionEvent.Renamed, () =>
          (change === "owner"
            ? db.update(SessionTable).set({ owner_user_id: "usr_other" }).where(eq(SessionTable.id, session.id)).run()
            : db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run()
          ).pipe(Effect.orDie, Effect.asVoid),
        )
        const outcome = yield* sessions.rename({ sessionID: session.id, title: "Must not escape" }).pipe(Effect.result)
        expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.NotFoundError" } })
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()).toEqual(before)
        expect(yield* rows(db)).toEqual(beforeEvents)
        expect(yield* db.select().from(EventSequenceTable).all()).toEqual(beforeSequence)
      }),
    )
  }

  it.effect("notifies observers only after the title and matching durable event are committed", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const observed: string[] = []
      yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== "session.next.renamed") return
          const stored = yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, session.id))
            .get()
            .pipe(Effect.orDie)
          const committed = yield* EventV2.readCommitted(db, SessionEvent.Renamed, event as SessionEvent.Renamed)
          expect(stored?.title).toBe("Committed before notify")
          expect(committed.data.title).toBe(stored?.title)
          observed.push(stored!.title)
        }),
      )
      yield* sessions.rename({ sessionID: session.id, title: "Committed before notify" })
      expect(observed).toEqual(["Committed before notify"])
    }),
  )

  it.effect("manual default-to-custom-to-default intent defeats a late generated proposal", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      yield* sessions.rename({ sessionID: session.id, title: "My title" })
      yield* sessions.rename({ sessionID: session.id, title: session.title })
      yield* events.publish(SessionEvent.TitleGenerated, {
        sessionID: session.id,
        messageID: SessionMessage.ID.make("msg_rename_generation"),
        timestamp: yield* DateTime.now,
        expectedTitle: session.title,
        title: "Stale generated title",
      })
      expect((yield* sessions.get(session.id)).title).toBe(session.title)
      expect(yield* db.select().from(SessionMessageTable).all()).toEqual([])
      const memory: SessionMessageUpdater.MemoryState = { messages: [] }
      yield* SessionMessageUpdater.update(
        SessionMessageUpdater.memory(memory),
        SessionEvent.Renamed.make({
          id: EventV2.ID.create(),
          type: "session.next.renamed",
          data: { sessionID: session.id, timestamp: yield* DateTime.now, title: "Metadata only" },
        }),
      )
      expect(memory.messages).toEqual([])
    }),
  )
})
