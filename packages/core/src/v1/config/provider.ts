export * as ConfigProviderV1 from "./provider"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"
import { Billing } from "@arforge-ai/schema/billing"
import type { ConfigProvider } from "../../config/provider"

export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])

export const Model = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  attachment: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Boolean),
  tool_call: Schema.optional(Schema.Boolean),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
      context_over_200k: Schema.optional(
        Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          cache_read: Schema.optional(Schema.Finite),
          cache_write: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
  /** Compatibility spelling of the same canonical billing contract, not another price owner. */
  priceCatalog: Schema.optional(Billing.PriceCatalog),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.Finite,
      input: Schema.optional(Schema.Finite),
      output: Schema.Finite,
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])))),
      output: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      ),
    }),
  ),
  experimental: Schema.optional(Schema.Boolean),
  status: Schema.optional(ModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  variants: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean).annotate({ description: "Disable this variant for the model" }),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({ description: "Variant-specific configuration" }),
  ),
})

export const Info = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  env: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  id: Schema.optional(Schema.String),
  npm: Schema.optional(Schema.String),
  whitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  blacklist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        baseURL: Schema.optional(Schema.String),
        setCacheKey: Schema.optional(Schema.Boolean).annotate({
          description: "Enable promptCacheKey for this provider (default false)",
        }),
        timeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
          }),
        ).annotate({
          description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
        }),
        headerTimeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
          }),
        ).annotate({
          description:
            "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
        }),
        chunkTimeout: Schema.optional(PositiveInt).annotate({
          description:
            "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
        }),
      }),
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  models: Schema.optional(Schema.Record(Schema.String, Model)),
}).annotate({ identifier: "ProviderConfig" })
export type Info = Schema.Schema.Type<typeof Info>

/** Read-only projection for remaining consumers of the legacy TS provider DTO. */
export const fromCanonical = (input: ConfigProvider.Info) => ({
  ...(input.name === undefined ? {} : { name: input.name }),
  ...(input.env === undefined ? {} : { env: [...input.env] }),
  ...(input.api?.type === "aisdk" ? { npm: input.api.package } : {}),
  ...(input.api?.url === undefined ? {} : { api: input.api.url }),
  ...(input.api || input.request
    ? {
        options: {
          ...input.api?.settings,
          ...input.request?.body,
          ...(input.api?.url === undefined ? {} : { baseURL: input.api.url }),
          ...(input.request?.headers === undefined ? {} : { headers: { ...input.request.headers } }),
        },
      }
    : {}),
  ...(input.models === undefined
    ? {}
    : {
        models: Object.fromEntries(
          Object.entries(input.models).map(([id, model]) => {
            const costs = model.cost === undefined ? [] : Array.isArray(model.cost) ? model.cost : [model.cost]
            const base = costs.find((cost) => cost.tier === undefined)
            const large = costs.find((cost) => cost.tier?.type === "context" && cost.tier.size === 200_000)
            return [
              id,
              {
                ...(model.name === undefined ? {} : { name: model.name }),
                ...(model.family === undefined ? {} : { family: model.family }),
                ...(model.api?.id === undefined ? {} : { id: model.api.id }),
                ...(model.api && "type" in model.api && model.api.type === "aisdk"
                  ? { provider: { npm: model.api.package, api: model.api.url } }
                  : {}),
                ...(model.capabilities === undefined
                  ? {}
                  : {
                      tool_call: model.capabilities.tools,
                      modalities: { input: [...model.capabilities.input], output: [...model.capabilities.output] },
                    }),
                ...(model.request?.body === undefined ? {} : { options: { ...model.request.body } }),
                ...(model.request?.headers === undefined ? {} : { headers: { ...model.request.headers } }),
                ...(model.variants === undefined
                  ? {}
                  : {
                      variants: Object.fromEntries(model.variants.map((variant) => [variant.id, { ...variant.body }])),
                    }),
                ...(base === undefined
                  ? {}
                  : {
                      cost: {
                        input: base.input,
                        output: base.output,
                        cache_read: base.cache?.read,
                        cache_write: base.cache?.write,
                        ...(large === undefined
                          ? {}
                          : {
                              context_over_200k: {
                                input: large.input,
                                output: large.output,
                                cache_read: large.cache?.read,
                                cache_write: large.cache?.write,
                              },
                            }),
                      },
                    }),
                ...(model.priceCatalog === undefined
                  ? {}
                  : { priceCatalog: Schema.encodeSync(Billing.PriceCatalog)(model.priceCatalog) }),
                ...(model.disabled === undefined
                  ? {}
                  : { status: model.disabled ? ("deprecated" as const) : ("active" as const) }),
                ...(model.limit?.context === undefined || model.limit.output === undefined
                  ? {}
                  : { limit: { context: model.limit.context, output: model.limit.output, input: model.limit.input } }),
              },
            ]
          }),
        ),
      }),
})
