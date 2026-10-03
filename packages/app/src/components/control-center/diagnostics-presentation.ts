import type { Locale } from "@/context/language"

export type DiagnosisMode = "error" | "frontend" | "javascript"
export type DiagnosisSeverity = "error" | "warning" | "info"

const language = (locale: Locale) => (locale === "zh" || locale === "zht" ? locale : "en")

export function diagnosisModeLabel(mode: DiagnosisMode, locale: Locale = "en") {
  const labels = {
    en: {
      error: "Error / document",
      frontend: "Frontend HTML / Vue",
      javascript: "JavaScript",
    },
    zh: {
      error: "错误 / 文档",
      frontend: "前端 HTML / Vue",
      javascript: "JavaScript",
    },
    zht: {
      error: "錯誤 / 文件",
      frontend: "前端 HTML / Vue",
      javascript: "JavaScript",
    },
  } as const
  return labels[language(locale)][mode]
}

export function diagnosisStatusLabel(success: boolean, locale: Locale = "en") {
  const labels = {
    en: { passed: "Checks passed", findings: "Review findings" },
    zh: { passed: "检查通过", findings: "需要查看发现项" },
    zht: { passed: "檢查通過", findings: "需要查看發現項" },
  } as const
  return labels[language(locale)][success ? "passed" : "findings"]
}

export function diagnosisSeverityLabel(severity: DiagnosisSeverity, locale: Locale = "en") {
  const labels = {
    en: { error: "Error", warning: "Warning", info: "Info" },
    zh: { error: "错误", warning: "警告", info: "信息" },
    zht: { error: "錯誤", warning: "警告", info: "資訊" },
  } as const
  return labels[language(locale)][severity]
}

export function diagnosisModeHint(mode: DiagnosisMode, locale: Locale = "en") {
  const hints = {
    en: {
      error: "Extracts local text, identifies error signals, and searches workspace code.",
      frontend: "Checks bounded HTML/Vue structure, scripts, mount targets, routes, icons, and asset references.",
      javascript: "Checks bounded JavaScript delimiters, strings, comments, and other deterministic syntax signals.",
    },
    zh: {
      error: "提取本地文本、识别错误信号，并搜索工作区代码。",
      frontend: "检查有界 HTML/Vue 结构、脚本、挂载目标、路由、图标和资源引用。",
      javascript: "检查有界 JavaScript 分隔符、字符串、注释及其他确定性语法信号。",
    },
    zht: {
      error: "擷取本機文字、識別錯誤訊號，並搜尋工作區程式碼。",
      frontend: "檢查有界 HTML/Vue 結構、腳本、掛載目標、路由、圖示和資源引用。",
      javascript: "檢查有界 JavaScript 分隔符、字串、註解及其他確定性語法訊號。",
    },
  } as const
  return hints[language(locale)][mode]
}
