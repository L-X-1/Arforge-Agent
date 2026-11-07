import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import path from "path"
import { serviceUse } from "@arforge-ai/core/effect/service-use"
import { Global } from "@arforge-ai/core/global"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"
import { ProtectedJson } from "@arforge-ai/core/protected-json"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { createHash } from "node:crypto"
import { McpOAuthFetch } from "./oauth-fetch"
import { McpAuthReadCache } from "./auth-read-cache"

export const Tokens = Schema.Struct({
  accessToken: Schema.mutableKey(Schema.String),
  refreshToken: Schema.mutableKey(Schema.optional(Schema.String)),
  expiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  scope: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Tokens = Schema.Schema.Type<typeof Tokens>

export const ClientInfo = Schema.Struct({
  clientId: Schema.mutableKey(Schema.String),
  clientSecret: Schema.mutableKey(Schema.optional(Schema.String)),
  clientIdIssuedAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  clientSecretExpiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
})
export type ClientInfo = Schema.Schema.Type<typeof ClientInfo>

export const Entry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),
  codeVerifier: Schema.mutableKey(Schema.optional(Schema.String)),
  oauthState: Schema.mutableKey(Schema.optional(Schema.String)),
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Entry = Schema.Schema.Type<typeof Entry>

const decodeAuthData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Entry))
type AuthData = Record<string, Entry>

const filepath = path.join(Global.Path.data, "mcp-auth.json")
const lockKey = `mcp-auth:${filepath}`

export interface OAuthSession {
  readonly oauthFetch: McpOAuthFetch.Owner
  readonly read: () => Effect.Effect<Entry | undefined>
  readonly saveTokens: (tokens: Tokens, issued: OAuthTokens) => Effect.Effect<void>
  readonly saveClientInfo: (info: ClientInfo) => Effect.Effect<void>
  readonly invalidateCredentials: (type: "all" | "client" | "tokens") => Effect.Effect<void>
}

type SharedGroup = ReturnType<typeof McpOAuthFetch.shared>
type AuthRow = {
  epoch: number
  observed: boolean
  fingerprint: string
  groups: Map<string, SharedGroup>
  committed?: { proof: object; group: SharedGroup; epoch: number }
}
// Shared by independently built service layers, not by service-object identity.
// The namespace is the actual existing protected writer target, never a caller
// supplied URL, display name, or a second credential file.
const oauthRows = new Map<string, AuthRow>()
const rowKey = (authKey: string) => JSON.stringify([path.resolve(filepath), authKey])
const fingerprint = (entry: Entry | undefined) => createHash("sha256").update(JSON.stringify([
  entry?.serverUrl,
  entry?.tokens && [entry.tokens.accessToken, entry.tokens.refreshToken, entry.tokens.expiresAt, entry.tokens.scope],
  entry?.clientInfo && [entry.clientInfo.clientId, entry.clientInfo.clientSecret, entry.clientInfo.clientIdIssuedAt, entry.clientInfo.clientSecretExpiresAt],
])).digest("hex")
function advance(row: AuthRow, value: string, keep?: SharedGroup) {
  row.epoch++
  row.observed = true
  row.fingerprint = value
  row.committed = undefined
  for (const group of row.groups.values()) if (group !== keep) group.invalidate()
}
function synchronize(row: AuthRow, value: string) {
  if (!row.observed) { row.observed = true; row.fingerprint = value; return }
  if (row.fingerprint !== value) advance(row, value)
}

