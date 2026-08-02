import { Mcp } from "@arforge-ai/schema/mcp"
import { Location } from "@arforge-ai/schema/location"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { McpServerNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const root = "/api/mcp"

export const makeMcpGroup = <I extends HttpApiMiddleware.AnyId, S>(locationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.mcp")
    .add(
      HttpApiEndpoint.get("mcp.list", root, {
        query: LocationQuery,
        success: Location.response(Schema.Array(Mcp.Server)),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("mcp.resource.catalog", `${root}/resource`, {
        query: LocationQuery,
        success: Location.response(Mcp.ResourceCatalog),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("mcp.connect", `${root}/:server/connect`, {
        params: { server: Schema.String },
        query: LocationQuery,
        success: HttpApiSchema.NoContent,
        error: McpServerNotFoundError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("mcp.disconnect", `${root}/:server/disconnect`, {
        params: { server: Schema.String },
        query: LocationQuery,
        success: HttpApiSchema.NoContent,
        error: McpServerNotFoundError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "MCP",
        description: "Workspace-scoped Model Context Protocol status, resources, and connection control.",
      }),
    )
