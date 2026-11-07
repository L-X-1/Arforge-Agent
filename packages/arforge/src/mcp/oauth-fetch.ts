import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { OAuthTokensSchema, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { createHash } from "node:crypto"
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers"

type FetchURL = Parameters<FetchLike>[0]
type FetchInit = Parameters<FetchLike>[1]

export const staleOwner = () =>
  new DOMException("MCP OAuth exchange no longer belongs to the current credential owner", "AbortError")

function refreshKey(url: FetchURL, init: FetchInit) {
  const form = typeof init?.body === "string" || init?.body instanceof URLSearchParams
    ? new URLSearchParams(init.body) : undefined
  if (init?.method?.toUpperCase() !== "POST" || form?.get("grant_type") !== "refresh_token" || !form.get("refresh_token")) return
  return createHash("sha256").update(JSON.stringify([
    String(url), [...new Headers(init.headers)].sort(([a], [b]) => a.localeCompare(b)), form.toString(),
    init.credentials, init.mode, init.redirect, init.cache, init.referrer, init.referrerPolicy, init.integrity,
  ])).digest("hex")
}

export function make(base: FetchLike = fetch) {
  type Flight = {
    epoch: number
    sequence: number
    predecessor?: string
    controller: AbortController
    promise: Promise<Response>
    pending: boolean
    waiters: number
    cacheable: boolean
  }
  type Issued = { epoch: number; flight: Flight; refresh?: string }
  const flights = new Map<string, Flight>()
  const issued = new Map<string, Issued>()
  let epoch = 0,
    managed = false,
    currentRefresh: string | undefined,
    serial = 0,
    sequence = 0,
    committedSequence = 0
  const digest = (value: string) => createHash("sha256").update(value).digest("hex")
  const refreshID = (tokens: OAuthTokens) =>
    tokens.refresh_token === undefined ? undefined : digest(tokens.refresh_token)
  const tokenIdentity = (tokens: OAuthTokens, refresh: string | undefined) =>
    digest(JSON.stringify([digest(tokens.access_token), refresh, tokens.token_type, tokens.scope, tokens.expires_in]))
  const tokenID = (tokens: OAuthTokens) => tokenIdentity(tokens, refreshID(tokens))
  const stale = () =>
    new DOMException("MCP OAuth exchange no longer belongs to the current credential owner", "AbortError")
  const invalidate = () => {
    epoch++
    for (const flight of flights.values()) flight.controller.abort(stale())
    flights.clear()
    issued.clear()
    currentRefresh = undefined
    committedSequence = 0
  }
  const observe = (tokens: OAuthTokens | undefined) => {
    if (tokens && currentRefresh === undefined) currentRefresh = refreshID(tokens)
  }
  const assertSave = (tokens: OAuthTokens) => {
    if (!managed) return
    const value = issued.get(tokenID(tokens))
    if (
      !value ||
      value.epoch !== epoch ||
      value.flight.controller.signal.aborted ||
      value.flight.sequence < committedSequence ||
      (value.flight.predecessor !== undefined &&
        currentRefresh !== undefined &&
        currentRefresh !== value.flight.predecessor &&
        currentRefresh !== value.refresh)
    )
      throw stale()
  }
  const committed = (tokens: OAuthTokens) => {
    assertSave(tokens)
    currentRefresh = refreshID(tokens)
    const id = tokenID(tokens),
      value = issued.get(id)
    if (!value) return
    committedSequence = value.flight.sequence
    // Keep this successful response through saveTokens and its asynchronous
    // storage gap. A caller that already captured the consumed refresh token
    // can still join it. Older rotations cannot overwrite the current one.
    for (const [key, flight] of flights) if (!flight.pending && flight !== value.flight) flights.delete(key)
    for (const [key, old] of issued) if (key !== id && !old.flight.pending) issued.delete(key)
    // A server may retain its refresh token. Once persisted, a future expiry
    // must perform a new exchange rather than replay this old access token.
    if (value.refresh === value.flight.predecessor)
      for (const [key, flight] of flights) if (flight === value.flight) flights.delete(key)
  }
  const track = async (response: Response, flight: Flight) => {
    if (flight.epoch !== epoch || flight.controller.signal.aborted) throw stale()
    if (!response.ok) return response
    let body: unknown
    try {
      body = await response.clone().json()
    } catch {
      return response
    }
    if (flight.epoch !== epoch || flight.controller.signal.aborted) throw stale()
    const decoded = OAuthTokensSchema.safeParse(body)
    if (!decoded.success) return response
    // refreshAuthorization in the installed SDK preserves the predecessor
    // when a successful response omits refresh_token (RFC6749 6).
    const effectiveRefresh =
      decoded.data.refresh_token === undefined ? flight.predecessor : digest(decoded.data.refresh_token)
    issued.set(tokenIdentity(decoded.data, effectiveRefresh), {
      epoch,
      flight,
      refresh: effectiveRefresh,
    })
    flight.cacheable = true
    return response
  }
  const wait = (flight: Flight, signal?: AbortSignal | null): Promise<Response> =>
    new Promise((resolve, reject) => {
      let done = false
      flight.waiters++
      const finish = () => {
        done = true
        flight.waiters--
        signal?.removeEventListener("abort", abort)
        flight.controller.signal.removeEventListener("abort", ownerAbort)
      }
      const ownerAbort = () => {
        if (!done) {
          finish()
          reject(flight.controller.signal.reason ?? stale())
        }
      }
      const abort = () => {
        if (done) return
        finish()
        reject(signal?.reason ?? stale())
        if (flight.pending && flight.waiters === 0) {
          flight.controller.abort(stale())
          for (const [key, value] of flights) if (value === flight) flights.delete(key)
        }
      }
      signal?.addEventListener("abort", abort, { once: true })
      flight.controller.signal.addEventListener("abort", ownerAbort, { once: true })
      if (signal?.aborted) abort()
      if (flight.controller.signal.aborted) ownerAbort()
      void flight.promise.then(
        (response) => {
          if (done) return
          finish()
          if (flight.epoch !== epoch || flight.controller.signal.aborted) reject(stale())
          else resolve(response.clone())
        },
        (error) => {
          if (!done) {
            finish()
            reject(error)
          }
        },
      )
    })
  const ownedFetch: FetchLike = (url, init) => {
    const form =
      typeof init?.body === "string" || init?.body instanceof URLSearchParams
        ? new URLSearchParams(init.body)
        : undefined
    const grant = form?.get("grant_type")
    const refresh = init?.method?.toUpperCase() === "POST" && grant === "refresh_token" && !!form?.get("refresh_token")
    const code = init?.method?.toUpperCase() === "POST" && grant === "authorization_code"
    if (!refresh && !code) return base(url, init)
    managed = true
    const predecessor = refresh ? digest(form!.get("refresh_token")!) : undefined
    const key = refresh ? refreshKey(url, init)! : `code:${serial++}`
    const existing = flights.get(key)
    if (refresh && existing) return wait(existing, init?.signal)
    if (refresh && currentRefresh !== undefined && predecessor !== currentRefresh) return Promise.reject(stale())
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason ?? stale())
    const controller = new AbortController()
    const result = Promise.withResolvers<Response>()
    const flight: Flight = {
      epoch,
      sequence: ++sequence,
      predecessor,
      controller,
      promise: result.promise,
      pending: true,
      waiters: 0,
      cacheable: false,
    }
    flights.set(key, flight)
    let operation: Promise<Response>
    try {
      operation = base(url, refresh ? { ...init, signal: controller.signal } : init)
    } catch (error) {
      operation = Promise.reject(error)
    }
    void operation
      .then((response) => track(response, flight))
      .then(
        (response) => {
          flight.pending = false
          if (!response.ok || !refresh || !flight.cacheable) {
            if (flights.get(key) === flight) flights.delete(key)
          }
          result.resolve(response)
        },
        (error) => {
          flight.pending = false
          if (flights.get(key) === flight) flights.delete(key)
          result.reject(error)
        },
      )
    // A transport owner can close before its first waiter is registered.
    void flight.promise.catch(() => {})
    if (!refresh) return wait(flight, init?.signal).then(() => flight.promise)
    return wait(flight, init?.signal)
  }
  const bind =
    (signal: AbortSignal): FetchLike =>
    (url, init) => {
      if (signal.aborted) return Promise.reject(signal.reason ?? stale())
      return ownedFetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal })
    }
  const proof = (tokens: OAuthTokens): object | undefined => {
    assertSave(tokens)
    return issued.get(tokenID(tokens))?.flight
  }
  return {
    fetch: ownedFetch, bind, observe, assertSave, committed, invalidate, proof,
    canJoin: (url: FetchURL, init: FetchInit) => {
      const key = refreshKey(url, init)
      return key !== undefined && flights.has(key)
    },
    pendingCount: () => [...flights.values()].filter(flight => flight.pending).length,
    cachedCount: () => flights.size,
  }
}

