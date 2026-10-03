export * as WorktreeControlWorker from "./worktree-worker"

import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Ref, Schema, SynchronizedRef } from "effect"
import { WorktreeSnapshot } from "./worktree-snapshot"

/** The worker never receives a Prepared worktree value or a caller action ID. */
export interface GenericSealedExecutor<S, E = never> {
  readonly execute: (input: {
    readonly snapshot: S
    readonly runID: AgentRuntime.RunID
    readonly actionID: AgentRuntime.ActionID
    readonly controlLease: DurableRun.RunLeaseCapability
    readonly authorization: ActionGateway.AuthorizationGrantCapability
    /**
     * Signal only after the executor has validated the presented control
     * capability and all immutable inputs, immediately before side effects.
     * The worker may rotate the capability through heartbeats after this
     * one-way handoff because neither Gateway nor the executor will read the
     * old capability again.
     */
    readonly controlLeaseValidated: () => Effect.Effect<void>
  }) => Effect.Effect<void, E>
}

/** Worktree compatibility alias; new controlled operations use the generic seam. */
export type SealedExecutor<E = never> = GenericSealedExecutor<WorktreeSnapshot.Snapshot, E>

export interface SnapshotCodec<S, Scope> {
  readonly decode: (input: unknown, expected: Scope) => { readonly snapshot: S }
  readonly actionMaterial: (snapshot: S) => {
    readonly name: string
    readonly inputDigest: string
    readonly resources: ReadonlyArray<string>
    readonly semantics: AgentRuntime.EffectSemantics
    readonly reasonSummary: string
  }
  readonly authorizationPlan: (snapshot: S, actionID: AgentRuntime.ActionID) => ActionGateway.AuthorizationPlan
}

export class SnapshotMismatchError extends Schema.TaggedErrorClass<SnapshotMismatchError>()(
  "WorktreeControlWorker.SnapshotMismatchError",
  { runID: AgentRuntime.RunID, reason: Schema.String },
) {}

export class RecoveryPausedError extends Schema.TaggedErrorClass<RecoveryPausedError>()(
  "WorktreeControlWorker.RecoveryPausedError",
  { runID: AgentRuntime.RunID, reason: Schema.String },
) {}

export class ExecutionDeadlineExceededError extends Schema.TaggedErrorClass<ExecutionDeadlineExceededError>()(
  "WorktreeControlWorker.ExecutionDeadlineExceededError",
  { runID: AgentRuntime.RunID, deadlineMs: Schema.Number },
) {}

export class InvalidExecutionWindowError extends Schema.TaggedErrorClass<InvalidExecutionWindowError>()(
  "WorktreeControlWorker.InvalidExecutionWindowError",
  { leaseTtlMs: Schema.Number, executionDeadlineMs: Schema.Number },
) {}

type WorkerError =
  | SnapshotMismatchError
  | RecoveryPausedError
  | ExecutionDeadlineExceededError
  | InvalidExecutionWindowError
  | DurableRun.NotFoundError
  | DurableRun.CorruptHistoryError
  | DurableRun.InvalidTransitionError
  | DurableRun.InvalidRunLeaseCapabilityError
  | DurableRun.LeaseHeldError
  | DurableRun.InvalidLeaseDurationError
  | DurableRun.BudgetExhaustedError
  | DurableRun.ChildDeadlineExceededError
  | DurableRun.AttemptInProgressError
  | DurableRun.InvalidAttemptStateError
  | DurableRun.AttemptMismatchError
  | DurableRun.LeaseMismatchError
  | ActionGateway.BlockedError
  | ActionGateway.AlreadySettledError
  | ActionGateway.RecoveryRequiredError
  | ActionGateway.PostProcessingError
  | ActionGateway.ActionInProgressError
  | ActionGateway.ActionIntentMismatchError
  | ActionGateway.InvalidSubjectError
  | DurableAction.CorruptHistoryError

