import { MCP } from "@/mcp"
import { InstanceStore } from "@/project/instance-store"
import { Location } from "@arforge-ai/core/location"
import { McpServerNotFoundError } from "@arforge-ai/protocol/errors"
import { Api } from "@arforge-ai/server/api"
import { response } from "@arforge-ai/server/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

const notFound = (error: { readonly name: string }) =>
  new McpServerNotFoundError({
    server: error.name,
    message: `MCP server not found: ${error.name}`,
  })

function inLocation<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    const store = yield* InstanceStore.Service
    return yield* store.provide({ directory: location.directory }, effect)
  })
}

export const mcpV2Handlers = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return handlers
      .handle(
        "mcp.list",
        Effect.fn("McpV2.list")(function* () {
          return yield* response(
            inLocation(mcp.status()).pipe(
              Effect.map((status) => Object.entries(status).map(([name, value]) => ({ name, status: value }))),
            ),
          )
        }),
      )
      .handle(
        "mcp.resource.catalog",
        Effect.fn("McpV2.resourceCatalog")(function* () {
          return yield* response(
            inLocation(Effect.all({ resources: mcp.resources(), templates: mcp.resourceTemplates() })).pipe(
              Effect.map(({ resources, templates }) => ({
                resources: Object.values(resources).map(({ client, ...resource }) => ({
                  ...resource,
                  server: client,
                })),
                templates: Object.values(templates).map(({ client, ...template }) => ({
                  ...template,
                  server: client,
                })),
              })),
            ),
          )
        }),
      )
      .handle(
        "mcp.connect",
        Effect.fn("McpV2.connect")(function* ({ params }) {
          yield* inLocation(mcp.connect(params.server)).pipe(Effect.mapError(notFound))
        }),
      )
      .handle(
        "mcp.disconnect",
        Effect.fn("McpV2.disconnect")(function* ({ params }) {
          yield* inLocation(mcp.disconnect(params.server)).pipe(Effect.mapError(notFound))
        }),
      )
  }),
)
