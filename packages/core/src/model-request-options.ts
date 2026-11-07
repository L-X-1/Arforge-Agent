export * as ModelRequestOptions from "./model-request-options"

import { Schema } from "effect"
import { GenerationOptions, ReasoningOptions, ReasoningEffort } from "@arforge-ai/llm"
import { OutputBudget } from "@arforge-ai/llm/route"

type Api = { type: string; package?: string; url?: string }
export function protocol(api: Api): "openai-chat" | "openai-responses" | "anthropic-messages" | undefined {
  if (api.type !== "aisdk") return undefined
  if (api.package === "@ai-sdk/openai") return "openai-responses"
  if (api.package === "@ai-sdk/anthropic") return "anthropic-messages"
  if (api.package === "@ai-sdk/openai-compatible" && api.url) return "openai-chat"
  return undefined
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** One lowering owner for saved canonical body -> typed LLM controls, shared by validation and runner. */
export function split(body: Readonly<Record<string, Schema.Json>>, api: Api) {
  const httpBody = { ...body }
  const selected = protocol(api)
  const reasoning: Record<string, unknown> = {}
  let maxTokens: number | undefined
  let temperature: number | undefined
  // Existing local configuration can carry sampling controls. Lower them into
  // the canonical generation owner instead of an HTTP protocol-field overlay.
  if (Object.hasOwn(httpBody, "temperature")) {
    const value = httpBody.temperature
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid temperature.")
    temperature = value
    delete httpBody.temperature
  }
  if (
    selected === "openai-chat" &&
    Object.hasOwn(httpBody, "reasoning_effort") &&
    Schema.is(ReasoningEffort)(httpBody.reasoning_effort)
  ) {
    reasoning.effort = httpBody.reasoning_effort
    delete httpBody.reasoning_effort
  }
  if (["openai-chat", "anthropic-messages"].includes(selected ?? "") && Object.hasOwn(httpBody, "thinking")) {
    const thinking = httpBody.thinking
    if (
      !record(thinking) ||
      !Object.hasOwn(thinking, "type") ||
      Object.keys(thinking).some((key) => !["type", "budget_tokens", "budgetTokens"].includes(key))
    )
      throw new Error("Unsupported thinking parameters.")
    reasoning.mode = thinking.type
    if (thinking.budget_tokens !== undefined || thinking.budgetTokens !== undefined)
      reasoning.budgetTokens = thinking.budget_tokens ?? thinking.budgetTokens
    delete httpBody.thinking
  }
  const container =
    selected === "openai-responses" ? "reasoning" : selected === "anthropic-messages" ? "output_config" : undefined
  if (container && Object.hasOwn(httpBody, container)) {
    const value = httpBody[container]
    if (!record(value)) throw new Error("Unsupported reasoning parameters.")
    if (value.effort !== undefined) {
      reasoning.effort = value.effort
      const { effort: _, ...rest } = value
      if (Object.keys(rest).length) httpBody[container] = rest as Record<string, Schema.Json>
      else delete httpBody[container]
    }
  }
  // Existing advanced budget fields acquire no independent authority. The final LLM budget still wins.
  for (const key of Object.keys(httpBody))
    if (OutputBudget.isBodyKey(key)) {
      const value = httpBody[key]
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid output limit.")
      maxTokens = maxTokens === undefined ? value : Math.min(maxTokens, value)
      delete httpBody[key]
    }
  const typed = Object.keys(reasoning).length ? Schema.decodeUnknownSync(ReasoningOptions)(reasoning) : undefined
  return {
    httpBody,
    generation:
      typed !== undefined || maxTokens !== undefined || temperature !== undefined
        ? GenerationOptions.make({ reasoning: typed, maxTokens, temperature })
        : undefined,
  }
}
