import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadProductEnv } from "../packages/core/src/config/product-env"
import { PostgresSchemaMigrations } from "../packages/core/src/database/postgres-schema.gen"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const injectedAdminUrl = process.env.ARFORGE_DB_ADMIN_URL?.trim()
const envResult = loadProductEnv({ workspaceRoot: root, override: true })
const mainUrl = process.env.ARFORGE_DB_URL?.trim()
const explicitMultiagentUrl = process.env.ARFORGE_MULTIAGENT_DB_URL?.trim()
const adminUrl = injectedAdminUrl || process.env.ARFORGE_DB_ADMIN_URL?.trim()

if (!mainUrl) throw new Error("ARFORGE_DB_URL is not configured in the private environment")

const mainTarget = parsePostgresUrl(mainUrl, "ARFORGE_DB_URL")
const multiagentUrl = explicitMultiagentUrl || deriveMultiagentUrl(mainUrl)
const multiagentTarget = parsePostgresUrl(multiagentUrl, "ARFORGE_MULTIAGENT_DB_URL")
const psql = resolvePsql()
const pendingMarker = resolve(
  root,
  "packages/core/src/database/postgres-migrations/20260728090000_workflow_graph_unified_store/.pending-admin",
)

const main = await inspectDatabase("main", mainUrl)
const multiagent = await inspectDatabase("multiagent", multiagentUrl)
const admin = adminUrl ? await inspectAdmin(adminUrl, mainTarget) : { configured: false as const }
const adminMultiagent = adminUrl
  ? await inspectAdminMultiagent(setDatabase(adminUrl, multiagentTarget.database))
  : { configured: false as const }
const pendingMainMigrations = main.ok
  ? PostgresSchemaMigrations.filter((migration) => !main.migrationLedger.includes(migration.id)).map(
      (migration) => migration.id,
    )
  : []

const report = {
  schemaVersion: 1,
  mode: process.env.ARFORGE_DATABASE_MODE?.trim() || "auto",
  privateEnvironment: {
    source: envResult.source ?? "process",
    loadedKeyCount: envResult.loaded.length,
    skippedKeyCount: envResult.skipped.length,
  },
  topology: {
    selection: explicitMultiagentUrl ? "explicit" : "derived",
    sameDatabase:
      sameServer(mainTarget, multiagentTarget) &&
      mainTarget.database.toLowerCase() === multiagentTarget.database.toLowerCase(),
    main: mainTarget.display,
    multiagent: multiagentTarget.display,
  },
  main,
  multiagent,
  workflowGraph: {
    pendingAdminMarker: existsSync(pendingMarker),
    expectedTables: ["workflow_graph_runs", "workflow_graph_nodes", "workflow_graph_events"],
    installedTableCount: main.ok ? main.workflowGraphTableCount : null,
    ready: main.ok && main.workflowGraphTableCount === 3,
  },
  schema: {
    expectedVersion: PostgresSchemaMigrations.at(-1)?.id ?? null,
    pendingMainMigrations,
    currentLedgerComplete: main.ok && pendingMainMigrations.length === 0,
  },
  admin,
  adminMultiagent,
  decisions: {
    databaseTopologyRequired: !explicitMultiagentUrl,
    multiagentPrivilegeRepairRequired: !multiagent.ok || multiagent.multiagentWritableTableCount !== 2,
    workflowMigrationRequired: !main.ok || main.workflowGraphTableCount !== 3,
    adminConnectionRequired:
      !main.ok ||
      pendingMainMigrations.length > 0 ||
      main.workflowGraphTableCount !== 3 ||
      !multiagent.ok ||
      multiagent.multiagentWritableTableCount !== 2,
  },
  safety: {
    readOnlyInspection: true,
    client: psql,
    secretsPrinted: false,
    schemaOrDataChanged: false,
  },
}

console.log(JSON.stringify(report, null, 2))

type Target = {
  host: string
  port: string
  database: string
  username: string
  password: string
  sslmode?: string
  display: string
}

