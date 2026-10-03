export * as FileMutation from "./file-mutation"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { tmpdir as osTmpdir } from "node:os"
import { dirname } from "path"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"
import { ConditionalWriteConflictError as GuardConditionalWriteConflictError, snapshot } from "./file-guard"
import type { FileFingerprint } from "./file-guard"
import * as MutationIntentRuntime from "./runtime/mutation-intent"
import * as RollbackArtifactRuntime from "./runtime/rollback-artifact"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as path from "node:path"
import { Flock } from "./util/flock"

export interface Target {
  readonly canonical: string
  readonly resource: string
}

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

export interface ConditionalWriteInput extends WriteInput {
  readonly expected: Uint8Array
}

export interface ConditionalRemoveInput {
  readonly target: Target
  readonly expected: Uint8Array
}

/**
 * Move a file while retaining the same compare-and-swap contract as a write.
 *
 * `expectedDestination` is deliberately optional: an omitted value means the
 * destination must be absent, while a supplied value is the exact destination
 * preimage that may be replaced.  The source is always required to match
 * `expectedSource` before it is removed.  This keeps rename-like operations in
 * the canonical FileMutation owner instead of letting individual tools compose
 * an unguarded write + remove pair.
 */
export interface ConditionalMoveInput {
  readonly source: Target
  readonly destination: Target
  readonly expectedSource: Uint8Array
  readonly content: string | Uint8Array
  readonly expectedDestination?: Uint8Array
}

export type RollbackInput =
  | { readonly kind: "remove-created"; readonly target: Target; readonly expected: Uint8Array }
  | { readonly kind: "restore"; readonly target: Target; readonly expected: Uint8Array; readonly content: Uint8Array }
  | { readonly kind: "recreate"; readonly target: Target; readonly content: Uint8Array }

export interface RemoveInput {
  readonly target: Target
}

export class StaleContentError extends Schema.TaggedErrorClass<StaleContentError>()("FileMutation.StaleContentError", {
  path: Schema.String,
  /** SHA-256 of the bytes observed immediately before the guarded write/remove. */
  observedVersion: Schema.optional(Schema.String),
  /** SHA-256 of the bytes found at commit time, when the target still exists. */
  currentVersion: Schema.optional(Schema.String),
}) {}

export class TargetExistsError extends Schema.TaggedErrorClass<TargetExistsError>()("FileMutation.TargetExistsError", {
  path: Schema.String,
}) {}

