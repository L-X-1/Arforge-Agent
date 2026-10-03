/**
 * Unified Agent quality telemetry.
 *
 * This is the TypeScript/Core owner for the historical Python
 * ``arforge agent-metrics`` report.  The source files are deliberately
 * append-only local telemetry, so the reader is tolerant of missing files,
 * malformed lines and old rows.  Telemetry must never make the main CLI fail.
 */

import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { resolve, join } from "node:path"
import { Global } from "../global"

type JsonRecord = Record<string, unknown>

const SCHEMA_VERSION = 1 as const
const SOURCE_NAMES = [
  "dogfood",
  "metrics_jsonl",
  "self_correct_learning",
  "recovery_outcomes",
  "eval_baseline",
  "regression_runs",
] as const

const INVALID_ACTION_NO_DATA_NOTE =
  "生产管道尚未落盘 failed_tool_calls（metrics.jsonl 与 dogfood.jsonl 均缺少该字段）"

export type AgentMetricsSourceName = (typeof SOURCE_NAMES)[number]

export interface AgentMetricsOptions {
  /** Profile directory containing the six telemetry sources. */
  readonly home?: string
}

export interface AgentMetric {
  readonly value: number | null
  [key: string]: unknown
}

export interface AgentMetricsReport {
  readonly schema_version: typeof SCHEMA_VERSION
  readonly generated_at: string
  readonly metrics: Readonly<Record<string, AgentMetric>>
  readonly sources: Readonly<Record<AgentMetricsSourceName, JsonRecord>>
  readonly gates: {
    readonly formal_dogfood: string
    readonly longitudinal_dogfood: string
  }
  readonly error?: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function integerValue(value: unknown): number {
  return Math.trunc(numberValue(value))
}

function truthy(value: unknown): boolean {
  return Boolean(value)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function recordHashValid(row: JsonRecord): boolean {
  const expected = typeof row.record_hash === "string" ? row.record_hash : ""
  if (!expected) return false
  const payload = { ...row }
  delete payload.record_hash
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex") === expected
}

function safePath(home?: string): string {
  const configured = (home ?? process.env.ARFORGE_HOME)?.trim()
  return resolve(configured || Global.Path.data)
}

export function agentMetricsHome(home?: string): string {
  return safePath(home)
}

function sourcePath(home: string, name: AgentMetricsSourceName): string {
  const filename: Record<AgentMetricsSourceName, string> = {
    dogfood: "dogfood.jsonl",
    metrics_jsonl: "metrics.jsonl",
    self_correct_learning: "self_correct_learning.json",
    recovery_outcomes: "recovery_outcomes.jsonl",
    eval_baseline: "eval_baseline.json",
    regression_runs: "regression_runs.jsonl",
  }
  return join(home, filename[name])
}

function historyPath(home: string): string {
  return join(home, "agent_metrics.jsonl")
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function readJsonl(path: string): JsonRecord[] {
  if (!isFile(path)) return []
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const rows: JsonRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) rows.push(parsed)
    } catch {
      // A malformed telemetry line is isolated from the rest of the report.
    }
  }
  return rows
}

