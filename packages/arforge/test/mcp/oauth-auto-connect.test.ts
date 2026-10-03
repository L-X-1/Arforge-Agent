import { expect } from "bun:test"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Effect, Exit, Fiber } from "effect"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { McpAuth } from "../../src/mcp/auth"
import { MCP } from "../../src/mcp/index"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { McpOAuthPendingProvider, McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { disposeAllInstancesEffect, provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const mcpTest = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      MCP.node,
      LocationServiceMap.node,
      McpAuth.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
    ]),
  ),
)

interface OAuthMcpOptions {
  capabilities?: "tools" | "resources"
  blockTokenExchange?: boolean
  initializeDelay?: number
  listToolsDelay?: number
}

function serveOAuthMcp(options: OAuthMcpOptions = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const capabilities = options.capabilities ?? "tools"
      let listToolsCalls = 0
      let tokenExchanges = 0
      let requiresAuth = true
      let releaseTokenExchange: (() => void) | undefined
      let signalTokenExchange: (() => void) | undefined
      const tokenExchangeStarted = options.blockTokenExchange
        ? new Promise<void>((resolve) => {
            signalTokenExchange = resolve
          })
        : undefined

      let protocol: Server
      let transport: WebStandardStreamableHTTPServerTransport
      const resetMcp = async () => {
        if (protocol!) await protocol.close().catch(() => {})
        protocol = new Server(
          { name: "oauth-auto-connect", version: "1.0.0" },
          { capabilities: capabilities === "tools" ? { tools: {} } : { resources: {} } },
        )
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        })
        if (capabilities === "tools") {
          protocol.setRequestHandler(ListToolsRequestSchema, async () => {
            listToolsCalls++
            if (options.listToolsDelay) await Bun.sleep(options.listToolsDelay)
            return Promise.resolve({ tools: [{ name: "test_tool", inputSchema: { type: "object" } }] })
          })
        }
        if (capabilities === "resources") {
          protocol.setRequestHandler(ListResourcesRequestSchema, () =>
            Promise.resolve({ resources: [{ name: "docs", uri: "docs://readme" }] }),
          )
        }
        await protocol.connect(transport)
      }

      await resetMcp()
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          const origin = url.origin
          const mcpUrl = `${origin}/mcp`

          if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
            return Response.json({
              resource: mcpUrl,
              authorization_servers: [origin],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/.well-known/oauth-protected-resource") {
            return Response.json({
              resource: mcpUrl,
              authorization_servers: [origin],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              registration_endpoint: `${origin}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["none"],
              code_challenge_methods_supported: ["S256"],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/register") {
            const metadata = (await request.json()) as Record<string, unknown>
            return Response.json({ ...metadata, client_id: "replacement-client" }, { status: 201 })
          }
          if (url.pathname === "/token") {
            tokenExchanges++
            if (options.blockTokenExchange)
              await new Promise<void>((resolve) => {
                releaseTokenExchange = resolve
                signalTokenExchange?.()
              })
            const body = new URLSearchParams(await request.text())
            if (body.get("code") !== "valid-code") {
              return Response.json(
                { error: "invalid_grant", error_description: "Token exchange failed" },
                { status: 400 },
              )
            }
            return Response.json({ access_token: "replacement-token", token_type: "Bearer" })
          }
          if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })

          if (request.method === "GET") return new Response(null, { status: 405 })
          if (requiresAuth && request.headers.get("authorization") !== "Bearer replacement-token") {
            return new Response("Unauthorized", {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="mcp"`,
              },
            })
          }
          if (options.initializeDelay && request.method === "POST") {
            const body = await request.clone().json()
            if (body.method === "initialize") await Bun.sleep(options.initializeDelay)
          }
          return transport.handleRequest(request)
        },
      })

      return {
        url: new URL("/mcp", http.url).toString(),
        allowAnonymous: () => {
          requiresAuth = false
        },
        listToolsCalls: () => listToolsCalls,
        tokenExchanges: () => tokenExchanges,
        waitForTokenExchange: () => tokenExchangeStarted ?? Promise.resolve(),
        releaseTokenExchange: () => releaseTokenExchange?.(),
        resetMcp,
        close: async () => {
          await http.stop(true)
          await protocol.close()
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

const remote = (url: string, enabled = true) => ({
  type: "remote" as const,
  url,
  enabled,
})

const stopOAuthCallback = Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))

mcpTest.instance("authentication without a redirect applies the request phase to its bounded catalog", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ listToolsDelay: 500 })
    const mcp = yield* MCP.Service
    const name = "oauth-catalog-timeout"
    yield* mcp.add(name, { ...remote(server.url), timeout: { startup: 2000, request: 100 } })
    server.allowAnonymous()
    expect((yield* mcp.authenticate(name)).status).toBe("failed")
    expect(yield* mcp.hasStoredTokens(name)).toBe(false)
    expect((yield* mcp.tools())[`${name}_test_tool`]).toBeUndefined()
    expect(server.listToolsCalls()).toBe(1)
  }),
)

