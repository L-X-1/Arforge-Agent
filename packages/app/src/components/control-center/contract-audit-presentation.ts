import type { Locale } from "@/context/language"
import type { DiagnosticReadOnlyExecutionBoundary } from "@arforge-ai/core/runtime/execution-boundary"

export type ContractAuditSectionID =
  | "file-state"
  | "memory-feedback"
  | "feature-policy-contract"
  | "permission-policy-contract"

export type ContractAuditData = {
  readonly execution_mode: string
  readonly status: string
  readonly ready: boolean
  readonly side_effects: string
  readonly writes: number
  readonly missing_requirements: ReadonlyArray<string>
  readonly caveat: string
  readonly execution_boundary?: DiagnosticReadOnlyExecutionBoundary
}

const language = (locale: Locale) => (locale === "zh" || locale === "zht" ? locale : "en")

export function isContractAuditSectionID(value: string): value is ContractAuditSectionID {
  return (
    value === "file-state" ||
    value === "memory-feedback" ||
    value === "feature-policy-contract" ||
    value === "permission-policy-contract"
  )
}

export function parseContractAudit(value: unknown): ContractAuditData | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Partial<ContractAuditData>
  if (
    typeof candidate.execution_mode !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.ready !== "boolean" ||
    typeof candidate.side_effects !== "string" ||
    typeof candidate.writes !== "number" ||
    !Number.isSafeInteger(candidate.writes) ||
    candidate.writes < 0 ||
    !Array.isArray(candidate.missing_requirements) ||
    !candidate.missing_requirements.every((item) => typeof item === "string") ||
    typeof candidate.caveat !== "string"
  )
    return undefined
  const executionBoundary =
    candidate.execution_boundary === undefined ? undefined : parseExecutionBoundary(candidate.execution_boundary)
  if (candidate.execution_boundary !== undefined && executionBoundary === undefined) return undefined
  return {
    execution_mode: candidate.execution_mode,
    status: candidate.status,
    ready: candidate.ready,
    side_effects: candidate.side_effects,
    writes: candidate.writes,
    missing_requirements: candidate.missing_requirements,
    caveat: candidate.caveat,
    ...(executionBoundary === undefined ? {} : { execution_boundary: executionBoundary }),
  }
}

/**
 * Parse the shared Core boundary without exposing internal field names in the
 * normal UI.  Unknown or widened values are omitted rather than rendered as
 * if they were safe.
 */
export function parseExecutionBoundary(value: unknown): DiagnosticReadOnlyExecutionBoundary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<DiagnosticReadOnlyExecutionBoundary>
  if (
    candidate.mode !== "read-only" ||
    candidate.writes !== false ||
    candidate.repairs_recovery !== false ||
    candidate.provider_execution_allowed !== false ||
    candidate.creates_profile_state !== false ||
    candidate.creates_settlement_state !== false
  )
    return undefined
  return {
    mode: "read-only",
    writes: false,
    repairs_recovery: false,
    provider_execution_allowed: false,
    creates_profile_state: false,
    creates_settlement_state: false,
  }
}

const REQUIREMENT_LABELS: Record<string, { en: string; zh: string; zht: string }> = {
  observation_journal: { en: "Durable observation journal", zh: "持久化观察账本", zht: "持久化觀察帳本" },
  run_session_binding: { en: "Run and session binding", zh: "运行与会话绑定", zht: "執行與會話綁定" },
  workspace_identity_binding: { en: "Workspace and identity binding", zh: "工作区与身份绑定", zht: "工作區與身分綁定" },
  durable_persistence: { en: "Durable persistence", zh: "持久化保存", zht: "持久化保存" },
  restart_recovery: { en: "Restart recovery", zh: "重启恢复", zht: "重新啟動恢復" },
  actor_authorization: { en: "Actor authorization", zh: "操作者授权", zht: "操作者授權" },
  cancellation: { en: "Cancellation handling", zh: "取消处理", zht: "取消處理" },
  transactional_settlement: { en: "Transactional settlement", zh: "事务式结算", zht: "事務式結算" },
  evidence_digest: { en: "Evidence digest", zh: "证据摘要", zht: "證據摘要" },
  retention_or_clear_policy: { en: "Retention or clear policy", zh: "保留或清理策略", zht: "保留或清理策略" },
  durable_retrieval_event: { en: "Durable retrieval event", zh: "持久化检索事件", zht: "持久化檢索事件" },
  retrieval_uid: { en: "Retrieval identity", zh: "检索标识", zht: "檢索識別" },
  returned_set_validation: { en: "Returned-set validation", zh: "返回集合校验", zht: "返回集合校驗" },
  transactional_update: { en: "Transactional update", zh: "事务式更新", zht: "事務式更新" },
  cross_process_evidence: { en: "Cross-process evidence", zh: "跨进程证据", zht: "跨程序證據" },
  durable_feature_state: { en: "Durable feature state", zh: "持久化功能状态", zht: "持久化功能狀態" },
  rollback_or_recovery: { en: "Rollback or recovery", zh: "回滚或恢复", zht: "回滾或恢復" },
  audit_evidence: { en: "Audit evidence", zh: "审计证据", zht: "稽核證據" },
  cross_process_consistency: { en: "Cross-process consistency", zh: "跨进程一致性", zht: "跨程序一致性" },
  typed_rule_schema: { en: "Typed rule schema", zh: "类型化规则结构", zht: "型別化規則結構" },
  workspace_project_binding: { en: "Workspace and project binding", zh: "工作区与项目绑定", zht: "工作區與專案綁定" },
  optimistic_revision: { en: "Optimistic revision check", zh: "乐观版本校验", zht: "樂觀版本校驗" },
}

