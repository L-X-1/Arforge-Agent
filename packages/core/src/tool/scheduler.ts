import { Deferred, Effect, Semaphore } from "effect"
import { KeyedMutex } from "../effect/keyed-mutex"
import type { ResolvedToolExecutionMetadata } from "./metadata"

/**
 * The bounded execution lane used after ToolRegistry preflight.
 *
 * `exclusive` takes the whole pool, `safe` takes one permit, and `keyed`
 * takes one permit plus a per-resource mutex.  Keeping the scheduler below
 * ToolRegistry means every source (built-in, plugin, MCP, or session-scoped)
 * uses the same admission rule once it has become a registered Tool.
 */
export interface ToolScheduler {
  readonly maxConcurrency: number
  /** Number of scheduler-admitted executions that have not reached release. */
  readonly active: Effect.Effect<number>
  /**
   * Waits for every admitted execution to release, without waiting forever
   * on a defective or non-cooperative child. A timeout is evidence that the
   * caller must keep the tool outcome unknown; it is never permission to
   * start the same side effect again.
   */
  readonly quiesce: (timeoutMs?: number) => Effect.Effect<Quiescence>
  readonly run: <A, E, R>(input: {
    /** Trusted task coordination waits for child work; it is not a leaf execution permit. */
    readonly coordinatesChildren?: boolean
    readonly metadata: Pick<ResolvedToolExecutionMetadata, "concurrency" | "resourceKey">
    readonly effect: Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E, R>
}

export const DEFAULT_TOOL_SCHEDULER_CONCURRENCY = 4
export const DEFAULT_TOOL_QUIESCENCE_TIMEOUT_MS = 5_000
export const MAX_TOOL_QUIESCENCE_TIMEOUT_MS = 60_000

export type Quiescence =
  | { readonly status: "quiescent"; readonly active: 0 }
  | { readonly status: "timed_out"; readonly active: number }

const MAX_TOOL_SCHEDULER_CONCURRENCY = 64

/** Build one scheduler for one ToolRegistry lifetime. */
export const make = (maxConcurrency = DEFAULT_TOOL_SCHEDULER_CONCURRENCY): ToolScheduler => {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_TOOL_SCHEDULER_CONCURRENCY)
    throw new RangeError(
      `Tool scheduler concurrency must be an integer between 1 and ${MAX_TOOL_SCHEDULER_CONCURRENCY}`,
    )

  const pool = Semaphore.makeUnsafe(maxConcurrency)
  const keyed = KeyedMutex.makeUnsafe<string>()
  const admitted = new Set<object>()
  const waiters = new Set<Deferred.Deferred<void>>()

  const release = (token: object) => {
    admitted.delete(token)
    if (admitted.size !== 0) return
    for (const waiter of waiters) Deferred.doneUnsafe(waiter, Effect.void)
    waiters.clear()
  }

  const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const token = {}
      admitted.add(token)
      return effect.pipe(Effect.ensuring(Effect.sync(() => release(token))))
    })

  const quiesce = (timeoutMs = DEFAULT_TOOL_QUIESCENCE_TIMEOUT_MS): Effect.Effect<Quiescence> => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TOOL_QUIESCENCE_TIMEOUT_MS)
      return Effect.die(
        new RangeError(
          `Tool scheduler quiescence timeout must be an integer between 0 and ${MAX_TOOL_QUIESCENCE_TIMEOUT_MS}`,
        ),
      )
    return Effect.suspend(() => {
      if (admitted.size === 0) return Effect.succeed({ status: "quiescent", active: 0 } as const)
      const waiter = Deferred.makeUnsafe<void>()
      waiters.add(waiter)
      return Deferred.await(waiter).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.map(
          (completed): Quiescence =>
            completed._tag === "Some"
              ? { status: "quiescent", active: 0 }
              : { status: "timed_out", active: admitted.size },
        ),
        Effect.ensuring(Effect.sync(() => waiters.delete(waiter))),
      )
    })
  }

  return {
    maxConcurrency,
    active: Effect.sync(() => admitted.size),
    quiesce,
    run: ({ metadata, effect, coordinatesChildren }) => {
      // The caller's task fiber owns coordination lifetime and cancellation.
      // Holding a leaf permit here would deadlock the child (and its quiesce)
      // against the parent waiting for that same child. Only the registry's
      // trusted task registration can set this flag; tool metadata cannot.
      if (coordinatesChildren) return effect
      // A keyed declaration without a resolved key is invalid at the
      // metadata boundary.  Keep this second guard conservative for callers
      // that construct the scheduler directly: it must never become an
      // accidentally parallel lane.
      if (metadata.concurrency === "keyed" && metadata.resourceKey) {
        return tracked(pool.withPermit(keyed.withLock(metadata.resourceKey)(effect)))
      }
      if (metadata.concurrency === "safe") return tracked(pool.withPermit(effect))
      // `exclusive` and malformed `keyed` metadata both occupy every permit,
      // creating a barrier against all safe/keyed work already in flight.
      return tracked(pool.withPermits(maxConcurrency)(effect))
    },
  }
}
