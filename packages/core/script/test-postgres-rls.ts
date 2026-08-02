#!/usr/bin/env bun

import { PgClient } from "@effect/sql-pg"
import { Effect, Redacted } from "effect"
import { loadProductEnv } from "../src/config/product-env"

loadProductEnv()

const appUrl = process.env.ARFORGE_DB_URL?.trim()
const adminUrl = process.env.ARFORGE_DB_ADMIN_URL?.trim()
if (!appUrl) throw new Error("ARFORGE_DB_URL is required")
if (!adminUrl) throw new Error("ARFORGE_DB_ADMIN_URL is required for isolated fixture setup and cleanup")

const businessTables = [
  "account",
  "account_state",
  "control_account",
  "workspace",
  "credential",
  "event_sequence",
  "event",
  "feedback",
  "goal",
  "learning_outcome",
  "learning_pattern",
  "learning_outcome_pattern",
  "memory",
  "permission",
  "project",
  "project_directory",
  "session",
  "session_tag",
  "message",
  "part",
  "todo",
  "session_message",
  "session_checkpoint",
  "scheduled_prompt",
  "session_input",
  "session_context_epoch",
  "session_share",
  "task_graph_task",
  "task_graph_edge",
  "team",
  "team_member",
  "team_message",
  "team_shutdown",
  "workflow_graph_runs",
  "workflow_graph_nodes",
  "workflow_graph_events",
] as const

