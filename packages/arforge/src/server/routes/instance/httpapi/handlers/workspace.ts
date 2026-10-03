import { listAdapters } from "@/control-plane/adapters"
import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Vcs } from "@/project/vcs"
import { Cause, Effect, Option } from "effect"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { WorkspaceRootWriterError } from "@arforge-ai/core/workspace-root-writer"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import { ApiVcsApplyError } from "../groups/instance"
import {
  ApiWorkspaceCreateError,
  ApiWorkspaceRootMutationError,
  ApiWorkspaceWarpError,
  CreatePayload,
  RootMutationPayload,
  RootMutationResult,
  WarpPayload,
} from "../groups/workspace"
import { executeWorkspaceRootControl } from "@/workspace-root-control-gateway"
import { makeWorkspaceRootProductionOwner } from "@arforge-ai/core/workspace-root-owner"

const rootMutationError = (input: {
  readonly owner: ReturnType<typeof makeWorkspaceRootProductionOwner>
  readonly reason: string
  readonly message: string
}) =>
  new ApiWorkspaceRootMutationError({
    name: "WorkspaceRootMutationError",
    data: {
      message: input.message,
      reason: input.reason,
      owner: input.owner.owner,
      blocking: [...input.owner.gate.blocking_gate_ids],
    },
  })

const mapRootMutationError = (
  owner: ReturnType<typeof makeWorkspaceRootProductionOwner>,
  error: unknown,
): ApiWorkspaceRootMutationError => {
  if (error instanceof WorkspaceRootWriterError)
    return rootMutationError({
      owner,
      reason: error.reason,
      message:
        error.reason === "writer_disabled"
          ? "Workspace root mutations are disabled until the TypeScript/Core durable writer gates pass; no Python writer fallback is available."
          : "Workspace root mutation was rejected before a successful commit; inspect the gate and retry only after recovery.",
    })
  if (error instanceof ActionGateway.BlockedError)
    return rootMutationError({
      owner,
      reason: "authorization_blocked",
      message: "Workspace root mutation was blocked by the ActionGateway authorization policy.",
    })
  if (error instanceof ActionGateway.RecoveryRequiredError)
    return rootMutationError({
      owner,
      reason: "recovery_required",
      message: "Workspace root mutation requires durable recovery before another attempt.",
    })
  if (error instanceof ActionGateway.ActionInProgressError)
    return rootMutationError({
      owner,
      reason: "action_in_progress",
      message: "Another durable workspace root mutation is still in progress; retry after it settles.",
    })
  return rootMutationError({
    owner,
    reason: "control_plane_failure",
    message: "Workspace root mutation was not accepted; no success or Python fallback was reported.",
  })
}

