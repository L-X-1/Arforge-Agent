export * as ModelVariantLowerer from "./model-variant-lowerer"

import { Effect, Schema } from "effect"
import * as ModelPreset from "@arforge-ai/schema/model-preset"
import { Model } from "@arforge-ai/schema/model"
import { ModelPresets } from "./model-presets"
import { LLM } from "@arforge-ai/llm"
import { LLMClient, OutputBudget } from "@arforge-ai/llm/route"
import * as OpenAICompatibleChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@arforge-ai/llm/protocols/openai-responses"
import * as AnthropicMessages from "@arforge-ai/llm/protocols/anthropic-messages"
import { ModelRequestOptions } from "./model-request-options"

type Api = { type: string; package?: string; url?: string }
export const protocol = ModelRequestOptions.protocol

export function highest(
  reference: ModelPreset.Reference,
  catalog: ModelPreset.Catalog,
  api: Api,
  wireID: string,
  executable: readonly { id: string }[],
): string | undefined {
  const recipes = ModelPresets.recipes(reference, catalog).filter(
    (recipe) => recipe.protocol === protocol(api) && recipe.wireIDs.includes(wireID),
  )
  if (recipes.length !== 1) return undefined
  return recipes[0].strengthOrder?.findLast((id) => executable.some((variant) => variant.id === id))
}

function serializes(body: Readonly<Record<string, Schema.Json>>, api: Api, wireID: string): boolean {
  const selected = protocol(api)
  if (!selected) return false
  const base =
    selected === "openai-chat"
      ? OpenAICompatibleChat.route
      : selected === "openai-responses"
        ? OpenAIResponses.route
        : AnthropicMessages.route
  const options = ModelRequestOptions.split(body, api)
  const route = base.with({ provider: "preset-serialization", ...(api.url ? { endpoint: { baseURL: api.url } } : {}) })
  const prepared = Effect.runSync(
    Effect.result(
      LLMClient.prepare(
        LLM.request({
          model: route.model({ id: wireID }),
          prompt: "Validate protocol serialization.",
          generation: options.generation,
          http: { body: options.httpBody },
        }),
      ),
    ),
  )
  return prepared._tag === "Success"
}

/** Executable configuration is private to Core, never part of the public preset DTO. */
export function lower(reference: ModelPreset.Reference, catalog: ModelPreset.Catalog, api: Api, wireID: string) {
  const selected = protocol(api)
  if (!selected) return []
  const recipes = ModelPresets.recipes(reference, catalog).filter(
    (recipe) => recipe.protocol === selected && recipe.wireIDs.includes(wireID),
  )
  if (recipes.length !== 1) return []
  // Preparing a request performs no IO. Use the real serializer as the compatibility owner,
  // rather than copying its protected-field rules or advertising bodies it rejects.
  return recipes[0].variants
    .filter((variant) => {
      try {
        return serializes(variant.body, api, wireID)
      } catch {
        return false
      }
    })
    .map((variant) => ({
      id: Model.VariantID.make(variant.id),
      body: structuredClone(variant.body),
    }))
}

const forbidden = new Set([
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "password",
  "secret",
  "accesstoken",
  "refreshtoken",
  "token",
  "endpoint",
  "baseurl",
  "url",
  "headers",
  "env",
  "model",
  "modelid",
  "providerid",
  "messages",
  "input",
  "__proto__",
  "prototype",
  "constructor",
])
/** Bounded public JSON writes cannot become a second credential/routing store. */
export function validateBody(body: Readonly<Record<string, Schema.Json>>, api: Api, wireID: string): void {
  if (Buffer.byteLength(JSON.stringify(body)) > 32768) throw new Error("Variant body exceeds the supported size.")
  let nodes = 0
  const visit = (value: Schema.Json, depth: number): void => {
    if (++nodes > 4096 || depth > 12) throw new Error("Variant body is too complex.")
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Variant values must be finite.")
    if (!value || typeof value !== "object") return
    for (const [key, item] of Object.entries(value)) {
      if (
        forbidden.has(key.replace(/[-_]/g, "").toLowerCase()) ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        throw new Error("Variant body contains a protected field.")
      visit(item, depth + 1)
    }
  }
  visit(body, 0)
  // Sampling remains outside the new public reasoning-variant write surface;
  // legacy local configuration is lowered separately by ModelRequestOptions.
  if (Object.hasOwn(body, "temperature")) throw new Error("Variant body cannot own sampling controls.")
  if (Object.keys(body).some(OutputBudget.isBodyKey)) throw new Error("Variant body cannot own output budgets.")
  const selected = protocol(api)
  if (body.reasoning !== undefined && selected !== "openai-responses")
    throw new Error("Reasoning body is incompatible with this protocol.")
  if ((body.reasoning_effort !== undefined || body.enable_thinking !== undefined) && selected !== "openai-chat")
    throw new Error("Chat reasoning parameters are incompatible with this protocol.")
  if (body.output_config !== undefined && selected !== "anthropic-messages")
    throw new Error("Output config is incompatible with this protocol.")
  if (body.thinking !== undefined && !["openai-chat", "anthropic-messages"].includes(selected ?? ""))
    throw new Error("Thinking parameters are incompatible with this protocol.")
  const effort = body.reasoning_effort
  if (
    effort !== undefined &&
    (typeof effort !== "string" || !effort.length || effort.length > 200 || ["default", "auto"].includes(effort))
  )
    throw new Error("Reasoning effort must be an explicit wire value.")
  if (body.enable_thinking !== undefined && typeof body.enable_thinking !== "boolean")
    throw new Error("Thinking toggle must be boolean.")
  for (const key of ["reasoning", "thinking", "output_config"]) {
    const value = body[key]
    if (value !== undefined && (value === null || Array.isArray(value) || typeof value !== "object"))
      throw new Error("Reasoning parameters must be objects.")
  }
  if (!serializes(body, api, wireID)) throw new Error("Variant body is unsupported by this protocol.")
}
