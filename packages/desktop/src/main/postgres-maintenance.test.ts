import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { postgresMaintenanceCopy } from "./postgres-maintenance-copy"
import {
  dispatchDesktopEntry, migrateConfiguredPostgres, ownPostgresMaintenance, postgresMaintenanceMessage,
  postgresMaintenanceMode, postgresMaintenanceResult, type PostgresMigrator,
} from "./postgres-maintenance"

const secret = "postgresql://synthetic_admin:private_sentinel@127.0.0.1:5432/owned"
const success = { ok: true, current: "20261104010000", appliedCount: 1 } as const
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

class Child extends EventEmitter {
  messages: unknown[] = []
  kills = 0
  onStop = () => { this.emit("exit", 2) }
  onKill = () => { this.emit("exit", 1) }
  postMessage(value: unknown) { this.messages.push(value); this.onStop() }
  kill() { this.kills++; this.onKill() }
}

function operation(overrides: Partial<Parameters<typeof migrateConfiguredPostgres>[0]> = {}) {
  let loads = 0, imports = 0, calls = 0
  const migrate: PostgresMigrator = async (url) => {
    expect(url).toBe(secret)
    calls++
    return { current: success.current, applied: calls === 1 ? [success.current] : [] }
  }
  return {
    input: { loadEnvironment: () => { loads++ }, adminURL: () => secret,
      loadMigrator: async () => { imports++; return migrate }, signal: new AbortController().signal, ...overrides },
    counts: () => ({ loads, imports, calls }),
  }
}

