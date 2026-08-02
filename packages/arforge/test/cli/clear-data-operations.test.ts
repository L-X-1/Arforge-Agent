import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  allBusinessTables,
  buildMutationSql,
  createClearDataPlan,
  executeClearDataPlan,
  type ProcessResult,
  type ProcessRunner,
} from "../../src/cli/cmd/clear-data-operations"

const roots: string[] = []
const appUrl = "postgresql://arforge_app:private@localhost:5432/arforge"
const adminUrl = "postgresql://arforge_admin:private@localhost:5432/arforge"

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arforge-clear-data-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  if (failure instanceof Error) expect(failure.message).toContain(message)
}

function successfulRunner(backup: string, calls: Array<{ command: string; stdin?: string }>): ProcessRunner {
  return async (command, _args, options): Promise<ProcessResult> => {
    calls.push({ command, stdin: options.stdin })
    if (command.toLocaleLowerCase("en-US").includes("powershell")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          Backup: backup,
          Manifest: backup + ".manifest.json",
          Sha256: await fs.readFile(backup).then(sha256),
          Bytes: (await fs.stat(backup)).size,
          Encryption: "AES-256-CBC",
          Authentication: "HMAC-SHA256",
          RestoreListVerified: true,
        }),
        stderr: "",
      }
    }
    if (options.stdin?.includes("has_table_privilege")) {
      return { exitCode: 0, stdout: "t\n", stderr: "" }
    }
    if (options.stdin?.startsWith("SELECT json_build_object")) {
      return { exitCode: 0, stdout: '{"session":2,"memory":1}\n', stderr: "" }
    }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
}

