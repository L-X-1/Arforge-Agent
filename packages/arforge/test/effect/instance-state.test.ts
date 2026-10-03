import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { $ } from "bun"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import {
  disposeAllInstancesEffect,
  provideInstanceEffect,
  reloadInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer))

class CleanupDependency extends Context.Service<CleanupDependency, { readonly mark: () => void }>()(
  "@test/InstanceStateCleanupDependency",
) {}

const access = <A, E, R>(state: InstanceState.InstanceState<A, E, R>, dir: string) =>
  InstanceState.get(state).pipe(provideInstanceEffect(dir))

const tmpdirGitScoped = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  yield* Effect.promise(() => $`git commit --allow-empty --amend -m ${`root commit ${dir}`}`.cwd(dir).quiet())
  return dir
})

it.live("InstanceState caches values per directory", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make(() => Effect.sync(() => ({ n: ++n })))

    const a = yield* access(state, dir)
    const b = yield* access(state, dir)

    expect(a).toBe(b)
    expect(n).toBe(1)
  }),
)

it.live("InstanceState keeps shared initialization alive when its first caller cancels", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const started = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<void>()
    const releases: number[] = []
    let attempts = 0
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const attempt = yield* Effect.acquireRelease(
          Effect.sync(() => ++attempts),
          (value) =>
            Effect.sync(() => {
              releases.push(value)
            }),
        )
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(ready)
        return { attempt }
      }),
    )

    const first = yield* access(state, dir).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const readers = yield* Effect.all(
      Array.from({ length: 8 }, () => access(state, dir)),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(first)
    expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
    expect(releases).toEqual([])
    yield* Deferred.succeed(ready, undefined)

    const recovered = yield* Fiber.join(readers)
    expect(attempts).toBe(1)
    expect(recovered[0]).toEqual({ attempt: 1 })
    for (const value of recovered) expect(value).toBe(recovered[0])
    expect(releases).toEqual([])
    expect(yield* access(state, dir)).toBe(recovered[0])

    yield* InstanceState.invalidate(state).pipe(provideInstanceEffect(dir))
    expect(releases).toEqual([1])
  }),
)

it.live("InstanceState closes pending initialization with its owning scope after a caller cancels", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const started = yield* Deferred.make<void>()
    let releases = 0

    yield* Effect.scoped(Effect.gen(function* () {
      const state = yield* InstanceState.make(() =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => { releases++ }))
          yield* Deferred.succeed(started, undefined)
          yield* Effect.never
        }),
      )
      const caller = yield* access(state, dir).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(caller)
      expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true)
      expect(releases).toBe(0)
    }))

    expect(releases).toBe(1)
  }),
)

it.live("InstanceState retries an initializer that interrupts itself", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let attempts = 0
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        attempts++
        if (attempts === 1) return yield* Effect.interrupt
        return { ready: true }
      }),
    )

    expect(Exit.hasInterrupts(yield* Effect.exit(access(state, dir)))).toBe(true)
    const recovered = yield* access(state, dir)
    expect(recovered).toEqual({ ready: true })
    expect(yield* access(state, dir)).toBe(recovered)
    expect(attempts).toBe(2)
  }),
)

for (const failure of ["typed failure", "defect"] as const) {
  it.live("InstanceState preserves cached " + failure, () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      let attempts = 0
      const state = yield* InstanceState.make(() =>
        Effect.gen(function* () {
          attempts++
          return yield* failure === "typed failure" ? Effect.fail("fixture failure") : Effect.die("fixture defect")
        }),
      )

      const first = yield* Effect.exit(access(state, dir))
      const second = yield* Effect.exit(access(state, dir))
      expect(Exit.isFailure(first)).toBe(true)
      expect(second).toEqual(first)
      expect(attempts).toBe(1)
    }),
  )
}

it.live("InstanceState isolates directories", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make((dir) => Effect.sync(() => ({ dir, n: ++n })))

    const a = yield* access(state, one)
    const b = yield* access(state, two)
    const c = yield* access(state, one)

    expect(a).toBe(c)
    expect(a).not.toBe(b)
    expect(n).toBe(2)
  }),
)

it.live("InstanceState invalidates on reload", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const seen: string[] = []
    let n = 0
    const state = yield* InstanceState.make(() =>
      Effect.acquireRelease(
        Effect.sync(() => ({ n: ++n })),
        (value) =>
          Effect.sync(() => {
            seen.push(String(value.n))
          }),
      ),
    )

    const a = yield* access(state, dir)
    yield* reloadInstance({ directory: dir })
    const b = yield* access(state, dir)

    expect(a).not.toBe(b)
    expect(seen).toEqual(["1"])
  }),
)

it.live("InstanceState invalidates on disposeAll", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const seen: string[] = []
    const state = yield* InstanceState.make((ctx) =>
      Effect.acquireRelease(
        Effect.sync(() => ({ dir: ctx.directory })),
        (value) =>
          Effect.sync(() => {
            seen.push(value.dir)
          }),
      ),
    )

    yield* access(state, one)
    yield* access(state, two)
    yield* disposeAllInstancesEffect

    expect(seen.sort()).toEqual([one, two].sort())
  }),
)