describe("explicit packaged PostgreSQL maintenance", () => {
  test("only an exact explicit flag selects maintenance; URL arguments and duplicates are rejected", () => {
    expect(postgresMaintenanceMode(["Arforge.exe"])).toBe("normal")
    expect(postgresMaintenanceMode(["Arforge.exe", "--migrate-postgres"])).toBe("migrate")
    expect(postgresMaintenanceMode(["Arforge.exe", "--migrate-postgres=" + secret])).toBe("invalid")
    expect(postgresMaintenanceMode(["--migrate-postgres", "--migrate-postgres"])).toBe("invalid")
    expect(postgresMaintenanceMode(["--migrate-postgres", secret])).toBe("invalid")
    expect(postgresMaintenanceMode(["--migrate-postgres-schema"])).toBe("invalid")
  })

  test("maintenance and malformed maintenance never invoke the normal backend/window bootstrap", () => {
    let normal = 0
    const modes: string[] = []
    for (const argv of [["Arforge.exe", "--migrate-postgres"], ["--migrate-postgres=" + secret]]) {
      dispatchDesktopEntry({ argv, normal: () => { normal++ }, maintenance: (mode) => modes.push(mode) })
    }
    expect(normal).toBe(0); expect(modes).toEqual(["migrate", "invalid"])
    dispatchDesktopEntry({ argv: ["Arforge.exe"], normal: () => { normal++ }, maintenance: (mode) => modes.push(mode) })
    expect(normal).toBe(1)
  })

  test("missing administrative URL cannot import the database or use the application URL", async () => {
    const value = operation({ adminURL: () => undefined })
    expect(await migrateConfiguredPostgres(value.input)).toEqual({ ok: false, code: "admin-url-missing" })
    expect(value.counts()).toEqual({ loads: 1, imports: 0, calls: 0 })
  })

  test("configuration errors and invalid URLs stay private and cannot import the database", async () => {
    for (const input of [{ loadEnvironment: () => { throw Error(secret) } }, { adminURL: () => "https://secret.invalid" }]) {
      const value = operation(input)
      const result = await migrateConfiguredPostgres(value.input)
      expect(result).toEqual({ ok: false, code: "configuration-unavailable" })
      expect(value.counts().imports).toBe(0)
      expect(JSON.stringify(result) + postgresMaintenanceMessage(result)).not.toContain("private_sentinel")
    }
  })

  test("loads private config before importing/invoking only the migrator and returns counters", async () => {
    const value = operation()
    expect(await migrateConfiguredPostgres(value.input)).toEqual(success)
    expect(await migrateConfiguredPostgres(value.input)).toEqual({ ...success, appliedCount: 0 })
    expect(value.counts()).toEqual({ loads: 2, imports: 2, calls: 2 })
    // This tests the adapter contract, not a claim that a real database migrated.
  })

  test("raw SQL/credential failure is replaced before a receipt or user message is produced", async () => {
    const value = operation({ loadMigrator: async () => async () => { throw Error(secret + " SELECT private_body") } })
    const result = await migrateConfiguredPostgres(value.input)
    expect(result).toEqual({ ok: false, code: "migration-failed" })
    expect(JSON.stringify(result) + postgresMaintenanceMessage(result)).not.toContain("private_sentinel")
    expect(postgresMaintenanceResult({ ...success, error: secret })).toBeUndefined()
    expect(postgresMaintenanceResult({ ok: true, current: secret, appliedCount: 1 })).toBeUndefined()
  })

  test("cancellation before work performs no configuration/database action", async () => {
    const controller = new AbortController(); controller.abort()
    const value = operation({ signal: controller.signal })
    expect(await migrateConfiguredPostgres(value.input)).toEqual({ ok: false, code: "cancelled" })
    expect(value.counts()).toEqual({ loads: 0, imports: 0, calls: 0 })
  })

  test("cancellation waits for the supplied migrator's scope cleanup", async () => {
    const controller = new AbortController()
    let finish!: () => void
    let cleanupStarted = false
    const value = operation({ signal: controller.signal, loadMigrator: async () => async (_url, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { cleanupStarted = true; finish = resolve }, { once: true })
      })
      throw Error(secret)
    } })
    let settled = false
    const result = migrateConfiguredPostgres(value.input).then((value) => { settled = true; return value })
    await tick(); controller.abort(); await tick()
    expect(cleanupStarted).toBe(true); expect(settled).toBe(false)
    finish()
    expect(await result).toEqual({ ok: false, code: "cancelled" })
  })

  test("safe acknowledgement is insufficient without the captured child's exit", async () => {
    const child = new Child(), owner = ownPostgresMaintenance(child, { signal: new AbortController().signal })
    let settled = false
    void owner.result.then(() => { settled = true })
    child.emit("message", success); await tick(); expect(settled).toBe(false)
    child.emit("exit", 0)
    expect(await owner.result).toEqual(success)
    expect(child.messages).toEqual([])
  })

  test("missing receipt and nonzero successful exit cannot be reported as success", async () => {
    for (const acknowledged of [false, true]) {
      const child = new Child(), owner = ownPostgresMaintenance(child, { signal: new AbortController().signal })
      if (acknowledged) child.emit("message", success)
      child.emit("exit", acknowledged ? 1 : 0)
      expect(await owner.result).toEqual({ ok: false, code: "worker-failed" })
    }
  })

  test("cancel only signals the captured utility and waits for its exact exit", async () => {
    const controller = new AbortController(), child = new Child()
    const owner = ownPostgresMaintenance(child, { signal: controller.signal })
    controller.abort()
    expect(await owner.result).toEqual({ ok: false, code: "cancelled" })
    expect(child.messages).toEqual([{ type: "cancel" }]); expect(child.kills).toBe(0)
    expect(JSON.stringify(child.messages)).not.toContain(secret)
  })

  test("timeout escalates only a nonresponsive captured utility and verifies exit", async () => {
    const child = new Child(); child.onStop = () => {}
    const owner = ownPostgresMaintenance(child, { signal: new AbortController().signal, timeoutMs: 1, graceMs: 1 })
    expect(await owner.result).toEqual({ ok: false, code: "timed-out" })
    expect(child.messages).toEqual([{ type: "cancel" }]); expect(child.kills).toBe(1)
  })

  test("failed cleanup retains exit tracking so an exact-owned stop can retry", async () => {
    const child = new Child(); child.onStop = () => {}; child.onKill = () => {}
    const owner = ownPostgresMaintenance(child, { signal: new AbortController().signal, timeoutMs: 1, graceMs: 1, killWaitMs: 1 })
    await expect(owner.result).rejects.toThrow("application exit was withheld")
    child.onStop = () => child.emit("exit", 2)
    await owner.stop()
    expect(child.messages).toEqual([{ type: "cancel" }, { type: "cancel" }])
  })

  test("malformed utility messages are cancelled, never printed or trusted", async () => {
    const child = new Child(), owner = ownPostgresMaintenance(child, { signal: new AbortController().signal })
    child.emit("message", { ok: false, code: secret, stack: secret })
    expect(await owner.result).toEqual({ ok: false, code: "worker-failed" })
  })

  test("native maintenance copy follows Simplified/Traditional Chinese and English desktop locales", () => {
    expect(postgresMaintenanceCopy("zh-CN").apply).toBe("应用迁移")
    expect(postgresMaintenanceCopy("zh-TW").apply).toBe("套用遷移")
    expect(postgresMaintenanceCopy("zh-Hant").cancelRepair).toBe("取消修復")
    expect(postgresMaintenanceCopy("en-US").apply).toBe("Apply migrations")
    for (const locale of ["zh-CN", "zh-TW", "en-US"]) {
      expect(postgresMaintenanceMessage({ ok: false, code: "admin-url-missing" }, locale)).toContain("Arforge.exe --migrate-postgres")
      expect(postgresMaintenanceMessage(success, locale)).toContain(success.current)
    }
  })
})
