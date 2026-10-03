import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { ControlOperation } from "@/control-operation/service"
import { SessionRevertControlOperation } from "@/control-operation/session-revert-operation"
import { SessionShareControlOperation } from "@/control-operation/session-share-operation"
import { WorktreeSnapshot } from "@/control-operation/worktree-snapshot"
import { HttpControlSubject } from "@/control-plane/http-control-subject"
import { InstanceState } from "@/effect/instance-state"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Project as ProjectSchema } from "@arforge-ai/schema/project"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionRevertReadonlyLocal } from "@/session/revert-readonly-local"
import { SessionRevertSnapshot } from "@/session/revert-snapshot"
import { SessionShareReadonlyLocal } from "@/share/readonly-local"
import { SessionShareProvider } from "@/share/provider"
import { SessionShareSnapshot } from "@/share/session-snapshot"
import type { MessageID, PartID, SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { ClaimIndexStatus } from "@/control-plane/claim-index-status"
import { Effect, Option } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  ConsoleSwitchPayload,
  ControlApprovalQuery,
  ControlApprovalReply,
  ControlOperationStatusQuery,
  SessionListQuery,
  ToolListQuery,
  WorktreeApiError,
  WorktreeCreatePayload,
  WorktreeRemovePayload,
  WorktreeResetPayload,
  SessionRevertControlPayload,
  SessionUnrevertControlPayload,
  SessionShareControlPayload,
} from "../groups/experimental"
import { ServiceUnavailableError } from "../errors"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

const controlAcceptanceError = () =>
  new WorktreeApiError({
    name: "WorktreeControlExecutionDeniedError",
    data: { message: "The durable worktree operation could not be accepted." },
  })

const controlApprovalReason: Readonly<Record<string, string>> = {
  "worktree.create": "Create an isolated worktree at the displayed commit.",
  "worktree.remove": "Remove the displayed worktree and its branch.",
  "worktree.reset": "Reset and clean the displayed worktree to the approved commit.",
  "skill.enable": "Enable the exact managed skill shown in the desktop control center.",
  "skill.disable": "Disable the exact managed skill shown in the desktop control center.",
  "plugin.enable": "Enable the exact managed plugin shown in the desktop control center.",
  "plugin.disable": "Disable the exact managed plugin shown in the desktop control center.",
  "plugin.install": "Install the exact inspected managed plugin package.",
  "plugin.update": "Update the exact inspected managed plugin package.",
  "plugin.uninstall": "Move the exact managed plugin to recoverable local storage.",
  "plugin.rollback": "Restore the exact managed plugin from recoverable local storage.",
  "session.revert": "Restore the exact approved Session file boundary and history marker.",
  "session.unrevert": "Restore the immutable preimage receipt from the first approved Session revert.",
  "session.share": "Publish the exact approved, heuristically scanned Session export.",
  "session.unshare": "Remove only the exact approved Session publication.",
  "evolution.proposal.create": "Create the exact governed Evolution candidate artifact.",
  "evolution.proposal.evaluate": "Evaluate the exact governed Evolution candidate in isolation.",
  "evolution.proposal.transition": "Advance the exact governed Evolution candidate through its reviewed lifecycle.",
  "evolution.exposure.archive": "Archive only the exact reviewed Evolution exposure records.",
  "evolution.exposure.restore": "Restore only the exact reviewed Evolution exposure archive.",
}

const evolutionControlApprovalReason: Readonly<Record<string, string>> = {
  "evolution.proposal.create": controlApprovalReason["evolution.proposal.create"],
  "evolution.proposal.evaluate": controlApprovalReason["evolution.proposal.evaluate"],
  "evolution.proposal.transition": controlApprovalReason["evolution.proposal.transition"],
  "evolution.exposure.archive": controlApprovalReason["evolution.exposure.archive"],
  "evolution.exposure.restore": controlApprovalReason["evolution.exposure.restore"],
}

const isEvolutionControlOperation = (action: string): action is keyof typeof evolutionControlApprovalReason =>
  Object.prototype.hasOwnProperty.call(evolutionControlApprovalReason, action)

const evolutionControlLocation = "/arforge/evolution"

const evolutionControlPlaneID = (principal: ControlClaimIndex.Principal, action: string) =>
  ControlPrincipal.controlPlaneID(principal, {
    location: evolutionControlLocation,
    projectID: ProjectSchema.ID.global,
    action,
  })

