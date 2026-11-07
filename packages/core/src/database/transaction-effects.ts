import { Context, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

interface CommitEffects {
  readonly effects: Array<Effect.Effect<void>>
  state: "open" | "closed"
}

// Use the SQL client's own identity: separate Database services must never share
// a queue, while root handles, transaction handles and principal scopes must.
const current = (client: SqlClient) =>
  Context.Reference<CommitEffects | undefined>(`${client.transactionService.key}/arforge.commitEffects`, {
    defaultValue: () => undefined,
  })

/** A background owner keeps identity and source services, never a caller's SQL lifetime. */
export const detachedContext = <R>(client: SqlClient, context: Context.Context<R>) =>
  context.pipe(Context.omit(client.transactionService, current(client)))

/** Queue in the current savepoint, or execute inline when no transaction owns it. */
export const afterCommit = (client: SqlClient, effect: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const reference = current(client)
    const frame = yield* reference
    if (!frame) return yield* effect
    if (frame.state !== "open")
      return yield* Effect.die(new Error("Completed SQL transaction context escaped its owner"))
    // Preserve the publishing caller's services (principal/location included),
    // but never retain a released SQL connection or append to a completed queue.
    const context = detachedContext(client, yield* Effect.context())
    // provideContext merges with the runtime context, which could itself have
    // captured this SQL lifetime. Remove it from the effective context too.
    frame.effects.push(
      Effect.updateContext(effect, (runtime) => detachedContext(client, Context.merge(runtime, context))),
    )
    return undefined
  })

/** Wrap the actual transaction effect, including its COMMIT and connection release. */
export const withCommitEffects = <A, E, R>(client: SqlClient, transaction: Effect.Effect<A, E, R>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const reference = current(client)
      const parent = yield* reference
      if (parent?.state === "closed")
        return yield* Effect.die(new Error("Completed SQL transaction context escaped its owner"))
      const frame: CommitEffects = { effects: [], state: "open" }
      const result = yield* Effect.provideService(restore(transaction), reference, frame).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            frame.state = "closed"
          }),
        ),
      )
      // This line is reached only after the physical commit/savepoint succeeds.
      // Failed bodies, savepoints and COMMITs discard their whole private queue.
      if (parent) parent.effects.push(...frame.effects)
      else for (const effect of frame.effects) yield* restore(effect)
      return result
    }),
  )

/** Keep Drizzle's transaction/config/query API and wrap nested handles as well. */
export const withTransactionEffects = <T extends object>(target: T, client: SqlClient): T => {
  const cache = new WeakMap<object, object>()
  const wrap = <T extends object>(target: T): T => {
    const existing = cache.get(target)
    if (existing) return existing as T
    const proxy = new Proxy(target, {
      get(source, property) {
        // SqlClient is itself callable and carries the transaction service.
        // Binding it as an ordinary method would drop those service properties.
        if (property === "$client") return client
        const value = Reflect.get(source, property, source)
        if (typeof value !== "function") return value
        if (property === "transaction") {
          return (callback: (transaction: object) => Effect.Effect<unknown, unknown, unknown>, ...args: unknown[]) =>
            withCommitEffects(
              client,
              Effect.suspend(() => value.call(source, (transaction: object) => callback(wrap(transaction)), ...args)),
            )
        }
        return value.bind(source)
      },
    })
    cache.set(target, proxy)
    return proxy
  }
  return wrap(target)
}
