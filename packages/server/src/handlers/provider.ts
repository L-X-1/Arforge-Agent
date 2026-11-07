import { Catalog } from "@arforge-ai/core/catalog"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ProviderNotFoundError } from "@arforge-ai/protocol/errors"
import { response } from "../location"
import {
  configurationCapability,
  getConfiguration,
  testConfiguration,
  saveConfiguration,
  connectConfigurationCredential,
  disconnectConfiguration,
  providerConfigurationScope,
} from "../provider-configuration"

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    const configure = yield* providerConfigurationScope
    return handlers
      .handle("provider.configuration.get", (ctx) => response(configure(getConfiguration(ctx.params.providerID))))
      .handle("provider.configuration.test", (ctx) =>
        response(configure(testConfiguration(ctx.params.providerID, ctx.payload))),
      )
      .handle("provider.configuration.capability", () => response(configure(configurationCapability())))
      .handle("provider.configuration.save", (ctx) =>
        response(configure(saveConfiguration(ctx.params.providerID, ctx.payload))),
      )
      .handle("provider.configuration.credential", (ctx) =>
        response(configure(connectConfigurationCredential(ctx.params.providerID, ctx.payload))),
      )
      .handle("provider.configuration.disconnect", (ctx) =>
        response(configure(disconnectConfiguration(ctx.params.providerID, ctx.payload.revision))),
      )
      .handle(
        "provider.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.provider.available())
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          const catalog = yield* Catalog.Service
          const provider = yield* catalog.provider.get(ctx.params.providerID)
          if (!provider)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          return yield* response(Effect.succeed(provider))
        }),
      )
  }),
)
