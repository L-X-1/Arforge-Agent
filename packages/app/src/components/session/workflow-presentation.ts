import type { Locale } from "@/context/language"

type WorkflowLocale = Pick<Intl.DateTimeFormatOptions, never> & { locale: Locale; intl: string }

type LocalizedLabel = readonly [simplified: string, traditional: string, english: string]

const simplified = (locale: Locale) => locale === "zh"
const chinese = (locale: Locale) => locale === "zh" || locale === "zht"

const RUN_STATUS: Record<string, LocalizedLabel> = {
  planned: ["待开始", "待開始", "Ready to start"],
  pending: ["等待中", "等待中", "Pending"],
  running: ["执行中", "執行中", "Running"],
  paused: ["已暂停", "已暫停", "Paused"],
  interrupted: ["已中断，可继续", "已中斷，可繼續", "Interrupted — can resume"],
  waiting_approval: ["等待批准", "等待批准", "Waiting for approval"],
  blocked: ["受阻", "受阻", "Blocked"],
  completed: ["已完成", "已完成", "Completed"],
  failed: ["执行失败", "執行失敗", "Failed"],
  cancelled: ["已取消", "已取消", "Cancelled"],
  canceled: ["已取消", "已取消", "Cancelled"],
  rejected: ["已拒绝", "已拒絕", "Rejected"],
  skipped: ["已跳过", "已跳過", "Skipped"],
}

const NODE_KIND: Record<string, LocalizedLabel> = {
  agent: ["AI 任务", "AI 任務", "AI task"],
  command: ["命令任务", "命令任務", "Command task"],
  approval: ["人工批准", "人工批准", "Human approval"],
  checkpoint: ["检查点", "檢查點", "Checkpoint"],
}

const ACCESS: Record<string, LocalizedLabel> = {
  read: ["只读", "唯讀", "Read only"],
  write: ["可修改文件", "可修改檔案", "May change files"],
}

const PERMISSION: Record<string, LocalizedLabel> = {
  plan: ["规划/只读", "規劃/唯讀", "Plan / read only"],
  acceptEdits: ["允许编辑", "允許編輯", "Edits allowed"],
  fullAccess: ["完全访问", "完整存取", "Full access"],
}

const SCHEDULING_ACTION: Record<string, LocalizedLabel> = {
  single: ["单执行", "單執行", "Single-agent"],
  candidate: ["候选（未自动启用）", "候選（未自動啟用）", "Candidate (not auto-enabled)"],
  multi: ["多执行", "多執行", "Multi-agent"],
}

const EXECUTION_MODE: Record<string, LocalizedLabel> = {
  single: ["单执行", "單執行", "Single-agent"],
  multi: ["多执行", "多執行", "Multi-agent"],
}

const SPLIT_REASON: Record<string, LocalizedLabel> = {
  "independent-read": ["独立只读探索", "獨立唯讀探索", "Independent read exploration"],
  "independent-dag-node": ["DAG 中的独立节点", "DAG 中的獨立節點", "Independent DAG nodes"],
  "specialized-tool-isolation": ["专业工具隔离", "專業工具隔離", "Specialized tool isolation"],
  "risk-isolation": ["风险隔离", "風險隔離", "Risk isolation"],
  "long-context-isolation": ["长上下文隔离", "長上下文隔離", "Long-context isolation"],
}

const SCHEDULING_FAILURE: Record<string, LocalizedLabel> = {
  "fixed-dataset multi-agent benefit evidence is missing": [
    "缺少固定数据集上的收益证据",
    "缺少固定資料集上的收益證據",
    "Fixed-dataset benefit evidence is missing",
  ],
  "no approved promotion policy was supplied": [
    "尚未提供经批准的启用策略",
    "尚未提供經批准的啟用策略",
    "No approved enablement policy was supplied",
  ],
  "no approved independent read/isolation/DAG split condition": [
    "没有满足安全拆分条件",
    "沒有滿足安全拆分條件",
    "No safe split condition was met",
  ],
  "baseline and multi evidence must use the same fixed-dataset sample size": [
    "单执行与多执行证据没有使用同一批样本",
    "單執行與多執行證據沒有使用同一批樣本",
    "Single- and multi-agent evidence did not use the same samples",
  ],
}

