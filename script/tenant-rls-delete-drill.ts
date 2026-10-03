import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

type PostgresTarget = {
  readonly host: string
  readonly port: string
  readonly database: string
  readonly username: string
  readonly password: string
  readonly sslmode?: string
  readonly display: string
}

type DrillMarkers = {
  readonly tenantA: string
  readonly tenantB: string
  readonly userA: string
  readonly userB: string
  readonly requestA: string
  readonly requestB: string
  readonly requestDigestA: string
  readonly requestDigestB: string
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parsePostgresUrl(raw: string, variable: string): PostgresTarget {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${variable} is not a valid URL`)
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${variable} must use PostgreSQL`)
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))
  if (!parsed.hostname || !database || !parsed.username) {
    throw new Error(`${variable} must include a host, username, and database`)
  }
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    sslmode: parsed.searchParams.get("sslmode") ?? undefined,
    display: `postgresql://${parsed.hostname}:${parsed.port || "5432"}/${database}`,
  }
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function makeMarkers() {
  const suffix = `${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`
  const tenantA = `ten_stage8_${suffix}_a`
  const tenantB = `ten_stage8_${suffix}_b`
  const userA = `usr_stage8_${suffix}_a`
  const userB = `usr_stage8_${suffix}_b`
  const requestA = `tdr_stage8_${suffix}_a`
  const requestB = `tdr_stage8_${suffix}_b`
  return {
    tenantA,
    tenantB,
    userA,
    userB,
    requestA,
    requestB,
    requestDigestA: digest(requestA),
    requestDigestB: digest(requestB),
  } satisfies DrillMarkers
}

export function buildTenantRlsDeleteDrillSql(markers: DrillMarkers) {
  const now = Date.now()
  const user = (id: string, suffix: string) => `
    INSERT INTO identity_user (
      id, email, normalized_email, display_name, password_hash, status,
      email_verified_at, session_epoch, time_created, time_updated
    ) VALUES (
      ${sqlLiteral(id)}, ${sqlLiteral(`${id}@stage8.invalid`)}, ${sqlLiteral(`${id}@stage8.invalid`)},
      ${sqlLiteral(`Stage 8 drill ${suffix}`)}, '$argon2id$v=19$stage8-drill', 'active',
      ${now}, 0, ${now}, ${now}
    );`
  const tenant = (id: string, userID: string, suffix: string) => `
    INSERT INTO identity_tenant (id, name, slug, created_by_user_id, time_created, time_updated)
    VALUES (${sqlLiteral(id)}, ${sqlLiteral(`Stage 8 drill ${suffix}`)}, ${sqlLiteral(`${id}-slug`)}, ${sqlLiteral(userID)}, ${now}, ${now});
    INSERT INTO identity_tenant_member (tenant_id, user_id, role, status, time_created, time_updated)
    VALUES (${sqlLiteral(id)}, ${sqlLiteral(userID)}, 'owner', 'active', ${now}, ${now});`
  const policy = (tenantID: string, userID: string) => `
    INSERT INTO tenant_policy (tenant_id, owner_user_id, time_created, time_updated)
    VALUES (${sqlLiteral(tenantID)}, ${sqlLiteral(userID)}, ${now}, ${now});`
  const request = (id: string, tenantID: string, userID: string, requestDigest: string) => `
    INSERT INTO tenant_data_request (
      tenant_id, owner_user_id, id, kind, status, requested_by, reason, request_digest, requested_at
    ) VALUES (
      ${sqlLiteral(tenantID)}, ${sqlLiteral(userID)}, ${sqlLiteral(id)}, 'tenant-delete', 'requested',
      ${sqlLiteral(userID)}, 'stage 8 transaction rollback drill', ${sqlLiteral(requestDigest)}, ${now}
    );`

  return `
BEGIN;
SET LOCAL statement_timeout = '10s';
${user(markers.userA, "A")}
${user(markers.userB, "B")}
${tenant(markers.tenantA, markers.userA, "A")}
${tenant(markers.tenantB, markers.userB, "B")}
${policy(markers.tenantA, markers.userA)}
${policy(markers.tenantB, markers.userB)}
${request(markers.requestA, markers.tenantA, markers.userA, markers.requestDigestA)}
${request(markers.requestB, markers.tenantB, markers.userB, markers.requestDigestB)}

SET LOCAL ROLE arforge_app;
SET LOCAL arforge.tenant_id = ${sqlLiteral(markers.tenantA)};
SET LOCAL arforge.user_id = ${sqlLiteral(markers.userA)};

SELECT json_build_object(
  'phase', 'read',
  'visible_policy_rows', (SELECT count(*)::int FROM tenant_policy WHERE tenant_id IN (${sqlLiteral(markers.tenantA)}, ${sqlLiteral(markers.tenantB)})),
  'visible_other_policy_rows', (SELECT count(*)::int FROM tenant_policy WHERE tenant_id = ${sqlLiteral(markers.tenantB)}),
  'visible_data_requests', (SELECT count(*)::int FROM tenant_data_request WHERE id IN (${sqlLiteral(markers.requestA)}, ${sqlLiteral(markers.requestB)})),
  'visible_other_data_requests', (SELECT count(*)::int FROM tenant_data_request WHERE id = ${sqlLiteral(markers.requestB)})
)::text;

WITH deleted AS (
  DELETE FROM tenant_data_request WHERE id = ${sqlLiteral(markers.requestB)} RETURNING id
)
SELECT json_build_object(
  'phase', 'cross_tenant_delete',
  'deleted_rows', (SELECT count(*)::int FROM deleted),
  'visible_other_data_requests_after_delete', (SELECT count(*)::int FROM tenant_data_request WHERE id = ${sqlLiteral(markers.requestB)})
)::text;

WITH deleted AS (
  DELETE FROM tenant_data_request WHERE id = ${sqlLiteral(markers.requestA)} RETURNING id
)
SELECT json_build_object(
  'phase', 'own_tenant_delete',
  'deleted_rows', (SELECT count(*)::int FROM deleted)
)::text;
SELECT json_build_object(
  'phase', 'own_tenant_delete_after',
  'visible_own_data_requests_after_delete', (SELECT count(*)::int FROM tenant_data_request WHERE id = ${sqlLiteral(markers.requestA)})
)::text;

RESET ROLE;
SELECT json_build_object(
  'phase', 'admin_visibility_before_rollback',
  'remaining_setup_requests', (SELECT count(*)::int FROM tenant_data_request WHERE id IN (${sqlLiteral(markers.requestA)}, ${sqlLiteral(markers.requestB)})),
  'remaining_setup_policies', (SELECT count(*)::int FROM tenant_policy WHERE tenant_id IN (${sqlLiteral(markers.tenantA)}, ${sqlLiteral(markers.tenantB)}))
)::text;
ROLLBACK;
`
}

