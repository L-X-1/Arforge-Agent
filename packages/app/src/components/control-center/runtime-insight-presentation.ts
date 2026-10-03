import type { Locale } from "@/context/language"

type Localized = readonly [string, string, string]

const localized = (value: Localized, locale: Locale) => value[locale === "zh" ? 1 : locale === "zht" ? 2 : 0]

const localeForIntl = (locale: Locale) => (locale === "zh" ? "zh-CN" : locale === "zht" ? "zh-TW" : locale)

export const formatRuntimeTime = (value: string | number | Date, locale: Locale) =>
  new Date(value).toLocaleTimeString(localeForIntl(locale))

export function runStatus(status: string, locale: Locale): { text: string; color: string } {
  const labels: Record<string, Localized> = {
    draft: ["Preparing", "准备执行", "準備執行"],
    preflight: ["Preparing", "准备执行", "準備執行"],
    queued: ["Preparing", "准备执行", "準備執行"],
    awaiting_authorization: ["Needs your confirmation", "需要你确认", "需要你確認"],
    running: ["Running automatically", "自动执行中", "自動執行中"],
    paused: ["Paused; waiting to resume", "已暂停等待接管", "已暫停等待接管"],
    recovering: ["Recovering automatically", "正在自动恢复", "正在自動恢復"],
    verifying: ["Verifying", "验证中", "驗證中"],
    completed: ["Completed", "已完成", "已完成"],
    failed: ["Failed", "失败", "失敗"],
    cancelled: ["Cancelled", "已取消", "已取消"],
    interrupted: ["Interrupted", "已中断", "已中斷"],
  }
  const hit = labels[status]
  const text = hit
    ? localized(hit, locale)
    : `${locale === "zh" ? "未知状态" : locale === "zht" ? "未知狀態" : "Unknown status"}: ${status}`
  const color = ["draft", "preflight", "queued", "recovering", "verifying"].includes(status)
    ? "#818cf8"
    : status === "awaiting_authorization" || status === "paused" || status === "interrupted"
      ? "#f59e0b"
      : status === "running"
        ? "#22c55e"
        : status === "failed"
          ? "#ef4444"
          : "#8b8b8b"
  return { text, color }
}

export function admissionStatusText(status: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    admitted: ["Admitted", "已准入", "已准入"],
    opt_in_required: ["Opt-in required", "需要显式启用", "需要明確啟用"],
    workspace_untrusted: ["Workspace trust required", "需要信任工作区", "需要信任工作區"],
    unsupported_tools: ["Unsupported tools", "存在不支持的工具", "存在不支援的工具"],
    collision: ["Profile collision", "配置名称冲突", "設定名稱衝突"],
  }
  return labels[status]
    ? localized(labels[status], locale)
    : `${locale === "zh" ? "未知准入状态" : locale === "zht" ? "未知准入狀態" : "Unknown admission status"}: ${status}`
}

export function admissionDecisionText(decision: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    admitted: ["Allowed to start", "允许启动", "允許啟動"],
    blocked: ["Blocked before start", "启动前已阻止", "啟動前已阻止"],
  }
  return labels[decision]
    ? localized(labels[decision], locale)
    : `${locale === "zh" ? "未知准入决定" : locale === "zht" ? "未知准入決定" : "Unknown admission decision"}: ${decision}`
}

export function authorityText(authority: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    automatic: ["Automatic", "自动执行", "自動執行"],
    scoped_grant: ["Scoped permission", "范围授权", "範圍授權"],
    human: ["Human approved", "需要你确认", "需要你確認"],
    forbidden: ["Blocked by policy", "系统禁止", "系統禁止"],
  }
  return labels[authority]
    ? localized(labels[authority], locale)
    : `${locale === "zh" ? "未知授权" : locale === "zht" ? "未知授權" : "Unknown authority"}: ${authority}`
}

export function riskTierText(riskTier: string, locale: Locale): string {
  const prefix = locale === "zh" ? "风险" : locale === "zht" ? "風險" : "Risk"
  return `${prefix} ${riskTier}`
}

export function actionStatusText(status: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    proposed: ["Proposed", "已提出", "已提出"],
    policy_evaluated: ["Policy checked", "策略已判断", "策略已判斷"],
    awaiting_approval: ["Awaiting your approval", "等待你确认", "等待你確認"],
    authorized: ["Authorized", "已获授权", "已獲授權"],
    executing: ["Executing", "执行中", "執行中"],
    observed: ["Result observed", "已收到真实结果", "已收到真實結果"],
    verifying: ["Verifying", "验证中", "驗證中"],
    settled: ["Verified and settled", "已验证并结算", "已驗證並結算"],
    compensating: ["Reversing impact", "正在撤销影响", "正在撤銷影響"],
    blocked: ["Blocked by policy", "已被安全规则阻止", "已被安全規則阻止"],
    cancelled: ["Cancelled", "已取消", "已取消"],
  }
  return labels[status]
    ? localized(labels[status], locale)
    : `${locale === "zh" ? "未知状态" : locale === "zht" ? "未知狀態" : "Unknown status"}: ${status}`
}

/**
 * Cancellation is intentionally narrower than "non-terminal".  The control
 * center may only offer the originating session's pre-handoff cancellation;
 * once an action is authorized/executing, the ActionGateway owns the
 * handoff decision and the UI must remain observational.
 */
export function canCancelPendingAction(
  actionSessionID: string,
  actionStatus: string,
  originatingSessionID: string | undefined,
): boolean {
  return (
    originatingSessionID !== undefined &&
    originatingSessionID.length > 0 &&
    actionSessionID === originatingSessionID &&
    ["proposed", "policy_evaluated", "awaiting_approval"].includes(actionStatus)
  )
}

/**
 * Keep internal action identifiers available for diagnostics while showing a
 * plain-language label to people scanning the Runtime Insight timeline.
 * Unknown identifiers remain visible so forward-compatible actions are never
 * silently mislabelled.
 */
export function actionNameText(name: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    "asset-localization": ["Localize external assets", "本地化外部资源", "本地化外部資源"],
    write: ["Write file", "写入文件", "寫入檔案"],
  }
  return labels[name] ? localized(labels[name], locale) : name
}

/** Localized labels for bounded durable operation progress phases. */
export function actionProgressPhaseText(phase: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    executing: ["Executing", "执行中", "執行中"],
    fetching: ["Fetching assets", "获取资源中", "取得資源中"],
    planning: ["Rebuilding plan", "重建计划中", "重建計畫中"],
    prepared: ["Mutation prepared", "变更已准备", "變更已準備"],
    committing: ["Committing files", "提交文件中", "提交檔案中"],
    committed: ["Files committed", "文件已提交", "檔案已提交"],
    settled: ["Settled", "已结算", "已結算"],
    failed: ["Failed closed", "已安全失败", "已安全失敗"],
    cancelled: ["Cancelled", "已取消", "已取消"],
    outcome_unknown: ["Outcome unknown", "结果未知", "結果未知"],
  }
  return labels[phase]
    ? localized(labels[phase], locale)
    : `${locale === "zh" ? "未知进度" : locale === "zht" ? "未知進度" : "Unknown progress"}: ${phase}`
}

export function observationStatusText(status: string | null, locale: Locale): string {
  if (status === "succeeded") return localized(["Succeeded", "成功", "成功"], locale)
  if (status === "failed") return localized(["Failed", "失败", "失敗"], locale)
  if (status === "interrupted") return localized(["Interrupted", "执行被中断", "執行被中斷"], locale)
  return localized(["Awaiting result", "等待返回", "等待返回"], locale)
}

function mutationPhaseText(phase: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    prepared: ["Prepared", "已准备", "已準備"],
    committed: ["Committed", "已提交", "已提交"],
    postprocessing: ["Post-processing", "后处理", "後處理"],
    settled: ["Settled", "已结算", "已結算"],
    rollback_required: ["Rollback required", "需要回滚", "需要回滾"],
    rollback_blocked: ["Rollback blocked", "回滚受阻", "回滾受阻"],
    rolled_back: ["Rolled back", "已回滚", "已回滾"],
    outcome_unknown: ["Outcome unknown", "结果未知", "結果未知"],
  }
  return labels[phase]
    ? localized(labels[phase], locale)
    : `${locale === "zh" ? "未知阶段" : locale === "zht" ? "未知階段" : "Unknown phase"}: ${phase}`
}

function mutationDecisionText(decision: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    settled: ["Settled", "已结算", "已結算"],
    inspect: ["Inspect required", "需要检查", "需要檢查"],
    manual_rollback: ["Manual rollback", "需要人工回滚", "需要人工回滾"],
    blocked: ["Blocked", "已阻止", "已阻止"],
  }
  return labels[decision]
    ? localized(labels[decision], locale)
    : `${locale === "zh" ? "未知决定" : locale === "zht" ? "未知決定" : "Unknown decision"}: ${decision}`
}

