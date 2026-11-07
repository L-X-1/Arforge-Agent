import { Effect, Effectable } from "effect"

type OperationScope = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/** Keep query construction lazy; authorize only SQL execution and explicit transactions. */
export const withPrincipalQueries = <T extends object>(target: T, scope: OperationScope): T => {
  const cache = new WeakMap<object, object>()
  const wrap = <T extends object>(source: T, queryMap = false): T => {
    const existing = cache.get(source)
    if (existing) return existing as T
    // Cover both yield* query and Effect.map/query.pipe: the latter evaluate
    // the Effect protocol directly and never call Symbol.iterator.
    const executable = Effect.isEffect(source)
      ? Effectable.Prototype({ label: "PrincipalQuery", evaluate: () => scope(source) })
      : undefined
    const proxy = new Proxy(source, {
      get(source, property) {
        if (property === "$client") return Reflect.get(source, property, source)
        if (property === "pipe")
          return (...operations: Array<(value: unknown) => unknown>) =>
            operations.reduce((value, operation) => operation(value), proxy as unknown)
        if (executable && property in executable) return Reflect.get(executable, property, proxy)
        const value = Reflect.get(source, property, source)
        if (property === "query" && typeof value === "object" && value !== null) return wrap(value, true)
        // Relational builders live one level below db.query. Their methods
        // must return scoped Effects just like db.select()/prepare().execute().
        if (queryMap && typeof value === "object" && value !== null) return wrap(value)
        if (typeof value !== "function") return value
        if (property === "transaction")
          return (callback: (transaction: object) => Effect.Effect<unknown, unknown, unknown>, ...args: unknown[]) =>
            scope(
              Effect.suspend(() => value.call(source, (transaction: object) => callback(wrap(transaction)), ...args)),
            )
        return (...args: unknown[]) => {
          const result = value.apply(source, args)
          // .values() may return an executable INSERT builder that must still
          // accept .onConflictDoNothing()/returning(), rather than execute now.
          if ((typeof result === "object" && result !== null) || typeof result === "function") return wrap(result)
          return result
        }
      },
    })
    cache.set(source, proxy)
    return proxy
  }
  return wrap(target)
}
