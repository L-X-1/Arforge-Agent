import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@arforge-ai/core/schema"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { ModelV2 } from "@arforge-ai/core/model"
import { ClaimIndexStatus } from "@/control-plane/claim-index-status"
import { ControlRunCoordinator } from "@/control-plane/run-coordinator"
import { ServiceUnavailableError } from "../errors"
import { ControlPlaneMutationPayload } from "@arforge-ai/protocol/control-principal"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
/**
 * The desktop mints this before it sends a destructive request. It binds one
 * user gesture to exactly one durable control-plane action; retrying that
 * request reuses the action, while a new gesture must mint a new ID.
 */
export const WorktreeCreatePayload = Schema.Struct({
  ...Worktree.CreateInput.fields,
  ...ControlPlaneMutationPayload.fields,
}).annotate({ identifier: "WorktreeCreateControlInput" })
export const WorktreeRemovePayload = Schema.Struct({
  ...Worktree.RemoveInput.fields,
  ...ControlPlaneMutationPayload.fields,
}).annotate({ identifier: "WorktreeRemoveControlInput" })
export const WorktreeResetPayload = Schema.Struct({
  ...Worktree.ResetInput.fields,
  ...ControlPlaneMutationPayload.fields,
}).annotate({ identifier: "WorktreeResetControlInput" })
export const SessionRevertControlPayload = Schema.Struct({
  ...ControlPlaneMutationPayload.fields,
  messageID: MessageID,
  partID: Schema.optional(PartID),
}).annotate({ identifier: "SessionRevertControlInput" })
export const SessionUnrevertControlPayload = Schema.Struct({
  ...ControlPlaneMutationPayload.fields,
}).annotate({ identifier: "SessionUnrevertControlInput" })
export const SessionShareControlPayload = Schema.Struct({
  ...ControlPlaneMutationPayload.fields,
  baseURL: Schema.String,
  organizationID: Schema.NullOr(Schema.String),
  visibility: Schema.Literals(["private", "organization", "public"]),
}).annotate({ identifier: "SessionShareControlInput" })

export const ControlApprovalQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  requestID: Schema.optional(AgentRuntime.ControlPlaneRequestID),
})
export const ControlApprovalReply = Schema.Struct({
  reply: PermissionV2.Reply,
  message: Schema.optional(Schema.String),
})
export const ControlOperationStatusQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  operation: Schema.Literals([...ControlRunCoordinator.OperationKind]),
})
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
  Schema.Literal("WorktreeOwnershipFailedError"),
  Schema.Literal("WorktreeControlExecutionDeniedError"),
  Schema.Literal("ActionGateway.BlockedError"),
  Schema.Literal("ActionGateway.RecoveryRequiredError"),
  Schema.Literal("ActionGateway.ActionInProgressError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  sessionRevert: "/experimental/session/:sessionID/revert",
  sessionUnrevert: "/experimental/session/:sessionID/unrevert",
  sessionShare: "/experimental/session/:sessionID/share",
  sessionUnshare: "/experimental/session/:sessionID/unshare",
  controlApproval: "/experimental/control-approval",
  controlApprovalReply: "/experimental/control-approval/:requestID/reply",
  controlOperationStatus: "/experimental/control-operation/:requestID",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the Arforge server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local Arforge state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: WorktreeCreatePayload,
          success: described(ClaimIndexStatus.Status, "Durable worktree operation accepted"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description:
              "Accept a durable worktree create operation and return its current status without tying execution to the HTTP request. Poll control-operation status for completion.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: WorktreeRemovePayload,
          success: described(ClaimIndexStatus.Status, "Durable worktree operation accepted"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description:
              "Accept a durable worktree removal and return its current status. The detached worker owns execution after this response.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: WorktreeResetPayload,
          success: described(ClaimIndexStatus.Status, "Durable worktree operation accepted"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description:
              "Accept a durable worktree reset to the immutable preflight commit and return its current status without waiting for execution.",
          }),
        ),
        HttpApiEndpoint.post("sessionRevert", ExperimentalPaths.sessionRevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionRevertControlPayload,
          success: described(ClaimIndexStatus.Status, "Durable session revert operation accepted"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert.control",
            summary: "Accept controlled session revert",
            description:
              "Capture an immutable read-only revert snapshot and schedule it as an L3 fresh-human ControlRun.",
          }),
        ),
        HttpApiEndpoint.post("sessionUnrevert", ExperimentalPaths.sessionUnrevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionUnrevertControlPayload,
          success: described(ClaimIndexStatus.Status, "Durable session unrevert operation accepted"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unrevert.control",
            summary: "Accept controlled session unrevert",
            description:
              "Accept an unrevert request only when its first-revert preimage receipt is available to the controlled worker.",
          }),
        ),
        HttpApiEndpoint.post("sessionShare", ExperimentalPaths.sessionShare, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionShareControlPayload,
          success: described(ClaimIndexStatus.Status, "Durable session share operation accepted"),
          error: [ServiceUnavailableError, WorktreeApiError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.share.control",
            summary: "Accept controlled session share",
            description:
              "Capture a consistent static Session export and schedule publication as an L3 fresh-human ControlRun.",
          }),
        ),
        HttpApiEndpoint.post("sessionUnshare", ExperimentalPaths.sessionUnshare, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionShareControlPayload,
          success: described(ClaimIndexStatus.Status, "Durable session unshare operation accepted"),
          error: [ServiceUnavailableError, WorktreeApiError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unshare.control",
            summary: "Accept controlled session unshare",
            description:
              "Capture the immutable original publication identity and schedule revocation as an L3 fresh-human ControlRun.",
          }),
        ),
        HttpApiEndpoint.get("controlApprovalList", ExperimentalPaths.controlApproval, {
          query: ControlApprovalQuery,
          success: described(Schema.Array(AgentRuntime.ControlRequest), "Pending control-plane approvals"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.controlApproval.list",
            summary: "List pending control-plane approvals",
            description: "List fresh human confirmations for the current desktop project.",
          }),
        ),
        HttpApiEndpoint.post("controlApprovalReply", ExperimentalPaths.controlApprovalReply, {
          params: { requestID: PermissionV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ControlApprovalReply,
          success: described(Schema.Boolean, "Control-plane approval processed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.controlApproval.reply",
            summary: "Reply to a control-plane approval",
            description: "Explicitly approve or reject one fresh control-plane action.",
          }),
        ),
        HttpApiEndpoint.get("controlOperationStatus", ExperimentalPaths.controlOperationStatus, {
          params: { requestID: AgentRuntime.ControlPlaneRequestID },
          query: ControlOperationStatusQuery,
          success: described(ClaimIndexStatus.Status, "Control operation status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.controlOperation.status",
            summary: "Get control operation status",
            description:
              "Resolve one request alias through the server-side durable claim index. The response contains no operation payload or checkpoint.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all Arforge sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
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
