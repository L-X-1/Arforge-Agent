import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Catalog } from "@arforge-ai/core/catalog"
import { Config } from "@arforge-ai/core/config"
import { Billing } from "@arforge-ai/schema/billing"
import { ConfigProviderPlugin } from "@arforge-ai/core/config/plugin/provider"
import { Integration } from "@arforge-ai/core/integration"
import { ModelV2 } from "@arforge-ai/core/model"
import { PluginV2 } from "@arforge-ai/core/plugin"
import { PluginHost } from "@arforge-ai/core/plugin/host"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

function request(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigProviderPlugin.Plugin", () => {
  it.effect("preserves the canonical price catalog through the existing JSON plugin boundary", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const price = Billing.PriceCatalog.make({
        revision: "configured-price-v1",
        currency: "USD",
        minorUnit: 6,
        unit: "token",
        effectiveFrom: DateTime.makeUnsafe(0),
        source: "fixture:configured-price",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 2 } },
      })
      yield* addPlugin(
        Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    "priced-provider": {
                      models: {
                        "priced-model": {
                          priceCatalog: Schema.encodeSync(Billing.PriceCatalog)(price),
                        },
                      },
                    },
                  },
                }),
              }),
            ]),
        }),
      )
      const model = required(
        yield* catalog.model.get(ProviderV2.ID.make("priced-provider"), ModelV2.ID.make("priced-model")),
      )
      expect(model.priceCatalog).toEqual(price)
    }),
  )

  it.effect("projects a configured model profile through the JSON plugin boundary", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("profile-provider")
      const modelID = ModelV2.ID.make("profile-model")
      const observedAt = DateTime.makeUnsafe("2026-08-12T00:00:00.000Z")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  "profile-provider": {
                    models: {
                      "profile-model": {
                        profile: {
                          version: "v1",
                          providerID: "profile-provider",
                          modelID: "profile-model",
                          modality: { input: ["text"], output: ["text"] },
                          limits: { context: 16_000, output: 2_000 },
                          capabilities: {
                            tools: "supported",
                            structured: "native",
                            reasoning: "unknown",
                            cache: "provider_defined",
                          },
                          tokenizer: "provider:tokenizer-v1",
                          estimator: "provider:estimator-v1",
                          priceCatalogRevision: "catalog-2026-08-12",
                          observations: [
                            {
                              kind: "capability",
                              status: "pass",
                              source: "recorded",
                              sourceID: "fixture:profile",
                              observedAt: DateTime.toEpochMillis(observedAt),
                              value: { capability: "tools" },
                            },
                          ],
                          policy: {
                            region: { mode: "provider_default", regions: [] },
                            egress: { mode: "provider", origins: [] },
                            data: { retention: "provider_defined", training: "provider_defined" },
                          },
                        },
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.profile?.providerID).toBe(providerID)
      expect(model.profile?.modelID).toBe(modelID)
      expect(model.profile?.limits).toEqual({ context: 16_000, input: undefined, output: 2_000 })
      expect(model.profile?.capabilities.tools).toBe("supported")
      expect(model.profile?.policy.egress.mode).toBe("provider")
      expect(model.profile?.observations[0]?.observedAt).toEqual(observedAt)
    }),
  )

  it.effect("keeps configured model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.arforge
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  arforge: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://arforge.test/v1" },
                    models: {
                      "alpha-gpt-next": {
                        variants: [
                          {
                            id: "high",
                            body: {
                              reasoningEffort: "high",
                              reasoningSummary: "auto",
                              include: ["reasoning.encrypted_content"],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants).toMatchObject([
        {
          id: "high",
          body: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ])
    }),
  )

  it.effect("keeps layered model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.arforge
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  arforge: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://arforge.test/v1" },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  arforge: {
                    models: {
                      "alpha-gpt-next": {
                        variants: [{ id: "high", body: { reasoningEffort: "high" } }],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants[0]).toMatchObject({
        id: "high",
        body: { reasoningEffort: "high" },
      })
    }),
  )

  it.effect("loads configured providers and applies later model overrides", () =>
    withEnv({ CUSTOM_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const providerID = ProviderV2.ID.make("custom")
        const modelID = ModelV2.ID.make("chat")
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/first",
                  providers: {
                    custom: {
                      name: "Configured",
                      env: ["CUSTOM_API_KEY"],
                      api: { type: "native", settings: {} },
                      request: request({ first: "first", shared: "first" }),
                      models: {
                        chat: {
                          name: "First",
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          disabled: true,
                          limit: { context: 100, output: 50 },
                          cost: { input: 1, output: 2 },
                          request: request({ first: "first", shared: "first" }, "retained"),
                          variants: [
                            {
                              id: "fast",
                              headers: { first: "first", shared: "first" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/default",
                  providers: {
                    custom: {
                      api: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                      request: request({ last: "last", shared: "last" }),
                      models: {
                        default: {
                          name: "Default",
                        },
                        chat: {
                          api: { id: "api-chat" },
                          name: "Last",
                          limit: { output: 75 },
                          request: request({ last: "last", shared: "last" }),
                          variants: [
                            {
                              id: "fast",
                              headers: { last: "last", shared: "last" },
                            },
                            {
                              id: "slow",
                              headers: { slow: "slow" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    custom: { name: "Renamed" },
                  },
                }),
              }),
            ]),
        })

        yield* addPlugin(config)

        const provider = required(yield* catalog.provider.get(providerID))
        const model = required(yield* catalog.model.get(providerID, modelID))
        expect((yield* catalog.model.default())?.id).toBe(ModelV2.ID.make("default"))
        expect(provider.name).toBe("Renamed")
        expect((yield* integrations.get(Integration.ID.make("custom")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* integrations.get(Integration.ID.make("custom")))?.name).toBe("Renamed")
        expect(provider.disabled).toBeUndefined()
        expect(provider.api).toEqual({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
        expect(provider.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.api.id).toBe(ModelV2.ID.make("api-chat"))
        expect(model.name).toBe("Last")
        expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
        expect(model.enabled).toBe(false)
        expect(model.limit).toEqual({ context: 100, output: 75 })
        expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 }, tier: undefined }])
        expect(model.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.request.variant).toBe("retained")
        expect(model.variants.map((variant) => variant.id)).toEqual([
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
      }),
    ),
  )
})
