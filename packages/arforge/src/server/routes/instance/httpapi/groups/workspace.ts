import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterEntry } from "@/control-plane/types"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ApiVcsApplyError } from "./instance"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/experimental/workspace"
export const CreatePayload = Schema.Struct(Struct.omit(Workspace.CreateInput.fields, ["projectID"]))
export const WarpPayload = Schema.Struct({
  id: Schema.NullOr(Workspace.Info.fields.id),
  sessionID: Workspace.SessionWarpInput.fields.sessionID,
  copyChanges: Workspace.SessionWarpInput.fields.copyChanges,
})

/**
 * The only HTTP payload accepted by the workspace-root control adapter.
 * State arrays, profile paths and authorization receipts are deliberately
 * absent: the server reconstructs them from the Core owner immediately
 * before the ActionGateway boundary.
 */
export const RootMutationPayload = Schema.Struct({
  action: Schema.Literals(["trust", "add", "remove"]),
  target: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32_768)),
})

const RootMutationDigest = Schema.Struct({
  trusted: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  configured: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})

export const RootMutationResult = Schema.Struct({
  status: Schema.Literals(["committed", "noop"]),
  action: Schema.Literals(["trust", "add", "remove"]),
  intentDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  before: RootMutationDigest,
  after: RootMutationDigest,
  rollbackArtifactID: Schema.optional(Schema.String),
})

export class ApiWorkspaceWarpError extends Schema.ErrorClass<ApiWorkspaceWarpError>("WorkspaceWarpError")(
  {
    name: Schema.Literal("WorkspaceWarpError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiWorkspaceCreateError extends Schema.ErrorClass<ApiWorkspaceCreateError>("WorkspaceCreateError")(
  {
    name: Schema.Literal("WorkspaceCreateError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiWorkspaceRootMutationError extends Schema.ErrorClass<ApiWorkspaceRootMutationError>(
  "WorkspaceRootMutationError",
)(
  {
    name: Schema.Literal("WorkspaceRootMutationError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.String,
      owner: Schema.Literal("typescript-core-workspace-root-writer"),
      blocking: Schema.Array(Schema.String),
    }),
  },
  { httpApiStatus: 409 },
) {}

export const WorkspacePaths = {
  adapters: `${root}/adapter`,
  list: root,
  syncList: `${root}/sync-list`,
  status: `${root}/status`,
  rootMutation: `${root}/root-mutation`,
  remove: `${root}/:id`,
  warp: `${root}/warp`,
} as const

export const WorkspaceApi = HttpApi.make("workspace")
  .add(
    HttpApiGroup.make("workspace")
      .add(
        HttpApiEndpoint.get("adapters", WorkspacePaths.adapters, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(WorkspaceAdapterEntry), "Workspace adapters"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.adapter.list",
            summary: "List workspace adapters",
            description: "List all available workspace adapters for the current project.",
          }),
        ),
        HttpApiEndpoint.get("list", WorkspacePaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workspace.Info), "Workspaces"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.list",
            summary: "List workspaces",
            description: "List all workspaces.",
          }),
        ),
        HttpApiEndpoint.post("create", WorkspacePaths.list, {
          query: WorkspaceRoutingQuery,
          payload: CreatePayload,
          success: described(Workspace.Info, "Workspace created"),
          error: [ApiWorkspaceCreateError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.create",
            summary: "Create workspace",
            description:
              "Create a workspace. The legacy Worktree adapter is disabled until it uses the control-plane Action Gateway.",
          }),
        ),
        HttpApiEndpoint.post("syncList", WorkspacePaths.syncList, {
          query: WorkspaceRoutingQuery,
          success: described(HttpApiSchema.NoContent, "Workspace list synced"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.syncList",
            summary: "Sync workspace list",
            description: "Register missing workspaces returned by workspace adapters.",
          }),
        ),
        HttpApiEndpoint.get("status", WorkspacePaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workspace.ConnectionStatus), "Workspace status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.status",
            summary: "Workspace status",
            description: "Get connection status for workspaces in the current project.",
          }),
        ),
        HttpApiEndpoint.post("rootMutation", WorkspacePaths.rootMutation, {
          query: WorkspaceRoutingQuery,
          payload: RootMutationPayload,
          success: described(RootMutationResult, "Workspace root mutation committed"),
          error: ApiWorkspaceRootMutationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.rootMutation",
            summary: "Mutate workspace roots",
            description:
              "Mutate trusted/configured workspace roots through the single TypeScript/Core ActionGateway writer. The route fails closed while production writer gates are incomplete and never falls back to Python.",
          }),
        ),
        HttpApiEndpoint.delete("remove", WorkspacePaths.remove, {
          params: { id: Workspace.Info.fields.id },
          query: WorkspaceRoutingQuery,
          success: described(Schema.UndefinedOr(Workspace.Info), "Workspace removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.remove",
            summary: "Remove workspace",
            description:
              "Remove a workspace. Legacy Worktree adapter removal is disabled until it uses the control-plane Action Gateway.",
          }),
        ),
        HttpApiEndpoint.post("warp", WorkspacePaths.warp, {
          query: WorkspaceRoutingQuery,
          payload: WarpPayload,
          success: described(HttpApiSchema.NoContent, "Session warped"),
          error: [ApiWorkspaceWarpError, ApiVcsApplyError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.warp",
            summary: "Warp session into workspace",
            description: "Move a session's sync history into the target workspace, or detach it to the local project.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "workspace", description: "Experimental HttpApi workspace routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "arforge experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
