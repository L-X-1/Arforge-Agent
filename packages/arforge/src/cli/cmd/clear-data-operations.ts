import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export type ClearDataScope = "workspace" | "all"
export type ClearDataPlanStatus = "planned" | "executing" | "completed" | "failed"

export interface ClearDataInventory {
  readonly records: Readonly<Record<string, number>>
  readonly total: number
}

export interface ClearDataBackup {
  readonly backup: string
  readonly manifest: string
  readonly sha256: string
  readonly bytes: number
  readonly encryption: string
  readonly authentication: string
  readonly restoreListVerified: boolean
}

export interface ClearDataPlan {
  readonly schemaVersion: 1
  readonly product: "Arforge"
  readonly id: string
  readonly scope: ClearDataScope
  readonly workspace?: string
  readonly databaseFingerprint: string
  readonly inventory: ClearDataInventory
  readonly backup: ClearDataBackup
  readonly confirmationHash: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly status: ClearDataPlanStatus
  readonly completedAt?: string
  readonly failure?: string
}

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type ProcessRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly stdin?: string
  },
) => Promise<ProcessResult>

export interface ClearDataDependencies {
  readonly now: () => Date
  readonly id: () => string
  readonly nonce: () => string
  readonly run: ProcessRunner
}

export interface CreateClearDataPlanOptions {
  readonly scope: ClearDataScope
  readonly workspace?: string
  readonly databaseUrl: string
  readonly adminDatabaseUrl?: string
  readonly planDirectory: string
  readonly backupDirectory?: string
  readonly postgresBin?: string
  readonly keyFile?: string
  readonly backupScript: string
}

export interface ExecuteClearDataPlanOptions {
  readonly planID: string
  readonly confirmation: string
  readonly databaseUrl: string
  readonly adminDatabaseUrl?: string
  readonly planDirectory: string
  readonly postgresBin?: string
}

const preservedTables = new Set([
  "account",
  "account_state",
  "arforge_schema_migration",
  "control_account",
  "credential",
  "data_migration",
])

export const allBusinessTables = [
  "event",
  "event_sequence",
  "feedback",
  "goal",
  "learning_outcome_pattern",
  "learning_outcome",
  "learning_pattern",
  "memory",
  "permission",
  "project_directory",
  "workspace",
  "message",
  "part",
  "scheduled_prompt",
  "session_checkpoint",
  "session_context_epoch",
  "session_input",
  "session_message",
  "session_tag",
  "todo",
  "session_share",
  "task_graph_edge",
  "task_graph_task",
  "team_member",
  "team_message",
  "team_shutdown",
  "team",
  "session",
  "project",
] as const

for (const table of allBusinessTables) {
  if (preservedTables.has(table)) throw new Error(`Clear-data table policy overlaps preserved table: ${table}`)
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isClearDataPlan(value: unknown): value is ClearDataPlan {
  if (!isRecord(value) || !isRecord(value.inventory) || !isRecord(value.backup)) return false
  return (
    value.schemaVersion === 1 &&
    value.product === "Arforge" &&
    typeof value.id === "string" &&
    (value.scope === "workspace" || value.scope === "all") &&
    (value.workspace === undefined || typeof value.workspace === "string") &&
    typeof value.databaseFingerprint === "string" &&
    isRecord(value.inventory.records) &&
    typeof value.inventory.total === "number" &&
    typeof value.backup.backup === "string" &&
    typeof value.backup.manifest === "string" &&
    typeof value.backup.sha256 === "string" &&
    typeof value.backup.bytes === "number" &&
    typeof value.backup.encryption === "string" &&
    typeof value.backup.authentication === "string" &&
    typeof value.backup.restoreListVerified === "boolean" &&
    typeof value.confirmationHash === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.expiresAt === "string" &&
    ["planned", "executing", "completed", "failed"].includes(String(value.status))
  )
}

function safeMessage(value: string) {
  return value
    .replace(/\b(postgresql|postgres):\/\/[^\s]+/gi, "$1://[REDACTED]")
    .replace(/\b(password|passwd|pwd|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, 1_000)
}

function databaseConnection(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("数据库连接地址无效")
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("clear-data 仅支持 PostgreSQL；SQLite 不能进入私人数据清理流程")
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""))
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!url.hostname || !database || !username || !password) {
    throw new Error("PostgreSQL 地址必须包含主机、数据库、用户名和密码")
  }
  return {
    host: url.hostname,
    port: url.port || "5432",
    database,
    username,
    password,
    identity: `${url.hostname.toLocaleLowerCase("en-US")}:${url.port || "5432"}/${database}`,
  }
}

