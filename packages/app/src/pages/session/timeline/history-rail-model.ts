export type HistoryMessage = {
  id: string
  role: string
  time?: { created: number }
}

export type HistoryPart = {
  type: string
  text?: string
  filename?: string
  synthetic?: boolean
  ignored?: boolean
}

export type HistoryEntry = {
  id: string
  text: string
  created?: number
}

export function historyExcerpt(text: string, limit = 240) {
  const value = text.replace(/\s+/g, " ").trim()
  return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)) + "\u2026"
}

/** Index only human prompts. Tool output and injected context are not turns. */
export function historyEntries(
  messages: readonly HistoryMessage[],
  parts: (id: string) => readonly HistoryPart[],
): HistoryEntry[] {
  const seen = new Set<string>()
  const result: HistoryEntry[] = []
  for (const message of messages) {
    if (message.role !== "user" || seen.has(message.id)) continue
    seen.add(message.id)
    const content = parts(message.id)
    const text = content
      .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
    const attachments = content
      .filter((part) => part.type === "file")
      .map((part) => part.filename || "[attachment]")
      .join(", ")
    if (!text && !attachments) continue
    result.push({ id: message.id, text: text || attachments, created: message.time?.created })
  }
  return result
}

/** Bound mounted markers even when a conversation contains thousands of turns. */
export function historyWindow(total: number, focus: number, capacity = 28) {
  const count = Math.max(1, Math.floor(capacity))
  const length = Math.max(0, Math.floor(total))
  const index = Math.max(0, Math.min(length - 1, focus))
  const start = Math.max(0, Math.min(length - count, index - Math.floor(count / 2)))
  return { start, end: Math.min(length, start + count) }
}

export function historyDestination(key: string, current: number, count: number, pageSize = 28) {
  if (count <= 0) return undefined
  const destination =
    key === "ArrowUp" ? current - 1 :
    key === "ArrowDown" ? current + 1 :
    key === "Home" ? 0 :
    key === "End" ? count - 1 :
    key === "PageUp" ? current - pageSize :
    key === "PageDown" ? current + pageSize :
    undefined
  return destination === undefined ? undefined : Math.max(0, Math.min(count - 1, destination))
}
