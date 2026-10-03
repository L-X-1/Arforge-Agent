import { SessionShareProvider } from "@/share/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/api/self-hosted-share"

export const SelfHostedSharePaths = {
  publish: `${root}/publish`,
  lookup: `${root}/lookup/:operationID`,
  revoke: `${root}/revoke`,
  lookupRevoke: `${root}/revoke/:operationID`,
} as const

export const SelfHostedShareApi = HttpApi.make("selfHostedShare").add(
  HttpApiGroup.make("selfHostedShare")
    .add(
      HttpApiEndpoint.post("publish", SelfHostedSharePaths.publish, {
        payload: SessionShareProvider.PublishInputSchema,
        success: described(SessionShareProvider.PublishResult, "Self-hosted publication receipt"),
        error: [HttpApiError.BadRequest, HttpApiError.Conflict, HttpApiError.Forbidden, HttpApiError.ServiceUnavailable],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "selfHostedShare.publish",
          summary: "Publish a frozen session export",
          description: "Persist a sealed export under an idempotent operation ID and return a verified receipt.",
        }),
      ),
      HttpApiEndpoint.get("lookup", SelfHostedSharePaths.lookup, {
        params: { operationID: Schema.String },
        success: described(SessionShareProvider.PublishLookup, "Self-hosted publication lookup"),
        error: [HttpApiError.BadRequest, HttpApiError.Conflict, HttpApiError.Forbidden, HttpApiError.ServiceUnavailable],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "selfHostedShare.lookup",
          summary: "Reconcile a publication operation",
          description: "Read the durable publication receipt for an operation ID without mutating provider state.",
        }),
      ),
      HttpApiEndpoint.post("revoke", SelfHostedSharePaths.revoke, {
        payload: SessionShareProvider.RevokeInputSchema,
        success: described(SessionShareProvider.RevokeResult, "Self-hosted revocation receipt"),
        error: [HttpApiError.BadRequest, HttpApiError.Conflict, HttpApiError.Forbidden, HttpApiError.ServiceUnavailable],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "selfHostedShare.revoke",
          summary: "Revoke a self-hosted publication",
          description: "Revoke only the exact original publication identity and digest under an idempotent operation ID.",
        }),
      ),
      HttpApiEndpoint.get("lookupRevoke", SelfHostedSharePaths.lookupRevoke, {
        params: { operationID: Schema.String },
        success: described(SessionShareProvider.RevokeLookup, "Self-hosted revocation lookup"),
        error: [HttpApiError.BadRequest, HttpApiError.Conflict, HttpApiError.Forbidden, HttpApiError.ServiceUnavailable],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "selfHostedShare.lookupRevoke",
          summary: "Reconcile a revocation operation",
          description: "Read the durable revocation receipt for an operation ID without guessing an outcome.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "self-hosted-share",
        description: "Authenticated persistence API for the Arforge self-hosted share provider.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
