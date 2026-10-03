import type { Locale } from "@/context/language"

/** Present the server's receipt observation; never infer delivery from execution status. */
export function childReceiptPresentation(receipt: string | undefined, locale: Locale) {
  const zh = locale === "zh"
  const zht = locale === "zht"
  if (receipt === "missing")
    return {
      label: zh ? "执行已结束，结果尚未确认" : zht ? "執行已結束，結果尚未確認" : "Execution ended; result unconfirmed",
      detail: zh
        ? "尚未找到结果记录（回执），不能据此交付。请先刷新状态；若持续未确认，可打开会话检查。不要为获取结果而重复执行任务。"
        : zht
          ? "尚未找到結果記錄（回執），不能據此交付。請先重新整理狀態；若持續未確認，可開啟會話檢查。不要為取得結果而重複執行任務。"
          : "The result receipt is missing, so delivery cannot be confirmed. Refresh the status; if this persists, open the session to inspect it. Do not rerun the task just to retrieve its result.",
    }
  if (receipt === "present")
    return {
      label: zh ? "结果已记录" : zht ? "結果已記錄" : "Result recorded",
      detail: zh
        ? "可打开会话查看执行内容。结果已记录不代表交付验收通过。"
        : zht
          ? "可開啟會話查看執行內容。結果已記錄不代表交付驗收通過。"
          : "Open the session to inspect the execution. A recorded result does not mean delivery acceptance has passed.",
    }
  if (receipt === "not-required")
    return {
      label: zh ? "已取消，无需结果回执" : zht ? "已取消，無需結果回執" : "Cancelled; no result receipt required",
      detail: zh
        ? "取消不是成功交付。可打开会话查看已有内容。"
        : zht
          ? "取消不是成功交付。可開啟會話查看已有內容。"
          : "Cancellation is not successful delivery. Open the session to inspect any existing content.",
    }
  if (receipt === "pending")
    return {
      label: zh ? "等待执行结束" : zht ? "等待執行結束" : "Awaiting execution outcome",
      detail: zh
        ? "任务尚未结束，暂时不能确认最终结果。可等待状态更新或打开会话查看进展。"
        : zht
          ? "任務尚未結束，暫時不能確認最終結果。可等待狀態更新或開啟會話查看進展。"
          : "The task is not terminal yet. Wait for a status update or open the session to inspect its progress.",
    }
  return {
    label: zh ? "结果状态未知" : zht ? "結果狀態未知" : "Result status unknown",
    detail: zh
      ? "服务未提供可识别的结果状态，不能仅凭“已完成”确认交付。请刷新状态或打开会话检查。"
      : zht
        ? "服務未提供可識別的結果狀態，不能僅憑「已完成」確認交付。請重新整理狀態或開啟會話檢查。"
        : "The server did not provide a recognized result status. Completed execution alone does not confirm delivery. Refresh or open the session to inspect it.",
  }
}

