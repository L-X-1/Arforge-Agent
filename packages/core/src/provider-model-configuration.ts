export * as ProviderModelConfiguration from "./provider-model-configuration"

import { Schema } from "effect"
import * as ModelPreset from "@arforge-ai/schema/model-preset"
import { ConfigProvider } from "./config/provider"
import { Model } from "@arforge-ai/schema/model"
import { ModelVariantLowerer } from "./model-variant-lowerer"
import { ModelPresets } from "./model-presets"

/** Pure canonical merge, shared by save tests and the real server writer. No V1 metadata lowering. */
export function merge(
  inputs: readonly ModelPreset.ConfigurationInput[],
  previous: Readonly<Record<string, ConfigProvider.Model>>,
  api: { type: string; package?: string; url?: string },
  presets?: ModelPreset.Catalog,
): Record<string, ConfigProvider.Model> {
  const result = { ...previous }
  const seen = new Set<string>()
  for (const raw of inputs) {
    const input = Schema.decodeUnknownSync(ModelPreset.ConfigurationInput)(raw)
    // Never silently rewrite a connection/wire identifier while applying manufacturer metadata.
    if (input.id !== input.id.trim() || !input.name.trim() || seen.has(input.id))
      throw new Error("Model IDs must be nonempty, unpadded and unique.")
    if (["__proto__", "prototype", "constructor"].includes(input.id)) throw new Error("Model ID is reserved.")
    seen.add(input.id)
    const old = Object.hasOwn(previous, input.id) ? previous[input.id] : undefined
    const effectiveApi =
      old?.api && "type" in old.api
        ? {
            ...old.api,
            url: old.api.url ?? ("package" in old.api && old.api.package === api.package ? api.url : undefined),
          }
        : api
    // Merge the encoded side, then decode once. Existing profiles can contain DateTime codecs.
    const encoded = old === undefined ? undefined : Schema.encodeSync(ConfigProvider.Model)(old)
    const model = { ...encoded, name: input.name.trim() }
    const preset =
      old === undefined && input.preset && presets ? ModelPresets.resolve(presets, input.preset) : undefined
    if (preset?.limit) model.limit = { ...preset.limit }
    if (preset?.capabilities && input.capabilities === undefined) model.capabilities = preset.capabilities
    const protocol = ModelVariantLowerer.protocol(effectiveApi)
    if (old === undefined && input.preset && presets && protocol) {
      const limits = ModelPresets.limitsForProtocol(input.preset, presets, protocol)
      if (limits) model.limit = { ...limits }
    }
    if (old === undefined && input.capabilities === undefined && input.preset && presets && protocol) {
      const scoped = ModelPresets.capabilities(input.preset, presets, protocol)
      if (scoped) model.capabilities = scoped
    }
    if (input.disabled !== undefined) model.disabled = input.disabled
    if (input.limit !== undefined) model.limit = { ...model.limit, ...input.limit }
    if (input.capabilities !== undefined) {
      for (const modes of [input.capabilities.input, input.capabilities.output])
        if (modes.length > 16 || modes.some((mode) => !mode.length || mode.length > 100))
          throw new Error("Model capabilities exceed supported bounds.")
      model.capabilities = input.capabilities
    }
    if (input.preset !== undefined) model.preset = input.preset
    if (input.variants !== undefined) {
      const ids = new Set<string>()
      model.variants = input.variants.map((variant) => {
        if (variant.id !== variant.id.trim() || ids.has(variant.id))
          throw new Error("Variant IDs must be unpadded and unique.")
        ids.add(variant.id)
        const existing = old?.variants?.find((item) => item.id === variant.id)
        // Public writes cannot add headers; omission/body roundtrip preserves existing advanced headers.
        if (variant.body !== undefined)
          ModelVariantLowerer.validateBody(variant.body, effectiveApi, old?.api?.id ?? input.id)
        return {
          ...existing,
          id: Model.VariantID.make(variant.id),
          ...(variant.body !== undefined ? { body: variant.body } : {}),
        }
      })
    } else if (old?.variants === undefined && input.preset && presets) {
      const generated = ModelVariantLowerer.lower(input.preset, presets, effectiveApi, old?.api?.id ?? input.id)
      if (generated.length) model.variants = generated
      if (old === undefined && generated.length && input.defaultVariant === undefined) {
        const highest = ModelVariantLowerer.highest(input.preset, presets, effectiveApi, input.id, generated)
        if (highest !== undefined) model.request = { ...model.request, variant: highest }
      }
    }
    if (input.defaultVariant === null) {
      const { variant: _removed, ...request } = model.request ?? {}
      model.request = request
    } else if (input.defaultVariant !== undefined) model.request = { ...model.request, variant: input.defaultVariant }
    const selected = model.request?.variant
    if (
      (input.defaultVariant !== undefined || input.variants !== undefined) &&
      selected !== undefined &&
      !model.variants?.some((variant) => variant.id === selected)
    )
      throw new Error("Default variant must reference an existing executable variant.")
    result[input.id] = Schema.decodeUnknownSync(ConfigProvider.Model)(model)
  }
  return result
}
