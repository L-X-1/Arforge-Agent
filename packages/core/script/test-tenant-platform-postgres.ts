#!/usr/bin/env bun

import { PgClient } from "@effect/sql-pg"
import { Effect, Redacted } from "effect"
import { loadProductEnv } from "../src/config/product-env"

loadProductEnv()

const appUrl = process.env.ARFORGE_DB_URL?.trim()
const adminUrl = process.env.ARFORGE_DB_ADMIN_URL?.trim()
if (!appUrl) throw new Error("ARFORGE_DB_URL is required")
if (!adminUrl) throw new Error("ARFORGE_DB_ADMIN_URL is required for isolated fixture setup and cleanup")

const suffix = `${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
const fixture = {
  userA: `usr_tenant_a_${suffix}`,
  userA2: `usr_tenant_a2_${suffix}`,
  userB: `usr_tenant_b_${suffix}`,
  tenantA: `ten_tenant_a_${suffix}`,
  tenantB: `ten_tenant_b_${suffix}`,
  projectA: `prj_tenant_a_${suffix}`,
  projectB: `prj_tenant_b_${suffix}`,
  sessionA: `ses_tenant_a_${suffix}`,
  feedbackA: `fdb_tenant_a_${suffix}`,
  secretA: "platform.secret.a",
  secretB: "platform.secret.b",
  usageA: `usage_tenant_a_${suffix}`,
  requestA: `req_tenant_a_${suffix}`,
  backupA: `backup_tenant_a_${suffix}`,
  auditA: `audit_tenant_a_${suffix}`,
  credentialA: `cred_tenant_a_${suffix}`,
  credentialA2: `cred_tenant_a2_${suffix}`,
}
const now = Date.now()
const digestA = "a".repeat(64)
const digestB = "b".repeat(64)
const fixturePasswordHash =
  "$argon2id$v=19$m=19456,t=2,p=1$DslOhTbBqO3nFXkCIMCK7puUBUgiJZRsFoiJ+L+96LM$j2MMLIvQlEimqSHb4PyWD03mD1lQh+pr2lFyBR3cv84"

const appLayer = PgClient.layer({
  url: Redacted.make(appUrl),
  applicationName: "Arforge tenant platform RLS penetration test (application role)",
  maxConnections: 2,
})
const adminLayer = PgClient.layer({
  url: Redacted.make(adminUrl),
  applicationName: "Arforge tenant platform RLS fixture administrator",
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
          ($1, $2, $2, 'Tenant platform A', $7, 'active', $6, 0, $6, $6),
          ($3, $4, $4, 'Tenant platform A2', $7, 'active', $6, 0, $6, $6),
          ($5, $8, $8, 'Tenant platform B', $7, 'active', $6, 0, $6, $6)`,
        [
          fixture.userA,
          `tenant-a-${suffix}@example.invalid`,
          fixture.userA2,
          `tenant-a2-${suffix}@example.invalid`,
          fixture.userB,
          now,
          fixturePasswordHash,
          `tenant-b-${suffix}@example.invalid`,
        ],
      )
      yield* client.unsafe(
        `INSERT INTO identity_tenant (id, name, slug, created_by_user_id, time_created, time_updated)
         VALUES
          ($1, 'Tenant platform A', $2, $3, $5, $5),
          ($4, 'Tenant platform B', $6, $7, $5, $5)`,
        [
          fixture.tenantA,
          `tenant-platform-a-${suffix}`,
          fixture.userA,
          fixture.tenantB,
          now,
          `tenant-platform-b-${suffix}`,
          fixture.userB,
        ],
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
      yield* client.unsafe(
        `INSERT INTO project
          (id, worktree, vcs, name, time_created, time_updated, sandboxes, commands, tenant_id, owner_user_id)
         VALUES
          ($1, $2, 'git', 'Tenant project A', $5, $5, '[]', NULL, $3, $6),
          ($7, $8, 'git', 'Tenant project B', $5, $5, '[]', NULL, $4, $9)`,
        [
          fixture.projectA,
          `C:/tenant-platform/a/${suffix}`,
          fixture.tenantA,
          fixture.tenantB,
          now,
          fixture.userA,
          fixture.projectB,
          `C:/tenant-platform/b/${suffix}`,
          fixture.userB,
        ],
      )
      yield* client.unsafe(
        `INSERT INTO session
          (id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output,
           tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated,
           tenant_id, owner_user_id)
         VALUES ($1, $2, 'tenant-a-session', $3, 'Tenant session A', '1', 0, 0, 0, 0, 0, 0, $4, $4, $5, $6)`,
        [
          fixture.sessionA,
          fixture.projectA,
          `C:/tenant-platform/a/session/${suffix}`,
          now,
          fixture.tenantA,
          fixture.userA,
        ],
      )
      yield* client.unsafe(
        `INSERT INTO tenant_project_member
          (tenant_id, project_id, user_id, role, status, time_created, time_updated)
         VALUES ($1, $2, $3, 'viewer', 'active', $4, $4)`,
        [fixture.tenantA, fixture.projectA, fixture.userA2, now],
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
  record(
    "platform test uses a non-bypass application role",
    role[0]?.current_user === "arforge_app" && !role[0].rolsuper && !role[0].rolbypassrls,
    role[0],
  )

  const advisoryLock = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ locked: boolean }>(
      `WITH lock_acquired AS (
         SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
       )
       SELECT true AS locked FROM lock_acquired`,
      [fixture.tenantA],
    ),
  )
  record("application role can acquire the tenant transaction lock", advisoryLock[0]?.locked ?? false, advisoryLock[0])

  const policyA = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe<{ tenant_id: string; owner_user_id: string }>(
      `INSERT INTO tenant_policy
        (tenant_id, owner_user_id, region, retention_days, quota_currency, quota_limit_minor,
         rate_limit_per_minute, rate_limit_burst, key_version, revision, time_created, time_updated)
       VALUES ($1, $2, 'cn-self-hosted', 180, 'USD', 100, 2, 1, 1, 1, $3, $3)
       RETURNING tenant_id, owner_user_id`,
      [fixture.tenantA, fixture.userA, now],
    ),
  )
  record(
    "tenant A policy receives request ownership",
    policyA[0]?.tenant_id === fixture.tenantA && policyA[0]?.owner_user_id === fixture.userA,
    { rowCount: policyA.length },
  )
  yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe(
      `INSERT INTO tenant_policy
        (tenant_id, owner_user_id, region, retention_days, quota_currency, quota_limit_minor,
         rate_limit_per_minute, rate_limit_burst, key_version, revision, time_created, time_updated)
       VALUES ($1, $2, 'other-region', 30, 'USD', 100, 1, 1, 1, 1, $3, $3)`,
      [fixture.tenantB, fixture.userB, now],
    ),
  )

  const tenantASeesOnlyOwnPolicy = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_policy`),
  )
  record(
    "tenant member sees only its tenant policy",
    tenantASeesOnlyOwnPolicy[0]?.count === 1,
    tenantASeesOnlyOwnPolicy[0],
  )
  const tenantBSeesNoTenantA = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_policy WHERE tenant_id = $1`, [
      fixture.tenantA,
    ]),
  )
  record("cross-tenant policy read returns no rows", tenantBSeesNoTenantA[0]?.count === 0, tenantBSeesNoTenantA[0])
  const forgedPolicy = yield* denied(
    asPrincipal(
      client,
      fixture.userB,
      fixture.tenantB,
      client.unsafe(
        `INSERT INTO tenant_policy
          (tenant_id, owner_user_id, region, retention_days, quota_currency, rate_limit_per_minute,
           rate_limit_burst, key_version, revision, time_created, time_updated)
         VALUES ($1, $2, 'forged', 30, 'USD', 1, 1, 1, 1, $3, $3)`,
        [fixture.tenantA, fixture.userB, now],
      ),
    ),
  )
  record("forged tenant policy insert is rejected", forgedPolicy, { rejected: forgedPolicy })

  yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO credential
        (tenant_id, owner_user_id, id, integration_id, label, value, encrypted_value,
         value_key_version, value_fingerprint, time_created, time_updated)
       VALUES ($1, $2, $3, 'fixture-provider', 'Owner fixture', '{"type":"key","key":""}',
               'v1.fixture-owner', 1, $4, $5, $5)`,
      [fixture.tenantA, fixture.userA, fixture.credentialA, digestA, now],
    ),
  )
  yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO credential
        (tenant_id, owner_user_id, id, integration_id, label, value, encrypted_value,
         value_key_version, value_fingerprint, time_created, time_updated)
       VALUES ($1, $2, $3, 'fixture-provider', 'Member fixture', '{"type":"key","key":""}',
               'v1.fixture-member', 1, $4, $5, $5)`,
      [fixture.tenantA, fixture.userA2, fixture.credentialA2, digestB, now],
    ),
  )
  const memberCredentials = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ id: string }>(`SELECT id FROM credential ORDER BY id`),
  )
  record(
    "ordinary tenant member sees only its own credential row",
    memberCredentials.length === 1 && memberCredentials[0]?.id === fixture.credentialA2,
    { ids: memberCredentials.map((row) => row.id) },
  )
  const adminCredentials = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM credential`),
  )
  record("tenant owner can audit tenant credential metadata", adminCredentials[0]?.count === 2, adminCredentials[0])
  const crossTenantCredentials = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM credential WHERE id = ANY($1::text[])`, [
      [fixture.credentialA, fixture.credentialA2],
    ]),
  )
  record(
    "cross-tenant credential read returns no rows",
    crossTenantCredentials[0]?.count === 0,
    crossTenantCredentials[0],
  )
  const forgedCredentialOwner = yield* denied(
    asPrincipal(
      client,
      fixture.userA2,
      fixture.tenantA,
      client.unsafe(
        `INSERT INTO credential
          (tenant_id, owner_user_id, id, integration_id, label, value, time_created, time_updated)
         VALUES ($1, $2, $3, 'forged-provider', 'Forged owner', '{"type":"key","key":""}', $4, $4)`,
        [fixture.tenantA, fixture.userA, `cred_forged_${suffix}`, now],
      ),
    ),
  )
  record("tenant member cannot forge credential ownership", forgedCredentialOwner, { rejected: forgedCredentialOwner })

  const secretA = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO tenant_secret
        (tenant_id, owner_user_id, secret_id, key_version, ciphertext, fingerprint, status, time_created, time_updated)
       VALUES ($1, $2, $3, 1, 'ciphertext-a', $4, 'active', $5, $5)
       RETURNING secret_id`,
      [fixture.tenantA, fixture.userA, fixture.secretA, digestA, now],
    ),
  )
  record("tenant secret is insertable by the tenant owner", secretA.length === 1, { rowCount: secretA.length })
  yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe(
      `INSERT INTO tenant_secret
        (tenant_id, owner_user_id, secret_id, key_version, ciphertext, fingerprint, status, time_created, time_updated)
       VALUES ($1, $2, $3, 1, 'ciphertext-b', $4, 'active', $5, $5)`,
      [fixture.tenantB, fixture.userB, fixture.secretB, digestB, now],
    ),
  )
  const memberReadsSecretMetadata = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_secret WHERE secret_id = $1`, [
      fixture.secretA,
    ]),
  )
  record(
    "tenant member can read tenant secret metadata",
    memberReadsSecretMetadata[0]?.count === 1,
    memberReadsSecretMetadata[0],
  )
  const crossTenantSecretRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_secret WHERE tenant_id = $1`, [
      fixture.tenantA,
    ]),
  )
  record("cross-tenant secret read returns no rows", crossTenantSecretRead[0]?.count === 0, crossTenantSecretRead[0])
  const memberSecretMutation = yield* denied(
    asPrincipal(
      client,
      fixture.userA2,
      fixture.tenantA,
      client.unsafe(`UPDATE tenant_secret SET status = 'revoked' WHERE secret_id = $1`, [fixture.secretA]),
    ),
  )
  record("non-admin member cannot revoke another owner's secret", memberSecretMutation, {
    rejected: memberSecretMutation,
  })
  yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(`UPDATE tenant_secret SET status = 'revoked', revoked_at = $2 WHERE secret_id = $1`, [
      fixture.secretA,
      now,
    ]),
  )

  const memberProjectRead = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM project WHERE id = $1`, [fixture.projectA]),
  )
  record("project membership grants project read access", memberProjectRead[0]?.count === 1, memberProjectRead[0])
  const crossTenantProjectRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM project WHERE id = $1`, [fixture.projectA]),
  )
  record("cross-tenant project read returns no rows", crossTenantProjectRead[0]?.count === 0, crossTenantProjectRead[0])
  const memberSessionRead = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM session WHERE id = $1`, [fixture.sessionA]),
  )
  record("project membership grants session read access", memberSessionRead[0]?.count === 1, memberSessionRead[0])
  const crossTenantSessionRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM session WHERE id = $1`, [fixture.sessionA]),
  )
  record("cross-tenant session read returns no rows", crossTenantSessionRead[0]?.count === 0, crossTenantSessionRead[0])
  const forgedMembership = yield* denied(
    asPrincipal(
      client,
      fixture.userA2,
      fixture.tenantA,
      client.unsafe(
        `INSERT INTO tenant_project_member
          (tenant_id, project_id, user_id, role, status, time_created, time_updated)
         VALUES ($1, $2, $3, 'editor', 'active', $4, $4)`,
        [fixture.tenantA, fixture.projectA, fixture.userB, now],
      ),
    ),
  )
  record("non-admin member cannot grant project membership", forgedMembership, { rejected: forgedMembership })

  const feedbackA = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO feedback
        (id, category, rating, message, workspace_path, session_id, time_created)
       VALUES ($1, 'general', 5, 'tenant platform session feedback', $2, $3, $4)
       RETURNING id`,
      [fixture.feedbackA, `C:/tenant-platform/a/${suffix}`, fixture.sessionA, now],
    ),
  )
  record("session member can create session-scoped feedback", feedbackA.length === 1, { rowCount: feedbackA.length })
  const crossTenantFeedbackRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM feedback WHERE id = $1`, [fixture.feedbackA]),
  )
  record(
    "cross-tenant session feedback read returns no rows",
    crossTenantFeedbackRead[0]?.count === 0,
    crossTenantFeedbackRead[0],
  )

  yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO tenant_rate_window
        (tenant_id, owner_user_id, bucket, window_started_at, request_count, time_updated)
       VALUES ($1, $2, 'api', $3, 1, $3)`,
      [fixture.tenantA, fixture.userA, now],
    ),
  )
  yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe(
      `INSERT INTO tenant_rate_window
        (tenant_id, owner_user_id, bucket, window_started_at, request_count, time_updated)
       VALUES ($1, $2, 'api', $3, 1, $3)`,
      [fixture.tenantB, fixture.userB, now],
    ),
  )
  const isolatedRateWindows = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_rate_window WHERE bucket = 'api'`),
  )
  record("rate windows are isolated per tenant", isolatedRateWindows[0]?.count === 1, isolatedRateWindows[0])

  const usageA = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO tenant_usage_ledger
        (tenant_id, owner_user_id, id, settlement_id, run_id, currency, amount_minor, recorded_at)
       VALUES ($1, $2, $3, 'settlement-a', 'run-a', 'USD', 80, $4)
       RETURNING id`,
      [fixture.tenantA, fixture.userA, fixture.usageA, now],
    ),
  )
  record("settled usage ledger accepts a new settlement", usageA.length === 1, { rowCount: usageA.length })
  const duplicateUsage = yield* denied(
    asPrincipal(
      client,
      fixture.userA,
      fixture.tenantA,
      client.unsafe(
        `INSERT INTO tenant_usage_ledger
          (tenant_id, owner_user_id, id, settlement_id, run_id, currency, amount_minor, recorded_at)
         VALUES ($1, $2, $3, 'settlement-a', 'run-a-replay', 'USD', 80, $4)`,
        [fixture.tenantA, fixture.userA, `${fixture.usageA}-replay`, now],
      ),
    ),
  )
  record("settled usage settlement identity is idempotent", duplicateUsage, { rejected: duplicateUsage })
  const crossTenantUsageRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_usage_ledger WHERE tenant_id = $1`, [
      fixture.tenantA,
    ]),
  )
  record("cross-tenant usage read returns no rows", crossTenantUsageRead[0]?.count === 0, crossTenantUsageRead[0])

  const requestA = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO tenant_data_request
        (tenant_id, owner_user_id, id, kind, status, requested_by, reason, request_digest, requested_at)
       VALUES ($1, $2, $3, 'tenant-delete', 'requested', $2, 'test deletion request', $4, $5)
       RETURNING id, owner_user_id`,
      [fixture.tenantA, fixture.userA2, fixture.requestA, digestA, now],
    ),
  )
  record("member can create a deletion request for its tenant", requestA.length === 1, { rowCount: requestA.length })
  yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(
      `UPDATE tenant_data_request
       SET status = 'approved', approved_by = $2
       WHERE id = $1`,
      [fixture.requestA, fixture.userA],
    ),
  )
  const approvedRequest = yield* asPrincipal(
    client,
    fixture.userA2,
    fixture.tenantA,
    client.unsafe<{ status: string; approved_by: string | null }>(
      `SELECT status, approved_by FROM tenant_data_request WHERE id = $1`,
      [fixture.requestA],
    ),
  )
  record(
    "tenant admin can approve a member deletion request",
    approvedRequest[0]?.status === "approved" && approvedRequest[0]?.approved_by === fixture.userA,
    approvedRequest[0],
  )
  const crossTenantRequestRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_data_request WHERE id = $1`, [
      fixture.requestA,
    ]),
  )
  record(
    "cross-tenant deletion request read returns no rows",
    crossTenantRequestRead[0]?.count === 0,
    crossTenantRequestRead[0],
  )

  const backupA = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO tenant_backup_manifest
        (tenant_id, owner_user_id, id, region, schema_revision, artifact_digest, status, created_at)
       VALUES ($1, $2, $3, 'cn-self-hosted', '20260814091000', $4, 'created', $5)
       RETURNING id`,
      [fixture.tenantA, fixture.userA, fixture.backupA, digestB, now],
    ),
  )
  record("tenant backup manifest is tenant-scoped", backupA.length === 1, { rowCount: backupA.length })
  const auditA = yield* asPrincipal(
    client,
    fixture.userA,
    fixture.tenantA,
    client.unsafe(
      `INSERT INTO tenant_audit_export
        (tenant_id, owner_user_id, id, requested_by, item_count, export_digest, created_at)
       VALUES ($1, $2, $3, $2, 0, $4, $5)
       RETURNING id`,
      [fixture.tenantA, fixture.userA, fixture.auditA, digestA, now],
    ),
  )
  record("tenant audit export receipt is tenant-scoped", auditA.length === 1, { rowCount: auditA.length })
  const crossTenantBackupRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_backup_manifest WHERE id = $1`, [
      fixture.backupA,
    ]),
  )
  record("cross-tenant backup read returns no rows", crossTenantBackupRead[0]?.count === 0, crossTenantBackupRead[0])
  const crossTenantAuditRead = yield* asPrincipal(
    client,
    fixture.userB,
    fixture.tenantB,
    client.unsafe<{ count: number }>(`SELECT count(*)::int AS count FROM tenant_audit_export WHERE id = $1`, [
      fixture.auditA,
    ]),
  )
  record(
    "cross-tenant audit export read returns no rows",
    crossTenantAuditRead[0]?.count === 0,
    crossTenantAuditRead[0],
  )
}).pipe(Effect.provide(appLayer))

const cleanup = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client.unsafe(`DELETE FROM feedback WHERE id = $1`, [fixture.feedbackA])
      yield* client.unsafe(`DELETE FROM tenant_audit_export WHERE id = $1`, [fixture.auditA])
      yield* client.unsafe(`DELETE FROM tenant_backup_manifest WHERE id = $1`, [fixture.backupA])
      yield* client.unsafe(`DELETE FROM tenant_data_request WHERE id = $1`, [fixture.requestA])
      yield* client.unsafe(`DELETE FROM tenant_usage_ledger WHERE id = $1`, [fixture.usageA])
      yield* client.unsafe(`DELETE FROM tenant_rate_window WHERE tenant_id = ANY($1::text[])`, [
        [fixture.tenantA, fixture.tenantB],
      ])
      yield* client.unsafe(`DELETE FROM tenant_secret WHERE tenant_id = ANY($1::text[])`, [
        [fixture.tenantA, fixture.tenantB],
      ])
      yield* client.unsafe(`DELETE FROM tenant_key WHERE tenant_id = ANY($1::text[])`, [
        [fixture.tenantA, fixture.tenantB],
      ])
      yield* client.unsafe(`DELETE FROM tenant_policy WHERE tenant_id = ANY($1::text[])`, [
        [fixture.tenantA, fixture.tenantB],
      ])
      yield* client.unsafe(`DELETE FROM tenant_project_member WHERE project_id = ANY($1::text[])`, [
        [fixture.projectA, fixture.projectB],
      ])
      yield* client.unsafe(`DELETE FROM credential WHERE id = ANY($1::text[])`, [
        [fixture.credentialA, fixture.credentialA2],
      ])
      yield* client.unsafe(`DELETE FROM session WHERE id = $1`, [fixture.sessionA])
      yield* client.unsafe(`DELETE FROM project WHERE id = ANY($1::text[])`, [[fixture.projectA, fixture.projectB]])
      yield* client.unsafe(`DELETE FROM identity_tenant_member WHERE tenant_id = ANY($1::text[])`, [
        [fixture.tenantA, fixture.tenantB],
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
    users: number
    tenants: number
    projects: number
    sessions: number
    secrets: number
    usage: number
    requests: number
    backups: number
    audit: number
    credentials: number
  }>(
    `SELECT
       (SELECT count(*)::int FROM identity_user WHERE id = ANY($1::text[])) AS users,
       (SELECT count(*)::int FROM identity_tenant WHERE id = ANY($2::text[])) AS tenants,
       (SELECT count(*)::int FROM project WHERE id = ANY($3::text[])) AS projects,
       (SELECT count(*)::int FROM session WHERE id = $4) AS sessions,
       (SELECT count(*)::int FROM tenant_secret WHERE tenant_id = ANY($2::text[])) AS secrets,
       (SELECT count(*)::int FROM tenant_usage_ledger WHERE tenant_id = ANY($2::text[])) AS usage,
       (SELECT count(*)::int FROM tenant_data_request WHERE tenant_id = ANY($2::text[])) AS requests,
       (SELECT count(*)::int FROM tenant_backup_manifest WHERE tenant_id = ANY($2::text[])) AS backups,
        (SELECT count(*)::int FROM tenant_audit_export WHERE tenant_id = ANY($2::text[])) AS audit,
        (SELECT count(*)::int FROM credential WHERE id = ANY($5::text[])) AS credentials`,
    [
      [fixture.userA, fixture.userA2, fixture.userB],
      [fixture.tenantA, fixture.tenantB],
      [fixture.projectA, fixture.projectB],
      fixture.sessionA,
      [fixture.credentialA, fixture.credentialA2],
    ],
  )
  return residue[0]
}).pipe(Effect.provide(adminLayer))

let failure: unknown
let cleanupFailure: unknown
let residue:
  | {
      users: number
      tenants: number
      projects: number
      sessions: number
      secrets: number
      usage: number
      requests: number
      backups: number
      audit: number
      credentials: number
    }
  | undefined
let fixturesMayExist = false
try {
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

if (cleanupFailure) throw new Error("Tenant platform fixture cleanup failed", { cause: cleanupFailure })
if (
  fixturesMayExist &&
  (!residue ||
    residue.users !== 0 ||
    residue.tenants !== 0 ||
    residue.projects !== 0 ||
    residue.sessions !== 0 ||
    residue.secrets !== 0 ||
    residue.usage !== 0 ||
    residue.requests !== 0 ||
    residue.backups !== 0 ||
    residue.audit !== 0 ||
    residue.credentials !== 0)
) {
  throw new Error(`Tenant platform fixture cleanup failed: ${JSON.stringify(residue)}`, { cause: failure })
}
if (fixturesMayExist)
  checks.push({ name: "temporary tenant platform fixture cleanup", passed: true, evidence: residue })
if (failure) throw failure

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      database: new URL(appUrl).pathname.replace(/^\//, ""),
      applicationRole: "arforge_app",
      passed: true,
      checkCount: checks.length,
      checks,
      fixturePrefix: `tenant_*_${suffix}`,
      secretsPrinted: false,
      cleanupVerified: true,
    },
    null,
    2,
  ),
)