export const workspaceCopy = (locale: Locale) => {
  if (locale === "zh" || locale === "zht") {
    const traditional = locale === "zht"
    return {
      title: traditional ? "個人工作區" : "个人工作区",
      safety: traditional
        ? "只顯示安全摘要：不展示原始事件、提示詞、憑據、租約持有人，也不提供破壞性維護操作。"
        : "只显示安全摘要：不展示原始事件、提示词、凭据、租约持有人，也不提供破坏性维护操作。",
      loading: traditional ? "載入中…" : "加载中…",
      unavailable: traditional ? "工作區資料暫時不可用，請重試。" : "工作区数据暂时不可用，请重试。",
      sessions: traditional ? "會話" : "会话",
      active: traditional ? "個活躍" : "个活跃",
      tasks: traditional ? "任務" : "任务",
      pending: traditional ? "個待處理" : "个待处理",
      runs: traditional ? "執行" : "执行",
      recovery: traditional ? "個待恢復" : "个待恢复",
      delegatedChildren: traditional ? "委派子任務" : "委派子任务",
      delegatedChildrenHint: traditional
        ? "顯示目前工作區快照中最近 12 個父執行的可讀直接子任務，包含已結束的執行；控制仍需有效授權。"
        : "显示当前工作区快照中最近 12 个父执行的可读直接子任务，包含已结束的执行；控制仍需有效授权。",
      noDelegatedChildren: traditional
        ? "目前範圍內沒有可顯示的直接子任務；也可能是查詢失敗或沒有讀取權限。"
        : "当前范围内没有可显示的直接子任务；也可能是查询失败或没有读取权限。",
      refreshChild: traditional ? "重新整理狀態（只讀）" : "刷新状态（只读）",
      readOnlyChild: traditional
        ? "目前僅供查看：可重新整理或開啟會話，不會重新執行任務。"
        : "当前仅供查看：可刷新或打开会话，不会重新执行任务。",
      childDepth: traditional ? "深度" : "深度",
      executionStatus: traditional ? "執行狀態" : "执行状态",
      objectiveDigest: traditional ? "目標指紋" : "目标指纹",
      control: traditional ? "控制子任務" : "控制子任务",
      closeControl: traditional ? "收起控制" : "收起控制",
      controlHint: traditional
        ? "僅控制此父執行的直接子任務。每次操作都會建立可重試的請求識別；提示詞仍走既有安全收件匣。"
        : "只控制此父执行的直接子任务。每次操作都会建立可重试的请求标识；提示词仍走现有安全收件箱。",
      messageMode: traditional ? "訊息操作" : "消息操作",
      steer: traditional ? "立即引導" : "立即引导",
      followup: traditional ? "排入追問" : "排入追问",
      sendSteer: traditional ? "送出引導" : "发送引导",
      sendFollowup: traditional ? "送出追問" : "发送追问",
      wait: traditional ? "等待狀態" : "等待状态",
      cancel: traditional ? "取消子任務" : "取消子任务",
      cancelReason: traditional ? "取消原因" : "取消原因",
      timeout: traditional ? "等待上限" : "等待上限",
      promptPlaceholder: traditional ? "輸入要傳給子任務的內容…" : "输入要传给子任务的内容…",
      reasonPlaceholder: traditional ? "例如：不再需要此子任務" : "例如：不再需要此子任务",
      promptRequired: traditional ? "請先輸入要傳送的內容。" : "请先输入要发送的内容。",
      reasonRequired: traditional ? "請先填寫取消原因。" : "请先填写取消原因。",
      working: traditional ? "處理中…" : "处理中…",
      retry: traditional ? "使用相同請求重試" : "使用相同请求重试",
      controlAccepted: traditional ? "操作已提交；正在重新整理子任務狀態。" : "操作已提交，正在刷新子任务状态。",
      controlTimedOut: traditional
        ? "等待已達上限；子任務仍在執行，請稍後重新整理。"
        : "等待已达上限；子任务仍在运行，请稍后刷新。",
      terminalControl: traditional
        ? "此子任務已結束，只能讀取最終狀態；不再接受引導、追問或取消。"
        : "此子任务已结束，只能读取最终状态；不再接受引导、追问或取消。",
      jobs: traditional ? "後台自動任務" : "后台自动任务",
      approvals: traditional ? "個待批准" : "个待批准",
      artifacts: traditional ? "成果引用" : "成果引用",
      artifactDetail: traditional ? "可追溯的結果引用" : "可追溯的结果引用",
      memories: traditional ? "記憶候選" : "记忆候选",
      safeMetadata: traditional ? "只顯示安全元資料" : "只显示安全元数据",
      runCost: traditional ? "執行成本" : "执行成本",
      jobCost: traditional ? "任務成本" : "任务成本",
      of: traditional ? "上限" : "上限",
      project: traditional ? "專案" : "项目",
      location: traditional ? "位置" : "位置",
      asOf: traditional ? "更新於" : "更新于",
      safetyNote: traditional
        ? "後台自動任務始終可見；需要人工處理的事項集中在下方。破壞性維護仍須使用獨立的管理授權。"
        : "后台自动任务始终可见；需要人工处理的事项集中在下方。破坏性维护仍须使用独立的管理授权。",
      attention: traditional ? "需要人工處理" : "需要人工处理",
      entries: traditional ? "項" : "项",
      noAttention: traditional ? "目前沒有需要人工處理的事項。" : "目前没有需要人工处理的事项。",
      next: traditional ? "下次" : "下次",
      updated: traditional ? "更新" : "更新",
      initiatedBy: traditional ? "發起者" : "发起者",
      confidence: traditional ? "可信度" : "可信度",
      hiddenContent: traditional ? "為保護隱私，此安全摘要不包含記憶正文。" : "为保护隐私，此安全摘要不包含记忆正文。",
      blockers: traditional ? "未解決阻塞" : "未解决阻塞",
      openSession: traditional ? "開啟會話" : "打开会话",
      showAll: traditional ? "查看全部" : "查看全部",
      showLess: traditional ? "收起" : "收起",
      counts: {
        tasks: traditional ? "任務" : "任务",
        runs: traditional ? "執行" : "执行",
        jobs: traditional ? "後台任務" : "后台任务",
        artifacts: traditional ? "成果" : "成果",
      },
    }
  }
  return {
    title: "Personal Workspace",
    safety:
      "Safe summary only: raw events, prompts, credentials, lease owners, and destructive maintenance actions are not exposed.",
    loading: "Loading…",
    unavailable: "Workspace data is temporarily unavailable. Please retry.",
    sessions: "Sessions",
    active: "active",
    tasks: "Tasks",
    pending: "pending",
    runs: "Runs",
    recovery: "need recovery",
    delegatedChildren: "Delegated child runs",
    delegatedChildrenHint:
      "Shows readable direct children from the latest 12 parent runs in this workspace snapshot, including ended runs. Control still requires valid authority.",
    noDelegatedChildren:
      "No direct children can be shown in this range; the query may also have failed or access may be denied.",
    refreshChild: "Refresh status (read-only)",
    readOnlyChild: "Read-only for now: refresh or open the session without rerunning the task.",
    childDepth: "depth",
    executionStatus: "Execution status",
    objectiveDigest: "objective fingerprint",
    control: "Control child",
    closeControl: "Close controls",
    controlHint:
      "Controls target this parent's direct child only. Each operation gets a retryable request identity; prompt text still uses the existing safe inbox.",
    messageMode: "Message operation",
    steer: "Steer now",
    followup: "Queue follow-up",
    sendSteer: "Send steer",
    sendFollowup: "Send follow-up",
    wait: "Wait for status",
    cancel: "Cancel child",
    cancelReason: "Cancellation reason",
    timeout: "Wait limit",
    promptPlaceholder: "Write a message for the child…",
    reasonPlaceholder: "For example: this child is no longer needed",
    promptRequired: "Enter a message before sending.",
    reasonRequired: "Enter a cancellation reason first.",
    working: "Working…",
    retry: "Retry with the same request",
    controlAccepted: "Operation submitted; refreshing the child status.",
    controlTimedOut: "The wait reached its limit; the child is still running. Refresh later.",
    terminalControl:
      "This child has finished. Only its final status can be observed; steer, follow-up, and cancel are closed.",
    jobs: "Automatic jobs",
    approvals: "need approval",
    artifacts: "Artifacts",
    artifactDetail: "traceable result references",
    memories: "Memory candidates",
    safeMetadata: "safe metadata only",
    runCost: "Run cost",
    jobCost: "Job cost",
    of: "limit",
    project: "Project",
    location: "Location",
    asOf: "Updated",
    safetyNote:
      "Automatic jobs remain visible; items that need you are collected below. Destructive maintenance still requires separate administrator authorization.",
    attention: "Needs your attention",
    entries: "items",
    noAttention: "Nothing needs your attention right now.",
    next: "next",
    updated: "updated",
    initiatedBy: "initiated by",
    confidence: "confidence",
    hiddenContent: "Memory content is excluded from this safe summary to protect privacy.",
    blockers: "Unresolved blockers",
    openSession: "Open session",
    showAll: "Show all",
    showLess: "Show less",
    counts: { tasks: "tasks", runs: "runs", jobs: "jobs", artifacts: "artifacts" },
  }
}

