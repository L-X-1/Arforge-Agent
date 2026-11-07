import { describe, expect, test } from "bun:test"
import { Catalog } from "@arforge-ai/core/catalog"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Location } from "@arforge-ai/core/location"
import { ModelV2 } from "@arforge-ai/core/model"
import { VariantPlugin } from "@arforge-ai/core/plugin/variant"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Effect, Layer } from "effect"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const it = testEffect(AppNodeBuilder.build(Catalog.node, [[Location.node, locationLayer]]))

test("recognizes the current documented deepseek-flash wire ID without inferring relay aliases", () => {
  const model = {
    id: "custom-display-key",
    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", id: "deepseek-flash" },
  }
  expect(VariantPlugin.generate(model).map((variant) => String(variant.id))).toEqual(["none", "low", "high", "max"])
  expect(VariantPlugin.defaults(model)).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" })
  expect(VariantPlugin.generate({ ...model, api: { ...model.api, id: "relay/private-deepseek-flash" } })).toEqual([])
})

describe("VariantPlugin", () => {
  it.effect("preserves explicit provider reasoning defaults while generating inherited model tiers", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service,
        id = ModelV2.ID.make("provider-defaults")
      yield* service.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.arforge, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", settings: {} }
          provider.request.body = { thinking: { type: "disabled" }, reasoning_effort: "low", owned: true }
        })
        catalog.model.update(ProviderV2.ID.arforge, id, (model) => {
          model.api = { id: ModelV2.ID.make("deepseek-v4-flash"), type: "native", settings: {} }
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))
      const selected = (yield* service.model.get(ProviderV2.ID.arforge, id))!
      expect(selected.variants.map((item) => String(item.id))).toEqual(["none", "low", "high", "max"])
      expect(selected.request.body).toEqual({ thinking: { type: "disabled" }, reasoning_effort: "low", owned: true })
    }),
  )

  it.effect("generates DeepSeek tiers from the effective inherited provider API without changing overrides", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      const inheritedID = ModelV2.ID.make("inherited-deepseek"),
        overrideID = ModelV2.ID.make("explicit-native")
      yield* service.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.arforge, (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "http://127.0.0.1:4096/v1",
            settings: {},
          }
        })
        for (const id of [inheritedID, overrideID])
          catalog.model.update(ProviderV2.ID.arforge, id, (model) => {
            model.api = {
              id: ModelV2.ID.make("deepseek-v4-flash"),
              type: "native",
              settings: id === overrideID ? { owned_override: true } : {},
            }
          })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))
      const inherited = (yield* service.model.get(ProviderV2.ID.arforge, inheritedID))!
      expect(inherited.api).toMatchObject({
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        id: "deepseek-v4-flash",
      })
      expect(inherited.variants.map((variant) => String(variant.id))).toEqual(["none", "low", "high", "max"])
      expect(inherited.request.body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" })
      const overridden = (yield* service.model.get(ProviderV2.ID.arforge, overrideID))!
      expect(overridden.api).toMatchObject({ type: "native", settings: { owned_override: true } })
      expect(overridden.variants).toEqual([])
      expect(overridden.request.body).toEqual({})
    }),
  )

  it.effect("retains the saved DeepSeek default and exposes its low tier without replacing explicit variants", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      const id = ModelV2.ID.make("deepseek-v4-flash")
      yield* service.transform((catalog) => {
        catalog.model.update(ProviderV2.ID.arforge, id, (model) => {
          model.api = { id, type: "aisdk", package: "@ai-sdk/openai-compatible" }
          model.request.variant = "none"
          model.request.body = { thinking: { type: "disabled" }, custom_mode: true }
          model.variants = [{ id: ModelV2.VariantID.make("high"), headers: { custom: "true" }, body: {} }]
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))
      const selected = (yield* service.model.get(ProviderV2.ID.arforge, id))!
      expect(selected.variants.map((variant) => String(variant.id))).toEqual(["none", "low", "high", "max"])
      expect(selected.variants.find((variant) => variant.id === "low")?.body).toEqual({
        thinking: { type: "enabled" },
        reasoning_effort: "low",
      })
      expect(selected.variants.find((variant) => variant.id === "high")).toMatchObject({
        headers: { custom: "true" },
        body: {},
      })
      expect(selected.request.variant).toBe("none")
      expect(selected.request.body).toMatchObject({ thinking: { type: "disabled" }, custom_mode: true })
    }),
  )

  it.effect("adds GLM 5.2 variants after catalog sources", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      yield* service.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.arforge, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible" }
        })
        catalog.model.update(ProviderV2.ID.arforge, ModelV2.ID.make("glm-5.2"), (model) => {
          model.api = {
            id: ModelV2.ID.make("glm-5.2"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
          }
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(ProviderV2.ID.arforge, ModelV2.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", body: { reasoning_effort: "high" } }),
        expect.objectContaining({ id: "max", body: { reasoning_effort: "max" } }),
      ])
    }),
  )

  it.effect("leaves explicitly configured or preset variants and unknown relay names unchanged", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      const ids = ["configured", "preset", "XINJIANGfree/DeepSeek-V4.1-Flash"]
      yield* service.transform((catalog) => {
        for (const id of ids) {
          const modelID = ModelV2.ID.make(id)
          catalog.model.update(ProviderV2.ID.arforge, modelID, (model) => {
            model.name = "DeepSeek V4.1 Flash"
            model.api = {
              id: ModelV2.ID.make(id.startsWith("XINJIANG") ? id : "deepseek-v4-flash"),
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
            }
            model.request.body = { custom_mode: true }
            model.request.variant = "auto"
            if (id === "preset")
              model.preset = { origin: { vendorID: "deepseek", modelID: "deepseek-flash" }, revision: "owned" }
          })
          if (id === "configured") catalog.model.configureVariants(ProviderV2.ID.arforge, modelID)
        }
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))
      for (const id of ids) {
        const selected = (yield* service.model.get(ProviderV2.ID.arforge, ModelV2.ID.make(id)))!
        expect(selected.variants).toEqual([])
        expect(selected.request).toMatchObject({ variant: "auto", body: { custom_mode: true } })
      }
    }),
  )

  it.effect("keeps explicit variants over generated defaults", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      yield* service.transform((catalog) => {
        catalog.model.update(ProviderV2.ID.arforge, ModelV2.ID.make("glm-5.2"), (model) => {
          model.api = {
            id: ModelV2.ID.make("glm-5.2"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
          }
          model.variants = [{ id: ModelV2.VariantID.make("high"), headers: { custom: "true" }, body: {} }]
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(ProviderV2.ID.arforge, ModelV2.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", headers: { custom: "true" } }),
        expect.objectContaining({ id: "max", body: { reasoning_effort: "max" } }),
      ])
    }),
  )
})