async function runPsql(target: PostgresTarget, query: string) {
  const psql = resolvePsql()
  const child = Bun.spawn(
    [
      psql,
      "--host",
      target.host,
      "--port",
      target.port,
      "--username",
      target.username,
      "--dbname",
      target.database,
      "--no-password",
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      query,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PGPASSWORD: target.password,
        ...(target.sslmode ? { PGSSLMODE: target.sslmode } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    const detail = stderr.trim().split(/\r?\n/, 1)[0] || `psql exited with code ${exitCode}`
    throw new Error(detail)
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function resolvePsql() {
  const configured = process.env.ARFORGE_PSQL_PATH?.trim()
  const programFiles = process.env.ProgramFiles || "C:\\Program Files"
  const candidates = [
    configured,
    ...["18", "17", "16", "15", "14"].map((version) => join(programFiles, "PostgreSQL", version, "bin", "psql.exe")),
  ].filter((item): item is string => Boolean(item))
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error("PostgreSQL psql.exe was not found; set ARFORGE_PSQL_PATH")
  return found
}

function parseJsonLines(lines: ReadonlyArray<string>) {
  return lines.map((line) => {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value)) throw new Error("drill returned invalid JSON")
    return value
  })
}

function numberField(record: JsonRecord, key: string) {
  return typeof record[key] === "number" ? record[key] : null
}

async function main() {
  const args = process.argv.slice(2)
  const outputIndex = args.indexOf("--output")
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "artifacts/stage8-tenant-rls-delete.json"
  if (!outputPath || outputPath.startsWith("--")) throw new Error("--output requires a value")
  const adminRaw = process.env.ARFORGE_DB_ADMIN_URL?.trim()
  if (!adminRaw) throw new Error("ARFORGE_DB_ADMIN_URL is not configured in the private environment")

  const startedAt = new Date().toISOString()
  const markers = makeMarkers()
  const target = parsePostgresUrl(adminRaw, "ARFORGE_DB_ADMIN_URL")
  let transactionLines: JsonRecord[] = []
  let transactionError: string | undefined
  try {
    transactionLines = parseJsonLines(await runPsql(target, buildTenantRlsDeleteDrillSql(markers)))
  } catch (error) {
    transactionError = error instanceof Error ? error.message : String(error)
  }

  let cleanup: JsonRecord | undefined
  let cleanupError: string | undefined
  try {
    const lines = parseJsonLines(
      await runPsql(
        target,
        `SELECT json_build_object(
          'remaining_tenants', (SELECT count(*)::int FROM identity_tenant WHERE id IN (${sqlLiteral(markers.tenantA)}, ${sqlLiteral(markers.tenantB)})),
          'remaining_users', (SELECT count(*)::int FROM identity_user WHERE id IN (${sqlLiteral(markers.userA)}, ${sqlLiteral(markers.userB)})),
          'remaining_memberships', (SELECT count(*)::int FROM identity_tenant_member WHERE tenant_id IN (${sqlLiteral(markers.tenantA)}, ${sqlLiteral(markers.tenantB)})),
          'remaining_policies', (SELECT count(*)::int FROM tenant_policy WHERE tenant_id IN (${sqlLiteral(markers.tenantA)}, ${sqlLiteral(markers.tenantB)})),
          'remaining_requests', (SELECT count(*)::int FROM tenant_data_request WHERE id IN (${sqlLiteral(markers.requestA)}, ${sqlLiteral(markers.requestB)}))
        )::text;`,
      ),
    )
    cleanup = lines[0]
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error)
  }

  const read = transactionLines.find((line) => line.phase === "read")
  const crossDelete = transactionLines.find((line) => line.phase === "cross_tenant_delete")
  const ownDelete = transactionLines.find((line) => line.phase === "own_tenant_delete")
  const ownDeleteAfter = transactionLines.find((line) => line.phase === "own_tenant_delete_after")
  const adminVisibility = transactionLines.find((line) => line.phase === "admin_visibility_before_rollback")
  const checks = {
    tenant_isolation_read:
      numberField(read ?? {}, "visible_policy_rows") === 1 &&
      numberField(read ?? {}, "visible_other_policy_rows") === 0 &&
      numberField(read ?? {}, "visible_data_requests") === 1 &&
      numberField(read ?? {}, "visible_other_data_requests") === 0,
    cross_tenant_delete_blocked:
      numberField(crossDelete ?? {}, "deleted_rows") === 0 &&
      numberField(crossDelete ?? {}, "visible_other_data_requests_after_delete") === 0,
    own_tenant_delete_allowed:
      numberField(ownDelete ?? {}, "deleted_rows") === 1 &&
      numberField(ownDeleteAfter ?? {}, "visible_own_data_requests_after_delete") === 0,
    rollback_preserved_transaction_markers:
      numberField(adminVisibility ?? {}, "remaining_setup_requests") === 1 &&
      numberField(adminVisibility ?? {}, "remaining_setup_policies") === 2,
    rollback_cleanup_verified:
      cleanupError === undefined &&
      numberField(cleanup ?? {}, "remaining_tenants") === 0 &&
      numberField(cleanup ?? {}, "remaining_users") === 0 &&
      numberField(cleanup ?? {}, "remaining_memberships") === 0 &&
      numberField(cleanup ?? {}, "remaining_policies") === 0 &&
      numberField(cleanup ?? {}, "remaining_requests") === 0,
  }
  const passed = transactionError === undefined && Object.values(checks).every(Boolean)
  const report = {
    schema_version: 1,
    status: passed ? "pass" : "fail",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    database: target.display,
    role: target.username,
    transaction: "rolled_back",
    checks,
    transaction_error: transactionError ?? null,
    cleanup_error: cleanupError ?? null,
    observations: {
      read: read ?? null,
      cross_tenant_delete: crossDelete ?? null,
      own_tenant_delete: ownDelete ?? null,
      own_tenant_delete_after: ownDeleteAfter ?? null,
      admin_visibility: adminVisibility ?? null,
      cleanup: cleanup ?? null,
    },
    safety: { unique_markers: true, business_data_committed: false, secrets_printed: false },
  }
  const absoluteOutput = resolve(root, outputPath)
  await writeFile(absoluteOutput, JSON.stringify(report, null, 2) + "\n", "utf8")
  console.log(
    JSON.stringify({
      status: report.status,
      output: absoluteOutput,
      failedChecks: Object.entries(checks)
        .filter(([, value]) => !value)
        .map(([key]) => key),
    }),
  )
  if (!passed) process.exitCode = 1
}

if (import.meta.main) await main()
