import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { Location } from "../src/location"
import { ProjectV2 } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionProjector } from "../src/session/projector"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const nodes = LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node])
const it = testEffect(
  AppNodeBuilder.build(nodes, [
    [ProjectV2.node, projects],
    [SessionExecution.node, SessionExecution.noopLayer],
  ]),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/transaction-project") })
const rows = (db: Database.Interface["db"]) => db.select().from(EventTable).orderBy(asc(EventTable.seq)).all()
const Live = EventV2.define({ type: "test.transaction.live", schema: { title: Schema.String } })
const Captured = EventV2.define({
  type: "test.transaction.principal.created",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, title: Schema.String },
})
const renamed = (event: EventV2.Payload) => {
  if (!Schema.is(SessionEvent.Renamed)(event)) throw new Error("Expected a rename notification")
  return event
}

// Exercise the production PostgreSQL principal runner and Effect SQL transaction
// context on an owned SQLite database. Only SET LOCAL is intercepted: this is
// transaction/authorization-boundary evidence, never a real PostgreSQL/RLS test.
const principalFixture = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const client = new Proxy(database.db.$client, {
      get(source, property, receiver) {
        if (property !== "unsafe") return Reflect.get(source, property, receiver)
        return (query: string, params: ReadonlyArray<unknown> = []) => {
          if (!query.startsWith("SELECT set_config(")) return source.unsafe(query, params)
          return Effect.gen(function* () {
            expect(Option.isSome(yield* Effect.serviceOption(source.transactionService))).toBe(true)
            expect(params).toHaveLength(2)
            return []
          })
        }
      },
    })
    const runAsPrincipal = Database.postgresPrincipalScope(client)
    return Database.Service.of({
      db: database.db,
      runAsPrincipal,
      transactionAsPrincipal: <A, E, R>(
        principal: Database.Principal,
        callback: (transaction: Database.Transaction) => Effect.Effect<A, E, R>,
      ) =>
        runAsPrincipal(
          principal,
          database.db.transaction((handle) =>
            Effect.provideService(callback(handle), Database.CurrentPrincipal, principal),
          ),
        ) as Effect.Effect<A, E, R>,
    })
  }),
).pipe(Layer.provide(Database.layerFromPath(":memory:")))
const itPrincipal = testEffect(
  AppNodeBuilder.build(nodes, [
    [Database.node, principalFixture],
    [ProjectV2.node, projects],
    [SessionExecution.node, SessionExecution.noopLayer],
  ]),
)