export function databaseFingerprint(value: string) {
  return sha256(databaseConnection(value).identity)
}

export function normalizeClearWorkspace(value: string) {
  const resolved = path.resolve(value)
  if (!path.isAbsolute(resolved)) throw new Error("工作区必须是绝对路径")
  return process.platform === "win32" ? resolved.replaceAll("\\", "/") : resolved
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function workspacePredicate(column: string, workspace: string) {
  const literal = sqlLiteral(workspace)
  return process.platform === "win32" ? `lower(${column}) = lower(${literal})` : `${column} = ${literal}`
}

function targetSessionPredicate(workspace: string) {
  const directory = workspacePredicate("s.directory", workspace)
  const workspaceDirectory = workspacePredicate("w.directory", workspace)
  return `(${directory} OR s.workspace_id IN (SELECT w.id FROM workspace w WHERE ${workspaceDirectory}))`
}

function jsonInventoryQuery(entries: ReadonlyArray<readonly [string, string]>) {
  return `SELECT json_build_object(${entries
    .flatMap(([name, query]) => [sqlLiteral(name), `(SELECT count(*)::bigint FROM ${query})`])
    .join(", ")});`
}

export function buildInventorySql(scope: ClearDataScope, workspace?: string) {
  if (scope === "all") {
    return jsonInventoryQuery(allBusinessTables.map((table) => [table, `"${table}"`] as const))
  }
  if (!workspace) throw new Error("workspace 范围需要工作区路径")
  const sessionPredicate = targetSessionPredicate(workspace)
  const workspacePath = workspacePredicate("workspace_path", workspace)
  const directory = workspacePredicate("directory", workspace)
  return jsonInventoryQuery([
    ["session", `session s WHERE ${sessionPredicate}`],
    ["feedback", `feedback WHERE ${workspacePath}`],
    ["learning_outcome", `learning_outcome WHERE ${workspacePath}`],
    ["learning_pattern", `learning_pattern WHERE ${workspacePath}`],
    ["memory", `memory WHERE ${workspacePath}`],
    ["workspace", `workspace WHERE ${directory}`],
    ["project_directory", `project_directory WHERE ${directory}`],
  ])
}

export function buildMutationSql(scope: ClearDataScope, workspace?: string) {
  if (scope === "all") {
    const tables = allBusinessTables.map((table) => `"${table}"`).join(", ")
    return `BEGIN;\nTRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;\nCOMMIT;`
  }
  if (!workspace) throw new Error("workspace 范围需要工作区路径")
  const sessionPredicate = targetSessionPredicate(workspace)
  const workspacePath = workspacePredicate("workspace_path", workspace)
  const directory = workspacePredicate("directory", workspace)
  return [
    "BEGIN;",
    `DELETE FROM feedback WHERE ${workspacePath} OR session_id IN (SELECT s.id FROM session s WHERE ${sessionPredicate});`,
    `DELETE FROM event_sequence WHERE owner_id IN (SELECT s.id FROM session s WHERE ${sessionPredicate});`,
    `DELETE FROM learning_outcome WHERE ${workspacePath};`,
    `DELETE FROM learning_pattern WHERE ${workspacePath};`,
    `DELETE FROM memory WHERE ${workspacePath};`,
    `DELETE FROM session WHERE id IN (SELECT s.id FROM session s WHERE ${sessionPredicate});`,
    `DELETE FROM workspace WHERE ${directory};`,
    `DELETE FROM project_directory WHERE ${directory};`,
    "COMMIT;",
  ].join("\n")
}

export const defaultProcessRunner: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
    child.stdin.end(options.stdin ?? "")
  })

const defaults: ClearDataDependencies = {
  now: () => new Date(),
  id: () => randomUUID(),
  nonce: () => randomBytes(4).toString("hex").toUpperCase(),
  run: defaultProcessRunner,
}

function psqlExecutable(postgresBin?: string) {
  return postgresBin ? path.join(postgresBin, process.platform === "win32" ? "psql.exe" : "psql") : "psql"
}

