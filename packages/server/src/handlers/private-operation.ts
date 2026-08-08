import { nativeHealth } from "@arforge-ai/core/capability-catalog"
import { Database } from "@arforge-ai/core/database/database"
import { usesPostgres } from "@arforge-ai/core/database/dialect"
import { Global } from "@arforge-ai/core/global"
import { InstallationVersion } from "@arforge-ai/core/installation/version"
import { pruneLogs, scanSensitiveFiles } from "@arforge-ai/core/private-operations"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { Effect } from "effect"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { resolveProductRoot } from "../product-root"

const productRoot = resolveProductRoot()

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\b(postgresql|postgres|mysql):\/\/[^\s]+/gi, "$1://[REDACTED]")
    .replace(/\b(password|passwd|pwd|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 300)

async function latestJson(directory: string, pattern: RegExp) {
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .then((items) => items.filter((item) => item.isFile() && pattern.test(item.name)))
    .catch(() => [])
  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name)
      return { file, mtime: (await fs.stat(file)).mtimeMs }
    }),
  )
  const latest = files.toSorted((a, b) => b.mtime - a.mtime)[0]
  if (!latest) return
  return JSON.parse((await fs.readFile(latest.file, "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0)
const bool = (value: unknown) => value === true
const string = (value: unknown) => (typeof value === "string" && value ? value : undefined)

export const PrivateOperationHandler = HttpApiBuilder.group(Api, "server.privateOperation", (handlers) =>
  handlers.handle(
    "privateOperation.overview",
    Effect.fn(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
      const storage = yield* Effect.promise(() =>
        Promise.all(
          [Global.Path.data, Global.Path.config, Global.Path.state, Global.Path.cache, Global.Path.log].map(
            async (directory) => {
              await fs.mkdir(directory, { recursive: true })
              await fs.access(directory, constants.R_OK | constants.W_OK)
            },
          ),
        ).then(
          () => ({ ok: true, detail: "5 个私人数据目录可读写" }),
          (error) => ({ ok: false, detail: message(error) }),
        ),
      )
      const agent = yield* Effect.succeed(nativeHealth()).pipe(
        Effect.map((health) => ({
          ok: health.status === "ok",
          detail: health.status === "ok" ? `Arforge Agent ${String(health.version ?? "")}` : "Agent 健康响应异常",
        })),
        Effect.catch((error) => Effect.succeed({ ok: false, detail: message(error) })),
      )
      const checks = [
        {
          id: "runtime",
          label: "统一运行时",
          ok: true,
          detail: `Arforge ${InstallationVersion} · Bun ${Bun.version}`,
        },
        { id: "workspace", label: "工作区", ok: true, detail: productRoot },
        { id: "storage", label: "私人目录", ...storage },
        {
          id: "database",
          label: "数据库",
          ok: usesPostgres,
          detail: usesPostgres ? "PostgreSQL 连接与 Schema 检查正常" : "当前未使用私人 PostgreSQL",
        },
        { id: "agent-bridge", label: "Agent 能力引擎", ...agent },
      ]
      const usage = sessions.reduce(
        (acc, session) => {
          acc.cost += session.cost
          acc.input += session.tokens_input
          acc.output += session.tokens_output
          acc.reasoning += session.tokens_reasoning
          acc.cacheRead += session.tokens_cache_read
          acc.cacheWrite += session.tokens_cache_write
          return acc
        },
        { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      )
      const backupDirectory =
        process.env.ARFORGE_BACKUP_DIRECTORY ??
        path.join(process.env.LOCALAPPDATA ?? Global.Path.data, "Arforge", "backups", "postgresql")
      const [manifest, drill, secrets, logs] = yield* Effect.promise(() =>
        Promise.all([
          latestJson(backupDirectory, /^arforge-\d{8}-\d{6}\.manifest\.json$/),
          latestJson(path.join(productRoot, "artifacts", "recovery-drills"), /^postgres-recovery-.+\.json$/),
          scanSensitiveFiles(Global.Path.data, {
            maxFiles: 2_000,
            excludeDirectories: ["repos", "snapshot", "log"],
          }),
          pruneLogs(Global.Path.log, 30),
        ]),
      )
      const encrypted = object(manifest?.encrypted)
      const encryption = object(manifest?.encryption)
      const sourceCounts = object(drill?.sourceTableCounts ?? drill?.source_table_counts)
      const restoredCounts = object(drill?.restoredTableCounts ?? drill?.restored_table_counts)
      const tables = new Set([...Object.keys(sourceCounts), ...Object.keys(restoredCounts)])
      let sourceRows = 0
      let restoredRows = 0
      let differences = 0
      for (const table of tables) {
        const source = number(sourceCounts[table])
        const restored = number(restoredCounts[table])
        sourceRows += source
        restoredRows += restored
        if (source !== restored) differences += 1
      }
      const reportedTables = number(drill?.tableCount ?? drill?.table_count)
      const reportedSourceRows = number(drill?.productionRows ?? drill?.sourceRows ?? drill?.source_rows)
      const reportedRestoredRows = number(drill?.restoredRows ?? drill?.restored_rows)
      const reportedDifferences = number(drill?.mismatchCount ?? drill?.mismatch_count)
      const drillTables = tables.size || reportedTables
      const drillSourceRows = sourceRows || reportedSourceRows
      const drillRestoredRows = restoredRows || reportedRestoredRows
      const drillDifferences = tables.size ? differences : reportedDifferences
      const passed = checks.filter((check) => check.ok).length
      const totalTokens = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
      const findingCount = secrets.findings.reduce(
        (sum, finding) => sum + Object.values(finding.categories).reduce((itemSum, count) => itemSum + count, 0),
        0,
      )
      return yield* response(
        Effect.succeed({
          schemaVersion: 1 as const,
          generatedAt: new Date().toISOString(),
          readOnly: true as const,
          doctor: {
            ok: passed === checks.length,
            passed,
            failed: checks.length - passed,
            checks,
          },
          usage: {
            sessions: sessions.length,
            cost: usage.cost,
            tokens: {
              input: usage.input,
              output: usage.output,
              reasoning: usage.reasoning,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              total: totalTokens,
            },
          },
          backup: {
            available: manifest !== undefined,
            ...(string(manifest?.createdAtUtc) ? { createdAt: string(manifest?.createdAtUtc) } : {}),
            ...(string(manifest?.database) ? { database: string(manifest?.database) } : {}),
            bytes: number(encrypted.bytes),
            encrypted: string(encryption.algorithm) === "AES-256-CBC",
            checksumVerified: typeof encrypted.sha256 === "string" && encrypted.sha256.length > 0,
            restoreListVerified: bool(manifest?.restoreListVerified),
          },
          recoveryDrill: {
            available: drill !== undefined,
            ...(string(drill?.completedAtUtc ?? drill?.completed_at_utc)
              ? { completedAt: string(drill?.completedAtUtc ?? drill?.completed_at_utc) }
              : {}),
            passed: bool(drill?.passed ?? drill?.success) && drillDifferences === 0,
            tables: drillTables,
            sourceRows: drillSourceRows,
            restoredRows: drillRestoredRows,
            differences: drillDifferences,
          },
          secrets: {
            filesScanned: secrets.filesScanned,
            filesSkipped: secrets.filesSkipped,
            findingFiles: secrets.findings.length,
            findings: findingCount,
            truncated: secrets.truncated,
          },
          logs: {
            retentionDays: logs.retentionDays,
            cutoff: logs.cutoff,
            files: logs.files,
            bytes: logs.bytes,
          },
        }),
      )
    }),
  ),
)