mcpTest.instance("OAuth startup without a redirect still enforces the frozen startup timeout", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ initializeDelay: 500 })
    const mcp = yield* MCP.Service
    const name = "oauth-startup-timeout"
    yield* mcp.add(name, { ...remote(server.url), timeout: { startup: 100, request: 2000 } })
    server.allowAnonymous()
    const started = yield* mcp.startAuth(name).pipe(Effect.exit)
    expect(Exit.isFailure(started)).toBe(true)
    expect(yield* mcp.hasStoredTokens(name)).toBe(false)
    expect(server.listToolsCalls()).toBe(0)
    expect(server.tokenExchanges()).toBe(0)
  }),
)

for (const startup of [100, 1500])
  mcpTest.instance(`OAuth completion uses the frozen startup phase (${startup} ms)`, () =>
    Effect.gen(function* () {
      yield* stopOAuthCallback
      const server = yield* serveOAuthMcp({ initializeDelay: 500 })
      const mcp = yield* MCP.Service
      const name = "oauth-finish-timeout"
      const request = startup === 100 ? 2000 : 100
      yield* mcp.add(name, { ...remote(server.url), timeout: { startup, request } })
      const started = yield* mcp.startAuth(name)
      expect(started.authorizationUrl).toContain("/authorize")
      const result = yield* mcp.finishAuth(name, "valid-code", started.oauthState)
      const connected = startup > 500
      expect(result.status).toBe(connected ? "connected" : "failed")
      expect(yield* mcp.hasStoredTokens(name)).toBe(connected)
      const tool = (yield* mcp.tools())[`${name}_test_tool`]
      if (connected) expect(tool?.timeout).toBe(request)
      else expect(tool).toBeUndefined()
      expect(server.tokenExchanges()).toBe(1)
    }),
  )

mcpTest.instance("first connect to OAuth server shows needs_auth instead of failed", () =>
  Effect.gen(function* () {
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("test-oauth", remote(server.url))

    expect((result.status as Record<string, { status: string }>)["test-oauth"]).toEqual({ status: "needs_auth" })
  }),
)

mcpTest.instance("state() generates and persists a new state when none is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-gen",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    expect((yield* auth.get("test-state-gen"))?.oauthState).toBeUndefined()

    const state = yield* Effect.promise(() => provider.state())
    expect(state).toHaveLength(64)
    expect((yield* auth.get("test-state-gen"))?.oauthState).toBe(state)
  }),
)

mcpTest.instance("state() returns existing state when one is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-existing",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    yield* auth.updateOAuthState("test-state-existing", "pre-saved-state-value")
    expect(yield* Effect.promise(() => provider.state())).toBe("pre-saved-state-value")
  }),
)

mcpTest.instance("pending provider does not expose or overwrite existing credentials before commit", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const name = "test-pending-credentials"
    const url = "https://example.com/mcp"
    const provider = new McpOAuthPendingProvider(name, url, {}, { onRedirect: async () => {} }, auth)

    yield* auth.updateClientInfo(name, { clientId: "old-client" }, url)
    yield* auth.updateTokens(name, { accessToken: "old-token" }, url)

    expect(yield* Effect.promise(() => provider.clientInformation())).toBeUndefined()
    expect(yield* Effect.promise(() => provider.tokens())).toBeUndefined()
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("old-token")
    expect((yield* auth.get(name))?.clientInfo?.clientId).toBe("old-client")
  }),
)

mcpTest.instance("failed reauthentication preserves existing credentials", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const name = "test-reauth-failure"

    yield* auth.updateClientInfo(name, { clientId: "dynamic-client", clientSecret: "dynamic-secret" }, server.url)
    yield* auth.updateTokens(name, { accessToken: "working-token" }, server.url)
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")

    expect(yield* mcp.finishAuth(name, "invalid-code", started.oauthState)).toEqual({
      status: "failed",
      error: "OAuth completion failed: Token exchange failed",
    })
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("working-token")
    expect((yield* auth.get(name))?.clientInfo).toMatchObject({
      clientId: "dynamic-client",
      clientSecret: "dynamic-secret",
    })
  }),
)

