import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Location } from "../src/location"
import { ProjectV2 } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionEvent } from "../src/session/event"
import { SessionProjector } from "../src/session/projector"
import { SessionRunCoordinator } from "../src/session/run-coordinator"
import { SessionStore } from "../src/session/store"
import { withPrincipalQueries } from "../src/database/principal-queries"
import * as TransactionEffects from "../src/database/transaction-effects"
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
const location = Location.Ref.make({ directory: AbsolutePath.make("/execution-transaction-project") })
class ExecutionSource extends Context.Service<ExecutionSource, string>()("@test/ExecutionTransactionSource") {}

// Production principal/operation boundaries over an owned SQLite transport.
// SET LOCAL is intercepted; this fixture does not establish PostgreSQL/RLS evidence.
const principalFixture = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const client = new Proxy(database.db.$client, {
      get(source, property, receiver) {
        if (property !== "unsafe") return Reflect.get(source, property, receiver)
        return (query: string, params: ReadonlyArray<unknown> = []) =>
          query.startsWith("SELECT set_config(") ? Effect.succeed([]) : source.unsafe(query, params)
      },
    })
    const runAsPrincipal = Database.postgresPrincipalScope(client)
    const db = withPrincipalQueries(database.db, Database.postgresOperationScope(client))
    return Database.Service.of({
      db,
      runAsPrincipal,
      transactionAsPrincipal: (principal, callback) =>
        runAsPrincipal(principal, db.transaction(callback).pipe(Effect.catchTag("SqlError", Effect.die))),
    })
  }),
).pipe(Layer.provide(Database.layerFromPath(":memory:")))
const itPrincipal = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [Database.node, principalFixture],
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const renamed = (event: EventV2.Payload) => (Schema.is(SessionEvent.Renamed)(event) ? event : undefined)

