export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@arforge-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export type CurrentStatus = {
  readonly schema_version: 1
  readonly current: string | null
  readonly applied: ReadonlyArray<string>
  readonly pending: ReadonlyArray<string>
  readonly unknown: ReadonlyArray<string>
  readonly source: "typescript-migration-ledger" | "unversioned"
}

export function unversioned(): CurrentStatus {
  return {
    schema_version: 1,
    current: null,
    applied: [],
    pending: migrations.map((migration) => migration.id),
    unknown: [],
    source: "unversioned",
  }
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    // Opening an already migrated SQLite database should be read-only with
    // respect to the migration ledger.  CREATE TABLE IF NOT EXISTS still
    // takes a schema write lock, which is enough to make independent worker
    // processes race even when there are no pending migrations.  Only issue
    // the DDL when the ledger is genuinely absent (legacy installs).
    const migrationTable = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"migration"}`,
    )
    if (!migrationTable) {
      yield* db.run(
        sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
      )
    }
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}

/**
 * Read the local SQLite migration ledger without changing it.
 *
 * This is deliberately separate from `apply`/`applyOnly`: callers such as the
 * CLI's `db current` command must be able to report an incomplete or empty
 * database without silently applying migrations.  Ordering follows the
 * generated migration list, so a partially applied database has one stable
 * current revision and a deterministic pending list.
 */
export function current(db: Database): Effect.Effect<CurrentStatus, unknown> {
  return Effect.gen(function* () {
    const migrationTable = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"migration"}`,
    )
    if (!migrationTable) {
      return unversioned()
    }

    const rows = yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)
    const known = new Set(migrations.map((migration) => migration.id))
    const applied = migrations
      .filter((migration) => rows.some((row) => row.id === migration.id))
      .map((migration) => migration.id)
    const appliedSet = new Set(applied)
    const pending = migrations.filter((migration) => !appliedSet.has(migration.id)).map((migration) => migration.id)
    const unknown = rows
      .map((row) => row.id)
      .filter((id) => !known.has(id))
      .sort()

    return {
      schema_version: 1,
      current: applied.at(-1) ?? null,
      applied,
      pending,
      unknown,
      source: "typescript-migration-ledger",
    } satisfies CurrentStatus
  })
}
