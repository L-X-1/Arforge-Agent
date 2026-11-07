export function homeCopy(locale: string, fallbackTitle: string) {
  if (locale === "zh") return { start: "开始一段新对话", back: "返回首页", history: "完整历史" }
  if (locale === "zht") return { start: "開始一段新對話", back: "返回首頁", history: "完整歷史" }
  if (locale === "en") return { start: "Start a new conversation", back: "Back to home", history: "All sessions" }
  // Existing translations remain in use for every other supported language.
  return { start: fallbackTitle, back: "", history: "" }
}