export type Interface<E = never> = {
  readonly execute: (runID: AgentRuntime.RunID) => Effect.Effect<void, WorkerError | E>
}

const canonicalEqual = (left: unknown, right: unknown) => {
  const leftHash = canonicalHash(left)
  return leftHash !== undefined && leftHash === canonicalHash(right)
}

const terminal = (status: AgentRuntime.RunStatus) => ["completed", "failed", "cancelled"].includes(status)

/**
 * Rebuilds the gateway input solely from the frozen DurableRun payload.  This
 * is intentionally not exported: an HTTP handler cannot turn arbitrary data
 * into a worker action.
 */
type ControlGatewayInput = Extract<ActionGateway.Input, { readonly kind: "control-plane" }>

type GatewayFailureProjection = {
  readonly to: Extract<AgentRuntime.RunStatus, "failed" | "paused">
  readonly reason: string
}

/** Exhaustive typed gateway classification. No user-facing reason text is parsed. */
function gatewayFailureProjection(error: unknown): GatewayFailureProjection | undefined {
  if (error instanceof ActionGateway.BlockedError)
    return { to: "failed", reason: "ActionGateway blocked the sealed worktree operation" }
  if (error instanceof ActionGateway.AlreadySettledError)
    return {
      to: "paused",
      reason: "ActionGateway found an earlier settlement without a matching ControlRun completion proof",
    }
  if (error instanceof ActionGateway.RecoveryRequiredError)
    return { to: "paused", reason: "ActionGateway requires durable recovery before execution" }
  if (error instanceof ActionGateway.ActionInProgressError)
    return { to: "paused", reason: "Another durable ActionGateway worker is still active" }
  if (error instanceof ActionGateway.ActionIntentMismatchError)
    return { to: "failed", reason: "ActionGateway rejected the immutable action intent" }
  if (error instanceof ActionGateway.InvalidSubjectError)
    return { to: "failed", reason: "ActionGateway rejected the immutable control subject" }
  if (error instanceof DurableAction.CorruptHistoryError)
    return { to: "failed", reason: "ActionGateway found corrupt durable action history" }
  if (error instanceof ExecutionDeadlineExceededError)
    return { to: "paused", reason: "The control execution deadline elapsed before completion" }
  return undefined
}

function gatewayInput<S>(
  run: AgentRuntime.ControlRun,
  snapshot: S,
  codec: Pick<SnapshotCodec<S, never>, "actionMaterial">,
): ControlGatewayInput {
  const material = codec.actionMaterial(snapshot)
  return {
    kind: "control-plane" as const,
    controlPlane: run.subject,
    runID: run.id,
    actionID: run.operation.actionID,
    name: material.name,
    resources: material.resources,
    semantics: material.semantics,
    reasonSummary: material.reasonSummary,
    initiator: run.initiator,
    traceID: run.traceID,
    inputDigest: material.inputDigest,
  } satisfies ControlGatewayInput
}

function decodeAndVerify<S, Scope>(
  run: AgentRuntime.ControlRun,
  expectedScope: Scope,
  codec: SnapshotCodec<S, Scope>,
): Effect.Effect<
  {
    readonly snapshot: S
    readonly input: ControlGatewayInput
    readonly authorization: ActionGateway.AuthorizationPlan
  },
  SnapshotMismatchError
> {
  return Effect.try({
    try: () => {
      const decoded = codec.decode(run.operation.payload, expectedScope).snapshot
      const input = gatewayInput(run, decoded, codec)
      const authorization = codec.authorizationPlan(decoded, run.operation.actionID)
      const expectedActionID = ActionGateway.stableControlPlaneActionID({
        subject: run.subject,
        name: input.name,
        resources: input.resources,
        inputDigest: input.inputDigest,
        policyVersion: ActionGateway.POLICY_VERSION,
      })
      if (
        run.operation.kind !== input.name ||
        run.operation.policyVersion !== ActionGateway.POLICY_VERSION ||
        run.operation.actionID !== expectedActionID ||
        run.operation.inputDigest !== input.inputDigest ||
        !canonicalEqual(run.operation.resources, input.resources) ||
        !canonicalEqual(run.operation.semantics, input.semantics) ||
        run.operation.authorizationDigest !== ActionGateway.intentDigestOf(input, authorization)
      )
        throw new Error("The persisted operation does not exactly match its sealed worktree snapshot.")
      return { snapshot: decoded, input, authorization }
    },
    catch: (cause) =>
      new SnapshotMismatchError({
        runID: run.id,
        reason: cause instanceof Error ? cause.message : "The sealed worktree snapshot is invalid.",
      }),
  })
}

