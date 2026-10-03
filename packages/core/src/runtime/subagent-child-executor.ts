/**
 * Canonical durable child execution boundary.
 *
 * The Core SubagentProvider owns the provider adapter's ephemeral execution
 * lease, while DurableRun owns the durable child aggregate, attempt usage,
 * semantic checkpoint and result settlement.  This service is the single
 * orchestration seam joining those two authorities.  Product/tool adapters
 * only supply child-session usage and the actual prompt operation; they do
 * not implement a second child state machine.
 */

export * as SubagentChildExecutor from "./subagent-child-executor"

import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { makeLocationNode } from "../effect/app-node"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DurableRun } from "./durable-run"
import { SubagentProvider } from "./subagent-provider"
import { canonicalHash } from "../util/canonical-hash"
import * as SessionCheckpoint from "../session/checkpoint"

export interface UsageSnapshot {
  readonly costMicros: number
  readonly tokens: number
}

export interface ChildExecution {
  readonly attempt: number
  readonly startedAtMs: number
  readonly timeoutMs: number
  /** Session usage is cumulative; this is the exact persisted baseline. */
  readonly costMicrosBefore: number
  readonly tokensBefore: number
  readonly ownerID: string
  readonly leaseID: AgentRuntime.LeaseID
}

export type TerminalChild = {
  readonly kind: "terminal"
  readonly status: "completed" | "failed" | "cancelled"
  readonly summary: string
}

export type ActiveChild = {
  readonly kind: "active"
  readonly execution: ChildExecution
}

export type PreparedChild = TerminalChild | ActiveChild

/**
 * Provider input deliberately excludes epoch and continuation.  The service
 * binds both to the newly persisted DurableRun attempt so a caller cannot
 * replay a provider epoch or attach a cursor to another child.
 */
export type ProviderInput = Readonly<{
  provider: SubagentProvider.Kind
  executionID: string
  sessionID: string
  modelID: string
  modelProviderID: string
  childRunID?: string
  parentRunID?: string
}>

export type ExecuteInput<A, E, R> = Readonly<{
  childRunID: AgentRuntime.RunID
  sessionID: string
  readUsage: () => Effect.Effect<UsageSnapshot, unknown>
  /** Provider adapter metadata; omit to retain the direct operation fallback. */
  provider?: ProviderInput
  /** Required when a provider cursor is persisted in the DurableRun checkpoint. */
  permissionDigest?: string
  /** Re-reads the child session permission contract before provider dispatch. */
  readPermissionDigest?: () => Effect.Effect<string | undefined, unknown>
  /** Prompt/input accounting observed by the product adapter after the operation. */
  promptTokens?: () => number
  /** Existing Evidence owner references carried into the terminal result receipt. */
  resultEvidenceRefs?: ReadonlyArray<AgentRuntime.EvidenceID>
  /** The only product-specific effect. It receives the durable attempt handle. */
  operation: (execution: ChildExecution) => Effect.Effect<A, E, R>
  /** Converts a previously completed child into the tool's output without replay. */
  onTerminal: (terminal: TerminalChild) => Effect.Effect<A, E, R>
  summarizeSuccess: (value: A) => string
  summarizeFailure: (cause: Cause.Cause<E>) => string
  ownerID?: string
  leaseTTLms?: number
}>

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "SubagentChildExecutor.InvalidInputError",
  { runID: AgentRuntime.RunID, reason: Schema.String },
) {}

export class SettlementIncompleteError extends Schema.TaggedErrorClass<SettlementIncompleteError>()(
  "SubagentChildExecutor.SettlementIncompleteError",
  { runID: AgentRuntime.RunID, status: Schema.Literals(["completed", "failed"]), reason: Schema.String },
) {}

