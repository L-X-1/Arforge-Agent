import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import {
  awaitLocalAttemptTermination,
  makeLocalAttemptTombstones,
  nextCancellationDisposition,
} from "../../src/mcp/cancellation"
import { it } from "../lib/effect"

describe("MCP local-attempt cancellation fence", () => {
  it.effect("returns at the bounded cancellation grace without wall-clock waiting", () =>
    Effect.gen(function* () {
      const runnerExit = yield* Deferred.make<void>()
      const waiter = yield* awaitLocalAttemptTermination(Deferred.await(runnerExit), "5 seconds").pipe(Effect.forkChild)

      // The runner never cooperates. Advancing TestClock proves callers get a
      // bounded result without using a fixed sleep or releasing its tombstone.
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(waiter)).toBe("timed_out")
    }),
  )

  it.effect("allows takeover only after the old runner publishes termination", () =>
    Effect.gen(function* () {
      const runnerExit = yield* Deferred.make<void>()
      const waiter = yield* awaitLocalAttemptTermination(Deferred.await(runnerExit), "5 seconds").pipe(Effect.forkChild)

      yield* Deferred.succeed(runnerExit, undefined)
      expect(yield* Fiber.join(waiter)).toBe("terminated")
    }),
  )

  it.effect("lets an explicit cancellation supersede a reload-preserved tombstone", () =>
    Effect.sync(() => {
      expect(nextCancellationDisposition("preserve_for_recovery", "settle_superseded")).toBe("settle_superseded")
      expect(nextCancellationDisposition(undefined, "preserve_for_recovery")).toBe("preserve_for_recovery")
    }),
  )

  it.effect("keeps a cross-instance tombstone after timeout so a replacement cannot spawn", () =>
    Effect.gen(function* () {
      const tombstones = makeLocalAttemptTombstones<object>()
      const key = "C:\\canonical-project\0server"
      const oldRunner = {}
      const oldRunnerExit = yield* Deferred.make<void>()
      let replacementSpawns = 0
      const startReplacement = () => {
        if (tombstones.get(key)) return "waiting_takeover" as const
        replacementSpawns++
        return "started" as const
      }

      // Instance A has been disposed, but its third-party runner does not
      // cooperate. Instance B must observe the real process-local tombstone,
      // return from its bounded cancellation wait, and still spawn nothing.
      tombstones.install(key, oldRunner)
      const waiter = yield* awaitLocalAttemptTermination(Deferred.await(oldRunnerExit), "5 seconds").pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(waiter)).toBe("timed_out")
      expect(startReplacement()).toBe("waiting_takeover")
      expect(replacementSpawns).toBe(0)

      // Only the original runner's eventual exit may remove its identity
      // tombstone. A retried transition can then start exactly once.
      yield* Deferred.succeed(oldRunnerExit, undefined)
      tombstones.clear(key, oldRunner)
      expect(startReplacement()).toBe("started")
      expect(replacementSpawns).toBe(1)
    }),
  )
})
