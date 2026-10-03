import { Context, Duration, Effect, Exit, Fiber, Option, ScopedCache, Scope } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~arforge/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
  readonly scope: Scope.Scope
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    // A cache lookup can be evaluated under a richer Location layer than the
    // layer that constructed this state. Keep the most recent per-directory
    // context so the legacy Promise disposer can close scoped resources with
    // the same services that created them.
    const lookupContexts = new Map<string, Context.Context<never>>()
    const constructionDatabase = yield* Effect.serviceOption(Database.Service)
    const constructionDatabaseContext = Context.addOrOmit(Context.empty(), Database.Service, constructionDatabase)
    const cache = yield* ScopedCache.makeWith<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      // An interrupted initializer must not poison the instance for later
      // callers. Let ScopedCache expire the interrupted entry and close its
      // scope before retrying; successful values and ordinary failures keep
      // their existing lifetime and concurrent lookup deduplication.
      timeToLive: (exit) => (Exit.hasInterrupts(exit) ? Duration.zero : Duration.infinity),
      lookup: () =>
        Effect.gen(function* () {
          const instance = yield* context
          // LayerMap/ScopedCache values expose only their requested location
          // services; provider dependencies (notably Database) are consumed
          // while constructing that context. Preserve the optional database
          // explicitly so invalidation can still close DB-backed finalizers
          // when the caller is an InstanceStore-only runtime.
          const lookupContext = yield* Effect.context()
          const lookupDatabase = yield* Effect.serviceOption(Database.Service)
          const database = Option.getOrUndefined(lookupDatabase) ?? Option.getOrUndefined(constructionDatabase)
          const value = yield* database === undefined
            ? init(instance)
            : init(instance).pipe(Effect.provideService(Database.Service, database))
          // Only retain a context for a materialized cache entry. If init
          // fails, ScopedCache owns the failed lookup cleanup and there is no
          // disposer context to retain.
          // A LayerMap context intentionally exposes only location services;
          // retain the durable database captured by the state owner as a
          // fallback without overriding location-specific services.
          lookupContexts.set(
            instance.directory,
            Context.merge(
              Context.addOrOmit(lookupContext, Database.Service, lookupDatabase),
              constructionDatabaseContext,
            ),
          )
          return value
        }),
    })

    // Keep a construction fallback for lookups that happen before a richer
    // Location layer is installed. The disposer itself now runs inside the
    // InstanceStore Effect runtime, so no Promise boundary can drop services.
    const cacheContext = Context.addOrOmit(
      yield* Effect.context(),
      Database.Service,
      yield* Effect.serviceOption(Database.Service),
    )
    const constructionContext = Context.merge(cacheContext, constructionDatabaseContext)

    // ScopedCache installs its own owning-scope finalizer when it is created.
    // That finalizer closes every entry from the scope-closing fiber, which is
    // often only the test/request context (and therefore has no Database).
    // Close materialized entries first, replaying the context captured for the
    // directory that created each entry; the built-in finalizer then observes
    // an empty map and has nothing left to fork under a pruned context.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Close entry scopes in the owner fiber, not through an unbounded
        // child pool. A scope-closing fiber may expose only the layer/logger
        // context; pin the construction context so DB-backed entry
        // finalizers cannot observe a pruned service map.
        for (const [directory, lookupContext] of lookupContexts) {
          yield* ScopedCache.invalidate(cache, directory).pipe(
            Effect.provide(Context.merge(lookupContext, constructionContext)),
            Effect.ignore,
          )
        }
        yield* ScopedCache.invalidateAll(cache).pipe(Effect.provide(constructionContext), Effect.ignore)
      }).pipe(Effect.provide(constructionContext), Effect.ignore),
    )
    const off = registerDisposer((directory, runtimeContext) => {
      const disposerContext = lookupContexts.get(directory) ?? cacheContext
      return ScopedCache.invalidate(cache, directory).pipe(
        Effect.provide(Context.merge(runtimeContext, disposerContext)),
        Effect.ensuring(Effect.sync(() => lookupContexts.delete(directory))),
      )
    }, Option.getOrUndefined(constructionDatabase))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
      scope,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const key = yield* directory
    // ScopedCache runs a missing lookup in its first caller. Own that lookup
    // in the state scope so cancelling one HTTP request cannot interrupt the
    // shared result for other callers. Joining remains interruptible, and
    // closing the state scope still interrupts pending initialization.
    const fiber = yield* ScopedCache.get(self.cache, key).pipe(
      Effect.forkIn(self.scope, { startImmediately: true }),
    )
    return yield* Fiber.join(fiber)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })

export * as InstanceState from "./instance-state"
