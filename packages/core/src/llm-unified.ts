import { createHash } from "node:crypto"
import { LLMError, LLMEvent, LLMResponse, type LLMRequest, type Usage } from "@arforge-ai/llm"
import * as LLMSchema from "@arforge-ai/schema/llm"
import { Schema } from "effect"

export type RequestInput = {
  readonly request: LLMRequest
  readonly contextPackageDigest: LLMSchema.Unified.Digest | string
  readonly modelProfileRevision: string
  readonly budget: LLMSchema.Unified.RequestBudget
  readonly deadlineAt?: LLMSchema.Unified.Request["deadlineAt"]
}

export type ResponseInput = {
  readonly response: LLMResponse
  readonly providerRequestID?: string
  readonly retry?: LLMSchema.Unified.RetryEvidence
  readonly error?: LLMSchema.Unified.RedactedError
}

const canonicalize = (value: unknown, stack = new WeakSet<object>()): unknown => {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object") return value
  if (value instanceof Uint8Array) return { type: "bytes", value: Array.from(value) }
  if (stack.has(value)) throw new Error("Cannot digest cyclic LLM input")
  stack.add(value)
  if (Array.isArray(value)) {
    const result = value.map((item) => canonicalize(item, stack) ?? null)
    stack.delete(value)
    return result
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).toSorted()) {
    const item = canonicalize((value as Record<string, unknown>)[key], stack)
    if (item !== undefined) result[key] = item
  }
  stack.delete(value)
  return result
}

export const sha256 = (value: unknown): LLMSchema.Unified.Digest => {
  const json = JSON.stringify(canonicalize(value))
  return Schema.decodeUnknownSync(LLMSchema.Unified.Digest)(createHash("sha256").update(json).digest("hex"))
}

const nonNegativeCount = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const usage = (value: Usage): LLMSchema.Unified.Usage => ({
  inputTokens: nonNegativeCount(value.inputTokens),
  outputTokens: nonNegativeCount(value.outputTokens),
  nonCachedInputTokens: nonNegativeCount(value.nonCachedInputTokens),
  cacheReadInputTokens: nonNegativeCount(value.cacheReadInputTokens),
  cacheWriteInputTokens: nonNegativeCount(value.cacheWriteInputTokens),
  reasoningTokens: nonNegativeCount(value.reasoningTokens),
  totalTokens: nonNegativeCount(value.totalTokens),
})

const providerErrorCategory = (reason: LLMError["reason"]): LLMSchema.Unified.ErrorCategory => {
  switch (reason._tag) {
    case "Authentication":
      return "authentication"
    case "ContentPolicy":
      return "content-policy"
    case "InvalidProviderOutput":
      return "invalid-output"
    case "InvalidRequest":
    case "NoRoute":
      return "invalid-request"
    case "ProviderInternal":
      return "provider-internal"
    case "QuotaExceeded":
      return "quota"
    case "RateLimit":
      return "rate-limit"
    case "Transport":
      return "transport"
    case "UnknownProvider":
      return "unknown"
  }
}

const providerErrorStatus = (reason: LLMError["reason"]) =>
  "http" in reason ? reason.http?.response?.status : undefined

/** Convert an LLM error to category-only evidence. Raw messages and bodies are discarded. */
export const redactedError = (error: LLMError): LLMSchema.Unified.RedactedError =>
  LLMSchema.Unified.RedactedError.make({
    category: providerErrorCategory(error.reason),
    retryable: error.retryable,
    status: providerErrorStatus(error.reason),
  })

const fragment = (event: LLMEvent, sequence: number): LLMSchema.Unified.StreamFragment | undefined => {
  switch (event.type) {
    case "text-delta":
      return LLMSchema.Unified.StreamFragment.make({
        sequence,
        kind: "text",
        id: event.id || `text-${sequence}`,
        text: event.text,
      })
    case "reasoning-delta":
      return LLMSchema.Unified.StreamFragment.make({
        sequence,
        kind: "reasoning",
        id: event.id || `reasoning-${sequence}`,
        text: event.text,
      })
    case "tool-input-delta":
      return LLMSchema.Unified.StreamFragment.make({
        sequence,
        kind: "tool-input",
        id: event.id || `tool-${sequence}`,
        text: event.text,
      })
    default:
      return undefined
  }
}

const normalizedToolCalls = (response: LLMResponse): ReadonlyArray<LLMSchema.Unified.ToolCall> =>
  response.toolCalls.map((call, index) =>
    LLMSchema.Unified.ToolCall.make({
      id: call.id || `tool-${index}`,
      name: call.name || `tool-${index}`,
      input: Schema.decodeUnknownSync(Schema.Json)(call.input),
      providerExecuted: call.providerExecuted,
    }),
  )

export const makeRequest = (input: RequestInput): LLMSchema.Unified.Request => {
  const { request } = input
  return LLMSchema.Unified.Request.make({
    version: "v1",
    providerID: String(request.model.provider),
    modelID: String(request.model.id),
    messagesDigest: sha256({ system: request.system, messages: request.messages }),
    contextPackageDigest: Schema.decodeUnknownSync(LLMSchema.Unified.Digest)(input.contextPackageDigest),
    toolSchemaDigest: sha256(request.tools),
    modelProfileRevision: input.modelProfileRevision,
    budget: input.budget,
    deadlineAt: input.deadlineAt,
  })
}

export const makeResponse = (input: ResponseInput): LLMSchema.Unified.Response => {
  const { response } = input
  return LLMSchema.Unified.Response.make({
    version: "v1",
    streamFragments: response.events.flatMap((event, sequence) => {
      const value = fragment(event, sequence)
      return value === undefined ? [] : [value]
    }),
    finishReason: response.finishReason,
    usage: response.usage === undefined ? undefined : usage(response.usage),
    toolCalls: normalizedToolCalls(response),
    providerRequestID: input.providerRequestID,
    retry: input.retry ?? { attempts: 1, retried: false, fallbacks: [] },
    error: input.error,
  })
}

export const makeExchange = (input: RequestInput & ResponseInput): LLMSchema.Unified.Exchange => ({
  request: makeRequest(input),
  response: makeResponse(input),
})

export const LLMUnified = {
  makeExchange,
  makeRequest,
  makeResponse,
  redactedError,
  sha256,
} as const
