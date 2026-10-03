export * as Database from "./database"

import { EffectDrizzleSqlite } from "@arforge-ai/effect-drizzle-sqlite"
import { PgClient } from "@effect/sql-pg"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer, Redacted } from "effect"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { existsSync } from "node:fs"
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

/** The Drizzle transaction handle shared by Core owner coordinators. */
export type Transaction = Parameters<Parameters<DatabaseShape["transaction"]>[0]>[0]

export interface Interface {
  db: DatabaseShape
  runAsPrincipal<A, E, R>(
    principal: { readonly tenantID: string; readonly userID: string },
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>

  /**
   * Run one transaction while binding the request principal to that same
   * transaction scope. PostgreSQL implementations use the existing
   * `SET LOCAL` boundary and Drizzle's nested transaction context, so every
   * query issued through the callback observes one physical connection;
   * SQLite receives the same principal through Effect context. This is the
   * canonical runner for future cross-owner coordinators.
   */
  transactionAsPrincipal<A, E, R>(
    principal: { readonly tenantID: string; readonly userID: string },
    callback: (transaction: Transaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>
}

export interface Principal {
  readonly tenantID: string
  readonly userID: string
}

// PostgreSQL RLS functions deliberately default to this private-server
// principal when no request-local setting exists. Keeping the predicate here
// makes that database contract explicit and prevents long-running local
// background work from inheriting a request transaction connection.
export const DefaultLocalPrincipal: Principal = Object.freeze({
  tenantID: "ten_local",
  userID: "usr_local",
})

export const isDefaultLocalPrincipal = (principal: Principal) =>
  principal.tenantID === DefaultLocalPrincipal.tenantID && principal.userID === DefaultLocalPrincipal.userID

/** Request-scoped principal established by every database authorization boundary. */
export const CurrentPrincipal = Context.Reference<Principal | undefined>("@arforge/v2/storage/Database/principal", {
  defaultValue: () => undefined,
})

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/storage/Database") {}

const sqliteServiceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeSqliteDatabase

    const readOnly = process.env.ARFORGE_DB_READ_ONLY === "1"
    if (!readOnly) {
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      yield* DatabaseMigration.apply(db)
    }

    return {
      db,
      runAsPrincipal: <A, E, R>(
        principal: { readonly tenantID: string; readonly userID: string },
        effect: Effect.Effect<A, E, R>,
      ) => Effect.provideService(effect, CurrentPrincipal, principal),
      transactionAsPrincipal: <A, E, R>(
        principal: { readonly tenantID: string; readonly userID: string },
        callback: (transaction: Transaction) => Effect.Effect<A, E, R>,
      ) => {
        const transaction = db.transaction((handle) =>
          Effect.provideService(callback(handle as Transaction), CurrentPrincipal, principal),
        )
        return Effect.provideService(transaction, CurrentPrincipal, principal) as Effect.Effect<A, E, R>
      },
    }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  const readOnly = process.env.ARFORGE_DB_READ_ONLY === "1"
  // A diagnostic against a missing profile should return an unversioned
  // report, not create a database just by starting the CLI.  Use a private
  // in-memory connection for the rest of the app layer in that case; the
  // command's `currentAtPath` fast path still returns the file-level status.
  const target = readOnly && filename !== ":memory:" && !existsSync(filename) ? ":memory:" : filename
  return sqliteServiceLayer.pipe(
    Layer.provide(
      sqliteLayer({
        filename: target,
        readonly: readOnly,
        readwrite: !readOnly,
        create: readOnly ? target === ":memory:" : true,
        disableWAL: readOnly,
      }),
    ),
  )
}

/**
 * Read the local migration ledger without booting the application database
 * service.  The normal service intentionally applies migrations at startup;
 * a diagnostic query must not inherit that writer.  `create:false` and the
 * missing-file fast path keep this function strictly read-only.
 */
export function currentAtPath(filename = path()) {
  if (filename !== ":memory:" && !existsSync(filename)) return Effect.succeed(DatabaseMigration.unversioned())

  const readOnly = Effect.gen(function* () {
    const db = yield* makeSqliteDatabase
    return yield* DatabaseMigration.current(db)
  }).pipe(
    Effect.provide(
      sqliteLayer({
        filename,
        readonly: true,
        readwrite: false,
        create: false,
        disableWAL: true,
      }),
    ),
  )
  return Effect.scoped(readOnly)
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

/**
 * A transaction-scoped advisory lock is the PostgreSQL migration lease.
 * Keeping it in the same transaction as the ledger and DDL means a crashed
 * migrator releases the lease and rolls back its unrecorded schema changes;
 * the next process can safely inspect the ledger and retry.  This is the
 * database's existing coordination primitive, not a second lease table.
 */
export const POSTGRES_SCHEMA_MIGRATION_LOCK = "arforge.schema.migration.v1"

/**
 * Derive the next migration set from the durable ledger without mutating it.
 * Keeping this projection pure makes restart/recovery reasoning independent of
 * a live database and ensures every caller uses the generated migration order.
 */
export const pendingPostgresMigrations = (completed: ReadonlySet<string>) =>
  PostgresSchemaMigrations.filter((migration) => !completed.has(migration.id))

const ensurePostgresSchema = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  return yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [POSTGRES_SCHEMA_MIGRATION_LOCK])
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
      const pending = pendingPostgresMigrations(completed)
      if (pending.length > 0 && !databaseState.can_create) {
        throw new Error(
          `The Arforge PostgreSQL schema is behind ${PostgresSchemaVersion}. Run "bun --cwd packages/core run db:migrate:postgres" with ARFORGE_DB_ADMIN_URL before starting the application role.`,
        )
      }

      for (const migration of pending) {
        yield* Effect.forEach(migration.statements, (statement) => client.unsafe(statement), {
          concurrency: 1,
          discard: true,
        })
        yield* client.unsafe(
          `INSERT INTO arforge_schema_migration (id, time_completed)
           VALUES ($1, $2)`,
          [migration.id, Date.now()],
        )
      }

      return {
        current: PostgresSchemaVersion,
        applied: pending.map((migration) => migration.id),
      }
    }),
  )
})