async function runPsql(
  runner: ProcessRunner,
  databaseUrl: string,
  sql: string,
  postgresBin?: string,
) {
  const connection = databaseConnection(databaseUrl)
  const result = await runner(
    psqlExecutable(postgresBin),
    [
      "--host",
      connection.host,
      "--port",
      connection.port,
      "--username",
      connection.username,
      "--dbname",
      connection.database,
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    {
      env: { ...process.env, PGPASSWORD: connection.password },
      stdin: sql,
    },
  )
  if (result.exitCode !== 0) {
    throw new Error(`PostgreSQL 操作失败：${safeMessage(result.stderr || result.stdout)}`)
  }
  return result.stdout.trim()
}

function assertAdminTarget(databaseUrl: string, adminDatabaseUrl?: string) {
  if (!adminDatabaseUrl) throw new Error("all 范围必须配置 ARFORGE_DB_ADMIN_URL")
  const app = databaseConnection(databaseUrl)
  const admin = databaseConnection(adminDatabaseUrl)
  if (app.identity !== admin.identity) throw new Error("管理员连接与应用连接不是同一个 PostgreSQL 数据库")
  if (app.username === admin.username) throw new Error("all 范围不能复用日常应用数据库角色")
  return adminDatabaseUrl
}

async function validateAdmin(
  runner: ProcessRunner,
  databaseUrl: string,
  adminDatabaseUrl: string | undefined,
  postgresBin?: string,
) {
  const adminUrl = assertAdminTarget(databaseUrl, adminDatabaseUrl)
  const relations = allBusinessTables.map((table) => sqlLiteral(`public.${table}`)).join(", ")
  const output = await runPsql(
    runner,
    adminUrl,
    `SELECT bool_and(has_table_privilege(current_user, relation, 'TRUNCATE'))
     FROM unnest(ARRAY[${relations}]) AS relation;`,
    postgresBin,
  )
  if (output !== "t") throw new Error("ARFORGE_DB_ADMIN_URL 对业务表缺少 TRUNCATE 权限")
}

async function inventory(
  runner: ProcessRunner,
  databaseUrl: string,
  scope: ClearDataScope,
  workspace: string | undefined,
  postgresBin?: string,
): Promise<ClearDataInventory> {
  const output = await runPsql(runner, databaseUrl, buildInventorySql(scope, workspace), postgresBin)
  const records: unknown = JSON.parse(output)
  if (!isRecord(records)) throw new Error("PostgreSQL 盘点结果格式无效")
  const normalized = Object.fromEntries(
    Object.entries(records).map(([name, count]) => {
      if (typeof count !== "number" && typeof count !== "string") {
        throw new Error(`PostgreSQL 盘点计数无效：${name}`)
      }
      const value = Number(count)
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`PostgreSQL 盘点计数越界：${name}`)
      return [name, value]
    }),
  )
  return {
    records: normalized,
    total: Object.values(normalized).reduce((sum, count) => sum + count, 0),
  }
}

function extractJson(output: string) {
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error("备份脚本没有返回有效 JSON")
  const parsed: unknown = JSON.parse(output.slice(start, end + 1))
  if (!isRecord(parsed)) throw new Error("备份脚本没有返回 JSON 对象")
  return parsed
}

async function createBackup(options: CreateClearDataPlanOptions, runner: ProcessRunner) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    options.backupScript,
  ]
  if (options.backupDirectory) args.push("-BackupDirectory", options.backupDirectory)
  if (options.postgresBin) args.push("-PostgresBin", options.postgresBin)
  if (options.keyFile) args.push("-KeyFile", options.keyFile)
  const result = await runner(process.platform === "win32" ? "powershell.exe" : "pwsh", args, {
    env: { ...process.env, ARFORGE_DB_URL: options.databaseUrl },
  })
  if (result.exitCode !== 0) {
    throw new Error(`加密备份失败，未生成清理计划：${safeMessage(result.stderr || result.stdout)}`)
  }
  const parsed = extractJson(result.stdout)
  const text = (name: string) => (typeof parsed[name] === "string" ? parsed[name] : "")
  const bytes = typeof parsed.Bytes === "number" ? parsed.Bytes : Number.NaN
  const backup = {
    backup: text("Backup"),
    manifest: text("Manifest"),
    sha256: text("Sha256").toLocaleLowerCase("en-US"),
    bytes,
    encryption: text("Encryption"),
    authentication: text("Authentication"),
    restoreListVerified: parsed.RestoreListVerified === true,
  }
  if (
    !backup.backup ||
    !backup.manifest ||
    !/^[a-f0-9]{64}$/.test(backup.sha256) ||
    backup.bytes <= 0 ||
    backup.encryption !== "AES-256-CBC" ||
    backup.authentication !== "HMAC-SHA256" ||
    !backup.restoreListVerified
  ) {
    throw new Error("加密备份结果不满足 Arforge 恢复契约，未生成清理计划")
  }
  return backup
}

