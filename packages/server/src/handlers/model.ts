import { Catalog } from "@arforge-ai/core/catalog"
import * as ModelsDev from "@arforge-ai/core/models-dev"
import { ModelPresets } from "@arforge-ai/core/model-presets"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { deepSeekFlashAliases } from "@arforge-ai/core/deepseek-flash"
import { ServiceUnavailableError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    // Location middleware replaces request context; retain the existing global snapshot owner.
    const modelsDev = yield* ModelsDev.Service
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* (ctx) {
          const catalog = yield* Catalog.Service
          const result = yield* response(catalog.model.available())
          const providerID = ProviderV2.ID.make("deepseek")
          const exactAliases = []
          if (result.data.some((model) => model.providerID === providerID)) {
            for (const alias of deepSeekFlashAliases) {
              const model = yield* catalog.model.get(providerID, ModelV2.ID.make(alias))
              if (model?.id === alias && !result.data.some((entry) => entry.providerID === providerID && entry.id === alias))
                exactAliases.push({
                  ...model,
                  api: { ...model.api, url: undefined, settings: {} },
                  request: { variant: model.request.variant, headers: {}, body: {} },
                  variants: model.variants.map((variant) => ({ ...variant, headers: {}, body: {} })),
                })
            }
          }
          const aliases = exactAliases.length ? { exactAliases } : {}
          if (ctx.query.includePresets !== true) return { ...result, ...aliases }
          const snapshot = yield* modelsDev.get()
          const presets = yield* Effect.try({
            try: () => ModelPresets.project(snapshot),
            catch: () =>
              new ServiceUnavailableError({
                message: "Model presets could not be projected.",
                service: "model-presets",
              }),
          })
          return { ...result, ...aliases, presets }
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.model.default().pipe(Effect.map((model) => model ?? null)))
        }),
      )
  }),
)
