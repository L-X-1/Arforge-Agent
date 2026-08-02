import { PgClient } from "@effect/sql-pg"
import { Effect, Redacted } from "effect"

const expectedRole = "arforge_app"
const url = process.env.ARFORGE_DB_URL?.trim()
if (!url) throw new Error("ARFORGE_DB_URL is required")

const marker = `permission-audit-${crypto.randomUUID()}`
const program = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  const role = yield* client.unsafe<{
    current_database: string
    current_user: string
    rolsuper: boolean
    rolcreatedb: boolean
    rolcreaterole: boolean
    rolreplication: boolean
    rolbypassrls: boolean
    can_connect: boolean
    can_use_schema: boolean
    can_create_schema_objects: boolean
    can_use_temp: boolean
    can_write_session: boolean
  }>(`
    SELECT
      current_database() AS current_database,
      current_user,
      role.rolsuper,
      role.rolcreatedb,
      role.rolcreaterole,
      role.rolreplication,
      role.rolbypassrls,
      has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
      has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema_objects,
      has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_use_temp,
      has_table_privilege(current_user, 'public.session', 'SELECT,INSERT,UPDATE,DELETE') AS can_write_session
    FROM pg_roles role
    WHERE role.rolname = current_user
  `)

  const writeRoundTrip = yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client.unsafe(
        "INSERT INTO arforge_schema_migration (id, time_completed) VALUES ($1, $2)",
        [marker, Date.now()],
      )
      yield* client.unsafe(
        "UPDATE arforge_schema_migration SET time_completed = time_completed + 1 WHERE id = $1",
        [marker],
      )
      const selected = yield* client.unsafe<{ id: string }>(
        "SELECT id FROM arforge_schema_migration WHERE id = $1",
        [marker],
      )
      yield* client.unsafe("DELETE FROM arforge_schema_migration WHERE id = $1", [marker])
      return selected[0]?.id === marker
    }),
  )

  const current = role[0]
  if (!current) throw new Error("The current PostgreSQL role was not found")
  const leastPrivilege =
    current.current_user === expectedRole &&
    !current.rolsuper &&
    !current.rolcreatedb &&
    !current.rolcreaterole &&
    !current.rolreplication &&
    !current.rolbypassrls &&
    current.can_connect &&
    current.can_use_schema &&
    !current.can_create_schema_objects &&
    !current.can_use_temp &&
    current.can_write_session &&
    writeRoundTrip

  return {
    database: current.current_database,
    role: current.current_user,
    leastPrivilege,
    writeRoundTrip,
    capabilities: {
      connect: current.can_connect,
      schemaUsage: current.can_use_schema,
      tableReadWrite: current.can_write_session,
    },
    denied: {
      superuser: !current.rolsuper,
      createDatabase: !current.rolcreatedb,
      createRole: !current.rolcreaterole,
      replication: !current.rolreplication,
      bypassRls: !current.rolbypassrls,
      schemaCreate: !current.can_create_schema_objects,
      temporaryTables: !current.can_use_temp,
    },
  }
})

const result = await Effect.runPromise(
  program.pipe(
    Effect.provide(
      PgClient.layer({
        url: Redacted.make(url),
        applicationName: "Arforge role audit",
        maxConnections: 1,
      }),
    ),
  ),
)

if (!result.leastPrivilege) {
  console.error(JSON.stringify(result))
  process.exit(1)
}

console.log(JSON.stringify(result))
