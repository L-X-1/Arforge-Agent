export * as KeyedMutex from "./keyed-mutex"

import { Effect, Scope, Semaphore } from "effect"

export interface KeyedMutex<in Key> {
  readonly size: Effect.Effect<number>
  readonly acquire: (key: Key) => Effect.Effect<void, never, Scope.Scope>
  readonly withLock: (key: Key) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * Creates an in-memory mutex with one lock per key. Entries are removed when no
 * holder or waiter remains.
 *
 *   same key      -> queue
 *   different key -> run independently
 *
 * `users` counts holders and waiters so an entry is not removed while a waiter
 * will reuse it.
 */
export const makeUnsafe = <Key>(): KeyedMutex<Key> => {
  const locks = new Map<Key, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  const acquire = (key: Key) =>
    Effect.gen(function* () {
      const entry = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const current = locks.get(key)
          const entry = current ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
          if (!current) locks.set(key, entry)
          entry.users++
          return entry
        }),
        (entry) =>
          Effect.sync(() => {
            entry.users--
            if (entry.users === 0) locks.delete(key)
          }),
      )
      yield* Effect.acquireRelease(entry.semaphore.take(1), () => entry.semaphore.release(1), { interruptible: true })
    })

  return {
    size: Effect.sync(() => locks.size),
    acquire,
    withLock: (key) => (effect) =>
      Effect.scopedWith((scope) => acquire(key).pipe(Scope.provide(scope), Effect.andThen(effect))),
  }
}

/** Creates an in-memory keyed mutex inside an Effect workflow. */
export const make = <Key>(): Effect.Effect<KeyedMutex<Key>> => Effect.sync(makeUnsafe<Key>)