export interface Interface {
  readonly oauth: (authKey: string, serverUrl: string, target: string) => OAuthSession
  readonly all: () => Effect.Effect<Record<string, Entry>>
  readonly get: (mcpName: string) => Effect.Effect<Entry | undefined>
  readonly getForUrl: (mcpName: string, serverUrl: string) => Effect.Effect<Entry | undefined>
  readonly set: (mcpName: string, entry: Entry, serverUrl?: string) => Effect.Effect<void>
  readonly remove: (mcpName: string) => Effect.Effect<void>
  readonly updateTokens: (mcpName: string, tokens: Tokens, serverUrl?: string) => Effect.Effect<void>
  readonly updateClientInfo: (mcpName: string, clientInfo: ClientInfo, serverUrl?: string) => Effect.Effect<void>
  readonly updateCodeVerifier: (mcpName: string, codeVerifier: string) => Effect.Effect<void>
  readonly clearCodeVerifier: (mcpName: string) => Effect.Effect<void>
  readonly updateOAuthState: (mcpName: string, oauthState: string) => Effect.Effect<void>
  readonly getOAuthState: (mcpName: string) => Effect.Effect<string | undefined>
  readonly clearOAuthState: (mcpName: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/McpAuth") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const secrets = yield* SecretProvider.Service
    const flock = yield* EffectFlock.Service
    const readCache = yield* McpAuthReadCache.make(secrets)
    const readProtected = (target: string) =>
      ProtectedJson.read(target).pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(SecretProvider.Service, readCache.provider),
        Effect.onError(() => Effect.sync(readCache.clear)),
      )
    const writeProtected = (target: string, value: unknown, mode?: number) =>
      ProtectedJson.write(target, value, mode).pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(SecretProvider.Service, secrets),
        Effect.ensuring(Effect.sync(readCache.clear)),
      )

    const read = Effect.fn("McpAuth.read")(function* () {
      return yield* readProtected(filepath).pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed({ value: {}, needsMigration: false as const }),
        ),
        Effect.flatMap(({ value, needsMigration }) => {
          const data = Option.getOrElse(decodeAuthData(value), () => ({}) as AuthData) as AuthData
          return needsMigration ? writeProtected(filepath, data, 0o600).pipe(Effect.as(data)) : Effect.succeed(data)
        }),
        Effect.orDie,
      )
    })

    const all = Effect.fn("McpAuth.all")(function* () {
      return yield* read().pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const mutate = Effect.fn("McpAuth.mutate")(function* (
      update: (data: AuthData) => AuthData | undefined,
      credentialKey?: string,
    ) {
      yield* Effect.gen(function* () {
        const next = update(yield* read())
        if (!next) return
        yield* writeProtected(filepath, next, 0o600).pipe(Effect.orDie)
        if (credentialKey !== undefined) {
          const row = oauthRows.get(rowKey(credentialKey))
          if (row) advance(row, fingerprint(next[credentialKey]))
        }
      }).pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const get = Effect.fn("McpAuth.get")(function* (mcpName: string) {
      const data = yield* all()
      return data[mcpName]
    })

    const getForUrl = Effect.fn("McpAuth.getForUrl")(function* (mcpName: string, serverUrl: string) {
      const entry = yield* get(mcpName)
      if (!entry) return undefined
      if (!entry.serverUrl) return undefined
      if (entry.serverUrl !== serverUrl) return undefined
      return entry
    })

    const set = Effect.fn("McpAuth.set")(function* (mcpName: string, entry: Entry, serverUrl?: string) {
      yield* mutate((data) => ({
        ...data,
        [mcpName]: serverUrl ? { ...entry, serverUrl } : entry,
      }), mcpName)
    })

    const remove = Effect.fn("McpAuth.remove")(function* (mcpName: string) {
      yield* mutate((data) => {
        const next = { ...data }
        delete next[mcpName]
        return next
      }, mcpName)
    })

    const updateField = <K extends keyof Entry>(field: K, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string, value: NonNullable<Entry[K]>, serverUrl?: string) {
        yield* mutate((data) => {
          const entry = { ...data[mcpName] }
          entry[field] = value
          if (serverUrl) entry.serverUrl = serverUrl
          return { ...data, [mcpName]: entry }
        }, field === "tokens" || field === "clientInfo" || serverUrl !== undefined ? mcpName : undefined)
      })

    const clearField = (field: keyof Entry, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string) {
        yield* mutate((data) => {
          const entry = data[mcpName]
          if (!entry) return undefined
          delete entry[field]
          return { ...data, [mcpName]: entry }
        })
      })

    const updateTokens = updateField("tokens", "updateTokens")
    const updateClientInfo = updateField("clientInfo", "updateClientInfo")
    const updateCodeVerifier = updateField("codeVerifier", "updateCodeVerifier")
    const updateOAuthState = updateField("oauthState", "updateOAuthState")
    const clearCodeVerifier = clearField("codeVerifier", "clearCodeVerifier")
    const clearOAuthState = clearField("oauthState", "clearOAuthState")

    const getOAuthState = Effect.fn("McpAuth.getOAuthState")(function* (mcpName: string) {
      const entry = yield* get(mcpName)
      return entry?.oauthState
    })

    const oauth = (authKey: string, serverUrl: string, target: string): OAuthSession => {
      type Handle = { row: AuthRow; group: SharedGroup; owner: McpOAuthFetch.Subscriber }
      type Observed = { handle: Handle; epoch: number; fingerprint: string; url?: string; refresh?: string }
      const key = rowKey(authKey), groupKey = JSON.stringify([serverUrl, target])
      let handle: Handle | undefined, observed: Observed | undefined
      const issued = new Map<object, Observed>()
      const failures: Observed[] = []
      let ambiguousFailure = false
      const acquire = (): Handle => {
        if (handle?.owner.active()) return handle
        const row = oauthRows.get(key) ?? { epoch: 0, observed: false, fingerprint: "", groups: new Map<string, SharedGroup>() }
        oauthRows.set(key, row)
        let group = row.groups.get(groupKey)
        if (!group) {
          const created: SharedGroup = McpOAuthFetch.shared(() => {
            if (row.groups.get(groupKey) !== created) return
            row.groups.delete(groupKey)
            if (!row.groups.size && oauthRows.get(key) === row) oauthRows.delete(key)
          }, () => {
            if (row.committed?.group === created) row.committed = undefined
          })
          group = created
          row.groups.set(groupKey, group)
        }
        handle = { row, group, owner: group.attach() }
        return handle
      }
      const current = (value: Handle) => handle === value && value.owner.active() && oauthRows.get(key) === value.row
      const release = () => {
        const old = handle
        handle = undefined
        observed = undefined
        issued.clear()
        failures.length = 0
        ambiguousFailure = false
        old?.owner.invalidate()
      }
      const ownedRead = Effect.fn("McpAuth.oauth.read")(function* () {
        const owner = acquire()
        return yield* Effect.gen(function* () {
          if (!current(owner)) throw McpOAuthFetch.staleOwner()
          const entry = (yield* read())[authKey]
          if (!current(owner)) throw McpOAuthFetch.staleOwner()
          synchronize(owner.row, fingerprint(entry))
          observed = {
            handle: owner, epoch: owner.row.epoch, fingerprint: owner.row.fingerprint,
            url: entry?.serverUrl,
            refresh: entry?.tokens?.refreshToken === undefined ? undefined
              : createHash("sha256").update(entry.tokens.refreshToken).digest("hex"),
          }
          return entry?.serverUrl === serverUrl ? entry : undefined
        }).pipe(flock.withLock(lockKey), Effect.orDie)
      })
      const matches = (snapshot: Observed | undefined, entry: Entry | undefined) => {
        if (!snapshot || !current(snapshot.handle)) return false
        const row = snapshot.handle.row
        synchronize(row, fingerprint(entry))
        return snapshot.epoch === row.epoch && snapshot.fingerprint === row.fingerprint &&
          (entry?.serverUrl === undefined || entry.serverUrl === serverUrl)
      }
      const ownedSave = Effect.fn("McpAuth.oauth.saveTokens")(function* (tokens: Tokens, wire: OAuthTokens) {
        const owner = acquire()
        const proof = owner.owner.proof(wire)
        const snapshot = proof ? issued.get(proof) : observed
        yield* Effect.gen(function* () {
          // Check again after the asynchronous file-lock acquisition. Do not
          // call public get/set/updateTokens here: they reacquire this lock.
          if (!current(owner)) throw McpOAuthFetch.staleOwner()
          owner.owner.assertSave(wire)
          const data = yield* read(), entry = data[authKey]
          if (!current(owner)) throw McpOAuthFetch.staleOwner()
          synchronize(owner.row, fingerprint(entry))
          const winner = owner.row.committed
          if (proof && winner?.proof === proof && winner.group === owner.group && winner.epoch === owner.row.epoch) return
          if (!matches(snapshot, entry)) throw McpOAuthFetch.staleOwner()
          owner.owner.assertSave(wire)
          const next = { ...entry, tokens, serverUrl }
          yield* writeProtected(filepath, { ...data, [authKey]: next }, 0o600).pipe(Effect.orDie)
          // Publication is synchronous immediately after the existing atomic
          // writer succeeds. No ambient InstanceRef/config callback is used.
          const live = oauthRows.get(key)
          if (live === owner.row) {
            advance(live, fingerprint(next), owner.group)
            if (proof) live.committed = { proof, group: owner.group, epoch: live.epoch }
            owner.group.committed(wire, proof)
          }
          for (const old of issued.keys()) if (old !== proof) issued.delete(old)
        }).pipe(flock.withLock(lockKey), Effect.orDie)
      })
      const ownedClient = Effect.fn("McpAuth.oauth.saveClientInfo")(function* (clientInfo: ClientInfo) {
        const snapshot = observed
        yield* Effect.gen(function* () {
          const data = yield* read(), entry = data[authKey]
          if (!matches(snapshot, entry)) throw McpOAuthFetch.staleOwner()
          const next = { ...entry, clientInfo, serverUrl }
          yield* writeProtected(filepath, { ...data, [authKey]: next }, 0o600).pipe(Effect.orDie)
          const row = oauthRows.get(key)
          if (row) advance(row, fingerprint(next))
          if (snapshot && current(snapshot.handle))
            observed = { ...snapshot, epoch: snapshot.handle.row.epoch, fingerprint: fingerprint(next), url: serverUrl }
        }).pipe(flock.withLock(lockKey), Effect.orDie)
      })
      const invalidateCredentials = Effect.fn("McpAuth.oauth.invalidateCredentials")(function* (type: "all" | "client" | "tokens") {
        // The SDK does not pass its failed request to this callback. Retain the
        // failed exchange's snapshot rather than using a newer tokens() read.
        const snapshot = ambiguousFailure ? undefined : failures.shift() ?? observed
        const owner = handle
        yield* Effect.gen(function* () {
          const data = yield* read(), entry = data[authKey]
          if (!matches(snapshot, entry) || !entry) return
          const next = { ...entry }
          if (type === "all") delete data[authKey]
          else {
            if (type === "client") delete next.clientInfo
            if (type === "tokens") delete next.tokens
            data[authKey] = next
          }
          yield* writeProtected(filepath, data, 0o600).pipe(Effect.orDie)
          const row = oauthRows.get(key)
          if (row) advance(row, fingerprint(data[authKey]))
        }).pipe(flock.withLock(lockKey), Effect.orDie)
        // Retiring one provider is not a shared credential revocation. Other
        // subscribers remain live unless the conditional store mutation won.
        if (handle === owner) release()
      })
      const fetch: FetchLike = async (url, init) => {
        if (init?.signal?.aborted) throw init.signal.reason ?? McpOAuthFetch.staleOwner()
        const owner = acquire(), snapshot = observed
        const form = typeof init?.body === "string" || init?.body instanceof URLSearchParams
          ? new URLSearchParams(init.body) : undefined
        const grant = init?.method?.toUpperCase() === "POST" ? form?.get("grant_type") : undefined
        if (grant === "refresh_token" && (!snapshot || snapshot.handle !== owner || snapshot.url !== serverUrl ||
          snapshot.refresh !== createHash("sha256").update(form?.get("refresh_token") ?? "").digest("hex") ||
          (snapshot.epoch !== owner.row.epoch && !owner.owner.canJoin(url, init)))) throw McpOAuthFetch.staleOwner()
        const response = await owner.owner.fetch(url, init)
        if (!current(owner)) throw McpOAuthFetch.staleOwner()
        const proof = owner.owner.responseProof(response)
        if (proof && snapshot) issued.set(proof, snapshot)
        if (!response.ok && snapshot && (grant === "refresh_token" || grant === "authorization_code")) {
          if (failures.length < 16) failures.push(snapshot)
          else ambiguousFailure = true // Fail closed instead of guessing a newer owner.
        }
        return response
      }
      const oauthFetch: McpOAuthFetch.Owner = {
        fetch,
        bind: signal => (url, init) => signal.aborted ? Promise.reject(signal.reason ?? McpOAuthFetch.staleOwner())
          : fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
        observe: tokens => acquire().owner.observe(tokens),
        assertSave: tokens => acquire().owner.assertSave(tokens),
        committed: tokens => acquire().owner.committed(tokens),
        invalidate: release,
      }
      return { oauthFetch, read: ownedRead, saveTokens: ownedSave, saveClientInfo: ownedClient, invalidateCredentials }
    }

    return Service.of({
      oauth,
      all,
      get,
      getForUrl,
      set,
      remove,
      updateTokens,
      updateClientInfo,
      updateCodeVerifier,
      clearCodeVerifier,
      updateOAuthState,
      getOAuthState,
      clearOAuthState,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, EffectFlock.node, SecretProvider.node],
})

export * as McpAuth from "./auth"
