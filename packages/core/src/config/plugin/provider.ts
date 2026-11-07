export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/definition"
import { Effect } from "effect"
import { Config } from "../../config"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { Catalog } from "../../catalog"
import { Integration } from "../../integration"
import { providerCredentialTarget } from "../../provider-credential-target"
import { ModelRequestOptions } from "../../model-request-options"

export const Plugin = define({
  id: "config-provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    // Target binding is private owner state, never a public plugin/catalog field.
    yield* (yield* Integration.Service).transform(
      Effect.fn(function* (draft) {
        for (const entry of yield* config.entries()) {
          if (entry.type !== "document") continue
          for (const [id, provider] of Object.entries(entry.info.providers ?? {}))
            if (provider.api)
              draft.credentialTarget(Integration.ID.make(id), providerCredentialTarget(id, provider.api))
        }
      }),
    )
    // Internal availability provenance stays outside the public plugin/catalog DTO.
    yield* (yield* Catalog.Service).transform(
      Effect.fn(function* (draft) {
        for (const entry of yield* config.entries()) {
          if (entry.type !== "document") continue
          for (const [id, provider] of Object.entries(entry.info.providers ?? {})) {
            for (const [modelID, model] of Object.entries(provider.models ?? {}))
              if (model.variants !== undefined)
                draft.model.configureVariants(ProviderV2.ID.make(id), ModelV2.ID.make(modelID))
            if (provider.authentication !== undefined)
              draft.provider.optionalAuthentication(
                ProviderV2.ID.make(id),
                provider.authentication === "optional" &&
                  provider.api !== undefined &&
                  ModelRequestOptions.protocol(provider.api) !== undefined &&
                  !provider.env?.length,
              )
          }
        }
      }),
    )
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        const configuredIntegrations = new Set(
          files.flatMap((file) =>
            Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
              provider.env === undefined && provider.authentication === undefined ? [] : [id],
            ),
          ),
        )
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const integrationID = id
            if (!configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
            integrations.update(integrationID, (integration) => {
              integration.name = item.name ?? integration.name
            })
            if (item.authentication !== undefined) {
              integrations.method.update({ integrationID, method: { type: "key" } })
            }
            if (item.env !== undefined) {
              integrations.method.update({
                integrationID,
                method: { type: "env", names: [...item.env] },
              })
            }
          }
        }
      }),
    )

    yield* (yield* Catalog.Service).transform(
      Effect.fn(function* (catalog) {
        const entries = yield* config.entries()
        const files = entries.filter((entry): entry is Config.Document => entry.type === "document")
        const configuredDefault = Config.latest(entries, "model")
        if (configuredDefault !== undefined) {
          const model = ModelV2.parse(configuredDefault)
          catalog.model.default.set(model.providerID, model.modelID)
        }
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const providerID = ProviderV2.ID.make(id)
            catalog.provider.update(providerID, (provider) => {
              if (item.name !== undefined) provider.name = item.name
              if (item.disabled !== undefined) provider.disabled = item.disabled
              if (item.api !== undefined) provider.api = { ...item.api }
              if (item.request !== undefined) {
                Object.assign(provider.request.headers, item.request.headers)
                Object.assign(provider.request.body, item.request.body)
              }
            })
            for (const [id, config] of Object.entries(item.models ?? {})) {
              catalog.model.update(providerID, ModelV2.ID.make(id), (model) => {
                if (config.family !== undefined) model.family = config.family
                if (config.name !== undefined) model.name = config.name
                if (config.preset !== undefined) model.preset = config.preset
                if (config.api !== undefined) model.api = { ...model.api, ...config.api }
                if (config.profile !== undefined) {
                  model.profile = config.profile
                }
                if (config.capabilities !== undefined) {
                  model.capabilities = {
                    tools: config.capabilities.tools,
                    input: [...config.capabilities.input],
                    output: [...config.capabilities.output],
                  }
                }
                if (config.request !== undefined) {
                  Object.assign(model.request.headers, config.request.headers)
                  Object.assign(model.request.body, config.request.body)
                  if (config.request.variant !== undefined) model.request.variant = config.request.variant
                }
                if (config.variants !== undefined) {
                  if (config.variants.length === 0) model.variants = []
                  for (const variant of config.variants) {
                    let existing = model.variants.find((item) => item.id === variant.id)
                    if (!existing) {
                      existing = {
                        id: variant.id,
                        headers: {},
                        body: {},
                      }
                      model.variants.push(existing)
                    }
                    Object.assign(existing.headers, variant.headers)
                    Object.assign(existing.body, variant.body)
                  }
                }
                if (config.cost !== undefined) {
                  model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                    ...(cost.tier !== undefined ? { tier: { ...cost.tier } } : {}),
                    input: cost.input,
                    output: cost.output,
                    cache: {
                      read: cost.cache?.read ?? 0,
                      write: cost.cache?.write ?? 0,
                    },
                  }))
                }
                if (config.priceCatalog !== undefined) Object.assign(model, { priceCatalog: config.priceCatalog })
                if (config.disabled !== undefined) model.enabled = !config.disabled
                if (config.limit !== undefined) {
                  const limit = { ...model.limit }
                  if (config.limit.context !== undefined) limit.context = config.limit.context
                  if (config.limit.input !== undefined) limit.input = config.limit.input
                  if (config.limit.output !== undefined) limit.output = config.limit.output
                  model.limit = limit
                }
              })
            }
            for(const modelID of item.excludedModels ?? []) {
              if(catalog.model.get(providerID,modelID))
                catalog.model.update(providerID,modelID,model=>{model.enabled=false})
            }
          }
        }
      }),
    )
  }),
})
