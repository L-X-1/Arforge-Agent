import * as ActionGateway from "@arforge-ai/core/action-gateway"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Context, Effect, Layer } from "effect"
import { SessionShareSnapshot } from "@/share/session-snapshot"
import { ControlOperation, LocalPrincipal, sameControlPath } from "./service"

export interface Scheduler {
  readonly start: (
    runID: AgentRuntime.RunID,
    location?: AgentRuntime.ControlPlaneSubject["location"],
  ) => Effect.Effect<void>
}

export interface ClaimInput {
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly snapshot: SessionShareSnapshot.Snapshot
}

export interface ClaimResult {
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
    | ControlOperation.SchedulerUnavailableError
    | ControlOperation.SchedulerStartError
    | ControlOperation.InvalidSealedClaimError
    | ControlOperation.UnsupportedPrincipalError
    | ControlClaimIndex.MissingPrincipalError
    | ControlClaimIndex.InvalidClaimMaterialError
    | ControlClaimIndex.ClaimConflictError
  >
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SessionShareControlOperation") {}

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: ControlOperation.MAX_RUN_DURATION_MS,
  maxCostMicros: 1,
  maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

export const make = (input: {
  readonly claims: ControlClaimIndex.Interface
  readonly scheduler?: Scheduler
}): Interface => ({
  claimAndStart: Effect.fn("SessionShareControlOperation.claimAndStart")(function* (request: ClaimInput) {
    if (!input.scheduler) return yield* new ControlOperation.SchedulerUnavailableError()
    const principal = yield* ControlClaimIndex.CurrentPrincipal
    if (!principal) return yield* new ControlClaimIndex.MissingPrincipalError()
    if (principal.tenantID !== LocalPrincipal.tenantID || principal.userID !== LocalPrincipal.userID)
      return yield* new ControlOperation.UnsupportedPrincipalError()
    if (
      request.snapshot.projectID !== request.subject.project ||
      !sameControlPath(request.snapshot.location, String(request.subject.location))
    )
      return yield* new ControlOperation.InvalidSealedClaimError({
        reason: "The sealed session share snapshot does not match the server control scope.",
      })

    const claimMaterial = SessionShareSnapshot.claimMaterial(request.snapshot)
    const material = SessionShareSnapshot.actionMaterial(request.snapshot)
    const actionID = ActionGateway.stableControlPlaneActionID({
      subject: request.subject,
      name: material.name,
      resources: material.resources,
      inputDigest: material.inputDigest,
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
      authorization: SessionShareSnapshot.authorizationPlan(request.snapshot),
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
      .pipe(Effect.catchCause(() => new ControlOperation.SchedulerStartError({ runID: claimed.snapshot.run.id })))
    return {
      kind: claimed.kind,
      runID: claimed.snapshot.run.id,
      actionID: claimed.snapshot.run.operation.actionID,
      status: claimed.snapshot.run.status,
      presentedRequestID: claimed.presentedRequestID,
    } satisfies ClaimResult
  }),
})

export const layer = (scheduler?: Scheduler): Layer.Layer<Service, never, ControlClaimIndex.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      return make({ claims: yield* ControlClaimIndex.Service, scheduler })
    }),
  )

export * as SessionShareControlOperation from "./session-share-operation"
