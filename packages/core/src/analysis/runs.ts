export * as AnalysisRuns from "./runs"

/**
 * Persisted run artifacts — native TS port of ``arforge/core/run_transaction.py``
 * read surface. Reads the same ``~/.arforge/runs/<run_id>*.json`` files the
 * retired Python agent wrote, so existing run history stays readable.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_PORTABLE_TRACE_BYTES = 5 * 1024 * 1024
const MAX_PORTABLE_TRACE_EVENTS = 5_000
const MAX_REPORT_TRACE_EVENTS = 500
const MAX_REPORT_TRACE_CHARS = 512 * 1024
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

const SENSITIVE_NAMES = new Set(["password", "passwd", "secret", "token", "api_key", "apikey", "authorization"])

export interface RunSummary {
  readonly run_id: string
  readonly created: string
  readonly has_transaction: boolean
  readonly has_trace: boolean
  readonly has_messages: boolean
  readonly changed_files: number
  readonly trace_events: number
  readonly messages_count: number
  readonly answer_preview: string
}

export interface RunCommand {
  readonly command: string
  readonly success: boolean
  readonly returncode: number | null
}

export interface RunReport {
  readonly schema_version: number
  readonly run_id: string
  readonly created: string
  readonly has_transaction: boolean
  readonly has_trace: boolean
  readonly has_messages: boolean
  readonly changed_files: string[]
  readonly commands_run: RunCommand[]
  readonly trace_events: number
  readonly messages_count: number
  readonly answer: string
  readonly observability: unknown
  readonly self_correct: unknown
  readonly trace: unknown[]
  readonly trace_truncated: boolean
}

export interface RunTraceExport {
  readonly format: string
  readonly mime_type: string
  readonly filename: string
  readonly content: string
  readonly trace_events: number
}

export function runsDir(home?: string): string {
  const configured = (home ?? process.env.ARFORGE_HOME)?.trim()
  const base = configured ? configured : join(homedir(), ".arforge")
  return join(base, "runs")
}

export function validatedRunId(runId: string): string {
  const cleaned = String(runId ?? "").trim()
  if (!RUN_ID_PATTERN.test(cleaned) || cleaned.includes("..")) {
    throw new Error("run_id must be a safe identifier up to 120 characters")
  }
  return cleaned
}

export function listReplayRunIds(home?: string): string[] {
  const dir = runsDir(home)
  if (!existsSync(dir)) return []
  const ids = new Set<string>()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    if (name.endsWith(".messages.json")) ids.add(name.slice(0, -".messages.json".length))
    else if (name.endsWith(".trace.json")) ids.add(name.slice(0, -".trace.json".length))
    else ids.add(name.slice(0, -".json".length))
  }
  return [...ids].sort()
}

export function loadRun(runId: string, home?: string): Record<string, unknown> {
  const cleanId = validatedRunId(runId)
  const target = join(runsDir(home), `${cleanId}.json`)
  if (!existsSync(target)) throw new Error(`run transaction not found: ${runId}`)
  return JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>
}

export function loadRunTrace(runId: string, home?: string): Record<string, unknown> {
  const cleanId = validatedRunId(runId)
  const target = join(runsDir(home), `${cleanId}.trace.json`)
  if (!existsSync(target)) throw new Error(`run trace not found: ${runId}`)
  return JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>
}

export function loadRunMessages(runId: string, home?: string): unknown[] {
  const cleanId = validatedRunId(runId)
  const target = join(runsDir(home), `${cleanId}.messages.json`)
  if (!existsSync(target)) throw new Error(`run messages not found: ${runId}`)
  return JSON.parse(readFileSync(target, "utf8")) as unknown[]
}

export function buildRunReport(runId: string, home?: string): RunReport {
  const cleanId = validatedRunId(runId)
  let transaction: Record<string, unknown> | null = null
  let traceDoc: Record<string, unknown> | null = null
  let messages: unknown[] | null = null
  try {
    transaction = loadRun(cleanId, home)
  } catch {
    transaction = null
  }
  try {
    traceDoc = loadRunTrace(cleanId, home)
  } catch {
    traceDoc = null
  }
  try {
    messages = loadRunMessages(cleanId, home)
  } catch {
    messages = null
  }
  if (transaction === null && traceDoc === null && messages === null) {
    throw new Error(`run artifacts not found: ${runId}`)
  }

  const entries = (transaction?.entries as Array<Record<string, unknown>> | undefined) ?? []
  const trace = (traceDoc?.trace as unknown[] | undefined) ?? []
  const commands: RunCommand[] = []
  for (const event of trace) {
    if (typeof event !== "object" || event === null) continue
    const record = event as Record<string, unknown>
    if (!(record.event === "command" || record.event === "run_cmd" || record.tool === "run_cmd")) continue
    const args = typeof record.args === "object" && record.args !== null ? (record.args as Record<string, unknown>) : {}
    const command = String(record.command ?? args.command ?? "")
    const returncode =
      typeof record.returncode === "number" ? record.returncode : typeof record.returncode === "string" ? Number(record.returncode) : null
    const success = typeof record.success === "boolean" ? record.success : (returncode ?? 1) === 0
    commands.push({ command, success, returncode: Number.isNaN(returncode ?? NaN) ? null : returncode })
  }
  const reportTrace: unknown[] = []
  let traceChars = 0
  let traceTruncated = trace.length > MAX_REPORT_TRACE_EVENTS
  for (const event of trace.slice(0, MAX_REPORT_TRACE_EVENTS)) {
    if (typeof event !== "object" || event === null) continue
    const safeEvent = sanitizeForStorage(event) as Record<string, unknown>
    const encoded = JSON.stringify(safeEvent, (key, value) => (typeof value === "object" && value !== null ? value : value))
    if (traceChars + encoded.length > MAX_REPORT_TRACE_CHARS) {
      traceTruncated = true
      break
    }
    reportTrace.push(JSON.parse(encoded))
    traceChars += encoded.length
  }
  const created = String((traceDoc ?? transaction ?? {}).created ?? "")
  return {
    schema_version: 1,
    run_id: cleanId,
    created,
    has_transaction: transaction !== null,
    has_trace: traceDoc !== null,
    has_messages: messages !== null,
    changed_files: entries.map((entry) => String(entry.path ?? "")).filter(Boolean),
    commands_run: commands,
    trace_events: trace.length,
    messages_count: messages?.length ?? 0,
    answer: String((traceDoc ?? {}).answer ?? ""),
    observability: (traceDoc ?? {}).observability ?? {},
    self_correct: (traceDoc ?? {}).self_correct ?? {},
    trace: reportTrace,
    trace_truncated: traceTruncated,
  }
}

export function listRunReports(limit = 20, home?: string): RunSummary[] {
  if (limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100")
  const ids = listReplayRunIds(home)
  const summaries: RunSummary[] = []
  for (const runId of [...ids].reverse().slice(-limit)) {
    let report: RunReport
    try {
      report = buildRunReport(runId, home)
    } catch {
      continue
    }
    summaries.push({
      run_id: report.run_id,
      created: report.created,
      has_transaction: report.has_transaction,
      has_trace: report.has_trace,
      has_messages: report.has_messages,
      changed_files: report.changed_files.length,
      trace_events: report.trace_events,
      messages_count: report.messages_count,
      answer_preview: report.answer.slice(0, 240),
    })
  }
  return summaries
}

export function exportRunTrace(runId: string, home?: string): RunTraceExport {
  const cleanId = validatedRunId(runId)
  const document = loadRunTrace(cleanId, home)
  const trace = document.trace
  if (!Array.isArray(trace) || trace.length > MAX_PORTABLE_TRACE_EVENTS) {
    throw new Error("trace event count exceeds the portable export limit")
  }
  const portable = {
    schema: "arforge.run.trace",
    schema_version: 1,
    run_id: cleanId,
    created: String(document.created ?? "").slice(0, 64),
    trace: sanitizeForStorage(trace),
    observability: sanitizeForStorage(document.observability ?? {}),
    answer: String(sanitizeForStorage(document.answer ?? "")).slice(0, 100_000),
    self_correct: sanitizeForStorage(document.self_correct ?? {}),
  }
  const content = JSON.stringify(portable, null, 2)
  if (Buffer.byteLength(content, "utf8") > MAX_PORTABLE_TRACE_BYTES) {
    throw new Error("trace export exceeds the portable size limit")
  }
  return {
    format: "json",
    mime_type: "application/json",
    filename: `run-trace-${cleanId}.json`,
    content,
    trace_events: trace.length,
  }
}

/**
 * Recursively remove complete credential values before durable storage
 * (native port of ``arforge.security_guard.sanitize_for_storage``).
 */
export function sanitizeForStorage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeForStorage(item))
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = String(key).toLowerCase().replaceAll("-", "_")
      result[key] = SENSITIVE_NAMES.has(normalized) ? "[REDACTED_SECRET]" : sanitizeForStorage(item)
    }
    return result
  }
  if (typeof value !== "string") return value
  let text = value
  text = text.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_SECRET]")
  text = text.replace(/\bghp_[A-Za-z0-9]{36}\b/g, "[REDACTED_SECRET]")
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_SECRET]")
  text = text.replace(/\b(postgresql|postgres|mysql):\/\/([^\s:/]+):([^@\s]+)@/gi, (match, scheme, user) => {
    void match
    return `${scheme}://${user}:[REDACTED_SECRET]@`
  })
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED_SECRET]")
  return text
}
