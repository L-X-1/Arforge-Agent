import { PersonalWorkspace } from "@arforge-ai/schema/personal-workspace"
import { PositiveInt } from "@arforge-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const query = Schema.Struct({
  ...LocationQuery.fields,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(Schema.optional),
})

export const makePersonalWorkspaceGroup = <I extends HttpApiMiddleware.AnyId, S>(
  locationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.personalWorkspace")
    .add(
      HttpApiEndpoint.get("personalWorkspace.snapshot", "/api/personal-workspace", {
        query,
        success: PersonalWorkspace.Snapshot,
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.personalWorkspace.snapshot",
            summary: "Get Personal Workspace",
            description:
              "Read a bounded safe projection of the current project, location, sessions, tasks, runs, background jobs, costs, artifacts, recovery, and memory candidates. Raw events, prompts, credentials, and destructive maintenance are excluded.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "personal workspace",
        description: "A user-visible read-only projection of durable work and human attention boundaries.",
      }),
    )
