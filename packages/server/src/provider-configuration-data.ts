import { Schema } from "effect"
import { ConfigProvider } from "@arforge-ai/core/config/provider"
import { ProviderModelConfiguration } from "@arforge-ai/core/provider-model-configuration"
import { ModelRequestOptions } from "@arforge-ai/core/model-request-options"
import { ModelV2 } from "@arforge-ai/core/model"
import type * as ModelPreset from "@arforge-ai/schema/model-preset"
import { ProviderConfigurationInput } from "@arforge-ai/protocol/groups/provider"

export type ProviderConfig = typeof ConfigProvider.Info.Type
export const packages = {
  "openai-chat": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
  "anthropic-messages": "@ai-sdk/anthropic",
} as const
export function apiFormat(api?: { type: string; package?: string; url?: string }) {
  return api ? ModelRequestOptions.protocol(api) : undefined
}
export const managed = (provider?: ProviderConfig): provider is ProviderConfig => {
  const api = provider?.api
  return api?.type === "aisdk" && Object.values(packages).some((value) => value === api.package)
}
export function safeURL(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => /key|token|secret|credential|authorization|signature/i.test(key))
    )
      return undefined
    return value
  } catch {
    return undefined
  }
}
const validID = (id: string) =>
  id.length > 0 && id === id.trim() && !["__proto__", "prototype", "constructor"].includes(id)

/** Pure canonical edit. No credentials, availability or manufacturer-based adapter selection. */
export function edit(
  input: typeof ProviderConfigurationInput.Type,
  previous?: ProviderConfig,
  presets?: ModelPreset.Catalog,
): ProviderConfig {
  if (previous && !managed(previous)) throw new Error("Unsupported provider adapter is read-only.")
  const baseURL = input.baseURL ?? previous?.api?.url
  if (!baseURL && !previous) throw new Error("New provider requires a valid explicit URL.")
  if (baseURL) {
    const url = new URL(baseURL)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Invalid provider URL.")
  }
  const removed = input.deletedModelIDs ?? []
  if (removed.length && (!previous || !input.revision))
    throw new Error("Deletion requires the saved provider revision.")
  const ids = new Set<string>()
  for (const id of removed) {
    if (
      !validID(id) ||
      ids.has(id) ||
      !Object.hasOwn(previous?.models ?? {}, id) ||
      input.models.some((model) => model.id === id)
    )
      throw new Error("Deleted model IDs must be existing, unique and separate from edited models.")
    ids.add(id)
  }
  const packageName = input.apiFormat
    ? packages[input.apiFormat]
    : previous?.api?.type === "aisdk"
      ? previous.api.package
      : packages["openai-chat"]
  const api = {
    ...previous?.api,
    type: "aisdk" as const,
    package: packageName,
    url: baseURL,
    settings: previous?.api?.settings ?? {},
  }
  const models = ProviderModelConfiguration.merge(input.models, previous?.models ?? {}, api, presets)
  for (const id of removed) delete models[id]
  const excluded=new Set(previous?.excludedModels ?? [])
  for(const id of removed)excluded.add(ModelV2.ID.make(id))
  for(const model of input.models)excluded.delete(ModelV2.ID.make(model.id))
  // Blank-key legacy clients used to derive optional from an empty field. Preserve an existing requirement.
  const env = input.env === undefined ? previous?.env : [input.env]
  const authentication =
    previous?.authentication === "required" || !!env?.length
      ? "required"
      : (input.authentication ?? previous?.authentication ?? "optional")
  return ConfigProvider.Info.make({
    ...previous,
    name: input.name.trim(),
    api,
    models,
    ...(previous?.excludedModels!==undefined||removed.length ? {excludedModels:[...excluded]} : {}),
    authentication,
    disabled: input.disabled ?? previous?.disabled,
    env,
  })
}

export function safeLimits(limit?: ConfigProvider.Model["limit"]): ModelPreset.Limits | undefined {
  if (!limit) return undefined
  const valid = (value?: number) => value !== undefined && Number.isSafeInteger(value) && value > 0
  const result = {
    ...(valid(limit.context) ? { context: limit.context } : {}),
    ...(valid(limit.input) ? { input: limit.input } : {}),
    ...(valid(limit.output) ? { output: limit.output } : {}),
  }
  return Object.keys(result).length ? result : undefined
}

export const encodeProvider = (provider: ProviderConfig) => Schema.encodeSync(ConfigProvider.Info)(provider)