describe("Session execution transaction lifetime", () => {
  it.live("an expired transaction context fails explicitly instead of swallowing a new notification", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const expired = yield* database.db.transaction(() => Effect.context<never>())
      let notifications = 0
      const notify = TransactionEffects.afterCommit(
        database.db.$client,
        Effect.sync(() => {
          notifications++
        }),
      )
      const failed = yield* notify.pipe(
        Effect.updateContext((_runtime: Context.Context<never>) => expired),
        Effect.exit,
      )
      expect(failed._tag).toBe("Failure")
      expect(notifications).toBe(0)
      yield* notify
      expect(notifications).toBe(1)
    }),
  )

  itPrincipal.live("a later caller replaces the runtime principal and an unbound caller cannot inherit it", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const a = { tenantID: "ten_runtime", userID: "usr_runtime" }
      const b = { tenantID: "ten_caller", userID: "usr_caller" }
      const observed: Array<Database.Principal | undefined> = []
      const coordinator = yield* database.runAsPrincipal(
        a,
        SessionRunCoordinator.make({
          drain: () =>
            Effect.gen(function* () {
              expect(Option.isNone(yield* Effect.serviceOption(database.db.$client.transactionService))).toBe(true)
              observed.push(yield* Database.CurrentPrincipal)
            }),
        }),
      )
      yield* Database.principalContext(b, coordinator.wakeAndWait("second"))
      yield* coordinator.wakeAndWait("unbound")
      expect(observed).toEqual([b, undefined])
    }),
  )

  it.live("a wake starts only after its admission transaction commits", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const started = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.sync(() => {
            runs++
          }).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
      })
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* coordinator.wake("admitted")
          yield* Effect.yieldNow
          expect(runs).toBe(0)
        }),
      )
      yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
      expect(runs).toBe(1)
    }),
  )

  it.live("a rolled-back admission never starts its queued drain", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      let runs = 0
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.sync(() => {
            runs++
          }),
      })
      const failed = yield* db
        .transaction(() =>
          coordinator.wake("discarded").pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      yield* Effect.yieldNow
      expect(runs).toBe(0)
      expect(yield* coordinator.active).toEqual(new Set())
    }),
  )

  it.live("a drain released after request commit uses no closed connection and delivers its committed event", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const session = yield* sessions.create({ location })
      const release = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const observed: string[] = []
      const principal = { tenantID: "ten_local", userID: "usr_local" }
      yield* events.listen((event) =>
        Effect.sync(() => {
          const change = renamed(event)
          if (change?.data.sessionID === session.id) observed.push(change.data.title)
        }),
      )
      const coordinator = yield* SessionRunCoordinator.make<
        string,
        SessionV2.NotFoundError | SessionV2.RenameConflictError
      >({
        drain: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            expect(Option.isNone(yield* Effect.serviceOption(database.db.$client.transactionService))).toBe(true)
            expect(yield* Database.CurrentPrincipal).toEqual(principal)
            expect(Context.getOption(yield* Effect.context(), ExecutionSource)).toEqual(Option.some("captured-source"))
            yield* sessions.rename({ sessionID: session.id, title: "Late committed drain" })
            yield* Deferred.succeed(done, undefined)
          }),
      })
      yield* database.runAsPrincipal(
        principal,
        database.db.transaction(() =>
          coordinator.wake(session.id).pipe(Effect.provideService(ExecutionSource, "captured-source")),
        ),
      )
      yield* Deferred.await(entered).pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(done).pipe(Effect.timeout("1 second"))
      expect((yield* sessions.get(session.id)).title).toBe("Late committed drain")
      expect(observed).toEqual(["Late committed drain"])
      const rows = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all()
      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }).pipe(Effect.timeout("3 seconds")),
  )

  itPrincipal.live("a coordinator constructed in a request cannot retain its expired SQL lifetime", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const principal = { tenantID: "ten_latewake", userID: "usr_latewake" }
      const session = yield* database.runAsPrincipal(principal, sessions.create({ location }))
      const release = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const done = yield* Deferred.make<Exit.Exit<void, unknown>>()
      const observed: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          const change = renamed(event)
          if (change?.data.sessionID === session.id) observed.push(change.data.title)
        }),
      )
      const coordinator = yield* database.runAsPrincipal(
        principal,
        Effect.gen(function* () {
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                expect(Option.isNone(yield* Effect.serviceOption(database.db.$client.transactionService))).toBe(true)
                expect(yield* Database.CurrentPrincipal).toEqual(principal)
                expect(Context.getOption(yield* Effect.context(), ExecutionSource)).toEqual(Option.some("late-source"))
                yield* sessions.rename({ sessionID: session.id, title: "Late wake committed" })
              }).pipe(Effect.onExit((exit) => Deferred.succeed(done, exit))),
          })
          yield* coordinator.wake(session.id)
          return coordinator
        }).pipe(Effect.provideService(ExecutionSource, "late-source")),
      )
      yield* Deferred.await(entered)
      yield* Deferred.succeed(release, undefined)
      yield* yield* Deferred.await(done)
      expect(observed).toEqual(["Late wake committed"])
      expect((yield* Database.principalContext(principal, sessions.get(session.id))).title).toBe("Late wake committed")
      expect(yield* coordinator.active).toEqual(new Set())
    }).pipe(Effect.timeout("3 seconds")),
  )

  itPrincipal.live("principal-bound waiting delivers committed progress before terminal execution", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const principal = { tenantID: "ten_waiting", userID: "usr_waiting" }
      const session = yield* database.runAsPrincipal(principal, sessions.create({ location }))
      const foreign = yield* sessions.create({ location })
      const progress = yield* Deferred.make<void>()
      const streamedProgress = yield* Deferred.make<void>()
      const terminal = yield* Deferred.make<void>()
      const observed: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          const change = renamed(event)
          if (change?.data.sessionID === session.id) observed.push(change.data.title)
        }),
      )
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () =>
          Effect.gen(function* () {
            expect(yield* Database.CurrentPrincipal).toEqual(principal)
            expect(Option.isNone(yield* Effect.serviceOption(database.db.$client.transactionService))).toBe(true)
            yield* sessions.rename({ sessionID: session.id, title: "Progress before terminal" })
            yield* Deferred.succeed(progress, undefined)
            yield* Deferred.await(terminal)
            expect(Option.isNone(yield* Effect.serviceOption(database.db.$client.transactionService))).toBe(true)
            const denied = yield* sessions.rename({ sessionID: foreign.id, title: "Foreign" }).pipe(Effect.exit)
            expect(denied).toMatchObject({ _tag: "Failure" })
            yield* sessions.rename({ sessionID: session.id, title: "Terminal" })
          }),
      })
      const stream = yield* Database.principalContext(
        principal,
        events.durable({ aggregateID: session.id, after: 0 }).pipe(
          Stream.take(2),
          Stream.tap(() => Deferred.succeed(streamedProgress, undefined)),
          Stream.runCollect,
        ),
      ).pipe(Effect.forkChild)
      const waiting = yield* Database.principalContext(principal, coordinator.wakeAndWait(session.id)).pipe(
        Effect.forkChild,
      )
      yield* Deferred.await(progress)
      yield* Deferred.await(streamedProgress)
      expect(observed).toEqual(["Progress before terminal"])
      yield* Deferred.succeed(terminal, undefined)
      yield* Fiber.join(waiting)
      expect(observed).toEqual(["Progress before terminal", "Terminal"])
      expect((yield* Fiber.join(stream)).map((event) => event.durable?.seq)).toEqual([1, 2])
      const rows = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all()
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
      expect((yield* sessions.get(foreign.id)).title).toBe(foreign.title)
      expect(yield* Database.CurrentPrincipal).toBeUndefined()
    }).pipe(Effect.timeout("3 seconds")),
  )
})