/** The Source23 methods retained by index.ts; storage proofs stay internal. */
export type Owner = Pick<ReturnType<typeof make>, "fetch" | "bind" | "observe" | "assertSave" | "committed" | "invalidate">
export type Subscriber = Owner & {
  proof: (tokens: OAuthTokens) => object | undefined
  responseProof: (response: Response) => object | undefined
  canJoin: (url: FetchURL, init: FetchInit) => boolean
  active: () => boolean
}

// A shared instance is acquired only by the protected-store authority. Bare
// make() deliberately remains isolated for pending authorization and callers
// that have not established a common physical credential owner.
export function shared(onEmpty: () => void, onIdle: () => void = () => {}, base: FetchLike = fetch) {
  const core = make(base)
  const subscribers = new Set<{ accepted: Set<object> }>()
  let idle: ReturnType<typeof scheduleTimeout> | undefined
  const clearIdle = () => { if (idle) cancelTimeout(idle); idle = undefined }
  const invalidate = () => {
    clearIdle()
    core.invalidate()
    for (const subscriber of subscribers) subscriber.accepted.clear()
    onIdle()
  }
  const scheduleIdle = () => {
    clearIdle()
    idle = scheduleTimeout(() => {
      idle = undefined
      // Never expire a network operation. An unsaved issued result is fenced
      // by the store proof; expiry after another successful commit is fail-closed.
      if (core.pendingCount()) { scheduleIdle(); return }
      invalidate()
    }, 60_000)
    idle.unref()
  }
  const committed = (tokens: OAuthTokens, expected?: object) => {
    // A completed protected write is not rolled back if its last transport
    // closed while the atomic writer was already in progress.
    let current: object | undefined
    try { current = core.proof(tokens) } catch { return }
    if (current !== expected) return
    core.committed(tokens)
    for (const subscriber of subscribers)
      for (const proof of subscriber.accepted) if (proof !== current) subscriber.accepted.delete(proof)
    scheduleIdle()
  }
  const attach = (): Subscriber => {
    const state = { accepted: new Set<object>() }
    subscribers.add(state)
    const controller = new AbortController()
    const responses = new WeakMap<Response, object>()
    let active = true
    const assertActive = () => { if (!active || controller.signal.aborted) throw staleOwner() }
    const proof = (tokens: OAuthTokens) => {
      assertActive()
      const value = core.proof(tokens)
      if (value && !state.accepted.has(value)) throw staleOwner()
      return value
    }
    const ownedFetch: FetchLike = async (url, init) => {
      assertActive()
      const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
      const response = await core.fetch(url, { ...init, signal })
      assertActive()
      if (signal.aborted) throw signal.reason ?? staleOwner()
      const form = typeof init?.body === "string" || init?.body instanceof URLSearchParams
        ? new URLSearchParams(init.body) : undefined
      const grant = init?.method?.toUpperCase() === "POST" ? form?.get("grant_type") : undefined
      if (response.ok && (grant === "refresh_token" || grant === "authorization_code")) {
        let body: unknown
        try { body = await response.clone().json() } catch { return response }
        assertActive()
        const decoded = OAuthTokensSchema.safeParse(body)
        if (decoded.success) {
          const effective = {
            ...decoded.data,
            refresh_token: decoded.data.refresh_token ?? (grant === "refresh_token" ? form?.get("refresh_token") ?? undefined : undefined),
          }
          const value = core.proof(effective)
          if (value) { state.accepted.add(value); responses.set(response, value) }
        }
      }
      return response
    }
    return {
      fetch: ownedFetch,
      bind: signal => (url, init) => signal.aborted
        ? Promise.reject(signal.reason ?? staleOwner())
        : ownedFetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
      observe: tokens => { assertActive(); core.observe(tokens) },
      assertSave: tokens => { proof(tokens) },
      committed: tokens => { const value = proof(tokens); committed(tokens, value) },
      proof,
      responseProof: response => responses.get(response),
      canJoin: (url, init) => active && core.canJoin(url, init),
      active: () => active,
      invalidate: () => {
        if (!active) return
        active = false
        controller.abort(staleOwner())
        state.accepted.clear()
        subscribers.delete(state)
        if (!subscribers.size) { invalidate(); onEmpty() }
      },
    }
  }
  return { attach, invalidate, committed, subscribers: () => subscribers.size }
}

/** Stable facade for pending -> committed provider handoff. */
export function delegate(current: () => Owner): Owner {
  return {
    fetch: (url, init) => current().fetch(url, init),
    bind: signal => (url, init) => signal.aborted
      ? Promise.reject(signal.reason ?? staleOwner())
      : current().fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
    observe: tokens => current().observe(tokens),
    assertSave: tokens => current().assertSave(tokens),
    committed: tokens => current().committed(tokens),
    invalidate: () => current().invalidate(),
  }
}

export * as McpOAuthFetch from "./oauth-fetch"