/**
 * Minimal location-bound worker seam. It owns the durable control lease and
 * only hands a sealed snapshot plus opaque capabilities to the real executor.
 * There is deliberately no adapter for Worktree's legacy Prepared/actionID
 * methods here.
 */
export const makeGeneric = <S, Scope, E>(input: {
  readonly durable: DurableRun.Interface
  readonly gateway: ActionGateway.Interface
  readonly codec: SnapshotCodec<S, Scope>
  readonly executor: GenericSealedExecutor<S, E>
  /** Unknown post-handoff outcomes must pause for manual recovery, never fail as if no side effect occurred. */
  readonly pauseOnExecutorError?: (error: unknown) => boolean
  readonly ownerID: string
  readonly leaseTtlMs: number
  /**
   * Hard wall-clock bound for approval plus execution. The durable lease must
   * outlive this deadline, so a replacement can never acquire the run while
   * the old gateway/executor fiber is still allowed to make progress.
   */
  readonly executionDeadlineMs?: number
  readonly scope: (run: AgentRuntime.ControlRun) => Effect.Effect<Scope, SnapshotMismatchError>
}): Interface<E> => {
  const execute = Effect.fn("WorktreeControlWorker.execute")(function* (runID: AgentRuntime.RunID) {
    const initial = yield* input.durable.load(runID)
    if (!("subject" in initial.run))
      return yield* new SnapshotMismatchError({
        runID,
        reason: "Only a control run can be executed by the worktree worker.",
      })
    if (terminal(initial.run.status)) return

    const executionDeadlineMs =
      input.executionDeadlineMs ?? Math.min(initial.run.budget.maxDurationMs, input.leaseTtlMs - 1)
    if (
      !Number.isSafeInteger(executionDeadlineMs) ||
      executionDeadlineMs <= 0 ||
      !Number.isSafeInteger(input.leaseTtlMs) ||
      input.leaseTtlMs <= executionDeadlineMs
    )
      return yield* new InvalidExecutionWindowError({
        leaseTtlMs: input.leaseTtlMs,
        executionDeadlineMs,
      })

    const expectedScope = yield* input.scope(initial.run)
    const rebuilt = yield* decodeAndVerify(initial.run, expectedScope, input.codec)
    const acquired = yield* input.durable.acquireControlLease({
      runID,
      ownerID: input.ownerID,
      ttlMs: input.leaseTtlMs,
    })
    const leaseState = yield* SynchronizedRef.make({
      capability: acquired.capability,
      snapshot: acquired.snapshot,
    })
    let current = acquired.snapshot
    if (terminal(current.run.status)) return

    const transition = (to: AgentRuntime.RunStatus, reason: string) =>
      SynchronizedRef.modifyEffect(leaseState, (state) =>
        input.durable
          .transitionControl(state.capability, { runID, to, reason })
          .pipe(Effect.map((snapshot) => [snapshot, { capability: state.capability, snapshot }] as const)),
      ).pipe(Effect.uninterruptible)
    const finishAttempt = (attempt: number, outcome: "completed" | "failed" | "interrupted", durationMs: number) =>
      SynchronizedRef.modifyEffect(leaseState, (state) =>
        input.durable
          .finishControlAttempt(state.capability, {
            runID,
            attempt,
            outcome,
            durationMs,
            costMicros: 0,
            tokens: 0,
          })
          .pipe(Effect.map((snapshot) => [snapshot, { capability: state.capability, snapshot }] as const)),
      ).pipe(Effect.uninterruptible)
    const beginAttempt = () =>
      SynchronizedRef.modifyEffect(leaseState, (state) =>
        input.durable
          .beginControlAttempt(state.capability, { runID })
          .pipe(Effect.map((snapshot) => [snapshot, { capability: state.capability, snapshot }] as const)),
      ).pipe(Effect.uninterruptible)
    const heartbeat = () =>
      SynchronizedRef.modifyEffect(leaseState, (state) =>
        input.durable
          .heartbeatControl(state.capability, {
            runID,
            ttlMs: input.leaseTtlMs,
          })
          .pipe(
            Effect.map(
              (renewed) => [renewed.snapshot, { capability: renewed.capability, snapshot: renewed.snapshot }] as const,
            ),
          ),
      ).pipe(Effect.uninterruptible)
    const refresh = Effect.fnUntraced(function* () {
      const latest = yield* input.durable.load(runID)
      if (!("subject" in latest.run))
        return yield* new SnapshotMismatchError({
          runID,
          reason: "The control run resolved to a session run while projecting its outcome.",
        })
      current = latest as DurableRun.ControlSnapshot
      yield* SynchronizedRef.update(leaseState, (state) => ({ ...state, snapshot: current }))
      return current
    })
    const project = Effect.fnUntraced(function* (
      to: Extract<AgentRuntime.RunStatus, "failed" | "paused">,
      reason: string,
    ) {
      yield* refresh()
      // An explicit cancellation may win while ActionGateway is returning a
      // typed BlockedError. Never overwrite that terminal durable decision.
      if (terminal(current.run.status) || current.run.status === "paused") return
      if (current.activeAttempt !== undefined) {
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        current = yield* finishAttempt(
          current.activeAttempt.attempt,
          "interrupted",
          Math.max(0, now - DateTime.toEpochMillis(current.activeAttempt.startedAt)),
        )
      }
      yield* transition(to, reason)
    })
    const failAfterProjection = <A>(
      error: A,
      to: Extract<AgentRuntime.RunStatus, "failed" | "paused">,
      reason: string,
    ) => project(to, reason).pipe(Effect.andThen(Effect.fail(error)))
    const release = () =>
      SynchronizedRef.get(leaseState).pipe(
        Effect.flatMap((state) =>
          input.durable.releaseControlLease(state.capability, {
            runID,
            reason: "Control worktree worker stopped",
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Control worktree worker could not release its durable lease; expiry remains recoverable", {
            runID,
            cause,
          }),
        ),
      )

    return yield* Effect.ensuring(
      Effect.gen(function* () {
        // A previous worker may have died after the side effect began.  Without
        // a persisted successful observation we stop for manual recovery;
        // executing a destructive worktree operation again would be unsafe.
        if (["running", "recovering", "verifying"].includes(current.run.status)) {
          if (current.run.status === "running" && current.activeAttempt !== undefined) {
            const now = DateTime.toEpochMillis(yield* DateTime.now)
            const durationMs = Math.max(0, now - DateTime.toEpochMillis(current.activeAttempt.startedAt))
            current = yield* finishAttempt(current.activeAttempt.attempt, "interrupted", durationMs)
          }
          if (current.run.status === "running")
            current = yield* transition("recovering", "Worker restart requires durable recovery")
          if (["recovering", "verifying"].includes(current.run.status))
            current = yield* transition("paused", "No sealed execution outcome is available")
          return yield* new RecoveryPausedError({
            runID,
            reason: "The previous worktree execution has no durable completion proof.",
          })
        }

        if (current.run.status === "draft") {
          current = yield* transition("preflight", "Sealed worktree snapshot passed worker verification")
        }
        if (current.run.status === "preflight") {
          current = yield* transition("awaiting_authorization", "Awaiting fresh ActionGateway authorization")
        }

        if (!["awaiting_authorization", "queued"].includes(current.run.status))
          return yield* new RecoveryPausedError({
            runID,
            reason: `Control run is not executable from durable state ${current.run.status}.`,
          })

        const controlLeaseValidated = yield* Deferred.make<void>()
        const deadlineReached = yield* Deferred.make<void>()
        const body = (authorization: ActionGateway.AuthorizationGrantCapability) =>
          Effect.gen(function* () {
            // Gateway has completed its final run-capability revalidation
            // before invoking the body. Rotate once at this explicit handoff
            // so the executor starts with a fresh full-TTL capability.
            current = yield* heartbeat()
            if (current.run.status === "awaiting_authorization")
              current = yield* transition("queued", "ActionGateway issued the fresh authorization grant")
            if (current.run.status !== "queued")
              return yield* new RecoveryPausedError({
                runID,
                reason: `Gateway handoff expected queued state, found ${current.run.status}.`,
              })
            current = yield* transition("running", "Sealed worktree executor started")
            const started = yield* beginAttempt()
            current = started
            const startedAt = DateTime.toEpochMillis(yield* DateTime.now)
            const executorLease = (yield* SynchronizedRef.get(leaseState)).capability
            const outcome = yield* input.executor
              .execute({
                snapshot: rebuilt.snapshot,
                runID,
                actionID: rebuilt.input.actionID,
                controlLease: executorLease,
                authorization,
                controlLeaseValidated: () => Deferred.succeed(controlLeaseValidated, undefined),
              })
              .pipe(Effect.exit)
            const durationMs = Math.max(0, DateTime.toEpochMillis(yield* DateTime.now) - startedAt)
            if (outcome._tag === "Failure") {
              const interrupted = Cause.hasInterruptsOnly(outcome.cause)
              const requiresRecovery = outcome.cause.reasons
                .filter(Cause.isFailReason)
                .some((reason) => input.pauseOnExecutorError?.(reason.error) === true)
              current = yield* finishAttempt(
                started.activeAttempt!.attempt,
                interrupted || requiresRecovery ? "interrupted" : "failed",
                durationMs,
              )
              current = yield* transition(
                interrupted || requiresRecovery ? "paused" : "failed",
                interrupted
                  ? "Sealed worktree executor was interrupted"
                  : requiresRecovery
                    ? "Sealed executor outcome requires manual recovery"
                    : "Sealed worktree executor failed",
              )
              return yield* Effect.failCause(outcome.cause)
            }
            current = yield* finishAttempt(started.activeAttempt!.attempt, "completed", durationMs)
            current = yield* transition("verifying", "Sealed worktree executor completed")
          })

        // `runLease` is intentionally attached only after acquireControlLease.
        // It is opaque and omitted from the persisted intent digest, while the
        // gateway revalidates it before approval, grant issuance, and body.
        const gatewayLease = (yield* SynchronizedRef.get(leaseState)).capability
        const leasedInput = { ...rebuilt.input, runLease: gatewayLease } satisfies ControlGatewayInput
        const gatewayEffect = input.gateway.execute(leasedInput, {
          authorization: rebuilt.authorization,
          execute: body,
        })
        const executeGateway = Effect.acquireUseRelease(
          Effect.gen(function* () {
            const deadlineExpired = yield* Ref.make(false)
            // Detached fibers are intentional. The release below owns their
            // shutdown order, so a parent/app-scope interrupt cannot stop the
            // heartbeat before a slow Gateway/executor cleanup has joined.
            const gatewayFiber = yield* gatewayEffect.pipe(Effect.forkDetach({ startImmediately: true }))

            const heartbeatFiber = yield* Effect.gen(function* () {
              yield* Effect.raceFirst(Deferred.await(controlLeaseValidated), Deferred.await(deadlineReached))
              const intervalMs = Math.max(1, Math.floor(input.leaseTtlMs / 3))
              while (true) {
                const renewed = yield* heartbeat().pipe(Effect.exit)
                if (Exit.isFailure(renewed)) {
                  yield* Effect.logError("Control lease heartbeat failed; interrupting the active worktree Gateway", {
                    runID,
                    cause: renewed.cause,
                  })
                  yield* Fiber.interrupt(gatewayFiber).pipe(Effect.forkDetach({ startImmediately: true }))
                  yield* Effect.sleep("1 second")
                  continue
                }
                yield* Effect.sleep(`${intervalMs} millis`)
              }
            }).pipe(Effect.forkDetach({ startImmediately: true }))

            // Do not use timeoutOrElse here: it joins the interrupted loser
            // before its fallback can renew the lease. This sibling first
            // opens the heartbeat path, then waits for full Gateway cleanup.
            const deadlineFiber = yield* Effect.gen(function* () {
              yield* Effect.sleep(`${executionDeadlineMs} millis`)
              yield* Ref.set(deadlineExpired, true)
              yield* Deferred.succeed(deadlineReached, undefined)
              yield* Fiber.interrupt(gatewayFiber)
            }).pipe(Effect.forkDetach({ startImmediately: true }))

            return { gatewayFiber, heartbeatFiber, deadlineFiber, deadlineExpired }
          }),
          ({ gatewayFiber, deadlineExpired }) =>
            Effect.gen(function* () {
              const exit = yield* Fiber.await(gatewayFiber)
              return { exit, deadlineExpired: yield* Ref.get(deadlineExpired) }
            }),
          ({ gatewayFiber, heartbeatFiber, deadlineFiber }) =>
            Effect.gen(function* () {
              // On an external parent interrupt, start renewal before asking
              // the Gateway to stop. Fiber.interrupt waits for all of its
              // uninterruptible cleanup while the detached heartbeat remains
              // alive. Only then are the timer and heartbeat themselves joined.
              if (gatewayFiber.pollUnsafe() === undefined) {
                yield* Deferred.succeed(deadlineReached, undefined)
                yield* Fiber.interrupt(gatewayFiber)
              }
              yield* Fiber.interrupt(deadlineFiber)
              yield* Fiber.interrupt(heartbeatFiber)
            }),
        ).pipe(
          Effect.flatMap(({ exit, deadlineExpired }) =>
            Effect.gen(function* () {
              if (deadlineExpired)
                return yield* new ExecutionDeadlineExceededError({
                  runID,
                  deadlineMs: executionDeadlineMs,
                })
              return yield* exit
            }),
          ),
          Effect.catch((error) => {
            const projection = gatewayFailureProjection(error)
            return projection ? failAfterProjection(error, projection.to, projection.reason) : Effect.fail(error)
          }),
        )
        yield* executeGateway
        current = (yield* SynchronizedRef.get(leaseState)).snapshot
        if (current.run.status !== "verifying")
          return yield* new RecoveryPausedError({
            runID,
            reason: `Gateway settled but the ControlRun is in ${current.run.status}, not verifying.`,
          })
        current = yield* transition("completed", "ActionGateway settled the sealed worktree execution")
      }),
      release(),
    )
  })
  return { execute }
}

/** Existing Worktree entry point, retained while sharing the generic worker core. */
export const make = <E>(input: {
  readonly durable: DurableRun.Interface
  readonly gateway: ActionGateway.Interface
  readonly executor: SealedExecutor<E>
  readonly ownerID: string
  readonly leaseTtlMs: number
  readonly executionDeadlineMs?: number
  readonly scope: (run: AgentRuntime.ControlRun) => Effect.Effect<WorktreeSnapshot.Scope, SnapshotMismatchError>
}): Interface<E> =>
  makeGeneric({
    ...input,
    codec: {
      decode: WorktreeSnapshot.decode,
      actionMaterial: WorktreeSnapshot.actionMaterial,
      authorizationPlan: WorktreeSnapshot.authorizationPlan,
    },
  })
