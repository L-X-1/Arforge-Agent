/**
 * A controller belongs to one SDK instance and Session, not to a URL.
 * The request fence also runs after awaits, before callers can chain another API call.
 */
export class ManagementScopeExpired extends Error {
  constructor() {
    super("The originating management scope is no longer active.")
  }
}

export function createManagementScope<S>(
  source: S,
  sessionID: string,
  current: () => { source: S; sessionID: string },
) {
  let disposed = false
  const generations = new Map<string, number>()
  const live = () => {
    if (disposed) return false
    try {
      const value = current()
      return value.source === source && value.sessionID === sessionID
    } catch {
      return false
    }
  }
  const assert = () => {
    if (!live()) throw new ManagementScopeExpired()
  }
  return {
    source,
    sessionID,
    live,
    assert,
    dispose: () => { disposed = true },
    next(channel: string) {
      const generation = (generations.get(channel) ?? 0) + 1
      generations.set(channel, generation)
      return () => live() && generations.get(channel) === generation
    },
  }
}

export type ManagementScope = Pick<ReturnType<typeof createManagementScope>, "live" | "assert" | "next">

/** Preserve the API, arguments, receiver, revisions and results; only fence its lifetime. */
export function bindManagementApi<T extends object>(api: T, scope: ManagementScope): T {
  const cache = new WeakMap<object, object>()
  const bind = <V extends object>(target: V): V => {
    const existing = cache.get(target)
    if (existing) return existing as V
    const proxy = new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key)
        if (typeof value === "function") {
          return async (...args: unknown[]) => {
            scope.assert()
            const result = await Reflect.apply(value, object, args)
            scope.assert()
            return result
          }
        }
        return value !== null && typeof value === "object" ? bind(value) : value
      },
    })
    cache.set(target, proxy)
    return proxy
  }
  return bind(api)
}

export async function loadManagementPartition<T>(
  scope: ManagementScope,
  channel: string,
  read: () => Promise<T>,
  events: {
    start: () => void
    commit: (value: T) => void
    fail: (error: unknown) => void
    finish: () => void
  },
) {
  if (!scope.live()) return false
  const current = scope.next(channel)
  events.start()
  try {
    const value = await read()
    if (!current()) return false
    events.commit(value)
    return true
  } catch (error) {
    if (current()) events.fail(error)
    return false
  } finally {
    if (current()) events.finish()
  }
}

export type ManagementPartition = { loading: boolean; fresh: boolean; error: string }

export function managementWriteBlocked(input: {
  live: boolean
  saving: boolean
  identity: ManagementPartition
  activity: ManagementPartition
  section: ManagementPartition
}) {
  return !input.live || input.saving ||
    [input.identity, input.activity, input.section].some((part) => part.loading || !part.fresh)
}

export class ManagementRefreshFailure extends Error {
  constructor(readonly reason: unknown) {
    super("The write was confirmed, but refreshing its view failed.")
  }
}

export async function afterManagementWrite<T>(refresh: () => Promise<T>) {
  try {
    return await refresh()
  } catch (error) {
    if (error instanceof ManagementScopeExpired) throw error
    throw new ManagementRefreshFailure(error)
  }
}

export type ManagementMutationResult =
  | { status: "confirmed" }
  | { status: "confirmed-refresh-failed"; error: unknown }
  | { status: "failed"; error: unknown }
  | { status: "stale" }

export async function runManagementMutation(
  scope: ManagementScope,
  action: () => Promise<unknown>,
  refresh?: () => Promise<unknown>,
): Promise<ManagementMutationResult> {
  if (!scope.live()) return { status: "stale" }
  try {
    await action()
    scope.assert()
    if (refresh) await afterManagementWrite(refresh)
    scope.assert()
    return { status: "confirmed" }
  } catch (error) {
    if (!scope.live() || error instanceof ManagementScopeExpired) return { status: "stale" }
    if (error instanceof ManagementRefreshFailure) return { status: "confirmed-refresh-failed", error: error.reason }
    return { status: "failed", error }
  }
}

/**
 * Keep an acknowledged write's pending read recovery until all reads succeed.
 * Retrying this path never repeats the write and cannot cross its source scope.
 */
export function createManagementReadRecovery(scope: ManagementScope) {
  let pending: (() => Promise<unknown>) | undefined
  return {
    require(read: () => Promise<unknown>) {
      scope.assert()
      pending = read
    },
    async refresh<T>(read: () => Promise<T>): Promise<T> {
      scope.assert()
      const recovery = pending
      if (recovery) await recovery()
      scope.assert()
      const result = await read()
      scope.assert()
      if (pending === recovery) pending = undefined
      return result
    },
  }
}
