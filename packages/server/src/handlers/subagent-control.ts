import { Location } from "@arforge-ai/core/location"
import { Database } from "@arforge-ai/core/database/database"
import * as ControlAccess from "@arforge-ai/core/runtime/subagent-control-access"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import * as CoreSubagentControl from "@arforge-ai/core/runtime/subagent-control"
import * as SubagentControlClaim from "@arforge-ai/core/runtime/subagent-control-claim"
import * as SubagentControlRecovery from "@arforge-ai/core/runtime/subagent-control-recovery"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { SubagentControl as ProtocolSubagentControl } from "@arforge-ai/schema/subagent-control"
import { IdentityContext } from "../identity-context"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
  SubagentControlNotFoundError,
} from "@arforge-ai/protocol/errors"
import { Clock, DateTime, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

type Operation = ProtocolSubagentControl.Operation

type ControlGatewayReceipt = SubagentControlRecovery.ControlGatewayReceipt

const actionName = (operation: Operation) => `subagent.control.${operation}`

const isSessionRun = (run: AgentRuntime.Run): run is AgentRuntime.SessionRun => "sessionID" in run

const apiError = (error: unknown) => {
  if (error instanceof ControlAccess.TreeScopeError) return new ConflictError({ message: error.message })
  if (error instanceof ControlAccess.AccessDeniedError) return new ForbiddenError({ message: error.message })
  if (
    error instanceof ConflictError ||
    error instanceof ForbiddenError ||
    error instanceof InvalidRequestError ||
    error instanceof ServiceUnavailableError ||
    error instanceof SubagentControlNotFoundError
  )
    return error
  if (error instanceof CoreSubagentControl.RequestConflictError)
    return new ConflictError({ message: error.reason, resource: error.messageID })
  if (error instanceof CoreSubagentControl.ControlClosedError)
    return new ConflictError({
      message: `The ${error.operation} request cannot target a terminal run (${error.status}).`,
      resource: error.runID,
    })
  if (error instanceof DurableRun.LeaseMismatchError)
    return new ConflictError({
      message: "The parent execution lease is no longer current. Resume the parent and retry.",
      resource: error.runID,
    })
  if (error instanceof DurableRun.LeaseHeldError)
    return new ConflictError({
      message: "Another control worker currently owns this request. Retry after it releases or expires its lease.",
      resource: error.runID,
    })
  if (error instanceof DurableRun.InvalidRunLeaseCapabilityError)
    return new ConflictError({
      message: "The control execution lease is no longer current. Retry the request.",
      resource: error.runID,
    })
  if (error instanceof DurableRun.InvalidTransitionError || error instanceof DurableRun.InvalidAttemptStateError)
    return new ConflictError({
      message: "The durable control request changed state before this operation could complete. Retry it.",
      resource: error.runID,
    })
  if (error instanceof DurableRun.AttemptInProgressError || error instanceof DurableRun.AttemptMismatchError)
    return new ConflictError({
      message: "Another control attempt is already active for this request. Retry after it settles.",
      resource: error.runID,
    })
  if (error instanceof ActionGateway.ActionInProgressError)
    return new ConflictError({
      message: "Another durable action worker currently owns this control request. Retry after it settles.",
      resource: error.actionID,
    })
  if (
    error instanceof ActionGateway.BlockedError ||
    error instanceof ActionGateway.AlreadySettledError ||
    error instanceof ActionGateway.RecoveryRequiredError ||
    error instanceof ActionGateway.ActionIntentMismatchError
  )
    return new ConflictError({
      message: "The durable control action cannot be replayed or resumed with the presented identity.",
      resource: error.actionID,
    })
  if (error instanceof ActionGateway.InvalidSubjectError)
    return new ConflictError({
      message: `The durable control action subject is invalid or no longer matches its claim: ${error.reason}`,
    })
  if (error instanceof DurableRun.ChildParentMismatchError)
    return new ConflictError({ message: error.reason, resource: error.childRunID })
  if (error instanceof DurableRun.NotFoundError)
    return new InvalidRequestError({ message: `Durable run not found: ${error.runID}`, field: "runID" })
  if (error instanceof SubagentControlClaim.InvalidClaimRequestError)
    return new InvalidRequestError({ message: error.reason })
  if (error instanceof ControlClaimIndex.MissingPrincipalError)
    return new ServiceUnavailableError({
      message: "The authenticated control principal is unavailable; sign in again and retry.",
      service: "control-principal",
    })
  if (error instanceof ControlClaimIndex.InvalidClaimMaterialError)
    return new InvalidRequestError({ message: error.reason })
  if (error instanceof ControlClaimIndex.ClaimConflictError) return new ConflictError({ message: error.reason })
  if (error instanceof CoreSubagentControl.InvalidRequestError)
    return new InvalidRequestError({ message: error.reason })
  return new ServiceUnavailableError({
    message: "The delegated-child control service is temporarily unavailable.",
    service: "subagent-control",
  })
}

const responseFromReceipt = (
  receipt: ControlGatewayReceipt,
  child: DurableRun.ChildSnapshot,
  claim: ControlClaimIndex.ClaimResult,
): ProtocolSubagentControl.Response => ({
  operation: receipt.operation,
  parentRunID: receipt.parentRunID,
  childRunID: receipt.childRunID,
  status: child.run.status,
  resultReceiptStatus: CoreSubagentControl.resultReceiptStatus(child.run),
  timedOut: receipt.timedOut,
  requestID: receipt.requestID,
  ...(receipt.admission ? { admission: receipt.admission } : {}),
  controlRunID: claim.snapshot.run.id,
  actionID: claim.snapshot.run.operation.actionID,
  claim: claim.kind,
})

export const SubagentControlHandler = HttpApiBuilder.group(Api, "server.subagentControl", (handlers) =>
  Effect.gen(function* () {
    const control = yield* CoreSubagentControl.Service
    const durable = yield* DurableRun.Service
    const claims = yield* ControlClaimIndex.Service
    const database = yield* Database.Service

    // Match the existing session/artifact read policy. Execution leases are
    // worker ownership, not user authorization to inspect durable metadata.
    const assertSessionReadable = Effect.fnUntraced(function* (
      sessionID: string,
      principal: IdentityContext.Principal,
    ) {
      yield* ControlAccess.assertSessionReadable(database, sessionID, principal).pipe(
        Effect.mapError((error) => new ForbiddenError({ message: error.message })),
      )
    })

    const principalOf = (identity: IdentityContext.Principal) =>
      ({ tenantID: identity.tenantID, userID: identity.userID }) satisfies ControlClaimIndex.Principal

    // Recursive cancellation is wider than the direct child. Authorize the
    // currently visible tree before creating a claim or signalling a provider.
    // listChildren is capped at 1,000; a full page cannot prove completeness.
    const assertDescendantsReadable = Effect.fnUntraced(function* (
      childRunID: AgentRuntime.RunID,
      identity: IdentityContext.Principal,
      location: Location.Interface,
    ) {
      yield* ControlAccess.assertDescendantsReadable(database, durable, childRunID, identity, {
        project: location.project.id,
        location: String(location.directory),
      })
    })

    const subject = (
      principal: ControlClaimIndex.Principal,
      location: Location.Interface,
      operation: Operation,
      requestID: AgentRuntime.ControlPlaneRequestID,
    ) =>
      AgentRuntime.ControlPlaneSubject.make({
        type: "control-plane",
        id: ControlPrincipal.controlPlaneID(principal, {
          location: String(location.directory),
          projectID: location.project.id,
          action: actionName(operation),
        }),
        location: location.directory,
        project: location.project.id,
        actor: "user",
        principalRef: ControlPrincipal.principalRef(principal),
        requestID,
      })

    const parentLease = Effect.fnUntraced(function* (parentRunID: AgentRuntime.RunID, location: Location.Interface) {
      const snapshot = yield* durable.load(parentRunID)
      if (!isSessionRun(snapshot.run))
        return yield* new InvalidRequestError({
          message: "The selected parent is not a SessionRun.",
          field: "parentRunID",
        })
      if (
        snapshot.run.project !== location.project.id ||
        String(snapshot.run.location ?? "") !== String(location.directory)
      )
        return yield* new ConflictError({
          message: "The parent run belongs to a different project or workspace.",
          resource: parentRunID,
        })
      yield* assertSessionReadable(snapshot.run.sessionID, yield* IdentityContext.Current)
      if (!snapshot.lease)
        return yield* new ConflictError({
          message: "The parent is not currently owned by an active execution lease. Resume it and retry.",
          resource: parentRunID,
        })
      return snapshot.lease
    })

    const children = Effect.fnUntraced(function* (ctx: {
      readonly params: { readonly parentRunID: AgentRuntime.RunID }
    }) {
      const location = yield* Location.Service
      const identity = yield* IdentityContext.Current
      const principal = principalOf(identity)
      const parent = yield* durable.load(ctx.params.parentRunID)
      if (!isSessionRun(parent.run))
        return yield* new InvalidRequestError({
          message: "The selected parent is not a SessionRun.",
          field: "parentRunID",
        })
      if (
        parent.run.project !== location.project.id ||
        String(parent.run.location ?? "") !== String(location.directory)
      )
        return yield* new ConflictError({
          message: "The parent run belongs to a different project or workspace.",
          resource: ctx.params.parentRunID,
        })

      yield* assertSessionReadable(parent.run.sessionID, identity)
      const snapshots = yield* durable.listChildren({
        parentRunID: ctx.params.parentRunID,
        includeTerminal: true,
        limit: 1_000,
      })
      const projected = [] as ProtocolSubagentControl.ChildSummary[]
      for (const snapshot of snapshots) {
        if (!isSessionRun(snapshot.run) || snapshot.run.child === undefined)
          return yield* new ConflictError({
            message: "The durable child projection is malformed.",
            resource: ctx.params.parentRunID,
          })
        if (
          snapshot.run.child.parentRunID !== ctx.params.parentRunID ||
          snapshot.run.project !== parent.run.project ||
          String(snapshot.run.location ?? "") !== String(parent.run.location ?? "")
        )
          return yield* new ConflictError({
            message: "A child durable binding does not match the requested parent scope.",
            resource: snapshot.run.id,
          })
        yield* assertSessionReadable(snapshot.run.sessionID, identity)
        const objectiveDigest = canonicalHash({
          domain: "arforge.subagent-objective/v1",
          objective: snapshot.run.child.delegatedObjective,
        })
        if (!objectiveDigest)
          return yield* new ConflictError({
            message: "A child objective could not be canonically projected.",
            resource: snapshot.run.id,
          })
        projected.push({
          childRunID: snapshot.run.id,
          sessionID: snapshot.run.sessionID,
          status: snapshot.run.status,
          resultReceiptStatus: CoreSubagentControl.resultReceiptStatus(snapshot.run),
          depth: snapshot.run.child.depth,
          objectiveDigest,
        })
      }

      RuntimeInsight.auditRecord({
        actor: identity.userID,
        action: "subagent.control.children.list",
        resource: ctx.params.parentRunID,
        reason: "Parent listed direct delegated children",
        tenantID: principal.tenantID,
        ownerUserID: principal.userID,
        metadata: {
          schemaVersion: 1,
          parentRunID: ctx.params.parentRunID,
          childCount: projected.length,
          childRunIDs: projected.map((item) => item.childRunID),
        },
      })
      return {
        parentRunID: ctx.params.parentRunID,
        controlAvailable:
          !!parent.lease &&
          DateTime.toEpochMillis(parent.lease.expiresAt) > (yield* Clock.currentTimeMillis) &&
          !["completed", "failed", "cancelled"].includes(parent.run.status),
        children: projected,
      } satisfies ProtocolSubagentControl.ChildrenResponse
    })

    const claim = Effect.fnUntraced(function* (
      input: CoreSubagentControl.ClaimInput,
      principal: ControlClaimIndex.Principal,
    ) {
      return yield* control.claim(input).pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
    })

    const materialOf = (input: CoreSubagentControl.ClaimInput) =>
      Effect.try({
        try: () => SubagentControlClaim.make(input),
        catch: apiError,
      })

    const childProjection = Effect.fnUntraced(function* (
      parentRunID: AgentRuntime.RunID,
      childRunID: AgentRuntime.RunID,
    ) {
      const loaded = yield* durable.load(childRunID)
      if (!isSessionRun(loaded.run) || loaded.run.child?.parentRunID !== parentRunID)
        return yield* new ConflictError({
          message: "The durable child binding changed while the control action was executing.",
          resource: childRunID,
        })
      return loaded as DurableRun.ChildSnapshot
    })

    const executeThroughGateway = Effect.fnUntraced(function* (
      material: SubagentControlClaim.Material,
      sealed: ControlClaimIndex.ClaimResult,
      parentLease: AgentRuntime.RunLease,
      direct: () => Effect.Effect<CoreSubagentControl.Result, CoreSubagentControl.Error>,
    ) {
      const gateway = yield* ActionGateway.Service
      const gatewayDurable = yield* DurableRun.Service
      const database = yield* Database.Service
      return yield* SubagentControlRecovery.executeControlGateway({
        runID: sealed.snapshot.run.id,
        material,
        sealedKind: sealed.kind,
        parentLease,
        durable: gatewayDurable,
        gateway,
        control,
        database,
        direct,
      })
    })

    const runSteer = Effect.fnUntraced(function* (
      operation: "steer" | "followup",
      ctx: {
        readonly params: { readonly parentRunID: AgentRuntime.RunID; readonly childRunID: AgentRuntime.RunID }
        readonly payload:
          | typeof ProtocolSubagentControl.SteerPayload.Type
          | typeof ProtocolSubagentControl.FollowupPayload.Type
      },
    ) {
      const location = yield* Location.Service
      const identity = yield* IdentityContext.Current
      const principal = principalOf(identity)
      const lease = yield* parentLease(ctx.params.parentRunID, location)
      const child = yield* durable.load(ctx.params.childRunID)
      const childRun = child.run
      if (!isSessionRun(childRun))
        return yield* new InvalidRequestError({
          message: "The selected child is not a SessionRun.",
          field: "childRunID",
        })
      yield* assertSessionReadable(childRun.sessionID, identity)
      const prepared = yield* Effect.try({
        try: () =>
          CoreSubagentControl.prepare({
            operation,
            parentRunID: ctx.params.parentRunID,
            childRunID: ctx.params.childRunID,
            sessionID: childRun.sessionID,
            requestID: ctx.payload.requestID,
            prompt: ctx.payload.prompt,
          }),
        catch: apiError,
      })
      const controlSubject = subject(principal, location, operation, ctx.payload.requestID)
      const claimInput: CoreSubagentControl.ClaimInput = {
        admission: "pending",
        operation,
        subject: controlSubject,
        parentRunID: ctx.params.parentRunID,
        childRunID: ctx.params.childRunID,
        sessionID: prepared.sessionID,
        requestID: ctx.payload.requestID,
        messageID: prepared.messageID,
        promptDigest: prepared.promptDigest,
        delivery: prepared.delivery,
      }
      const material = yield* materialOf(claimInput)
      const sealed = yield* claim(claimInput, principal)
      const receipt = yield* executeThroughGateway(material, sealed, lease, () =>
        operation === "steer"
          ? control.steer({
              callerRunID: ctx.params.parentRunID,
              parentRunID: ctx.params.parentRunID,
              childRunID: ctx.params.childRunID,
              leaseID: lease.id,
              ownerID: lease.ownerID,
              operation: "steer",
              requestID: ctx.payload.requestID,
              prompt: ctx.payload.prompt,
            })
          : control.followup({
              callerRunID: ctx.params.parentRunID,
              parentRunID: ctx.params.parentRunID,
              childRunID: ctx.params.childRunID,
              leaseID: lease.id,
              ownerID: lease.ownerID,
              operation: "followup",
              requestID: ctx.payload.requestID,
              prompt: ctx.payload.prompt,
            }),
      )
      return responseFromReceipt(receipt, yield* childProjection(ctx.params.parentRunID, ctx.params.childRunID), sealed)
    })

    const runObservation = Effect.fnUntraced(function* (
      operation: "wait" | "cancel",
      ctx: {
        readonly params: { readonly parentRunID: AgentRuntime.RunID; readonly childRunID: AgentRuntime.RunID }
        readonly payload:
          | typeof ProtocolSubagentControl.WaitPayload.Type
          | typeof ProtocolSubagentControl.CancelPayload.Type
      },
    ) {
      const location = yield* Location.Service
      const identity = yield* IdentityContext.Current
      const principal = principalOf(identity)
      const lease = yield* parentLease(ctx.params.parentRunID, location)
      const controlSubject = subject(principal, location, operation, ctx.payload.requestID)
      const child = yield* durable.load(ctx.params.childRunID)
      const childRun = child.run
      if (!isSessionRun(childRun))
        return yield* new InvalidRequestError({
          message: "The selected child is not a SessionRun.",
          field: "childRunID",
        })
      yield* assertSessionReadable(childRun.sessionID, identity)
      if (operation === "wait") {
        const payload = ctx.payload as typeof ProtocolSubagentControl.WaitPayload.Type
        const claimInput: CoreSubagentControl.ClaimInput = {
          operation: "wait",
          subject: controlSubject,
          parentRunID: ctx.params.parentRunID,
          childRunID: ctx.params.childRunID,
          sessionID: childRun.sessionID,
          requestID: payload.requestID,
          ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
        }
        const material = yield* materialOf(claimInput)
        const sealed = yield* claim(claimInput, principal)
        const receipt = yield* executeThroughGateway(material, sealed, lease, () =>
          control.wait({
            callerRunID: ctx.params.parentRunID,
            parentRunID: ctx.params.parentRunID,
            childRunID: ctx.params.childRunID,
            leaseID: lease.id,
            ownerID: lease.ownerID,
            operation: "wait",
            timeoutMs: payload.timeoutMs,
          }),
        )
        return responseFromReceipt(
          receipt,
          yield* childProjection(ctx.params.parentRunID, ctx.params.childRunID),
          sealed,
        )
      }

      const payload = ctx.payload as typeof ProtocolSubagentControl.CancelPayload.Type
      if (payload.recursive !== false) yield* assertDescendantsReadable(ctx.params.childRunID, identity, location)
      const reasonDigest = canonicalHash({ domain: "arforge.subagent-control-reason/v1", reason: payload.reason })
      if (!reasonDigest)
        return yield* new InvalidRequestError({ message: "The cancellation reason is not canonically hashable." })
      const claimInput: CoreSubagentControl.ClaimInput = {
        operation: "cancel",
        subject: controlSubject,
        parentRunID: ctx.params.parentRunID,
        childRunID: ctx.params.childRunID,
        sessionID: childRun.sessionID,
        requestID: payload.requestID,
        reasonDigest,
        ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
        ...(payload.recursive === undefined ? {} : { recursive: payload.recursive }),
      }
      const material = yield* materialOf(claimInput)
      const sealed = yield* claim(claimInput, principal)
      const receipt = yield* executeThroughGateway(material, sealed, lease, () =>
        control.cancel({
          callerRunID: ctx.params.parentRunID,
          parentRunID: ctx.params.parentRunID,
          childRunID: ctx.params.childRunID,
          leaseID: lease.id,
          ownerID: lease.ownerID,
          operation: "cancel",
          // Keep the user-provided cancellation text out of the durable run
          // transition and RuntimeInsight surfaces. The metadata-only claim
          // already binds its canonical digest; the run needs only a stable,
          // non-sensitive explanation for replay and recovery.
          reason: `Parent requested delegated-child cancellation (reason digest ${reasonDigest})`,
          recursive: payload.recursive,
          timeoutMs: payload.timeoutMs,
        }),
      )
      return responseFromReceipt(receipt, yield* childProjection(ctx.params.parentRunID, ctx.params.childRunID), sealed)
    })

    /**
     * Read-only durable projection for a previously sealed control request.
     * The route revalidates the caller's workspace and immutable parent/child
     * binding before consulting the tenant-scoped claim index.  The payload is
     * checked only for metadata identity; no prompt, reason, lease, or
     * provider field is ever copied into the response.
     */
    const status = Effect.fnUntraced(function* (ctx: {
      readonly params: {
        readonly parentRunID: AgentRuntime.RunID
        readonly childRunID: AgentRuntime.RunID
        readonly operation: Operation
        readonly requestID: AgentRuntime.ControlPlaneRequestID
      }
    }) {
      const location = yield* Location.Service
      const identity = yield* IdentityContext.Current
      const principal = principalOf(identity)
      const parent = yield* durable.load(ctx.params.parentRunID)
      if (!isSessionRun(parent.run))
        return yield* new InvalidRequestError({
          message: "The selected parent is not a SessionRun.",
          field: "parentRunID",
        })
      if (
        parent.run.project !== location.project.id ||
        String(parent.run.location ?? "") !== String(location.directory)
      )
        return yield* new ConflictError({
          message: "The parent run belongs to a different project or workspace.",
          resource: ctx.params.parentRunID,
        })
      const child = yield* durable.load(ctx.params.childRunID)
      if (!isSessionRun(child.run) || child.run.child === undefined)
        return yield* new InvalidRequestError({
          message: "The selected child is not a delegated SessionRun.",
          field: "childRunID",
        })
      if (child.run.child.parentRunID !== ctx.params.parentRunID)
        return yield* new ConflictError({
          message: "The selected child is not owned by the supplied parent.",
          resource: ctx.params.childRunID,
        })

      yield* assertSessionReadable(parent.run.sessionID, identity)
      yield* assertSessionReadable(child.run.sessionID, identity)
      const expectedSubject = subject(principal, location, ctx.params.operation, ctx.params.requestID)
      const snapshot = yield* claims
        .lookup({ controlPlaneID: expectedSubject.id, requestID: ctx.params.requestID })
        .pipe(
          Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal),
          Effect.mapError((error) => {
            if (error instanceof ControlClaimIndex.NotFoundError)
              return new SubagentControlNotFoundError({
                parentRunID: ctx.params.parentRunID,
                childRunID: ctx.params.childRunID,
                requestID: ctx.params.requestID,
                message: "No durable control claim exists for this request ID.",
              })
            return error
          }),
        )
      const run = snapshot.run
      if (
        run.subject.id !== expectedSubject.id ||
        run.subject.requestID !== ctx.params.requestID ||
        run.subject.location !== expectedSubject.location ||
        run.subject.project !== expectedSubject.project ||
        run.operation.kind !== actionName(ctx.params.operation)
      )
        return yield* new ConflictError({
          message: "The durable control claim does not match the requested operation scope.",
          resource: ctx.params.requestID,
        })

      const payload = run.operation.payload
      if (payload === null || typeof payload !== "object" || Array.isArray(payload))
        return yield* new ConflictError({
          message: "The durable control claim payload is malformed.",
          resource: ctx.params.requestID,
        })
      const metadata = payload as Record<string, unknown>
      if (
        metadata.operation !== ctx.params.operation ||
        metadata.requestID !== ctx.params.requestID ||
        metadata.parentRunID !== ctx.params.parentRunID ||
        metadata.childRunID !== ctx.params.childRunID ||
        metadata.sessionID !== child.run.sessionID ||
        Object.prototype.hasOwnProperty.call(metadata, "prompt") ||
        Object.prototype.hasOwnProperty.call(metadata, "reason")
      )
        return yield* new ConflictError({
          message: "The durable control claim metadata does not match the immutable parent/child binding.",
          resource: ctx.params.requestID,
        })

      RuntimeInsight.auditRecord({
        actor: identity.userID,
        action: "subagent.control.status",
        resource: ctx.params.childRunID,
        reason: "Parent read the durable delegated-child control claim status",
        tenantID: principal.tenantID,
        ownerUserID: principal.userID,
        metadata: {
          schemaVersion: 1,
          operation: ctx.params.operation,
          parentRunID: ctx.params.parentRunID,
          childRunID: ctx.params.childRunID,
          requestID: ctx.params.requestID,
          controlRunID: run.id,
          actionID: run.operation.actionID,
          status: run.status,
        },
      })

      return {
        operation: ctx.params.operation,
        parentRunID: ctx.params.parentRunID,
        childRunID: ctx.params.childRunID,
        status: run.status,
        timedOut: false,
        requestID: ctx.params.requestID,
        controlRunID: run.id,
        actionID: run.operation.actionID,
        claim: "existing" as const,
      } satisfies ProtocolSubagentControl.Response
    })

    return handlers
      .handle(
        "subagentControl.children",
        Effect.fn(function* (ctx) {
          return yield* children(ctx).pipe(
            Effect.mapError((error) => (error instanceof ForbiddenError ? error : apiError(error))),
          )
        }),
      )
      .handle(
        "subagentControl.steer",
        Effect.fn(function* (ctx) {
          return yield* runSteer("steer", ctx).pipe(Effect.mapError(apiError))
        }),
      )
      .handle(
        "subagentControl.followup",
        Effect.fn(function* (ctx) {
          return yield* runSteer("followup", ctx).pipe(Effect.mapError(apiError))
        }),
      )
      .handle(
        "subagentControl.wait",
        Effect.fn(function* (ctx) {
          return yield* runObservation("wait", ctx).pipe(Effect.mapError(apiError))
        }),
      )
      .handle(
        "subagentControl.cancel",
        Effect.fn(function* (ctx) {
          return yield* runObservation("cancel", ctx).pipe(Effect.mapError(apiError))
        }),
      )
      .handle(
        "subagentControl.status",
        Effect.fn(function* (ctx) {
          return yield* status(ctx).pipe(Effect.mapError(apiError))
        }),
      )
  }),
)
