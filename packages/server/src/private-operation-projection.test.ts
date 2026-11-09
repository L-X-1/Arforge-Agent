import { Schema } from "effect"
import { PrivateOperation } from "@arforge-ai/schema/private-operation"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  projectLocalOperations,
  projectWindowsBackupTasks,
  readWindowsBackupTasks,
  resolveWindowsTaskProbe,
  type ProjectLocalOperationsInput,
} from "./private-operation-projection"

const roots: string[] = []
const payload = Buffer.from("synthetic encrypted backup payload for projection tests\n")
const plaintextPayload = Buffer.from("synthetic plaintext postgres custom dump\n")
const createdAt = "2026-11-01T10:00:00.000Z"
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

interface Fixture {
  readonly backupDirectory: string
  readonly drillDirectory: string
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arforge-private-operation-projection-"))
  roots.push(root)
  const backupDirectory = path.join(root, "backups")
  const drillDirectory = path.join(root, "drills")
  await fs.mkdir(backupDirectory, { recursive: true })
  await fs.mkdir(drillDirectory, { recursive: true })
  return { backupDirectory, drillDirectory }
}

function manifestFor(archiveName: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 2,
    product: "Arforge",
    createdAtUtc: createdAt,
    database: "arforge",
    backupFile: archiveName,
    encrypted: { bytes: bytes.byteLength, sha256: digest(bytes) },
    plaintext: { format: "PostgreSQL custom", bytes: plaintextPayload.byteLength, sha256: digest(plaintextPayload) },
    encryption: { algorithm: "AES-256-CBC", authentication: "HMAC-SHA256", hmacScope: "IV || ciphertext" },
    restoreListVerified: true,
    ...overrides,
  }
}

async function writeBackupFixture(
  directory: string,
  options: {
    readonly stem?: string
    readonly bytes?: Buffer
    readonly manifest?: Record<string, unknown>
    readonly writeArchive?: boolean
  } = {},
) {
  const stem = options.stem ?? "arforge-20261101-100000"
  const archiveName = `${stem}.dump.enc`
  const bytes = options.bytes ?? payload
  if (options.writeArchive !== false) await fs.writeFile(path.join(directory, archiveName), bytes)
  const manifest = manifestFor(archiveName, bytes, options.manifest)
  await fs.writeFile(path.join(directory, `${stem}.manifest.json`), JSON.stringify(manifest))
  return { archiveName, bytes, manifest }
}

async function writeDrillReport(directory: string, report: Record<string, unknown>, name?: string) {
  const file = path.join(directory, name ?? "postgres-recovery-20261102-030000.json")
  await fs.writeFile(file, JSON.stringify(report))
  return file
}

function drillReport(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    product: "Arforge",
    startedAtUtc: "2026-11-02T03:00:00.000Z",
    completedAtUtc: "2026-11-02T03:00:12.000Z",
    sourceDatabase: "arforge",
    temporaryDatabase: "arforge_restore_drill_fixture",
    backupFile: "arforge-20261101-100000.dump.enc",
    encryptedBackupSha256: digest(payload),
    plaintextBackupSha256: digest(plaintextPayload),
    checksumVerified: true,
    authenticationVerified: true,
    restoreListVerified: true,
    tableCount: 7,
    productionRows: 1234,
    restoredRows: 1234,
    mismatchCount: 0,
    mismatches: [],
    temporaryDatabaseRemoved: true,
    passed: true,
    ...overrides,
  }
}

async function project(dirs: Fixture, overrides: Partial<ProjectLocalOperationsInput> = {}) {
  return projectLocalOperations({
    backupDirectory: dirs.backupDirectory,
    drillDirectories: [dirs.drillDirectory],
    ...overrides,
    readTasks: overrides.readTasks ?? (async () => []),
  })
}