function isOwnedEvolutionControlSubject(
  subject: AgentRuntime.ControlPlaneSubject,
  input: { readonly action: string; readonly principal: ControlClaimIndex.Principal },
) {
  return (
    subject.id === evolutionControlPlaneID(input.principal, input.action) &&
    subject.location === evolutionControlLocation &&
    subject.project === ProjectSchema.ID.global &&
    subject.actor === "user" &&
    subject.principalRef === ControlPrincipal.principalRef(input.principal) &&
    isEvolutionControlOperation(input.action)
  )
}

function controlSubjectOwnedBy(
  subject: AgentRuntime.ControlPlaneSubject,
  input: {
    readonly directory: string
    readonly projectID: typeof ProjectSchema.ID.Type
    readonly action: string
    readonly principal: ControlClaimIndex.Principal
  },
) {
  return (
    HttpControlSubject.ownedBy(subject, input) ||
    isOwnedEvolutionControlSubject(subject, { action: input.action, principal: input.principal })
  )
}

function evolutionControlSubject(input: {
  readonly action: string
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly principal: ControlClaimIndex.Principal
}) {
  return AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: evolutionControlPlaneID(input.principal, input.action),
    location: AbsolutePath.make(evolutionControlLocation),
    project: ProjectSchema.ID.global,
    actor: "user",
    principalRef: ControlPrincipal.principalRef(input.principal),
    requestID: input.requestID,
  })
}