/** Render a known requirement without exposing internal snake_case identifiers. */
export function contractAuditRequirementLabel(requirement: string, locale: Locale = "en") {
  const labels = REQUIREMENT_LABELS[requirement]
  if (!labels) {
    if (locale === "zh") return "其他迁移要求"
    if (locale === "zht") return "其他遷移要求"
    return "Additional migration requirement"
  }
  return labels[language(locale)]
}

export function contractAuditTitle(id: ContractAuditSectionID, locale: Locale = "en") {
  const titles = {
    en: {
      "file-state": "File observation contract",
      "memory-feedback": "Memory feedback contract",
      "feature-policy-contract": "Feature policy migration",
      "permission-policy-contract": "Permission policy migration",
    },
    zh: {
      "file-state": "文件观察合同",
      "memory-feedback": "记忆反馈合同",
      "feature-policy-contract": "功能策略迁移",
      "permission-policy-contract": "权限策略迁移",
    },
    zht: {
      "file-state": "文件觀察合約",
      "memory-feedback": "記憶回饋合約",
      "feature-policy-contract": "功能策略遷移",
      "permission-policy-contract": "權限策略遷移",
    },
  } as const
  return titles[language(locale)][id]
}

export function contractAuditStatus(data: Pick<ContractAuditData, "status" | "ready">, locale: Locale = "en") {
  const labels = {
    en: {
      ready: "Ready",
      notReady: "Not ready (fail-closed)",
      review: "Review required (fail-closed)",
    },
    zh: {
      ready: "已具备条件",
      notReady: "尚未完成（fail-closed）",
      review: "需要复核（fail-closed）",
    },
    zht: {
      ready: "已具備條件",
      notReady: "尚未完成（fail-closed）",
      review: "需要覆核（fail-closed）",
    },
  } as const
  const copy = labels[language(locale)]
  return data.ready && data.status === "ready" ? copy.ready : data.status === "not_ready" ? copy.notReady : copy.review
}

export function contractAuditEffect(data: Pick<ContractAuditData, "side_effects" | "writes">, locale: Locale = "en") {
  const labels = {
    en: { none: "Read-only · no writes", writes: "Writes reported: {{count}}" },
    zh: { none: "只读 · 不写入", writes: "报告写入次数：{{count}}" },
    zht: { none: "唯讀 · 不寫入", writes: "報告寫入次數：{{count}}" },
  } as const
  const copy = labels[language(locale)]
  return data.side_effects === "none" && data.writes === 0
    ? copy.none
    : copy.writes.replace("{{count}}", String(data.writes))
}

export function contractAuditBoundaryLabel(
  boundary: DiagnosticReadOnlyExecutionBoundary | undefined,
  locale: Locale = "en",
): string {
  // Keep the field reads explicit: this is a user-facing summary of the
  // validated card, not a free-form translation of untrusted report text.
  if (!boundary)
    return language(locale) === "zh"
      ? "执行边界不可用 · 不要将此审计结果视为执行权限"
      : language(locale) === "zht"
        ? "執行邊界不可用 · 不要將此稽核結果視為執行權限"
        : "Execution boundary unavailable · do not treat this audit as execution permission"
  if (
    boundary.mode !== "read-only" ||
    boundary.writes !== false ||
    boundary.repairs_recovery !== false ||
    boundary.provider_execution_allowed !== false ||
    boundary.creates_profile_state !== false ||
    boundary.creates_settlement_state !== false
  )
    return language(locale) === "zh"
      ? "执行边界无法验证"
      : language(locale) === "zht"
        ? "執行邊界無法驗證"
        : "Execution boundary unavailable"
  const labels = {
    en: "Execution boundary: read-only · no writes, state creation, recovery repair, or Provider execution",
    zh: "执行边界：只读 · 不写入、不创建状态、不修复 recovery、不调用 Provider",
    zht: "執行邊界：唯讀 · 不寫入、不建立狀態、不修復 recovery、不呼叫 Provider",
  } as const
  return labels[language(locale)]
}

export function contractAuditMissingLabel(count: number, locale: Locale = "en") {
  const labels = {
    en: count === 0 ? "No missing requirements" : `Missing requirements (${count})`,
    zh: count === 0 ? "没有缺口" : `尚缺要求（${count}）`,
    zht: count === 0 ? "沒有缺口" : `尚缺要求（${count}）`,
  } as const
  return labels[language(locale)]
}

export function contractAuditEvidenceLabel(locale: Locale = "en") {
  return { en: "Advanced evidence", zh: "高级证据", zht: "進階證據" }[language(locale)]
}