describe("backup availability, checksum verification and recorded catalog verification", () => {
  test("verifies the actual on-disk SHA-256 and keeps the recorded catalog check separate", async () => {
    const dirs = await fixture()
    const backup = await writeBackupFixture(dirs.backupDirectory)
    const result = await project(dirs)

    expect(result.backup).toEqual({
      available: true,
      createdAt,
      database: "arforge",
      bytes: backup.bytes.byteLength,
      encrypted: true,
      checksumVerified: true,
      restoreListVerified: true,
      fileState: "available",
      checksumState: "verified",
      catalogState: "recorded",
    })
    expect(Schema.decodeUnknownSync(PrivateOperation.Backup)(result.backup)).toEqual(result.backup)

    expect(result.recoveryDrill).toEqual({
      available: false,
      passed: false,
      tables: 0,
      sourceRows: 0,
      restoredRows: 0,
      differences: 0,
      state: "pending",
      bound: false,
    })
  })

  test("reports a digest mismatch without claiming checksum or restore-list verification", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory, {
      manifest: { encrypted: { bytes: payload.byteLength, sha256: digest("tampered archive") } },
    })
    const result = await project(dirs)

    expect(result.backup.available).toBe(true)
    expect(result.backup.fileState).toBe("available")
    expect(result.backup.checksumState).toBe("mismatch")
    expect(result.backup.checksumVerified).toBe(false)
    expect(result.backup.restoreListVerified).toBe(false)
    // The manifest still records the backup-time catalog check; it is reported
    // as a recorded claim, never as a verification of the tampered archive.
    expect(result.backup.catalogState).toBe("recorded")
    expect(Schema.decodeUnknownSync(PrivateOperation.Backup)(result.backup).checksumState).toBe("mismatch")
  })

  test("reports a missing archive without inventing availability or verification", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory, { writeArchive: false })
    const result = await project(dirs)

    expect(result.backup).toEqual({
      available: false,
      createdAt,
      database: "arforge",
      bytes: payload.byteLength,
      encrypted: true,
      checksumVerified: false,
      restoreListVerified: false,
      fileState: "missing",
      checksumState: "missing",
      catalogState: "missing",
    })
  })

  test("reports an unreadable archive as unreadable rather than verified", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    const result = await project(dirs, { hashFile: async () => undefined })

    expect(result.backup.fileState).toBe("available")
    expect(result.backup.checksumState).toBe("unreadable")
    expect(result.backup.checksumVerified).toBe(false)
    expect(result.backup.restoreListVerified).toBe(false)
    expect(result.backup.catalogState).toBe("recorded")
  })

  test("reports an unrecorded catalog check instead of a pass", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory, { manifest: { restoreListVerified: false } })
    const result = await project(dirs)

    expect(result.backup.checksumState).toBe("verified")
    expect(result.backup.catalogState).toBe("unrecorded")
    expect(result.backup.restoreListVerified).toBe(false)
  })

  test("has no latest backup when the directory is empty", async () => {
    const dirs = await fixture()
    const result = await project(dirs)

    expect(result.backup).toEqual({
      available: false,
      bytes: 0,
      encrypted: false,
      checksumVerified: false,
      restoreListVerified: false,
      fileState: "unavailable",
      checksumState: "unverified",
      catalogState: "missing",
    })
  })

  test("does not fall back to an older verified backup when the newest manifest is corrupt", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory, { stem: "arforge-20261001-100000" })
    await fs.writeFile(
      path.join(dirs.backupDirectory, "arforge-20261101-100000.manifest.json"),
      "{ this is not a manifest",
    )
    await fs.utimes(
      path.join(dirs.backupDirectory, "arforge-20261001-100000.manifest.json"),
      new Date("2026-10-01T10:00:00Z"),
      new Date("2026-10-01T10:00:00Z"),
    )
    const result = await project(dirs)

    expect(result.backup.available).toBe(false)
    expect(result.backup.checksumVerified).toBe(false)
    expect(result.backup.checksumState).toBe("unverified")
    expect(result.backup.fileState).toBe("unavailable")
  })

  test("keeps legacy manifest field spellings readable", async () => {
    const dirs = await fixture()
    const archiveName = "arforge-20261001T100000Z.dump"
    await fs.writeFile(path.join(dirs.backupDirectory, archiveName), payload)
    await fs.writeFile(
      path.join(dirs.backupDirectory, "arforge-20261001T100000Z.dump.json"),
      JSON.stringify({
        schema_version: 1,
        created_at: "2026-10-01T10:00:00Z",
        database: "arforge",
        backup: archiveName,
        size_bytes: payload.byteLength,
        sha256: digest(payload),
        catalog_verified: true,
      }),
    )
    const result = await project(dirs)

    expect(result.backup).toEqual({
      available: true,
      createdAt: "2026-10-01T10:00:00Z",
      database: "arforge",
      bytes: payload.byteLength,
      encrypted: false,
      checksumVerified: true,
      restoreListVerified: true,
      fileState: "available",
      checksumState: "verified",
      catalogState: "recorded",
    })
  })

  test("encodes through the public Overview contract and keeps old responses decodable", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    await writeDrillReport(dirs.drillDirectory, drillReport())
    const result = await project(dirs)
    const overview = {
      schemaVersion: 1 as const,
      generatedAt: "2026-11-08T00:00:00.000Z",
      readOnly: true as const,
      doctor: { ok: true, passed: 1, failed: 0, checks: [] },
      usage: {
        sessions: 0,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      backup: result.backup,
      recoveryDrill: result.recoveryDrill,
      secrets: { filesScanned: 0, filesSkipped: 0, findingFiles: 0, findings: 0, truncated: false },
      logs: { retentionDays: 30, cutoff: "2026-10-09T00:00:00.000Z", files: 0, bytes: 0 },
      windowsBackupTasks: result.windowsBackupTasks,
    }
    expect(Schema.decodeUnknownSync(PrivateOperation.Overview)(overview)).toEqual(overview)

    const legacyOverview: Record<string, unknown> = { ...overview }
    delete legacyOverview.windowsBackupTasks
    const legacyBackup = {
      available: true,
      bytes: 1,
      encrypted: true,
      checksumVerified: false,
      restoreListVerified: false,
    }
    const legacyDecoded = Schema.decodeUnknownSync(PrivateOperation.Overview)({
      ...legacyOverview,
      backup: legacyBackup,
    })
    expect(legacyDecoded.backup.fileState).toBeUndefined()
  })
})

