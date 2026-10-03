import { AbsolutePath } from "@arforge-ai/core/schema"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import type { ActionGateway } from "@arforge-ai/core/action-gateway"
import type { ToolExecutionProjection } from "@arforge-ai/core/tool/execution-state"
import * as MutationIntentRuntime from "@arforge-ai/core/runtime/mutation-intent"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import {
  LocationServiceMap,
  buildLocationServiceMap,
  locationServiceMapLayer,
} from "@arforge-ai/core/location-services"
import { Location } from "@arforge-ai/core/location"
import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect"
import { createHash } from "node:crypto"
import * as path from "path"
import { InstanceState } from "@/effect/instance-state"

/**
 * Deterministic crash-boundary pause used only by the isolated desktop
 * acceptance.  Production processes never enter this branch because both
 * markers are required; the child process is terminated by the harness while
 * the durable mutation is still in `postprocessing`, before the final
 * settlement checkpoint is appended.
 */
const testMutationBoundaryPause = () =>
  process.env.ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE === "1" &&
  process.env.ARFORGE_TEST_MUTATION_BOUNDARY === "before-settlement"
    ? Effect.sleep("20 seconds")
    : Effect.void

export type MutationConflictMetadata = {
  kind: "file_conflict"
  code: "observed_version_mismatch" | "target_exists"
  path: string
  observedVersion?: string
  currentVersion?: string
}

export type MutationUndo = FileMutation.RollbackInput & { readonly target: FileMutation.Target }

export const digestBytes = (content: Uint8Array) => createHash("sha256").update(content).digest("hex")

export type IntentEntryInput = {
  readonly target: FileMutation.Target
  readonly operation: AgentRuntime.MutationIntentEntry["operation"]
  readonly before?: Uint8Array
  readonly after?: Uint8Array
  readonly recovery: AgentRuntime.MutationIntentEntry["recovery"]
  readonly rollbackArtifact?: AgentRuntime.MutationRollbackArtifact
}

export const intentEntry = (input: IntentEntryInput): AgentRuntime.MutationIntentEntry => ({
  target: input.target.resource,
  operation: input.operation,
  ...(input.before === undefined ? {} : { beforeDigest: digestBytes(input.before) }),
  ...(input.after === undefined
    ? {}
    : { afterDigest: digestBytes(input.after), afterByteLength: input.after.byteLength }),
  ...(input.rollbackArtifact === undefined ? {} : { rollbackArtifact: input.rollbackArtifact }),
  recovery: input.recovery,
})

/**
 * Stage inverse bytes before the durable `prepared` boundary. The artifact
 * store is optional for compatibility runtimes; the production AppLayer
 * supplies it, and any storage failure fails closed before a file mutation.
 */
