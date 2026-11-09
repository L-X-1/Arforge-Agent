import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * The read-only operations projection deliberately keeps four facts apart:
 *
 * 1. the latest backup manifest and archive file availability
 * 2. an actual SHA-256 recomputation over the archive that is on disk now
 * 3. the archive catalog verification recorded inside the manifest at backup time
 * 4. recovery evidence, which only counts when a report is bound to this exact
 *    archive file name and encrypted digest
 *
 * Older projections reported `checksumVerified` when the manifest merely had a
 * `sha256` string. That is a claim, not a verification, so the functions below
 * recompute the digest and surface the claim and the verification separately.
 * Legacy manifest/report field spellings stay readable for compatibility.
 */

const MANIFEST_PATTERN = /^(?:arforge-\d{8}-\d{6}\.manifest\.json|.+-\d{8}T\d{6}Z\.dump\.json)$/
const DRILL_PATTERN = /^postgres-recovery-.+\.json$/
const MAX_DRILL_REPORTS = 100
const TASK_QUERY_TIMEOUT_MS = 5_000
const TASK_QUERY_MAX_BYTES = 64_000

export type BackupFileState = "available" | "missing" | "unavailable"
export type BackupChecksumState = "verified" | "mismatch" | "missing" | "unreadable" | "unverified"
export type BackupCatalogState = "recorded" | "unrecorded" | "missing"
export type RecoveryDrillState = "verified" | "failed" | "pending" | "unbound" | "historical"
export type WindowsBackupTaskStatus = "succeeded" | "failed" | "running" | "never" | "disabled" | "unknown"

export interface BackupProjection {
  readonly available: boolean
  readonly createdAt?: string
  readonly database?: string
  readonly bytes: number
  readonly encrypted: boolean
  readonly checksumVerified: boolean
  readonly restoreListVerified: boolean
  readonly fileState: BackupFileState
  readonly checksumState: BackupChecksumState
  readonly catalogState: BackupCatalogState
}

export interface RecoveryDrillProjection {
  readonly available: boolean
  readonly completedAt?: string
  readonly passed: boolean
  readonly tables: number
  readonly sourceRows: number
  readonly restoredRows: number
  readonly differences: number
  readonly state: RecoveryDrillState
  readonly bound: boolean
}

export interface WindowsBackupTaskProjection {
  readonly name: string
  readonly status: WindowsBackupTaskStatus
  readonly lastRunAt?: string
  readonly exitCode?: number
}

export interface LocalOperationsProjection {
  readonly backup: BackupProjection
  readonly recoveryDrill: RecoveryDrillProjection
  readonly windowsBackupTasks: ReadonlyArray<WindowsBackupTaskProjection>
}

/**
 * Only these two scheduled tasks are part of the shipped backup policy. The
 * projection never accepts a caller-supplied task name, so the read-only page
 * cannot be pointed at arbitrary task actions.
 */
export const WINDOWS_BACKUP_TASK_NAMES = [
  "Arforge PostgreSQL Backup",
  "Arforge Private PostgreSQL Backup",
] as const

const SCHED_RUNNING = 0x00041301
const SCHED_DISABLED = 0x00041302
const SCHED_HAS_NOT_RUN = 0x00041303
const SCHED_NO_MORE_RUNS = 0x00041304
const SCHED_NOT_SCHEDULED = 0x00041305
const SCHED_NO_VALID_TRIGGERS = 0x00041307

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const object = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined

