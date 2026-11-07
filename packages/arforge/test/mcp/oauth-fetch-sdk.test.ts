import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import type { McpAuth } from "../../src/mcp/auth"
import { McpOAuthPendingProvider, McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { McpOAuthFetch } from "../../src/mcp/oauth-fetch"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("real SDK concurrent catalog/ping rotation shares the production provider hook and retains winning credentials", async () => {
  const firstRefresh = deferred(),
    twoSDKRefreshes = deferred(),
    threeSDKRefreshes = deferred(),
    release = deferred(),
    saveStarted = deferred(),
    releaseSave = deferred()
  let initialExpired = false,
    refreshRequests = 0,
    hookRefreshes = 0,
    invalidRefreshes = 0,
    tokenClears = 0
  let persistenceStarted = false,
    persistenceFinished = false,
    lateEnteredPersistenceGap = false
  let access = crypto.randomUUID(),
    refresh = crypto.randomUUID()
  const initialAccess = access,
    initialRefresh = refresh
  let entry: McpAuth.Entry | undefined
  const patch = (value: Partial<McpAuth.Entry>, url?: string) =>
    Effect.sync(() => {
      entry = { ...entry, ...value, ...(url ? { serverUrl: url } : {}) }
    })
  const storage: McpAuth.Interface = {
    // This existing SDK unit fixture models one provider's persistence seam.
    // Adapt the required typed port without adding a production fallback.
    // Cross-service authority/encryption is covered by the separate real-store
    // coordinator fixture, rather than being claimed by this in-memory double.
    oauth: (key, url) => {
      const oauthFetch = McpOAuthFetch.make()
      return {
        oauthFetch,
        read: () => storage.getForUrl(key, url),
        saveTokens: (tokens, wire) => Effect.suspend(() => {
          oauthFetch.assertSave(wire)
          return storage.updateTokens(key, tokens, url)
            .pipe(Effect.tap(() => Effect.sync(() => oauthFetch.committed(wire))))
        }),
        saveClientInfo: info => storage.updateClientInfo(key, info, url),
        invalidateCredentials: type => Effect.gen(function* () {
          oauthFetch.invalidate()
          const value = yield* storage.get(key)
          if (!value) return
          if (type === "all") return yield* storage.remove(key)
          if (type === "client") delete value.clientInfo
          if (type === "tokens") delete value.tokens
          yield* storage.set(key, value)
        }),
      }
    },
    all: () => Effect.sync((): Record<string, McpAuth.Entry> => (entry ? { owned: structuredClone(entry) } : {})),
    get: () => Effect.sync(() => (entry ? structuredClone(entry) : undefined)),
    getForUrl: (_key, url) => Effect.sync(() => (entry?.serverUrl === url ? structuredClone(entry) : undefined)),
    set: (_key, value, url) =>
      Effect.sync(() => {
        if (entry?.tokens && !value.tokens) tokenClears++
        entry = { ...value, ...(url ? { serverUrl: url } : {}) }
      }),
    remove: () =>
      Effect.sync(() => {
        entry = undefined
      }),
    updateTokens: (_key, tokens, url) =>
      Effect.promise(async () => {
        persistenceStarted = true
        saveStarted.resolve()
        await releaseSave.promise
        await Effect.runPromise(patch({ tokens }, url))
        persistenceFinished = true
      }),
    updateClientInfo: (_key, clientInfo, url) => patch({ clientInfo }, url),
    updateCodeVerifier: (_key, codeVerifier) => patch({ codeVerifier }),
    clearCodeVerifier: () => patch({ codeVerifier: undefined }),
    updateOAuthState: (_key, oauthState) => patch({ oauthState }),
    getOAuthState: () => Effect.sync(() => entry?.oauthState),
    clearOAuthState: () => patch({ oauthState: undefined }),
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url),
        origin = url.origin
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: origin + "/mcp",
          authorization_servers: [origin],
          scopes_supported: ["resource.read", "offline_access"],
        })
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          response_types_supported: ["code"],
          grant_types_supported: ["refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        })
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text())
        refreshRequests++
        firstRefresh.resolve()
        await release.promise
        if (body.get("refresh_token") !== refresh) {
          invalidRefreshes++
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        }
        access = crypto.randomUUID()
        refresh = crypto.randomUUID()
        return Response.json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 })
      }
      if (request.method === "GET") return new Response(null, { status: 405 })
      if (request.method === "DELETE") return new Response(null)
      if (request.headers.get("authorization") !== "Bearer " + access || (initialExpired && access === initialAccess))
        return Response.json(
          { error: "expired" },
          {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          },
        )
      const rpc = JSONRPCMessageSchema.parse(await request.json())
      if (!("id" in rpc)) return new Response(null, { status: 202 })
      const result =
        "method" in rpc && rpc.method === "initialize"
          ? {
              protocolVersion: String(rpc.params?.protocolVersion),
              capabilities: { resources: {} },
              serverInfo: { name: "owned-rotation", version: "1" },
            }
          : "method" in rpc && rpc.method === "resources/list"
            ? { resources: [{ name: "owned", uri: "evidence://owned/manual" }] }
            : "method" in rpc && rpc.method === "resources/templates/list"
              ? { resourceTemplates: [] }
              : {}
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result })
    },
  })
  const endpoint = `http://127.0.0.1:${server.port}/mcp`
  entry = {
    serverUrl: endpoint,
    tokens: { accessToken: access, refreshToken: refresh, expiresAt: Date.now() / 1000 + 3600 },
  }
  const provider = new McpOAuthProvider(
    "owned",
    endpoint,
    { clientId: "owned-client" },
    { onRedirect: () => {} },
    storage,
  )
  const controller = new AbortController(),
    productionFetch = provider.oauthFetch.bind(controller.signal)
  const client = new Client({ name: "owned-causal", version: "1" }, { capabilities: {} })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        authProvider: provider,
        fetch: (url, init) => {
          const body = init?.body instanceof URLSearchParams ? init.body : undefined
          if (body?.get("grant_type") === "refresh_token") {
            hookRefreshes++
            if (hookRefreshes === 2) twoSDKRefreshes.resolve()
            if (hookRefreshes === 3) {
              lateEnteredPersistenceGap = persistenceStarted && !persistenceFinished
              threeSDKRefreshes.resolve()
            }
          }
          return productionFetch(url, init)
        },
      }),
    )
    initialExpired = true
    const resources = client.listResources({}, { timeout: 5000 })
    await firstRefresh.promise
    const ping = client.ping({ timeout: 5000 })
    await twoSDKRefreshes.promise
    release.resolve()
    await saveStarted.promise
    const templates = client.listResourceTemplates({}, { timeout: 5000 })
    await threeSDKRefreshes.promise
    releaseSave.resolve()
    const outcomes = await Promise.allSettled([resources, ping, templates])
    expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
    expect(hookRefreshes).toBe(3)
    expect(refreshRequests).toBe(1)
    expect(invalidRefreshes).toBe(0)
    expect(tokenClears).toBe(0)
    expect(lateEnteredPersistenceGap).toBe(true)
    expect(entry?.tokens?.accessToken === access).toBe(true)
    expect(entry?.tokens?.refreshToken === refresh && refresh !== initialRefresh).toBe(true)
    const pending = new McpOAuthPendingProvider("owned", endpoint, {}, { onRedirect: () => {} }, storage)
    await pending.saveClientInformation({ client_id: "owned-before-commit", redirect_uris: [pending.redirectUrl] })
    await pending.saveTokens({ access_token: access, refresh_token: refresh, token_type: "Bearer" })
    await pending.commit()
    await pending.invalidateCredentials("client")
    expect(await pending.clientInformation()).toBeUndefined()
    await pending.saveClientInformation({ client_id: "owned-after-commit", redirect_uris: [pending.redirectUrl] })
    expect(entry?.clientInfo?.clientId).toBe("owned-after-commit")
    expect(entry?.tokens?.refreshToken === refresh).toBe(true)
  } finally {
    release.resolve()
    releaseSave.resolve()
    controller.abort()
    provider.oauthFetch.invalidate()
    await client.close().catch(() => {})
    await server.stop(true)
  }
}, 15000)
