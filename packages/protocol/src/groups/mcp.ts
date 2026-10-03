import { Mcp } from "@arforge-ai/schema/mcp"
import { Location } from "@arforge-ai/schema/location"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError, McpServerNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const root = "/api/mcp"

/** Exact identity required for a read-only MCP action reconciliation lookup. */
export const ReconciliationQuery = Schema.Struct({
  ...LocationQuery.fields,
  intentDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  idempotencyKey: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
})

/** Explicit operator acknowledgement for recording a fresh read-only result. */
export const ReconciliationRecordRequest = Schema.Struct({
  expectedEvidenceDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  approval: Schema.Literal("record_evidence"),
})

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
      HttpApiEndpoint.get("mcp.capabilities", `${root}/capabilities`, {
        query: LocationQuery,
        success: Location.response(Mcp.CapabilityCatalog),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("mcp.action.reconciliation", `${root}/actions/:actionID/reconciliation`, {
        params: { actionID: Schema.String },
        query: ReconciliationQuery,
        success: Location.response(Mcp.Reconciliation),
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.mcp.action.reconciliation",
            summary: "Inspect MCP action reconciliation",
            description:
              "Read-only, identity-bound reconciliation of an MCP child action; it never calls MCP transport, changes Action status, or authorizes a retry.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("mcp.action.reconciliationRecord", `${root}/actions/:actionID/reconciliation/record`, {
        params: { actionID: Schema.String },
        query: ReconciliationQuery,
        payload: ReconciliationRecordRequest,
        success: Location.response(Mcp.Reconciliation),
        error: [ForbiddenError, InvalidRequestError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.mcp.action.reconciliationRecord",
            summary: "Record an operator-confirmed MCP reconciliation",
            description:
              "Records only a fresh, identity-bound read-only MCP evidence projection after explicit operator confirmation; it never calls MCP transport, changes Action status, or authorizes a retry.",
          }),
        ),
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