const safeFileName = (value: unknown) => {
  const name = text(value)
  if (!name) return undefined
  const base = path.basename(name)
  return base === name && base !== "." && base !== ".." ? base : undefined
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

interface ManifestRecord {
  readonly file: string
  readonly archiveName?: string
  readonly sha256?: string
  readonly bytes: number
  readonly createdAt?: string
  readonly database?: string
  readonly encrypted: boolean
  readonly restoreListRecorded: boolean
}

function projectManifestRecord(file: string, manifest: Record<string, unknown>): ManifestRecord {
  const encrypted = object(manifest.encrypted)
  const encryption = object(manifest.encryption)
  const legacySha256 = text(manifest.sha256)
  const archiveName = safeFileName(manifest.backupFile ?? manifest.backup)
  const sha256 = text(encrypted.sha256) ?? legacySha256
  return {
    file,
    archiveName,
    sha256,
    bytes: count(encrypted.bytes) ?? count(manifest.size_bytes) ?? 0,
    createdAt: text(manifest.createdAtUtc) ?? text(manifest.created_at),
    database: text(manifest.database),
    encrypted: text(encryption.algorithm) === "AES-256-CBC",
    // v2 manifests record the backup-time `pg_restore --list` check in
    // `restoreListVerified`; the legacy Python manifest used `catalog_verified`.
    restoreListRecorded: manifest.restoreListVerified === true || manifest.catalog_verified === true,
  }
}

async function latestManifest(directory: string): Promise<ManifestRecord | undefined> {
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .then((items) => items.filter((item) => item.isFile() && MANIFEST_PATTERN.test(item.name)))
    .catch(() => [])
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name)
      const stat = await fs.lstat(file).catch(() => undefined)
      return stat ? { file, mtime: stat.mtimeMs } : undefined
    }),
  )
  const latest = candidates
    .filter((item): item is { file: string; mtime: number } => item !== undefined)
    .toSorted((a, b) => b.mtime - a.mtime)[0]
  if (!latest) return undefined
  // Never fall back to an older archive when the newest manifest is corrupt:
  // that would report an older verified backup while the latest one is broken.
  const manifest = await readJsonObject(latest.file)
  return manifest ? projectManifestRecord(latest.file, manifest) : undefined
}

async function inspectFile(file: string): Promise<BackupFileState> {
  try {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) return "unavailable"
    return stat.isFile() ? "available" : "missing"
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable"
  }
}

async function digestFile(file: string): Promise<string | undefined> {
  try {
    const hash = createHash("sha256")
    const handle = await fs.open(file, "r")
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
    return hash.digest("hex").toLowerCase()
  } catch {
    return undefined
  }
}

async function projectBackup(
  backupDirectory: string,
  manifest: ManifestRecord | undefined,
  hashFile: (file: string) => Promise<string | undefined>,
): Promise<BackupProjection> {
  if (!manifest) {
    return {
      available: false,
      bytes: 0,
      encrypted: false,
      checksumVerified: false,
      restoreListVerified: false,
      fileState: "unavailable",
      checksumState: "unverified",
      catalogState: "missing",
    }
  }
  const archive = manifest.archiveName ? path.join(backupDirectory, manifest.archiveName) : undefined
  const fileState: BackupFileState = archive ? await inspectFile(archive) : "missing"
  let checksumState: BackupChecksumState = "unverified"
  if (!archive || fileState === "missing") checksumState = "missing"
  else if (fileState === "unavailable") checksumState = "unreadable"
  else if (manifest.sha256) {
    const digest = await hashFile(archive)
    checksumState =
      digest === undefined ? "unreadable" : digest === manifest.sha256.toLowerCase() ? "verified" : "mismatch"
  }
  const catalogState: BackupCatalogState =
    fileState !== "available" || !archive ? "missing" : manifest.restoreListRecorded ? "recorded" : "unrecorded"
  return {
    available: fileState === "available",
    ...(manifest.createdAt ? { createdAt: manifest.createdAt } : {}),
    ...(manifest.database ? { database: manifest.database } : {}),
    bytes: manifest.bytes,
    encrypted: manifest.encrypted,
    checksumVerified: checksumState === "verified",
    restoreListVerified: catalogState === "recorded" && checksumState === "verified",
    fileState,
    checksumState,
    catalogState,
  }
}

interface DrillReport {
  readonly file: string
  readonly mtime: number
  readonly backupName?: string
  readonly sha256?: string
  readonly completedAt?: string
  readonly passed: boolean
  readonly checksumVerified?: boolean
  /**
   * The old drill script wrote its report *before* dropping the temporary
   * database and did not record cleanup at all, so an absent field must not be
   * treated as cleanup succeeded.
   */
  readonly cleanupState: "confirmed" | "failed" | "unrecorded"
  readonly tables: number
  readonly sourceRows: number
  readonly restoredRows: number
  readonly differences: number
}

