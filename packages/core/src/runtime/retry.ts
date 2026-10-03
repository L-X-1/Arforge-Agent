import { LLMError } from "@arforge-ai/llm"

export type FailureCategory =
  | "rate-limit"
  | "server-error"
  | "transport"
  | "auth"
  | "invalid-request"
  | "content-policy"
  | "cancel"
  | "unknown"

export type RetryDecision = {
  readonly action: "retry" | "fallback" | "stop"
  readonly category: FailureCategory
  readonly reason: string
}

export type RetryInput = {
  readonly failure: unknown
  readonly outputStarted: boolean
  readonly toolCallStarted: boolean
  readonly transportRetriesUsed: number
  readonly maxTransportRetries: number
  readonly fallbackAvailable: boolean
}

export const classifyFailure = (failure: unknown): FailureCategory => {
  if (!(failure instanceof LLMError)) return "unknown"
  switch (failure.reason._tag) {
    case "RateLimit":
      return "rate-limit"
    case "ProviderInternal":
      return "server-error"
    case "Transport":
      return "transport"
    case "Authentication":
      return "auth"
    case "InvalidRequest":
      return "invalid-request"
    case "ContentPolicy":
      return "content-policy"
    default:
      return "unknown"
  }
}

const retryableTransportCategories = new Set<FailureCategory>(["rate-limit", "server-error", "transport"])
const fallbackableCategories = new Set<FailureCategory>(["rate-limit", "server-error", "transport", "auth"])

/** Decide retry/fallback without mutating durable history or hiding output boundaries. */
export const decide = (input: RetryInput): RetryDecision => {
  const category = classifyFailure(input.failure)
  if (input.outputStarted || input.toolCallStarted)
    return {
      action: "stop",
      category,
      reason: "visible or executable provider output already started; retry/fallback would duplicate work",
    }
  if (retryableTransportCategories.has(category) && input.transportRetriesUsed < input.maxTransportRetries)
    return {
      action: "retry",
      category,
      reason: `safe ${category} retry before visible output (${input.transportRetriesUsed + 1}/${input.maxTransportRetries})`,
    }
  if (input.fallbackAvailable && fallbackableCategories.has(category))
    return {
      action: "fallback",
      category,
      reason: `fallback is allowed for ${category} before visible output; original failure must be retained`,
    }
  return {
    action: "stop",
    category,
    reason: `stop on ${category}; no safe retry or approved fallback is available`,
  }
}

export const RuntimeRetry = {
  classifyFailure,
  decide,
} as const
