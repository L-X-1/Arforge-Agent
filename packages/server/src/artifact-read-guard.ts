import { ARTIFACT_READ_BYTES_PER_MINUTE } from "@arforge-ai/core/tenant-platform"

export const ARTIFACT_READ_WINDOW_MS = 60_000
export const ARTIFACT_READ_MAX_REQUESTS = 32
export const ARTIFACT_READ_MAX_BYTES = ARTIFACT_READ_BYTES_PER_MINUTE

type RateBucket = {
  windowStartedAt: number
  requests: number
  bytes: number
}

const rateBuckets = new Map<string, RateBucket>()

/**
 * A deliberately conservative process-local second guard. The durable tenant
 * rate window now owns the cross-instance request/byte budget; this layer
 * additionally bounds one logical scope's burst on a single server instance.
 */
export function admitArtifactRead(input: {
  readonly tenantID: string
  readonly userID: string
  /** Session ID for the legacy route; scopeID is used by profile/tenant reads. */
  readonly sessionID?: string
  readonly scopeID?: string
  readonly bytes: number
  readonly now?: number
}): { readonly allowed: boolean; readonly retryAfterSeconds: number } {
  const now = input.now ?? Date.now()
  const scopeID = input.scopeID ?? input.sessionID
  if (scopeID === undefined || scopeID.trim() === "")
    return { allowed: false, retryAfterSeconds: Math.ceil(ARTIFACT_READ_WINDOW_MS / 1_000) }
  const key = `${input.tenantID}:${input.userID}:${scopeID}`
  const current = rateBuckets.get(key)
  const bucket =
    current === undefined || now - current.windowStartedAt >= ARTIFACT_READ_WINDOW_MS
      ? { windowStartedAt: now, requests: 0, bytes: 0 }
      : current
  if (
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    bucket.requests >= ARTIFACT_READ_MAX_REQUESTS ||
    bucket.bytes + input.bytes > ARTIFACT_READ_MAX_BYTES
  ) {
    rateBuckets.set(key, bucket)
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartedAt + ARTIFACT_READ_WINDOW_MS - now) / 1000)),
    }
  }
  bucket.requests += 1
  bucket.bytes += input.bytes
  rateBuckets.set(key, bucket)
  // Keep a bounded map even when a server receives many short-lived session IDs.
  if (rateBuckets.size > 2_048) {
    const oldest = rateBuckets.keys().next().value
    if (oldest !== undefined) rateBuckets.delete(oldest)
  }
  return { allowed: true, retryAfterSeconds: 0 }
}