mcpTest.instance("successful reauthentication commits replacement credentials", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const name = "test-reauth-success"

    yield* auth.updateClientInfo(name, { clientId: "old-client" }, server.url)
    yield* auth.updateTokens(name, { accessToken: "old-token" }, server.url)
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("old-token")

    expect((yield* mcp.finishAuth(name, "valid-code", started.oauthState)).status).toBe("connected")
    const entry = yield* auth.get(name)
    // Legacy bare-name entries are intentionally never adopted by a project
    // scoped OAuth flow. The old user data remains untouched while the new
    // protected, opaque project key is used by MCP itself.
    expect(entry?.tokens?.accessToken).toBe("old-token")
    expect(yield* mcp.hasStoredTokens(name)).toBe(true)
    expect(yield* mcp.getAuthStatus(name)).toBe("authenticated")
  }),
)

mcpTest.instance("commit failure closes the unowned client and retires the failed OAuth generation", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-commit-failure"
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    let clientCloseCalls = 0

    const result = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const providerPrototype = McpOAuthPendingProvider.prototype
        const clientPrototype = McpClient.prototype
        const originalCommit = providerPrototype.commit
        const originalClose = clientPrototype.close
        providerPrototype.commit = async () => {
          throw new Error("injected credential commit failure")
        }
        clientPrototype.close = async function () {
          clientCloseCalls++
          return originalClose.call(this)
        }
        return () => {
          providerPrototype.commit = originalCommit
          clientPrototype.close = originalClose
        }
      }),
      () => mcp.finishAuth(name, "valid-code", started.oauthState),
      (restore) => Effect.sync(restore),
    )

    expect(result).toEqual({
      status: "failed",
      error: `MCP 服务 ${name} 的 OAuth 凭据未保存、连接发布失败；请重新发起授权`,
    })
    expect(clientCloseCalls).toBe(1)
    expect((yield* mcp.status())[name]).toEqual(result)
    expect(yield* mcp.hasStoredTokens(name)).toBe(false)
    expect(yield* mcp.finishAuth(name, "valid-code", started.oauthState)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("已过期"),
    })
    expect(server.tokenExchanges()).toBe(1)

    yield* Effect.promise(server.resetMcp)
    const retry = yield* mcp.startAuth(name)
    expect(yield* mcp.finishAuth(name, "valid-code", retry.oauthState)).toEqual({ status: "connected" })
  }),
)

mcpTest.instance("publish failure after commit keeps credentials but closes and unpublishes the client", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-publish-failure"
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    let clientCloseCalls = 0

    const result = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const clientPrototype = McpClient.prototype
        const originalClose = clientPrototype.close
        const originalSetNotificationHandler = clientPrototype.setNotificationHandler
        clientPrototype.close = async function () {
          clientCloseCalls++
          return originalClose.call(this)
        }
        clientPrototype.setNotificationHandler = function (...args) {
          if ((args[0] as unknown) === LoggingMessageNotificationSchema)
            throw new Error("injected client publication failure")
          return Reflect.apply(originalSetNotificationHandler, this, args)
        }
        return () => {
          clientPrototype.close = originalClose
          clientPrototype.setNotificationHandler = originalSetNotificationHandler
        }
      }),
      () => mcp.finishAuth(name, "valid-code", started.oauthState),
      (restore) => Effect.sync(restore),
    )

    expect(result).toEqual({
      status: "failed",
      error: `MCP 服务 ${name} 的 OAuth 凭据已保存、连接发布失败；可直接重新连接`,
    })
    expect(clientCloseCalls).toBe(1)
    expect((yield* mcp.status())[name]).toEqual(result)
    expect(yield* mcp.hasStoredTokens(name)).toBe(true)
    expect(yield* mcp.getAuthStatus(name)).toBe("authenticated")
    expect(yield* mcp.finishAuth(name, "valid-code", started.oauthState)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("已过期"),
    })
    expect(server.tokenExchanges()).toBe(1)

    yield* Effect.promise(server.resetMcp)
    yield* mcp.connect(name)
    expect((yield* mcp.status())[name]).toEqual({ status: "connected" })
  }),
)

mcpTest.instance("auth status only reports project-scoped credentials for the configured server URL", () =>
  Effect.gen(function* () {
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-status-url"
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    expect((yield* mcp.finishAuth(name, "valid-code", started.oauthState)).status).toBe("connected")
    expect(yield* mcp.getAuthStatus(name)).toBe("authenticated")

    yield* mcp.add(name, remote("https://other.example.com/mcp", false))
    expect(yield* mcp.getAuthStatus(name)).toBe("not_authenticated")

    yield* mcp.add(name, remote(server.url, false))
    expect(yield* mcp.getAuthStatus(name)).toBe("authenticated")
  }),
)

mcpTest.instance("authenticate() stores a connected client when auth completes without redirect", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-connect"
    const added = yield* mcp.add(name, remote(server.url))
    expect((added.status as Record<string, { status: string }>)[name]?.status).toBe("needs_auth")

    server.allowAnonymous()
    expect((yield* mcp.authenticate(name)).status).toBe("connected")
    expect((yield* mcp.status())[name]?.status).toBe("connected")
  }),
)

