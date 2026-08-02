export * as Database from "./database"

import { EffectDrizzleSqlite } from "@arforge-ai/effect-drizzle-sqlite"
import { PgClient } from "@effect/sql-pg"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer, Redacted } from "effect"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { usesPostgres } from "./dialect"
import { PostgresSchemaMigrations, PostgresSchemaVersion } from "./postgres-schema.gen"

const makeSqliteDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeSqliteDatabase>

export interface Interface {
  db: DatabaseShape
  runAsPrincipal<A, E, R>(
    principal: { readonly tenantID: string; readonly userID: string },
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/storage/Database") {}

const sqliteServiceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeSqliteDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return {
      db,
      runAsPrincipal: <A, E, R>(
        _principal: { readonly tenantID: string; readonly userID: string },
        effect: Effect.Effect<A, E, R>,
      ) => effect,
    }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return sqliteServiceLayer.pipe(Layer.provide(sqliteLayer({ filename })))
}

const postgresProxyCache = new WeakMap<object, unknown>()

function postgresCompat<T extends object>(target: T): T {
  const cached = postgresProxyCache.get(target)
  if (cached) return cached as T

  const proxy = new Proxy(target, {
    get(source, property, receiver) {
      const execute = Reflect.get(source, "execute", receiver)
      if ((property === "run" || property === "all") && typeof execute === "function") {
        return () => execute.call(source)
      }
      if (property === "get" && typeof execute === "function") {
        return () => execute.call(source).pipe(Effect.map((rows: ReadonlyArray<unknown>) => rows[0]))
      }

      const value = Reflect.get(source, property, receiver)
      if (typeof value !== "function") return value
      if (property === "transaction") {
        return (callback: (transaction: unknown) => unknown, ...args: unknown[]) =>
          value.call(source, (transaction: object) => callback(postgresCompat(transaction)), ...args)
      }
      return (...args: unknown[]) => {
        const result = value.apply(source, args)
        if ((typeof result === "object" && result !== null) || typeof result === "function") {
          return postgresCompat(result as object)
        }
        return result
      }
    },
  })
  postgresProxyCache.set(target, proxy)
  return proxy
}

const ensurePostgresSchema = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  const state = yield* client.unsafe<{
    installed: boolean
    migration_table: boolean
    can_create: boolean
  }>(`
    SELECT
      to_regclass('public.session') IS NOT NULL AS installed,
      to_regclass('public.arforge_schema_migration') IS NOT NULL AS migration_table,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create
  `)
  const databaseState = state[0]
  if (!databaseState) throw new Error("Unable to inspect the PostgreSQL schema")

  if (!databaseState.installed && !databaseState.can_create) {
    throw new Error(
      "The Arforge PostgreSQL schema is not installed. Run migrations with an administrative database role before starting the application role.",
    )
  }

  if (!databaseState.migration_table) {
    if (!databaseState.can_create) {
      throw new Error(
        "The Arforge PostgreSQL migration ledger is missing. Run migrations with an administrative database role before starting the application role.",
      )
    }
    yield* client.unsafe(`
      CREATE TABLE arforge_schema_migration (
        id text PRIMARY KEY,
        time_completed bigint NOT NULL
      )
    `)
  }

  const baseline = PostgresSchemaMigrations[0]
  if (!baseline) throw new Error("Arforge has no PostgreSQL baseline migration")
  // Early private builds installed the baseline before the migration ledger
  // became version-aware. A session table is sufficient evidence that the
  // baseline exists; seed only that baseline, never a later migration.
  if (databaseState.installed) {
    yield* client.unsafe(
      `INSERT INTO arforge_schema_migration (id, time_completed)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [baseline.id, Date.now()],
    )
  }

  const completedRows = yield* client.unsafe<{ id: string }>(`SELECT id FROM arforge_schema_migration`)
  const completed = new Set(completedRows.map((row) => row.id))
  const pending = PostgresSchemaMigrations.filter((migration) => !completed.has(migration.id))
  if (pending.length > 0 && !databaseState.can_create) {
    throw new Error(
      `The Arforge PostgreSQL schema is behind ${PostgresSchemaVersion}. Run "bun --cwd packages/core run db:migrate:postgres" with ARFORGE_DB_ADMIN_URL before starting the application role.`,
    )
  }

  for (const migration of pending) {
    yield* client.withTransaction(
      Effect.gen(function* () {
        yield* Effect.forEach(migration.statements, (statement) => client.unsafe(statement), {
          concurrency: 1,
          discard: true,
        })
        yield* client.unsafe(
          `INSERT INTO arforge_schema_migration (id, time_completed)
           VALUES ($1, $2)`,
          [migration.id, Date.now()],
        )
      }),
    )
  }

  return {
    current: PostgresSchemaVersion,
    applied: pending.map((migration) => migration.id),
  }
})

const makePostgresDatabase = Effect.gen(function* () {
  yield* ensurePostgresSchema

  const client = yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()
  return {
    // Keep the established feature-facing API (.run/.all/.get) while the
    // underlying query builder and tables use PostgreSQL.
    db: postgresCompat(db) as unknown as DatabaseShape,
    runAsPrincipal: <A, E, R>(
      principal: { readonly tenantID: string; readonly userID: string },
      effect: Effect.Effect<A, E, R>,
    ) =>
      client.withTransaction(
        client
          .unsafe(`SELECT set_config('arforge.tenant_id', $1, true), set_config('arforge.user_id', $2, true)`, [
            principal.tenantID,
            principal.userID,
          ])
          .pipe(Effect.andThen(effect)),
      ) as Effect.Effect<A, E, R>,
  }
}).pipe(Effect.orDie)

export function migratePostgresSchema(url: string) {
  return ensurePostgresSchema.pipe(
    Effect.provide(
      PgClient.layer({
        url: Redacted.make(url),
        applicationName: "Arforge Migration",
        maxConnections: 2,
      }),
    ),
    Effect.scoped,
  )
}

export function layerFromPostgresUrl(url: string) {
  return Layer.effect(Service, makePostgresDatabase).pipe(
    Layer.provide(
      PgClient.layer({
        url: Redacted.make(url),
        applicationName: "Arforge",
        maxConnections: 10,
      }),
    ),
    Layer.orDie,
  )
}

export function path() {
  if (Flag.ARFORGE_DB) {
    if (Flag.ARFORGE_DB === ":memory:" || isAbsolute(Flag.ARFORGE_DB)) return Flag.ARFORGE_DB
    return join(Global.Path.data, Flag.ARFORGE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.ARFORGE_DISABLE_CHANNEL_DB === "1" ||
    process.env.ARFORGE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "arforge.db")
  return join(Global.Path.data, `arforge-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.suspend(() => {
    if (!usesPostgres) return layerFromPath(path())
    const url = process.env.ARFORGE_DB_URL?.trim()
    if (!url) throw new Error("ARFORGE_DB_URL is required for the PostgreSQL backend")
    return layerFromPostgresUrl(url)
  }),
  deps: [],
})