const makePostgresDatabase = Effect.gen(function* () {
  // Read-only diagnostics may still construct the global app layer.  Do not
  // run schema creation/upgrade in that mode; the `db current` command
  // rejects PostgreSQL explicitly until a read-only revision contract exists.
  if (process.env.ARFORGE_DB_READ_ONLY !== "1") yield* ensurePostgresSchema

  const client = yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()
  return {
    // Keep the established feature-facing API (.run/.all/.get) while the
    // underlying query builder and tables use PostgreSQL.
    db: postgresCompat(db) as unknown as DatabaseShape,
    runAsPrincipal: <A, E, R>(
      principal: { readonly tenantID: string; readonly userID: string },
      effect: Effect.Effect<A, E, R>,
    ) => {
      const scoped = Effect.provideService(effect, CurrentPrincipal, principal)
      // Local/private mode is the schema's fail-safe default identity. It does
      // not need SET LOCAL and must not hold one PostgreSQL connection for a
      // multi-minute agent run whose child fibers perform concurrent work.
      if (isDefaultLocalPrincipal(principal)) return scoped
      return client.withTransaction(
        client
          .unsafe(`SELECT set_config('arforge.tenant_id', $1, true), set_config('arforge.user_id', $2, true)`, [
            principal.tenantID,
            principal.userID,
          ])
          .pipe(Effect.andThen(scoped)),
      ) as Effect.Effect<A, E, R>
    },
    transactionAsPrincipal: <A, E, R>(
      principal: { readonly tenantID: string; readonly userID: string },
      callback: (transaction: Transaction) => Effect.Effect<A, E, R>,
    ) => {
      const scoped = db.transaction((handle) =>
        // The feature-facing Core contract uses the same `.run/.get/.all`
        // methods for SQLite and PostgreSQL.  The root PostgreSQL database is
        // wrapped by postgresCompat above, but Drizzle's transaction callback
        // receives a fresh native handle; wrap that handle as well or owner
        // writers would see `.run is not a function` in production.
        Effect.provideService(callback(postgresCompat(handle) as unknown as Transaction), CurrentPrincipal, principal),
      )
      // Keep the private/local principal on the normal database path. For a
      // tenant-scoped request, the SET LOCAL statement and Drizzle callback
      // share the same physical PostgreSQL transaction connection.
      if (isDefaultLocalPrincipal(principal)) return scoped as Effect.Effect<A, E, R>
      return client.withTransaction(
        client
          .unsafe(`SELECT set_config('arforge.tenant_id', $1, true), set_config('arforge.user_id', $2, true)`, [
            principal.tenantID,
            principal.userID,
          ])
          .pipe(Effect.andThen(scoped)),
      ) as Effect.Effect<A, E, R>
    },
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
