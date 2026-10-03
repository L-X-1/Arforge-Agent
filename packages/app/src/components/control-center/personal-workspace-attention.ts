import type { Locale } from "@/context/language"
import type { SessionSettingsValue } from "@/components/session/session-settings-navigation"
import type { ArforgeSettingsValue } from "./navigation"

export type AttentionTarget = ArforgeSettingsValue | SessionSettingsValue | `#${string}`
export type AttentionResourceType = "personal_job" | "run" | "memory_candidate" | "workspace"

const localized = (value: [string, string, string], locale: Locale) =>
  value[locale === "zh" ? 1 : locale === "zht" ? 2 : 0]

export const attentionTitle = (
  kind: string,
  fallback: string,
  locale: Locale,
  resourceType?: AttentionResourceType,
) => {
  if (kind === "pending_approval" && resourceType === "run")
    return localized(["Run authorization", "执行等待授权", "執行等待授權"], locale)
  const labels: Record<string, [string, string, string]> = {
    pending_approval: ["Automatic job review", "后台任务待确认", "後台任務待確認"],
    recovery_required: ["Run recovery", "执行恢复", "執行恢復"],
    artifact_ready: ["Artifact ready", "成果已生成", "成果已產生"],
    memory_candidate: ["Memory review", "记忆候选待审查", "記憶候選待審查"],
    cost_review: ["Cost review", "成本使用情况", "成本使用情況"],
  }
  const hit = labels[kind]
  if (!hit) return fallback
  return localized(hit, locale)
}

export const attentionDetail = (
  kind: string,
  fallback: string,
  locale: Locale,
  resourceType?: AttentionResourceType,
) => {
  if (kind === "pending_approval" && resourceType === "run")
    return localized(
      [
        "This run is waiting for human authorization before execution can continue.",
        "这次执行正在等待人工授权，授权前不会继续。",
        "這次執行正在等待人工授權，授權前不會繼續。",
      ],
      locale,
    )
  const labels: Record<string, [string, string, string]> = {
    pending_approval: [
      "An automatic job is waiting for your approval before it can continue.",
      "后台自动任务正在等待你的批准，批准前不会继续执行。",
      "後台自動任務正在等待你的批准，批准前不會繼續執行。",
    ],
    recovery_required: [
      "The previous run did not finish normally. Review its recovery details before continuing.",
      "上次执行未正常完成。请先查看恢复详情，确认当前状态后再继续。",
      "上次執行未正常完成。請先查看恢復詳情，確認目前狀態後再繼續。",
    ],
    artifact_ready: [
      "The automatic job produced traceable results that are ready to review.",
      "后台自动任务已生成可追溯的成果，可在任务详情中查看。",
      "後台自動任務已產生可追溯的成果，可在任務詳情中查看。",
    ],
    memory_candidate: [
      "A memory candidate is waiting for human review before activation.",
      "记忆候选正在等待人工审查，审查前不会启用。",
      "記憶候選正在等待人工審查，審查前不會啟用。",
    ],
    cost_review: [
      "Review the accumulated usage and budget limits for this workspace.",
      "请检查当前工作区的累计用量与预算上限。",
      "請檢查目前工作區的累計用量與預算上限。",
    ],
  }
  const hit = labels[kind]
  if (!hit) return fallback
  return localized(hit, locale)
}

export const attentionAction = (
  kind: string,
  locale: Locale,
  resourceType?: AttentionResourceType,
  crossSession = false,
) => {
  if (kind === "pending_approval" && resourceType === "run")
    return {
      target: "arforge-runtime" as const,
      label: localized(["View run awaiting authorization", "查看待授权执行", "查看待授權執行"], locale),
    }
  const values: Record<string, { target: AttentionTarget; label: [string, string, string] }> = {
    pending_approval: {
      target: "session-automation",
      label: ["Review automatic task", "审查后台任务", "審查後台任務"],
    },
    recovery_required: {
      target: "arforge-runtime",
      label: ["View recovery details", "查看恢复详情", "查看恢復詳情"],
    },
    artifact_ready: {
      target: "session-automation",
      label: ["Review artifacts", "审查成果", "審查成果"],
    },
    memory_candidate: {
      target: "#personal-workspace-memory-candidates",
      label: ["View candidate", "查看候选信息", "查看候選資訊"],
    },
    cost_review: {
      target: "#personal-workspace-cost",
      label: ["View cost summary", "查看成本汇总", "查看成本彙總"],
    },
  }
  const value = values[kind]
  if (!value) return undefined
  if (crossSession && value.target === "session-automation")
    return {
      target: "session-automation" as const,
      label: localized(["Open related session", "打开所属会话", "開啟所屬 Session"], locale),
    }
  return {
    target: value.target,
    label: localized(value.label, locale),
  }
}
