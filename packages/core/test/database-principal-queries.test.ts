import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import { defineRelations, eq, sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { pgTable, text } from "drizzle-orm/pg-core"
import { PgClient } from "@effect/sql-pg"
import { Database } from "../src/database/database"
import { withPrincipalQueries } from "../src/database/principal-queries"
import { ProjectTable } from "../src/project/sql"
import { ProjectSchema } from "../src/project/schema"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

describe("Principal query operation boundaries", () => {
  it.live("PostgreSQL fluent, prepared and relational reads retain caller filters and execution scopes", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bindings: ReadonlyArray<unknown>[] = []
      const client = new Proxy(database.db.$client, {
        get(source, property, receiver) {
          if (property !== "unsafe") return Reflect.get(source, property, receiver)
          return (query: string, params: ReadonlyArray<unknown> = []) => {
            if (!query.startsWith("SELECT set_config(")) return source.unsafe(query, params)
            return Effect.sync(() => { bindings.push(params) }).pipe(Effect.as([]))
          }
        },
      })
      const rows = pgTable("principal_pg_rows", { id: text().primaryKey(), owner: text().notNull() })
      yield* database.db.run(sql`CREATE TABLE principal_pg_rows (id TEXT PRIMARY KEY, owner TEXT NOT NULL)`)
      const native = yield* PgDrizzle.makeWithDefaults({ relations: defineRelations({ rows }) }).pipe(
        // Exercise the real PostgreSQL builders on owned SQLite transport.
        // Only SET LOCAL is intercepted; this does not prove PostgreSQL RLS.
        Effect.provideService(PgClient.PgClient, client as unknown as PgClient.PgClient),
      )
      const db = withPrincipalQueries(Database.postgresCompat(native), Database.postgresOperationScope(client))
      const principal = { tenantID: "ten_pg_query", userID: "usr_pg_query" }
      const inserted = db.insert(rows).values([{ id: "a", owner: principal.userID }, { id: "b", owner: "other" }]).onConflictDoNothing()
      const owned = db.select().from(rows).where(eq(rows.owner, principal.userID))
      const prepared = owned.prepare("owned_principal")
      const relational = db.query.rows.findMany({ where: { owner: principal.userID } })
      expect(bindings).toEqual([])
      yield* Database.principalContext(principal, Effect.gen(function* () {
        yield* inserted
        expect(yield* owned).toEqual([{ id: "a", owner: principal.userID }])
        expect(yield* Effect.map(owned, (result) => result.length)).toBe(1)
        expect(yield* prepared.execute()).toEqual([{ id: "a", owner: principal.userID }])
        const beforeRelational = bindings.length
        expect(yield* relational).toEqual([{ id: "a", owner: principal.userID }])
        expect(bindings.length).toBe(beforeRelational + 1)
      }))
      expect(bindings).toEqual(Array.from({ length: 5 }, () => [principal.tenantID, principal.userID]))
    }),
  )

  it.live("fluent builders stay lazy and every Effect execution form enters a fresh principal scope", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bindings: ReadonlyArray<unknown>[] = []
      const client = new Proxy(database.db.$client, {
        get(source, property, receiver) {
          if (property !== "unsafe") return Reflect.get(source, property, receiver)
          return (query: string, params: ReadonlyArray<unknown> = []) => {
            if (!query.startsWith("SELECT set_config(")) return source.unsafe(query, params)
            return Effect.sync(() => {
              bindings.push(params)
            }).pipe(Effect.as([]))
          }
        },
      })
      const operationScope = Database.postgresOperationScope(client)
      const db = withPrincipalQueries(database.db, <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        operationScope(
          Effect.gen(function* () {
            expect(Option.isSome(yield* Effect.serviceOption(client.transactionService))).toBe(true)
            return yield* effect
          }),
        ),
      )
      const a = { tenantID: "ten_query_a", userID: "usr_query_a" }
      const b = { tenantID: "ten_query_b", userID: "usr_query_b" }
      const id = ProjectSchema.ID.make("principal-lazy")
      const insert = db
        .insert(ProjectTable)
        .values({ id, worktree: AbsolutePath.make("/principal-lazy"), sandboxes: [] })
        .onConflictDoNothing()
      const query = db.select().from(ProjectTable)
      expect(bindings).toEqual([])
      yield* Database.principalContext(
        a,
        Effect.gen(function* () {
          yield* insert
          expect((yield* query).length).toBe(1)
          expect(yield* Effect.map(query, (rows) => rows.length)).toBe(1)
          expect(yield* query.pipe(Effect.map((rows) => rows.length))).toBe(1)
          expect((yield* query.all()).length).toBe(1)
          expect((yield* query.get())?.id).toBe(id)
          expect((yield* query.prepare().all()).length).toBe(1)
          yield* db.run(sql`SELECT 1`)
        }),
      )
      expect(bindings).toEqual(Array.from({ length: 8 }, () => [a.tenantID, a.userID]))
      yield* Database.principalContext(b, query.all())
      expect(bindings.at(-1)).toEqual([b.tenantID, b.userID])
      expect(Option.isNone(yield* Effect.serviceOption(client.transactionService))).toBe(true)
      expect(yield* Database.CurrentPrincipal).toBeUndefined()
    }),
  )

  it.live("an explicit transaction retains atomic rollback across prepared and direct queries", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      let scopes = 0
      const db = withPrincipalQueries(database.db, <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* Effect.serviceOption(database.db.$client.transactionService))) return yield* effect
          scopes++
          return yield* database.db.transaction(() => effect).pipe(Effect.catchTag("SqlError", Effect.die))
        }),
      )
      const failed = yield* db
        .transaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction
              .insert(ProjectTable)
              .values({
                id: ProjectSchema.ID.make("rollback-query"),
                worktree: AbsolutePath.make("/rollback"),
                sandboxes: [],
              })
            expect((yield* transaction.select().from(ProjectTable).all()).length).toBe(1)
            expect((yield* db.select().from(ProjectTable).prepare().all()).length).toBe(1)
            return yield* Effect.fail("rollback")
          }),
        )
        .pipe(Effect.exit)
      expect(failed).toMatchObject({ _tag: "Failure" })
      expect(scopes).toBe(1)
      expect(yield* database.db.select().from(ProjectTable).all()).toEqual([])
    }),
  )
})