describe("recovery evidence is bound to the selected archive and digest", () => {
  test("verifies a passing drill report bound to the latest archive", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    await writeDrillReport(dirs.drillDirectory, drillReport())
    const result = await project(dirs)

    expect(result.recoveryDrill).toEqual({
      available: true,
      completedAt: "2026-11-02T03:00:12.000Z",
      passed: true,
      tables: 7,
      sourceRows: 1234,
      restoredRows: 1234,
      differences: 0,
      state: "verified",
      bound: true,
    })
    expect(Schema.decodeUnknownSync(PrivateOperation.RecoveryDrill)(result.recoveryDrill).state).toBe("verified")
  })

  test("reports a bound failing drill report as failed", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    await writeDrillReport(dirs.drillDirectory, drillReport({ passed: false, mismatchCount: 2, restoredRows: 1200 }))
    const result = await project(dirs)

    expect(result.recoveryDrill.state).toBe("failed")
    expect(result.recoveryDrill.passed).toBe(false)
    expect(result.recoveryDrill.differences).toBe(2)
    expect(result.recoveryDrill.bound).toBe(true)
  })

  test("does not show a drill for another backup as passed", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    await writeDrillReport(
      dirs.drillDirectory,
      drillReport({
        backupFile: "arforge-20261001-100000.dump.enc",
        encryptedBackupSha256: digest("another backup"),
      }),
    )
    const result = await project(dirs)

    expect(result.recoveryDrill.available).toBe(true)
    expect(result.recoveryDrill.state).toBe("unbound")
    expect(result.recoveryDrill.passed).toBe(false)
    expect(result.recoveryDrill.bound).toBe(false)
  })

  test("does not bind a report whose archive digest is missing or different", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    await writeDrillReport(dirs.drillDirectory, drillReport({ encryptedBackupSha256: digest("other archive") }))
    const wrongHash = await project(dirs)
    expect(wrongHash.recoveryDrill.state).toBe("unbound")
    expect(wrongHash.recoveryDrill.passed).toBe(false)

    const legacyBoundary = await fixture()
    await writeBackupFixture(legacyBoundary.backupDirectory)
    await writeDrillReport(
      legacyBoundary.drillDirectory,
      drillReport({
        backupFile: undefined,
        backup: path.join(legacyBoundary.backupDirectory, "arforge-20261101-100000.dump.enc"),
        encryptedBackupSha256: undefined,
        checksumVerified: undefined,
      }),
    )
    const legacy = await project(legacyBoundary)
    expect(legacy.recoveryDrill.state).toBe("unbound")
    expect(legacy.recoveryDrill.passed).toBe(false)
  })

  test("never passes a bound report when the current archive digest changed after the report", async () => {
    const dirs = await fixture()
    const backup = await writeBackupFixture(dirs.backupDirectory)
    await writeDrillReport(dirs.drillDirectory, drillReport())
    // The manifest and the passing report still agree with each other, but the
    // archive bytes on disk changed afterwards: only historical evidence remains.
    await fs.writeFile(path.join(dirs.backupDirectory, backup.archiveName), Buffer.from("replaced archive content\n"))
    const result = await project(dirs)

    expect(result.backup.checksumState).toBe("mismatch")
    expect(result.backup.checksumVerified).toBe(false)
    expect(result.backup.restoreListVerified).toBe(false)
    expect(result.recoveryDrill.available).toBe(true)
    expect(result.recoveryDrill.bound).toBe(true)
    expect(result.recoveryDrill.state).toBe("historical")
    expect(result.recoveryDrill.passed).toBe(false)
    expect(Schema.decodeUnknownSync(PrivateOperation.RecoveryDrill)(result.recoveryDrill).state).toBe("historical")
  })

  test("treats a bound passing report as historical when the archive is missing", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory, { writeArchive: false })
    await writeDrillReport(dirs.drillDirectory, drillReport())
    const result = await project(dirs)

    expect(result.backup.fileState).toBe("missing")
    expect(result.recoveryDrill.state).toBe("historical")
    expect(result.recoveryDrill.passed).toBe(false)
  })

  test("does not pass a report whose temporary database cleanup failed", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    await writeDrillReport(dirs.drillDirectory, drillReport({ temporaryDatabaseRemoved: false }))
    const result = await project(dirs)

    expect(result.recoveryDrill.state).toBe("failed")
    expect(result.recoveryDrill.passed).toBe(false)
  })

  test("treats a matching legacy report without cleanup evidence as historical, never verified", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    const reportPath = path.join(dirs.drillDirectory, "postgres-recovery-20261102-030000.json")
    // Older scripts wrote the report before dropping the temporary database and
    // did not record cleanup: name + digest + passed all match, but this cannot
    // be current proof.
    await writeDrillReport(
      dirs.drillDirectory,
      drillReport({ temporaryDatabaseRemoved: undefined }),
      path.basename(reportPath),
    )
    const legacy = await project(dirs)
    expect(legacy.backup.checksumState).toBe("verified")
    expect(legacy.recoveryDrill.bound).toBe(true)
    expect(legacy.recoveryDrill.state).toBe("historical")
    expect(legacy.recoveryDrill.passed).toBe(false)

    // The same bound report becomes verified only once it explicitly records a
    // successful cleanup together with the other current-evidence conditions.
    await writeDrillReport(dirs.drillDirectory, drillReport(), path.basename(reportPath))
    const current = await project(dirs)
    expect(current.recoveryDrill.bound).toBe(true)
    expect(current.recoveryDrill.state).toBe("verified")
    expect(current.recoveryDrill.passed).toBe(true)
  })

  test("requires the recorded archive name even when the digest matches", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    await writeDrillReport(dirs.drillDirectory, drillReport({ backupFile: "arforge-20261001-100000.dump.enc" }))
    const result = await project(dirs)

    expect(result.recoveryDrill.state).toBe("unbound")
    expect(result.recoveryDrill.bound).toBe(false)
    expect(result.recoveryDrill.passed).toBe(false)
  })

  test("reads reports from the backup-relative packaged location and the legacy directory", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    const packaged = path.join(dirs.backupDirectory, "recovery-drills")
    await fs.mkdir(packaged, { recursive: true })
    await writeDrillReport(packaged, drillReport(), "postgres-recovery-20261103-030000.json")
    const packagedResult = await project(dirs, { drillDirectories: [packaged, dirs.drillDirectory] })
    expect(packagedResult.recoveryDrill.state).toBe("verified")
    expect(packagedResult.recoveryDrill.bound).toBe(true)

    const legacyOnly = await fixture()
    await writeBackupFixture(legacyOnly.backupDirectory)
    await writeDrillReport(legacyOnly.drillDirectory, drillReport())
    const legacyResult = await project(legacyOnly, {
      drillDirectories: [path.join(legacyOnly.backupDirectory, "recovery-drills"), legacyOnly.drillDirectory],
    })
    expect(legacyResult.recoveryDrill.state).toBe("verified")
  })
})