/** A human-approved rollback could not pass the final content/CAS boundary. */
export class MutationRollbackError extends Schema.TaggedErrorClass<MutationRollbackError>()(
  "FileMutation.MutationRollbackError",
  {
    target: Schema.optional(Schema.String),
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason
  }
}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface RemoveResult {
  readonly operation: "remove"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface MoveResult {
  readonly operation: "move"
  readonly source: string
  readonly destination: string
  readonly sourceResource: string
  readonly destinationResource: string
  readonly overwritten: boolean
}

export type WriteReceipt = {
  readonly result: WriteResult
  readonly preimage?: FileFingerprint
  readonly postimage: FileFingerprint
  readonly rollback: {
    readonly kind: "restore_preimage" | "remove_created"
    readonly digest?: string
  }
}

export type MutationRollbackInput = Readonly<{
  readonly worktree: string
  readonly intent: Pick<AgentRuntime.MutationIntent, "transactionID" | "phase" | "entries">
  /** Digest from the fresh postimage inspection shown to the approving human. */
  readonly observationDigest: string
}>

export type MutationRollbackReceipt = Readonly<{
  readonly transactionID: AgentRuntime.MutationTransactionID
  readonly inspection: MutationIntentRuntime.MutationInspectionProjection
}>

export interface Interface {
  /** Create without replacing an existing target. */
  readonly create: (input: WriteInput) => Effect.Effect<WriteResult, TargetExistsError | FSUtil.Error>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (input: TextWriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  /** Commit only if an existing target still has the expected bytes. */
  readonly writeIfUnchanged: (
    input: ConditionalWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | FSUtil.Error>
  readonly fingerprint: (input: { readonly target: Target }) => Effect.Effect<FileFingerprint | undefined, FSUtil.Error>
  readonly writeTextWithReceipt: (input: TextWriteInput) => Effect.Effect<WriteReceipt, FSUtil.Error>
  readonly writeIfUnchangedWithReceipt: (
    input: ConditionalWriteInput,
  ) => Effect.Effect<WriteReceipt, StaleContentError | FSUtil.Error>
  /** Apply one inverse journal entry while preserving the same CAS semantics. */
  readonly rollback: (
    input: RollbackInput,
  ) => Effect.Effect<WriteResult | RemoveResult, StaleContentError | TargetExistsError | FSUtil.Error>
  /** Execute one explicitly approved rollback using profile-owned inverse artifacts and fresh CAS checks. */
  readonly rollbackIntent: (
    input: MutationRollbackInput,
  ) => Effect.Effect<
    MutationRollbackReceipt,
    MutationRollbackError | StaleContentError | RollbackArtifactRuntime.RollbackArtifactError | FSUtil.Error
  >
  readonly remove: (input: RemoveInput) => Effect.Effect<RemoveResult, FSUtil.Error>
  readonly removeIfUnchanged: (
    input: ConditionalRemoveInput,
  ) => Effect.Effect<RemoveResult, StaleContentError | FSUtil.Error>
  /** Move/transform one source into one destination under ordered CAS locks. */
  readonly moveIfUnchanged: (
    input: ConditionalMoveInput,
  ) => Effect.Effect<MoveResult, StaleContentError | TargetExistsError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/FileMutation") {}

/**
 * Re-observe a durable mutation manifest against the current workspace.
 *
 * This is deliberately a Core read-only seam: it only requests fingerprints,
 * re-checks workspace containment, and delegates the final classification to
 * the deterministic mutation-intent projection. It never reads file bytes,
 * writes, rolls back, settles an Action, or authorizes a retry.
 */
export const inspectIntent = (input: {
  readonly files: Pick<Interface, "fingerprint">
  readonly worktree: string
  readonly intent: Pick<AgentRuntime.MutationIntent, "transactionID" | "phase" | "entries">
}) =>
  Effect.gen(function* () {
    const observations: MutationIntentRuntime.MutationObservedImage[] = []
    for (const entry of input.intent.entries) {
      const canonical = path.resolve(input.worktree, entry.target)
      const relative = path.relative(input.worktree, canonical)
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
        return yield* new MutationRollbackError({
          target: entry.target,
          reason: "Mutation recovery target is outside the workspace.",
        })
      const target: Target = {
        canonical,
        resource: relative.replaceAll("\\", "/") || ".",
      }
      const current = yield* input.files.fingerprint({ target })
      observations.push({
        target: entry.target,
        present: current !== undefined,
        ...(current === undefined ? {} : { digest: current.digest, byteLength: current.size }),
      })
    }
    return MutationIntentRuntime.inspect(input.intent, observations)
  })

/**
 * Serialize file changes by canonical target. Conditional writes compare and
 * commit while holding both the existing process-local mutex and a cooperative
 * cross-process lease. The lease is deliberately outside the workspace and
 * has heartbeat/stale-owner recovery; an uncooperating external writer is
 * still detected by the byte comparison, not magically prevented by this API.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const rollbackArtifacts = yield* RollbackArtifactRuntime.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const crossProcessLockRoot = path.join(osTmpdir(), "arforge-file-mutation-locks")
    const lockKey = (target: Target) => {
      const canonical = path.normalize(path.resolve(target.canonical))
      return `file-mutation:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`
    }
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Flock.effect(lockKey(target), { dir: crossProcessLockRoot }).pipe(
            Effect.mapError((cause) => new FSUtil.FileSystemError({ method: "crossProcessLock", cause })),
            Effect.andThen(locks.withLock(target.canonical)(Effect.uninterruptible(effect))),
          ),
        )

    /**
     * Acquire every lock in a stable order.  A move touches two paths; sorting
     * by the same normalized key used by single-target mutations prevents two
     * concurrent moves from deadlocking when their source/destination pairs
     * overlap in opposite directions.
     */
    const withTargetsLock = (targets: ReadonlyArray<Target>) => {
      const unique = Array.from(new Map(targets.map((target) => [lockKey(target), target])).values()).sort(
        (left, right) => lockKey(left).localeCompare(lockKey(right)),
      )
      const wrap = <A, E, R>(index: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | FSUtil.Error, R> =>
        index >= unique.length ? effect : withTargetLock(unique[index])(wrap(index + 1, effect))
      return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | FSUtil.Error, R> => wrap(0, effect)
    }

    /**
     * Mutation callers such as apply_patch may already have an absolute
     * lexical path and therefore do not pass through LocationMutation. Walk
     * every existing component while the mutation lock is held so a symlink or
     * junction cannot redirect a create/delete/move through an otherwise
     * trusted workspace path. Missing leaf/parent components are allowed; the
     * check simply continues toward the nearest existing ancestor.
     */
    const assertNoLinkPath = (canonical: string, method: string) =>
      Effect.gen(function* () {
        let current = path.resolve(canonical)
        while (true) {
          if (yield* fs.isSymbolicLink(current))
            return yield* new FSUtil.FileSystemError({
              method,
              cause: new Error(`Symbolic link or junction path component is not supported: ${current}`),
            })
          const parent = path.dirname(current)
          if (parent === current) return yield* Effect.void
          current = parent
        }
      })

    const guardTarget = (target: Target, method: string) => assertNoLinkPath(target.canonical, method)

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const removeResult = (target: Target, existed: boolean): RemoveResult => ({
      operation: "remove",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          yield* guardTarget(input.target, "write")
          const existed = yield* fs.exists(input.target.canonical)
          yield* fs.writeWithDirs(input.target.canonical, input.content)
          return writeResult(input.target, existed)
        }),
      ),
    )

    const writeIfUnchangedAtomic = (
      input: ConditionalWriteInput,
    ): Effect.Effect<void, StaleContentError | FSUtil.Error> => {
      const write: Effect.Effect<void, FSUtil.Error> = fs.writeIfUnchanged
        ? fs.writeIfUnchanged(input.target.canonical, input.expected, input.content)
        : Effect.fail(
            new FSUtil.FileSystemError({
              method: "writeIfUnchanged",
              cause: new Error("Conditional atomic write is unavailable for this filesystem implementation"),
            }),
          )
      return write.pipe(
        Effect.asVoid,
        Effect.mapError((error): StaleContentError | FSUtil.Error => {
          const cause = error instanceof FSUtil.FileSystemError ? error.cause : undefined
          return cause instanceof GuardConditionalWriteConflictError
            ? new StaleContentError({
                path: input.target.canonical,
                observedVersion: contentVersion(input.expected),
                ...(cause.currentVersion === undefined ? {} : { currentVersion: cause.currentVersion }),
              })
            : error
        }),
      )
    }

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          yield* guardTarget(input.target, "writeTextPreservingBom")
          const next = splitBom(input.content)
          const current = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          yield* fs.writeWithDirs(
            input.target.canonical,
            joinBom(next.text, Boolean(current && hasUtf8Bom(current)) || next.bom),
          )
          return writeResult(input.target, current !== undefined)
        }),
      ),
    )

    const create = Effect.fn("FileMutation.create")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          yield* guardTarget(input.target, "create")
          const write = fs.writeIfAbsentAtomic
            ? fs.writeIfAbsentAtomic(input.target.canonical, input.content)
            : typeof input.content === "string"
              ? fs.writeFileString(input.target.canonical, input.content, { flag: "wx" })
              : fs.writeFile(input.target.canonical, input.content, { flag: "wx" })
          yield* write.pipe(
            Effect.catchReason("PlatformError", "NotFound", () =>
              fs.ensureDir(dirname(input.target.canonical)).pipe(Effect.andThen(write)),
            ),
            Effect.catchReason("PlatformError", "AlreadyExists", () =>
              Effect.fail(new TargetExistsError({ path: input.target.canonical })),
            ),
            Effect.catch((error) =>
              error instanceof FSUtil.FileSystemError && error.cause instanceof GuardConditionalWriteConflictError
                ? Effect.fail(new TargetExistsError({ path: input.target.canonical }))
                : Effect.fail(error),
            ),
          )
          return writeResult(input.target, false)
        }),
      ),
    )

    const writeIfUnchangedUnderLock = (input: ConditionalWriteInput) =>
      Effect.gen(function* () {
        yield* guardTarget(input.target, "writeIfUnchanged")
        const current = yield* fs.readFile(input.target.canonical).pipe(
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.fail(
              new StaleContentError({
                path: input.target.canonical,
                observedVersion: contentVersion(input.expected),
              }),
            ),
          ),
        )
        if (!sameBytes(current, input.expected)) {
          return yield* new StaleContentError({
            path: input.target.canonical,
            observedVersion: contentVersion(input.expected),
            currentVersion: contentVersion(current),
          })
        }
        yield* writeIfUnchangedAtomic(input)
        return writeResult(input.target, true)
      })

    const writeIfUnchanged = Effect.fn("FileMutation.writeIfUnchanged")((input: ConditionalWriteInput) =>
      withTargetLock(input.target)(writeIfUnchangedUnderLock(input)),
    )

    const fingerprint: Interface["fingerprint"] = Effect.fn("FileMutation.fingerprint")((input) =>
      // A fingerprint is an observation boundary, not a best-effort stat. It
      // must use the same cooperative lease as a writer so a recovery probe
      // cannot sample a file while another Arforge process is between its
      // read/format/write steps. The lock is per target and is released before
      // the next target in a multi-file inspection; callers still classify a
      // multi-file transaction conservatively when observations disagree.
      withTargetLock(input.target)(
        snapshot(input.target.canonical).pipe(
          Effect.map((value) =>
            value === undefined
              ? undefined
              : {
                  digest: value.digest,
                  size: value.size,
                  mode: value.mode,
                  identity: value.identity,
                  mtimeMs: value.mtimeMs,
                },
          ),
          Effect.mapError((error) => new FSUtil.FileSystemError({ method: "fingerprint", cause: error })),
        ),
      ),
    )

    const writeTextWithReceipt: Interface["writeTextWithReceipt"] = Effect.fn("FileMutation.writeTextWithReceipt")(
      (input) =>
        Effect.gen(function* () {
          const before = yield* fingerprint({ target: input.target })
          const result = yield* writeTextPreservingBom(input)
          const after = yield* fingerprint({ target: input.target })
          if (!after) return yield* Effect.die(new Error("Atomic write completed without a readable postimage"))
          return {
            result,
            ...(before ? { preimage: before } : {}),
            postimage: after,
            rollback: before
              ? { kind: "restore_preimage" as const, digest: before.digest }
              : { kind: "remove_created" as const },
          }
        }),
    )

    const writeIfUnchangedWithReceipt: Interface["writeIfUnchangedWithReceipt"] = Effect.fn(
      "FileMutation.writeIfUnchangedWithReceipt",
    )((input) =>
      Effect.gen(function* () {
        const before = yield* fingerprint({ target: input.target })
        const result = yield* writeIfUnchanged(input)
        const after = yield* fingerprint({ target: input.target })
        if (!after) return yield* Effect.die(new Error("Atomic conditional write completed without a postimage"))
        return {
          result,
          ...(before ? { preimage: before } : {}),
          postimage: after,
          rollback: before
            ? { kind: "restore_preimage" as const, digest: before.digest }
            : { kind: "remove_created" as const },
        }
      }),
    )

    const remove = Effect.fn("FileMutation.remove")((input: RemoveInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          yield* guardTarget(input.target, "remove")
          const existed = yield* fs.remove(input.target.canonical).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          )
          return removeResult(input.target, existed)
        }),
      ),
    )

    const removeIfUnchangedUnderLock = (input: ConditionalRemoveInput) =>
      Effect.gen(function* () {
        yield* guardTarget(input.target, "removeIfUnchanged")
        const current = yield* fs.readFile(input.target.canonical).pipe(
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.fail(
              new StaleContentError({
                path: input.target.canonical,
                observedVersion: contentVersion(input.expected),
              }),
            ),
          ),
        )
        if (!sameBytes(current, input.expected))
          return yield* new StaleContentError({
            path: input.target.canonical,
            observedVersion: contentVersion(input.expected),
            currentVersion: contentVersion(current),
          })
        // We already hold the per-target lock. Calling `remove(input)` here
        // would try to reacquire the same non-reentrant mutex and hang a
        // successful guarded delete; commit directly under this lock.
        const existed = yield* fs.remove(input.target.canonical).pipe(
          Effect.as(true),
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.fail(
              new StaleContentError({
                path: input.target.canonical,
                observedVersion: contentVersion(input.expected),
              }),
            ),
          ),
        )
        return removeResult(input.target, existed)
      })

    const removeIfUnchanged = Effect.fn("FileMutation.removeIfUnchanged")((input: ConditionalRemoveInput) =>
      withTargetLock(input.target)(removeIfUnchangedUnderLock(input)),
    )

    const moveIfUnchanged: Interface["moveIfUnchanged"] = Effect.fn("FileMutation.moveIfUnchanged")((input) =>
      withTargetsLock([input.source, input.destination])(
        Effect.gen(function* () {
          yield* guardTarget(input.source, "moveIfUnchanged")
          yield* guardTarget(input.destination, "moveIfUnchanged")
          if (lockKey(input.source) === lockKey(input.destination))
            return yield* Effect.fail(
              new FSUtil.FileSystemError({
                method: "moveIfUnchanged",
                cause: new Error("Source and destination must be different files"),
              }),
            )

          const source = yield* fs.readFile(input.source.canonical).pipe(
            Effect.catchReason("PlatformError", "NotFound", () =>
              Effect.fail(
                new StaleContentError({
                  path: input.source.canonical,
                  observedVersion: contentVersion(input.expectedSource),
                }),
              ),
            ),
          )
          if (!sameBytes(source, input.expectedSource))
            return yield* new StaleContentError({
              path: input.source.canonical,
              observedVersion: contentVersion(input.expectedSource),
              currentVersion: contentVersion(source),
            })

          const destination = yield* fs
            .readFile(input.destination.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          if (input.expectedDestination === undefined) {
            if (destination !== undefined) return yield* new TargetExistsError({ path: input.destination.canonical })
          } else {
            if (destination === undefined)
              return yield* new StaleContentError({
                path: input.destination.canonical,
                observedVersion: contentVersion(input.expectedDestination),
              })
            if (!sameBytes(destination, input.expectedDestination))
              return yield* new StaleContentError({
                path: input.destination.canonical,
                observedVersion: contentVersion(input.expectedDestination),
                currentVersion: contentVersion(destination),
              })
          }

          const written = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content
          let destinationCommitted = false
          const commit = Effect.gen(function* () {
            if (destination !== undefined) {
              // The destination is already under the ordered lock, so call
              // the atomic primitive directly rather than reacquiring it.
              yield* writeIfUnchangedAtomic({
                target: input.destination,
                expected: input.expectedDestination!,
                content: written,
              })
            } else {
              const createDestination = (
                fs.writeIfAbsentAtomic
                  ? fs.writeIfAbsentAtomic(input.destination.canonical, written)
                  : fs.writeFile(input.destination.canonical, written, { flag: "wx" })
              ).pipe(
                Effect.catchReason("PlatformError", "NotFound", () =>
                  fs
                    .ensureDir(dirname(input.destination.canonical))
                    .pipe(
                      Effect.andThen(
                        fs.writeIfAbsentAtomic
                          ? fs.writeIfAbsentAtomic(input.destination.canonical, written)
                          : fs.writeFile(input.destination.canonical, written, { flag: "wx" }),
                      ),
                    ),
                ),
                Effect.catchReason("PlatformError", "AlreadyExists", () =>
                  Effect.fail(new TargetExistsError({ path: input.destination.canonical })),
                ),
                Effect.catch((error) =>
                  error instanceof FSUtil.FileSystemError && error.cause instanceof GuardConditionalWriteConflictError
                    ? Effect.fail(new TargetExistsError({ path: input.destination.canonical }))
                    : Effect.fail(error),
                ),
              )
              yield* createDestination
            }
            destinationCommitted = true
            yield* removeIfUnchangedUnderLock({ target: input.source, expected: input.expectedSource })
            return {
              operation: "move" as const,
              source: input.source.canonical,
              destination: input.destination.canonical,
              sourceResource: input.source.resource,
              destinationResource: input.destination.resource,
              overwritten: destination !== undefined,
            }
          })

          const result = yield* commit.pipe(Effect.uninterruptible, Effect.exit)
          if (Exit.isSuccess(result)) return result.value
          if (destinationCommitted) {
            // A source CAS failure after publishing the destination would
            // otherwise leave a phantom copy.  Compensate only if the new
            // destination image is still ours; a concurrent external change
            // is reported as a rollback defect instead of being overwritten.
            const compensation =
              destination === undefined
                ? removeIfUnchangedUnderLock({ target: input.destination, expected: written }).pipe(Effect.asVoid)
                : writeIfUnchangedAtomic({
                    target: input.destination,
                    expected: written,
                    content: destination,
                  }).pipe(Effect.asVoid)
            const restored = yield* compensation.pipe(Effect.exit)
            if (Exit.isFailure(restored))
              return yield* new FSUtil.FileSystemError({
                method: "moveIfUnchanged.rollback",
                cause: new Error(`Destination compensation failed: ${String(restored.cause)}`),
              })
          }
          return yield* Effect.failCause(result.cause)
        }),
      ),
    )

    const rollback: Interface["rollback"] = Effect.fn("FileMutation.rollback")(function* (input: RollbackInput) {
      switch (input.kind) {
        case "remove-created":
          return yield* removeIfUnchanged({ target: input.target, expected: input.expected })
        case "restore":
          return yield* writeIfUnchanged({ target: input.target, expected: input.expected, content: input.content })
        case "recreate":
          return yield* create({ target: input.target, content: input.content })
      }
    })

    const observe = (target: Target) =>
      snapshot(target.canonical).pipe(
        Effect.mapError((error) => new FSUtil.FileSystemError({ method: "rollbackFingerprint", cause: error })),
      )

    const targetForEntry = (worktree: string, entry: AgentRuntime.MutationIntentEntry) =>
      Effect.gen(function* () {
        const canonical = path.resolve(worktree, entry.target)
        const relative = path.relative(worktree, canonical)
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
          return yield* new MutationRollbackError({
            target: entry.target,
            reason: "The rollback target is outside the active workspace.",
          })
        return {
          canonical,
          resource: relative.replaceAll("\\", "/") || ".",
        } satisfies Target
      })

    const rollbackEntry = (input: { readonly target: Target; readonly entry: AgentRuntime.MutationIntentEntry }) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const current = yield* observe(input.target)
          const postimageMatches =
            input.entry.operation === "remove"
              ? current === undefined
              : current !== undefined &&
                current.digest === input.entry.afterDigest &&
                (input.entry.afterByteLength === undefined || current.size === input.entry.afterByteLength)
          if (!postimageMatches)
            return yield* new StaleContentError({
              path: input.target.canonical,
              observedVersion: input.entry.afterDigest,
              ...(current === undefined ? {} : { currentVersion: current.digest }),
            })

          if (input.entry.operation === "create") {
            if (current === undefined)
              return yield* new MutationRollbackError({
                target: input.target.resource,
                reason: "The create rollback target disappeared before compensation.",
              })
            yield* removeIfUnchangedUnderLock({ target: input.target, expected: current.content })
            const after = yield* observe(input.target)
            if (after !== undefined)
              return yield* new MutationRollbackError({
                target: input.target.resource,
                reason: "The created file was not removed after the guarded rollback.",
              })
            return
          }

          const artifact = input.entry.rollbackArtifact
          if (artifact === undefined)
            return yield* new MutationRollbackError({
              target: input.target.resource,
              reason: "This mutation has no durable inverse artifact; manual recovery is required.",
            })
          const inverse = yield* Effect.tryPromise({
            try: () => rollbackArtifacts.store.read(artifact),
            catch: (error) =>
              error instanceof RollbackArtifactRuntime.RollbackArtifactError
                ? error
                : new RollbackArtifactRuntime.RollbackArtifactError("io_error", String(error)),
          })
          if (input.entry.operation === "write") {
            if (current === undefined)
              return yield* new MutationRollbackError({
                target: input.target.resource,
                reason: "The write rollback target disappeared before compensation.",
              })
            yield* writeIfUnchangedUnderLock({
              target: input.target,
              expected: current.content,
              content: inverse.content,
            })
          } else {
            const write = fs.writeFile(input.target.canonical, inverse.content, { flag: "wx" })
            yield* write.pipe(
              Effect.catchReason("PlatformError", "NotFound", () =>
                fs.ensureDir(dirname(input.target.canonical)).pipe(Effect.andThen(write)),
              ),
              Effect.catchReason("PlatformError", "AlreadyExists", () =>
                Effect.fail(
                  new StaleContentError({
                    path: input.target.canonical,
                    currentVersion: "present",
                  }),
                ),
              ),
            )
          }

          const after = yield* observe(input.target)
          if (after?.digest !== inverse.ref.digest || after.size !== inverse.ref.byteLength)
            return yield* new MutationRollbackError({
              target: input.target.resource,
              reason: "The restored preimage failed the post-write integrity check.",
            })
        }),
      )

    const rollbackIntent: Interface["rollbackIntent"] = Effect.fn("FileMutation.rollbackIntent")(function* (input) {
      if (input.intent.phase !== "rollback_required")
        return yield* new MutationRollbackError({
          reason: "A rollback requires the durable mutation phase rollback_required.",
        })
      if (!MutationIntentRuntime.isObservationDigest(input.observationDigest))
        return yield* new MutationRollbackError({ reason: "The approving observation digest is invalid." })

      const initial = yield* inspectIntent({
        files: { fingerprint },
        worktree: input.worktree,
        intent: input.intent,
      })
      if (initial.observationDigest !== input.observationDigest)
        return yield* new MutationRollbackError({
          reason: "The approving fingerprint observation is stale; inspect the targets again.",
        })
      if (initial.decision !== "postimage_matches")
        return yield* new MutationRollbackError({
          reason: "Rollback requires every target to still match its recorded postimage.",
        })

      for (const entry of input.intent.entries.toReversed()) {
        const target = yield* targetForEntry(input.worktree, entry)
        yield* rollbackEntry({ target, entry })
      }

      const inspection = yield* inspectIntent({
        files: { fingerprint },
        worktree: input.worktree,
        intent: input.intent,
      })
      if (inspection.decision !== "preimage_matches")
        return yield* new MutationRollbackError({
          reason: "Rollback completed without a complete preimage inspection; manual review is required.",
        })
      return { transactionID: input.intent.transactionID, inspection }
    })

    return Service.of({
      create,
      write,
      writeTextPreservingBom,
      writeIfUnchanged,
      fingerprint,
      writeTextWithReceipt,
      writeIfUnchangedWithReceipt,
      rollback,
      rollbackIntent,
      remove,
      removeIfUnchanged,
      moveIfUnchanged,
    })
  }),
)

function splitBom(text: string) {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}

function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

function hasUtf8Bom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

const contentVersion = (content: Uint8Array) => createHash("sha256").update(content).digest("hex")

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, RollbackArtifactRuntime.node] })

/**
 * Deferred until the corresponding V2 integrations exist.
 */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after V2 snapshot design exists.
// TODO: Notify LSP and collect diagnostics after V2 LSP runtime exists.
// TODO: Design multi-file transactions / rollback if apply_patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