describe("EventV2 outer transaction notifications", () => {
  it.effect("unbound durable appends use local ownership and cannot change a foreign aggregate", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const principal = { tenantID: "ten_bound_event", userID: "usr_bound_event" }
      const aggregateID = "bound-before-unbound"
      yield* database.runAsPrincipal(principal, events.publish(Captured, { id: aggregateID, title: "Original" }))
      const stored = yield* database.db.select().from(EventTable).all()
      const sequences = yield* database.db.select().from(EventSequenceTable).all()
      const observed: EventV2.Payload[] = []
      yield* events.listen((event) => Effect.sync(() => { observed.push(event) }))
      expect(yield* Database.CurrentPrincipal).toBeUndefined()
      const rejected = yield* events.publish(Captured, { id: aggregateID, title: "Unbound" }).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      expect(yield* database.db.select().from(EventTable).all()).toEqual(stored)
      expect(yield* database.db.select().from(EventSequenceTable).all()).toEqual(sequences)
      expect(observed).toEqual([])
      yield* events.publish(Captured, { id: "local-after-unbound", title: "Local" })
      expect(yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, "local-after-unbound")).get())
        .toMatchObject({ tenant_id: "ten_local", owner_user_id: "usr_local", seq: 0 })
      expect(observed).toHaveLength(1)
    }),
  )

  it.effect("binds durable event and sequence ownership to the captured principal", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const principal = { tenantID: "ten_captured_event", userID: "usr_captured_event" }
      const ownership = { tenant_id: principal.tenantID, owner_user_id: principal.userID }
      const aggregateID = "captured-owner-aggregate"
      yield* database.runAsPrincipal(principal, events.publish(Captured, { id: aggregateID, title: "Original" }))
      const stored = yield* database.db.select().from(EventTable).all()
      const sequences = yield* database.db.select().from(EventSequenceTable).all()
      expect(stored).toMatchObject([{ ...ownership, aggregate_id: aggregateID, seq: 0 }])
      expect(sequences).toMatchObject([{ ...ownership, aggregate_id: aggregateID, seq: 0 }])

      const foreign = { tenantID: "ten_other_event", userID: "usr_other_event" }
      const rejected = yield* database.runAsPrincipal(foreign, events.publish(Captured, { id: aggregateID, title: "Forbidden" })).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      expect(yield* database.db.select().from(EventTable).all()).toEqual(stored)
      expect(yield* database.db.select().from(EventSequenceTable).all()).toEqual(sequences)

      const rolledBack = yield* database.runAsPrincipal(principal, database.db.transaction(() =>
        events.publish(Captured, { id: "captured-rolled-back", title: "Discard" }).pipe(Effect.andThen(Effect.fail("rollback"))),
      )).pipe(Effect.exit)
      expect(Exit.isFailure(rolledBack)).toBe(true)
      expect(yield* database.db.select().from(EventTable).all()).toEqual(stored)
      expect(yield* database.db.select().from(EventSequenceTable).all()).toEqual(sequences)
      expect(yield* Database.CurrentPrincipal).toBeUndefined()
    }),
  )

  it.effect("outer rollback discards rename notifications and restores the title, rows and sequence", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const before = yield* rows(db)
      const sequence = yield* db.select().from(EventSequenceTable).all()
      const observed: EventV2.Payload[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      )

      const exit = yield* db
        .transaction(() =>
          sessions
            .rename({ sessionID: session.id, title: "Rolled back" })
            .pipe(Effect.andThen(Effect.fail("outer rollback"))),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* sessions.get(session.id)).title).toBe(session.title)
      expect(yield* rows(db)).toEqual(before)
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual(sequence)
      expect(observed).toEqual([])
    }),
  )

  it.effect("nested commit defers every observer until outer commit and preserves event order and identity", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const observed: EventV2.Payload[] = []
      const titles: string[] = []
      yield* events.listen((event) =>
        Effect.gen(function* () {
          expect(Option.isNone(yield* Effect.serviceOption(db.$client.transactionService))).toBe(true)
          const stored = yield* EventV2.readCommitted(db, SessionEvent.Renamed, renamed(event))
          expect(stored.id).toBe(event.id)
          expect(event.durable?.seq).toBe(stored.seq)
          titles.push(
            (yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie))!
              .title,
          )
          observed.push(event)
        }),
      )

      yield* db.transaction((outer) =>
        Effect.gen(function* () {
          yield* sessions.rename({ sessionID: session.id, title: "First" })
          yield* outer.transaction(() => sessions.rename({ sessionID: session.id, title: "Second" }))
          expect(observed).toEqual([])
        }),
      )

      expect(observed.map((event) => [event.id, event.durable?.seq, renamed(event).data.title])).toEqual(
        (yield* rows(db))
          .slice(1)
          .map((row) => [row.id, row.seq, Schema.decodeUnknownSync(SessionEvent.Renamed.data)(row.data).title]),
      )
      expect(titles).toEqual(["Second", "Second"])
    }),
  )

  it.effect("a caught nested rollback discards only that savepoint's notifications and reuses its sequence", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const observed: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          observed.push(renamed(event).data.title)
        }),
      )

      yield* db.transaction((outer) =>
        Effect.gen(function* () {
          yield* sessions.rename({ sessionID: session.id, title: "Before" })
          const failed = yield* outer
            .transaction(() =>
              sessions
                .rename({ sessionID: session.id, title: "Discard" })
                .pipe(Effect.andThen(Effect.fail("savepoint"))),
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(failed)).toBe(true)
          expect((yield* sessions.get(session.id)).title).toBe("Before")
          yield* sessions.rename({ sessionID: session.id, title: "After" })
          expect(observed).toEqual([])
        }),
      )

      expect(observed).toEqual(["Before", "After"])
      expect((yield* rows(db)).map((row) => row.seq)).toEqual([0, 1, 2])
    }),
  )

  it.effect("typed, wildcard and durable streams receive only the outer committed event", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const seen: Record<string, EventV2.Payload[]> = { typed: [], all: [], durable: [] }
      const fibers = []
      for (const [key, stream] of [
        ["typed", events.subscribe(SessionEvent.Renamed)],
        ["all", events.all()],
        ["durable", events.durable({ aggregateID: session.id, after: 0 })],
      ] as const) {
        fibers.push(
          yield* stream.pipe(
            Stream.take(1),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                seen[key].push(event)
              }),
            ),
            Effect.forkScoped,
          ),
        )
      }
      yield* Effect.yieldNow
      yield* db
        .transaction(() =>
          Effect.gen(function* () {
            yield* sessions.rename({ sessionID: session.id, title: "Rollback" })
            yield* Effect.yieldNow
            return yield* Effect.fail("outer")
          }),
        )
        .pipe(Effect.exit)
      expect(seen).toEqual({ typed: [], all: [], durable: [] })
      yield* sessions.rename({ sessionID: session.id, title: "Committed" })
      yield* Effect.forEach(fibers, Fiber.join)
      for (const received of Object.values(seen)) {
        expect(received).toMatchObject([
          { type: "session.next.renamed", durable: { seq: 1 }, data: { title: "Committed" } },
        ])
      }
    }),
  )

  it.effect("runAsPrincipal and transactionAsPrincipal retain the captured tenant without leaking failed work", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const principal = { tenantID: "ten_commit_fixture", userID: "usr_commit_fixture" }
      const session = yield* database.runAsPrincipal(principal, sessions.create({ location }))
      const observed: Database.Principal[] = []
      yield* events.listen(() =>
        Effect.gen(function* () {
          observed.push((yield* Database.CurrentPrincipal)!)
        }),
      )

      yield* database
        .runAsPrincipal(
          principal,
          database.transactionAsPrincipal(principal, () =>
            sessions.rename({ sessionID: session.id, title: "Discard" }).pipe(Effect.andThen(Effect.fail("outer"))),
          ),
        )
        .pipe(Effect.exit)
      expect(observed).toEqual([])
      const foreign = yield* database.runAsPrincipal(
        { tenantID: "ten_other", userID: principal.userID },
        sessions.rename({ sessionID: session.id, title: "Forbidden" }).pipe(Effect.result),
      )
      expect(foreign).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.NotFoundError" } })
      yield* database.runAsPrincipal(
        principal,
        database.transactionAsPrincipal(principal, () =>
          sessions.rename({ sessionID: session.id, title: "Committed" }),
        ),
      )
      expect(observed).toEqual([principal])
      expect(yield* Database.CurrentPrincipal).toBeUndefined()
      expect((yield* Database.principalContext(principal, sessions.get(session.id))).title).toBe("Committed")
    }),
  )

  it.effect("published replay is deferred, discarded on rollback and delivered once on commit", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const replayed = {
        id: EventV2.ID.create(),
        type: "session.next.renamed.1",
        aggregateID: session.id,
        seq: 1,
        data: { sessionID: session.id, title: "Replayed", timestamp: DateTime.toEpochMillis(yield* DateTime.now) },
      }
      const observed: EventV2.Payload[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      )
      yield* db
        .transaction(() => events.replay(replayed, { publish: true }).pipe(Effect.andThen(Effect.fail("outer"))))
        .pipe(Effect.exit)
      expect(observed).toEqual([])
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* events.replay(replayed, { publish: true })
          yield* events.replay(replayed, { publish: true })
          expect(observed).toEqual([])
        }),
      )
      expect(observed).toMatchObject([{ id: replayed.id, durable: { seq: 1 }, data: { title: "Replayed" } }])
    }),
  )

  it.effect("a physical COMMIT failure discards notifications and leaves no title/event/sequence change", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      yield* db.run("CREATE TABLE commit_parent (id INTEGER PRIMARY KEY)")
      yield* db.run(
        "CREATE TABLE commit_child (parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)",
      )
      const before = yield* rows(db)
      const sequence = yield* db.select().from(EventSequenceTable).all()
      const observed: EventV2.Payload[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      )
      let bodyCompleted = false
      const exit = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            yield* sessions.rename({ sessionID: session.id, title: "Commit must fail" })
            yield* db.run("INSERT INTO commit_child(parent) VALUES (999)")
            bodyCompleted = true
          }),
        )
        .pipe(Effect.exit)
      expect(bodyCompleted).toBe(true)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(observed).toEqual([])
      expect((yield* sessions.get(session.id)).title).toBe(session.title)
      expect(yield* rows(db)).toEqual(before)
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual(sequence)
      expect(yield* db.all("SELECT * FROM commit_child")).toEqual([])
    }),
  )

  it.effect("durable wakeups cause no aggregate read before commit or after outer rollback", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      let reads = 0
      yield* EventV2.Service.use((events) =>
        Effect.gen(function* () {
          const fiber = yield* events
            .durable({ aggregateID: session.id, after: 0 })
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
          yield* Effect.yieldNow
          expect(reads).toBe(1)
          const publish = (title: string) =>
            events.publish(SessionEvent.Renamed, {
              sessionID: session.id,
              title,
              timestamp: DateTime.nowUnsafe(),
            })
          yield* db
            .transaction(() =>
              Effect.gen(function* () {
                yield* publish("Discard")
                yield* Effect.yieldNow
                expect(reads).toBe(1)
                return yield* Effect.fail("outer")
              }),
            )
            .pipe(Effect.exit)
          yield* Effect.yieldNow
          expect(reads).toBe(1)
          yield* db.transaction(() =>
            Effect.gen(function* () {
              yield* publish("Committed")
              yield* Effect.yieldNow
              expect(reads).toBe(1)
            }),
          )
          expect(Array.from(yield* Fiber.join(fiber))).toMatchObject([
            { durable: { seq: 1 }, data: { title: "Committed" } },
          ])
          expect(reads).toBe(2)
        }),
      ).pipe(
        Effect.provide(
          EventV2.layerWith({
            beforeAggregateRead: () =>
              Effect.sync(() => {
                reads++
              }),
          }),
        ),
      )
    }),
  )

  it.effect("interruption after an inner success rolls back without notifying", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const observed: EventV2.Payload[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      )
      const exit = yield* db
        .transaction(() =>
          sessions.rename({ sessionID: session.id, title: "Interrupted" }).pipe(Effect.andThen(Effect.interrupt)),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(observed).toEqual([])
      expect((yield* sessions.get(session.id)).title).toBe(session.title)
      expect(yield* rows(db)).toHaveLength(1)
    }),
  )

  it.effect("live-only notifications also wait for commit, while observer defects still fail the caller", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const observed: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          if (!Schema.is(Live)(event)) throw new Error("Expected a live fixture notification")
          observed.push(event.data.title)
        }),
      )
      yield* db
        .transaction(() => events.publish(Live, { title: "Discard" }).pipe(Effect.andThen(Effect.fail("outer"))))
        .pipe(Effect.exit)
      expect(observed).toEqual([])
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* events.publish(Live, { title: "Committed" })
          expect(observed).toEqual([])
        }),
      )
      expect(observed).toEqual(["Committed"])
      const defect = new Error("live observer failure")
      yield* events.listen(() => Effect.die(defect))
      const caught = yield* db
        .transaction(() => events.publish(Live, { title: "Failure" }))
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(caught).toBe(defect)
    }),
  )

  itPrincipal.effect(
    "production runAsPrincipal nesting rolls back silently and rebinds observer reads after commit",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const database = yield* Database.Service
        const principal = { tenantID: "ten_scope_fixture", userID: "usr_scope_fixture" }
        const session = yield* database.runAsPrincipal(principal, sessions.create({ location }))
        const observed: string[] = []
        yield* events.listen((event) =>
          Effect.gen(function* () {
            expect(yield* Database.CurrentPrincipal).toEqual(principal)
            const transaction = yield* Effect.serviceOption(database.db.$client.transactionService)
            // The authorization runner starts a fresh root transaction for observer
            // reads, instead of leaking the old request's inner savepoint connection.
            expect(Option.isSome(transaction) ? transaction.value[1] : undefined).toEqual(0)
            const committed = yield* EventV2.readCommitted(database.db, SessionEvent.Renamed, renamed(event))
            const stored = yield* database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, session.id))
              .get()
              .pipe(Effect.orDie)
            expect(committed.data).toMatchObject({ title: stored?.title })
            observed.push(stored!.title)
          }),
        )
        yield* database
          .runAsPrincipal(
            principal,
            sessions
              .rename({ sessionID: session.id, title: "Discard" })
              .pipe(Effect.andThen(Effect.fail("request failed"))),
          )
          .pipe(Effect.exit)
        expect(observed).toEqual([])
        yield* database.runAsPrincipal(
          principal,
          Effect.gen(function* () {
            yield* sessions.rename({ sessionID: session.id, title: "Committed" })
            expect(observed).toEqual([])
          }),
        )
        expect(observed).toEqual(["Committed"])
        expect(yield* Database.CurrentPrincipal).toBeUndefined()
      }),
  )

  itPrincipal.effect(
    "deferred observers keep each publishing tenant's context and a foreign rename remains denied",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const database = yield* Database.Service
        const first = { tenantID: "ten_first", userID: "usr_first" }
        const second = { tenantID: "ten_second", userID: "usr_second" }
        const a = yield* database.runAsPrincipal(first, sessions.create({ location }))
        const b = yield* database.runAsPrincipal(second, sessions.create({ location }))
        const observed: Array<{ principal: Database.Principal; sessionID: string }> = []
        yield* events.listen((event) =>
          Effect.gen(function* () {
            const principal = (yield* Database.CurrentPrincipal)!
            const sessionID = renamed(event).data.sessionID
            const stored = yield* database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionID))
              .get()
              .pipe(Effect.orDie)
            expect(stored?.tenant_id).toBe(principal.tenantID)
            expect(stored?.owner_user_id).toBe(principal.userID)
            observed.push({ principal, sessionID })
          }),
        )
        const denied = yield* database.runAsPrincipal(
          first,
          sessions.rename({ sessionID: b.id, title: "Foreign" }).pipe(Effect.result),
        )
        expect(denied).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.NotFoundError" } })
        yield* database.runAsPrincipal(first, sessions.rename({ sessionID: a.id, title: "First" }))
        yield* database.runAsPrincipal(second, sessions.rename({ sessionID: b.id, title: "Second" }))
        expect(observed).toEqual([
          { principal: first, sessionID: a.id },
          { principal: second, sessionID: b.id },
        ])
        expect(yield* Database.CurrentPrincipal).toBeUndefined()
      }),
  )
})