mcpTest.instance("authenticate() connects a resource-only server without listing tools", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ capabilities: "resources" })
    const mcp = yield* MCP.Service
    const name = "test-oauth-resources"
    const added = yield* mcp.add(name, remote(server.url))
    expect((added.status as Record<string, { status: string }>)[name]?.status).toBe("needs_auth")

    server.allowAnonymous()
    expect((yield* mcp.authenticate(name)).status).toBe("connected")
    expect(server.listToolsCalls()).toBe(0)
    expect(Object.keys(yield* mcp.resources())).toEqual([`${name}:docs://readme`])
  }),
)

mcpTest.instance("late OAuth completion after disable stays stale and cannot store credentials", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-stale-disable"
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")

    yield* mcp.add(name, { ...remote(server.url), enabled: false })
    expect(yield* mcp.finishAuth(name, "valid-code", started.oauthState)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("已过期"),
    })
    expect((yield* mcp.status())[name]).toEqual({ status: "disabled" })
    expect(yield* mcp.hasStoredTokens(name)).toBe(false)
  }),
)

mcpTest.instance("late OAuth completion after disconnect cannot revive the remote server", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-stale-disconnect"
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")

    yield* mcp.disconnect(name)
    expect(yield* mcp.finishAuth(name, "valid-code", started.oauthState)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("已过期"),
    })
    expect((yield* mcp.status())[name]).toEqual({ status: "disabled" })
    expect(yield* mcp.hasStoredTokens(name)).toBe(false)
  }),
)

mcpTest.instance("a callback state from a replaced OAuth generation cannot exchange through the replacement", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-generation-handoff"
    yield* mcp.add(name, remote(server.url))

    const first = yield* mcp.startAuth(name)
    const replacement = yield* mcp.startAuth(name)
    expect(first.oauthState).not.toBe(replacement.oauthState)

    // This models a callback that has already returned its code while a new
    // authStart replaces the generation. It must fail before the replacement
    // transport sees an exchange request.
    expect(yield* mcp.finishAuth(name, "valid-code", first.oauthState)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("已过期"),
    })
    expect(server.tokenExchanges()).toBe(0)

    expect((yield* mcp.finishAuth(name, "valid-code", replacement.oauthState)).status).toBe("connected")
    expect(server.tokenExchanges()).toBe(1)
  }),
)

mcpTest.instance("instance finalization fences an in-flight OAuth completion before it can commit or publish", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ blockTokenExchange: true })
    const mcp = yield* MCP.Service
    const name = "test-oauth-finalizer-fence"
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)

    const finishing = yield* mcp.finishAuth(name, "valid-code", started.oauthState).pipe(Effect.forkChild)
    yield* Effect.promise(server.waitForTokenExchange)

    // Disposal detaches the exact pending identity under its keyed transition
    // while the token exchange is blocked. Releasing the exchange afterwards
    // must not persist credentials or publish a client into the replacement
    // InstanceState.
    yield* disposeAllInstancesEffect
    yield* Effect.sync(server.releaseTokenExchange)
    expect(yield* Fiber.join(finishing)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("已过期"),
    })

    yield* mcp.add(name, remote(server.url))
    expect(yield* mcp.getAuthStatus(name)).toBe("not_authenticated")
  }),
)

mcpTest.instance("same server name in two projects keeps OAuth generations isolated", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const secondServer = yield* serveOAuthMcp()
    const firstDirectory = (yield* TestInstance).directory
    const secondDirectory = yield* tmpdirScoped()
    const name = "shared-oauth-name"

    const first = yield* MCP.Service
    yield* first.add(name, remote(server.url))
    const firstStarted = yield* first.startAuth(name)
    expect(firstStarted.authorizationUrl).toContain("/authorize")

    const second = yield* Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add(name, remote(secondServer.url))
      return yield* mcp.startAuth(name)
    }).pipe(provideInstance(secondDirectory))
    expect(second.authorizationUrl).toContain("/authorize")

    expect((yield* first.finishAuth(name, "valid-code", firstStarted.oauthState)).status).toBe("connected")
    const secondResult = yield* MCP.Service.pipe(
      Effect.flatMap((mcp) => mcp.finishAuth(name, "valid-code", second.oauthState)),
      provideInstance(secondDirectory),
    )
    expect(secondResult.status).toBe("connected")
    expect((yield* first.status())[name]?.status).toBe("connected")
    const secondStatus = yield* MCP.Service.pipe(
      Effect.flatMap((mcp) => mcp.status()),
      provideInstance(secondDirectory),
    )
    expect(secondStatus[name]?.status).toBe("connected")
    expect(firstDirectory).not.toBe(secondDirectory)
  }),
)