function projectDrillReport(file: string, mtime: number, report: Record<string, unknown>): DrillReport {
  const sourceCounts = object(report.sourceTableCounts ?? report.source_table_counts)
  const restoredCounts = object(report.restoredTableCounts ?? report.restored_table_counts)
  const tables = new Set([...Object.keys(sourceCounts), ...Object.keys(restoredCounts)])
  let sourceRows = 0
  let restoredRows = 0
  let tableDifferences = 0
  for (const table of tables) {
    const source = count(sourceCounts[table]) ?? 0
    const restored = count(restoredCounts[table]) ?? 0
    sourceRows += source
    restoredRows += restored
    if (source !== restored) tableDifferences += 1
  }
  const legacyDifferences = object(report.row_count_differences ?? report.rowCountDifferences)
  const differences = tables.size
    ? tableDifferences
    : (count(report.mismatchCount ?? report.mismatch_count) ?? Object.keys(legacyDifferences).length)
  const passedFlag = report.passed === true || report.success === true
  const exactMatch = report.exact_row_count_match === true || report.exactRowCountMatch === true
  const checksumVerifiedFlag = report.checksumVerified ?? report.checksum_verified
  // Newer drills publish the report only after the temporary database was
  // dropped and record that cleanup explicitly. Reports from the previous
  // script (field absent) are readable historical evidence, not current proof.
  const cleanupFlag = report.temporaryDatabaseRemoved ?? report.temporary_database_removed
  const cleanupState: DrillReport["cleanupState"] =
    cleanupFlag === true ? "confirmed" : cleanupFlag === false ? "failed" : "unrecorded"
  return {
    file,
    mtime,
    backupName: safeFileName(report.backupFile) ?? safeFileName(report.backup),
    sha256: text(report.encryptedBackupSha256) ?? text(report.encrypted_backup_sha256),
    completedAt:
      text(report.completedAtUtc) ??
      text(report.completed_at_utc) ??
      text(report.completedAt) ??
      text(report.completed_at),
    passed: passedFlag || (exactMatch && differences === 0),
    checksumVerified: typeof checksumVerifiedFlag === "boolean" ? checksumVerifiedFlag : undefined,
    cleanupState,
    tables: tables.size || count(report.tableCount ?? report.table_count ?? report.restored_table_count) || 0,
    sourceRows: sourceRows || count(report.productionRows ?? report.sourceRows ?? report.source_rows) || 0,
    restoredRows: restoredRows || count(report.restoredRows ?? report.restored_rows) || 0,
    differences,
  }
}

async function loadDrillReportsFromDirectory(directory: string): Promise<DrillReport[]> {
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .then((items) => items.filter((item) => item.isFile() && DRILL_PATTERN.test(item.name)))
    .catch(() => [])
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name)
      const stat = await fs.lstat(file).catch(() => undefined)
      if (!stat) return undefined
      const report = await readJsonObject(file)
      return report ? projectDrillReport(file, stat.mtimeMs, report) : undefined
    }),
  )
  return candidates.filter((item): item is DrillReport => item !== undefined)
}

/**
 * Merge reports from the packaged default location and the legacy repository
 * artifacts location. Binding still requires the exact archive name + digest,
 * so an older report cannot supply current evidence.
 */
async function loadDrillReports(directories: ReadonlyArray<string>): Promise<DrillReport[]> {
  const reports = (await Promise.all(directories.map(loadDrillReportsFromDirectory))).flat()
  const unique = new Map<string, DrillReport>()
  for (const report of reports) if (!unique.has(report.file)) unique.set(report.file, report)
  return [...unique.values()].toSorted((a, b) => b.mtime - a.mtime).slice(0, MAX_DRILL_REPORTS)
}

function projectRecoveryDrill(
  reports: ReadonlyArray<DrillReport>,
  manifest: ManifestRecord | undefined,
  backup: BackupProjection,
): RecoveryDrillProjection {
  const latest = reports[0]
  const bound =
    manifest?.archiveName && manifest.sha256
      ? reports.find(
          (report) =>
            report.backupName === manifest.archiveName &&
            report.sha256 !== undefined &&
            report.sha256.toLowerCase() === manifest.sha256!.toLowerCase(),
        )
      : undefined
  const reportPassed =
    bound !== undefined && bound.passed && bound.differences === 0 && bound.checksumVerified !== false
  // `verified` requires current evidence: the report must be bound, itself
  // passing, published after successful temporary-database cleanup, and the
  // archive on disk must still match the manifest digest. Reports from the old
  // script (cleanup field absent, written before `dropdb`) are readable but only
  // `historical`; an explicit cleanup failure is `failed`.
  const state: RecoveryDrillState = !latest
    ? "pending"
    : !bound
      ? "unbound"
      : bound.cleanupState === "failed"
        ? "failed"
        : reportPassed && bound.cleanupState === "confirmed" && backup.checksumState === "verified"
          ? "verified"
          : reportPassed
            ? "historical"
            : "failed"
  const selected = bound ?? latest
  return {
    available: latest !== undefined,
    ...(selected?.completedAt ? { completedAt: selected.completedAt } : {}),
    passed: state === "verified",
    tables: selected?.tables ?? 0,
    sourceRows: selected?.sourceRows ?? 0,
    restoredRows: selected?.restoredRows ?? 0,
    differences: selected?.differences ?? 0,
    state,
    bound: bound !== undefined,
  }
}

