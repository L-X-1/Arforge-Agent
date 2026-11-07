import { createOwnedProcessStop } from "./lifecycle"
import { postgresMaintenanceCopy } from "./postgres-maintenance-copy"

export const POSTGRES_MAINTENANCE_SWITCH = "--migrate-postgres"

export function postgresMaintenanceMode(argv: readonly string[]) {
  const matches = argv.filter((arg) => arg.startsWith(POSTGRES_MAINTENANCE_SWITCH))
  if (matches.length === 0) return "normal"
  if (argv.some((arg) => /^postgres(?:ql)?:\/\//i.test(arg) || /^--(?:db-)?admin-url(?:=|$)/.test(arg))) return "invalid"
  return matches.length === 1 && matches[0] === POSTGRES_MAINTENANCE_SWITCH ? "migrate" : "invalid"
}

export function dispatchDesktopEntry(input: {
  readonly argv: readonly string[]
  readonly normal: () => void
  readonly maintenance: (mode: "migrate" | "invalid") => void
}) {
  const mode = postgresMaintenanceMode(input.argv)
  if (mode === "normal") input.normal()
  else input.maintenance(mode)
}

const failureCodes = ["admin-url-missing", "configuration-unavailable", "migration-failed", "cancelled", "timed-out", "worker-failed"] as const
type FailureCode = (typeof failureCodes)[number]
export type PostgresMaintenanceResult =
  | { readonly ok: true; readonly current: string; readonly appliedCount: number }
  | { readonly ok: false; readonly code: FailureCode }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const revision = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,160}$/.test(value)

/** A utility receipt contains public counters only, never an Error, URL or SQL. */
export function postgresMaintenanceResult(value: unknown): PostgresMaintenanceResult | undefined {
  if (!record(value)) return undefined
  const keys = Object.keys(value).sort().join(",")
  if (value.ok === true && keys === "appliedCount,current,ok" && revision(value.current) && typeof value.appliedCount === "number" && Number.isSafeInteger(value.appliedCount) && value.appliedCount >= 0) {
    return { ok: true, current: value.current, appliedCount: value.appliedCount }
  }
  if (value.ok !== false || keys !== "code,ok") return undefined
  const code = failureCodes.find((code) => code === value.code)
  return code ? { ok: false, code } : undefined
}

export type PostgresMigrator = (url: string, signal: AbortSignal) => Promise<{ readonly current: string; readonly applied: readonly string[] }>

/** The private environment is loaded before the database module is imported. */
export async function migrateConfiguredPostgres(input: {
  readonly loadEnvironment: () => void
  readonly adminURL: () => string | undefined
  readonly loadMigrator: () => Promise<PostgresMigrator>
  readonly signal: AbortSignal
}): Promise<PostgresMaintenanceResult> {
  if (input.signal.aborted) return { ok: false, code: "cancelled" }
  try {
    input.loadEnvironment()
  } catch {
    return { ok: false, code: "configuration-unavailable" }
  }
  const url = input.adminURL()?.trim()
  if (!url) return { ok: false, code: "admin-url-missing" }
  try {
    const target = new URL(url)
    if (!["postgres:", "postgresql:"].includes(target.protocol)) return { ok: false, code: "configuration-unavailable" }
  } catch {
    return { ok: false, code: "configuration-unavailable" }
  }
  try {
    if (input.signal.aborted) return { ok: false, code: "cancelled" }
    const migrate = await input.loadMigrator()
    if (input.signal.aborted) return { ok: false, code: "cancelled" }
    const result = await migrate(url, input.signal)
    if (input.signal.aborted) return { ok: false, code: "cancelled" }
    if (!revision(result.current)) return { ok: false, code: "migration-failed" }
    return { ok: true, current: result.current, appliedCount: result.applied.length }
  } catch {
    return { ok: false, code: input.signal.aborted ? "cancelled" : "migration-failed" }
  }
}

export interface PostgresMaintenanceChild {
  on(event: "message", listener: (message: unknown) => void): unknown
  once(event: "exit", listener: (code: number) => void): unknown
  once(event: "error", listener: (...args: unknown[]) => void): unknown
  off(event: "message", listener: (message: unknown) => void): unknown
  off(event: "exit", listener: (code: number) => void): unknown
  off(event: "error", listener: (...args: unknown[]) => void): unknown
  postMessage(message: { readonly type: "cancel" }): void
  kill(): unknown
}

/** Success requires both a safe migration receipt and the captured child's exit. */
export function ownPostgresMaintenance(child: PostgresMaintenanceChild, options: {
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  readonly graceMs?: number
  readonly killWaitMs?: number
}) {
  let exited = false
  let receipt: PostgresMaintenanceResult | undefined
  let interrupted: PostgresMaintenanceResult | undefined
  let resolveExit!: (code: number) => void
  let resolveInterrupt!: (result: PostgresMaintenanceResult) => void
  const exit = new Promise<number>((resolve) => { resolveExit = resolve })
  const interruption = new Promise<PostgresMaintenanceResult>((resolve) => { resolveInterrupt = resolve })
  const interrupt = (code: FailureCode) => {
    if (interrupted) return
    interrupted = { ok: false, code }
    resolveInterrupt(interrupted)
  }
  const onMessage = (value: unknown) => {
    const parsed = postgresMaintenanceResult(value)
    if (!parsed || receipt) { interrupt("worker-failed"); return }
    receipt = parsed
  }
  const onExit = (code: number) => {
    exited = true
    resolveExit(code)
    child.off("message", onMessage)
    child.off("error", onError)
  }
  const onError = () => interrupt("worker-failed")
  child.on("message", onMessage)
  child.once("exit", onExit)
  child.once("error", onError)
  const stop = createOwnedProcessStop({
    exited: () => exited, exit,
    requestStop: () => child.postMessage({ type: "cancel" }),
    kill: () => { child.kill() },
    graceMs: options.graceMs, killWaitMs: options.killWaitMs,
  })
  const abort = () => interrupt("cancelled")
  options.signal.addEventListener("abort", abort, { once: true })
  if (options.signal.aborted) abort()
  const timer = setTimeout(() => interrupt("timed-out"), options.timeoutMs ?? 120_000)
  const result = (async (): Promise<PostgresMaintenanceResult> => {
    try {
      const outcome = await Promise.race([
        exit.then((code): PostgresMaintenanceResult => {
          if (interrupted) return interrupted
          if (!receipt || (receipt.ok && code !== 0)) return { ok: false, code: "worker-failed" }
          return receipt
        }),
        interruption,
      ])
      // On cancellation/timeout this waits for SQL scope cleanup, then escalates
      // only this utility. If exit cannot be confirmed, keep the host alive.
      await stop()
      return outcome
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener("abort", abort)
      child.off("message", onMessage)
      // A failed stop must retain the captured exit listener so Quit can retry.
      if (exited) {
        child.off("exit", onExit)
        child.off("error", onError)
      }
    }
  })()
  return { result, stop }
}

export function postgresMaintenanceMessage(result: PostgresMaintenanceResult, locale = "en") {
  return postgresMaintenanceCopy(locale).result(result)
}
