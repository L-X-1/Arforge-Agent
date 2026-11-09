import { Deferred, Effect, Scope, Semaphore } from "effect"
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
  readonly quiesce: (timeoutMs?: number, sessionID?: string) => Effect.Effect<Quiescence>
  readonly acquire: (input: Admission) => Effect.Effect<void, never, Scope.Scope>
  readonly run: <A, E, R>(input: Admission & { readonly effect: Effect.Effect<A, E, R> }) => Effect.Effect<A, E, R>
}

type Admission = {
  /** Trusted task coordination waits for child work; it is not a leaf execution permit. */
  readonly coordinatesChildren?: boolean
  readonly metadata: Pick<ResolvedToolExecutionMetadata, "concurrency" | "resourceKey">
  readonly sessionID?: string
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
  const admitted = new Map<object, string | undefined>()
  const waiters = new Map<Deferred.Deferred<void>, string | undefined>()
  const count = (sessionID?: string) => {
    if (sessionID === undefined) return admitted.size
    let active = 0
    for (const owner of admitted.values()) if (owner === sessionID) active++
    return active
  }

  const release = (token: object) => {
    admitted.delete(token)
    for (const [waiter, sessionID] of waiters) {
      if (count(sessionID) !== 0) continue
      waiters.delete(waiter)
      Deferred.doneUnsafe(waiter, Effect.void)
    }
  }

  const acquire = ({ metadata, coordinatesChildren, sessionID }: Admission) =>
    Effect.gen(function* () {
      // Holding a leaf permit while a trusted task coordinates its children would deadlock them.
      if (coordinatesChildren) return
      const key = metadata.concurrency === "keyed" ? metadata.resourceKey : undefined
      const permits = metadata.concurrency === "safe" || key ? 1 : maxConcurrency
      // Same-resource waiters must leave shared capacity available for other work.
      if (key) yield* keyed.acquire(key)
      yield* Effect.acquireRelease(pool.take(permits), () => pool.release(permits), { interruptible: true })
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const token = {}
          admitted.set(token, sessionID)
          return token
        }),
        (token) => Effect.sync(() => release(token)),
      )
    })

  const quiesce = (timeoutMs = DEFAULT_TOOL_QUIESCENCE_TIMEOUT_MS, sessionID?: string): Effect.Effect<Quiescence> => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TOOL_QUIESCENCE_TIMEOUT_MS)
      return Effect.die(
        new RangeError(
          `Tool scheduler quiescence timeout must be an integer between 0 and ${MAX_TOOL_QUIESCENCE_TIMEOUT_MS}`,
        ),
      )
    return Effect.suspend(() => {
      if (count(sessionID) === 0) return Effect.succeed({ status: "quiescent", active: 0 } as const)
      const waiter = Deferred.makeUnsafe<void>()
      waiters.set(waiter, sessionID)
      return Deferred.await(waiter).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.map(
          (completed): Quiescence =>
            completed._tag === "Some"
              ? { status: "quiescent", active: 0 }
              : { status: "timed_out", active: count(sessionID) },
        ),
        Effect.ensuring(Effect.sync(() => waiters.delete(waiter))),
      )
    })
  }

  return {
    maxConcurrency,
    active: Effect.sync(() => admitted.size),
    quiesce,
    acquire,
    run: (input) => Effect.scopedWith((scope) => acquire(input).pipe(Scope.provide(scope), Effect.andThen(input.effect))),
  }
}