function inspectionDecisionText(decision: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    postimage_matches: ["Postimage matches", "当前状态匹配已写结果", "目前狀態符合已寫結果"],
    preimage_matches: ["Preimage matches", "当前状态仍是写入前", "目前狀態仍是寫入前"],
    manual_review: ["Manual review required", "状态不确定，需要人工检查", "狀態不確定，需要人工檢查"],
  }
  return labels[decision]
    ? localized(labels[decision], locale)
    : `${locale === "zh" ? "未知检查结果" : locale === "zht" ? "未知檢查結果" : "Unknown inspection"}: ${decision}`
}

function inspectionStateText(state: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    postimage_matches: ["matches postimage", "匹配已写结果", "符合已寫結果"],
    preimage_matches: ["matches preimage", "匹配写入前", "符合寫入前"],
    changed: ["changed", "已发生变化", "已發生變化"],
    unobserved: ["not observed", "未能观察", "未能觀察"],
  }
  return labels[state]
    ? localized(labels[state], locale)
    : `${locale === "zh" ? "未知目标状态" : locale === "zht" ? "未知目標狀態" : "Unknown target state"}: ${state}`
}

function postProcessingStageText(stage: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    formatter: ["formatter", "格式化", "格式化"],
    bom: ["BOM synchronization", "BOM 同步", "BOM 同步"],
    lsp_touch: ["LSP refresh", "LSP 刷新", "LSP 重新整理"],
    diagnostics: ["diagnostics", "诊断", "診斷"],
    event_v2: ["event publication", "事件发布", "事件發布"],
    watcher: ["watcher notification", "文件变更通知", "檔案變更通知"],
  }
  return labels[stage]
    ? localized(labels[stage], locale)
    : `${locale === "zh" ? "未知阶段" : locale === "zht" ? "未知階段" : "Unknown stage"}: ${stage}`
}

function postProcessingStatusText(status: string, locale: Locale): string {
  if (status === "completed") return localized(["completed", "已完成", "已完成"], locale)
  if (status === "started") return localized(["in progress", "进行中", "進行中"], locale)
  return `${locale === "zh" ? "未知状态" : locale === "zht" ? "未知狀態" : "Unknown status"}: ${status}`
}

/** Human-readable, metadata-only semantic checkpoint text for recovery UI. */
export function postProcessingCheckpointText(
  stage: string,
  status: string,
  target: string | undefined,
  locale: Locale,
): string {
  const scope = target ? ` · ${target}` : ""
  return `${postProcessingStageText(stage, locale)} · ${postProcessingStatusText(status, locale)}${scope}`
}

function postProcessingRecoveryStatusText(status: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    not_started: ["not entered", "尚未进入", "尚未進入"],
    in_flight: ["possibly in flight", "可能仍在执行", "可能仍在執行"],
    completed_unsettled: ["completed, settlement pending", "已完成但尚未结算", "已完成但尚未結算"],
    settled: ["settled", "已结算", "已結算"],
    rolled_back: ["rolled back", "已回滚", "已回滾"],
  }
  return labels[status]
    ? localized(labels[status], locale)
    : `${locale === "zh" ? "未知后处理恢复状态" : locale === "zht" ? "未知後處理恢復狀態" : "Unknown post-processing recovery status"}: ${status}`
}

/** Human-readable classification for the gap between a side effect and settlement. */
export function postProcessingRecoveryText(
  status: string,
  stage: string | undefined,
  target: string | undefined,
  locale: Locale,
): string {
  const scope = stage === undefined ? "" : ` · ${postProcessingStageText(stage, locale)}${target ? ` · ${target}` : ""}`
  return `${postProcessingRecoveryStatusText(status, locale)}${scope}`
}

export function artifactStatusText(status: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    not_required: ["No inverse artifact required", "无需逆向工件", "無需逆向工件"],
    available: ["Inverse artifact available", "逆向工件可用", "逆向工件可用"],
    missing: ["Inverse artifact missing", "逆向工件缺失", "逆向工件缺失"],
    corrupt: ["Inverse artifact integrity failed", "逆向工件完整性失败", "逆向工件完整性失敗"],
    quota_pressure: ["Profile quota pressure", "配置空间配额有压力", "設定檔空間配額有壓力"],
    unavailable: ["Artifact store unavailable", "工件存储暂不可用", "工件儲存暫不可用"],
  }
  return labels[status]
    ? localized(labels[status], locale)
    : `${locale === "zh" ? "未知工件状态" : locale === "zht" ? "未知工件狀態" : "Unknown artifact status"}: ${status}`
}

function inspectionOperationText(operation: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    create: ["create", "创建", "建立"],
    write: ["write", "写入", "寫入"],
    remove: ["remove", "删除", "刪除"],
  }
  return labels[operation]
    ? localized(labels[operation], locale)
    : `${locale === "zh" ? "未知操作" : locale === "zht" ? "未知操作" : "Unknown operation"}: ${operation}`
}

export type RecoveryReviewDecision = "settle_postimage" | "require_rollback" | "confirm_rolled_back" | "block_rollback"

export type RecoveryReviewOption = Readonly<{
  readonly decision: RecoveryReviewDecision
  readonly label: string
}>

/**
 * Return only evidence-bound human actions that are legal for the inspected
 * phase. These actions record a durable decision; they never execute a file
 * write, retry an Action, or change the Action status.
 */
export function recoveryReviewOptions(
  phase: string,
  inspectionDecision: string,
  locale: Locale,
): ReadonlyArray<RecoveryReviewOption> {
  const option = (decision: RecoveryReviewDecision, label: Localized): RecoveryReviewOption => ({
    decision,
    label: localized(label, locale),
  })

  if (inspectionDecision === "postimage_matches") {
    if (phase === "prepared")
      return [option("require_rollback", ["Mark rollback required", "标记需要回滚", "標記需要回滾"])]
    if (phase === "committed" || phase === "postprocessing" || phase === "outcome_unknown")
      return [
        option("settle_postimage", ["Confirm result is written", "确认结果已写入", "確認結果已寫入"]),
        option("require_rollback", ["Mark rollback required", "标记需要回滚", "標記需要回滾"]),
      ]
  }
  if (inspectionDecision === "preimage_matches" && (phase === "rollback_required" || phase === "outcome_unknown"))
    return [option("confirm_rolled_back", ["Confirm rollback completed", "确认已完成回滚", "確認已完成回滾"])]
  if (inspectionDecision === "manual_review" && (phase === "rollback_required" || phase === "outcome_unknown"))
    return [option("block_rollback", ["Mark rollback blocked", "标记回滚受阻", "標記回滾受阻"])]
  return []
}

