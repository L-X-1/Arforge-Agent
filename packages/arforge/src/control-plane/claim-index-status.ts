export * as ClaimIndexStatus from "./claim-index-status"

import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { Effect, Option, Schema } from "effect"
import { WorktreeSnapshot } from "@/control-operation/worktree-snapshot"
import * as ControlRunCoordinator from "./run-coordinator"

/**
 * A read-only adapter over the Core ClaimIndex. It deliberately accepts the
 * server-derived control subject rather than a run/action ID from a renderer.
 */
export type Input = {
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly operation: ControlRunCoordinator.OperationKind
  /** Optional server-only proof used before returning an existing mutation alias. */
  readonly acceptsPayload?: (payload: unknown) => boolean
}

export class PrincipalUnavailableError extends Schema.TaggedErrorClass<PrincipalUnavailableError>()(
  "ClaimIndexStatus.PrincipalUnavailableError",
  {},
) {}

export class ScopeMismatchError extends Schema.TaggedErrorClass<ScopeMismatchError>()(
  "ClaimIndexStatus.ScopeMismatchError",
  {
    runID: AgentRuntime.RunID,
  },
) {}

/**
 * Resolve a presentation request alias through the immutable ClaimIndex and
 * project only display-safe state. IdentityContext is request scoped, then
 * injected into the Core Context.Reference for this one lookup; no layer or
 * browser value can become a long-lived principal.
 */
export const lookup = Effect.fn("ClaimIndexStatus.lookup")(function* (input: Input) {
  const identity = yield* Effect.serviceOption(IdentityContext.Current)
  if (Option.isNone(identity)) return yield* new PrincipalUnavailableError()

  const snapshot = yield* ControlClaimIndex.Service.use((service) =>
    service.lookup({ controlPlaneID: input.subject.id, requestID: input.subject.requestID }),
  ).pipe(
    Effect.provideService(ControlClaimIndex.CurrentPrincipal, {
      tenantID: identity.value.tenantID,
      userID: identity.value.userID,
    }),
  )
  const run = snapshot.run
  if (
    run.subject.id !== input.subject.id ||
    run.subject.location !== input.subject.location ||
    run.subject.project !== input.subject.project ||
    run.subject.actor !== input.subject.actor ||
    run.subject.principalRef !== input.subject.principalRef ||
    run.operation.kind !== input.operation
  )
    return yield* new ScopeMismatchError({ runID: run.id })
  if (input.acceptsPayload !== undefined) {
    const accepted = yield* Effect.try({
      try: () => input.acceptsPayload!(run.operation.payload),
      catch: () => new ScopeMismatchError({ runID: run.id }),
    })
    if (!accepted) return yield* new ScopeMismatchError({ runID: run.id })
  }

  const phase = ControlRunCoordinator.displayPhase(run.status)
  const result =
    phase === "completed"
      ? input.operation === "session.revert" || input.operation === "session.unrevert"
        ? ({ kind: input.operation, completed: true } as const)
        : yield* Effect.try({
            try: () =>
              WorktreeSnapshot.completionResult(run.operation.payload, {
                projectID: input.subject.project,
                location: input.subject.location,
                operation: input.operation,
              }),
            catch: () => new ScopeMismatchError({ runID: run.id }),
          })
      : undefined
  return {
    runID: run.id,
    actionID: run.operation.actionID,
    // The response is for this presented alias, which can differ from the
    // canonical run's original request ID.
    requestID: input.subject.requestID,
    operation: input.operation,
    phase,
    recovery: ControlRunCoordinator.recoveryDirective(run.status),
    canApprove: phase === "waiting_for_confirmation",
    ...(result ? { result } : {}),
  } satisfies Status
})

export const Result = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("worktree.create"),
    name: Schema.String,
    directory: Schema.String,
    branch: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("worktree.remove"),
    completed: Schema.Literal(true),
  }),
  Schema.Struct({
    kind: Schema.Literal("worktree.reset"),
    completed: Schema.Literal(true),
  }),
  Schema.Struct({
    kind: Schema.Literals(["session.revert", "session.unrevert"]),
    completed: Schema.Literal(true),
  }),
]).annotate({ identifier: "ControlOperationResult" })

export const Status = Schema.Struct({
  runID: AgentRuntime.RunID,
  actionID: AgentRuntime.ActionID,
  requestID: AgentRuntime.ControlPlaneRequestID,
  operation: Schema.Literals([...ControlRunCoordinator.OperationKind]),
  phase: Schema.Literals([
    "preparing",
    "waiting_for_confirmation",
    "queued",
    "executing",
    "recovering",
    "verifying",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),
  recovery: Schema.Literals(["awaiting_authorization", "resume", "recover", "none"]),
  canApprove: Schema.Boolean,
  result: Schema.optionalKey(Result),
}).annotate({ identifier: "ControlOperationStatus" })
export interface Status extends Schema.Schema.Type<typeof Status> {}
