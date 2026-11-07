import { retry } from "@arforge-ai/core/util/retry"

const transientMessage =
  /load failed|network connection was lost|network request failed|failed to fetch|econnreset|econnrefused|socket hang up|err_network_changed/i

/** Only bootstrap GET callers opt in; never install this on an SDK or mutation. */
export function isTransientBootstrapReadError(error: unknown): boolean {
  let value = error
  let transport = false
  let transient = false
  const seen = new Set<unknown>()
  for (let depth = 0; value && typeof value === "object" && depth < 5; depth++) {
    if (seen.has(value)) return false
    seen.add(value)
    const record = value as Record<string, unknown>
    if (record.name === "AbortError" || record.name === "TimeoutError" || record.code === "ABORT_ERR") return false
    if (record.code === "ETIMEDOUT" || record.code === "ESOCKETTIMEDOUT") return false
    if (value instanceof Error && /\b(?:timeout|timed\s*out|etimedout)\b/i.test(value.message)) return false
    if (record.status !== undefined || record.statusCode !== undefined || typeof record._tag === "string") return false
    if (record.name === "ClientError") {
      if (record.reason !== "Transport") return false
      transport = true
    }
    if (value instanceof Error && transientMessage.test(value.message)) transient = true
    value = record.cause
  }
  return transport || transient
}

export function assertBootstrapReadCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new DOMException("Bootstrap source is no longer current", "AbortError")
}

export function retryBootstrapRead<T>(read: () => Promise<T>, isCurrent: () => boolean): Promise<T> {
  return retry(
    async () => {
      assertBootstrapReadCurrent(isCurrent)
      const value = await read()
      assertBootstrapReadCurrent(isCurrent)
      return value
    },
    {
      attempts: 3,
      delay: 100,
      maxDelay: 200,
      retryIf: (error) => isCurrent() && isTransientBootstrapReadError(error),
    },
  )
}
