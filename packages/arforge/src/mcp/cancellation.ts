import { type Duration, Effect } from "effect"

/**
 * A cancellation request must never make the control plane wait forever for a
 * third-party MCP runner. The runner's tombstone remains installed after this
 * grace period; callers can report `waiting_takeover` and retry only after the
 * runner has actually exited.
 */
export const LOCAL_ATTEMPT_CANCELLATION_GRACE = "5 seconds"

export type LocalAttemptTermination = "terminated" | "timed_out"

/**
 * Process-local tombstones bridge an InstanceState reload. Clearing is by
 * identity so a late old runner cannot erase a newer generation's barrier.
 */
export interface LocalAttemptTombstones<Attempt> {
  readonly get: (key: string) => Attempt | undefined
  readonly install: (key: string, attempt: Attempt) => void
  readonly clear: (key: string, attempt: Attempt) => void
}

export const makeLocalAttemptTombstones = <Attempt>(): LocalAttemptTombstones<Attempt> => {
  const tombstones = new Map<string, Attempt>()
  return {
    get: (key) => tombstones.get(key),
    install: (key, attempt) => tombstones.set(key, attempt),
    clear: (key, attempt) => {
      if (tombstones.get(key) === attempt) tombstones.delete(key)
    },
  }
}

/**
 * Reload preserves an unfinished approval so the user sees the same request.
 * A later explicit user cancellation is stronger: it must make that durable
 * request terminal even while its old runner still owns the tombstone.
 */
export type LocalAttemptCancellationDisposition = "settle_superseded" | "preserve_for_recovery"

export const nextCancellationDisposition = (
  current: LocalAttemptCancellationDisposition | undefined,
  requested: LocalAttemptCancellationDisposition,
): LocalAttemptCancellationDisposition =>
  requested === "settle_superseded" ? "settle_superseded" : (current ?? "preserve_for_recovery")

/**
 * Waits for a runner exit with an explicit bound. This is deliberately kept
 * separate from process closing so tests can exercise the safety boundary with
 * TestClock instead of wall-clock sleeps.
 */
export const awaitLocalAttemptTermination = <A, E, R>(
  completion: Effect.Effect<A, E, R>,
  duration: Duration.Input = LOCAL_ATTEMPT_CANCELLATION_GRACE,
): Effect.Effect<LocalAttemptTermination, E, R> =>
  completion.pipe(
    Effect.as("terminated" as const),
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.succeed("timed_out" as const),
    }),
  )