describe("Windows backup scheduled task projection", () => {
  test("reports a readable failed task with its exit code and no task actions", async () => {
    const rows = [
      {
        name: "Arforge PostgreSQL Backup",
        found: true,
        state: "Ready",
        lastRunAt: "2026-11-01T02:00:00.0000000Z",
        lastTaskResult: 0,
      },
      {
        name: "Arforge Private PostgreSQL Backup",
        found: true,
        state: "Ready",
        lastRunAt: "2026-11-01T03:00:00.0000000Z",
        lastTaskResult: 1,
        actions: [{ command: "C:\\private\\powershell.exe", arguments: "--password=hunter2" }],
      },
      {
        name: "Unrelated Host Task",
        found: true,
        state: "Ready",
        lastRunAt: "2026-11-01T04:00:00Z",
        lastTaskResult: 0,
      },
    ]

    const tasks = projectWindowsBackupTasks(rows)
    expect(tasks).toEqual([
      { name: "Arforge PostgreSQL Backup", status: "succeeded", lastRunAt: "2026-11-01T02:00:00.000Z", exitCode: 0 },
      {
        name: "Arforge Private PostgreSQL Backup",
        status: "failed",
        lastRunAt: "2026-11-01T03:00:00.000Z",
        exitCode: 1,
      },
    ])
    expect(tasks).toHaveLength(2)
    expect(JSON.stringify(tasks)).not.toContain("hunter2")
    expect(JSON.stringify(tasks)).not.toContain("powershell")
    expect(JSON.stringify(tasks)).not.toContain("Unrelated Host Task")
    expect(JSON.stringify(tasks)).not.toContain("arguments")
    for (const task of tasks) {
      expect(Object.keys(task).every((key) => ["name", "status", "lastRunAt", "exitCode"].includes(key))).toBe(true)
      expect(Schema.decodeUnknownSync(PrivateOperation.WindowsBackupTask)(task)).toEqual(task)
    }
  })

  test("projects scheduler states: running, never run and disabled", () => {
    expect(
      projectWindowsBackupTasks([
        { name: "Arforge PostgreSQL Backup", found: true, state: "Running", lastTaskResult: 267009 },
      ])[0],
    ).toMatchObject({ status: "running", exitCode: 267009 })
    expect(
      projectWindowsBackupTasks([
        { name: "Arforge PostgreSQL Backup", found: true, state: "Ready", lastRunAt: "", lastTaskResult: 267011 },
      ])[0],
    ).toMatchObject({ status: "never", exitCode: 267011 })
    expect(
      projectWindowsBackupTasks([
        { name: "Arforge PostgreSQL Backup", found: true, state: "Disabled", lastTaskResult: 0 },
      ])[0],
    ).toMatchObject({ status: "disabled" })
  })

  test("marks an unreadable task as unknown instead of a pass", () => {
    const tasks = projectWindowsBackupTasks([
      { name: "Arforge PostgreSQL Backup", found: false },
      { name: "Arforge Private PostgreSQL Backup", found: true, state: "Ready", lastRunAt: "1899-12-30T00:00:00Z" },
    ])
    expect(tasks).toEqual([
      { name: "Arforge PostgreSQL Backup", status: "unknown" },
      { name: "Arforge Private PostgreSQL Backup", status: "unknown" },
    ])
  })

  test("keeps both known tasks unknown when the host cannot read the scheduler", async () => {
    const tasks = await readWindowsBackupTasks("darwin")
    expect(tasks).toEqual([
      { name: "Arforge PostgreSQL Backup", status: "unknown" },
      { name: "Arforge Private PostgreSQL Backup", status: "unknown" },
    ])
  })

  test("keeps the backup projection when the task reader fails", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    const result = await project(dirs, {
      readTasks: async () => {
        throw new Error("scheduler unavailable")
      },
    })
    expect(result.backup.checksumState).toBe("verified")
    expect(result.windowsBackupTasks).toEqual([
      { name: "Arforge PostgreSQL Backup", status: "unknown" },
      { name: "Arforge Private PostgreSQL Backup", status: "unknown" },
    ])
  })

  test("projects a failed private task through the full local operations projection", async () => {
    const dirs = await fixture()
    await writeBackupFixture(dirs.backupDirectory)
    const result = await project(dirs, {
      readTasks: async () =>
        projectWindowsBackupTasks([
          { name: "Arforge PostgreSQL Backup", found: true, state: "Ready", lastRunAt: "2026-11-01T02:00:00Z", lastTaskResult: 0 },
          {
            name: "Arforge Private PostgreSQL Backup",
            found: true,
            state: "Ready",
            lastRunAt: "2026-11-01T03:00:00Z",
            lastTaskResult: 2147942401,
          },
        ]),
    })
    expect(result.windowsBackupTasks[1]).toEqual({
      name: "Arforge Private PostgreSQL Backup",
      status: "failed",
      lastRunAt: "2026-11-01T03:00:00.000Z",
      exitCode: 2147942401,
    })
  })

  test("resolves an absolute system PowerShell and a minimal Windows-only environment", () => {
    const probe = resolveWindowsTaskProbe({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: "E:\\Arforge-Agent\\.tools\\bun-1.3.14;C:\\Windows\\System32",
      PSModulePath: "E:\\Arforge-Agent\\custom-modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
      ARFORGE_DB_URL: "postgresql://user:secret@localhost/db",
      ARFORGE_DB_ADMIN_URL: "postgresql://admin:secret@localhost/db",
      USERPROFILE: "C:\\Users\\fixture",
    })
    if (!probe) throw new Error("system PowerShell probe was not resolved")

    expect(probe.executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(probe.moduleManifest).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1",
    )
    expect(Object.keys(probe.environment).toSorted()).toEqual(
      ["COMSPEC", "PATH", "PATHEXT", "PSModulePath", "SystemRoot", "WINDIR"].toSorted(),
    )
    const serialized = JSON.stringify(probe.environment)
    expect(serialized).not.toContain("Arforge-Agent")
    expect(serialized).not.toContain("ARFORGE")
    expect(serialized).not.toContain("postgresql://")
    expect(serialized).not.toContain("Users")
    expect(probe.environment["PATH"]).toBe("C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0")
    expect(probe.environment["PSModulePath"]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules")
  })

  test("refuses to resolve the task probe without an absolute Windows system root", () => {
    expect(resolveWindowsTaskProbe({ PATH: "C:\\Windows\\System32" })).toBeUndefined()
    expect(resolveWindowsTaskProbe({ SystemRoot: "Windows" })).toBeUndefined()
    expect(resolveWindowsTaskProbe({ SystemRoot: "C:\\Windows", WINDIR: "D:\\Windows" })).toBeDefined()
  })
})