const suffix = `${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
const fixturePasswordHash =
  "$argon2id$v=19$m=19456,t=2,p=1$DslOhTbBqO3nFXkCIMCK7puUBUgiJZRsFoiJ+L+96LM$j2MMLIvQlEimqSHb4PyWD03mD1lQh+pr2lFyBR3cv84"
const fixture = {
  userA: `usr_rls_a_${suffix}`,
  userB: `usr_rls_b_${suffix}`,
  tenantA: `ten_rls_a_${suffix}`,
  tenantB: `ten_rls_b_${suffix}`,
  rowA: `fdb_rls_a_${suffix}`,
  rowB: `fdb_rls_b_${suffix}`,
  forged: `fdb_rls_forged_${suffix}`,
}
const now = Date.now()

const appLayer = PgClient.layer({
  url: Redacted.make(appUrl),
  applicationName: "Arforge RLS penetration test (application role)",
  maxConnections: 1,
})
const adminLayer = PgClient.layer({
  url: Redacted.make(adminUrl),
  applicationName: "Arforge RLS penetration test (fixture administrator)",
  maxConnections: 1,
})

type Check = { name: string; passed: true; evidence: unknown }
const checks: Check[] = []

function record(name: string, condition: boolean, evidence: unknown) {
  if (!condition) throw new Error(`${name} failed: ${JSON.stringify(evidence)}`)
  checks.push({ name, passed: true, evidence })
}

function denied<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.match({
      onFailure: () => true,
      onSuccess: () => false,
    }),
  )
}

function asPrincipal<A, E, R>(
  client: PgClient.PgClient,
  userID: string,
  tenantID: string,
  effect: Effect.Effect<A, E, R>,
) {
  return client.withTransaction(
    client
      .unsafe(`SELECT set_config('arforge.tenant_id', $1, true), set_config('arforge.user_id', $2, true)`, [
        tenantID,
        userID,
      ])
      .pipe(Effect.andThen(effect)),
  )
}

const setup = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client.unsafe(
        `INSERT INTO identity_user
          (id, email, normalized_email, display_name, password_hash, status, email_verified_at,
           session_epoch, time_created, time_updated)
         VALUES
          ($1, $2, $2, 'RLS test A', $6, 'active', $3, 0, $3, $3),
          ($4, $5, $5, 'RLS test B', $6, 'active', $3, 0, $3, $3)`,
        [
          fixture.userA,
          `rls-a-${suffix}@example.invalid`,
          now,
          fixture.userB,
          `rls-b-${suffix}@example.invalid`,
          fixturePasswordHash,
        ],
      )
      yield* client.unsafe(
        `INSERT INTO identity_tenant (id, name, slug, created_by_user_id, time_created, time_updated)
         VALUES
          ($1, 'RLS tenant A', $2, $3, $4, $4),
          ($5, 'RLS tenant B', $6, $7, $4, $4)`,
        [fixture.tenantA, `rls-a-${suffix}`, fixture.userA, now, fixture.tenantB, `rls-b-${suffix}`, fixture.userB],
      )
      yield* client.unsafe(
        `INSERT INTO identity_tenant_member
          (tenant_id, user_id, role, status, time_created, time_updated)
         VALUES
          ($1, $2, 'owner', 'active', $3, $3),
          ($4, $5, 'owner', 'active', $3, $3)`,
        [fixture.tenantA, fixture.userA, now, fixture.tenantB, fixture.userB],
      )
    }),
  )
}).pipe(Effect.provide(adminLayer))

const penetration = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  const role = yield* client.unsafe<{
    current_user: string
    rolsuper: boolean
    rolbypassrls: boolean
  }>(`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)
  const activeRole = role[0]
  record(
    "application role cannot bypass RLS",
    activeRole?.current_user === "arforge_app" && !activeRole.rolsuper && !activeRole.rolbypassrls,
    activeRole,
  )

  const tableSecurity = yield* client.unsafe<{
    relname: string
    relrowsecurity: boolean
    relforcerowsecurity: boolean
    has_policy: boolean
    tenant_not_null: boolean
    owner_not_null: boolean
  }>(
    `SELECT
       tables.relname,
       tables.relrowsecurity,
       tables.relforcerowsecurity,
       EXISTS (
         SELECT 1 FROM pg_policy policy
         WHERE policy.polrelid = tables.oid AND policy.polname = 'tenant_isolation'
       ) AS has_policy,
       COALESCE((
         SELECT attribute.attnotnull FROM pg_attribute attribute
         WHERE attribute.attrelid = tables.oid AND attribute.attname = 'tenant_id'
       ), false) AS tenant_not_null,
       COALESCE((
         SELECT attribute.attnotnull FROM pg_attribute attribute
         WHERE attribute.attrelid = tables.oid AND attribute.attname = 'owner_user_id'
       ), false) AS owner_not_null
     FROM pg_class tables
     JOIN pg_namespace namespace ON namespace.oid = tables.relnamespace
     WHERE namespace.nspname = 'public' AND tables.relname = ANY($1::text[])
     ORDER BY tables.relname`,
    [businessTables],
  )
  const secureTables = tableSecurity.filter(
    (table) =>
      table.relrowsecurity &&
      table.relforcerowsecurity &&
      table.has_policy &&
      table.tenant_not_null &&
      table.owner_not_null,
  )
  record("all business tables force the tenant policy", secureTables.length === businessTables.length, {
    expected: businessTables.length,
    actual: secureTables.length,
    insecure: tableSecurity.filter((table) => !secureTables.includes(table)).map((table) => table.relname),
  })

  const insertedA = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe<{ tenant_id: string; owner_user_id: string }>(
      `INSERT INTO feedback (id, category, rating, message, workspace_path, time_created)
       VALUES ($1, 'general', 5, 'RLS test row A', '/rls-test/a', $2)
       RETURNING tenant_id, owner_user_id`,
      [fixture.rowA, now],
    ),
  )
  record(
    "same-tenant insert receives request ownership",
    insertedA[0]?.tenant_id === fixture.tenantA && insertedA[0]?.owner_user_id === fixture.userA,
    { rowCount: insertedA.length },
  )

  const aReadsA = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM feedback WHERE id = $1`, [fixture.rowA]),
  )
  record("same-tenant read succeeds", aReadsA[0]?.count === 1, aReadsA[0])

  const aUpdatesA = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe<{ count: number }>(
      `WITH changed AS (
         UPDATE feedback SET message = 'RLS same-tenant update' WHERE id = $1 RETURNING 1
       ) SELECT count(*)::int AS count FROM changed`,
      [fixture.rowA],
    ),
  )
  record("same-tenant update succeeds", aUpdatesA[0]?.count === 1, aUpdatesA[0])

  const bReadsA = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM feedback WHERE id = $1`, [fixture.rowA]),
  )
  record("cross-tenant read returns no rows", bReadsA[0]?.count === 0, bReadsA[0])

  const bUpdatesA = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(
      `WITH changed AS (
         UPDATE feedback SET message = 'cross-tenant attack' WHERE id = $1 RETURNING 1
       ) SELECT count(*)::int AS count FROM changed`,
      [fixture.rowA],
    ),
  )
  record("cross-tenant update affects no rows", bUpdatesA[0]?.count === 0, bUpdatesA[0])

  const bDeletesA = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(
      `WITH changed AS (DELETE FROM feedback WHERE id = $1 RETURNING 1)
       SELECT count(*)::int AS count FROM changed`,
      [fixture.rowA],
    ),
  )
  record("cross-tenant delete affects no rows", bDeletesA[0]?.count === 0, bDeletesA[0])

  const forgedTenant = yield* denied(
    asPrincipal(
      client,
      fixture.userB,
      fixture.tenantB,
      client.unsafe(
        `INSERT INTO feedback
          (id, tenant_id, owner_user_id, category, rating, message, workspace_path, time_created)
         VALUES ($1, $2, $3, 'general', 1, 'forged tenant', '/rls-test/forged', $4)`,
        [fixture.forged, fixture.tenantA, fixture.userA, now],
      ),
    ),
  )
  record("forged cross-tenant insert is rejected", forgedTenant, { rejected: forgedTenant })

  const forgedOwner = yield* denied(
    asPrincipal(
      client,
      fixture.userA,
      fixture.tenantA,
      client.unsafe(
        `INSERT INTO feedback
          (id, tenant_id, owner_user_id, category, rating, message, workspace_path, time_created)
         VALUES ($1, $2, $3, 'general', 1, 'forged owner', '/rls-test/forged-owner', $4)`,
        [fixture.forged, fixture.tenantA, fixture.userB, now],
      ),
    ),
  )
  record("forged row owner is rejected", forgedOwner, { rejected: forgedOwner })

  const unauthorizedMembershipRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM feedback WHERE id = $1`, [fixture.rowA]),
  )
  record(
    "setting another tenant ID without membership reveals no rows",
    unauthorizedMembershipRead[0]?.count === 0,
    unauthorizedMembershipRead[0],
  )

  const insertedB = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ tenant_id: string; owner_user_id: string }>(
      `INSERT INTO feedback (id, category, rating, message, workspace_path, time_created)
       VALUES ($1, 'general', 5, 'RLS test row B', '/rls-test/b', $2)
       RETURNING tenant_id, owner_user_id`,
      [fixture.rowB, now],
    ),
  )
  record(
    "second tenant can write its own row",
    insertedB[0]?.tenant_id === fixture.tenantB && insertedB[0]?.owner_user_id === fixture.userB,
    { rowCount: insertedB.length },
  )

  const aReadsB = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM feedback WHERE id = $1`, [fixture.rowB]),
  )
  record("reverse cross-tenant read returns no rows", aReadsB[0]?.count === 0, aReadsB[0])

  yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(`SELECT 1 FROM feedback WHERE id = $1`, [fixture.rowA]),
  )
  const leakedSetting = yield* client.unsafe<{ user_id: string | null; tenant_id: string | null }>(
    `SELECT
       NULLIF(current_setting('arforge.user_id', true), '') AS user_id,
       NULLIF(current_setting('arforge.tenant_id', true), '') AS tenant_id`,
  )
  const outsideTransaction = yield* client.unsafe<{ count: number }>(
    `SELECT count(*)::int AS count FROM feedback WHERE id = ANY($1::text[])`,
    [[fixture.rowA, fixture.rowB]],
  )
  record(
    "pooled connection does not retain request identity",
    leakedSetting[0]?.user_id === null && leakedSetting[0]?.tenant_id === null && outsideTransaction[0]?.count === 0,
    { settings: leakedSetting[0], visibleFixtureRows: outsideTransaction[0]?.count },
  )

  const rowSecurityOff = yield* denied(
    asPrincipal(
      client,
      fixture.userA,
      fixture.tenantA,
      client
        .unsafe("SET LOCAL row_security = off")
        .pipe(Effect.andThen(client.unsafe(`SELECT id FROM feedback WHERE id = $1`, [fixture.rowA]))),
    ),
  )
  record("application role cannot disable RLS per request", rowSecurityOff, { rejected: rowSecurityOff })

  const alterRls = yield* denied(client.unsafe("ALTER TABLE feedback DISABLE ROW LEVEL SECURITY"))
  record("application role cannot alter the RLS policy", alterRls, { rejected: alterRls })
}).pipe(Effect.provide(appLayer))

