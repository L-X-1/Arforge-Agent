export * as OutputBudget from "./output-budget"

import { GenerationOptions, LLMRequest, mergeGenerationOptions } from "../schema"

/** Protocol-owned generation fields. Public body extensions never acquire budget authority. */
export const BodyKeys = [
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "maxTokens",
  "maxOutputTokens",
  "maxCompletionTokens",
  "max_new_tokens",
  "maxNewTokens",
  "maxTokenCount",
] as const
export const isBodyKey = (key: string) => (BodyKeys as readonly string[]).includes(key)
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
export function limit(request: LLMRequest): number | undefined {
  const values = [
    request.generation?.maxTokens,
    request.model.defaults?.limits?.output ?? request.model.route.defaults.limits?.output,
  ]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map(Math.floor)
  return values.length ? Math.min(...values) : undefined
}
export function clampRequest(request: LLMRequest): LLMRequest {
  const maximum = limit(request)
  if (maximum === undefined || request.generation?.maxTokens === maximum) return request
  return LLMRequest.update(request, {
    generation: mergeGenerationOptions(request.generation, GenerationOptions.make({ maxTokens: maximum })),
  })
}

/** Final JSON boundary, after provider/variant/request body merges. Preserve unrelated extensions. */
export function clampBody(body: unknown, request: LLMRequest): unknown {
  const maximum = limit(request)
  if (maximum === undefined || !record(body)) return body
  const result = { ...body }
  for (const key of BodyKeys) if (Object.hasOwn(result, key)) result[key] = maximum
  const protocol = request.model.route.protocol
  const primary =
    protocol === "openai-responses"
      ? "max_output_tokens"
      : ["openai-chat", "anthropic-messages"].includes(protocol)
        ? "max_tokens"
        : undefined
  if (primary) result[primary] = maximum
  for (const [container, key] of [
    ["generationConfig", "maxOutputTokens"],
    ["generation_config", "max_output_tokens"],
    ["inferenceConfig", "maxTokens"],
    ["inference_config", "max_tokens"],
  ]) {
    const value = result[container]
    if (record(value)) {
      const nested = { ...value }
      for (const alias of BodyKeys) if (Object.hasOwn(nested, alias)) nested[alias] = maximum
      if (Object.hasOwn(value, key) || protocol === "gemini" || protocol === "bedrock-converse") nested[key] = maximum
      result[container] = nested
    }
  }
  return result
}
