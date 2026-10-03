import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import {
  DEFAULT_TOOL_QUIESCENCE_TIMEOUT_MS,
  MAX_TOOL_QUIESCENCE_TIMEOUT_MS,
  make as makeToolScheduler,
} from "../src/tool/scheduler"

const metadata = (concurrency: "exclusive" | "safe" | "keyed", resourceKey?: string) => ({
  concurrency,
  ...(resourceKey === undefined ? {} : { resourceKey }),
})

describe("bounded Tool Scheduler", () => {
  it("lets trusted coordination await a child in a one-permit lane without blocking child quiescence", async () => {
    const scheduler = makeToolScheduler(1)
    const result = await Effect.runPromise(
      scheduler
        .run({
          metadata: metadata("exclusive"),
          coordinatesChildren: true,
          effect: Effect.gen(function* () {
            const child = yield* scheduler.run({ metadata: metadata("exclusive"), effect: Effect.succeed("child") })
            expect(yield* scheduler.active).toBe(0)
            expect(yield* scheduler.quiesce(0)).toEqual({ status: "quiescent", active: 0 })
            return child
          }),
        })
        .pipe(Effect.timeout("1 second")),
    )
    expect(result).toBe("child")
  })

  it("cancelling coordination cancels its child and releases the leaf permit", async () => {
    const scheduler = makeToolScheduler(1)
    await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const parent = yield* scheduler
          .run({
            metadata: metadata("exclusive"),
            coordinatesChildren: true,
            effect: scheduler.run({
              metadata: metadata("exclusive"),
              effect: Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        yield* Fiber.interrupt(parent)
        expect(yield* scheduler.quiesce(0)).toEqual({ status: "quiescent", active: 0 })
        expect(yield* scheduler.run({ metadata: metadata("exclusive"), effect: Effect.succeed("next") })).toBe("next")
      }).pipe(Effect.timeout("1 second")),
    )
  })

  it("caps safe work at the configured rolling pool size", async () => {
    const scheduler = makeToolScheduler(2)
    let active = 0
    let maximum = 0
    const work = (value: number) =>
      scheduler.run({
        metadata: metadata("safe"),
        effect: Effect.gen(function* () {
          active += 1
          maximum = Math.max(maximum, active)
          yield* Effect.sleep("15 millis")
          active -= 1
          return value
        }),
      })

    const values = await Effect.runPromise(
      Effect.all([work(1), work(2), work(3), work(4)], { concurrency: "unbounded" }),
    )
    expect(values).toEqual([1, 2, 3, 4])
    expect(maximum).toBe(2)
    expect(active).toBe(0)
  })

  it("keeps exclusive work as a barrier against safe work", async () => {
    const scheduler = makeToolScheduler(2)
    let active = 0
    let exclusiveOverlap = false
    const safe = (duration: number) =>
      scheduler.run({
        metadata: metadata("safe"),
        effect: Effect.gen(function* () {
          active += 1
          yield* Effect.sleep(`${duration} millis`)
          active -= 1
        }),
      })
    const exclusive = scheduler.run({
      metadata: metadata("exclusive"),
      effect: Effect.gen(function* () {
        if (active !== 0) exclusiveOverlap = true
        active += 1
        yield* Effect.sleep("5 millis")
        active -= 1
      }),
    })

    await Effect.runPromise(Effect.all([safe(25), safe(10), exclusive, safe(5)], { concurrency: "unbounded" }))
    expect(exclusiveOverlap).toBe(false)
    expect(active).toBe(0)
  })

  it("serializes the same keyed resource while allowing different resources to overlap", async () => {
    const scheduler = makeToolScheduler(3)
    let active = 0
    let sameKeyOverlap = false
    let differentKeyOverlap = false
    const starts = new Map<string, number>()
    const work = (key: string) =>
      scheduler.run({
        metadata: metadata("keyed", key),
        effect: Effect.gen(function* () {
          if ((starts.get(key) ?? 0) > 0) sameKeyOverlap = true
          if (active > 0 && key === "y") differentKeyOverlap = true
          starts.set(key, (starts.get(key) ?? 0) + 1)
          active += 1
          yield* Effect.sleep("15 millis")
          active -= 1
          starts.set(key, (starts.get(key) ?? 1) - 1)
        }),
      })

    await Effect.runPromise(Effect.all([work("x"), work("x"), work("y")], { concurrency: "unbounded" }))
    expect(sameKeyOverlap).toBe(false)
    expect(differentKeyOverlap).toBe(true)
    expect(active).toBe(0)
  })

  it("fails closed to exclusive when a direct caller omits a keyed resource", async () => {
    const scheduler = makeToolScheduler(2)
    let active = 0
    let overlap = false
    const work = scheduler.run({
      metadata: metadata("keyed"),
      effect: Effect.gen(function* () {
        if (active > 0) overlap = true
        active += 1
        yield* Effect.sleep("10 millis")
        active -= 1
      }),
    })
    await Effect.runPromise(Effect.all([work, work], { concurrency: "unbounded" }))
    expect(overlap).toBe(false)
    expect(active).toBe(0)
  })

  it("releases a permit when a running call is cancelled so queued work can drain", async () => {
    const scheduler = makeToolScheduler(1)
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const queuedStarted = await Effect.runPromise(Deferred.make<void>())
    const program = Effect.gen(function* () {
      const first = yield* scheduler
        .run({
          metadata: metadata("safe"),
          effect: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const second = yield* scheduler
        .run({ metadata: metadata("safe"), effect: Deferred.succeed(queuedStarted, undefined) })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(queuedStarted)).toBe(false)
      yield* Fiber.interrupt(first)
      yield* Fiber.join(second)
      expect(yield* Deferred.isDone(queuedStarted)).toBe(true)
    })
    await Effect.runPromise(program)
  })

  it("reports quiescence only after every admitted execution releases", async () => {
    const scheduler = makeToolScheduler(2)
    const release = await Effect.runPromise(Deferred.make<void>())
    const started = await Effect.runPromise(Deferred.make<void>())
    const program = Effect.gen(function* () {
      const running = yield* scheduler
        .run({
          metadata: metadata("safe"),
          effect: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(yield* scheduler.active).toBe(1)
      const pending = yield* scheduler.quiesce(25)
      expect(pending).toEqual({ status: "timed_out", active: 1 })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(yield* scheduler.quiesce(DEFAULT_TOOL_QUIESCENCE_TIMEOUT_MS)).toEqual({
        status: "quiescent",
        active: 0,
      })
      expect(yield* scheduler.active).toBe(0)
    })
    await Effect.runPromise(program)
  })

  it("rejects an unbounded quiescence timeout instead of silently waiting forever", async () => {
    const scheduler = makeToolScheduler()
    const tooLong = await Effect.runPromise(scheduler.quiesce(MAX_TOOL_QUIESCENCE_TIMEOUT_MS + 1).pipe(Effect.exit))
    const negative = await Effect.runPromise(scheduler.quiesce(-1).pipe(Effect.exit))
    expect(tooLong._tag).toBe("Failure")
    expect(negative._tag).toBe("Failure")
  })
})