export function durationText(durationMs: number, locale: Locale): string {
  const units =
    locale === "zh"
      ? { ms: "毫秒", seconds: "秒", minutes: "分钟", hours: "小时" }
      : locale === "zht"
        ? { ms: "毫秒", seconds: "秒", minutes: "分鐘", hours: "小時" }
        : { ms: "ms", seconds: "s", minutes: "min", hours: "h" }
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} ${units.ms}`
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} ${units.seconds}`
  const minutes = durationMs / 60_000
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} ${units.minutes}`
  return `${(minutes / 60).toFixed(1)} ${units.hours}`
}

export function costText(costMicros: number): string {
  const dollars = Math.max(0, costMicros) / 1_000_000
  return `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`
}

export function modelText(value: string | null | undefined, locale: Locale): string {
  const normalized = String(value ?? "").trim()
  if (!normalized || /(^|\/)(unselected|none|null|undefined)(?=\/|$)/i.test(normalized))
    return localized(["No model selected", "未选择模型", "未選擇模型"], locale)
  return normalized
}

export function runtimeModelText(
  providerID: string | null | undefined,
  modelID: string | null | undefined,
  locale: Locale,
): string {
  const provider = String(providerID ?? "").trim()
  const model = String(modelID ?? "").trim()
  if (!provider || !model || [provider, model].some((value) => /^(unselected|none|null|undefined)$/i.test(value)))
    return localized(["No model selected", "未选择模型", "未選擇模型"], locale)
  return modelText(`${provider}/${model}`, locale)
}

export function runtimeReasonText(reason: string | null | undefined, locale: Locale): string {
  const value = String(reason ?? "").trim()
  if (!value) return ""
  const stableReasons: ReadonlyArray<readonly [RegExp, Localized]> = [
    [
      /a durable file mutation was interrupted during post-processing/i,
      [
        "A durable file mutation was interrupted during post-processing.",
        "持久文件变更在后处理期间中断。",
        "持久檔案變更在後處理期間中斷。",
      ],
    ],
    [
      /the originating session has a precise asset localization request awaiting approval/i,
      [
        "The originating session has a precise asset localization request awaiting approval.",
        "原始会话有一个精确的资产本地化请求等待确认。",
        "原始會話有一個精確的資產本地化請求等待確認。",
      ],
    ],
    [
      /a different originating session has an asset localization request awaiting approval/i,
      [
        "A different originating session has an asset localization request awaiting approval.",
        "另一个原始会话有一个资产本地化请求等待确认。",
        "另一個原始會話有一個資產本地化請求等待確認。",
      ],
    ],
    [
      /an external mcp action was interrupted before its remote outcome was confirmed/i,
      [
        "An external MCP action was interrupted before its remote outcome was confirmed.",
        "外部 MCP 动作在确认远程结果前中断。",
        "外部 MCP 動作在確認遠端結果前中斷。",
      ],
    ],
    [
      /all cooperative fingerprints match the durable postimage/i,
      [
        "All cooperative fingerprints match the durable postimage.",
        "所有协作指纹都匹配持久化后的结果。",
        "所有協作指紋都符合持久化後的結果。",
      ],
    ],
    [
      /the profile-owned inverse artifact is available/i,
      [
        "The profile-owned inverse artifact is available.",
        "配置空间拥有的逆向工件可用。",
        "設定檔空間擁有的逆向工件可用。",
      ],
    ],
    [
      /human review recorded for the observed postimage/i,
      [
        "Human review recorded for the observed postimage.",
        "已记录对当前结果的人工检查。",
        "已記錄對目前結果的人工檢查。",
      ],
    ],
    [
      /action log still needs settlement/i,
      ["Action log still needs settlement.", "动作日志仍需要结算。", "動作日誌仍需要結算。"],
    ],
    [/localized files committed/i, ["Localized files committed.", "本地化文件已提交。", "本地化檔案已提交。"]],
    [/localization result settled/i, ["Localization result settled.", "本地化结果已结算。", "本地化結果已結算。"]],
    [/waiting for approval(?: in another session)?/i, ["Waiting for approval.", "等待确认。", "等待確認。"]],
  ]
  const stable = stableReasons.find(([pattern]) => pattern.test(value))
  if (stable) return localized(stable[1], locale)
  if (/ProviderModelNotFoundError|Model not found|unselected\/unselected|no model (?:selected|configured)/i.test(value))
    return localized(
      [
        "No usable model is configured. Choose a provider and model in Settings, then retry.",
        "尚未配置可用模型。请在设置中选择提供商和模型后重试。",
        "尚未設定可用模型。請在設定中選擇提供商和模型後重試。",
      ],
      locale,
    )
  if (/ECONNREFUSED|fetch failed|network|timed out|timeout/i.test(value))
    return localized(
      [
        "The service did not respond. Check the server connection and try again.",
        "服务没有返回结果。请检查服务器连接后重试。",
        "服務沒有返回結果。請檢查伺服器連線後重試。",
      ],
      locale,
    )
  if (/unauthorized|forbidden|api key|authentication|401|403/i.test(value))
    return localized(
      [
        "The provider needs authorization. Check the provider settings and try again.",
        "提供商需要授权。请检查提供商设置后重试。",
        "提供商需要授權。請檢查提供商設定後重試。",
      ],
      locale,
    )
  if (/workflow independent verifier passed/i.test(value))
    return localized(["Workflow verification passed", "工作流验证已通过", "工作流程驗證已通過"], locale)
  if (/(?:[A-Za-z][\w]*(?:Error|Exception)|stack trace| at [\w$.[\]()]+)/i.test(value))
    return localized(
      [
        "The run failed before producing a usable result. Check the model and server settings, then retry.",
        "任务未能生成可用结果。请检查模型和服务器设置后重试。",
        "任務未能產生可用結果。請檢查模型和伺服器設定後重試。",
      ],
      locale,
    )
  return value
}

/**
 * MCP providers return stable English reason strings today. Keep those
 * protocol values intact at the boundary, but translate the known safety
 * explanations before they reach a localized user-facing recovery panel.
 * Unknown/future provider text remains visible for forward compatibility.
 */
export function mcpRecoveryReasonText(reason: string | null | undefined, locale: Locale): string {
  const value = String(reason ?? "").trim()
  if (!value) return ""
  if (/remote outcome remains unknown|inspect the provider before recording evidence/i.test(value))
    return localized(
      [
        "The remote outcome remains unknown; inspect the provider before recording evidence.",
        "远程结果仍未知；请先检查提供商后再记录证据。",
        "遠端結果仍未知；請先檢查提供商後再記錄證據。",
      ],
      locale,
    )
  if (/owner recorded the observed remote outcome|no replay was performed/i.test(value))
    return localized(
      [
        "The owner recorded the observed remote outcome; no replay was performed.",
        "owner 已记录观察到的远程结果；未执行重放。",
        "owner 已記錄觀察到的遠端結果；未執行重放。",
      ],
      locale,
    )
  return runtimeReasonText(value, locale)
}

export function mcpRecoveryEvidenceSummaryText(summary: string | null | undefined, locale: Locale): string {
  const value = String(summary ?? "").trim()
  if (!value) return ""
  if (/no transport replay was attempted/i.test(value))
    return localized(["No transport replay was attempted.", "未执行传输重放。", "未執行傳輸重放。"], locale)
  if (/owner recorded the operator-confirmed remote outcome/i.test(value))
    return localized(
      [
        "The owner recorded the operator-confirmed remote outcome.",
        "owner 已记录经操作员确认的远程结果。",
        "owner 已記錄經操作員確認的遠端結果。",
      ],
      locale,
    )
  return value
}

export function auditActionText(action: string, locale: Locale = "zh"): string {
  const labels: Record<string, Localized> = {
    "run.created": ["Persistent run created", "已创建持久任务", "已建立持久任務"],
    "run.state.changed": ["Run state updated", "任务状态已更新", "任務狀態已更新"],
    "run.lease.acquired": ["Worker took ownership", "工作进程已接管", "工作進程已接管"],
    "run.attempt.started": ["Execution attempt started", "开始一次执行尝试", "開始一次執行嘗試"],
    "run.attempt.finished": ["Execution attempt settled", "一次执行尝试已结算", "一次執行嘗試已結算"],
    "run.checkpoint.created": ["Recovery checkpoint saved", "已保存恢复点", "已儲存恢復點"],
    "tool.execute.start": ["Tool execution started", "开始执行工具", "開始執行工具"],
    "tool.execute.end": ["Tool execution finished", "工具执行结束", "工具執行結束"],
    "action.policy.evaluated": ["Action risk and authority checked", "动作风险与授权已判断", "動作風險與授權已判斷"],
    "action.authorization.granted": ["Authorization scope recorded safely", "授权范围已安全记录", "授權範圍已安全記錄"],
    "action.authorization.failed": [
      "Authorization failed; action was not executed",
      "授权未通过，动作未执行",
      "授權未通過，動作未執行",
    ],
    "action.scope.escalation": [
      "Action exceeded its scope and was stopped",
      "执行范围超出授权，已安全停止",
      "執行範圍超出授權，已安全停止",
    ],
    "action.state.changed": ["Action state updated", "动作状态已更新", "動作狀態已更新"],
    "action.execution.resumed": [
      "Safe action resumed after interruption",
      "安全动作已从中断处恢复",
      "安全動作已從中斷處恢復",
    ],
    "action.result.replayed": ["Persisted tool result replayed", "已重放持久化工具结果", "已重放持久化工具結果"],
    "action.result.not-persisted": ["Tool result could not be persisted", "工具结果未能持久化", "工具結果未能持久化"],
    "action.authorization.missing": [
      "Action missed the approval gate and was blocked",
      "动作未经过许可入口，已阻止结算",
      "動作未經過許可入口，已阻止結算",
    ],
  }
  return labels[action] ? localized(labels[action], locale) : action
}

export const runtimeInsightCopy = (locale: Locale) => {
  const traditional = locale === "zht"
  const artifactScopeText = (scope: string) =>
    scope === "tenant"
      ? traditional
        ? "目前租戶"
        : "当前租户"
      : scope === "profile"
        ? traditional
          ? "目前設定檔"
          : "当前配置空间"
        : traditional
          ? "目前工作階段"
          : "当前会话"
  if (locale === "zh" || traditional) {
    return {
      auto: traditional ? "自動" : "自动",
      human: traditional ? "人工" : "人工",
      refresh: traditional ? "重新整理" : "刷新",
      refreshing: traditional ? "重新整理中…" : "刷新中…",
      verifyAudit: traditional ? "校驗稽核鏈" : "校验审计链",
      verifyingAudit: traditional ? "校驗中…" : "校验中…",
      automaticNotice: traditional
        ? "以下資料全部由系統自動記錄，無需手動維護。"
        : "以下数据全部由系统自动记录，无需手动维护。",
      auditVerified: (count: number) =>
        traditional ? `稽核鏈校驗通過：${count} 條記錄均未被竄改。` : `审计链校验通过：${count} 条记录均未被篡改。`,
      auditFailed: (issue: string) =>
        traditional ? `稽核鏈校驗失敗：${issue || "記錄被竄改"}` : `审计链校验失败：${issue || "记录被篡改"}`,
      noRecordsBefore: traditional
        ? "暫無記錄。進行對話或工具呼叫後，這裡會自動展示執行過程。"
        : "暂无记录。进行对话或工具调用后，这里会自动展示运行过程。",
      emptyTitle: traditional ? "尚未產生執行記錄" : "尚未产生运行记录",
      emptyHint: traditional
        ? "目前工作區的真實事件、持久任務和工具動作均為 0，這不是故障。開始一次對話或工具呼叫後，執行與驗證過程會自動出現在這裡。"
        : "当前工作区的真实事件、持久任务和工具动作均为 0，这不是故障。开始一次对话或工具调用后，执行与验证过程会自动出现在这里。",
      dataSource: traditional
        ? "資料來源：TypeScript Core · 當前工作區 · 即時讀取"
        : "数据源：TypeScript Core · 当前工作区 · 实时读取",
      durableTitle: traditional ? "持久任務與崩潰恢復" : "持久任务与崩溃恢复",
      durableHint: traditional
        ? "任務開始前會被持久化；執行進程用心跳證明自己仍在工作。應用程式異常退出後，租約過期才允許其他進程接管，避免同一動作重複執行。"
        : "任务开始前会被持久化；运行进程用心跳证明自己仍在工作。应用异常退出后，租约过期才允许其他进程接管，避免同一动作重复执行。",
      noWorker: traditional ? "目前沒有工作進程持有任務" : "当前没有工作进程持有任务",
      recentTakeover: (generation: number) =>
        traditional ? `最近為第 ${generation + 1} 次接管` : `最近为第 ${generation + 1} 次接管`,
      workerOnline: traditional ? "工作進程在線" : "工作进程在线",
      leaseExpired: traditional ? "工作進程心跳已過期，可安全接管" : "工作进程心跳已过期，可安全接管",
      takeoverHeartbeat: (generation: number, time: string) =>
        traditional
          ? `第 ${generation + 1} 次接管 · 最近心跳 ${time}`
          : `第 ${generation + 1} 次接管 · 最近心跳 ${time}`,
      noCheckpoint: traditional ? "尚無恢復點" : "尚无恢复点",
      checkpointSaved: (sequence: number) =>
        traditional ? `恢復點已儲存 · 事件 #${sequence}` : `恢复点已保存 · 事件 #${sequence}`,
      admissionTitle: traditional ? "Custom Agent 准入證據" : "Custom Agent 准入证据",
      admissionHint: traditional
        ? "只讀顯示啟動前的工具投影、工作區信任與固定摘要；不包含提示詞、憑據或 Provider 內容。"
        : "只读显示启动前的工具投影、工作区信任与固定摘要；不包含提示词、凭据或 Provider 内容。",
      admissionDecision: (decision: string) => admissionDecisionText(decision, locale),
      admissionStatus: (status: string) => admissionStatusText(status, locale),
      admissionChecks: (passed: number, total: number) =>
        traditional ? `檢查 ${passed}/${total} 項通過` : `检查 ${passed}/${total} 项通过`,
      admissionTools: (declared: number, canonical: number, unsupported: number) =>
        traditional
          ? `工具宣告 ${declared} · 已繫結 ${canonical} · 不支援 ${unsupported}`
          : `工具声明 ${declared} · 已绑定 ${canonical} · 不支持 ${unsupported}`,
      admissionEvidenceRefs: (count: number) =>
        traditional ? `Evidence 引用 ${count} 條` : `Evidence 引用 ${count} 条`,
      actionsTitle: traditional ? "真實動作與影響" : "真实动作与影响",
      actionsHint: traditional
        ? "每個可能產生副作用的動作都經過統一安全入口；這裡顯示授權依據、影響範圍和後端實際觀察結果。"
        : "每个可能产生副作用的动作都经过统一安全入口；这里显示授权依据、影响范围和后端实际观察结果。",
      progressTitle: traditional ? "動作進度" : "动作进度",
      assetProgressTitle: traditional ? "資產本地化進度" : "资产本地化进度",
      progressPhase: (phase: string) => actionProgressPhaseText(phase, locale),
      progressCount: (completed: number, total: number) =>
        traditional ? `已完成 ${completed}/${total}` : `已完成 ${completed}/${total}`,
      progressDetail: (detail: string) => (traditional ? `系統狀態：${detail}` : `系统状态：${detail}`),
      progressReadOnly: traditional
        ? "此處只讀展示持久進度；取消只能在執行交接前由原始會話提交。"
        : "这里只读展示持久进度；取消只能在执行交接前由原始会话提交。",
      cancelPendingAction: traditional ? "取消待確認動作" : "取消待确认动作",
      cancellingPendingAction: traditional ? "取消中…" : "取消中…",
      cancelPendingActionHint: traditional
        ? "僅原始會話可在執行交接前取消；已授權或執行中的動作只能查看。"
        : "仅原始会话可在执行交接前取消；已授权或执行中的动作只能查看。",
      mcpRecoveryTitle: traditional ? "MCP 外部動作核對" : "MCP 外部动作核对",
      mcpRecoveryHint: traditional
        ? "斷線後結果可能已在外部服務生效。此處只做唯讀核對，不會重放請求或自動重試。"
        : "断线后结果可能已在外部服务生效。这里只做只读核对，不会重放请求或自动重试。",
      mcpRecoveryIdentity: (digest: string) => (traditional ? `固定意圖指紋 · ${digest}` : `固定意图指纹 · ${digest}`),
      mcpRecoveryState: (state: string | null | undefined) =>
        state === "known_success"
          ? traditional
            ? "已知成功"
            : "已知成功"
          : state === "known_failure"
            ? traditional
              ? "已知失敗"
              : "已知失败"
            : state === "unknown"
              ? traditional
                ? "結果未知"
                : "结果未知"
              : traditional
                ? "尚未核對"
                : "尚未核对",
      mcpRecoveryInspect: traditional ? "唯讀核對" : "只读核对",
      mcpRecoveryInspecting: traditional ? "核對中…" : "核对中…",
      mcpRecoveryOperatorNotice: traditional
        ? "成員只能查看；記錄證據需要 owner/admin，且不會開啟自動重試。"
        : "成员只能查看；记录证据需要 owner/admin，且不会开启自动重试。",
      mcpRecoveryDecision: (kind: string) =>
        kind === "confirmed"
          ? traditional
            ? "唯讀核對已確認"
            : "只读核对已确认"
          : traditional
            ? "需要人工核對"
            : "需要人工核对",
      mcpRecoveryEvidence: (digest: string, source: string) =>
        traditional ? `證據 ${digest} · 來源 ${source}` : `证据 ${digest} · 来源 ${source}`,
      mcpRecoveryRecord: traditional ? "記錄核對證據（需管理員）" : "记录核对证据（需管理员）",
      mcpRecoveryRecording: traditional ? "記錄中…" : "记录中…",
      mcpRecoveryPermissionDenied: traditional
        ? "目前帳號只能唯讀查看；請由 owner/admin 記錄核對證據。"
        : "当前账号只能只读查看；请由 owner/admin 记录核对证据。",
      mcpRecoveryUnavailable: traditional
        ? "暫時無法核對 MCP 結果；未執行重放，請稍後重試或聯絡 owner/admin。"
        : "暂时无法核对 MCP 结果；未执行重放，请稍后重试或联系 owner/admin。",
      persistedResult: (bytes: number) =>
        traditional ? `結果已持久化，可免重複恢復（${bytes} 位元組）` : `结果已持久化，可免重复恢复（${bytes} 字节）`,
      notPersistedResult: traditional ? "結果未持久化，恢復時需人工判斷" : "结果未持久化，恢复时需人工判断",
      mutationRecoveryStatus: (phase: string, decision: string, requiresReview: boolean, transactionID: string) =>
        requiresReview
          ? traditional
            ? `恢復需要處理 · ${mutationPhaseText(phase, locale)} / ${mutationDecisionText(decision, locale)} · 事務 ${transactionID}`
            : `恢复需要处理 · ${mutationPhaseText(phase, locale)} / ${mutationDecisionText(decision, locale)} · 事务 ${transactionID}`
          : traditional
            ? `變更事務已結算 · 事務 ${transactionID}`
            : `变更事务已结算 · 事务 ${transactionID}`,
      automaticRetryBlocked: traditional ? "自動重試已阻止，請先檢查或結算" : "自动重试已阻止，请先检查或结算",
      noRetryNeeded: traditional ? "無需重試，動作已持久化結算" : "无需重试，动作已持久化结算",
      mutationRecoveryReason: (reason: string) => (traditional ? `依據：${reason}` : `依据：${reason}`),
      postProcessingTitle: traditional ? "後處理檢查點" : "后处理检查点",
      postProcessingRecoveryTitle: traditional ? "後處理恢復分類" : "后处理恢复分类",
      inspectTargets: traditional ? "檢查目前目標狀態" : "检查当前目标状态",
      inspectingTargets: traditional ? "檢查中…" : "检查中…",
      inspectionTitle: traditional ? "重啟後目標觀測" : "重启后目标观察",
      inspectionDecision: (decision: string) => inspectionDecisionText(decision, locale),
      inspectionEntry: (operation: string, target: string, state: string) =>
        `${inspectionOperationText(operation, locale)} · ${target} · ${inspectionStateText(state, locale)}`,
      inspectionReason: (reason: string) => (traditional ? `觀測依據：${reason}` : `观察依据：${reason}`),
      inspectionUnavailable: traditional
        ? "目前無法讀取目標指紋，請人工檢查工作區後再決定。"
        : "当前无法读取目标指纹，请人工检查工作区后再决定。",
      recoveryRoleNotice: (role: string, canRollback: boolean, canMaintain: boolean) =>
        traditional
          ? `目前角色：${role === "member" ? "成員" : role === "admin" ? "管理員" : "所有者"} · ${canRollback ? "可執行受保護回滾" : "回滾需 owner/admin"}${canMaintain ? "" : " · 工件維護需 owner/admin"}`
          : `当前角色：${role === "member" ? "成员" : role === "admin" ? "管理员" : "所有者"} · ${canRollback ? "可执行受保护回滚" : "回滚需 owner/admin"}${canMaintain ? "" : " · 工件维护需 owner/admin"}`,
      recoveryRollbackPermission: traditional
        ? "目前帳號可以檢查並記錄證據；受保護回滾和工件維護需要 owner/admin。"
        : "当前账号可以检查并记录证据；受保护回滚和工件维护需要 owner/admin。",
      reviewTitle: traditional ? "人工復核決定" : "人工复核决定",
      reviewSafetyNotice: traditional
        ? "以下按鈕只記錄你的證據綁定決定，不會寫入檔案、改變動作狀態或開啟自動重試。"
        : "以下按钮只记录你的证据绑定决定，不会写入文件、改变动作状态或开启自动重试。",
      rollbackTitle: traditional ? "執行受保護回滾" : "执行受保护回滚",
      rollbackSafetyNotice: traditional
        ? "僅在所有目標仍匹配變更後指紋時恢復受保護逆向工件；完成後會再次校驗原始指紋。"
        : "仅在所有目标仍匹配变更后指纹时恢复受保护逆向工件；完成后会再次校验原始指纹。",
      executeRollback: traditional ? "執行受保護回滾" : "执行受保护回滚",
      executingRollback: traditional ? "回滾中…" : "回滚中…",
      rollbackUnavailable: traditional
        ? "沒有完整的持久逆向工件，目前只能人工處理。"
        : "没有完整的持久逆向工件，当前只能人工处理。",
      artifactMaintenanceTitle: traditional ? "逆向工件維護" : "逆向工件维护",
      artifactMaintenanceHint: traditional
        ? "系統會從持久動作中收集仍在使用的引用；這裡僅顯示脫敏計數。清理必須二次確認，引用中或損壞的工件不會被刪除。"
        : "系统会从持久动作中收集仍在使用的引用；这里只显示脱敏计数。清理必须二次确认，引用中或损坏的工件不会被删除。",
      auditArtifacts: traditional ? "檢查工件狀態" : "检查工件状态",
      auditingArtifacts: traditional ? "檢查中…" : "检查中…",
      sweepArtifacts: traditional ? "準備清理未引用工件" : "准备清理未引用工件",
      confirmSweepArtifacts: traditional ? "確認清理（含配額回收）" : "确认清理（含配额回收）",
      cancelSweep: traditional ? "取消" : "取消",
      sweepingArtifacts: traditional ? "清理中…" : "清理中…",
      settlementRecoveryTitle: traditional ? "子任務結算恢復" : "子任务结算恢复",
      settlementRecoveryHint: traditional
        ? "只處理目前租戶的 pending recovery-outbox；僅重放確定性的 owner 寫入，不會重試 Provider 或外部請求。"
        : "只处理当前租户的待处理 recovery-outbox；仅重放确定性的 owner 写入，不会重试 Provider 或外部请求。",
      settlementRecoveryStart: traditional ? "檢查待處理結算" : "检查待处理结算",
      settlementRecoveryConfirm: traditional ? "確認恢復結算" : "确认恢复结算",
      settlementRecoveryCancel: traditional ? "取消" : "取消",
      settlementRecoveryRunning: traditional ? "恢復中…" : "恢复中…",
      settlementRecoverySummary: (scanned: number, committed: number, pending: number, failed: number) =>
        traditional
          ? `掃描 ${scanned} · 已提交 ${committed} · 待處理 ${pending} · 失敗 ${failed}`
          : `扫描 ${scanned} · 已提交 ${committed} · 待处理 ${pending} · 失败 ${failed}`,
      settlementRecoveryReview: (count: number) =>
        traditional ? `${count} 項仍需人工復核；未執行 Provider。` : `${count} 项仍需人工复核；未执行 Provider。`,
      settlementRecoveryNextPage: traditional ? "仍有下一頁待處理項目" : "仍有下一页待处理项目",
      artifactStatus: (status: string) => artifactStatusText(status, locale),
      artifactSummary: (referenced: number, total: number, orphan: number) =>
        traditional
          ? `已保護引用 ${referenced} · 工件 ${total} · 未引用 ${orphan}`
          : `已保护引用 ${referenced} · 工件 ${total} · 未引用 ${orphan}`,
      artifactAuditLine: (bytes: number, corrupt: number, missing: number, overQuota: boolean) =>
        traditional
          ? `磁碟占用 ${bytes} 位元組 · 損壞 ${corrupt} · 缺失引用 ${missing}${overQuota ? " · 配額超限" : ""}`
          : `磁盘占用 ${bytes} 字节 · 损坏 ${corrupt} · 缺失引用 ${missing}${overQuota ? " · 配额超限" : ""}`,
      artifactScanIncomplete: traditional
        ? "引用掃描未完整，為安全起見不允許清理。"
        : "引用扫描未完整，为安全起见不允许清理。",
      continueArtifactScan: traditional ? "繼續掃描下一頁" : "继续扫描下一页",
      sweepRequiresCompleteScan: traditional
        ? "請先完成整個引用掃描，再進行清理。"
        : "请先完成整个引用扫描，再进行清理。",
      artifactScanProgress: (pages: number, actions: number) =>
        traditional ? `已掃描 ${pages} 頁 · ${actions} 個持久動作` : `已扫描 ${pages} 页 · ${actions} 个持久动作`,
      artifactRemoved: (count: number) =>
        traditional ? `本次清理 ${count} 個未引用工件` : `本次清理 ${count} 个未引用工件`,
      artifactEvidenceTitle: traditional ? "工件回執與稽核證據" : "工件回执与审计证据",
      artifactEvidenceHint: (scope = "session") =>
        traditional
          ? `只讀取${artifactScopeText(scope)}的受控回執元資料與脫敏稽核；不展示本機路徑或檔案內容。`
          : `只读取${artifactScopeText(scope)}的受控回执元数据和脱敏审计；不展示本机路径或文件内容。`,
      artifactEvidenceNoSession: traditional
        ? "目前控制中心未綁定工作階段或授權 owner；開啟會話或選擇有效 owner 後即可查看工件證據。"
        : "当前控制中心未绑定会话或授权 owner；打开会话或选择有效 owner 后即可查看工件证据。",
      artifactEvidenceSummary: (artifacts: number, audits: number) =>
        traditional ? `回執 ${artifacts} · 稽核記錄 ${audits}` : `回执 ${artifacts} · 审计记录 ${audits}`,
      artifactEvidenceHead: (sequence: number, hash: string) =>
        traditional ? `鏈頭 #${sequence} · ${hash}` : `链头 #${sequence} · ${hash}`,
      artifactEvidenceDropped: (count: number) =>
        traditional ? `已封存稽核記錄 ${count} 條` : `已封存审计记录 ${count} 条`,
      artifactEvidenceChain: (state: string) =>
        state === "intact"
          ? traditional
            ? "目前頁面鏈條完整"
            : "当前页面链条完整"
          : state === "windowed"
            ? traditional
              ? "僅證明目前分頁鏈接"
              : "仅证明当前分页链路"
            : state === "broken"
              ? traditional
                ? "鏈接異常，已停止宣稱完整"
                : "链路异常，已停止宣称完整"
              : traditional
                ? "尚無稽核記錄"
                : "暂无审计记录",
      artifactEvidenceRetention: (mode: string) => (traditional ? `保留 ${mode}` : `保留 ${mode}`),
      artifactEvidenceReads: (count: number) => (traditional ? `讀取 ${count} 次` : `读取 ${count} 次`),
      artifactEvidenceCreated: (time: string) => (traditional ? `建立 ${time}` : `创建 ${time}`),
      artifactEvidenceAuditTitle: traditional ? "最近稽核" : "最近审计",
      artifactEvidenceCatalogTitle: traditional ? "受控回執" : "受控回执",
      artifactEvidenceEmpty: (scope = "session") =>
        traditional ? `${artifactScopeText(scope)}沒有受控工件回執。` : `${artifactScopeText(scope)}没有受控工件回执。`,
      artifactEvidenceAuditEmpty: (scope = "session") =>
        traditional ? `${artifactScopeText(scope)}沒有稽核記錄。` : `${artifactScopeText(scope)}没有审计记录。`,
      artifactEvidenceMaintenanceTitle: traditional ? "維護邊界" : "维护边界",
      artifactEvidenceMaintenanceStatus: (
        canMaintain: boolean,
        status: string | undefined,
        complete: boolean | undefined,
        reason: string,
      ) =>
        !canMaintain
          ? traditional
            ? `此 owner 不可維護：${reason}`
            : `此 owner 不可维护：${reason}`
          : status === undefined
            ? traditional
              ? "目前 profile 可維護；尚未開始掃描。"
              : "当前 profile 可维护；尚未开始扫描。"
            : complete
              ? traditional
                ? "profile 掃描已完成；清理仍需明確確認。"
                : "profile 扫描已完成；清理仍需明确确认。"
              : status === "active"
                ? traditional
                  ? "profile 掃描進行中；清理保持停用。"
                  : "profile 扫描进行中；清理保持停用。"
                : traditional
                  ? "profile 掃描已過期；請重新開始稽核。"
                  : "profile 扫描已过期；请重新开始审计。",
      artifactEvidenceMaintenanceProgress: (pages: number, actions: number) =>
        traditional ? `最近掃描 · ${pages} 頁 · ${actions} 個動作` : `最近扫描 · ${pages} 页 · ${actions} 个动作`,
      reviewing: traditional ? "記錄中…" : "记录中…",
      attempts: (used: number, max: number) => (traditional ? `執行嘗試 ${used}/${max}` : `执行尝试 ${used}/${max}`),
      duration: (used: string, max: string) =>
        traditional ? `佔用時長 ${used} / ${max}` : `占用时长 ${used} / ${max}`,
      durationSingle: (value: string) => (traditional ? `佔用時長 ${value}` : `占用时长 ${value}`),
      modelCost: (used: string, max: string) =>
        traditional ? `模型費用 ${used} / ${max}` : `模型费用 ${used} / ${max}`,
      localCost: traditional ? "本地動作不計模型費用" : "本地动作不计模型费用",
      activeAttempt: (attempt: number, time: string) =>
        traditional ? `第 ${attempt} 次執行中 · 始於 ${time}` : `第 ${attempt} 次执行中 · 始于 ${time}`,
      contextTitle: traditional ? "模型上下文組成" : "模型上下文组成",
      contextHint: traditional
        ? "每次呼叫自動把身份、專案事實、記憶等按優先級分層放進上下文；這裡展示各層佔比。"
        : "每次调用自动把身份、项目事实、记忆等按优先级分层放进上下文；这里展示各层占比。",
      totalTokens: (total: number) => (traditional ? `共 ${total} tokens` : `共 ${total} tokens`),
      routingTitle: traditional ? "模型選擇記錄" : "模型选择记录",
      routingHint: traditional
        ? "每次呼叫自動記錄選了哪個模型、價格和理由；方便你核對花費與選擇邏輯。"
        : "每次调用自动记录选了哪个模型、价格和理由；方便你核对花费与选择逻辑。",
      inputCost: (value: string | number) => (traditional ? `${value}/百萬輸入` : `${value}/百万输入`),
      outputCost: (value: string | number) => (traditional ? `${value}/百萬輸出` : `${value}/百万输出`),
      verificationTitle: traditional ? "交付前驗證" : "交付前验证",
      verificationHint: traditional
        ? "任務完成前自動核驗恢復點、真實工具結果和交付檢查；紅色表示有驗證項未通過。"
        : "任务完成前自动核验恢复点、真实工具结果和交付检查；红色表示有验证项未通过。",
      passed: traditional ? "通過" : "通过",
      failed: traditional ? "未通過" : "未通过",
      auditTitle: traditional ? "操作稽核" : "操作审计",
      auditHint: traditional
        ? "關鍵操作自動留痕並連結成防竄改鏈條；你可以在需要時點擊上方按鈕校驗。"
        : "关键操作自动留痕并链接成防篡改链条；你可以在需要时点击上方按钮校验。",
      chainStatus: traditional ? "鏈狀態" : "链状态",
      validChain: (count: number) => (traditional ? `完整（${count} 條）` : `完整（${count} 条）`),
      invalidChain: traditional ? "異常" : "异常",
      runsTitle: traditional ? "工作階段執行狀態" : "会话运行状态",
      runsHint: traditional
        ? "工作階段自動記錄開始/結束與結果；若進程中斷，狀態會標記為 interrupted，可重新發起繼續。"
        : "会话自动记录开始/结束与结果；若进程中断，状态会标记为 interrupted，可重新发起继续。",
      ongoing: traditional ? "進行中" : "进行中",
      sessionRunStatus: (status: string) =>
        status === "running"
          ? traditional
            ? "進行中"
            : "进行中"
          : status === "completed"
            ? traditional
              ? "已完成"
              : "已完成"
            : status === "failed"
              ? traditional
                ? "失敗"
                : "失败"
              : status === "interrupted"
                ? traditional
                  ? "中斷"
                  : "中断"
                : status,
      latestReason: traditional ? "最新狀態依據" : "最新状态依据",
      resultLabel: traditional ? "結果" : "结果",
      impact: traditional ? "影響" : "影响",
      items: traditional ? "項" : "项",
      event: traditional ? "事件" : "事件",
      tokens: traditional ? "tokens" : "tokens",
      task: traditional ? "任務" : "任务",
      verified: traditional ? "已驗證並結算" : "已验证并结算",
    }
  }
  return {
    auto: "Automatic",
    human: "Human",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    verifyAudit: "Verify audit chain",
    verifyingAudit: "Verifying…",
    automaticNotice: "All data below is recorded automatically by the system; no manual maintenance is required.",
    auditVerified: (count: number) => `Audit chain verified: ${count} records are intact.`,
    auditFailed: (issue: string) => `Audit chain verification failed: ${issue || "records were modified"}`,
    noRecordsBefore: "No records yet. Start a conversation or tool call to see the execution process here.",
    emptyTitle: "No runtime records yet",
    emptyHint:
      "This workspace has no real events, durable runs, or tool actions yet. That is not an error; they will appear here after a conversation or tool call.",
    dataSource: "Data source: TypeScript Core · current workspace · live read",
    durableTitle: "Durable runs and crash recovery",
    durableHint:
      "Runs are persisted before they start; the worker uses heartbeats to prove it is alive. After an abnormal exit, another worker can take over only after the lease expires, preventing duplicate actions.",
    noWorker: "No worker currently owns this run",
    recentTakeover: (generation: number) => `latest takeover ${generation + 1}`,
    workerOnline: "Worker online",
    leaseExpired: "Worker heartbeat expired; safe to take over",
    takeoverHeartbeat: (generation: number, time: string) => `takeover ${generation + 1} · last heartbeat ${time}`,
    noCheckpoint: "No recovery checkpoint yet",
    checkpointSaved: (sequence: number) => `Recovery checkpoint saved · event #${sequence}`,
    admissionTitle: "Custom Agent admission evidence",
    admissionHint:
      "Read-only startup checks for tool projection, workspace trust, and the fixed digest; prompts, credentials, and Provider payloads are never shown.",
    admissionDecision: (decision: string) => admissionDecisionText(decision, locale),
    admissionStatus: (status: string) => admissionStatusText(status, locale),
    admissionChecks: (passed: number, total: number) => `Checks passed ${passed}/${total}`,
    admissionTools: (declared: number, canonical: number, unsupported: number) =>
      `Tools declared ${declared} · bound ${canonical} · unsupported ${unsupported}`,
    admissionEvidenceRefs: (count: number) => `Evidence references ${count}`,
    actionsTitle: "Real actions and impact",
    actionsHint:
      "Every potentially side-effecting action passes through the unified safety gate; this shows its authorization basis, scope, and observed backend result.",
    progressTitle: "Action progress",
    assetProgressTitle: "Asset localization progress",
    progressPhase: (phase: string) => actionProgressPhaseText(phase, locale),
    progressCount: (completed: number, total: number) => `Completed ${completed}/${total}`,
    progressDetail: (detail: string) => `System status: ${detail}`,
    progressReadOnly:
      "This is a read-only durable progress view; cancellation is accepted only by the originating session before execution handoff.",
    cancelPendingAction: "Cancel pending action",
    cancellingPendingAction: "Cancelling…",
    cancelPendingActionHint:
      "Only the originating session can cancel before execution handoff; authorized or running actions remain observational.",
    mcpRecoveryTitle: "MCP external action reconciliation",
    mcpRecoveryHint:
      "After a disconnect, the external service may already have applied the action. This performs a read-only check; it never replays the request or enables automatic retry.",
    mcpRecoveryIdentity: (digest: string) => `Immutable intent fingerprint · ${digest}`,
    mcpRecoveryState: (state: string | null | undefined) =>
      state === "known_success"
        ? "Known success"
        : state === "known_failure"
          ? "Known failure"
          : state === "unknown"
            ? "Outcome unknown"
            : "Not checked",
    mcpRecoveryInspect: "Read-only check",
    mcpRecoveryInspecting: "Checking…",
    mcpRecoveryOperatorNotice:
      "Members can inspect; recording evidence requires an owner/admin and never enables automatic retry.",
    mcpRecoveryDecision: (kind: string) =>
      kind === "confirmed" ? "Read-only check confirmed" : "Manual review required",
    mcpRecoveryEvidence: (digest: string, source: string) => `Evidence ${digest} · source ${source}`,
    mcpRecoveryRecord: "Record reconciliation evidence (admin)",
    mcpRecoveryRecording: "Recording…",
    mcpRecoveryPermissionDenied: "This account can inspect only; an owner/admin must record reconciliation evidence.",
    mcpRecoveryUnavailable:
      "The MCP outcome could not be checked right now. No replay was attempted; retry later or ask an owner/admin.",
    persistedResult: (bytes: number) => `Result persisted; recovery can avoid repeating it (${bytes} bytes)`,
    notPersistedResult: "Result was not persisted; recovery needs human judgment",
    mutationRecoveryStatus: (phase: string, decision: string, requiresReview: boolean, transactionID: string) =>
      requiresReview
        ? `Recovery required · ${mutationPhaseText(phase, locale)} / ${mutationDecisionText(decision, locale)} · transaction ${transactionID}`
        : `Mutation settled · transaction ${transactionID}`,
    automaticRetryBlocked: "Automatic retry is blocked; inspect or reconcile first.",
    noRetryNeeded: "No retry is needed; the action is durably settled.",
    mutationRecoveryReason: (reason: string) => `Recovery evidence: ${reason}`,
    postProcessingTitle: "Post-processing checkpoints",
    postProcessingRecoveryTitle: "Post-processing recovery classification",
    inspectTargets: "Inspect current target state",
    inspectingTargets: "Inspecting…",
    inspectionTitle: "Post-restart target observation",
    inspectionDecision: (decision: string) => inspectionDecisionText(decision, locale),
    inspectionEntry: (operation: string, target: string, state: string) =>
      `${inspectionOperationText(operation, locale)} · ${target} · ${inspectionStateText(state, locale)}`,
    inspectionReason: (reason: string) => `Observation evidence: ${reason}`,
    inspectionUnavailable: "Target fingerprints could not be read; inspect the workspace manually before deciding.",
    recoveryRoleNotice: (role: string, canRollback: boolean, canMaintain: boolean) =>
      `Current role: ${role === "member" ? "Member" : role === "admin" ? "Admin" : "Owner"} · ${canRollback ? "guarded rollback available" : "rollback requires owner/admin"}${canMaintain ? "" : " · artifact maintenance requires owner/admin"}`,
    recoveryRollbackPermission:
      "This account can inspect and record evidence; guarded rollback and artifact maintenance require an owner/admin.",
    reviewTitle: "Human review decision",
    reviewSafetyNotice:
      "These buttons record your evidence-bound decision only. They do not write files, change Action status, or enable automatic retry.",
    rollbackTitle: "Execute guarded rollback",
    rollbackSafetyNotice:
      "This restores profile-owned inverse artifacts only while every target still matches its postimage, then verifies the original preimage again.",
    executeRollback: "Execute guarded rollback",
    executingRollback: "Rolling back…",
    rollbackUnavailable: "No complete durable inverse artifact is available; handle this mutation manually.",
    artifactMaintenanceTitle: "Inverse artifact maintenance",
    artifactMaintenanceHint:
      "Live references are collected from durable actions and only redacted counts are shown. Cleanup requires a second confirmation; referenced or corrupt artifacts are never removed.",
    auditArtifacts: "Audit artifact state",
    auditingArtifacts: "Auditing…",
    sweepArtifacts: "Prepare cleanup of unreferenced artifacts",
    confirmSweepArtifacts: "Confirm cleanup (including quota reclaim)",
    cancelSweep: "Cancel",
    sweepingArtifacts: "Cleaning…",
    settlementRecoveryTitle: "Child settlement recovery",
    settlementRecoveryHint:
      "Only the current tenant's pending recovery outbox is handled. This replays deterministic owner writes only; Provider and external requests are never retried.",
    settlementRecoveryStart: "Check pending settlements",
    settlementRecoveryConfirm: "Confirm settlement recovery",
    settlementRecoveryCancel: "Cancel",
    settlementRecoveryRunning: "Recovering…",
    settlementRecoverySummary: (scanned: number, committed: number, pending: number, failed: number) =>
      `Scanned ${scanned} · committed ${committed} · pending ${pending} · failed ${failed}`,
    settlementRecoveryReview: (count: number) => `${count} still require human review; no Provider was executed.`,
    settlementRecoveryNextPage: "More pending items remain on the next page",
    artifactStatus: (status: string) => artifactStatusText(status, locale),
    artifactSummary: (referenced: number, total: number, orphan: number) =>
      `Protected references ${referenced} · artifacts ${total} · unreferenced ${orphan}`,
    artifactAuditLine: (bytes: number, corrupt: number, missing: number, overQuota: boolean) =>
      `Disk usage ${bytes} bytes · corrupt ${corrupt} · missing references ${missing}${overQuota ? " · over quota" : ""}`,
    artifactScanIncomplete: "The durable-reference scan is incomplete; cleanup is disabled for safety.",
    continueArtifactScan: "Continue the next scan page",
    sweepRequiresCompleteScan: "Complete the durable-reference scan before cleanup.",
    artifactScanProgress: (pages: number, actions: number) => `Scanned ${pages} page(s) · ${actions} durable action(s)`,
    artifactRemoved: (count: number) => `Cleaned ${count} unreferenced artifact(s) this time`,
    artifactEvidenceTitle: "Artifact receipts and audit evidence",
    artifactEvidenceHint: (scope = "session") =>
      `Reads only controlled receipt metadata and redacted audit records for the ${scope === "tenant" ? "current tenant" : scope === "profile" ? "current profile" : "current session"}; local paths and file contents are never shown.`,
    artifactEvidenceNoSession:
      "The control center is not bound to a session or authorized owner; open a session or select a valid owner to inspect artifact evidence.",
    artifactEvidenceSummary: (artifacts: number, audits: number) => `Receipts ${artifacts} · audit records ${audits}`,
    artifactEvidenceHead: (sequence: number, hash: string) => `chain head #${sequence} · ${hash}`,
    artifactEvidenceDropped: (count: number) => `${count} older audit record(s) archived`,
    artifactEvidenceChain: (state: string) =>
      state === "intact"
        ? "The returned chain is intact"
        : state === "windowed"
          ? "Only the returned page is linked; older records are outside this window"
          : state === "broken"
            ? "The returned chain has a link problem; completeness is not claimed"
            : "No audit records yet",
    artifactEvidenceRetention: (mode: string) => `retention ${mode}`,
    artifactEvidenceReads: (count: number) => `reads ${count}`,
    artifactEvidenceCreated: (time: string) => `created ${time}`,
    artifactEvidenceAuditTitle: "Recent audit records",
    artifactEvidenceCatalogTitle: "Controlled receipts",
    artifactEvidenceEmpty: (scope = "session") =>
      `No controlled receipts are registered for the ${scope === "tenant" ? "current tenant" : scope === "profile" ? "current profile" : "current session"} yet.`,
    artifactEvidenceAuditEmpty: (scope = "session") =>
      `No audit records are available for the ${scope === "tenant" ? "current tenant" : scope === "profile" ? "current profile" : "current session"} yet.`,
    artifactEvidenceMaintenanceTitle: "Maintenance boundary",
    artifactEvidenceMaintenanceStatus: (
      canMaintain: boolean,
      status: string | undefined,
      complete: boolean | undefined,
      reason: string,
    ) =>
      !canMaintain
        ? `Maintenance unavailable for this owner: ${reason}`
        : status === undefined
          ? "Profile maintenance is available; no scan has started."
          : complete
            ? "Profile maintenance scan complete; cleanup still needs explicit confirmation."
            : status === "active"
              ? "Profile maintenance scan in progress; cleanup stays disabled."
              : "Profile maintenance scan expired; start a new audit.",
    artifactEvidenceMaintenanceProgress: (pages: number, actions: number) =>
      `Latest scan · ${pages} page(s) · ${actions} action(s)`,
    reviewing: "Recording…",
    attempts: (used: number, max: number) => `Attempts ${used}/${max}`,
    duration: (used: string, max: string) => `Duration ${used} / ${max}`,
    durationSingle: (value: string) => `Duration ${value}`,
    modelCost: (used: string, max: string) => `Model cost ${used} / ${max}`,
    localCost: "Local action; no model cost",
    activeAttempt: (attempt: number, time: string) => `Attempt ${attempt} running · started ${time}`,
    contextTitle: "Model context composition",
    contextHint:
      "Each call automatically layers identity, project facts, memory, and other inputs into context by priority; this shows each layer's share.",
    totalTokens: (total: number) => `${total} tokens total`,
    routingTitle: "Model routing records",
    routingHint:
      "Each call records the selected model, price, and reason so you can check spending and routing decisions.",
    inputCost: (value: string | number) => `${value}/million input`,
    outputCost: (value: string | number) => `${value}/million output`,
    verificationTitle: "Pre-delivery verification",
    verificationHint:
      "Before completion, the system verifies checkpoints, real tool results, and delivery checks; red means a verification item did not pass.",
    passed: "Passed",
    failed: "Failed",
    auditTitle: "Operation audit",
    auditHint:
      "Key operations are recorded and linked into a tamper-evident chain; verify it with the button above when needed.",
    chainStatus: "Chain status",
    validChain: (count: number) => `Intact (${count})`,
    invalidChain: "Invalid",
    runsTitle: "Session run status",
    runsHint:
      "Sessions record start, finish, and results automatically. Interrupted runs can be started again to continue.",
    ongoing: "Running",
    sessionRunStatus: (status: string) =>
      status === "running"
        ? "Running"
        : status === "completed"
          ? "Completed"
          : status === "failed"
            ? "Failed"
            : status === "interrupted"
              ? "Interrupted"
              : status,
    latestReason: "Latest state reason",
    resultLabel: "Result",
    impact: "Impact",
    items: "items",
    event: "event",
    tokens: "tokens",
    task: "Task",
    verified: "Verified and settled",
  }
}

