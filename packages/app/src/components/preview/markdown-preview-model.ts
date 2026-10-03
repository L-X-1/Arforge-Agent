export const MARKDOWN_PREVIEW_MAX_CHARACTERS = 500_000

export function markdownPreviewLink(value: string): string | undefined {
  if (/[\u0000-\u001f\u007f]/.test(value)) return
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return
    if (url.username || url.password) return
    return url.href
  } catch {
    return
  }
}