function normalizeLastRun(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  // PowerShell "o" formatting can emit more than three fractional digits, which
  // not every Date parser accepts. Truncate the fraction to milliseconds.
  const timestamp = Date.parse(raw.replace(/\.(\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, ".$1"))
  if (!Number.isFinite(timestamp)) return undefined
  const year = new Date(timestamp).getUTCFullYear()
  if (year < 2000 || year > 3000) return undefined
  return new Date(timestamp).toISOString()
}

function unsignedInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const integer = Math.trunc(value)
  if (integer < 0) return integer + 0x1_0000_0000
  return integer <= 0xffff_ffff ? integer : undefined
}

function projectWindowsBackupTask(
  name: (typeof WINDOWS_BACKUP_TASK_NAMES)[number],
  raw: Record<string, unknown> | undefined,
): WindowsBackupTaskProjection {
  if (!raw || raw.found === false) return { name, status: "unknown" }
  const lastRunAt = normalizeLastRun(raw.lastRunAt)
  const exitCode = unsignedInteger(raw.lastTaskResult)
  const base = { name, ...(lastRunAt ? { lastRunAt } : {}) }
  const withStatus = (status: WindowsBackupTaskStatus) => ({
    ...base,
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
  })
  const taskState = text(raw.state)
  if (taskState === "Running" || exitCode === SCHED_RUNNING) return withStatus("running")
  if (taskState === "Disabled" || exitCode === SCHED_DISABLED) return withStatus("disabled")
  if (exitCode === undefined) return { ...base, status: "unknown" }
  if (
    !lastRunAt ||
    exitCode === SCHED_HAS_NOT_RUN ||
    exitCode === SCHED_NO_MORE_RUNS ||
    exitCode === SCHED_NOT_SCHEDULED
  )
    return withStatus("never")
  if (exitCode === 0) return withStatus("succeeded")
  if (exitCode === SCHED_NO_VALID_TRIGGERS) return { ...base, status: "unknown" }
  return withStatus("failed")
}

const isBackupTaskName = (value: string): value is (typeof WINDOWS_BACKUP_TASK_NAMES)[number] =>
  WINDOWS_BACKUP_TASK_NAMES.some((name) => name === value)

/**
 * Project the raw JSON rows emitted by the fixed Read-ScheduledTask probe.
 * Rows for any other task name are ignored, and only the allow-listed fields
 * (name, last run time, scheduler result) ever leave this function.
 */
export function projectWindowsBackupTasks(raw: ReadonlyArray<unknown>): WindowsBackupTaskProjection[] {
  const rows = new Map<string, Record<string, unknown>>()
  for (const value of raw) {
    const row = object(value)
    const name = text(row.name)
    if (!name || !isBackupTaskName(name)) continue
    if (!rows.has(name)) rows.set(name, row)
  }
  return WINDOWS_BACKUP_TASK_NAMES.map((name) => projectWindowsBackupTask(name, rows.get(name)))
}

export interface WindowsTaskProbe {
  readonly executable: string
  readonly moduleManifest: string
  readonly environment: Readonly<Record<string, string>>
}

/**
 * Resolve the fixed system PowerShell executable and a minimal Windows-only
 * environment. The probe deliberately does not inherit PATH, PSModulePath or
 * any other parent variable (including Arforge secrets), so a repository-local
 * shim or user module path cannot hijack the read-only scheduled-task query.
 */
export function resolveWindowsTaskProbe(environment: NodeJS.ProcessEnv = process.env): WindowsTaskProbe | undefined {
  const systemRoot = text(environment.SystemRoot) ?? text(environment.WINDIR)
  if (!systemRoot) return undefined
  const windows = path.win32
  if (!windows.isAbsolute(systemRoot)) return undefined
  const system32 = windows.join(systemRoot, "System32")
  const windowsPowerShell = windows.join(system32, "WindowsPowerShell", "v1.0")
  return {
    executable: windows.join(windowsPowerShell, "powershell.exe"),
    moduleManifest: windows.join(windowsPowerShell, "Modules", "ScheduledTasks", "ScheduledTasks.psd1"),
    environment: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      COMSPEC: windows.join(system32, "cmd.exe"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PATH: `${system32};${windowsPowerShell}`,
      PSModulePath: windows.join(windowsPowerShell, "Modules"),
    },
  }
}

