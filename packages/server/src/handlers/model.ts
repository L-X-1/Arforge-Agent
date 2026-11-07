import { Catalog } from "@arforge-ai/core/catalog"
import * as ModelsDev from "@arforge-ai/core/models-dev"
import { ModelPresets } from "@arforge-ai/core/model-presets"
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
          if (ctx.query.includePresets !== true) return result
          const snapshot = yield* modelsDev.get()
          const presets = yield* Effect.try({
            try: () => ModelPresets.project(snapshot),
            catch: () =>
              new ServiceUnavailableError({
                message: "Model presets could not be projected.",
                service: "model-presets",
              }),
          })
          return { ...result, presets }
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