function parsePostgresUrl(raw: string, variable: string): Target {
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
  if (!parsed.hostname || !database) throw new Error(`${variable} must include a host and database`)
  const username = decodeURIComponent(parsed.username)
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database,
    username,
    password: decodeURIComponent(parsed.password),
    sslmode: parsed.searchParams.get("sslmode") ?? undefined,
    display: `postgresql://${parsed.hostname}:${parsed.port || "5432"}/${database}`,
  }
}

function deriveMultiagentUrl(raw: string) {
  const parsed = new URL(raw)
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))
  parsed.pathname = `/${encodeURIComponent(`${database}_ma`)}`
  return parsed.toString()
}

function setDatabase(raw: string, database: string) {
  const parsed = new URL(raw)
  parsed.pathname = `/${encodeURIComponent(database)}`
  return parsed.toString()
}

function sameServer(left: Target, right: Target) {
  return left.host.toLowerCase() === right.host.toLowerCase() && left.port === right.port
}

async function inspectDatabase(label: string, url: string) {
  const target = parsePostgresUrl(url, label)
  try {
    const first = await runPsqlJson(
      target,
      `
      SELECT json_build_object(
        'database', current_database(),
        'role', current_user,
        'serverVersion', current_setting('server_version'),
        'canCreateSchema', has_schema_privilege(current_user, 'public', 'CREATE'),
        'migrationTable', to_regclass('public.arforge_schema_migration') IS NOT NULL,
        'alembicTable', to_regclass('public.alembic_version') IS NOT NULL,
        'publicTableCount', (
          SELECT count(*)::int
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ),
        'visiblePublicTableCount', (
          SELECT count(*)::int
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ),
        'workflowGraphTableCount', (
          SELECT count(*)::int
          FROM (
            VALUES
              ('workflow_graph_runs'),
              ('workflow_graph_nodes'),
              ('workflow_graph_events')
          ) AS expected(name)
          WHERE to_regclass('public.' || expected.name) IS NOT NULL
        ),
        'multiagentTableCount', (
          SELECT count(*)::int
          FROM (
            VALUES
              ('multiagent_tasks'),
              ('multiagent_conversations')
          ) AS expected(name)
          WHERE to_regclass('public.' || expected.name) IS NOT NULL
        ),
        'multiagentWritableTableCount', (
          SELECT count(*)::int
          FROM (
            VALUES
              ('multiagent_tasks'),
              ('multiagent_conversations')
          ) AS expected(name)
          WHERE
            to_regclass('public.' || expected.name) IS NOT NULL
            AND has_table_privilege(current_user, 'public.' || expected.name, 'SELECT')
            AND has_table_privilege(current_user, 'public.' || expected.name, 'INSERT')
            AND has_table_privilege(current_user, 'public.' || expected.name, 'UPDATE')
            AND has_table_privilege(current_user, 'public.' || expected.name, 'DELETE')
        )
      )
    `,
    )
    const migrations = first.migrationTable
      ? ((
          await runPsqlJson(
            target,
            `
          SELECT json_build_object(
            'ids',
            COALESCE(json_agg(id ORDER BY id), '[]'::json)
          )
          FROM arforge_schema_migration
        `,
          )
        ).ids as unknown[])
      : []
    const defaultAdminCandidate = await runPsqlJson(
      target,
      `
      SELECT json_build_object(
        'role', 'postgres',
        'exists', EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'postgres'),
        'superuser', COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres'), false),
        'canCreateDatabase', COALESCE((SELECT rolcreatedb FROM pg_roles WHERE rolname = 'postgres'), false),
        'canCreateRole', COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = 'postgres'), false)
      )
    `,
    )
    const multiagentRows =
      numberValue(first.multiagentWritableTableCount) === 2
        ? await runPsqlJson(
            target,
            `
            SELECT json_build_object(
              'tasks', (SELECT count(*)::int FROM multiagent_tasks),
              'conversations', (SELECT count(*)::int FROM multiagent_conversations)
            )
          `,
          )
        : null
    return {
      ok: true as const,
      target: target.display,
      database: stringValue(first.database),
      role: stringValue(first.role),
      serverVersion: stringValue(first.serverVersion),
      canCreateSchema: Boolean(first.canCreateSchema),
      publicTableCount: numberValue(first.publicTableCount),
      visiblePublicTableCount: numberValue(first.visiblePublicTableCount),
      workflowGraphTableCount: numberValue(first.workflowGraphTableCount),
      multiagentTableCount: numberValue(first.multiagentTableCount),
      multiagentWritableTableCount: numberValue(first.multiagentWritableTableCount),
      multiagentRows,
      migrationLedger: migrations.map(stringValue),
      alembicLedgerPresent: Boolean(first.alembicTable),
      defaultAdminCandidate,
    }
  } catch (error) {
    return {
      ok: false as const,
      target: target.display,
      error: safeError(error, url),
    }
  }
}