function readJson(path: string): JsonRecord {
  if (!isFile(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function loadAgentOutcomes(home?: string): JsonRecord[] {
  return readJsonl(sourcePath(safePath(home), "dogfood"))
}

function successRate(rows: JsonRecord[]): JsonRecord {
  const total = rows.length
  const passed = rows.filter((row) => truthy(row.success)).length
  return {
    value: total ? passed / total : 0,
    total,
    passed,
    failed: total - passed,
    success_rate: total ? Number((passed / total).toFixed(4)) : 0,
  }
}

function metricSuccessRate(rows: JsonRecord[]): AgentMetric {
  const aggregate = successRate(rows)
  return {
    value: aggregate.total ? Number(numberValue(aggregate.success_rate).toFixed(4)) : null,
    n: aggregate.total,
    source: "dogfood",
  }
}

function averageToolCalls(rows: JsonRecord[]): AgentMetric {
  const calls = rows.reduce((total, row) => total + integerValue(row.tool_calls), 0)
  return {
    value: rows.length ? Number((calls / rows.length).toFixed(2)) : null,
    n: rows.length,
    source: "dogfood",
  }
}

function invalidActionRate(metricsRows: JsonRecord[], dogfoodRows: JsonRecord[]): AgentMetric {
  const preferred = metricsRows.filter((row) => row.failed_tool_calls !== undefined && row.failed_tool_calls !== null)
  const fallback = dogfoodRows.filter((row) => row.failed_tool_calls !== undefined && row.failed_tool_calls !== null)
  const rows = preferred.length ? preferred : fallback
  const source = preferred.length ? "metrics_jsonl" : fallback.length ? "dogfood" : undefined
  const toolCalls = rows.reduce((total, row) => total + integerValue(row.tool_calls), 0)
  const failed = rows.reduce((total, row) => total + integerValue(row.failed_tool_calls), 0)
  if (!source || toolCalls === 0) {
    return {
      value: null,
      tool_calls: toolCalls,
      failed,
      source: source ?? null,
      note: INVALID_ACTION_NO_DATA_NOTE,
    }
  }
  return { value: Number((failed / toolCalls).toFixed(4)), tool_calls: toolCalls, failed, source }
}

function emptyFormalReport() {
  return {
    schema_version: SCHEMA_VERSION,
    status: "insufficient_evidence",
    total_records: 0,
    formal_verified_records: 0,
    all_qualifying_records: 0,
    selected_run_id: "",
    formal_runs: 0,
    qualifying_records: 0,
    unique_qualifying_tasks: 0,
    duplicate_task_ids: [],
    passed: 0,
    failed: 0,
    success_rate: 0,
    categories: [],
    missing_categories: [],
    total_duration_seconds: 0,
    requirements: {
      minimum_tasks: 50,
      minimum_duration_seconds: 15,
      minimum_tokens: 50_000,
      minimum_steps: 5,
      minimum_tool_calls: 5,
      minimum_success_rate: 0.9,
      required_categories: [],
    },
    checks: {
      minimum_tasks: false,
      minimum_success_rate: false,
      required_categories: true,
      unique_task_ids: true,
    },
    failed_checks: ["minimum_tasks", "minimum_success_rate"],
  }
}

export interface FormalDogfoodOptions {
  readonly minimum_tasks?: number
  readonly minimum_duration_seconds?: number
  readonly minimum_tokens?: number
  readonly minimum_steps?: number
  readonly minimum_tool_calls?: number
  readonly minimum_success_rate?: number
  readonly required_categories?: readonly string[]
}

export function formalDogfoodReport(rows: readonly JsonRecord[], options: FormalDogfoodOptions = {}): JsonRecord {
  const minimumTasks = options.minimum_tasks ?? 50
  const minimumDuration = options.minimum_duration_seconds ?? 15
  const minimumTokens = options.minimum_tokens ?? 50_000
  const minimumSteps = options.minimum_steps ?? 5
  const minimumToolCalls = options.minimum_tool_calls ?? 5
  const minimumSuccessRate = options.minimum_success_rate ?? 0.9
  const requiredCategories = [...(options.required_categories ?? [])]
  if (minimumTasks < 1 || minimumDuration < 0 || minimumTokens < 0 || !Number.isFinite(minimumSuccessRate) || minimumSuccessRate < 0 || minimumSuccessRate > 1) {
    return emptyFormalReport()
  }

  const formalRows = rows.filter(
    (row) =>
      integerValue(row.schema_version) >= 2 &&
      truthy(row.formal) &&
      truthy(row.real_model) &&
      truthy(row.isolated_workspace) &&
      isRecord(row.verification) &&
      Object.keys(row.verification).length > 0 &&
      recordHashValid(row),
  )
  const qualifying = formalRows.filter(
    (row) =>
      numberValue(row.duration_seconds) >= minimumDuration &&
      integerValue(row.tokens) >= minimumTokens &&
      integerValue(row.steps) >= minimumSteps &&
      integerValue(row.tool_calls) >= minimumToolCalls &&
      String(row.run_id ?? "").trim() !== "" &&
      String(row.task_id ?? "").trim() !== "",
  )
  const runs = new Map<string, JsonRecord[]>()
  for (const row of qualifying) {
    const key = String(row.run_id)
    const existing = runs.get(key) ?? []
    existing.push(row)
    runs.set(key, existing)
  }
  let selectedRunID = ""
  let selectedRows: JsonRecord[] = []
  for (const [runID, runRows] of runs) {
    if (runRows.length >= selectedRows.length) {
      selectedRunID = runID
      selectedRows = runRows
    }
  }
  const taskCounts = new Map<string, number>()
  for (const row of selectedRows) {
    const taskID = String(row.task_id)
    taskCounts.set(taskID, (taskCounts.get(taskID) ?? 0) + 1)
  }
  const uniqueRows = selectedRows.filter((row) => taskCounts.get(String(row.task_id)) === 1)
  const passed = uniqueRows.filter((row) => truthy(row.success)).length
  const rate = uniqueRows.length ? passed / uniqueRows.length : 0
  const categories = [...new Set(uniqueRows.map((row) => String(row.task_category ?? "").trim()).filter(Boolean))].sort()
  const missingCategories = requiredCategories.filter((category) => !categories.includes(category)).sort()
  const checks = {
    minimum_tasks: uniqueRows.length >= minimumTasks,
    minimum_success_rate: rate >= minimumSuccessRate,
    required_categories: missingCategories.length === 0,
    unique_task_ids: uniqueRows.length === selectedRows.length,
  }
  const evidenceReady = checks.minimum_tasks && checks.required_categories
  const status = evidenceReady ? (checks.minimum_success_rate && checks.unique_task_ids ? "pass" : "fail") : "insufficient_evidence"
  return {
    schema_version: SCHEMA_VERSION,
    status,
    total_records: rows.length,
    formal_verified_records: formalRows.length,
    all_qualifying_records: qualifying.length,
    selected_run_id: selectedRunID,
    formal_runs: runs.size,
    qualifying_records: selectedRows.length,
    unique_qualifying_tasks: uniqueRows.length,
    duplicate_task_ids: [...taskCounts.entries()].filter(([, count]) => count > 1).map(([taskID]) => taskID).sort(),
    passed,
    failed: uniqueRows.length - passed,
    success_rate: Number(rate.toFixed(4)),
    categories,
    missing_categories: missingCategories,
    total_duration_seconds: Number(uniqueRows.reduce((total, row) => total + numberValue(row.duration_seconds), 0).toFixed(2)),
    requirements: {
      minimum_tasks: minimumTasks,
      minimum_duration_seconds: minimumDuration,
      minimum_tokens: minimumTokens,
      minimum_steps: minimumSteps,
      minimum_tool_calls: minimumToolCalls,
      minimum_success_rate: minimumSuccessRate,
      required_categories: requiredCategories,
    },
    checks,
    failed_checks: Object.entries(checks).filter(([, passedCheck]) => !passedCheck).map(([name]) => name),
  }
}

export interface LongitudinalDogfoodOptions {
  readonly minimum_unique_tasks?: number
  readonly minimum_suites?: number
  readonly minimum_categories?: number
  readonly minimum_first_attempt_success_rate?: number
  readonly minimum_latest_success_rate?: number
  readonly minimum_duration_seconds?: number
  readonly minimum_tokens?: number
  readonly minimum_steps?: number
  readonly minimum_tool_calls?: number
}

export function longitudinalDogfoodReport(rows: readonly JsonRecord[], options: LongitudinalDogfoodOptions = {}): JsonRecord {
  const minimumUniqueTasks = options.minimum_unique_tasks ?? 100
  const minimumSuites = options.minimum_suites ?? 2
  const minimumCategories = options.minimum_categories ?? 17
  const minimumFirstRate = options.minimum_first_attempt_success_rate ?? 0.9
  const minimumLatestRate = options.minimum_latest_success_rate ?? 0.98
  const minimumDuration = options.minimum_duration_seconds ?? 15
  const minimumTokens = options.minimum_tokens ?? 50_000
  const minimumSteps = options.minimum_steps ?? 5
  const minimumToolCalls = options.minimum_tool_calls ?? 5
  if (minimumUniqueTasks < 1 || minimumSuites < 1 || minimumCategories < 1 || minimumFirstRate < 0 || minimumFirstRate > 1 || minimumLatestRate < 0 || minimumLatestRate > 1) {
    return {
      schema_version: SCHEMA_VERSION,
      status: "insufficient_evidence",
      total_records: rows.length,
      qualifying_attempts: 0,
      unique_tasks: 0,
      suites: [],
      categories: [],
      first_attempt_passed: 0,
      first_attempt_failed: 0,
      first_attempt_success_rate: 0,
      latest_passed: 0,
      latest_failed: 0,
      latest_success_rate: 0,
      recovered_tasks: 0,
      regressed_tasks: 0,
      repeated_attempts: 0,
      requirements: {},
      checks: {},
      failed_checks: [],
    }
  }
  const qualifying: JsonRecord[] = []
  rows.forEach((row, sequence) => {
    const valid =
      integerValue(row.schema_version) >= 2 &&
      truthy(row.formal) &&
      truthy(row.real_model) &&
      truthy(row.isolated_workspace) &&
      truthy(row.verification_passed) === truthy(row.success) &&
      isRecord(row.verification) &&
      Object.keys(row.verification).length > 0 &&
      recordHashValid(row) &&
      String(row.suite_id ?? "").trim() !== "" &&
      String(row.task_id ?? "").trim() !== "" &&
      numberValue(row.duration_seconds) >= minimumDuration &&
      integerValue(row.tokens) >= minimumTokens &&
      integerValue(row.steps) >= minimumSteps &&
      integerValue(row.tool_calls) >= minimumToolCalls
    if (valid) qualifying.push({ ...row, _sequence: sequence })
  })
  const attempts = new Map<string, JsonRecord[]>()
  for (const row of qualifying) {
    const key = `${String(row.suite_id)}\u0000${String(row.task_id)}`
    const existing = attempts.get(key) ?? []
    existing.push(row)
    attempts.set(key, existing)
  }
  for (const values of attempts.values()) values.sort((left, right) => integerValue(left._sequence) - integerValue(right._sequence))
  const firstRows = [...attempts.values()].map((values) => values[0]).filter((row): row is JsonRecord => row !== undefined)
  const latestRows = [...attempts.values()].map((values) => values[values.length - 1]).filter((row): row is JsonRecord => row !== undefined)
  const firstPassed = firstRows.filter((row) => truthy(row.success)).length
  const latestPassed = latestRows.filter((row) => truthy(row.success)).length
  const uniqueTasks = attempts.size
  const firstRate = uniqueTasks ? firstPassed / uniqueTasks : 0
  const latestRate = uniqueTasks ? latestPassed / uniqueTasks : 0
  const recovered = [...attempts.values()].filter((values) => !truthy(values[0]?.success) && truthy(values[values.length - 1]?.success)).length
  const regressed = [...attempts.values()].filter((values) => truthy(values[0]?.success) && !truthy(values[values.length - 1]?.success)).length
  const suites = [...new Set(latestRows.map((row) => String(row.suite_id)))].sort()
  const categories = [...new Set(latestRows.map((row) => String(row.task_category ?? "")).filter((category) => category.trim() !== ""))].sort()
  const checks = {
    minimum_unique_tasks: uniqueTasks >= minimumUniqueTasks,
    minimum_suites: suites.length >= minimumSuites,
    minimum_categories: categories.length >= minimumCategories,
    minimum_first_attempt_success_rate: firstRate >= minimumFirstRate,
    minimum_latest_success_rate: latestRate >= minimumLatestRate,
    no_regressions: regressed === 0,
  }
  const evidenceReady = checks.minimum_unique_tasks && checks.minimum_suites && checks.minimum_categories
  return {
    schema_version: SCHEMA_VERSION,
    status: evidenceReady ? (Object.values(checks).every(Boolean) ? "pass" : "fail") : "insufficient_evidence",
    total_records: rows.length,
    qualifying_attempts: qualifying.length,
    unique_tasks: uniqueTasks,
    suites,
    categories,
    first_attempt_passed: firstPassed,
    first_attempt_failed: uniqueTasks - firstPassed,
    first_attempt_success_rate: Number(firstRate.toFixed(4)),
    latest_passed: latestPassed,
    latest_failed: uniqueTasks - latestPassed,
    latest_success_rate: Number(latestRate.toFixed(4)),
    recovered_tasks: recovered,
    regressed_tasks: regressed,
    repeated_attempts: qualifying.length - uniqueTasks,
    requirements: {
      minimum_unique_tasks: minimumUniqueTasks,
      minimum_suites: minimumSuites,
      minimum_categories: minimumCategories,
      minimum_first_attempt_success_rate: minimumFirstRate,
      minimum_latest_success_rate: minimumLatestRate,
      minimum_duration_seconds: minimumDuration,
      minimum_tokens: minimumTokens,
      minimum_steps: minimumSteps,
      minimum_tool_calls: minimumToolCalls,
    },
    checks,
    failed_checks: Object.entries(checks).filter(([, passedCheck]) => !passedCheck).map(([name]) => name),
  }
}

function firstAttemptSuccessRate(report: JsonRecord): AgentMetric {
  const unique = integerValue(report.unique_tasks)
  return {
    value: unique ? Number(numberValue(report.first_attempt_success_rate).toFixed(4)) : null,
    n: unique,
    source: "longitudinal_dogfood",
  }
}

function recoverySuccessRate(longReport: JsonRecord, selfCorrect: JsonRecord, recoveryRows: JsonRecord[]): AgentMetric {
  const recovered = integerValue(longReport.recovered_tasks)
  const firstFailed = integerValue(longReport.first_attempt_failed)
  const taskLevel = firstFailed ? Number((recovered / firstFailed).toFixed(4)) : null
  const taskDetail = { value: taskLevel, recovered, first_failed: firstFailed }

  const hint = selfCorrect._hint_performance
  let successTotal = 0
  let failureTotal = 0
  let classes = 0
  if (isRecord(hint)) {
    for (const performance of Object.values(hint)) {
      if (!isRecord(performance)) continue
      classes += 1
      successTotal += integerValue(performance.success)
      failureTotal += integerValue(performance.failure)
    }
  }
  const attemptsTotal = successTotal + failureTotal
  const hintLevel = attemptsTotal ? Number((successTotal / attemptsTotal).toFixed(4)) : null
  const events = recoveryRows.length
  const verified = recoveryRows.filter((row) => truthy(row.verified)).length
  const contextRestore = events ? Number((verified / events).toFixed(4)) : null
  const detail = {
    task_level: taskDetail,
    hint_level: { value: hintLevel, classes, total_attempts: attemptsTotal },
    context_restore: { value: contextRestore, verified, events },
  }
  const values = Object.values(detail).map((entry) => entry.value).filter((value): value is number => value !== null)
  return { value: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null, detail }
}

function verificationMetrics(rows: JsonRecord[]): [AgentMetric, AgentMetric] {
  const wrote = rows.filter((row) => integerValue(row.modified_files) > 0)
  const verified = wrote.filter((row) => (isRecord(row.verification) && Object.keys(row.verification).length > 0) || truthy(row.verification_passed))
  const passed = verified.filter((row) => truthy(row.verification_passed)).length
  return [
    { value: wrote.length ? Number((verified.length / wrote.length).toFixed(4)) : null, wrote: wrote.length, verified: verified.length, source: "dogfood" },
    { value: verified.length ? Number((passed / verified.length).toFixed(4)) : null, n: verified.length },
  ]
}

function patchRegressionRate(longReport: JsonRecord, regressionRows: JsonRecord[], evalBaseline: JsonRecord): AgentMetric {
  const regressed = integerValue(longReport.regressed_tasks)
  const total = integerValue(longReport.unique_tasks)
  const result: AgentMetric = {
    value: total ? Number((regressed / total).toFixed(4)) : null,
    regressed,
    total,
    source: "longitudinal_dogfood",
  }
  if (regressionRows.length) {
    const withFailures = regressionRows.filter((row) => integerValue(row.failed) > 0).length
    result.regression_runs = { runs: regressionRows.length, with_failures: withFailures, rate: Number((withFailures / regressionRows.length).toFixed(4)) }
  }
  if (Object.keys(evalBaseline).length) {
    const baseline: JsonRecord = {}
    if (evalBaseline.success_rate !== undefined) baseline.success_rate = evalBaseline.success_rate
    const savedAt = evalBaseline.saved_at ?? evalBaseline.ts
    if (savedAt !== undefined && savedAt !== null) baseline.saved_at = savedAt
    if (Object.keys(baseline).length) result.eval_baseline = baseline
  }
  return result
}

function fingerprintCount(selfCorrect: JsonRecord): number {
  return Object.keys(selfCorrect).filter((key) => key !== "_hint_performance").length
}

function sourcesSummary(home: string, dogfoodRows: JsonRecord[], metricsRows: JsonRecord[], selfCorrect: JsonRecord, recoveryRows: JsonRecord[], evalBaseline: JsonRecord, regressionRows: JsonRecord[]): Record<AgentMetricsSourceName, JsonRecord> {
  return {
    dogfood: isFile(sourcePath(home, "dogfood")) ? { status: "ok", rows: dogfoodRows.length } : { status: "missing" },
    metrics_jsonl: isFile(sourcePath(home, "metrics_jsonl")) ? { status: "ok", rows: metricsRows.length } : { status: "missing" },
    self_correct_learning: isFile(sourcePath(home, "self_correct_learning")) ? { status: "ok", fingerprints: fingerprintCount(selfCorrect) } : { status: "missing" },
    recovery_outcomes: isFile(sourcePath(home, "recovery_outcomes")) ? { status: "ok", rows: recoveryRows.length } : { status: "missing" },
    eval_baseline: isFile(sourcePath(home, "eval_baseline")) ? { status: "ok" } : { status: "missing" },
    regression_runs: isFile(sourcePath(home, "regression_runs")) ? { status: "ok", rows: regressionRows.length } : { status: "missing" },
  }
}

function emptyMetrics(): Readonly<Record<string, AgentMetric>> {
  return {
    success_rate: { value: null, n: 0, source: "dogfood" },
    avg_tool_calls: { value: null, n: 0, source: "dogfood" },
    invalid_action_rate: { value: null, tool_calls: 0, failed: 0, source: null, note: INVALID_ACTION_NO_DATA_NOTE },
    first_attempt_success_rate: { value: null, n: 0, source: "longitudinal_dogfood" },
    recovery_success_rate: {
      value: null,
      detail: {
        task_level: { value: null, recovered: 0, first_failed: 0 },
        hint_level: { value: null, classes: 0, total_attempts: 0 },
        context_restore: { value: null, verified: 0, events: 0 },
      },
    },
    verification_coverage: { value: null, wrote: 0, verified: 0, source: "dogfood" },
    verification_pass_rate: { value: null, n: 0 },
    patch_regression_rate: { value: null, regressed: 0, total: 0, source: "longitudinal_dogfood" },
  }
}

function buildReport(home: string): AgentMetricsReport {
  const dogfoodRows = loadAgentOutcomes(home)
  const metricsRows = readJsonl(sourcePath(home, "metrics_jsonl"))
  const selfCorrect = readJson(sourcePath(home, "self_correct_learning"))
  const recoveryRows = readJsonl(sourcePath(home, "recovery_outcomes"))
  const regressionRows = readJsonl(sourcePath(home, "regression_runs"))
  const evalBaseline = readJson(sourcePath(home, "eval_baseline"))
  const formal = formalDogfoodReport(dogfoodRows)
  const longitudinal = longitudinalDogfoodReport(dogfoodRows)
  const [verificationCoverage, verificationPassRate] = verificationMetrics(dogfoodRows)
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    metrics: {
      success_rate: metricSuccessRate(dogfoodRows),
      avg_tool_calls: averageToolCalls(dogfoodRows),
      invalid_action_rate: invalidActionRate(metricsRows, dogfoodRows),
      first_attempt_success_rate: firstAttemptSuccessRate(longitudinal),
      recovery_success_rate: recoverySuccessRate(longitudinal, selfCorrect, recoveryRows),
      verification_coverage: verificationCoverage,
      verification_pass_rate: verificationPassRate,
      patch_regression_rate: patchRegressionRate(longitudinal, regressionRows, evalBaseline),
    },
    sources: sourcesSummary(home, dogfoodRows, metricsRows, selfCorrect, recoveryRows, evalBaseline, regressionRows),
    gates: {
      formal_dogfood: String(formal.status),
      longitudinal_dogfood: String(longitudinal.status),
    },
  }
}

export function agentMetricsReport(home?: string): AgentMetricsReport {
  try {
    return buildReport(safePath(home))
  } catch (error) {
    return {
      schema_version: SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      metrics: emptyMetrics(),
      sources: Object.fromEntries(SOURCE_NAMES.map((name) => [name, { status: "error" }])) as unknown as Record<AgentMetricsSourceName, JsonRecord>,
      gates: { formal_dogfood: "insufficient_evidence", longitudinal_dogfood: "insufficient_evidence" },
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function readAgentMetricsHistory(limit = 50, home?: string): JsonRecord[] {
  const bounded = Math.max(0, Math.trunc(numberValue(limit)))
  const rows = readJsonl(historyPath(safePath(home)))
  return bounded ? rows.slice(-bounded) : []
}

export function agentMetricsHistory(limit = 50, home?: string): JsonRecord[] {
  const root = safePath(home)
  const report = agentMetricsReport(root)
  const entry = {
    ts: report.generated_at,
    schema_version: SCHEMA_VERSION,
    metrics: Object.fromEntries(Object.entries(report.metrics).map(([name, metric]) => [name, metric.value])),
    sources: Object.fromEntries(Object.entries(report.sources).map(([name, source]) => [name, source.status])),
    gates: report.gates,
  }
  try {
    mkdirSync(root, { recursive: true })
    appendFileSync(historyPath(root), `${JSON.stringify(entry)}\n`, "utf8")
  } catch {
    // History is best effort and must never block a report or session.
  }
  return readAgentMetricsHistory(limit, root)
}

export function clearAgentMetricsHistory(home?: string): number {
  const path = historyPath(safePath(home))
  if (!isFile(path)) return 0
  const count = readJsonl(path).length
  try {
    unlinkSync(path)
    return count
  } catch {
    return 0
  }
}