export const stageIntentEntries = (inputs: ReadonlyArray<IntentEntryInput>) =>
  Effect.gen(function* () {
    const artifactService = yield* Effect.serviceOption(RollbackArtifact.Service)
    const entries: AgentRuntime.MutationIntentEntry[] = []
    for (const input of inputs) {
      const before = input.before
      if (before === undefined || input.operation === "create" || Option.isNone(artifactService)) {
        entries.push(intentEntry(input))
        continue
      }
      const ref = yield* Effect.tryPromise({
        try: () => artifactService.value.store.put(before),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      entries.push(
        intentEntry({
          ...input,
          recovery: input.operation === "write" ? "restore-from-artifact" : input.recovery,
          rollbackArtifact: ref,
        }),
      )
    }
    return entries
  })

export type MutationIntentRecorder = {
  readonly transactionID: AgentRuntime.MutationTransactionID
  readonly entries: ReadonlyArray<AgentRuntime.MutationIntentEntry>
  readonly record: (phase: AgentRuntime.MutationIntentPhase, summary?: string) => Effect.Effect<void, never>
  /** Optional for compatibility test doubles; production recorders persist append-only checkpoints. */
  readonly recordPostProcessingStage?: (
    stage: AgentRuntime.MutationPostProcessingStage,
    status: AgentRuntime.MutationPostProcessingStatus,
    target?: string,
  ) => Effect.Effect<void, never>
}

/**
 * Bind the mature tool's in-process journal to the current durable Action
 * when the SessionTools gateway context is present. Direct tool/unit callers
 * intentionally get no recorder, preserving their compatibility path without
 * creating a second persistence owner.
 */
export const makeIntentRecorder = (input: {
  readonly gateway?: Pick<ActionGateway.Interface, "recordMutationIntent">
  readonly actionID?: AgentRuntime.ActionID
  readonly entries: ReadonlyArray<AgentRuntime.MutationIntentEntry>
}): MutationIntentRecorder | undefined => {
  if (input.gateway === undefined || input.gateway.recordMutationIntent === undefined || input.actionID === undefined)
    return undefined
  const manifestDigest = MutationIntentRuntime.manifestDigest(input.entries)
  if (manifestDigest === undefined) return undefined
  const transactionID = AgentRuntime.MutationTransactionID.create()
  const createdAt = DateTime.makeUnsafe(Date.now())
  let lastUpdatedAt = DateTime.toEpochMillis(createdAt)
  let postProcessing: AgentRuntime.MutationPostProcessingCheckpoint[] = []
  const postProcessingSnapshot = () =>
    postProcessing.length === 0 ? undefined : Object.freeze(postProcessing.map((checkpoint) => ({ ...checkpoint })))
  return {
    transactionID,
    entries: Object.freeze([...input.entries]),
    record: (phase, summary) => {
      const updatedAtMs = Math.max(Date.now(), lastUpdatedAt + 1)
      lastUpdatedAt = updatedAtMs
      const checkpointSnapshot = postProcessingSnapshot()
      return input.gateway!.recordMutationIntent!({
        actionID: input.actionID!,
        transactionID,
        phase,
        entries: input.entries,
        manifestDigest,
        createdAt,
        updatedAt: DateTime.makeUnsafe(updatedAtMs),
        ...(checkpointSnapshot === undefined ? {} : { postProcessing: checkpointSnapshot }),
        ...(summary === undefined ? {} : { summary }),
      }).pipe(Effect.orDie, Effect.asVoid)
    },
    recordPostProcessingStage: (stage, status, target) =>
      Effect.gen(function* () {
        if (status === "started") {
          postProcessing = [
            ...postProcessing,
            {
              sequence: postProcessing.length,
              stage,
              status,
              ...(target === undefined ? {} : { target }),
            },
          ]
        } else {
          const current = postProcessing.at(-1)
          if (
            current === undefined ||
            current.status !== "started" ||
            current.stage !== stage ||
            current.target !== target
          )
            return yield* Effect.die(
              new Error(`Cannot complete mutation post-processing stage ${stage}: no matching started checkpoint.`),
            )
          // Completion is a new immutable fact. Never rewrite the started
          // checkpoint in place: the trailing item remains the exact durable
          // evidence of the stage boundary observed by a restarted worker.
          postProcessing = [
            ...postProcessing,
            {
              sequence: postProcessing.length,
              stage,
              status,
              ...(target === undefined ? {} : { target }),
            },
          ]
        }
        const updatedAtMs = Math.max(Date.now(), lastUpdatedAt + 1)
        lastUpdatedAt = updatedAtMs
        const checkpointSnapshot = postProcessingSnapshot()
        yield* input.gateway!.recordMutationIntent!({
          actionID: input.actionID!,
          transactionID,
          phase: "postprocessing",
          entries: input.entries,
          manifestDigest,
          createdAt,
          updatedAt: DateTime.makeUnsafe(updatedAtMs),
          postProcessing: checkpointSnapshot!,
          summary: `${stage} ${status}`,
        }).pipe(Effect.orDie, Effect.asVoid)
      }),
  }
}

/**
 * Persist a recovery phase without allowing a telemetry/durability failure to
 * interrupt the compensating FileMutation rollback. Strict transaction phases
 * use `record` directly; only recovery breadcrumbs use this best-effort path.
 */
export const recordBestEffort = (
  recorder: MutationIntentRecorder | undefined,
  phase: AgentRuntime.MutationIntentPhase,
  summary: string,
): Effect.Effect<void> =>
  recorder === undefined ? Effect.void : Effect.exit(recorder.record(phase, summary)).pipe(Effect.asVoid)

/**
 * Persist one side-effect stage as `started → completed` around its effect.
 * The enclosing transaction makes the pair uninterruptible; a hard stop can
 * therefore leave a durable trailing `started` checkpoint that recovery can
 * show without guessing whether the adapter completed.
 */
export const runPostProcessingStage = <A, E, R>(input: {
  readonly recorder: MutationIntentRecorder | undefined
  readonly stage: AgentRuntime.MutationPostProcessingStage
  readonly target?: string
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  input.recorder?.recordPostProcessingStage === undefined
    ? input.effect
    : Effect.gen(function* () {
        yield* input.recorder!.recordPostProcessingStage!(input.stage, "started", input.target)
        const value = yield* input.effect
        yield* input.recorder!.recordPostProcessingStage!(input.stage, "completed", input.target)
        return value
      })

/**
 * Re-observe a durable intent after a restart. The durable record contains
 * only digests, so this compares fresh fingerprints and returns a conservative
 * operator projection; it never restores, retries, or writes a file.
 */
export const inspectMutationIntent = (input: {
  readonly files: Pick<FileMutation.Interface, "fingerprint">
  readonly worktree: string
  readonly intent: Pick<AgentRuntime.MutationIntent, "transactionID" | "phase" | "entries">
}) => FileMutation.inspectIntent(input)

/**
 * Compose the Core read-only recovery projection with the Arforge workspace
 * adapter. The projection supplies only the validated content-free manifest;
 * this helper performs fresh fingerprints and never mutates or retries.
 */
export const inspectMutationProjection = (input: {
  readonly files: Pick<FileMutation.Interface, "fingerprint">
  readonly worktree: string
  readonly projection: Pick<ToolExecutionProjection, "mutationIntent">
}) =>
  Effect.gen(function* () {
    if (input.projection.mutationIntent === undefined) return undefined
    return yield* inspectMutationIntent({
      files: input.files,
      worktree: input.worktree,
      intent: input.projection.mutationIntent,
    })
  })

/**
 * In-memory inverse journal for one user-visible mutation transaction. It is
 * deliberately not a second file owner: every inverse operation delegates to
 * the Core FileMutation service and therefore retains its keyed CAS lock.
 */
export type MutationJournal = {
  readonly add: (entry: MutationUndo) => void
  readonly refresh: (target: FileMutation.Target, current: Uint8Array) => void
  readonly rollback: () => Effect.Effect<ReadonlyArray<Error>>
}

export const makeJournal = (files: FileMutation.Interface): MutationJournal => {
  const entries: MutationUndo[] = []

  const add = (entry: MutationUndo) => {
    entries.push(entry)
  }

  const refresh = (target: FileMutation.Target, current: Uint8Array) => {
    const index = entries.findLastIndex((entry) => entry.target.canonical === target.canonical)
    const entry = index >= 0 ? entries[index] : undefined
    if (!entry || entry.kind === "recreate") return
    entries[index] = { ...entry, expected: current }
  }

  const rollback = Effect.fn("ArforgeFileMutation.rollbackJournal")(function* () {
    const failures: Error[] = []
    for (const entry of entries.toReversed()) {
      const exit = yield* files.rollback(entry).pipe(Effect.uninterruptible, Effect.exit)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return failures
  })

  return { add, refresh, rollback }
}

/**
 * Run formatter/LSP/event post-processing as one durable mutation boundary.
 *
 * Every mature file tool uses this helper after its Core commit. The effect is
 * uninterruptible while a post-processing stage is in flight; any failure is
 * compensated through the same Core rollback journal. A failed durable
 * `settled` record is intentionally different: the side effects completed but
 * the final fact is unknown, so the mutation remains inspect-only instead of
 * being silently rolled back or retried.
 */
export const runPostProcessingTransaction = <A, E, R>(input: {
  readonly recorder: MutationIntentRecorder | undefined
  readonly journal: MutationJournal
  readonly operation: "Edit" | "Write" | "Patch"
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, Error, R> =>
  Effect.gen(function* () {
    const postExit = yield* Effect.gen(function* () {
      if (input.recorder) yield* input.recorder.record("postprocessing", `${input.operation} post-processing started`)
      return yield* input.effect
    }).pipe(Effect.uninterruptible, Effect.exit)

    if (Exit.isFailure(postExit)) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const original = Cause.squash(postExit.cause)
          const originalError = original instanceof Error ? original : new Error(String(original))
          yield* recordBestEffort(
            input.recorder,
            "rollback_required",
            `${input.operation} transaction requires compensation`,
          )
          const rollbackErrors = yield* input.journal.rollback()
          yield* recordBestEffort(
            input.recorder,
            rollbackErrors.length > 0 ? "rollback_blocked" : "rolled_back",
            `${input.operation} transaction recovery`,
          )
          if (rollbackErrors.length > 0)
            return yield* Effect.fail(
              new Error(
                `${input.operation} post-processing failed. ${originalError.message} Rollback: ${rollbackErrors
                  .map((error) => error.message)
                  .join("; ")}`,
              ),
            )
          return yield* Effect.fail(new Error(`${input.operation} post-processing failed. ${originalError.message}`))
        }),
      )
    }

    if (input.recorder) {
      yield* testMutationBoundaryPause()
      const settled = yield* input.recorder
        .record("settled", `${input.operation} transaction settled`)
        .pipe(Effect.uninterruptible, Effect.exit)
      if (Exit.isFailure(settled)) {
        yield* recordBestEffort(
          input.recorder,
          "outcome_unknown",
          `${input.operation} transaction settlement is unknown`,
        )
        return yield* Effect.fail(
          new Error(
            `${input.operation} completed its file and diagnostics work, but durable settlement is unknown; inspect before retrying.`,
          ),
        )
      }
    }

    return postExit.value
  })

/**
 * Project the canonical Core FileMutation owner into the mature Arforge tool
 * runtime. The adapter contains no write state of its own: location-scoped
 * FileMutation remains the only implementation of create/conditional-write/
 * conditional-remove and its keyed commit lock.
 */
export const service = Effect.fn("ArforgeFileMutation.service")(function* () {
  // Tool execution normally already runs inside the canonical location
  // context. Reuse that service directly instead of opening a second
  // LayerMap/RcMap for the same directory. The nested map used to outlive the
  // request scope and its deferred finalizer could run after the location
  // context had been pruned, which made Database-backed cleanup nondeterministic.
  const current = yield* Effect.serviceOption(FileMutation.Service)
  if (Option.isSome(current)) return current.value

  const instance = yield* InstanceState.context
  const existing = yield* Effect.serviceOption(LocationServiceMap.Service)
  const outerRollbackArtifacts = yield* Effect.serviceOption(RollbackArtifact.Service)
  // When the mature adapter has an explicitly composed profile-owned store,
  // carry that exact service into the lazily-built location map. Otherwise
  // FileMutation.node would hoist a second default RollbackArtifact node and
  // a staged inverse could be written to a different store than the caller
  // observes. The replacement is only a service reuse; it does not create a
  // second artifact owner or widen the workspace boundary.
  const locationMapLayer = Option.isSome(outerRollbackArtifacts)
    ? buildLocationServiceMap([
        [RollbackArtifact.node, Layer.succeed(RollbackArtifact.Service, outerRollbackArtifacts.value)],
      ])
    : locationServiceMapLayer
  const locations = Option.isSome(existing)
    ? existing.value
    : yield* Effect.gen(function* () {
        return yield* LocationServiceMap.Service
      }).pipe(Effect.provide(locationMapLayer))
  const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))
  return yield* Effect.gen(function* () {
    return yield* FileMutation.Service
  }).pipe(Effect.provide(location))
})

export const target = (worktree: string, filePath: string): FileMutation.Target => ({
  canonical: filePath,
  resource: path.relative(worktree, filePath).replaceAll("\\", "/") || ".",
})

/** Keep the mature tool surface on one user-facing conflict vocabulary. */
export const mutationError = (operation: "editing" | "writing" | "applying the patch", error: unknown) =>
  error instanceof FileMutation.StaleContentError || error instanceof FileMutation.TargetExistsError
    ? new Error(`File changed after permission approval. Read it again before ${operation}.`)
    : error instanceof Error
      ? error
      : new Error(String(error))

/**
 * Report the canonical conflict shape before converting a Core mutation error
 * into the mature V1 tool's model-facing error. The session processor retains
 * metadata when it settles an error, so the same shape reaches the desktop
 * timeline without making the UI parse error prose.
 */
export const conflictMetadata = (error: unknown): MutationConflictMetadata | undefined => {
  if (error instanceof FileMutation.StaleContentError) {
    return {
      kind: "file_conflict",
      code: "observed_version_mismatch",
      path: error.path,
      ...(error.observedVersion ? { observedVersion: error.observedVersion } : {}),
      ...(error.currentVersion ? { currentVersion: error.currentVersion } : {}),
    }
  }
  if (error instanceof FileMutation.TargetExistsError) {
    return {
      kind: "file_conflict",
      code: "target_exists",
      path: error.path,
    }
  }
  return undefined
}

export const reportFailure = (input: {
  error: unknown
  operation: "editing" | "writing" | "applying the patch"
  metadata: (input: { metadata?: Record<string, unknown> }) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const conflict = conflictMetadata(input.error)
    if (conflict) yield* input.metadata({ metadata: conflict })
    return yield* Effect.fail(mutationError(input.operation, input.error))
  })
