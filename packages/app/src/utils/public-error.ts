/**
 * Extract a useful user-facing message from native Errors and typed API error
 * objects without serializing the entire response (which can leak request
 * metadata or credentials).
 */
export function publicErrorMessage(error: unknown, fallback = "Request failed.") {
  const value = findMessage(error, new Set(), 0)
  return redact(value || fallback).slice(0, 2_000)
}

function findMessage(value: unknown, seen: Set<object>, depth: number): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (value instanceof Error) return value.message.trim() || value.name
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (!value || typeof value !== "object" || depth >= 4 || seen.has(value)) return
  seen.add(value)

  for (const key of ["message", "detail", "reason", "error", "cause"] as const) {
    const result = findMessage(Reflect.get(value, key), seen, depth + 1)
    if (result) return result
  }

  const tag = Reflect.get(value, "_tag")
  if (typeof tag === "string" && tag.trim()) return tag.trim()
}

function redact(value: string) {
  return value
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED_SECRET]")
    .replace(
      /\b(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED_SECRET]",
    )
}
