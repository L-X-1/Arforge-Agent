import { PrivateOperation } from "@arforge-ai/schema/private-operation"
import { Context } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { Location } from "@arforge-ai/schema/location"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const makePrivateOperationGroup = <I extends HttpApiMiddleware.AnyId, S>(
  locationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.privateOperation")
    .add(
      HttpApiEndpoint.get("privateOperation.overview", "/api/private-operations/overview", {
        query: LocationQuery,
        success: Location.response(PrivateOperation.Overview),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "private operations",
        description: "Read-only private operations health, usage, backup, recovery, secrets, and log-retention status.",
      }),
    )