function safeControlApproval(input: AgentRuntime.ControlRequest) {
  const reason = controlApprovalReason[input.action]
  if (!reason) return undefined
  if (
    input.resources.length === 0 ||
    input.resources.length > 32 ||
    input.resources.some(
      (resource) => resource.length === 0 || resource.length > 512 || /[\u0000-\u001f]/.test(resource),
    )
  ) {
    return undefined
  }
  return AgentRuntime.ControlRequest.make({
    id: input.id,
    subject: input.subject,
    action: input.action,
    resources: [...input.resources],
    metadata: { reason, requiresHumanConfirmation: true },
  })
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const controlOperations = yield* ControlOperation.Service
    const sessionRevertOperations = yield* SessionRevertControlOperation.Service
    const sessionRevertInspector = yield* SessionRevertReadonlyLocal.Service
    const sessionShareOperations = yield* SessionShareControlOperation.Service
    const sessionShareExporter = yield* SessionShareReadonlyLocal.Service
    const sessionShareProvider = yield* SessionShareProvider.Service

    const requireSessionShareProvider = Effect.fnUntraced(function* () {
      const availability = yield* sessionShareProvider.availability()
      if (availability !== "ready")
        return yield* new ServiceUnavailableError({
          message: "Session sharing is unavailable until a verified provider adapter is configured.",
          service: "session-share-provider",
        })
    })

    const currentControlPrincipal = Effect.fnUntraced(function* () {
      const identity = yield* Effect.serviceOption(IdentityContext.Current)
      if (Option.isNone(identity) || !identity.value.tenantID || !identity.value.userID)
        return yield* controlAcceptanceError()
      return { tenantID: identity.value.tenantID, userID: identity.value.userID } satisfies ControlClaimIndex.Principal
    })

    const currentLocalControlPrincipal = Effect.fnUntraced(function* () {
      const principal = yield* currentControlPrincipal()
      // Detached dispatch/recovery does not yet carry a PostgreSQL RLS
      // principal. Refuse user-auth claims before preparation instead of
      // accepting a run that no worker can safely load.
      if (!HttpControlSubject.isLocalPrincipal(principal)) return yield* controlAcceptanceError()
      return principal
    })

    /**
     * A retry first resolves the exact server-derived request alias. Only a
     * typed NotFound may proceed to fresh preparation; corrupt, foreign, or
     * otherwise unreadable durable state fails closed instead of recreating
     * filesystem intent.
     */
    const existingControlOperation = Effect.fnUntraced(function* (
      presented: WorktreeSnapshot.PresentedInput,
      principal: ControlClaimIndex.Principal,
    ) {
      const instance = yield* InstanceState.context
      const subject = HttpControlSubject.make({
        directory: instance.directory,
        projectID: instance.project.id,
        action: presented.operation,
        requestID: AgentRuntime.ControlPlaneRequestID.make(presented.requestID),
        principal,
      })
      return yield* ClaimIndexStatus.lookup({
        subject,
        operation: presented.operation,
        acceptsPayload: (payload) => WorktreeSnapshot.matchesPresentedInput(payload, presented),
      }).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ControlClaimIndex.NotFoundError", () => Effect.succeed(Option.none())),
        Effect.mapError(controlAcceptanceError),
      )
    })

    const acceptControlOperation = (
      operation: "worktree.create" | "worktree.remove" | "worktree.reset",
      requestID: AgentRuntime.ControlPlaneRequestID,
      prepared: WorktreeSnapshot.Prepared,
      principal: ControlClaimIndex.Principal,
    ) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const scope = yield* mapWorktreeError(worktreeSvc.controlScope())
        const snapshot = yield* Effect.try({
          try: () => WorktreeSnapshot.encode(prepared, scope),
          catch: controlAcceptanceError,
        })
        const subject = HttpControlSubject.make({
          directory: instance.directory,
          projectID: instance.project.id,
          action: operation,
          requestID,
          principal,
        })
        yield* controlOperations
          .claimAndStart({ subject, snapshot })
          .pipe(
            Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal),
            Effect.mapError(controlAcceptanceError),
          )
        // Return only the durable projection. The detached scheduler owns all
        // approval waits and Git/filesystem side effects after this point.
        return yield* ClaimIndexStatus.lookup({ subject, operation }).pipe(Effect.mapError(controlAcceptanceError))
      })

    const acceptSessionRevertOperation = (input: {
      readonly sessionID: SessionID
      readonly kind: "revert" | "unrevert"
      readonly requestID: AgentRuntime.ControlPlaneRequestID
      readonly messageID?: MessageID
      readonly partID?: PartID
      readonly principal: ControlClaimIndex.Principal
    }) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const operation = `session.${input.kind}` as const
        const subject = HttpControlSubject.make({
          directory: instance.directory,
          projectID: instance.project.id,
          action: operation,
          requestID: input.requestID,
          principal: input.principal,
        })
        const existing = yield* ClaimIndexStatus.lookup({
          subject,
          operation,
          acceptsPayload: (payload) =>
            SessionRevertSnapshot.matchesPresentedInput(payload, {
              kind: input.kind,
              requestID: input.requestID,
              sessionID: input.sessionID,
              ...(input.messageID !== undefined ? { messageID: input.messageID } : {}),
              ...(input.partID !== undefined ? { partID: input.partID } : {}),
            }),
        }).pipe(
          Effect.map(Option.some),
          Effect.catchTag("ControlClaimIndex.NotFoundError", () => Effect.succeed(Option.none())),
          Effect.catch(() => Effect.fail(controlAcceptanceError())),
        )
        if (Option.isSome(existing)) return existing.value
        const snapshot = yield* sessionRevertInspector
          .capture({
            requestID: input.requestID,
            kind: input.kind,
            sessionID: input.sessionID,
            ...(input.messageID !== undefined ? { messageID: input.messageID } : {}),
            ...(input.partID !== undefined ? { partID: input.partID } : {}),
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Controlled Session revert preflight was rejected", {
                sessionID: input.sessionID,
                kind: input.kind,
                reason: error.reason,
                message: error.message,
              }),
            ),
            Effect.mapError(controlAcceptanceError),
          )
        yield* sessionRevertOperations
          .claimAndStart({ subject, snapshot })
          .pipe(
            Effect.provideService(ControlClaimIndex.CurrentPrincipal, input.principal),
            Effect.tapError((error) =>
              Effect.logWarning("Controlled Session revert claim was rejected", {
                sessionID: input.sessionID,
                kind: input.kind,
                errorTag: error._tag,
                reason: "reason" in error ? error.reason : undefined,
                runID: "runID" in error ? error.runID : undefined,
              }),
            ),
            Effect.mapError(controlAcceptanceError),
          )
        return yield* ClaimIndexStatus.lookup({ subject, operation }).pipe(Effect.mapError(controlAcceptanceError))
      })

    const acceptSessionShareOperation = (input: {
      readonly sessionID: SessionID
      readonly kind: "share" | "unshare"
      readonly requestID: AgentRuntime.ControlPlaneRequestID
      readonly baseURL: string
      readonly organizationID: string | null
      readonly visibility: "private" | "organization" | "public"
      readonly principal: ControlClaimIndex.Principal
    }) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const operation = `session.${input.kind}` as const
        const subject = HttpControlSubject.make({
          directory: instance.directory,
          projectID: instance.project.id,
          action: operation,
          requestID: input.requestID,
          principal: input.principal,
        })
        const presented = {
          kind: input.kind,
          requestID: input.requestID,
          sessionID: input.sessionID,
          baseURL: input.baseURL,
          organizationID: input.organizationID,
          visibility: input.visibility,
        }
        const existing = yield* ClaimIndexStatus.lookup({
          subject,
          operation,
          acceptsPayload: (payload) => SessionShareSnapshot.matchesPresentedInput(payload, presented),
        }).pipe(
          Effect.map(Option.some),
          Effect.catchTag("ControlClaimIndex.NotFoundError", () => Effect.succeed(Option.none())),
          Effect.catch(() => Effect.fail(controlAcceptanceError())),
        )
        if (Option.isSome(existing)) return existing.value
        yield* requireSessionShareProvider()
        const snapshot = yield* sessionShareExporter
          .capture({
            requestID: input.requestID,
            kind: input.kind,
            sessionID: input.sessionID,
            target: {
              baseURL: input.baseURL,
              organizationID: input.organizationID,
              visibility: input.visibility,
              publication: null,
            },
          })
          .pipe(Effect.mapError(controlAcceptanceError))
        yield* sessionShareOperations
          .claimAndStart({ subject, snapshot })
          .pipe(
            Effect.provideService(ControlClaimIndex.CurrentPrincipal, input.principal),
            Effect.mapError(controlAcceptanceError),
          )
        return yield* ClaimIndexStatus.lookup({ subject, operation }).pipe(Effect.mapError(controlAcceptanceError))
      })

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    /** Runs a control-plane operation in the same location-bound services as MCP. */
    const inLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        return yield* effect.pipe(
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))),
        )
      })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof WorktreeCreatePayload.Type
    }) {
      const principal = yield* currentLocalControlPrincipal()
      const existing = yield* existingControlOperation(
        { operation: "worktree.create", requestID: ctx.payload.requestID, payload: ctx.payload },
        principal,
      )
      if (Option.isSome(existing)) return existing.value
      const prepared = yield* mapWorktreeError(worktreeSvc.prepareCreate(ctx.payload, ctx.payload.requestID))
      return yield* acceptControlOperation(
        "worktree.create",
        ctx.payload.requestID,
        {
          kind: "create",
          value: prepared,
        },
        principal,
      )
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: typeof WorktreeRemovePayload.Type
    }) {
      const principal = yield* currentLocalControlPrincipal()
      const existing = yield* existingControlOperation(
        { operation: "worktree.remove", requestID: input.payload.requestID, payload: input.payload },
        principal,
      )
      if (Option.isSome(existing)) return existing.value
      const prepared = yield* mapWorktreeError(worktreeSvc.prepareRemove(input.payload, input.payload.requestID))
      return yield* acceptControlOperation(
        "worktree.remove",
        input.payload.requestID,
        {
          kind: "remove",
          value: prepared,
        },
        principal,
      )
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: typeof WorktreeResetPayload.Type
    }) {
      const principal = yield* currentLocalControlPrincipal()
      const existing = yield* existingControlOperation(
        { operation: "worktree.reset", requestID: ctx.payload.requestID, payload: ctx.payload },
        principal,
      )
      if (Option.isSome(existing)) return existing.value
      const prepared = yield* mapWorktreeError(worktreeSvc.prepareReset(ctx.payload, ctx.payload.requestID))
      return yield* acceptControlOperation(
        "worktree.reset",
        ctx.payload.requestID,
        {
          kind: "reset",
          value: prepared,
        },
        principal,
      )
    })

    const sessionRevert = Effect.fn("ExperimentalHttpApi.sessionRevert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SessionRevertControlPayload.Type
    }) {
      const principal = yield* currentLocalControlPrincipal()
      return yield* acceptSessionRevertOperation({
        sessionID: ctx.params.sessionID,
        kind: "revert",
        requestID: ctx.payload.requestID,
        messageID: ctx.payload.messageID,
        partID: ctx.payload.partID,
        principal,
      })
    })

    const sessionUnrevert = Effect.fn("ExperimentalHttpApi.sessionUnrevert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SessionUnrevertControlPayload.Type
    }) {
      const principal = yield* currentLocalControlPrincipal()
      return yield* acceptSessionRevertOperation({
        sessionID: ctx.params.sessionID,
        kind: "unrevert",
        requestID: ctx.payload.requestID,
        principal,
      })
    })

    const sessionShare = Effect.fn("ExperimentalHttpApi.sessionShare")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SessionShareControlPayload.Type
    }) {
      const principal = yield* currentLocalControlPrincipal()
      return yield* acceptSessionShareOperation({
        sessionID: ctx.params.sessionID,
        kind: "share",
        requestID: ctx.payload.requestID,
        baseURL: ctx.payload.baseURL,
        organizationID: ctx.payload.organizationID,
        visibility: ctx.payload.visibility,
        principal,
      })
    })

    const sessionUnshare = Effect.fn("ExperimentalHttpApi.sessionUnshare")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SessionShareControlPayload.Type
    }) {
      const principal = yield* currentLocalControlPrincipal()
      return yield* acceptSessionShareOperation({
        sessionID: ctx.params.sessionID,
        kind: "unshare",
        requestID: ctx.payload.requestID,
        baseURL: ctx.payload.baseURL,
        organizationID: ctx.payload.organizationID,
        visibility: ctx.payload.visibility,
        principal,
      })
    })

    const controlApprovalList = Effect.fn("ExperimentalHttpApi.controlApprovalList")(function* (ctx: {
      query: typeof ControlApprovalQuery.Type
    }) {
      const instance = yield* InstanceState.context
      const principal = yield* currentControlPrincipal().pipe(Effect.option)
      if (Option.isNone(principal)) return []
      return yield* inLocation(
        Authorizer.Service.use((authorizer) =>
          authorizer.list().pipe(
            Effect.map((items) => {
              return items.flatMap((item) => {
                if (!("subject" in item) || item.subject.type !== "control-plane") return []
                if (
                  !controlSubjectOwnedBy(item.subject, {
                    directory: instance.directory,
                    projectID: instance.project.id,
                    action: item.action,
                    principal: principal.value,
                  })
                )
                  return []
                if (ctx.query.requestID !== undefined && item.subject.requestID !== ctx.query.requestID) return []
                const safe = safeControlApproval(item)
                return safe ? [safe] : []
              })
            }),
          ),
        ),
      )
    })

    const controlApprovalReply = Effect.fn("ExperimentalHttpApi.controlApprovalReply")(function* (ctx: {
      params: { requestID: string }
      payload: typeof ControlApprovalReply.Type
    }) {
      const instance = yield* InstanceState.context
      const principal = yield* currentControlPrincipal().pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      yield* inLocation(
        Authorizer.Service.use((authorizer) =>
          Effect.gen(function* () {
            const pending = yield* authorizer.get(ctx.params.requestID as never)
            if (
              !pending ||
              !("subject" in pending) ||
              pending.subject.type !== "control-plane" ||
              !controlSubjectOwnedBy(pending.subject, {
                directory: instance.directory,
                projectID: instance.project.id,
                action: pending.action,
                principal,
              })
            )
              return yield* new HttpApiError.BadRequest({})
            yield* authorizer.reply({
              requestID: ctx.params.requestID as never,
              reply: ctx.payload.reply,
              message: ctx.payload.message,
            })
          }).pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({})))),
        ),
      )
      return true
    })

    /**
     * This is deliberately read-only. The request ID is only an alias; the
     * server derives the complete subject from the current location/project
     * and resolves it through Core's strict ClaimIndex before returning a
     * display DTO. No payload, checkpoint, action body, or mutation effect is
     * exposed through this endpoint.
     */
    const controlOperationStatus = Effect.fn("ExperimentalHttpApi.controlOperationStatus")(function* (ctx: {
      params: { requestID: AgentRuntime.ControlPlaneRequestID }
      query: typeof ControlOperationStatusQuery.Type
    }) {
      const instance = yield* InstanceState.context
      const principal = yield* currentControlPrincipal().pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      const subject =
        isEvolutionControlOperation(ctx.query.operation)
          ? evolutionControlSubject({
              action: ctx.query.operation,
              requestID: ctx.params.requestID,
              principal,
            })
          : HttpControlSubject.make({
              directory: instance.directory,
              projectID: instance.project.id,
              action: ctx.query.operation,
              requestID: ctx.params.requestID,
              principal,
            })
      return yield* ClaimIndexStatus.lookup({ subject, operation: ctx.query.operation }).pipe(
        // An unknown alias, malformed durable projection, foreign scope, or
        // absent authenticated identity deliberately has one opaque response.
        Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))),
      )
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("sessionRevert", sessionRevert)
      .handle("sessionUnrevert", sessionUnrevert)
      .handle("sessionShare", sessionShare)
      .handle("sessionUnshare", sessionUnshare)
      .handle("controlApprovalList", controlApprovalList)
      .handle("controlApprovalReply", controlApprovalReply)
      .handle("controlOperationStatus", controlOperationStatus)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("resource", resource)
  }),
)
