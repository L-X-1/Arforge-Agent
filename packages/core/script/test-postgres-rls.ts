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
  "control_run_claim",
  "control_run_request_alias",
] as const

const suffix = `${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
const fixturePasswordHash =
  "$argon2id$v=19$m=19456,t=2,p=1$DslOhTbBqO3nFXkCIMCK7puUBUgiJZRsFoiJ+L+96LM$j2MMLIvQlEimqSHb4PyWD03mD1lQh+pr2lFyBR3cv84"
const fixture = {
  userA: `usr_rls_a_${suffix}`,
  userA2: `usr_rls_a2_${suffix}`,
  userB: `usr_rls_b_${suffix}`,
  tenantA: `ten_rls_a_${suffix}`,
  tenantB: `ten_rls_b_${suffix}`,
  rowA: `fdb_rls_a_${suffix}`,
  rowB: `fdb_rls_b_${suffix}`,
  forged: `fdb_rls_forged_${suffix}`,
}
const now = Date.now()

type ControlClaimFixture = {
  readonly bindingDigest: string
  readonly baseBindingDigest: string
  readonly generation: number
  readonly operationID: string
  readonly runID: string
  readonly controlPlaneID: string
  readonly location: string
  readonly projectID: string
  readonly actor: string
  readonly canonicalRequestID: string
  readonly claimDigest: string
  readonly canonicalAuthorizationDigest: string
  readonly canonicalActionID: string
  readonly policyVersion: string
  readonly inputDigest: string
  readonly payloadDigest: string
  readonly createdRunDigest: string
}

type ControlAliasFixture = {
  readonly aliasDigest: string
  readonly requestID: string
  readonly controlPlaneID: string
  readonly bindingDigest: string
  readonly presentedAuthorizationDigest: string
  readonly presentedActionID: string
  readonly presentedSnapshotDigest: string
}

function controlClaim(label: string): ControlClaimFixture {
  return {
    bindingDigest: `binding_${label}_${suffix}`,
    baseBindingDigest: `base_binding_${label}_${suffix}`,
    generation: 0,
    operationID: `cop_${label}_${suffix}`,
    runID: `run_control_${label}_${suffix}`,
    controlPlaneID: `control_plane_${label}_${suffix}`,
    location: `C:/rls-test/${label}/${suffix}`,
    projectID: `project_${label}_${suffix}`,
    actor: `actor_${label}_${suffix}`,
    canonicalRequestID: `request_canonical_${label}_${suffix}`,
    claimDigest: `claim_${label}_${suffix}`,
    canonicalAuthorizationDigest: `authorization_${label}_${suffix}`,
    canonicalActionID: `action_${label}_${suffix}`,
    policyVersion: "rls-test-v1",
    inputDigest: `input_${label}_${suffix}`,
    payloadDigest: `payload_${label}_${suffix}`,
    createdRunDigest: `created_run_${label}_${suffix}`,
  }
}

function controlAlias(label: string, claim: ControlClaimFixture): ControlAliasFixture {
  return {
    aliasDigest: `alias_${label}_${suffix}`,
    requestID: `request_presented_${label}_${suffix}`,
    controlPlaneID: claim.controlPlaneID,
    bindingDigest: claim.bindingDigest,
    presentedAuthorizationDigest: `presented_authorization_${label}_${suffix}`,
    presentedActionID: `presented_action_${label}_${suffix}`,
    presentedSnapshotDigest: `presented_snapshot_${label}_${suffix}`,
  }
}

const claimA = controlClaim("a")
const claimA2 = controlClaim("a2")
const claimB = controlClaim("b")
const duplicateBaseClaim = {
  ...controlClaim("duplicate-base"),
  baseBindingDigest: claimA.baseBindingDigest,
  generation: claimA.generation,
}
const concurrentBase = `base_binding_concurrent_${suffix}`
const concurrentClaimLeft = { ...controlClaim("concurrent-left"), baseBindingDigest: concurrentBase }
const concurrentClaimRight = { ...controlClaim("concurrent-right"), baseBindingDigest: concurrentBase }
const rollbackClaim = controlClaim("rollback")
const aliasA = controlAlias("a", claimA)
const aliasA2 = controlAlias("a2", claimA2)
const aliasB = controlAlias("b", claimB)
const duplicateRequestAlias = { ...controlAlias("duplicate-request", claimA), requestID: aliasA.requestID }
const crossOwnerAlias = controlAlias("cross-owner", claimA)
const crossTenantAlias = controlAlias("cross-tenant", claimA)
const rollbackAlias = controlAlias("rollback", rollbackClaim)

const appLayer = PgClient.layer({
  url: Redacted.make(appUrl),
  applicationName: "Arforge RLS penetration test (application role)",
  maxConnections: 2,
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

function insertControlClaim(client: PgClient.PgClient, claim: ControlClaimFixture, createdSequence = 0) {
  return client.unsafe<{ tenant_id: string; owner_user_id: string; binding_digest: string }>(
    `INSERT INTO control_run_claim (
       binding_digest, base_binding_digest, generation, operation_id, run_id,
       control_plane_id, location, project_id, actor, canonical_request_id,
       claim_digest, canonical_authorization_digest, canonical_action_id,
       policy_version, input_digest, payload_digest, created_run_digest,
       created_sequence, time_created
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13,
       $14, $15, $16, $17,
       $18, $19
     )
     RETURNING tenant_id, owner_user_id, binding_digest`,
    [
      claim.bindingDigest,
      claim.baseBindingDigest,
      claim.generation,
      claim.operationID,
      claim.runID,
      claim.controlPlaneID,
      claim.location,
      claim.projectID,
      claim.actor,
      claim.canonicalRequestID,
      claim.claimDigest,
      claim.canonicalAuthorizationDigest,
      claim.canonicalActionID,
      claim.policyVersion,
      claim.inputDigest,
      claim.payloadDigest,
      claim.createdRunDigest,
      createdSequence,
      now,
    ],
  )
}

function insertControlAlias(client: PgClient.PgClient, alias: ControlAliasFixture) {
  return client.unsafe<{ tenant_id: string; owner_user_id: string; alias_digest: string }>(
    `INSERT INTO control_run_request_alias (
       alias_digest, request_id, control_plane_id, binding_digest,
       presented_authorization_digest, presented_action_id,
       presented_snapshot_digest, time_created
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING tenant_id, owner_user_id, alias_digest`,
    [
      alias.aliasDigest,
      alias.requestID,
      alias.controlPlaneID,
      alias.bindingDigest,
      alias.presentedAuthorizationDigest,
      alias.presentedActionID,
      alias.presentedSnapshotDigest,
      now,
    ],
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
          ($1, $2, $2, 'RLS test A', $8, 'active', $7, 0, $7, $7),
          ($3, $4, $4, 'RLS test A2', $8, 'active', $7, 0, $7, $7),
          ($5, $6, $6, 'RLS test B', $8, 'active', $7, 0, $7, $7)`,
        [
          fixture.userA,
          `rls-a-${suffix}@example.invalid`,
          fixture.userA2,
          `rls-a2-${suffix}@example.invalid`,
          fixture.userB,
          `rls-b-${suffix}@example.invalid`,
          now,
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
          ($1, $2, 'owner', 'active', $6, $6),
          ($1, $3, 'member', 'active', $6, $6),
          ($4, $5, 'owner', 'active', $6, $6)`,
        [fixture.tenantA, fixture.userA, fixture.userA2, fixture.tenantB, fixture.userB, now],
      )
    }),
  )
}).pipe(Effect.provide(adminLayer))

const schemaPreflight = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  const tables = yield* client.unsafe<{ claim: string | null; alias: string | null }>(
    `SELECT
       to_regclass('public.control_run_claim')::text AS claim,
       to_regclass('public.control_run_request_alias')::text AS alias`,
  )
  if (tables[0]?.claim !== "control_run_claim" || tables[0]?.alias !== "control_run_request_alias") {
    throw new Error(
      "ControlRun ClaimIndex PostgreSQL migration is not applied; run db:migrate:postgres before db:test:postgres-rls",
    )
  }
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
    has_credential_owner_policy: boolean
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
       EXISTS (
         SELECT 1 FROM pg_policy policy
         WHERE policy.polrelid = tables.oid AND policy.polname = 'credential_owner_isolation'
       ) AS has_credential_owner_policy,
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
      (table.has_policy || (table.relname === "credential" && table.has_credential_owner_policy)) &&
      table.tenant_not_null &&
      table.owner_not_null,
  )
  record("all business tables force the tenant policy", secureTables.length === businessTables.length, {
    expected: businessTables.length,
    actual: secureTables.length,
    insecure: tableSecurity.filter((table) => !secureTables.includes(table)).map((table) => table.relname),
    credentialPolicy: tableSecurity.find((table) => table.relname === "credential")?.has_credential_owner_policy,
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

  const insertedClaimA = yield* asPrincipal(client, fixture.userA, fixture.tenantA, insertControlClaim(client, claimA))
  record(
    "control claim receives the request owner",
    insertedClaimA[0]?.tenant_id === fixture.tenantA && insertedClaimA[0]?.owner_user_id === fixture.userA,
    insertedClaimA[0],
  )

  const insertedAliasA = yield* asPrincipal(client, fixture.userA, fixture.tenantA, insertControlAlias(client, aliasA))
  record(
    "control request alias receives the request owner",
    insertedAliasA[0]?.tenant_id === fixture.tenantA && insertedAliasA[0]?.owner_user_id === fixture.userA,
    insertedAliasA[0],
  )

  const sameTenantOtherUserReadsClaim = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM control_run_claim WHERE binding_digest = $1`, [
      claimA.bindingDigest,
    ]),
  )
  record(
    "same-tenant different owner cannot read a control claim",
    sameTenantOtherUserReadsClaim[0]?.count === 0,
    sameTenantOtherUserReadsClaim[0],
  )

  const crossTenantReadsClaim = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM control_run_claim WHERE binding_digest = $1`, [
      claimA.bindingDigest,
    ]),
  )
  record("cross-tenant cannot read a control claim", crossTenantReadsClaim[0]?.count === 0, crossTenantReadsClaim[0])

  const crossOwnerAliasRejected = yield* denied(
    asPrincipal(client, fixture.userA2, fixture.tenantA, insertControlAlias(client, crossOwnerAlias)),
  )
  record("same-tenant different owner cannot bind an alias to another owner's claim", crossOwnerAliasRejected, {
    rejected: crossOwnerAliasRejected,
  })

  const crossTenantAliasRejected = yield* denied(
    asPrincipal(client, fixture.userB, fixture.tenantB, insertControlAlias(client, crossTenantAlias)),
  )
  record("cross-tenant cannot bind an alias to another tenant's claim", crossTenantAliasRejected, {
    rejected: crossTenantAliasRejected,
  })

  const duplicateRequestRejected = yield* denied(
    asPrincipal(client, fixture.userA, fixture.tenantA, insertControlAlias(client, duplicateRequestAlias)),
  )
  record("control request alias is immutable per owner request ID", duplicateRequestRejected, {
    rejected: duplicateRequestRejected,
  })

  const duplicateBaseRejected = yield* denied(
    asPrincipal(client, fixture.userA, fixture.tenantA, insertControlClaim(client, duplicateBaseClaim)),
  )
  record("control claim generation is unique per owner base binding", duplicateBaseRejected, {
    rejected: duplicateBaseRejected,
  })

  const concurrentClaimResults = yield* Effect.all(
    [concurrentClaimLeft, concurrentClaimRight].map((claim) =>
      asPrincipal(client, fixture.userA, fixture.tenantA, insertControlClaim(client, claim)).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      ),
    ),
    { concurrency: "unbounded" },
  )
  record(
    "concurrent control claim allocation admits exactly one owner generation",
    concurrentClaimResults.filter(Boolean).length === 1,
    concurrentClaimResults,
  )

  const tablePrivileges = yield* client.unsafe<{
    table_name: string
    can_select: boolean
    can_insert: boolean
    can_update: boolean
    can_delete: boolean
    can_truncate: boolean
  }>(
    `SELECT
       table_name,
       has_table_privilege(current_user, table_name, 'SELECT') AS can_select,
       has_table_privilege(current_user, table_name, 'INSERT') AS can_insert,
       has_table_privilege(current_user, table_name, 'UPDATE') AS can_update,
       has_table_privilege(current_user, table_name, 'DELETE') AS can_delete,
       has_table_privilege(current_user, table_name, 'TRUNCATE') AS can_truncate
     FROM unnest(ARRAY['control_run_claim', 'control_run_request_alias']::text[]) AS table_name
     ORDER BY table_name`,
  )
  record(
    "control claim tables grant the application role SELECT and INSERT only",
    tablePrivileges.length === 2 &&
      tablePrivileges.every(
        (table) =>
          table.can_select && table.can_insert && !table.can_update && !table.can_delete && !table.can_truncate,
      ),
    tablePrivileges,
  )

  const aliasForeignKey = yield* client.unsafe<{
    child_columns: readonly string[]
    parent_columns: readonly string[]
  }>(
    `SELECT
       array_to_json(ARRAY(
         SELECT attribute.attname
         FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
         JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key_column.attnum
         ORDER BY key_column.ordinal
       )) AS child_columns,
       array_to_json(ARRAY(
         SELECT attribute.attname
         FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attnum, ordinal)
         JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.confrelid AND attribute.attnum = key_column.attnum
         ORDER BY key_column.ordinal
       )) AS parent_columns
     FROM pg_constraint constraint_row
     WHERE constraint_row.conname = 'control_run_request_alias_claim_fk'
       AND constraint_row.contype = 'f'`,
  )
  record(
    "control request aliases use an owner-scoped composite claim foreign key",
    aliasForeignKey.length === 1 &&
      aliasForeignKey[0]?.child_columns.join(",") === "tenant_id,owner_user_id,binding_digest" &&
      aliasForeignKey[0]?.parent_columns.join(",") === "tenant_id,owner_user_id,binding_digest",
    aliasForeignKey,
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
      yield* client.unsafe(`DELETE FROM control_run_request_alias WHERE alias_digest = ANY($1::text[])`, [
        [aliasA.aliasDigest],
      ])
      yield* client.unsafe(`DELETE FROM control_run_claim WHERE binding_digest = ANY($1::text[])`, [
        [claimA.bindingDigest, concurrentClaimLeft.bindingDigest, concurrentClaimRight.bindingDigest],
      ])
      yield* client.unsafe(`DELETE FROM identity_tenant_member WHERE user_id = ANY($1::text[])`, [
        [fixture.userA, fixture.userA2, fixture.userB],
      ])
      yield* client.unsafe(`DELETE FROM identity_tenant WHERE id = ANY($1::text[])`, [
        [fixture.tenantA, fixture.tenantB],
      ])
      yield* client.unsafe(`DELETE FROM identity_user WHERE id = ANY($1::text[])`, [
        [fixture.userA, fixture.userA2, fixture.userB],
      ])
    }),
  )

  const residue = yield* client.unsafe<{
    feedback: number
    claims: number
    aliases: number
    users: number
    tenants: number
  }>(
    `SELECT
       (SELECT count(*)::int FROM feedback WHERE id = ANY($1::text[])) AS feedback,
       (SELECT count(*)::int FROM control_run_claim WHERE binding_digest = ANY($2::text[])) AS claims,
       (SELECT count(*)::int FROM control_run_request_alias WHERE alias_digest = ANY($3::text[])) AS aliases,
       (SELECT count(*)::int FROM identity_user WHERE id = ANY($4::text[])) AS users,
       (SELECT count(*)::int FROM identity_tenant WHERE id = ANY($5::text[])) AS tenants`,
    [
      [fixture.rowA, fixture.rowB, fixture.forged],
      [claimA.bindingDigest, concurrentClaimLeft.bindingDigest, concurrentClaimRight.bindingDigest],
      [aliasA.aliasDigest],
      [fixture.userA, fixture.userA2, fixture.userB],
      [fixture.tenantA, fixture.tenantB],
    ],
  )
  return residue[0]
}).pipe(Effect.provide(adminLayer))

let failure: unknown
let cleanupFailure: unknown
let residue: { feedback: number; claims: number; aliases: number; users: number; tenants: number } | undefined
let fixturesMayExist = false
try {
  await Effect.runPromise(schemaPreflight)
  fixturesMayExist = true
  await Effect.runPromise(setup)
  await Effect.runPromise(penetration)
} catch (error) {
  failure = error
} finally {
  if (fixturesMayExist) {
    try {
      residue = await Effect.runPromise(cleanup)
    } catch (error) {
      cleanupFailure = error
    }
  }
}

if (cleanupFailure) throw new Error("RLS fixture cleanup failed", { cause: cleanupFailure })
if (
  fixturesMayExist &&
  (!residue ||
    residue.feedback !== 0 ||
    residue.claims !== 0 ||
    residue.aliases !== 0 ||
    residue.users !== 0 ||
    residue.tenants !== 0)
) {
  throw new Error(`RLS fixture cleanup failed: ${JSON.stringify(residue)}`, { cause: failure })
}
if (fixturesMayExist) checks.push({ name: "temporary fixture cleanup", passed: true, evidence: residue })
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