it.live("InstanceState invalidation preserves the construction service context", () => {
  let cleanups = 0
  return Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const state = yield* InstanceState.make(() =>
      Effect.acquireRelease(Effect.succeed(true), () =>
        Effect.gen(function* () {
          const dependency = yield* CleanupDependency
          yield* Effect.sync(dependency.mark)
        }),
      ),
    )

    yield* access(state, dir)
    yield* disposeAllInstancesEffect

    expect(cleanups).toBe(1)
  }).pipe(
    Effect.provide(
      Layer.succeed(
        CleanupDependency,
        CleanupDependency.of({
          mark: () => {
            cleanups++
          },
        }),
      ),
    ),
  )
})

it.live("InstanceState.get reads the current directory lazily", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/InstanceStateLazy") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))
          const get = InstanceState.get(state)

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              return yield* get
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const a = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      const b = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(two))

      expect(a).toBe(one)
      expect(b).toBe(two)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState preserves directory across async boundaries", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirGitScoped
    const two = yield* tmpdirGitScoped
    const three = yield* tmpdirGitScoped

    interface Api {
      readonly get: () => Effect.Effect<{ directory: string; worktree: string; project: string }>
    }

    class Test extends Context.Service<Test, Api>()("@test/InstanceStateAsync") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) =>
            Effect.sync(() => ({
              directory: ctx.directory,
              worktree: ctx.worktree,
              project: ctx.project.id,
            })),
          )

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              yield* Effect.sleep(Duration.millis(1))
              yield* Effect.sleep(Duration.millis(1))
              for (let i = 0; i < 100; i++) {
                yield* Effect.yieldNow
              }
              for (let i = 0; i < 100; i++) {
                yield* Effect.promise(() => Promise.resolve())
              }
              yield* Effect.sleep(Duration.millis(2))
              yield* Effect.sleep(Duration.millis(1))
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const [a, b, c] = yield* Effect.all(
        [one, two, three].map((dir) => Test.use((svc) => svc.get()).pipe(provideInstanceEffect(dir))),
        { concurrency: "unbounded" },
      )

      expect(a).toEqual({ directory: one, worktree: one, project: a.project })
      expect(b).toEqual({ directory: two, worktree: two, project: b.project })
      expect(c).toEqual({ directory: three, worktree: three, project: c.project })
      expect(a.project).not.toBe(b.project)
      expect(a.project).not.toBe(c.project)
      expect(b.project).not.toBe(c.project)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState survives high-contention concurrent access", () =>
  Effect.gen(function* () {
    const dirs = yield* Effect.all(
      Array.from({ length: 20 }, () => tmpdirScoped()),
      { concurrency: "unbounded" },
    )

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/HighContention") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              for (let i = 0; i < 10; i++) {
                yield* Effect.sleep(Duration.millis(Math.random() * 3))
                yield* Effect.yieldNow
                yield* Effect.promise(() => Promise.resolve())
              }
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const results = yield* Effect.all(
        dirs.map((dir) => Test.use((svc) => svc.get()).pipe(provideInstanceEffect(dir))),
        { concurrency: "unbounded" },
      )

      expect(results).toEqual(dirs)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState correct after interleaved init and dispose", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/InterleavedDispose") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) =>
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(5))
              return ctx.directory
            }),
          )

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const a = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      expect(a).toBe(one)

      const [, b] = yield* Effect.all(
        [reloadInstance({ directory: one }), Test.use((svc) => svc.get()).pipe(provideInstanceEffect(two))],
        { concurrency: "unbounded" },
      )
      expect(b).toBe(two)

      const c = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      expect(c).toBe(one)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState mutation in one directory does not leak to another", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const state = yield* InstanceState.make(() => Effect.sync(() => ({ count: 0 })))

    const s1 = yield* access(state, one)
    s1.count = 42

    const s2 = yield* access(state, two)
    expect(s2.count).toBe(0)

    const s1again = yield* access(state, one)
    expect(s1again.count).toBe(42)
    expect(s1again).toBe(s1)
  }),
)

it.live("InstanceState dedupes concurrent lookups", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        n += 1
        yield* Effect.sleep(Duration.millis(10))
        return { n }
      }),
    )

    const [a, b] = yield* Effect.all([access(state, dir), access(state, dir)], { concurrency: "unbounded" })
    expect(a).toBe(b)
    expect(n).toBe(1)
  }),
)

it.live("InstanceState survives deferred resume from the same instance context", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })

    interface Api {
      readonly get: (gate: Deferred.Deferred<void>) => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/DeferredResume") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* (gate: Deferred.Deferred<void>) {
              yield* Deferred.await(gate)
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Test.use((svc) => svc.get(gate)).pipe(provideInstanceEffect(dir), Effect.forkScoped)

      yield* Deferred.succeed(gate, undefined).pipe(provideInstanceEffect(dir))
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe(dir)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState survives deferred resume outside ALS when InstanceRef is set", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })

    interface Api {
      readonly get: (gate: Deferred.Deferred<void>) => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/DeferredResumeOutside") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* (gate: Deferred.Deferred<void>) {
              yield* Deferred.await(gate)
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Test.use((svc) => svc.get(gate)).pipe(provideInstanceEffect(dir), Effect.forkScoped)

      yield* Deferred.succeed(gate, undefined)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe(dir)
    }).pipe(Effect.provide(Test.layer))
  }),
)
