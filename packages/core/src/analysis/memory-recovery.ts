import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { Global } from "../global"

type JsonRecord = Record<string, unknown>

const PENDING_REBUILD_STATES = new Set([
  "rebuild_pending_stale",
  "rebuild_pending_missing",
  "transcript_rebuild_pending",
])
const TREND_DAYS = 7

export interface MemoryRecoveryReport {
  readonly schema_version: 1
  readonly execution_mode: "read-only-core-memory-recovery"
  readonly side_effects: "none"
  readonly source: {
    readonly status: "read" | "missing"
    readonly file: "recovery_outcomes.jsonl"
    readonly rows: number
    readonly corrupt_rows: number
  }
  readonly events_total: number
  readonly states: Readonly<Record<string, { readonly count: number; readonly ratio: number }>>
  readonly verified_count: number
  readonly restore_success_rate: number
  readonly pending_rebuild_rate: number
  readonly daily_trend: ReadonlyArray<{
    readonly date: string
    readonly verified: number
    readonly total: number
    readonly rate: number
  }>
  readonly corrupt_rows: number
  readonly clear: {
    readonly status: "unsupported"
    readonly reason: string
  }
  readonly caveat: string
}

const homePath = (home?: string): string => resolve((home ?? process.env.ARFORGE_HOME)?.trim() || Global.Path.data)

const recoveryPath = (home: string): string => join(home, "recovery_outcomes.jsonl")

const isFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const utcDay = (value: Date): string => value.toISOString().slice(0, 10)

const parseRows = (path: string): { rows: JsonRecord[]; corruptRows: number } => {
  if (!isFile(path)) return { rows: [], corruptRows: 0 }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { rows: [], corruptRows: 0 }
  }
  const rows: JsonRecord[] = []
  let corruptRows = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!isRecord(parsed)) throw new Error("row is not an object")
      const state = parsed.recovery_state
      const timestamp = parsed.ts
      if (
        typeof state !== "string" ||
        state.trim() === "" ||
        typeof timestamp !== "string" ||
        Number.isNaN(Date.parse(timestamp))
      )
        throw new Error("row has invalid recovery state or timestamp")
      rows.push(parsed)
    } catch {
      corruptRows += 1
    }
  }
  return { rows, corruptRows }
}

const addCount = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)

/**
 * Read and aggregate the profile-local recovery outcome log without writing or
 * clearing it.  The historical Python command's clear operation is deliberately
 * not reproduced until a typed owner, identity boundary, and audit trail exist.
 */
export function memoryRecoveryReport(home?: string, now = new Date()): MemoryRecoveryReport {
  const root = homePath(home)
  const path = recoveryPath(root)
  const parsed = parseRows(path)
  const stateCounts = new Map<string, number>()
  const dailyTotals = new Map<string, number>()
  const dailyVerified = new Map<string, number>()
  let verifiedCount = 0

  for (const row of parsed.rows) {
    const state = String(row.recovery_state)
    const date = new Date(String(row.ts))
    const day = utcDay(date)
    addCount(stateCounts, state)
    addCount(dailyTotals, day)
    if (Boolean(row.verified)) {
      verifiedCount += 1
      addCount(dailyVerified, day)
    }
  }

  const eventsTotal = parsed.rows.length
  const states = Object.fromEntries(
    [...stateCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([state, count]) => [state, { count, ratio: eventsTotal ? count / eventsTotal : 0 }]),
  )
  const pendingCount = [...stateCounts.entries()]
    .filter(([state]) => PENDING_REBUILD_STATES.has(state))
    .reduce((total, [, count]) => total + count, 0)
  const end = new Date(now)
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
  const start = endDay - (TREND_DAYS - 1) * 86_400_000
  const dailyTrend = Array.from({ length: TREND_DAYS }, (_, index) => {
    const date = new Date(start + index * 86_400_000)
    const day = utcDay(date)
    const total = dailyTotals.get(day) ?? 0
    const verified = dailyVerified.get(day) ?? 0
    return { date: day, verified, total, rate: total ? verified / total : 0 }
  })

  return {
    schema_version: 1,
    execution_mode: "read-only-core-memory-recovery",
    side_effects: "none",
    source: {
      status: isFile(path) ? "read" : "missing",
      file: "recovery_outcomes.jsonl",
      rows: eventsTotal,
      corrupt_rows: parsed.corruptRows,
    },
    events_total: eventsTotal,
    states,
    verified_count: verifiedCount,
    restore_success_rate: eventsTotal ? verifiedCount / eventsTotal : 0,
    pending_rebuild_rate: eventsTotal ? pendingCount / eventsTotal : 0,
    daily_trend: dailyTrend,
    corrupt_rows: parsed.corruptRows,
    clear: {
      status: "unsupported",
      reason: "清理恢复日志会删除迁移期证据；等价 typed producer、身份绑定和审计事务完成前保持退出码 2。",
    },
    caveat:
      "这是 profile-local recovery_outcomes.jsonl 的只读聚合；TS/Core 尚未接管旧 Python recovery producer，缺失/损坏行只计入 corrupt_rows，不会影响主会话。",
  }
}

export const MemoryRecoveryAnalysis = {
  report: memoryRecoveryReport,
}
