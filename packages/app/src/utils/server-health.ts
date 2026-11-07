import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { authTokenFromCredentials, createSdkForServer } from "./server"
import { ClientError, Arforge } from "@arforge-ai/client"
import { Accessor, createEffect, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export type ServerHealth = { healthy: boolean; version?: string }

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 30_000
const defaultRetryCount = 2
const defaultRetryDelayMs = 100
const cacheMs = 750
const healthCache = new Map<
  string,
  { at: number; done: boolean; fetch: typeof globalThis.fetch; promise: Promise<ServerHealth> }
>()

function cacheKey(server: ServerConnection.HttpBase) {
  return `${server.url}\n${server.username ?? ""}\n${server.password ?? ""}`
}

function timeoutSignal(timeoutMs: number) {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (timeout) {
    try {
      return {
        signal: timeout.call(AbortSignal, timeoutMs),
        clear: undefined as (() => void) | undefined,
      }
    } catch {}
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryable(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false
  if (error instanceof ClientError) return error.reason === "Transport"
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  if (error instanceof TypeError) return true
  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

export async function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  const timeout = opts?.signal ? undefined : timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs)
  const signal = opts?.signal ?? timeout?.signal
  const retryCount = opts?.retryCount ?? defaultRetryCount
  const retryDelayMs = opts?.retryDelayMs ?? defaultRetryDelayMs
  const next = (count: number, error: unknown) => {
    if (count >= retryCount || !retryable(error, signal)) return Promise.resolve({ healthy: false } as const)
    return wait(retryDelayMs * (count + 1), signal)
      .then(() => attempt(count + 1))
      .catch(() => ({ healthy: false }))
  }
  const attempt = async (count: number): Promise<ServerHealth> => {
    const current = await Arforge.make({
      baseUrl: server.url,
      fetch,
      headers: server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
          }
        : undefined,
    })
      .health.get({ signal })
      .then((x) =>
        typeof x.healthy === "boolean"
          ? { data: { healthy: x.healthy, version: x.version } }
          : { error: new Error("Invalid health response") },
      )
      .catch((error) => ({ error }))
    if ("data" in current && current.data) return current.data
    if (signal?.aborted) return { healthy: false }

    return createSdkForServer({ server, fetch, signal })
      .global.health()
      .then((x) => (x.error ? next(count, x.error) : { healthy: x.data?.healthy === true, version: x.data?.version }))
      .catch((error) => next(count, error))
  }
  return attempt(0).finally(() => timeout?.clear?.())
}

const pollMs = 10_000

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase, options?: { force?: boolean }) => {
    // Keep both protocol attempts bound to the credentials that started them.
    const source = { ...http }
    const key = cacheKey(source)
    const hit = healthCache.get(key)
    const now = Date.now()
    if (hit && hit.fetch === fetcher && (!hit.done || (!options?.force && now - hit.at < cacheMs))) return hit.promise
    const promise = checkServerHealth(source, fetcher).finally(() => {
      const next = healthCache.get(key)
      if (!next || next.promise !== promise) return
      next.done = true
      next.at = Date.now()
    })
    healthCache.set(key, { at: now, done: false, fetch: fetcher, promise })
    return promise
  }
}

export const createServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)
  let generation = 0
  let disposed = false
  let identities = new Map<ServerConnection.Key, string>()

  const probe = async (conn: ServerConnection.Any, force: boolean): Promise<ServerHealth | undefined> => {
    const key = ServerConnection.key(conn)
    const source = { ...conn.http }
    const identity = cacheKey(source)
    const expectedGeneration = generation
    const active = () => !disposed && enabled() && generation === expectedGeneration &&
      servers().some((item) => ServerConnection.key(item) === key && cacheKey(item.http) === identity)
    if (!active()) return
    const result = await checkServerHealth(source, { force }).catch(() => ({ healthy: false }))
    if (!active()) return
    setStatus(key, result)
    return result
  }

  onCleanup(() => { disposed = true; generation++ })

  createEffect(() => {
    generation++
    if (!enabled()) {
      identities.clear()
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    const nextIdentities = new Map<ServerConnection.Key, string>()
    const retained: Record<string, ServerHealth> = {}
    for (const conn of list) {
      const key = ServerConnection.key(conn)
      const identity = cacheKey(conn.http)
      nextIdentities.set(key, identity)
      const previous = untrack(() => status[key])
      if (identities.get(key) === identity && previous) retained[key] = previous
    }
    identities = nextIdentities
    setStatus(reconcile(retained))

    const poll = () => { for (const conn of list) void probe(conn, false) }
    poll()
    const id = setInterval(poll, pollMs)
    onCleanup(() => {
      generation++
      clearInterval(id)
    })
  })

  return { status, refresh: (conn: ServerConnection.Any) => probe(conn, true) }
}

// Existing consumers retain their record-shaped API and normal cache behavior.
export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) =>
  createServerHealth(servers, enabled).status
