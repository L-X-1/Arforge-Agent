export * as ControlOperation from "./service"

import * as ActionGateway from "@arforge-ai/core/action-gateway"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Context, Effect, Layer, Schema } from "effect"
import { WorktreeSnapshot } from "./worktree-snapshot"

/** App-scoped scheduling is deliberately injected; an HTTP request never owns a worker fiber. */
export interface Scheduler {
  /** Location is part of the server-derived subject, never renderer input. */
  readonly start: (
    runID: AgentRuntime.RunID,
    location?: AgentRuntime.ControlPlaneSubject["location"],
  ) => Effect.Effect<void>
}

export class SchedulerUnavailableError extends Schema.TaggedErrorClass<SchedulerUnavailableError>()(
  "ControlOperation.SchedulerUnavailableError",
  {},
) {}

export class SchedulerStartError extends Schema.TaggedErrorClass<SchedulerStartError>()(
  "ControlOperation.SchedulerStartError",
  { runID: AgentRuntime.RunID },
) {}

export class InvalidSealedClaimError extends Schema.TaggedErrorClass<InvalidSealedClaimError>()(
  "ControlOperation.InvalidSealedClaimError",
  { reason: Schema.String },
) {}

export class UnsupportedPrincipalError extends Schema.TaggedErrorClass<UnsupportedPrincipalError>()(
  "ControlOperation.UnsupportedPrincipalError",
  {},
) {}

/**
 * The current detached recovery scanner can safely re-enter only the local
 * single-user RLS scope. Multi-tenant dispatch requires a separate trusted,
 * restart-persistent principal index; accepting it here would create a run
 * that the worker cannot see after the HTTP transaction ends.
 */
export const LocalPrincipal = Object.freeze({ tenantID: "ten_local", userID: "usr_local" })

export type ClaimInput = {
  /** Must be derived from the current instance location/project and operation. */
  readonly subject: AgentRuntime.ControlPlaneSubject
  /** The output of WorktreeSnapshot.encode; no Prepared worktree value crosses this boundary. */
  readonly snapshot: WorktreeSnapshot.Snapshot
}

export type ClaimResult = {
  readonly kind: "claimed" | "existing"
  readonly runID: AgentRuntime.RunID
  readonly actionID: AgentRuntime.ActionID
  readonly status: AgentRuntime.RunStatus
  readonly presentedRequestID: AgentRuntime.ControlPlaneRequestID
}

export interface Interface {
  readonly claimAndStart: (
    input: ClaimInput,
  ) => Effect.Effect<
    ClaimResult,
    | SchedulerUnavailableError
    | SchedulerStartError
    | InvalidSealedClaimError
    | UnsupportedPrincipalError
    | ControlClaimIndex.MissingPrincipalError
    | ControlClaimIndex.InvalidClaimMaterialError
    | ControlClaimIndex.ClaimConflictError
  >
}

/** Inject only from a long-lived location/app scope; HTTP scopes get no scheduler by default. */
export class Service extends Context.Service<Service, Interface>()("@arforge/ControlOperation") {}

export const MAX_RUN_DURATION_MS = 15 * 60 * 1000

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: MAX_RUN_DURATION_MS,
  // DurableRun treats reaching the cost ceiling as exhausted before an
  // attempt starts. Worktree execution does not accrue model cost, so one
  // positive sentinel micro-unit keeps the initial zero-cost attempt valid;
  // maxAttempts remains the authoritative one-shot bound.
  maxCostMicros: 1,
  maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

export const sameControlPath = (left: string, right: string) => {
  const windows =
    /^[A-Za-z]:[\\/]/.test(left) || /^\\\\/.test(left) || /^[A-Za-z]:[\\/]/.test(right) || /^\\\\/.test(right)
  if (!windows) return left === right
  return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase()
}

/**
 * Claims an already prepared, sealed worktree operation and gives its durable
 * ID to an app-scoped scheduler.  It intentionally has no callback for a raw
 * Worktree mutation: the scheduler must run WorktreeControlWorker instead.
 */
export const make = (input: {
  readonly claims: ControlClaimIndex.Interface
  readonly scheduler?: Scheduler
}): Interface => ({
  claimAndStart: Effect.fn("ControlOperation.claimAndStart")(function* (request: ClaimInput) {
    if (!input.scheduler) return yield* new SchedulerUnavailableError()
    const principal = yield* ControlClaimIndex.CurrentPrincipal
    if (!principal) return yield* new ControlClaimIndex.MissingPrincipalError()
    if (principal.tenantID !== LocalPrincipal.tenantID || principal.userID !== LocalPrincipal.userID)
      return yield* new UnsupportedPrincipalError()
    if (
      request.snapshot.projectID !== request.subject.project ||
      !sameControlPath(request.snapshot.location, String(request.subject.location))
    )
      return yield* new InvalidSealedClaimError({
        reason: "The sealed snapshot does not match the server control scope.",
      })

    const claimMaterial = WorktreeSnapshot.claimMaterial(request.snapshot)
    const material = WorktreeSnapshot.actionMaterial(request.snapshot)
    const inputDigest = material.inputDigest
    const actionID = ActionGateway.stableControlPlaneActionID({
      subject: request.subject,
      name: material.name,
      resources: material.resources,
      inputDigest,
      policyVersion: ActionGateway.POLICY_VERSION,
    })
    const claimed = yield* input.claims.claim({
      subject: request.subject,
      gateway: {
        kind: "control-plane",
        name: material.name,
        resources: material.resources,
        semantics: material.semantics,
        reasonSummary: material.reasonSummary,
        initiator: "user",
        traceID: `control:${request.subject.id}:${request.subject.requestID}`,
      },
      authorization: WorktreeSnapshot.authorizationPlan(request.snapshot, actionID),
      // The action identity is canonical request-independent material. The
      // full request-bound snapshot remains the immutable operation payload
      // and is revalidated by the worker before execution.
      input: claimMaterial.input,
      operation: { kind: material.name, payload: request.snapshot },
      claimMaterial,
      run: {
        initiator: "user",
        authority: "human",
        riskTier: "L3",
        reasonSummary: material.reasonSummary,
        budget,
        traceID: `control:${request.subject.id}:${request.subject.requestID}`,
        visibility: "details",
      },
    })
    yield* input.scheduler
      .start(claimed.snapshot.run.id, request.subject.location)
      .pipe(Effect.catchCause(() => new SchedulerStartError({ runID: claimed.snapshot.run.id })))
    return {
      kind: claimed.kind,
      runID: claimed.snapshot.run.id,
      actionID: claimed.snapshot.run.operation.actionID,
      status: claimed.snapshot.run.status,
      presentedRequestID: claimed.presentedRequestID,
    } satisfies ClaimResult
  }),
})

/**
 * Explicitly fail-closed when a location lifecycle has not provided the
 * detached scheduler. This keeps accidental HTTP-only wiring from persisting
 * an approval that no worker can own.
 */
export const layer = (scheduler?: Scheduler): Layer.Layer<Service, never, ControlClaimIndex.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      return make({ claims: yield* ControlClaimIndex.Service, scheduler })
    }),
  )