export const statusLabel = (status: string, locale: Locale) => {
  const labels: Record<string, [string, string, string]> = {
    needs_human: ["Needs attention", "需要人工处理", "需要人工處理"],
    system_automatic: ["Automatic", "系统自动", "系統自動"],
    human_visible: ["Visible", "用户可见", "使用者可見"],
    settled: ["Settled", "已结束", "已結束"],
    pending: ["Pending", "待处理", "待處理"],
    in_progress: ["In progress", "进行中", "進行中"],
    draft: ["Draft", "草稿", "草稿"],
    preflight: ["Preflight", "执行前检查", "執行前檢查"],
    awaiting_authorization: ["Awaiting authorization", "等待授权", "等待授權"],
    awaiting_approval: ["Awaiting approval", "等待批准", "等待批准"],
    queued: ["Queued", "排队中", "排隊中"],
    running: ["Running", "运行中", "執行中"],
    paused: ["Paused", "已暂停", "已暫停"],
    recovering: ["Recovering", "恢复中", "恢復中"],
    verifying: ["Verifying", "验证中", "驗證中"],
    completed: ["Completed", "已完成", "已完成"],
    failed: ["Failed", "失败", "失敗"],
    cancelled: ["Cancelled", "已取消", "已取消"],
    pending_approval: ["Pending approval", "等待批准", "等待批准"],
    recovery_required: ["Recovery required", "需要恢复", "需要恢復"],
    artifact_ready: ["Artifact ready", "成果可审查", "成果可審查"],
    memory_candidate: ["Needs review", "等待审查", "等待審查"],
    cost_review: ["Cost review", "成本检查", "成本檢查"],
  }
  const hit = labels[status]
  if (!hit) return status.replaceAll("_", " ")
  return hit[locale === "zh" ? 1 : locale === "zht" ? 2 : 0]
}