const cleanup = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client.unsafe(`DELETE FROM feedback WHERE id = ANY($1::text[])`, [
        [fixture.rowA, fixture.rowB, fixture.forged],
      ])
      yield* client.unsafe(`DELETE FROM identity_tenant_member WHERE user_id = ANY($1::text[])`, [
        [fixture.userA, fixture.userB],
      ])
      yield* client.unsafe(`DELETE FROM identity_tenant WHERE id = ANY($1::text[])`, [
        [fixture.tenantA, fixture.tenantB],
      ])
      yield* client.unsafe(`DELETE FROM identity_user WHERE id = ANY($1::text[])`, [[fixture.userA, fixture.userB]])
    }),
  )

  const residue = yield* client.unsafe<{ feedback: number; users: number; tenants: number }>(
    `SELECT
       (SELECT count(*)::int FROM feedback WHERE id = ANY($1::text[])) AS feedback,
       (SELECT count(*)::int FROM identity_user WHERE id = ANY($2::text[])) AS users,
       (SELECT count(*)::int FROM identity_tenant WHERE id = ANY($3::text[])) AS tenants`,
    [
      [fixture.rowA, fixture.rowB, fixture.forged],
      [fixture.userA, fixture.userB],
      [fixture.tenantA, fixture.tenantB],
    ],
  )
  return residue[0]
}).pipe(Effect.provide(adminLayer))

let failure: unknown
let cleanupFailure: unknown
let residue: { feedback: number; users: number; tenants: number } | undefined
try {
  await Effect.runPromise(setup)
  await Effect.runPromise(penetration)
} catch (error) {
  failure = error
} finally {
  try {
    residue = await Effect.runPromise(cleanup)
  } catch (error) {
    cleanupFailure = error
  }
}

if (cleanupFailure) throw new Error("RLS fixture cleanup failed", { cause: cleanupFailure })
if (!residue || residue.feedback !== 0 || residue.users !== 0 || residue.tenants !== 0) {
  throw new Error(`RLS fixture cleanup failed: ${JSON.stringify(residue)}`, { cause: failure })
}
checks.push({ name: "temporary fixture cleanup", passed: true, evidence: residue })
if (failure) throw failure

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      database: new URL(appUrl).pathname.replace(/^\//, ""),
      applicationRole: "arforge_app",
      businessTableCount: businessTables.length,
      passed: true,
      checkCount: checks.length,
      checks,
      fixturePrefix: `rls_*_${suffix}`,
      secretsPrinted: false,
      cleanupVerified: true,
    },
    null,
    2,
  ),
)