function label(table: Record<string, LocalizedLabel>, value: string, locale: Locale) {
  const hit = table[value]
  if (hit) return simplified(locale) ? hit[0] : locale === "zht" ? hit[1] : hit[2]
  return value.replaceAll("_", " ")
}

export const workflowRunStatusLabel = (status: string, locale: Locale) => label(RUN_STATUS, status, locale)
export const workflowNodeKindLabel = (kind: string, locale: Locale) => label(NODE_KIND, kind, locale)
export const workflowAccessLabel = (access: string, locale: Locale) => label(ACCESS, access, locale)
export const workflowPermissionLabel = (mode: string, locale: Locale) => label(PERMISSION, mode, locale)
export const workflowSchedulingActionLabel = (action: string, locale: Locale) => label(SCHEDULING_ACTION, action, locale)
export const workflowExecutionModeLabel = (mode: string, locale: Locale) => label(EXECUTION_MODE, mode, locale)
export const workflowSplitReasonLabel = (reason: string, locale: Locale) => label(SPLIT_REASON, reason, locale)
export const workflowSchedulingFailureLabel = (failure: string, locale: Locale) =>
  label(SCHEDULING_FAILURE, failure, locale)

export function workflowParallelismHelp(locale: Locale) {
  if (locale === "zht") return "這是請求上限，不是並行承諾；沒有經批准的收益證據時，Arforge 只使用一個執行單元。"
  if (simplified(locale)) return "这是请求上限，不是并行承诺；没有经批准的收益证据时，Arforge 只使用一个执行单元。"
  return "This is a requested ceiling, not a promise. Arforge uses one execution unit without approved benefit evidence."
}

export function workflowParallelismLabel(
  scheduling: { requested_max_parallel: number; effective_max_parallel: number },
  locale: Locale,
) {
  if (locale === "zht")
    return `請求上限 ${scheduling.requested_max_parallel} · 實際 ${scheduling.effective_max_parallel}`
  if (simplified(locale))
    return `请求上限 ${scheduling.requested_max_parallel} · 实际 ${scheduling.effective_max_parallel}`
  return `Requested ceiling ${scheduling.requested_max_parallel} · active ${scheduling.effective_max_parallel}`
}

export function workflowSchedulingSummary(
  scheduling: {
    action: string
    execute_mode: string
    eligible: boolean
    effective_max_parallel: number
  },
  locale: Locale,
) {
  if (scheduling.action === "multi" && scheduling.execute_mode === "multi") {
    if (locale === "zht") return `收益證據與策略已通過；本次最多並行 ${scheduling.effective_max_parallel} 個獨立任務。`
    if (simplified(locale))
      return `收益证据与策略已通过；本次最多并行 ${scheduling.effective_max_parallel} 个独立任务。`
    return `Benefit evidence and policy passed; up to ${scheduling.effective_max_parallel} independent tasks may run in parallel.`
  }
  if (scheduling.action === "candidate") {
    if (locale === "zht") return "任務結構允許拆分，但尚未通過固定資料集收益門禁；本次仍使用單執行。"
    if (simplified(locale)) return "任务结构允许拆分，但尚未通过固定数据集收益门禁；本次仍使用单执行。"
    return "The task can be split, but fixed-dataset benefit evidence has not passed; this run remains single-agent."
  }
  if (scheduling.eligible) {
    if (locale === "zht") return "多執行收益檢查未通過；本次使用單執行。"
    if (simplified(locale)) return "多执行收益检查未通过；本次使用单执行。"
    return "Multi-agent benefit checks did not pass; this run uses a single agent."
  }
  if (locale === "zht") return "目前任務結構不適合安全拆分；本次使用單執行。"
  if (simplified(locale)) return "当前任务结构不适合安全拆分；本次使用单执行。"
  return "This task is not structurally safe to split; this run uses a single agent."
}

export function workflowProgressLabel(
  progress: { settled: number; total: number; percent: number },
  locale: Locale,
) {
  if (locale === "zht") return `已處理 ${progress.settled}/${progress.total} 個步驟（${Math.round(progress.percent)}%）`
  if (simplified(locale)) return `已处理 ${progress.settled}/${progress.total} 个步骤（${Math.round(progress.percent)}%）`
  return `${progress.settled}/${progress.total} steps settled (${Math.round(progress.percent)}%)`
}