export const sessionProcessCopy = (locale: Locale) => {
  const choose = (english: string, simplified: string, traditional = simplified) =>
    locale === "zh" ? simplified : locale === "zht" ? traditional : english
  return {
    ...runtimeInsightCopy(locale),
    processTitle: choose("Run process", "运行过程", "執行過程"),
    collapse: choose("Collapse", "收起", "收起"),
    expand: choose("Expand", "展开", "展開"),
    refreshFailed: (detail: string) =>
      choose(`Could not read run records: ${detail}`, `运行记录读取失败：${detail}`, `執行記錄讀取失敗：${detail}`),
    refreshFailedHint: choose(
      "This does not hide the run; retry later or inspect the backend state in Runtime Insight.",
      "这不会隐藏任务本身，你可以稍后刷新或在运行洞察中检查后端状态。",
      "這不會隱藏任務本身，你可以稍後重新整理或在執行洞察中檢查後端狀態。",
    ),
    empty: choose(
      "Start a conversation to see the run process and evolution here.",
      "开始一次对话后，这里会自动显示运行过程与进化迭代。",
      "開始一次對話後，這裡會自動顯示執行過程與演化迭代。",
    ),
    evolutionTitle: choose("Learning and evolution", "自主学习与进化", "自主學習與演化"),
    evolutionAutoFlow: choose(
      "System flow: detect failure → create candidate → isolated test → canary → promote or roll back.",
      "系统自动完成：发现失败 → 生成候选 → 隔离测试 → 灰度 → 晋升或回滚。",
      "系統自動完成：發現失敗 → 產生候選 → 隔離測試 → 灰度 → 晉升或回滾。",
    ),
    evolutionStages: [
      choose("Detect failure", "发现失败", "發現失敗"),
      choose("Create candidate", "生成候选", "產生候選"),
      choose("Isolated test", "隔离测试", "隔離測試"),
      choose("Your approval", "你审批", "你審批"),
      choose("Canary active", "灰度生效", "灰度生效"),
    ],
    evolutionEvent: (action: string) => {
      const labels: Record<string, string> = {
        candidate_created: choose("Failure found; candidate created", "发现失败并生成候选", "發現失敗並產生候選"),
        candidate_evaluated: choose("Isolated evaluation", "隔离评测", "隔離評測"),
        candidate_approved: choose("Human approved", "人工批准", "人工批准"),
        candidate_rejected: choose("Human rejected", "人工拒绝", "人工拒絕"),
        canary_started: choose("Canary started", "灰度运行", "灰度運行"),
        candidate_promoted: choose("Candidate promoted", "晋升生效", "晉升生效"),
        candidate_rolled_back: choose("Rolled back", "回滚", "回滾"),
      }
      return labels[action] ?? action
    },
    testing: choose("Isolated test in progress", "隔离测试进行中", "隔離測試進行中"),
    awaitingApproval: choose("Waiting for your approval", "等待你审批", "等待你審批"),
    testedAwaitingApproval: choose(
      "Test passed · awaiting your approval",
      "测试通过 · 等你审批",
      "測試通過 · 等你審批",
    ),
    rationale: choose("Why", "为什么", "為什麼"),
    evidence: (count: number) => choose(`(${count} evidence items)`, `（依据 ${count} 条）`, `（依據 ${count} 條）`),
    testFailed: choose(
      "Isolated test failed; approval is not recommended",
      "隔离测试未通过，不建议批准",
      "隔離測試未通過，不建議批准",
    ),
    testPassed: choose(
      "Isolated test passed; it is ready for your approval",
      "隔离测试已通过，可以放心审批",
      "隔離測試已通過，可以放心審批",
    ),
    approve: choose("Approve", "批准", "批准"),
    reject: choose("Reject", "拒绝", "拒絕"),
    humanParenthesized: choose("(human)", "（人工）", "（人工）"),
    sessionStatus: choose("Session status · automatic record", "会话状态 · 自动记录", "工作階段狀態 · 自動記錄"),
    continueHint: choose(
      "Send a message or use /continue to continue",
      "可发送消息或用 /continue 继续",
      "可發送訊息或用 /continue 繼續",
    ),
    checkpoint: choose("Recovery checkpoint saved", "已有恢复点", "已有恢復點"),
    workerOnline: choose("Worker online", "工作进程在线", "工作進程在線"),
    actionTimeline: choose(
      "Execution timeline · real backend records",
      "执行时间线 · 真实后端记录",
      "執行時間線 · 真實後端記錄",
    ),
    impactRange: (count: number) => choose(`Impact ${count} items`, `影响范围 ${count} 项`, `影響範圍 ${count} 項`),
    executionFailed: choose("Execution result: failed", "执行结果：失败", "執行結果：失敗"),
    executionSucceeded: choose("Execution result: succeeded", "执行结果：成功", "執行結果：成功"),
    modelSelection: choose("Model selection · automatic", "模型选择 · 自动", "模型選擇 · 自動"),
    verification: choose("Pre-delivery verification · automatic", "交付前验证 · 自动", "交付前驗證 · 自動"),
    memoryRecall: choose("Memory retrieval · automatic", "记忆检索 · 自动", "記憶檢索 · 自動"),
    fingerprint: choose("Query fingerprint", "检索指纹", "檢索指紋"),
    governedRecord: choose("Governed record", "受治理记录", "受治理記錄"),
    auditTitle: choose("Operation records", "操作记录", "操作記錄"),
    auditNotice: choose(
      "Automatic record · human verification available",
      "自动记录 · 人工可校验",
      "自動記錄 · 人工可校驗",
    ),
    verifyAudit: choose("Verify tamper protection", "校验是否被篡改", "校驗是否被竄改"),
    verifyingAudit: choose("Verifying…", "校验中…", "校驗中…"),
    auditStart: choose("Started", "开始", "開始"),
    auditEnd: choose("Finished", "结束", "結束"),
    approveConfirm: (title: string, rationale: string) =>
      choose(
        `Approve evolution candidate: ${title}\n\n${rationale}`,
        `批准进化候选：${title}\n\n${rationale}`,
        `批准演化候選：${title}\n\n${rationale}`,
      ),
    rejectConfirm: (title: string, rationale: string) =>
      choose(
        `Reject evolution candidate: ${title}\n\n${rationale}`,
        `拒绝进化候选：${title}\n\n${rationale}`,
        `拒絕演化候選：${title}\n\n${rationale}`,
      ),
    transitionReason: (label: string) =>
      choose(`From the conversation UI: ${label}`, `由对话界面${label}`, `由對話介面${label}`),
    transitionFailed: (label: string, detail: string) =>
      choose(`${label} failed: ${detail}`, `${label}失败：${detail}`, `${label}失敗：${detail}`),
  }
}
