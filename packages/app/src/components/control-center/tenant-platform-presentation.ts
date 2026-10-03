import type { Locale } from "@/context/language"

type LocalizedCopy = readonly [english: string, simplified: string, traditional: string]

const intlLocale: Partial<Record<Locale, string>> = {
  en: "en-US",
  zh: "zh-CN",
  zht: "zh-TW",
}

const choose = (copy: LocalizedCopy, locale: Locale) =>
  locale === "zh" ? copy[1] : locale === "zht" ? copy[2] : copy[0]

const statusCopies: Record<string, LocalizedCopy> = {
  active: ["Active", "已启用", "已啟用"],
  approved: ["Approved", "已批准", "已批准"],
  completed: ["Completed", "已完成", "已完成"],
  created: ["Created", "已创建", "已建立"],
  executing: ["Executing", "执行中", "執行中"],
  failed: ["Failed", "失败", "失敗"],
  rejected: ["Rejected", "已拒绝", "已拒絕"],
  requested: ["Requested", "已请求", "已請求"],
  restored: ["Restored", "已恢复", "已還原"],
  revoked: ["Revoked", "已撤销", "已撤銷"],
  verified: ["Verified", "已校验", "已驗證"],
}

const kindCopies: Record<string, LocalizedCopy> = {
  "tenant-export": ["Tenant data export", "租户数据导出", "租戶資料匯出"],
  "tenant-delete": ["Tenant data deletion", "租户数据删除", "租戶資料刪除"],
}

export const tenantStatusLabel = (value: string, locale: Locale) =>
  choose(
    statusCopies[value] ?? [value.replaceAll("_", " "), value.replaceAll("_", " "), value.replaceAll("_", " ")],
    locale,
  )

export const tenantDataKindLabel = (value: string, locale: Locale) =>
  choose(
    kindCopies[value] ?? [value.replaceAll("_", " "), value.replaceAll("_", " "), value.replaceAll("_", " ")],
    locale,
  )

export const shortDigest = (value: string, visible = 12) => {
  if (value.length <= visible * 2 + 1) return value
  return `${value.slice(0, visible)}…${value.slice(-visible)}`
}

export const formatTenantTime = (value: string | number | Date | undefined, locale: Locale) => {
  if (value === undefined) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat(intlLocale[locale] ?? "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}
