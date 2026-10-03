import type { Locale } from "@/context/language"
import type * as MemoryCandidate from "@arforge-ai/schema/memory-candidate"

const choose = (locale: Locale, values: [string, string, string]) =>
  values[locale === "zh" ? 1 : locale === "zht" ? 2 : 0]

export const candidateReviewCopy = (locale: Locale) => ({
  review: choose(locale, ["Review candidate", "审查候选", "審查候選"]),
  close: choose(locale, ["Close details", "收起详情", "收起詳情"]),
  loading: choose(locale, ["Loading candidate…", "正在加载候选…", "正在載入候選…"]),
  processing: choose(locale, ["Processing…", "正在处理…", "正在處理…"]),
  retry: choose(locale, ["Retry", "重试", "重試"]),
  content: choose(locale, ["Proposed memory", "候选记忆内容", "候選記憶內容"]),
  redacted: choose(locale, [
    "Secret or credential-like content is hidden and cannot be approved.",
    "疑似秘密或凭据的内容已隐藏，且不能批准。",
    "疑似秘密或憑據的內容已隱藏，且不能批准。",
  ]),
  reason: choose(locale, ["Decision reason", "决策理由", "決策理由"]),
  reasonHelp: choose(locale, [
    "Required for approval, rejection, and activation. It will be stored in the audit trail.",
    "批准、拒绝和激活都必须填写；理由会写入审计记录。",
    "批准、拒絕和啟用都必須填寫；理由會寫入稽核記錄。",
  ]),
  approve: choose(locale, ["Approve", "批准", "批准"]),
  reject: choose(locale, ["Reject", "拒绝", "拒絕"]),
  confirmReject: choose(locale, ["Confirm rejection", "确认拒绝", "確認拒絕"]),
  cancel: choose(locale, ["Cancel", "取消", "取消"]),
  activate: choose(locale, ["Activate memory", "激活记忆", "啟用記憶"]),
  audit: choose(locale, ["Audit trail", "审计记录", "稽核記錄"]),
  policy: choose(locale, ["Policy", "策略", "策略"]),
  dedup: choose(locale, ["Duplicate check", "重复检查", "重複檢查"]),
  retention: choose(locale, ["Retention", "保留策略", "保留策略"]),
  evidence: choose(locale, ["Source evidence", "来源证据", "來源證據"]),
  approved: choose(locale, [
    "Candidate approved. Review it once more before activation.",
    "候选已批准。激活前请再次确认内容。",
    "候選已批准。啟用前請再次確認內容。",
  ]),
  rejected: choose(locale, [
    "Candidate rejected and kept in the audit history.",
    "候选已拒绝，并保留在审计历史中。",
    "候選已拒絕，並保留在稽核歷史中。",
  ]),
  activated: choose(locale, [
    "Candidate activated as durable memory.",
    "候选已激活为持久记忆。",
    "候選已啟用為持久記憶。",
  ]),
})

export const candidateBlockLabel = (code: MemoryCandidate.ReviewBlockCode, locale: Locale) => {
  const labels: Record<MemoryCandidate.ReviewBlockCode, [string, string, string]> = {
    status_not_proposed: [
      "The candidate is no longer awaiting approval.",
      "候选已不再等待批准。",
      "候選已不再等待批准。",
    ],
    policy_not_allow: [
      "The policy explicitly denied this candidate.",
      "策略已明确拒绝此候选。",
      "策略已明確拒絕此候選。",
    ],
    secret_or_credential: [
      "Secret or credential-like candidates cannot be approved.",
      "秘密或凭据类候选不能批准。",
      "秘密或憑據類候選不能批准。",
    ],
    duplicate: ["A duplicate candidate cannot be approved.", "重复候选不能批准。", "重複候選不能批准。"],
    conflict: [
      "Resolve the memory conflict before approval.",
      "批准前必须先解决记忆冲突。",
      "批准前必須先解決記憶衝突。",
    ],
    working_state: [
      "Short-lived working state cannot become durable memory.",
      "短期工作状态不能变成持久记忆。",
      "短期工作狀態不能變成持久記憶。",
    ],
  }
  return choose(locale, labels[code])
}

const valueLabels: Record<string, [string, string, string]> = {
  proposed: ["Awaiting review", "等待审查", "等待審查"],
  approved: ["Approved", "已批准", "已批准"],
  rejected: ["Rejected", "已拒绝", "已拒絕"],
  promoted: ["Activated", "已激活", "已啟用"],
  public: ["Public", "公开", "公開"],
  internal: ["Internal", "内部", "內部"],
  confidential: ["Confidential", "机密", "機密"],
  secret: ["Secret", "秘密", "秘密"],
  allow: ["Allowed", "允许", "允許"],
  review: ["Needs review", "需要审查", "需要審查"],
  deny: ["Denied", "已拒绝", "已拒絕"],
  unknown: ["Not checked", "未检查", "未檢查"],
  novel: ["No duplicate", "无重复", "無重複"],
  near_duplicate: ["Possible duplicate", "可能重复", "可能重複"],
  duplicate: ["Duplicate", "重复", "重複"],
  conflict: ["Conflict", "冲突", "衝突"],
  default: ["Default", "默认", "預設"],
  short: ["Short term", "短期", "短期"],
  long: ["Long term", "长期", "長期"],
  indefinite: ["Indefinite", "长期保留", "長期保留"],
  until_review: ["Until next review", "保留至下次审查", "保留至下次審查"],
  activated: ["Activated", "已激活", "已啟用"],
}

export const candidateValueLabel = (value: string, locale: Locale) =>
  valueLabels[value] ? choose(locale, valueLabels[value]) : value

export const candidateReasonLabel = (value: string, locale: Locale) => {
  if (/Legacy (?:auto|model) write routed to candidate review\./i.test(value))
    return choose(locale, [
      "Model-generated memory was routed to candidate review.",
      "模型生成的记忆已转入候选审查。",
      "模型生成的記憶已轉入候選審查。",
    ])
  if (/Legacy (?:auto|model) MemoryV2\.create request/i.test(value))
    return choose(locale, [
      "An automatic memory request created this candidate.",
      "自动记忆请求创建了此候选。",
      "自動記憶請求建立了此候選。",
    ])
  if (/Automatic memory requires explicit approval\./i.test(value))
    return choose(locale, [
      "Automatic memory requires explicit approval.",
      "自动记忆必须经过明确批准。",
      "自動記憶必須經過明確批准。",
    ])
  return value
}