describe("clear-data safety contract", () => {
  test("workspace plan creates a verified backup before yielding a one-time phrase", async () => {
    const root = await temporaryRoot()
    const backup = path.join(root, "backup.dump.enc")
    await fs.writeFile(backup, "encrypted-backup")
    const calls: Array<{ command: string; stdin?: string }> = []

    const result = await createClearDataPlan(
      {
        scope: "workspace",
        workspace: root,
        databaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: path.join(root, "postgres-backup.ps1"),
      },
      {
        run: successfulRunner(backup, calls),
        id: () => "00000000-0000-4000-8000-000000000001",
        nonce: () => "A1B2C3D4",
        now: () => new Date("2026-07-27T00:00:00.000Z"),
      },
    )

    expect(result.confirmationPhrase).toBe("CLEAR ARFORGE WORKSPACE A1B2C3D4")
    expect(result.plan).toMatchObject({
      status: "planned",
      inventory: { total: 3 },
      backup: { restoreListVerified: true },
    })
    expect(calls.some((call) => call.stdin?.startsWith("SELECT json_build_object"))).toBe(true)
    expect(calls.some((call) => call.command.toLocaleLowerCase("en-US").includes("powershell"))).toBe(true)
  })

  test("backup failure prevents a plan and any mutation", async () => {
    const root = await temporaryRoot()
    const calls: Array<{ command: string; stdin?: string }> = []
    const run: ProcessRunner = async (command, _args, options) => {
      calls.push({ command, stdin: options.stdin })
      if (options.stdin?.startsWith("SELECT json_build_object")) {
        return { exitCode: 0, stdout: '{"session":1}', stderr: "" }
      }
      return { exitCode: 1, stdout: "", stderr: "backup unavailable" }
    }

    await expectFailure(
      createClearDataPlan({
        scope: "workspace",
        workspace: root,
        databaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: "missing.ps1",
      }, { run }),
      "加密备份失败",
    )
    expect(calls.some((call) => call.stdin?.includes("DELETE FROM"))).toBe(false)
    expect(await fs.readdir(path.join(root, "plans")).catch(() => [])).toHaveLength(0)
  })

  test("wrong confirmation leaves the plan reusable and never mutates", async () => {
    const root = await temporaryRoot()
    const backup = path.join(root, "backup.dump.enc")
    await fs.writeFile(backup, "encrypted-backup")
    const calls: Array<{ command: string; stdin?: string }> = []
    const run = successfulRunner(backup, calls)
    const id = "00000000-0000-4000-8000-000000000002"
    await createClearDataPlan(
      {
        scope: "workspace",
        workspace: root,
        databaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: "backup.ps1",
      },
      {
        run,
        id: () => id,
        nonce: () => "11223344",
        now: () => new Date("2026-07-27T00:00:00.000Z"),
      },
    )
    calls.length = 0

    await expectFailure(
      executeClearDataPlan(
        {
          planID: id,
          confirmation: "WRONG",
          databaseUrl: appUrl,
          planDirectory: path.join(root, "plans"),
        },
        { run, now: () => new Date("2026-07-27T00:01:00.000Z") },
      ),
      "一次性确认短语不匹配",
    )
    expect(calls).toHaveLength(0)
    const saved = JSON.parse(await fs.readFile(path.join(root, "plans", `${id}.json`), "utf8"))
    expect(saved.status).toBe("planned")
  })

  test("verified execution consumes the plan and blocks replay", async () => {
    const root = await temporaryRoot()
    const backup = path.join(root, "backup.dump.enc")
    await fs.writeFile(backup, "encrypted-backup")
    const calls: Array<{ command: string; stdin?: string }> = []
    const run = successfulRunner(backup, calls)
    const id = "00000000-0000-4000-8000-000000000003"
    const phrase = "CLEAR ARFORGE WORKSPACE 55667788"
    await createClearDataPlan(
      {
        scope: "workspace",
        workspace: root,
        databaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: "backup.ps1",
      },
      {
        run,
        id: () => id,
        nonce: () => "55667788",
        now: () => new Date("2026-07-27T00:00:00.000Z"),
      },
    )
    calls.length = 0

    const completed = await executeClearDataPlan(
      {
        planID: id,
        confirmation: phrase,
        databaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
      },
      { run, now: () => new Date("2026-07-27T00:01:00.000Z") },
    )
    expect(completed.status).toBe("completed")
    expect(calls.some((call) => call.stdin?.includes("DELETE FROM session"))).toBe(true)

    await expectFailure(
      executeClearDataPlan(
        {
          planID: id,
          confirmation: phrase,
          databaseUrl: appUrl,
          planDirectory: path.join(root, "plans"),
        },
        { run, now: () => new Date("2026-07-27T00:02:00.000Z") },
      ),
      "已被消费",
    )
  })

  test("all scope requires a distinct admin role on the same database", async () => {
    const root = await temporaryRoot()
    const backup = path.join(root, "backup.dump.enc")
    await fs.writeFile(backup, "encrypted-backup")
    const calls: Array<{ command: string; stdin?: string }> = []

    await expectFailure(
      createClearDataPlan({
        scope: "all",
        databaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: "backup.ps1",
      }, { run: successfulRunner(backup, calls) }),
      "ARFORGE_DB_ADMIN_URL",
    )

    await expectFailure(
      createClearDataPlan({
        scope: "all",
        databaseUrl: appUrl,
        adminDatabaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: "backup.ps1",
      }, { run: successfulRunner(backup, calls) }),
      "不能复用日常应用数据库角色",
    )

    await createClearDataPlan(
      {
        scope: "all",
        databaseUrl: appUrl,
        adminDatabaseUrl: adminUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: "backup.ps1",
      },
      {
        run: successfulRunner(backup, calls),
        id: () => "00000000-0000-4000-8000-000000000004",
      },
    )
    expect(calls.some((call) => call.stdin?.includes("has_table_privilege"))).toBe(true)
  })

  test("all mutation preserves credentials, accounts, and migration ledgers", () => {
    const sql = buildMutationSql("all")
    for (const table of allBusinessTables) expect(sql).toContain(`"${table}"`)
    expect(sql).not.toContain('"credential"')
    expect(sql).not.toContain('"account"')
    expect(sql).not.toContain('"arforge_schema_migration"')
    expect(sql).not.toContain('"data_migration"')
  })

  test("SQLite and a changed database target are rejected", async () => {
    const root = await temporaryRoot()
    await expectFailure(
      createClearDataPlan({
        scope: "workspace",
        databaseUrl: "file:arforge.db",
        planDirectory: path.join(root, "plans"),
        backupScript: "backup.ps1",
      }),
      "仅支持 PostgreSQL",
    )

    const backup = path.join(root, "backup.dump.enc")
    await fs.writeFile(backup, "encrypted-backup")
    const id = "00000000-0000-4000-8000-000000000005"
    const run = successfulRunner(backup, [])
    await createClearDataPlan(
      {
        scope: "workspace",
        workspace: root,
        databaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: "backup.ps1",
      },
      {
        run,
        id: () => id,
        nonce: () => "99AABBCC",
        now: () => new Date("2026-07-27T00:00:00.000Z"),
      },
    )
    await expectFailure(
      executeClearDataPlan(
        {
          planID: id,
          confirmation: "CLEAR ARFORGE WORKSPACE 99AABBCC",
          databaseUrl: "postgresql://arforge_app:private@localhost:5432/another_database",
          planDirectory: path.join(root, "plans"),
        },
        { run, now: () => new Date("2026-07-27T00:01:00.000Z") },
      ),
      "目标不一致",
    )
  })

  test("a damaged encrypted backup prevents mutation", async () => {
    const root = await temporaryRoot()
    const backup = path.join(root, "backup.dump.enc")
    await fs.writeFile(backup, "encrypted-backup")
    const calls: Array<{ command: string; stdin?: string }> = []
    const run = successfulRunner(backup, calls)
    const id = "00000000-0000-4000-8000-000000000006"
    await createClearDataPlan(
      {
        scope: "workspace",
        workspace: root,
        databaseUrl: appUrl,
        planDirectory: path.join(root, "plans"),
        backupScript: "backup.ps1",
      },
      {
        run,
        id: () => id,
        nonce: () => "DDEEFF00",
        now: () => new Date("2026-07-27T00:00:00.000Z"),
      },
    )
    await fs.appendFile(backup, "tampered")
    calls.length = 0

    await expectFailure(
      executeClearDataPlan(
        {
          planID: id,
          confirmation: "CLEAR ARFORGE WORKSPACE DDEEFF00",
          databaseUrl: appUrl,
          planDirectory: path.join(root, "plans"),
        },
        { run, now: () => new Date("2026-07-27T00:01:00.000Z") },
      ),
      "哈希校验失败",
    )
    expect(calls).toHaveLength(0)
  })
})
