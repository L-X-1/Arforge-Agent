import { isServiceUnavailableError, isUnauthorizedError } from "@arforge-ai/client/promise"

export type ModelCatalogFailure = "auth" | "limit" | "unavailable" | "temporary" | "unknown"

/** Classify transport metadata only; never expose a provider body/header object. */
export function classifyModelCatalogError(error: unknown): ModelCatalogFailure {
  const seen = new Set<object>()
  const status = (value: unknown, depth: number): number | undefined => {
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return
    seen.add(value)
    for (const key of ["status", "statusCode"]) {
      const code = Reflect.get(value, key)
      if (typeof code === "number" && code >= 400 && code <= 599) return code
      if (typeof code === "string" && /^[45]\d{2}$/.test(code)) return Number(code)
    }
    // Declared catalog errors are decoded by the client without the HTTP status.
    if (isUnauthorizedError(value)) return 401
    if (isServiceUnavailableError(value)) return 503
    for (const key of ["cause", "error", "response", "data"]) {
      const code = status(Reflect.get(value, key), depth + 1)
      if (code !== undefined) return code
    }
    return
  }
  const code = status(error, 0)
  if (code === 401 || code === 403) return "auth"
  if (code === 402 || code === 429) return "limit"
  if (code === 404 || code === 410) return "unavailable"
  if (code === 408 || code === 425 || (code !== undefined && code >= 500)) return "temporary"
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return "temporary"
  return "unknown"
}