function scheduledTaskQueryScript(probe: WindowsTaskProbe): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$env:PSModulePath=${quote(probe.environment["PSModulePath"] ?? "")}`,
    `Import-Module -Name ${quote(probe.moduleManifest)} -ErrorAction Stop`,
    `$names=@(${WINDOWS_BACKUP_TASK_NAMES.map(quote).join(",")})`,
    "foreach($name in $names){",
    "$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue",
    "if($null -eq $task){@{name=$name;found=$false}|ConvertTo-Json -Compress;continue}",
    "$info=Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue",
    "$last=''",
    "if($null -ne $info -and $null -ne $info.LastRunTime -and $info.LastRunTime.Year -gt 2000){$last=$info.LastRunTime.ToUniversalTime().ToString('o')}",
    "$result=$null",
    "if($null -ne $info){$result=[long]$info.LastTaskResult}",
    "@{name=$name;found=$true;state=[string]$task.State;lastRunAt=$last;lastTaskResult=$result}|ConvertTo-Json -Compress",
    "}",
  ].join(";")
}

async function runScheduledTaskQuery(probe: WindowsTaskProbe): Promise<string> {
  await fs.access(probe.executable, constants.F_OK)
  const script = scheduledTaskQueryScript(probe)
  return new Promise((resolve, reject) => {
    const child = spawn(
      probe.executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        windowsHide: true,
        env: { ...probe.environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const stdout: Buffer[] = []
    let outputBytes = 0
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error("Windows backup scheduled task query timed out"))
    }, TASK_QUERY_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes <= TASK_QUERY_MAX_BYTES) stdout.push(chunk)
    })
    child.stderr.on("data", () => undefined)
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Windows backup scheduled task query failed with exit code ${code}`))
        return
      }
      resolve(Buffer.concat(stdout).toString("utf8"))
    })
  })
}

function parseScheduledTaskOutput(output: string): unknown[] {
  const rows: unknown[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // The fixed probe only emits JSON lines; ignore any unexpected noise.
    }
  }
  return rows
}

/**
 * Read the two known backup tasks on Windows. Every failure (non-Windows host,
 * missing system PowerShell, timeout, malformed output) projects both tasks as
 * `unknown` instead of inventing a state.
 */
export async function readWindowsBackupTasks(
  platform: NodeJS.Platform = process.platform,
): Promise<WindowsBackupTaskProjection[]> {
  if (platform !== "win32") return projectWindowsBackupTasks([])
  try {
    const probe = resolveWindowsTaskProbe()
    if (!probe) return projectWindowsBackupTasks([])
    return projectWindowsBackupTasks(parseScheduledTaskOutput(await runScheduledTaskQuery(probe)))
  } catch {
    return projectWindowsBackupTasks([])
  }
}

export interface ProjectLocalOperationsInput {
  readonly backupDirectory: string
  /**
   * Report directories in preference order. Packaged runtimes put drills next
   * to the backups; the repository artifacts directory stays readable for
   * reports produced by previous layouts.
   */
  readonly drillDirectories: ReadonlyArray<string>
  readonly platform?: NodeJS.Platform
  readonly readTasks?: () => Promise<ReadonlyArray<WindowsBackupTaskProjection>>
  /** Test seam for unreadable archives; production always uses the real digest. */
  readonly hashFile?: (file: string) => Promise<string | undefined>
}

export async function projectLocalOperations(input: ProjectLocalOperationsInput): Promise<LocalOperationsProjection> {
  const readTasks = input.readTasks ?? (() => readWindowsBackupTasks(input.platform))
  const tasks = (async () => {
    try {
      return await readTasks()
    } catch {
      return projectWindowsBackupTasks([])
    }
  })()
  const [manifest, reports, windowsBackupTasks] = await Promise.all([
    latestManifest(input.backupDirectory),
    loadDrillReports(input.drillDirectories),
    tasks,
  ])
  const backup = await projectBackup(input.backupDirectory, manifest, input.hashFile ?? digestFile)
  const recoveryDrill = projectRecoveryDrill(reports, manifest, backup)
  return { backup, recoveryDrill, windowsBackupTasks: [...windowsBackupTasks] }
}