export function workflowAttemptLabel(attempt: number, maxAttempts: number, locale: Locale) {
  if (attempt === 0) {
    if (locale === "zht") return `尚未嘗試 · 最多 ${maxAttempts} 次`
    if (simplified(locale)) return `尚未尝试 · 最多 ${maxAttempts} 次`
    return `Not attempted · up to ${maxAttempts}`
  }
  if (locale === "zht") return `第 ${attempt}/${maxAttempts} 次嘗試`
  return simplified(locale) ? `第 ${attempt}/${maxAttempts} 次尝试` : `Attempt ${attempt}/${maxAttempts}`
}

export function workflowDurationLabel(milliseconds: number, locale: Locale) {
  const value = Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds) : 0
  if (value < 1_000) return chinese(locale) ? `${value} 毫秒` : `${value} ms`
  const seconds = value / 1_000
  if (seconds < 60) return chinese(locale) ? `${Math.round(seconds)} 秒` : `${Math.round(seconds)} sec`
  const minutes = seconds / 60
  if (minutes < 60) return chinese(locale) ? `${Math.round(minutes)} ${locale === "zht" ? "分鐘" : "分钟"}` : `${Math.round(minutes)} min`
  return chinese(locale) ? `${(minutes / 60).toFixed(1)} ${locale === "zht" ? "小時" : "小时"}` : `${(minutes / 60).toFixed(1)} hr`
}

export function workflowDependencyLabel(dependsOn: readonly string[], locale: Locale) {
  if (dependsOn.length === 0) {
    if (locale === "zht") return "無前置步驟"
    return simplified(locale) ? "无前置步骤" : "No prerequisites"
  }
  return chinese(locale) ? `等待：${dependsOn.join("、")}` : `Depends on: ${dependsOn.join(", ")}`
}

export function workflowProgressBreakdownLabel(byStatus: Readonly<Record<string, number>>, locale: Locale) {
  const entries = Object.entries(byStatus).filter(([, count]) => Number.isFinite(count) && count > 0)
  if (entries.length === 0) {
    if (locale === "zht") return "暫無步驟狀態"
    return simplified(locale) ? "暂无步骤状态" : "No step status yet"
  }
  return entries
    .map(([status, count]) => `${workflowRunStatusLabel(status, locale)} ${count}`)
    .join(chinese(locale) ? "、" : ", ")
}

export function workflowConditionLabel(condition: unknown, locale: Locale) {
  if (condition === null || condition === undefined || condition === "") {
    if (locale === "zht") return "始終執行"
    return simplified(locale) ? "始终执行" : "Always run"
  }
  if (condition === true) {
    if (locale === "zht") return "條件滿足"
    return simplified(locale) ? "条件满足" : "Condition met"
  }
  if (condition === false) {
    if (locale === "zht") return "條件不滿足"
    return simplified(locale) ? "条件不满足" : "Condition not met"
  }
  if (typeof condition === "string" || typeof condition === "number") return String(condition)
  if (
    typeof condition === "object" &&
    !Array.isArray(condition) &&
    Object.values(condition).every(
      (value) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0),
    )
  ) {
    if (locale === "zht") return "始終執行"
    return simplified(locale) ? "始终执行" : "Always run"
  }
  try {
    return JSON.stringify(condition)
  } catch {
    if (locale === "zht") return "條件無法顯示"
    return simplified(locale) ? "条件无法显示" : "Condition unavailable"
  }
}

export function workflowDateTime(value: string | null, options: WorkflowLocale) {
  if (!value) {
    if (options.locale === "zht") return "尚未發生"
    return simplified(options.locale) ? "尚未发生" : "Not yet"
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(options.intl, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

export function workflowNodeSummary(input: {
  status: string
  attempt: number
  maxAttempts: number
  locale: Locale
}) {
  return `${workflowRunStatusLabel(input.status, input.locale)} · ${workflowAttemptLabel(input.attempt, input.maxAttempts, input.locale)}`
}
