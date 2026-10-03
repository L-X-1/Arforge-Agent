import { describe, expect } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

class CoordinatorContext extends Context.Service<CoordinatorContext, { readonly value: string }>()(
  "@test/SessionRunCoordinatorContext",
) {}

describe("SessionRunCoordinator", () => {
  for (const method of ["wake", "wakeAndWait"] as const) {
    it.live(`does not inherit scoped options into a successful run's queued ${method}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>()
          const releaseFirst = yield* Deferred.make<void>()
          const nextStarted = yield* Deferred.make<void>()
          const releaseNext = yield* Deferred.make<void>()
          type Options = { readonly credentialIDs: readonly string[]; readonly budget: number }
          const observations: Array<{ options: Options | undefined; context: string }> = []
          const coordinator = yield* SessionRunCoordinator.make<string, never, Options>({
            drain: (_key, _force, options) =>
              Effect.gen(function* () {
                const marker = Context.getOption(yield* Effect.context(), CoordinatorContext)
                observations.push({ options, context: marker._tag === "Some" ? marker.value.value : "missing" })
                if (observations.length === 1) {
                  yield* Deferred.succeed(firstStarted, undefined)
                  yield* Deferred.await(releaseFirst)
                } else {
                  yield* Deferred.succeed(nextStarted, undefined)
                  yield* Deferred.await(releaseNext)
                }
              }),
          })
          const options = { credentialIDs: ["one-run-only"], budget: 25 }
          const first = yield* coordinator
            .runWith("session", options)
            .pipe(Effect.provideService(CoordinatorContext, { value: "scoped-owner" }), Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const next = yield* coordinator[method]("session").pipe(
            Effect.provideService(CoordinatorContext, { value: "follow-up-owner" }),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Deferred.await(nextStarted).pipe(Effect.timeout("1 second"))
          expect(observations).toEqual([
            { options, context: "scoped-owner" },
            { options: undefined, context: "follow-up-owner" },
          ])
          // The scoped caller owns its original generation, not an unrelated
          // follow-up. The latter stays active and its waiter is not released early.
          yield* Fiber.join(first).pipe(Effect.timeout("1 second"))
          expect((yield* coordinator.active).has("session")).toBe(true)
          yield* Deferred.succeed(releaseNext, undefined)
          yield* Fiber.join(next).pipe(Effect.timeout("1 second"))
        }),
      ),
    )
  }

  it.live("concurrent resumes share the same failure and allow a subsequent run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const failure = new Error("shared drain failure")
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make<string, Error>({
          drain: () =>
            Effect.gen(function* () {
              runs++
              if (runs !== 1) return
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              yield* Effect.fail(failure)
            }),
        })
        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const second = yield* coordinator.run("session").pipe(Effect.forkChild({ startImmediately: true }))
        expect(runs).toBe(1)
        yield* Deferred.succeed(release, undefined)
        for (const fiber of [first, second]) {
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
        }
        expect((yield* coordinator.active).size).toBe(0)
        yield* coordinator.run("session")
        expect(runs).toBe(2)
        expect((yield* coordinator.active).size).toBe(0)
      }),
    ),
  )

  it.live("exclusive cancellation preserves cleanup defects and releases the slot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const defect = new Error("exclusive cleanup defect")
        const coordinator = yield* SessionRunCoordinator.make<string, never>({ drain: () => Effect.void })
        const work = yield* coordinator
          .exclusive(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.die(defect)),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.interrupt("session")
        const exit = yield* Fiber.await(work)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("exclusive cleanup defect")
        expect((yield* coordinator.active).size).toBe(0)
        expect(yield* coordinator.exclusive("session", Effect.void)).toBe(true)
      }),
    ),
  )

  it.live("exclusive interrupt waits for setup before cancelling and running cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const ready = yield* Deferred.make<void>()
        const cancelling = yield* Deferred.make<void>()
        const order: string[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({ drain: () => Effect.void })
        const work = yield* coordinator
          .exclusive(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  order.push("cleanup")
                }),
              ),
            ),
            Deferred.succeed(cancelling, undefined).pipe(
              Effect.andThen(Deferred.await(ready)),
              Effect.andThen(
                Effect.sync(() => {
                  order.push("cancel-action")
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const cancel = yield* coordinator
          .interrupt(
            "session",
            Effect.sync(() => {
              order.push("cancel-session")
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(cancelling)
        expect(order).toEqual([])
        expect((yield* coordinator.active).has("session")).toBe(true)
        yield* Deferred.succeed(ready, undefined)
        yield* Fiber.join(cancel)
        expect(order).toEqual(["cancel-action", "cancel-session", "cleanup"])
        expect(Exit.isFailure(yield* Fiber.await(work))).toBe(true)
        expect((yield* coordinator.active).size).toBe(0)
      }),
    ),
  )

  for (const method of ["run", "wakeAndWait"] as const) {
    it.live(`exclusive work hands ${method} callers to one fresh drain`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const drainStarted = yield* Deferred.make<void>()
          const finishDrain = yield* Deferred.make<void>()
          let drains = 0
          const coordinator = yield* SessionRunCoordinator.make<string, never>({
            drain: () =>
              Effect.gen(function* () {
                drains++
                yield* Deferred.succeed(drainStarted, undefined)
                yield* Deferred.await(finishDrain)
              }),
          })
          const shell = yield* coordinator
            .exclusive("session", Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
            .pipe(Effect.forkChild)
          yield* Deferred.await(started)
          const first = yield* coordinator[method]("session").pipe(Effect.forkChild({ startImmediately: true }))
          const second = yield* coordinator[method]("session").pipe(Effect.forkChild({ startImmediately: true }))
          expect(drains).toBe(0)
          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(shell)).toBe(true)
          yield* Deferred.await(drainStarted).pipe(Effect.timeout("1 second"))
          expect((yield* coordinator.active).has("session")).toBe(true)
          expect(yield* coordinator.exclusive("session", Effect.die("must not execute"))).toBe(false)
          yield* Deferred.succeed(finishDrain, undefined)
          yield* Effect.all([Fiber.join(first), Fiber.join(second)]).pipe(Effect.timeout("1 second"))
          expect(drains).toBe(1)
          expect((yield* coordinator.active).size).toBe(0)
        }),
      ),
    )
  }

  for (const fail of [false, true]) {
    it.live(`exclusive work runs once before queued drains failure=${fail}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const drained = yield* Deferred.make<void>()
          let commands = 0
          let drains = 0
          const coordinator = yield* SessionRunCoordinator.make<string, string>({
            drain: () =>
              Effect.sync(() => {
                drains++
              }).pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
          })
          const work = Effect.gen(function* () {
            commands++
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            if (fail) yield* Effect.fail("command failed")
          })
          const shell = yield* coordinator.exclusive("session", work).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          expect((yield* coordinator.active).has("session")).toBe(true)
          expect(yield* coordinator.exclusive("session", work)).toBe(false)
          yield* coordinator.wake("session")
          yield* coordinator.wake("session")
          expect(drains).toBe(0)
          yield* Deferred.succeed(release, undefined)
          const exit = yield* Fiber.await(shell)
          expect(Exit.isFailure(exit)).toBe(fail)
          yield* Deferred.await(drained).pipe(Effect.timeout("1 second"))
          expect(commands).toBe(1)
          expect(drains).toBe(1)
        }),
      ),
    )
  }

  it.live("interrupt cleans exclusive work and cancels pending wake without rerunning it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let cleaned = false
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: () =>
            Effect.sync(() => {
              drains++
            }),
        })
        const shell = yield* coordinator
          .exclusive(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session")
        yield* coordinator.interrupt("session")
        const exit = yield* Fiber.await(shell)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(cleaned).toBe(true)
        expect(drains).toBe(0)
        expect((yield* coordinator.active).size).toBe(0)
        yield* coordinator.wakeAndWait("session")
        expect(drains).toBe(1)
      }),
    ),
  )

  it.live("interrupt settles every concurrent resume waiter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        })
        const first = yield* coordinator.run("session").pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        const second = yield* coordinator.run("session").pipe(Effect.forkChild({ startImmediately: true }))
        const third = yield* coordinator.run("session").pipe(Effect.forkChild({ startImmediately: true }))
        yield* coordinator.interrupt("session")
        const exits = yield* Effect.all([Fiber.await(first), Fiber.await(second), Fiber.await(third)]).pipe(
          Effect.timeout("1 second"),
        )
        expect(exits.every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))).toBe(true)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("joins concurrent resumes for one key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(runs).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs an explicit scope after the current run without leaking it to wakeups", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const scopes: Array<{ readonly tag: string } | undefined> = []
        let calls = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never, { readonly tag: string }>({
          drain: (_key, _force, options) =>
            Effect.gen(function* () {
              scopes.push(options)
              calls++
              if (calls === 1) {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(gate)
              }
            }),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const scoped = yield* coordinator.runWith("session", { tag: "credential-scope" }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(scopes).toEqual([undefined])

        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(scoped)])
        expect(scopes).toEqual([undefined, { tag: "credential-scope" }])
      }),
    ),
  )

  it.effect("joins a wake-started execution without forcing a successor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => forces.push(force)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(resumed)

        expect(forces).toEqual([false])
      }),
    ),
  )

  it.effect("starts execution when woken while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drained = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({ drain: () => Deferred.succeed(drained, undefined) })

        yield* coordinator.wake("session")
        yield* Deferred.await(drained)
      }),
    ),
  )

  it.effect("replays the admission context into detached drains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<string>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.contextWith((context) => {
              const marker = Context.getOption(context, CoordinatorContext)
              return Deferred.succeed(started, marker._tag === "Some" ? marker.value.value : "missing").pipe(
                Effect.asVoid,
              )
            }),
        })

        yield* coordinator
          .wake("session")
          .pipe(Effect.provideService(CoordinatorContext, CoordinatorContext.of({ value: "captured" })))
        expect(yield* Deferred.await(started)).toBe("captured")
      }),
    ),
  )

  it.effect("snapshots only active executions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) =>
            Deferred.succeed(key === "first" ? firstStarted : secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(key === "first" ? firstGate : secondGate)),
            ),
        })

        expect(Array.from(yield* coordinator.active)).toEqual([])
        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        expect(Array.from(yield* coordinator.active)).toEqual(["first"])

        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(secondStarted)
        expect(Array.from(yield* coordinator.active)).toEqual(["first", "second"])

        yield* Deferred.succeed(firstGate, undefined)
        yield* Fiber.join(first)
        expect(Array.from(yield* coordinator.active)).toEqual(["second"])
        yield* Deferred.succeed(secondGate, undefined)
        yield* Fiber.join(second)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("cleans active executions after failure and defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new Error("failed")
        const defect = new Error("defect")
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) => (key === "failure" ? Effect.fail(failure) : Effect.die(defect)),
        })

        const failed = yield* coordinator.run("failure").pipe(Effect.exit)
        expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])

        const died = yield* coordinator.run("defect").pipe(Effect.exit)
        expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("cleans active executions when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const coordinator = yield* Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          })
          yield* coordinator.wake("session")
          yield* Deferred.await(started)
          expect(Array.from(yield* coordinator.active)).toEqual(["session"])
          return coordinator
        }),
      )

      expect(Array.from(yield* coordinator.active)).toEqual([])
    }),
  )

  it.effect("coalesces wakes received during active execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        yield* Effect.all([coordinator.wake("session"), coordinator.wake("session"), coordinator.wake("session")], {
          concurrency: "unbounded",
        })
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("wakeAndWait waits for the follow-up registered during an active run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        let runs = 0
        let submittedSettled = false
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
                  : Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate))),
              ),
            ),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        const submitted = yield* coordinator
          .wakeAndWait("session")
          .pipe(Effect.ensuring(Effect.sync(() => (submittedSettled = true))), Effect.forkChild)
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)

        expect(submittedSettled).toBeFalse()
        yield* Deferred.succeed(secondGate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(submitted)])
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("wakeAndWait follows its successor when the active run fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const failure = new Error("previous turn failed")
        let runs = 0
        let submittedSettled = false
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(firstGate)),
                      Effect.andThen(Effect.fail(failure)),
                    )
                  : Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate))),
              ),
            ),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        const submitted = yield* coordinator
          .wakeAndWait("session")
          .pipe(Effect.ensuring(Effect.sync(() => (submittedSettled = true))), Effect.forkChild)
        yield* Deferred.succeed(firstGate, undefined)

        expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(failure)
        yield* Deferred.await(secondStarted)
        expect(submittedSettled).toBeFalse()
        yield* Deferred.succeed(secondGate, undefined)
        yield* Fiber.join(submitted)
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("coalesces concurrent wakeAndWait callers behind one follow-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        const submitted = []
        for (let index = 0; index < 3; index++) {
          submitted.push(yield* coordinator.wakeAndWait("session").pipe(Effect.forkChild))
          // Let each caller register its barrier before the active generation
          // is released. This asserts coalescing without relying on wall time.
          yield* Effect.yieldNow
        }
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* Effect.all([Fiber.join(first), ...submitted.map(Fiber.join)])

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("runs again when woken during the follow-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const thirdStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.await(firstGate)
                  : run === 2
                    ? Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)))
                    : Deferred.succeed(thirdStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(secondGate, undefined)
        yield* Deferred.await(thirdStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(3)
      }),
    ),
  )

  it.effect("does nothing when interrupted while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make({ drain: () => Effect.void })
        yield* coordinator.interrupt("session")
      }),
    ),
  )

  it.effect("interrupts active execution and clears its pending wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session")
        yield* coordinator.interrupt("session")
        yield* Deferred.await(interrupted)

        const exit = yield* Fiber.await(resumed)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("interrupt settles a wakeAndWait barrier instead of stranding the caller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
            ),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const submitted = yield* coordinator.wakeAndWait("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.interrupt("session")

        const [firstExit, submittedExit] = yield* Effect.all([Fiber.await(first), Fiber.await(submitted)])
        expect(Exit.isFailure(firstExit) && Cause.hasInterruptsOnly(firstExit.cause)).toBeTrue()
        expect(Exit.isFailure(submittedExit) && Cause.hasInterruptsOnly(submittedExit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs a wake registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                      ),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(interrupt)
        yield* Deferred.await(secondStarted)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("starts a resume registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) => {
            forces.push(force)
            return forces.length === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                  ),
                )
              : Deferred.succeed(secondStarted, undefined)
          },
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Effect.all([Fiber.join(interrupt), Fiber.join(resumed)])
        yield* Deferred.await(secondStarted)

        expect(forces).toEqual([false, true])
      }),
    ),
  )

  it.effect("starts one follow-up when a wake races with failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const failure = new Error("failed")
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.await(gate).pipe(Effect.andThen(Effect.fail(failure)))
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(gate, undefined)

        expect(yield* Fiber.join(resumed).pipe(Effect.flip)).toBe(failure)
        yield* Deferred.await(secondStarted)
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("does not cancel execution when a joined waiter is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Fiber.interrupt(second)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)

        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs different keys concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const bothStarted = yield* Deferred.make<void>()
        let active = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++active).pipe(
              Effect.tap(() => (active === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(bothStarted)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      }),
    ),
  )

  it.effect("trampolines synchronous self-waking execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const limit = 20_000
        const completed = yield* Deferred.make<void>()
        let runs = 0
        let wake: (key: string) => Effect.Effect<void> = () => Effect.void
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (key) =>
            Effect.sync(() => ++runs).pipe(
              Effect.tap((run) => (run < limit ? wake(key) : Deferred.succeed(completed, undefined))),
              Effect.asVoid,
            ),
        })
        wake = coordinator.wake

        yield* coordinator.wake("session")
        yield* Deferred.await(completed)

        expect(runs).toBe(limit)
      }),
    ),
  )
})
