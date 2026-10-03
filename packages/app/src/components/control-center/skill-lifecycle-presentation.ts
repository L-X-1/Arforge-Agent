import type { Locale } from "@/context/language"

type Localized = readonly [english: string, simplified: string, traditional: string]

const choose = (value: Localized, locale: Locale) =>
  locale === "zh" ? value[1] : locale === "zht" ? value[2] : value[0]

const CHECK_LABELS: Record<string, Localized> = {
  no_permission_expansion: ["No permission expansion", "未扩大权限范围", "未擴大權限範圍"],
  no_new_secret: ["No new secret access", "没有新增密钥访问", "沒有新增密鑰存取"],
  no_new_egress: ["No new network egress", "没有新增联网目标", "沒有新增網路目標"],
  no_regression: ["No regression", "没有回归问题", "沒有回歸問題"],
  utility_non_regression: ["Utility did not regress", "效用没有下降", "效用沒有下降"],
}

export function skillEvaluationCheckLabel(check: string, locale: Locale): string {
  return CHECK_LABELS[check] ? choose(CHECK_LABELS[check], locale) : check.replaceAll("_", " ")
}

export function skillDeploymentFieldLabel(field: string, locale: Locale): string {
  const labels: Record<string, Localized> = {
    skill: ["Skill", "技能", "技能"],
    active_candidate: ["Active candidate", "当前候选", "目前候選"],
    previous_candidate: ["Previous candidate", "上一候选", "上一候選"],
    generation: ["Deployment generation", "部署代次", "部署代次"],
    deployment_digest: ["Deployment evidence digest", "部署证据摘要", "部署證據摘要"],
  }
  return labels[field] ? choose(labels[field], locale) : field.replaceAll("_", " ")
}
