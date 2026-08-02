import { PgClient } from "@effect/sql-pg"
import { Effect, Redacted } from "effect"

const appRole = "arforge_app"
const adminUrl = process.env.ARFORGE_DB_ADMIN_URL?.trim() || process.env.ARFORGE_DB_URL?.trim()
const appPassword = process.env.ARFORGE_DB_APP_PASSWORD?.trim()

if (!adminUrl) throw new Error("ARFORGE_DB_ADMIN_URL or ARFORGE_DB_URL is required")
if (!appPassword || !/^[A-Za-z0-9_-]{43,}$/.test(appPassword)) {
  throw new Error("ARFORGE_DB_APP_PASSWORD must be a 43+ character URL-safe random secret")
}

const parsed = new URL(adminUrl)
const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))
if (!database) throw new Error("The PostgreSQL URL must include a database name")

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

const program = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  const current = yield* client.unsafe<{ current_user: string }>("SELECT current_user")
  const adminRole = current[0]?.current_user
  if (!adminRole) throw new Error("Unable to determine the PostgreSQL administrative role")

  const roles = yield* client.unsafe<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [appRole],
  )

  if (!roles[0]?.exists) {
    yield* client.unsafe(`
      CREATE ROLE ${identifier(appRole)}
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
      PASSWORD ${literal(appPassword)}
    `)
  } else {
    yield* client.unsafe(`
      ALTER ROLE ${identifier(appRole)}
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
      PASSWORD ${literal(appPassword)}
    `)
  }

  yield* client.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE ${identifier(database)} FROM PUBLIC`)
  yield* client.unsafe(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(appRole)}`)
  yield* client.unsafe("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
  yield* client.unsafe(`GRANT USAGE ON SCHEMA public TO ${identifier(appRole)}`)
  yield* client.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(appRole)}`,
  )
  yield* client.unsafe(
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${identifier(appRole)}`,
  )
  yield* client.unsafe(`
    ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(adminRole)} IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${identifier(appRole)}
  `)
  yield* client.unsafe(`
    ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(adminRole)} IN SCHEMA public
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${identifier(appRole)}
  `)

  return {
    database,
    role: appRole,
    adminRole,
    privileges: ["CONNECT", "USAGE(public)", "SELECT", "INSERT", "UPDATE", "DELETE", "SEQUENCE"],
    prohibited: ["SUPERUSER", "CREATEDB", "CREATEROLE", "REPLICATION", "BYPASSRLS", "CREATE(public)", "TEMPORARY"],
  }
})

const result = await Effect.runPromise(
  program.pipe(
    Effect.provide(
      PgClient.layer({
        url: Redacted.make(adminUrl),
        applicationName: "Arforge role provisioner",
        maxConnections: 1,
      }),
    ),
  ),
)

console.log(JSON.stringify(result))