/** Revalidate an existing child attempt without acquiring a lease or starting another run. */
export const validateExecution = Effect.fn("SubagentChildExecutor.validateExecution")(function* (input: {
  readonly childRunID: AgentRuntime.RunID
  readonly sessionID: string
  readonly execution: Pick<ChildExecution, "attempt" | "ownerID" | "leaseID">
}) {
  const durable = yield* DurableRun.Service
  const snapshot = yield* durable.validateLease({
    runID: input.childRunID,
    leaseID: input.execution.leaseID,
    ownerID: input.execution.ownerID,
  })
  if (
    !("child" in snapshot.run) ||
    !snapshot.run.child ||
    !("sessionID" in snapshot.run) ||
    snapshot.run.sessionID !== input.sessionID ||
    snapshot.run.status !== "running" ||
    snapshot.activeAttempt?.attempt !== input.execution.attempt
  )
    return yield* new InvalidInputError({
      runID: input.childRunID,
      reason: "child execution no longer matches its session, running state, or active attempt",
    })
  return snapshot
})

export interface Interface {
  /** Prepare one deterministic child attempt, recovering an interrupted one. */
  readonly prepare: (input: {
    readonly childRunID: AgentRuntime.RunID
    readonly sessionID: string
    readonly readUsage: () => Effect.Effect<UsageSnapshot, unknown>
    readonly ownerID?: string
    readonly leaseTTLms?: number
  }) => Effect.Effect<PreparedChild, unknown>
  /** Prepare, execute through the Core provider, and settle exactly once. */
  readonly execute: <A, E, R>(input: ExecuteInput<A, E, R>) => Effect.Effect<A, E | unknown, R>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SubagentChildExecutor") {}

const childTerminal = (status: AgentRuntime.RunStatus): status is TerminalChild["status"] =>
  status === "completed" || status === "failed" || status === "cancelled"

const sessionUsage = (value: UsageSnapshot): UsageSnapshot => ({
  costMicros: Number.isSafeInteger(value.costMicros) ? Math.max(0, value.costMicros) : 0,
  tokens: Number.isSafeInteger(value.tokens) ? Math.max(0, value.tokens) : 0,
})

const boundedAttemptUsage = (run: AgentRuntime.SessionRun, input: UsageSnapshot & { readonly durationMs: number }) => ({
  durationMs: Math.max(0, Math.min(input.durationMs, run.budget.maxDurationMs - run.budget.durationMsUsed)),
  costMicros: Math.max(0, Math.min(input.costMicros, run.budget.maxCostMicros - run.budget.costMicrosUsed)),
  tokens: Math.max(0, Math.min(input.tokens, run.budget.maxTokens - run.budget.tokensUsed)),
})

const providerUsageTokenTotal = (usage: SubagentProvider.Usage | undefined) =>
  usage === undefined
    ? 0
    : Math.max(
        0,
        Math.round(
          usage.inputTokens +
            usage.outputTokens +
            usage.reasoningTokens +
            usage.cacheReadTokens +
            usage.cacheWriteTokens,
        ),
      )

const failureText = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).slice(0, 16_000)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const durable = yield* DurableRun.Service
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(SubagentProvider.Service))

    const loadChild = Effect.fn("SubagentChildExecutor.loadChild")(function* (
      runID: AgentRuntime.RunID,
      sessionID?: string,
    ) {
      const snapshot = yield* durable.load(runID)
      if (
        !("child" in snapshot.run) ||
        !snapshot.run.child ||
        !("sessionID" in snapshot.run) ||
        (sessionID !== undefined && snapshot.run.sessionID !== sessionID)
      )
        return yield* new InvalidInputError({
          runID,
          reason: "requested run is not a durable child bound to the supplied session",
        })
      return snapshot as DurableRun.ChildSnapshot
    })

    const prepare: Interface["prepare"] = Effect.fn("SubagentChildExecutor.prepare")(function* (input) {
      let current = yield* loadChild(input.childRunID, input.sessionID)
      if (childTerminal(current.run.status)) {
        if (current.run.status !== "cancelled" && !current.run.childResult) {
          const intent = yield* durable.readChildSettlementIntent({
            parentRunID: current.run.child.parentRunID,
            childRunID: current.run.id,
          })
          if (!intent)
            return yield* new SettlementIncompleteError({
              runID: current.run.id,
              status: current.run.status,
              reason:
                "Child execution ended but its durable result receipt is missing; reconcile settlement before delivering the result. The operation was not replayed.",
            })
          const ownerID = input.ownerID ?? `core-child-settlement-${process.pid}-${randomUUID()}`
          current = yield* Effect.acquireUseRelease(
            durable.acquireLease({
              runID: current.run.id,
              ownerID,
              reuseExisting: false,
              ttlMs: input.leaseTTLms ?? 30_000,
            }),
            (owned) =>
              durable.recordChildResult({
                runID: input.childRunID,
                execution: { attempt: owned.run.budget.attemptsUsed, ownerID, leaseID: owned.lease!.id },
                result: {
                  status: intent.status,
                  summary: intent.summary,
                  artifactRefs: intent.artifactRefs,
                  evidenceRefs: intent.evidenceRefs,
                  usage: intent.usage,
                },
                ...(intent.admissionEvidence ? { admissionEvidence: intent.admissionEvidence } : {}),
              }),
            (owned) =>
              durable
                .releaseLease({
                  runID: input.childRunID,
                  ownerID,
                  leaseID: owned.lease!.id,
                  reason: "child settlement recovery finished",
                })
                .pipe(Effect.catchTag("DurableRun.LeaseMismatchError", () => Effect.void)),
          )
        }
        if (!childTerminal(current.run.status))
          return yield* new InvalidInputError({
            runID: current.run.id,
            reason: "Recovered child settlement is not terminal",
          })
        return {
          kind: "terminal",
          status: current.run.status,
          summary: current.run.childResult?.summary ?? "",
        } satisfies TerminalChild
      }

      if (current.run.status === "draft") {
        yield* durable.transition({ runID: current.run.id, to: "preflight", reason: "child preflight" })
        current = yield* loadChild(current.run.id)
      }
      if (current.run.status === "preflight") {
        yield* durable.transition({ runID: current.run.id, to: "queued", reason: "child queued" })
        current = yield* loadChild(current.run.id)
      }
      if (current.run.status === "paused") {
        yield* durable.transition({ runID: current.run.id, to: "queued", reason: "child resumed" })
        current = yield* loadChild(current.run.id)
      }

      // Ownership identifies this invocation, not every caller in a process.
      // Reusing a process/run owner would let another call "recover" a live
      // attempt because acquireLease is idempotent for the same owner.
      const ownerID = input.ownerID ?? `core-child-${process.pid}-${current.run.id}-${randomUUID()}`
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const leased = yield* durable.acquireLease({
            runID: current.run.id,
            ownerID,
            reuseExisting: false,
            ttlMs: input.leaseTTLms ?? Math.max(30_000, current.run.budget.maxDurationMs + 5_000),
          })
          current = leased as DurableRun.ChildSnapshot
          return yield* restore(
            Effect.gen(function* () {
              // A process restart can leave the active attempt open.  Close it using
              // the persisted baseline before beginning a new deterministic attempt.
              if (current.activeAttempt) {
                const now = yield* DateTime.now
                const observed = sessionUsage(yield* input.readUsage())
                const baseline = current.activeAttempt.usageBaseline ?? { costMicros: 0, tokens: 0 }
                const recoveredUsage = boundedAttemptUsage(current.run, {
                  durationMs: Math.max(
                    0,
                    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(current.activeAttempt.startedAt),
                  ),
                  costMicros: Math.max(0, observed.costMicros - baseline.costMicros),
                  tokens: Math.max(0, observed.tokens - baseline.tokens),
                })
                yield* durable.finishAttempt({
                  runID: current.run.id,
                  attempt: current.activeAttempt.attempt,
                  execution: {
                    attempt: current.activeAttempt.attempt,
                    leaseID: leased.lease!.id,
                    ownerID,
                  },
                  outcome: "interrupted",
                  ...recoveredUsage,
                })
                current = yield* loadChild(current.run.id)
              }
              if (current.run.status === "running") {
                yield* durable.transition({ runID: current.run.id, to: "recovering", reason: "child recovered" })
                current = yield* loadChild(current.run.id)
              }
              if (current.run.status === "recovering") {
                yield* durable.transition({ runID: current.run.id, to: "running", reason: "child worker started" })
                current = yield* loadChild(current.run.id)
              }
              if (current.run.status === "queued") {
                yield* durable.transition({ runID: current.run.id, to: "running", reason: "child worker started" })
                current = yield* loadChild(current.run.id)
              }

              const baseline = sessionUsage(yield* input.readUsage())
              const started = yield* durable.beginAttempt({
                runID: current.run.id,
                usageBaseline: AgentRuntime.RunUsageBaseline.make(baseline),
              })
              const attempt = started.activeAttempt?.attempt
              if (attempt === undefined)
                return yield* new InvalidInputError({ runID: current.run.id, reason: "child attempt was not recorded" })
              const deadlineRemaining = current.run.child.deadlineAt
                ? DateTime.toEpochMillis(current.run.child.deadlineAt) - Date.now()
                : Number.MAX_SAFE_INTEGER
              const timeoutMs = Math.max(
                1,
                Math.min(current.run.budget.maxDurationMs - current.run.budget.durationMsUsed, deadlineRemaining),
              )
              return {
                kind: "active",
                execution: {
                  attempt,
                  startedAtMs: Date.now(),
                  timeoutMs,
                  costMicrosBefore: baseline.costMicros,
                  tokensBefore: baseline.tokens,
                  ownerID,
                  leaseID: current.lease?.id ?? leased.lease!.id,
                },
              } satisfies ActiveChild
            }),
          ).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : durable
                    .releaseLease({
                      runID: leased.run.id,
                      leaseID: leased.lease!.id,
                      ownerID,
                      reason: "child preparation failed",
                    })
                    .pipe(Effect.catchTag("DurableRun.LeaseMismatchError", () => Effect.void)),
            ),
          )
        }),
      )
    })

    const execute: Interface["execute"] = <A, E, R>(input: ExecuteInput<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const childBeforePrepare = yield* loadChild(input.childRunID, input.sessionID)
          let verifiedPermissionDigest: string | undefined
          if (input.provider) {
            const expectedParentRunID = String(childBeforePrepare.run.child.parentRunID)
            if (input.provider.executionID !== String(input.childRunID))
              return yield* new InvalidInputError({
                runID: input.childRunID,
                reason: "provider execution identity does not match the durable child",
              })
            if (input.provider.sessionID !== input.sessionID)
              return yield* new InvalidInputError({
                runID: input.childRunID,
                reason: "provider session identity does not match the durable child",
              })
            if (input.provider.childRunID !== undefined && input.provider.childRunID !== String(input.childRunID))
              return yield* new InvalidInputError({
                runID: input.childRunID,
                reason: "provider child identity does not match the durable child",
              })
            if (input.provider.parentRunID !== expectedParentRunID)
              return yield* new InvalidInputError({
                runID: input.childRunID,
                reason: "provider parent identity does not match the durable child",
              })
            if (!input.permissionDigest)
              return yield* new InvalidInputError({
                runID: input.childRunID,
                reason: "provider execution requires a child permission digest",
              })
            verifiedPermissionDigest = input.readPermissionDigest
              ? yield* restore(input.readPermissionDigest())
              : undefined
            if (!verifiedPermissionDigest || verifiedPermissionDigest !== input.permissionDigest)
              return yield* new InvalidInputError({
                runID: input.childRunID,
                reason: "child permission digest changed before provider dispatch",
              })
          }
          // Provider epochs rotate on recovery; semantic loop progress must
          // survive that rotation. Validate before acquiring a new attempt.
          if (provider && input.provider) {
            const previous = yield* loadChild(input.childRunID)
            if (previous.checkpoint) {
              // Product admission metadata shares this container; rotating the
              // provider cursor must not erase its frozen recovery contract.
              yield* Effect.try({
                try: () => SessionCheckpoint.fromContainer(previous.checkpoint!.state, input.sessionID),
                catch: () =>
                  new InvalidInputError({ runID: input.childRunID, reason: "Invalid semantic child checkpoint" }),
              })
            }
          }
          const prepared = yield* prepare({
            childRunID: input.childRunID,
            sessionID: input.sessionID,
            // External usage reads may wait indefinitely. Keep preparation's
            // lease handoff masked, but let cancellation reach its cleanup.
            readUsage: () => restore(input.readUsage()),
            ...(input.ownerID === undefined ? {} : { ownerID: input.ownerID }),
            ...(input.leaseTTLms === undefined ? {} : { leaseTTLms: input.leaseTTLms }),
          })
          if (prepared.kind === "terminal") return yield* input.onTerminal(prepared)

          const execution = prepared.execution
          let handedOff = false
          return yield* Effect.gen(function* () {
            let continuation: SubagentProvider.ContinuationCursor | undefined
            let permissionDigest = input.permissionDigest
            const persistContinuation = (next: SubagentProvider.ContinuationCursor) =>
              Effect.gen(function* () {
                if (!permissionDigest)
                  return yield* new InvalidInputError({
                    runID: input.childRunID,
                    reason: "provider continuation requires a child permission digest",
                  })
                const current = yield* loadChild(input.childRunID)
                if (!current.checkpoint)
                  return yield* new InvalidInputError({
                    runID: input.childRunID,
                    reason: "provider progress has no DurableRun checkpoint",
                  })
                const state = SubagentProvider.advanceContinuationCheckpointState(current.checkpoint.state, next, {
                  attempt: execution.attempt,
                  leaseID: execution.leaseID,
                  leaseOwnerID: execution.ownerID,
                  permissionDigest,
                })
                if (state !== current.checkpoint.state)
                  yield* durable
                    .checkpoint({
                      runID: input.childRunID,
                      execution,
                      state: (latest) => {
                        if (!latest) throw new Error("Provider progress checkpoint disappeared")
                        return SubagentProvider.advanceContinuationCheckpointState(latest, next, {
                          attempt: execution.attempt,
                          leaseID: execution.leaseID,
                          leaseOwnerID: execution.ownerID,
                          permissionDigest: permissionDigest!,
                        })
                      },
                    })
                    .pipe(Effect.orDie)
                continuation = next
              })

            if (provider && input.provider) {
              if (!permissionDigest)
                return yield* new InvalidInputError({
                  runID: input.childRunID,
                  reason: "provider execution requires a child permission digest",
                })
              const currentPermissionDigest = verifiedPermissionDigest ?? permissionDigest
              const outputDigest = canonicalHash({
                schemaVersion: 1,
                provider: input.provider.provider,
                executionID: input.provider.executionID,
                epoch: execution.attempt,
              })
              if (!outputDigest)
                return yield* new InvalidInputError({
                  runID: input.childRunID,
                  reason: "provider digest is not hashable",
                })
              const seed = SubagentProvider.makeContinuationCursor({
                provider: input.provider.provider,
                executionID: input.provider.executionID,
                epoch: execution.attempt,
                outputDigest,
              })
              const state = SubagentProvider.bindContinuationCheckpointState(
                {
                  phase: "subagent-provider",
                  provider: input.provider.provider,
                  executionID: input.provider.executionID,
                  epoch: execution.attempt,
                },
                seed,
                {
                  attempt: execution.attempt,
                  leaseID: execution.leaseID,
                  leaseOwnerID: execution.ownerID,
                  permissionDigest,
                },
              )
              yield* durable
                .checkpoint({
                  runID: input.childRunID,
                  execution,
                  state: (latest) => {
                    const sessionLoop = latest ? SessionCheckpoint.fromContainer(latest, input.sessionID) : undefined
                    return { ...latest, ...state, ...(sessionLoop ? { sessionLoop: { ...sessionLoop } } : {}) }
                  },
                })
                .pipe(Effect.orDie, restore)
              const current = yield* loadChild(input.childRunID)
              if (!current.checkpoint)
                return yield* new InvalidInputError({
                  runID: input.childRunID,
                  reason: "child checkpoint was not persisted",
                })
              const checkpoint = SubagentProvider.readContinuationCheckpointState(current.checkpoint.state, {
                provider: input.provider.provider,
                executionID: input.provider.executionID,
                epoch: execution.attempt,
              })
              const now = yield* DateTime.now
              const revalidationError = SubagentProvider.validateContinuationCheckpointRevalidation({
                expected: {
                  provider: input.provider.provider,
                  executionID: input.provider.executionID,
                  epoch: execution.attempt,
                },
                checkpoint,
                activeAttempt: current.activeAttempt?.attempt,
                lease: current.lease
                  ? {
                      runID: current.lease.runID,
                      leaseID: current.lease.id,
                      ownerID: current.lease.ownerID,
                      expiresAtMs: DateTime.toEpochMillis(current.lease.expiresAt),
                    }
                  : undefined,
                expectedLeaseID: execution.leaseID,
                expectedLeaseOwnerID: execution.ownerID,
                expectedPermissionDigest: permissionDigest,
                currentPermissionDigest,
                nowMs: DateTime.toEpochMillis(now),
              })
              if (revalidationError)
                return yield* new InvalidInputError({ runID: input.childRunID, reason: revalidationError })
              continuation = checkpoint.cursor
            }

            const operation = validateExecution({
              childRunID: input.childRunID,
              sessionID: input.sessionID,
              execution,
            }).pipe(
              Effect.andThen(Effect.suspend(() => input.operation(execution))),
              Effect.provideService(DurableRun.Service, durable),
            )
            const providerOperation =
              provider && input.provider
                ? provider.execute(
                    {
                      ...input.provider,
                      epoch: execution.attempt,
                      ...(input.childRunID ? { childRunID: String(input.childRunID) } : {}),
                      ...(input.provider.parentRunID ? { parentRunID: input.provider.parentRunID } : {}),
                      ...(input.provider.parentRunID ? {} : {}),
                      ...(continuation === undefined ? {} : { continuation }),
                    },
                    operation,
                    {
                      onEvent: (_event, next) => (next === undefined ? Effect.void : persistContinuation(next)),
                    },
                  )
                : operation
            // The operation can be silent (for example an open provider stream).
            // Reuse the durable authority check without renewing or reacquiring
            // its lease. A lost owner must interrupt its in-flight work, not wait
            // for output or the entire task budget before noticing takeover.
            const ownership = Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep("1 second")
                yield* validateExecution({
                  childRunID: input.childRunID,
                  sessionID: input.sessionID,
                  execution,
                })
              }
            }).pipe(Effect.provideService(DurableRun.Service, durable))
            handedOff = true
            const exit = yield* Effect.exit(
              restore(Effect.timeout(Effect.raceFirst(providerOperation, ownership), execution.timeoutMs)),
            )
            yield* settle({
              input: input as ExecuteInput<A, E, unknown>,
              execution,
              exit: exit as Exit.Exit<A, E>,
            })
            return yield* Exit.match(exit, {
              onFailure: (cause) => Effect.failCause(cause),
              onSuccess: Effect.succeed,
            })
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) || handedOff
                ? Effect.void
                : durable
                    .releaseLease({
                      runID: input.childRunID,
                      leaseID: execution.leaseID,
                      ownerID: execution.ownerID,
                      reason: "child provider initialization failed",
                    })
                    .pipe(Effect.catchTag("DurableRun.LeaseMismatchError", () => Effect.void)),
            ),
          )
        }),
      )

    const settle = <A, E>(input: {
      readonly input: ExecuteInput<A, E, unknown>
      readonly execution: ChildExecution
      readonly exit: Exit.Exit<A, E>
    }) =>
      Effect.gen(function* () {
        // A stale worker must not finish a replacement attempt or mutate its
        // provider checkpoint. Validate before starting settlement writes.
        yield* validateExecution({
          childRunID: input.input.childRunID,
          sessionID: input.input.sessionID,
          execution: input.execution,
        }).pipe(Effect.provideService(DurableRun.Service, durable))
        let current = yield* loadChild(input.input.childRunID)
        const projection =
          provider && input.input.provider
            ? yield* provider.inspect({
                executionID: input.input.provider?.executionID ?? String(input.input.childRunID),
                provider: input.input.provider?.provider,
              })
            : undefined
        if (projection?.continuation && projection.epoch === input.execution.attempt && current.checkpoint) {
          const digest = input.input.permissionDigest
          if (!digest)
            return yield* new InvalidInputError({
              runID: input.input.childRunID,
              reason: "missing permission digest at settlement",
            })
          const state = SubagentProvider.advanceContinuationCheckpointState(
            current.checkpoint.state,
            projection.continuation,
            {
              attempt: input.execution.attempt,
              leaseID: input.execution.leaseID,
              leaseOwnerID: input.execution.ownerID,
              permissionDigest: digest,
            },
          )
          if (state !== current.checkpoint.state)
            yield* durable
              .checkpoint({
                runID: input.input.childRunID,
                execution: input.execution,
                state: (latest) => {
                  if (!latest) throw new Error("Provider settlement checkpoint disappeared")
                  return SubagentProvider.advanceContinuationCheckpointState(latest, projection.continuation!, {
                    attempt: input.execution.attempt,
                    leaseID: input.execution.leaseID,
                    leaseOwnerID: input.execution.ownerID,
                    permissionDigest: digest,
                  })
                },
              })
              .pipe(Effect.orDie)
          current = yield* loadChild(input.input.childRunID)
        }

        if (current.activeAttempt?.attempt === input.execution.attempt) {
          const after = sessionUsage(yield* input.input.readUsage())
          const interrupted = Exit.isFailure(input.exit) && Cause.hasInterruptsOnly(input.exit.cause)
          const usage = boundedAttemptUsage(current.run, {
            durationMs: Math.max(0, Date.now() - input.execution.startedAtMs),
            costMicros: Math.max(
              0,
              after.costMicros - input.execution.costMicrosBefore,
              projection?.usage?.costMicros ?? 0,
            ),
            tokens: Math.max(
              0,
              after.tokens - input.execution.tokensBefore,
              input.input.promptTokens?.() ?? 0,
              providerUsageTokenTotal(projection?.usage),
            ),
          })
          yield* durable.finishAttempt({
            runID: input.input.childRunID,
            attempt: input.execution.attempt,
            execution: input.execution,
            outcome: Exit.isSuccess(input.exit) ? "completed" : interrupted ? "interrupted" : "failed",
            ...usage,
          })
        }

        current = yield* loadChild(input.input.childRunID)
        if (Exit.isSuccess(input.exit)) {
          if (current.run.status === "running") {
            yield* durable.transition({
              runID: current.run.id,
              to: "verifying",
              reason: "child result verification",
              execution: input.execution,
            })
            current = yield* loadChild(current.run.id)
          }
          if (current.run.status === "verifying")
            yield* durable.transition({
              runID: current.run.id,
              to: "completed",
              reason: "child completed",
              execution: input.execution,
            })
          const settled = yield* loadChild(input.input.childRunID)
          yield* durable.recordChildResult({
            runID: input.input.childRunID,
            execution: input.execution,
            result: {
              status: "completed",
              summary: input.input.summarizeSuccess(input.exit.value).slice(0, 16_000),
              artifactRefs: [],
              evidenceRefs: [...(input.input.resultEvidenceRefs ?? [])],
              usage: {
                attempts: settled.run.budget.attemptsUsed,
                durationMs: settled.run.budget.durationMsUsed,
                costMicros: settled.run.budget.costMicrosUsed,
                tokens: settled.run.budget.tokensUsed,
              },
            },
          })
        } else if (Cause.hasInterruptsOnly(input.exit.cause)) {
          yield* durable.cancelChild({
            parentRunID: current.run.child.parentRunID,
            childRunID: current.run.id,
            reason: "child interrupted",
            recursive: true,
          })
        } else {
          if (current.run.status === "running")
            yield* durable.transition({
              runID: current.run.id,
              to: "failed",
              reason: `child failed: ${failureText(input.exit.cause).slice(0, 1_000)}`,
              execution: input.execution,
            })
          const settled = yield* loadChild(input.input.childRunID)
          yield* durable.recordChildResult({
            runID: input.input.childRunID,
            execution: input.execution,
            result: {
              status: "failed",
              summary: input.input.summarizeFailure(input.exit.cause).slice(0, 16_000),
              artifactRefs: [],
              evidenceRefs: [...(input.input.resultEvidenceRefs ?? [])],
              usage: {
                attempts: settled.run.budget.attemptsUsed,
                durationMs: settled.run.budget.durationMsUsed,
                costMicros: settled.run.budget.costMicrosUsed,
                tokens: settled.run.budget.tokensUsed,
              },
            },
          })
        }
        const after = yield* loadChild(input.input.childRunID)
        if (after.lease?.id === input.execution.leaseID && after.lease.ownerID === input.execution.ownerID)
          yield* durable.releaseLease({
            runID: input.input.childRunID,
            leaseID: input.execution.leaseID,
            ownerID: input.execution.ownerID,
            reason: "child worker finished",
          })
      })

    return Service.of({ prepare, execute })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  // The provider is optional for legacy/unmetered callers.  Keeping it out
  // of the structural dependency list also prevents the provider adapter's
  // construction error from widening every HTTP route's layer error type.
  deps: [DurableRun.node],
})