async function inspectAdmin(url: string, main: Target) {
  const target = parsePostgresUrl(url, "ARFORGE_DB_ADMIN_URL")
  try {
    const row = await runPsqlJson(
      target,
      `
      SELECT json_build_object(
        'database', current_database(),
        'role', current_user,
        'superuser', rolsuper,
        'canCreateDatabase', rolcreatedb,
        'canCreateRole', rolcreaterole,
        'canCreateSchema', has_schema_privilege(current_user, 'public', 'CREATE')
      )
      FROM pg_roles
      WHERE rolname = current_user
    `,
    )
    return {
      configured: true as const,
      ok: true as const,
      target: target.display,
      role: stringValue(row.role),
      superuser: Boolean(row.superuser),
      canCreateDatabase: Boolean(row.canCreateDatabase),
      canCreateRole: Boolean(row.canCreateRole),
      canCreateSchema: Boolean(row.canCreateSchema),
      targetsMainDatabase: sameServer(target, main) && target.database.toLowerCase() === main.database.toLowerCase(),
    }
  } catch (error) {
    return {
      configured: true as const,
      ok: false as const,
      target: target.display,
      error: safeError(error, url),
    }
  }
}

async function inspectAdminMultiagent(url: string) {
  const target = parsePostgresUrl(url, "ARFORGE_DB_ADMIN_URL")
  try {
    const row = await runPsqlJson(
      target,
      `
      SELECT json_build_object(
        'database', current_database(),
        'tasks', (SELECT count(*)::int FROM multiagent_tasks),
        'conversations', (SELECT count(*)::int FROM multiagent_conversations),
        'appCanSelectTasks', has_table_privilege('arforge_app', 'public.multiagent_tasks', 'SELECT'),
        'appCanWriteTasks',
          has_table_privilege('arforge_app', 'public.multiagent_tasks', 'INSERT')
          AND has_table_privilege('arforge_app', 'public.multiagent_tasks', 'UPDATE')
          AND has_table_privilege('arforge_app', 'public.multiagent_tasks', 'DELETE'),
        'appCanSelectConversations', has_table_privilege('arforge_app', 'public.multiagent_conversations', 'SELECT'),
        'appCanWriteConversations',
          has_table_privilege('arforge_app', 'public.multiagent_conversations', 'INSERT')
          AND has_table_privilege('arforge_app', 'public.multiagent_conversations', 'UPDATE')
          AND has_table_privilege('arforge_app', 'public.multiagent_conversations', 'DELETE')
      )
    `,
    )
    return {
      configured: true as const,
      ok: true as const,
      target: target.display,
      ...row,
    }
  } catch (error) {
    return {
      configured: true as const,
      ok: false as const,
      target: target.display,
      error: safeError(error, url),
    }
  }
}

async function runPsqlJson(target: Target, query: string) {
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
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `psql exited with code ${code}`)
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)
  if (!line) throw new Error("psql returned no JSON row")
  return JSON.parse(line) as Record<string, unknown>
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

function safeError(error: unknown, secretUrl: string) {
  const parsed = new URL(secretUrl)
  const secret = decodeURIComponent(parsed.password)
  let message = error instanceof Error ? error.message : String(error)
  message = message.replaceAll(secretUrl, parsePostgresUrl(secretUrl, "database").display)
  if (secret) message = message.replaceAll(secret, "***")
  return message.split(/\r?\n/, 1)[0]
}

function numberValue(value: unknown) {
  return typeof value === "bigint" ? Number(value) : Number(value)
}

function stringValue(value: unknown) {
  return value === null || value === undefined ? "" : String(value)
}
