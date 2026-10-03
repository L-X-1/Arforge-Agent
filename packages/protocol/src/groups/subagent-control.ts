import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SubagentControl } from "@arforge-ai/schema/subagent-control"
import { Context } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import {
  InvalidRequestError,
  ServiceUnavailableError,
  ConflictError,
  SubagentControlNotFoundError,
  ForbiddenError,
} from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const root = "/api/subagent-control/:parentRunID/:childRunID"
const parentRoot = "/api/subagent-control/:parentRunID/children"
const params = {
  parentRunID: AgentRuntime.RunID,
  childRunID: AgentRuntime.RunID,
}
const parentParams = {
  parentRunID: AgentRuntime.RunID,
}
const statusParams = {
  ...params,
  operation: SubagentControl.Operation,
  requestID: AgentRuntime.ControlPlaneRequestID,
}

/**
 * Protocol-only control surface.  The route carries request identity and
 * prompt/reason bytes only; execution lease owner fields are resolved by the
 * server and never accepted from a renderer or CLI caller.
 */
export const makeSubagentControlGroup = <I extends HttpApiMiddleware.AnyId, S>(locationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.subagentControl")
    .add(
      HttpApiEndpoint.get("subagentControl.children", parentRoot, {
        params: parentParams,
        query: LocationQuery,
        success: SubagentControl.ChildrenResponse,
        error: [
          InvalidRequestError,
          ConflictError,
          ForbiddenError,
          ServiceUnavailableError,
          SubagentControlNotFoundError,
        ],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.subagentControl.children",
            summary: "List delegated children",
            description:
              "List the direct children of a parent SessionRun using a metadata-only projection. The response contains status and stable identifiers, never delegated prompt text, leases, or provider payloads.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("subagentControl.steer", `${root}/steer`, {
        params,
        query: LocationQuery,
        payload: SubagentControl.SteerPayload,
        success: SubagentControl.Response,
        error: [
          InvalidRequestError,
          ConflictError,
          ForbiddenError,
          ServiceUnavailableError,
          SubagentControlNotFoundError,
        ],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.subagentControl.steer",
            summary: "Steer a delegated child",
            description:
              "Admit one deterministic steering input for a direct child and seal a metadata-only control claim. Prompt bytes remain in the durable SessionInput inbox.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("subagentControl.followup", `${root}/followup`, {
        params,
        query: LocationQuery,
        payload: SubagentControl.FollowupPayload,
        success: SubagentControl.Response,
        error: [
          InvalidRequestError,
          ConflictError,
          ForbiddenError,
          ServiceUnavailableError,
          SubagentControlNotFoundError,
        ],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.subagentControl.followup",
            summary: "Queue a delegated child follow-up",
            description:
              "Queue one deterministic follow-up for a direct child and seal a metadata-only control claim without duplicating the prompt in the claim record.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("subagentControl.wait", `${root}/wait`, {
        params,
        query: LocationQuery,
        payload: SubagentControl.WaitPayload,
        success: SubagentControl.Response,
        error: [
          InvalidRequestError,
          ConflictError,
          ForbiddenError,
          ServiceUnavailableError,
          SubagentControlNotFoundError,
        ],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.subagentControl.wait",
            summary: "Wait for a delegated child",
            description:
              "Observe a direct child with a bounded timeout; timeout returns a snapshot and never fabricates completion.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("subagentControl.cancel", `${root}/cancel`, {
        params,
        query: LocationQuery,
        payload: SubagentControl.CancelPayload,
        success: SubagentControl.Response,
        error: [
          InvalidRequestError,
          ConflictError,
          ForbiddenError,
          ServiceUnavailableError,
          SubagentControlNotFoundError,
        ],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.subagentControl.cancel",
            summary: "Cancel a delegated child",
            description:
              "Cancel a direct child only after provider outcome and parent authorization are known; uncertain provider outcomes remain visible as pending.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("subagentControl.status", `${root}/:operation/:requestID`, {
        params: statusParams,
        query: LocationQuery,
        success: SubagentControl.Response,
        error: [
          InvalidRequestError,
          ConflictError,
          ForbiddenError,
          ServiceUnavailableError,
          SubagentControlNotFoundError,
        ],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.subagentControl.status",
            summary: "Read a delegated-child control claim",
            description:
              "Read the durable status of one previously claimed direct-child control request. The projection contains IDs and state only; it never returns leases, prompt text, cancellation reason, or provider payloads.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "subagent control",
        description: "Deterministic parent-scoped delegated-child control with one durable prompt pipeline.",
      }),
    )