function planPath(directory: string, planID: string) {
  if (!/^[0-9a-f-]{36}$/i.test(planID)) throw new Error("清理计划 ID 无效")
  return path.join(path.resolve(directory), `${planID}.json`)
}

async function writePlan(directory: string, plan: ClearDataPlan) {
  await fs.mkdir(directory, { recursive: true })
  const target = planPath(directory, plan.id)
  const partial = `${target}.${process.pid}.partial`
  await fs.writeFile(partial, JSON.stringify(plan, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  await fs.rename(partial, target)
}

async function readPlan(directory: string, planID: string) {
  const content = await fs.readFile(planPath(directory, planID), "utf8")
  const plan: unknown = JSON.parse(content)
  if (!isClearDataPlan(plan) || plan.id !== planID) {
    throw new Error("清理计划格式无效")
  }
  return plan
}

async function fileSha256(filename: string) {
  const file = await fs.readFile(filename)
  return sha256(file)
}

export async function createClearDataPlan(
  rawOptions: CreateClearDataPlanOptions,
  dependencies: Partial<ClearDataDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies }
  const workspace =
    rawOptions.scope === "workspace"
      ? normalizeClearWorkspace(rawOptions.workspace ?? process.cwd())
      : undefined
  databaseConnection(rawOptions.databaseUrl)
  if (rawOptions.scope === "all") {
    await validateAdmin(
      deps.run,
      rawOptions.databaseUrl,
      rawOptions.adminDatabaseUrl,
      rawOptions.postgresBin,
    )
  }
  const records = await inventory(
    deps.run,
    rawOptions.databaseUrl,
    rawOptions.scope,
    workspace,
    rawOptions.postgresBin,
  )
  const backup = await createBackup(rawOptions, deps.run)
  const id = deps.id()
  const nonce = deps.nonce()
  const confirmationPhrase =
    rawOptions.scope === "all" ? `CLEAR ALL ARFORGE DATA ${nonce}` : `CLEAR ARFORGE WORKSPACE ${nonce}`
  const created = deps.now()
  const plan: ClearDataPlan = {
    schemaVersion: 1,
    product: "Arforge",
    id,
    scope: rawOptions.scope,
    ...(workspace ? { workspace } : {}),
    databaseFingerprint: databaseFingerprint(rawOptions.databaseUrl),
    inventory: records,
    backup,
    confirmationHash: sha256(`${id}\0${confirmationPhrase}`),
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + 15 * 60_000).toISOString(),
    status: "planned",
  }
  await writePlan(rawOptions.planDirectory, plan)
  return { plan, confirmationPhrase }
}

export async function executeClearDataPlan(
  options: ExecuteClearDataPlanOptions,
  dependencies: Partial<ClearDataDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies }
  const plan = await readPlan(options.planDirectory, options.planID)
  if (plan.status !== "planned") throw new Error(`清理计划已被消费，当前状态：${plan.status}`)
  if (deps.now().getTime() > Date.parse(plan.expiresAt)) throw new Error("清理计划已过期，请重新盘点和备份")
  if (sha256(`${plan.id}\0${options.confirmation}`) !== plan.confirmationHash) {
    throw new Error("一次性确认短语不匹配")
  }
  if (databaseFingerprint(options.databaseUrl) !== plan.databaseFingerprint) {
    throw new Error("当前数据库与清理计划目标不一致")
  }
  if ((await fileSha256(plan.backup.backup)) !== plan.backup.sha256) {
    throw new Error("加密备份哈希校验失败，拒绝执行清理")
  }
  if (plan.scope === "all") {
    await validateAdmin(
      deps.run,
      options.databaseUrl,
      options.adminDatabaseUrl,
      options.postgresBin,
    )
  }

  const executing: ClearDataPlan = { ...plan, status: "executing" }
  await writePlan(options.planDirectory, executing)
  try {
    const url = plan.scope === "all" ? assertAdminTarget(options.databaseUrl, options.adminDatabaseUrl) : options.databaseUrl
    await runPsql(deps.run, url, buildMutationSql(plan.scope, plan.workspace), options.postgresBin)
    const completed: ClearDataPlan = {
      ...executing,
      status: "completed",
      completedAt: deps.now().toISOString(),
    }
    await writePlan(options.planDirectory, completed)
    return completed
  } catch (error) {
    const failed: ClearDataPlan = {
      ...executing,
      status: "failed",
      failure: safeMessage(error instanceof Error ? error.message : String(error)),
    }
    await writePlan(options.planDirectory, failed)
    throw error
  }
}