export const workspaceHandlers = HttpApiBuilder.group(InstanceHttpApi, "workspace", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service

    const adapters = Effect.fn("WorkspaceHttpApi.adapters")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.sync(() => listAdapters(instance.project.id))
    })

    const list = Effect.fn("WorkspaceHttpApi.list")(function* () {
      return yield* workspace.list((yield* InstanceState.context).project)
    })

    const create = Effect.fn("WorkspaceHttpApi.create")(function* (ctx: { payload: typeof CreatePayload.Type }) {
      if (ctx.payload.type === "worktree") {
        return yield* new ApiWorkspaceCreateError({
          name: "WorkspaceCreateError",
          data: {
            message: "Legacy Worktree adapter creation is disabled until it uses the control-plane Action Gateway",
          },
        })
      }
      const instance = yield* InstanceState.context
      return yield* workspace
        .create({
          ...ctx.payload,
          extra: ctx.payload.extra ?? null,
          projectID: instance.project.id,
        })
        .pipe(
          Effect.catchCause((cause) => {
            const die = cause.reasons.find(Cause.isDieReason)
            const fail = cause.reasons.find(Cause.isFailReason)
            const reason: unknown = die?.defect ?? fail?.error
            const message = reason instanceof Error ? reason.message : "Workspace creation failed"
            return Effect.fail(
              new ApiWorkspaceCreateError({
                name: "WorkspaceCreateError",
                data: { message },
              }),
            )
          }),
        )
    })

    const syncList = Effect.fn("WorkspaceHttpApi.syncList")(function* () {
      yield* workspace.syncList((yield* InstanceState.context).project)
    })

    const status = Effect.fn("WorkspaceHttpApi.status")(function* () {
      const ids = new Set((yield* workspace.list((yield* InstanceState.context).project)).map((item) => item.id))
      return (yield* workspace.status()).filter((item) => ids.has(item.workspaceID))
    })

    const rootMutation = Effect.fn("WorkspaceHttpApi.rootMutation")(function* (ctx: {
      readonly payload: typeof RootMutationPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const owner = makeWorkspaceRootProductionOwner({ primary: instance.directory })

      // Do not even resolve identity/gateway while the authoritative Core gate
      // is disabled. This guarantees the HTTP surface is side-effect free and
      // gives users the same explicit fail-closed answer as the CLI.
      if (!owner.enabled)
        return yield* rootMutationError({
          owner,
          reason: "writer_disabled",
          message:
            "Workspace root mutations are disabled until the TypeScript/Core durable writer gates pass; no Python writer fallback is available.",
        })

      const identity = yield* Effect.serviceOption(IdentityContext.Current)
      if (Option.isNone(identity))
        return yield* rootMutationError({
          owner,
          reason: "identity_unavailable",
          message:
            "Workspace root mutation requires an authenticated principal; no local fallback identity is accepted.",
        })
      const gateway = yield* Effect.serviceOption(ActionGateway.Service)
      if (Option.isNone(gateway))
        return yield* rootMutationError({
          owner,
          reason: "gateway_unavailable",
          message: "Workspace root mutation requires the location-scoped ActionGateway service.",
        })

      const principal: ControlPrincipal.Principal = {
        tenantID: identity.value.tenantID,
        userID: identity.value.userID,
      }
      return yield* executeWorkspaceRootControl({
        owner,
        gateway: gateway.value,
        principal,
        requestID: AgentRuntime.ControlPlaneRequestID.create(),
        action: ctx.payload.action,
        target: ctx.payload.target,
        projectID: instance.project.id,
      }).pipe(
        Effect.map((result) => result satisfies typeof RootMutationResult.Type),
        Effect.mapError((error) => mapRootMutationError(owner, error)),
        Effect.catchCause((cause) => Effect.fail(mapRootMutationError(owner, Cause.squash(cause)))),
      )
    })

    const remove = Effect.fn("WorkspaceHttpApi.remove")(function* (ctx: { params: { id: Workspace.Info["id"] } }) {
      const target = yield* workspace.get(ctx.params.id)
      if (target?.type === "worktree") return yield* new HttpApiError.BadRequest({})
      return yield* workspace
        .remove(ctx.params.id)
        .pipe(Effect.catchTag("Session.TeamOwnedError", () => new HttpApiError.BadRequest({})))
    })

    const warp = Effect.fn("WorkspaceHttpApi.warp")(function* (ctx: { payload: typeof WarpPayload.Type }) {
      yield* workspace
        .sessionWarp({
          workspaceID: ctx.payload.id,
          sessionID: ctx.payload.sessionID,
          copyChanges: ctx.payload.copyChanges,
        })
        .pipe(
          Effect.mapError((error) => {
            if (error instanceof Workspace.WorkspaceNotFoundError) return notFound(error.message)
            if (error instanceof Vcs.PatchApplyError) {
              return new ApiVcsApplyError({
                name: "VcsApplyError",
                data: {
                  message: error.message,
                  reason: error.reason,
                },
              })
            }
            return new ApiWorkspaceWarpError({
              name: "WorkspaceWarpError",
              data: {
                message: error.message,
              },
            })
          }),
        )
    })

    return handlers
      .handle("adapters", adapters)
      .handle("list", list)
      .handle("create", create)
      .handle("syncList", syncList)
      .handle("status", status)
      .handle("rootMutation", rootMutation)
      .handle("remove", remove)
      .handle("warp", warp)
  }),
)
