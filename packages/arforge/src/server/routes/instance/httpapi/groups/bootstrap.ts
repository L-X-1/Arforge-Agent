import { LocationQuery, locationQueryOpenApi } from "@arforge-ai/protocol/groups/location"
import { Location } from "@arforge-ai/schema/location"
import { Project } from "@arforge-ai/schema/project"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { AbsolutePath } from "@arforge-ai/schema/schema"
import { Schema } from "effect"
import { Vcs } from "@/project/vcs"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"

export class BootstrapPathInfo extends Schema.Class<BootstrapPathInfo>("Bootstrap.PathInfo")({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}) {}

export class BootstrapProjectCurrent extends Schema.Class<BootstrapProjectCurrent>("Bootstrap.ProjectCurrent")({
  id: ProjectID,
  directory: AbsolutePath,
}) {}

export class BootstrapVcsInfo extends Schema.Class<BootstrapVcsInfo>("Bootstrap.VcsInfo")({
  branch: Schema.optional(Schema.String),
  defaultBranch: Schema.optional(Schema.String),
}) {}

const query = Schema.Struct({ ...LocationQuery.fields, ...WorkspaceRoutingQueryFields })

export const BootstrapVcsDiffQuery = Schema.Struct({
  ...query.fields,
  mode: Schema.Literals(["working", "branch"]),
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

// Project persistence and instance/VCS state still belong to the existing
// services. Expose their read-only bootstrap views without a second state owner.
export const BootstrapApi = HttpApi.make("bootstrap").add(
  HttpApiGroup.make("bootstrap")
    .add(
      HttpApiEndpoint.get("path", "/api/path", { query, success: BootstrapPathInfo })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.path.get", summary: "Get instance paths" })),
      HttpApiEndpoint.get("project.list", "/api/project", { query, success: Schema.Array(Project.Info) })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.project.list", summary: "List projects" })),
      HttpApiEndpoint.get("project.current", "/api/project/current", { query, success: BootstrapProjectCurrent })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.project.current", summary: "Get current project" })),
      HttpApiEndpoint.get("vcs", "/api/vcs", { query, success: Location.response(BootstrapVcsInfo) })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.vcs.get", summary: "Get version control information" })),
      HttpApiEndpoint.get("vcs.diff", "/api/vcs/diff", {
        query: BootstrapVcsDiffQuery,
        success: Location.response(Schema.Array(Vcs.FileDiff)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.vcs.diff", summary: "Get version control differences" })),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