const localeForIntl = (locale: Locale) => (locale === "zh" ? "zh-CN" : locale === "zht" ? "zh-TW" : locale)

export const formatWorkspaceTime = (value: string | number | Date | undefined, locale: Locale) => {
  if (value === undefined) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(localeForIntl(locale))
}

const localizedLabel = (value: string, locale: Locale, labels: Record<string, [string, string, string]>) => {
  const hit = labels[value]
  if (!hit) return value.replaceAll("_", " ")
  return hit[locale === "zh" ? 1 : locale === "zht" ? 2 : 0]
}

export const personalJobApprovalLabel = (value: string, locale: Locale) =>
  localizedLabel(value, locale, {
    not_required: ["No approval needed", "无需批准", "無需批准"],
    pending: ["Waiting for approval", "等待批准", "等待批准"],
    approved: ["Approved", "已批准", "已批准"],
    rejected: ["Rejected", "已拒绝", "已拒絕"],
  })

export const runInitiatorLabel = (value: string, locale: Locale) =>
  localizedLabel(value, locale, {
    user: ["User", "用户", "使用者"],
    agent: ["Agent", "Agent", "Agent"],
    schedule: ["Schedule", "定时任务", "排程任務"],
    trigger: ["Trigger", "触发器", "觸發器"],
    recovery: ["Recovery", "恢复流程", "恢復流程"],
    evolution: ["Evolution", "进化流程", "演化流程"],
  })

export const runAuthorityLabel = (value: string, locale: Locale) =>
  localizedLabel(value, locale, {
    automatic: ["Automatic authority", "系统自动授权", "系統自動授權"],
    scoped_grant: ["Scoped permission", "范围授权", "範圍授權"],
    human: ["Human approved", "人工批准", "人工批准"],
    forbidden: ["Blocked", "已阻止", "已阻止"],
  })

export const riskTierLabel = (value: string, locale: Locale) =>
  localizedLabel(value, locale, {
    L0: ["Risk L0", "风险 L0", "風險 L0"],
    L1: ["Risk L1", "风险 L1", "風險 L1"],
    L2: ["Risk L2", "风险 L2", "風險 L2"],
    L3: ["Risk L3", "风险 L3", "風險 L3"],
    L4: ["Risk L4", "风险 L4", "風險 L4"],
  })

export const visibilityLabel = (mode: string, locale: Locale) =>
  localizedLabel(mode, locale, {
    background: ["Background automatic", "后台自动", "背景自動"],
  })
