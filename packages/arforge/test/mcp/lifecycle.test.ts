import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { afterAll, beforeAll, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  GetPromptRequestSchema,
  GetTaskRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Config } from "../../src/config/config"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { MCP } from "../../src/mcp/index"
import { McpControlGateway } from "../../src/mcp/control-gateway"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { safeCapabilityKey } from "../../src/mcp/capability-registry"
import { TestConfig } from "../fixture/config"
import { TestInstance, reloadInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// The authorized local connect lives in the location service map; the test
// harness merges the same map layer the MCP node depends on so approvals can
// be issued through the location's Authorizer.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([MCP.node, LocationServiceMap.node])))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

type Page<T> = { items: T[]; nextCursor?: string }

interface LifecycleServerState {
  tools: Tool[]
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string }>
  toolPages?: Record<string, Page<Tool>>
  promptPages?: Record<string, Page<{ name: string; description?: string }>>
  resourcePages?: Record<string, Page<{ name: string; uri: string; description?: string }>>
  resourceTemplatePages?: Record<string, Page<{ name: string; uriTemplate: string; description?: string }>>
  listToolsError?: string
  requestDelay?: number
  pingDelay?: number
  catalogDelay?: number
  catalogCalls: string[]
  catalogCancelled: number
  onCatalogStart?: () => void
  onCatalogEnd?: () => void
  roots?: Array<{ uri: string; name?: string }>
  requests: string[]
  aborted: number
  taskGets: number
}

function lifecycleServer(input?: {
  initializeDelay?: number
  rejectInitialize?: boolean
  capabilities?: ServerCapabilities
  instructions?: string
  requestRoots?: boolean
  task?: {
    taskId: string
    status: "working" | "input_required" | "completed" | "failed" | "cancelled"
    lastUpdatedAt: string
  }
}) {
  const capabilities = input?.capabilities ?? { tools: {}, prompts: {}, resources: {} }
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state: LifecycleServerState = {
        tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        requests: [],
        aborted: 0,
        taskGets: 0,
        catalogCalls: [],
        catalogCancelled: 0,
      }

      const catalogRead = async (kind: string, signal: AbortSignal) => {
        state.catalogCalls.push(kind)
        state.onCatalogStart?.()
        try {
          if (state.catalogDelay) await delay(state.catalogDelay, undefined, { signal })
        } catch (error) {
          if (signal.aborted) state.catalogCancelled++
          throw error
        } finally {
          state.onCatalogEnd?.()
        }
      }

      const makeProtocol = async () => {
        const protocol = new Server(
          { name: "mcp-lifecycle", version: "1.0.0" },
          { capabilities, instructions: input?.instructions },
        )
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        })

        protocol.setRequestHandler(PingRequestSchema, async () => {
          if (state.pingDelay) await Bun.sleep(state.pingDelay)
          return {}
        })

        if (capabilities.tools) {
          protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
            await catalogRead("tools", extra.signal)
            if (state.listToolsError) throw new Error(state.listToolsError)
            const page = state.toolPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ tools: page?.items ?? state.tools, nextCursor: page?.nextCursor })
          })
        }
        if (capabilities.tasks && input?.task) {
          protocol.setRequestHandler(GetTaskRequestSchema, (request) => {
            state.taskGets += 1
            if (request.params.taskId !== input.task!.taskId) throw new Error("task not found")
            return Promise.resolve({
              taskId: input.task!.taskId,
              status: input.task!.status,
              ttl: null,
              createdAt: input.task!.lastUpdatedAt,
              lastUpdatedAt: input.task!.lastUpdatedAt,
            })
          })
        }
        if (capabilities.prompts) {
          protocol.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
            await catalogRead("prompts", extra.signal)
            const page = state.promptPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ prompts: page?.items ?? state.prompts, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(GetPromptRequestSchema, async () => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { messages: [{ role: "user", content: { type: "text", text: "prompt result" } }] }
          })
        }
        if (capabilities.resources) {
          protocol.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
            await catalogRead("resources", extra.signal)
            const page = state.resourcePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ resources: page?.items ?? state.resources, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => {
            await catalogRead("templates", extra.signal)
            const page = state.resourceTemplatePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({
              resourceTemplates: page?.items ?? state.resourceTemplates,
              nextCursor: page?.nextCursor,
            })
          })
          protocol.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { contents: [{ uri: request.params.uri, text: "resource result" }] }
          })
        }

        protocol.oninitialized = () => {
          if (!input?.requestRoots) return
          if (!protocol.getClientCapabilities()?.roots) return
          void Bun.sleep(25)
            .then(() => protocol.listRoots())
            .then((result) => {
              state.roots = result.roots
            })
            .catch(() => {})
        }
        await protocol.connect(transport)
        return { protocol, transport }
      }

      let current = await makeProtocol()
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          state.requests.push(request.method)
          request.signal.addEventListener("abort", () => state.aborted++)
          if ((input?.initializeDelay || input?.rejectInitialize) && request.method === "POST") {
            const body = await request.clone().json()
            if (body.method === "initialize") {
              if (input.initializeDelay) await Bun.sleep(input.initializeDelay)
              if (input.rejectInitialize) return new Response(null, { status: 405 })
            }
          }
          return current.transport.handleRequest(request)
        },
      })

      return {
        state,
        url: http.url.toString(),
        sendToolListChanged: () => current.protocol.sendToolListChanged(),
        restart: async () => {
          current = await makeProtocol()
        },
        // Close the active protocol while keeping the HTTP endpoint alive.
        // This models a real remote transport drop and lets the client prove
        // that its supervisor creates a fresh MCP session on the same URL.
        drop: async () => {
          await current.transport.close().catch(() => {})
          await current.protocol.close().catch(() => {})
          current = await makeProtocol()
        },
        close: async () => {
          await current.protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function hangingLifecycleServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "mcp-lifecycle-hanging", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const requests: string[] = []
      let aborted = 0
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          requests.push(request.method)
          request.signal.addEventListener("abort", () => aborted++)
          return new Promise<Response>(() => {})
        },
      })
      return {
        requests,
        aborted: () => aborted,
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function statusName(status: Record<string, MCPNS.Status> | MCPNS.Status, server: string) {
  if ("status" in status) return status.status
  return status[server]?.status
}

/**
 * Approves the first pending control-plane approval for the location: the
 * real L3 fresh-human path through the Authorizer, exactly like a user
 * answering the approval UI.
 */
function approvePending(directory: string) {
  return Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const locationContext = yield* locations.contextEffect(
      Location.Ref.make({ directory: AbsolutePath.make(directory) }),
    )
    yield* Effect.provide(
      Effect.gen(function* () {
        const authorizer = yield* Authorizer.Service
        const request = yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* authorizer.list()
            return list.find((item) => "subject" in item && item.subject.type === "control-plane")
          }),
          "control approval never became pending",
        )
        yield* authorizer.reply({ requestID: request.id, reply: "once" })
      }),
      locationContext,
    )
  })
}

const remote = (url: string, timeout?: number) => ({ type: "remote" as const, url, oauth: false as const, timeout })

type ScopeGuardServer = {
  readonly url: string
  readonly state: { catalogCalls: number }
  readonly sendToolListChanged: () => Promise<void>
  readonly close: () => Promise<void>
}

let scopeGuardServer: ScopeGuardServer | undefined
const scopeGuardConfig: { url?: string; reads: number } = { reads: 0 }

async function startScopeGuardServer(): Promise<ScopeGuardServer> {
  const state = { catalogCalls: 0 }
  const protocol = new Server(
    { name: "mcp-scope-guard", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: "stale server instructions" },
  )
  protocol.setRequestHandler(ListToolsRequestSchema, async () => {
    state.catalogCalls++
    return { tools: [{ name: "cached-tool", inputSchema: { type: "object", properties: {} } }] }
  })
  protocol.setRequestHandler(ListPromptsRequestSchema, async () => {
    state.catalogCalls++
    return { prompts: [{ name: "should-not-be-read" }] }
  })
  protocol.setRequestHandler(ListResourcesRequestSchema, async () => {
    state.catalogCalls++
    return { resources: [{ name: "should-not-be-read", uri: "scope://resource" }] }
  })
  protocol.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    state.catalogCalls++
    return { resourceTemplates: [{ name: "should-not-be-read", uriTemplate: "scope://resource/{id}" }] }
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  })
  await protocol.connect(transport)
  const http = Bun.serve({
    port: 0,
    fetch(request) {
      return transport.handleRequest(request)
    },
  })
  return {
    url: http.url.toString(),
    state,
    sendToolListChanged: () => protocol.sendToolListChanged(),
    close: async () => {
      await protocol.close().catch(() => {})
      http.stop(true)
    },
  }
}

beforeAll(async () => {
  scopeGuardServer = await startScopeGuardServer()
  scopeGuardConfig.url = scopeGuardServer.url
  scopeGuardConfig.reads = 0
})

afterAll(async () => {
  await scopeGuardServer?.close()
  scopeGuardServer = undefined
})

// The first config read seeds the connected client.  Subsequent reads return
// an empty snapshot, modelling source removal while the old generation is
// still connected.  Catalogue/list and cached-tool projections must fail
// closed without issuing a request to that client.
const scopeGuardIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([MCP.node, LocationServiceMap.node, Config.node]), [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.sync(() => {
            scopeGuardConfig.reads += 1
            return scopeGuardConfig.reads === 1 && scopeGuardConfig.url
              ? { mcp: { "scope-guard": remote(scopeGuardConfig.url) } }
              : {}
          }),
      }),
    ],
  ]),
)

scopeGuardIt.instance("catalog reads fail closed when declared scope disappears", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const clients = yield* mcp.clients()
    expect(clients["scope-guard"]).toBeDefined()
    const before = scopeGuardServer!.state.catalogCalls
    expect(yield* mcp.prompts()).toEqual({})
    expect(yield* mcp.resources("scope-guard")).toEqual({})
    expect(yield* mcp.resourceTemplates("scope-guard")).toEqual({})
    // The direct compatibility prompt reader has the same scope fence as
    // resources; once config disappears it must not touch the retained
    // client, even without a generation lease.
    expect(yield* mcp.getPrompt("scope-guard", "should-not-be-read")).toBeUndefined()
    // The transport-free registry can retain the handshake generation, but
    // API/CLI capability projections must not expose it after scope removal.
    expect(yield* mcp.capabilities!()).toEqual([])
    expect((yield* mcp.catalog()).capabilities).toEqual([])
    expect(yield* mcp.instructions()).toEqual([])
    expect(scopeGuardServer!.state.catalogCalls).toBe(before)
    yield* Effect.promise(() => scopeGuardServer!.sendToolListChanged())
    yield* Effect.promise(() => delay(50))
    expect(scopeGuardServer!.state.catalogCalls).toBe(before)
    expect(Object.keys(yield* mcp.tools())).toEqual([])
  }),
)

for (const source of ["server", "global"] as const)
  it.instance(
    `phase-specific MCP timeouts from ${source} allow startup without lengthening request deadlines`,
    () =>
      Effect.gen(function* () {
        const server = yield* lifecycleServer({ initializeDelay: 300 })
        const mcp = yield* MCP.Service
        const timeout = { startup: 2000, request: 100 }
        yield* mcp.add("phases", {
          ...remote(server.url),
          ...(source === "server" ? { timeout } : {}),
        })
        expect((yield* mcp.status()).phases?.status).toBe("connected")
        expect((yield* mcp.tools()).phases_test_tool?.timeout).toBe(100)
        // Caller mutation must not alter an already connected generation.
        timeout.request = 1000
        expect((yield* mcp.tools()).phases_test_tool?.timeout).toBe(100)
        server.state.requestDelay = 500
        expect(yield* mcp.getPrompt("phases", "delayed")).toBeUndefined()
        server.state.requestDelay = 0
        expect(yield* mcp.getPrompt("phases", "ready")).toMatchObject({
          messages: [{ content: { text: "prompt result" } }],
        })
      }),
    {
      init: (directory) =>
        Effect.promise(() =>
          Bun.write(
            path.join(directory, "arforge.json"),
            JSON.stringify({
              mcp: { timeout: source === "global" ? { startup: 2000, request: 100 } : { startup: 100, request: 2000 } },
            }),
          ),
        ).pipe(Effect.asVoid),
    },
  )

it.instance("a short MCP startup timeout cannot borrow the longer request timeout", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ initializeDelay: 500 })
    const mcp = yield* MCP.Service
    yield* mcp.add("short-start", { ...remote(server.url), timeout: { startup: 100, request: 2000 } })
    expect((yield* mcp.status())["short-start"]?.status).toBe("failed")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    expect(server.state.requests).toContain("POST")
    expect(server.state.requests).not.toContain("GET")
  }),
)

it.instance("MCP transport fallback remains available within the startup budget", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ rejectInitialize: true })
    const mcp = yield* MCP.Service
    yield* mcp.add("fallback", { ...remote(server.url), timeout: { startup: 2000, request: 100 } })
    expect((yield* mcp.status()).fallback?.status).toBe("failed")
    expect(server.state.requests).toContain("POST")
    expect(server.state.requests).toContain("GET")
  }),
)

it.instance("MCP health probes enforce the request timeout before awaiting the response", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("slow-health", { ...remote(server.url), timeout: { startup: 2000, request: 100 } })
    expect((yield* mcp.status())["slow-health"]?.status).toBe("connected")
    server.state.pingDelay = 500
    const snapshot = (yield* mcp.health({ probe: true }))["slow-health"]
    expect(snapshot?.health).not.toBe("healthy")
    expect(snapshot?.failureCount).toBeGreaterThan(0)
  }),
)

for (const kind of ["tools", "prompts", "resources", "templates"] as const)
  it.instance(
    `the original ${kind} catalog consumer aborts a slow whole traversal without publishing partial entries`,
    () =>
      Effect.gen(function* () {
        const server = yield* lifecycleServer()
        const mcp = yield* MCP.Service
        const entries = Array.from({ length: 8 }, (_, index) => {
          const page = {
            items: [
              {
                name: `entry-${index}`,
                inputSchema: { type: "object" as const },
                uri: `test://${index}`,
                uriTemplate: `test://${index}/{id}`,
              },
            ],
            nextCursor: index === 7 ? undefined : String(index + 1),
          }
          return [index === 0 ? "initial" : String(index), page] as const
        })
        server.state.toolPages = kind === "tools" ? Object.fromEntries(entries) : undefined
        server.state.promptPages = kind === "prompts" ? Object.fromEntries(entries) : undefined
        server.state.resourcePages = kind === "resources" ? Object.fromEntries(entries) : undefined
        server.state.resourceTemplatePages = kind === "templates" ? Object.fromEntries(entries) : undefined
        if (kind === "tools") server.state.catalogDelay = 60
        yield* mcp.add("catalog-budget", { ...remote(server.url), timeout: { startup: 2000, request: 150 } })
        if (kind !== "tools") {
          expect((yield* mcp.status())["catalog-budget"]?.status).toBe("connected")
          server.state.catalogDelay = 60
        }
        const result =
          kind === "tools"
            ? yield* mcp.tools()
            : kind === "prompts"
              ? yield* mcp.prompts()
              : kind === "resources"
                ? yield* mcp.resources()
                : yield* mcp.resourceTemplates()
        expect(Object.keys(result)).toEqual([])
        expect(server.state.catalogCalls.filter((value) => value === kind).length).toBeLessThan(8)
        expect(
          (yield* mcp.capabilities!()).filter(
            (item) => item.kind === (kind === "templates" ? "resource_template" : kind.slice(0, -1)),
          ),
        ).toEqual([])
      }),
  )

it.instance("concurrent catalog readers share one bounded instance pool across servers and list kinds", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    let active = 0
    let maximum = 0
    const servers = []
    for (let index = 0; index < 6; index++) {
      const server = yield* lifecycleServer()
      server.state.prompts = [{ name: "one" }]
      server.state.resources = [{ name: "one", uri: `test://${index}` }]
      yield* mcp.add(`pool-${index}`, { ...remote(server.url), timeout: { startup: 2000, request: 1000 } })
      servers.push(server)
    }
    for (const server of servers) {
      server.state.catalogDelay = 80
      server.state.onCatalogStart = () => {
        active++
        maximum = Math.max(maximum, active)
      }
      server.state.onCatalogEnd = () => {
        active--
      }
    }
    const [prompts, resources] = yield* Effect.all([mcp.prompts(), mcp.resources()], { concurrency: 2 })
    expect(Object.keys(prompts)).toHaveLength(6)
    expect(Object.keys(resources)).toHaveLength(6)
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(4)
    expect(active).toBe(0)
  }),
)

it.instance("catalog() returns one coherent projection for all protocol catalogue kinds", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({
      capabilities: { tools: {}, prompts: {}, resources: {} },
    })
    server.state.prompts = [{ name: "review", description: "Review the change" }]
    server.state.resources = [{ name: "readme", uri: "docs://readme" }]
    server.state.resourceTemplates = [{ name: "issue", uriTemplate: "docs://issues/{id}" }]
    const mcp = yield* MCP.Service
    yield* mcp.add("coherent", remote(server.url))

    const snapshot = yield* mcp.catalog()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.prompts)).toBe(true)
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true)
    expect(Object.keys(snapshot.prompts)).toEqual(["coherent:review"])
    expect(Object.keys(snapshot.resources)).toEqual(["coherent:docs://readme"])
    expect(Object.keys(snapshot.resourceTemplates)).toEqual(["coherent:docs://issues/{id}"])
    expect(snapshot.capabilities.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "prompt:coherent:review",
      "resource:coherent:docs://readme",
      "resource_template:coherent:docs://issues/{id}",
      "tool:coherent_test_tool",
    ])
  }),
)

it.instance("catalog control gateway settles a lease-free durable run", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({
      capabilities: { tools: {}, prompts: {}, resources: {} },
    })
    const mcp = yield* MCP.Service
    yield* mcp.add("control", remote(server.url))

    const requestID = AgentRuntime.ControlPlaneRequestID.create()
    const snapshot = yield* McpControlGateway.catalog({
      mcp,
      principal: ControlPrincipal.LOCAL_PRINCIPAL,
      requestID,
    })
    expect(snapshot.capabilities).toHaveLength(1)

    const instance = yield* TestInstance
    const locations = yield* LocationServiceMap.Service
    const locationContext = yield* locations.contextEffect(
      Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }),
    )
    const runs = yield* Effect.provide(
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        return yield* durable.list({ limit: 100 })
      }),
      locationContext,
    )
    const catalogRuns = runs.filter(
      (item): item is DurableRun.ControlSnapshot =>
        "subject" in item.run &&
        item.run.operation.kind === "mcp.catalog.read" &&
        item.run.subject.requestID === requestID,
    )
    expect(catalogRuns).toHaveLength(1)
    expect(catalogRuns[0]?.run.status).toBe("completed")
    expect(catalogRuns[0]?.lease).toBeUndefined()
    expect(catalogRuns[0]?.activeAttempt).toBeUndefined()
  }),
)

it.instance("catalog() retries when a reconnect changes its generation fence", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({
      capabilities: { tools: {}, prompts: {}, resources: {} },
    })
    server.state.prompts = [{ name: "review" }]
    server.state.resources = [{ name: "readme", uri: "docs://readme" }]
    server.state.resourceTemplates = [{ name: "issue", uriTemplate: "docs://issues/{id}" }]
    server.state.catalogDelay = 40
    const mcp = yield* MCP.Service
    yield* mcp.add("fenced", { ...remote(server.url), timeout: { startup: 2000, request: 2000 } })

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let signalled = false
    server.state.onCatalogStart = () => {
      if (signalled) return
      signalled = true
      resolveStarted()
    }

    // Let the first list request start, then establish a fresh MCP client
    // while all three catalogue reads are still inside their bounded delay.
    // The first attempt must be discarded by the generation/client fence.
    const reconnect = yield* Effect.forkChild(
      Effect.promise(async () => {
        await started
        await delay(5)
        // Replace the server-side session first so the explicit add starts a
        // fresh transport instead of competing for the old HTTP session.
        await server.restart()
      }).pipe(Effect.andThen(mcp.add("fenced", { ...remote(server.url), timeout: { startup: 2000, request: 2000 } }))),
    )
    const snapshot = yield* mcp.catalog()
    yield* Fiber.join(reconnect)

    expect(Object.keys(snapshot.prompts)).toEqual(["fenced:review"])
    expect(Object.keys(snapshot.resources)).toEqual(["fenced:docs://readme"])
    expect(Object.keys(snapshot.resourceTemplates)).toEqual(["fenced:docs://issues/{id}"])
    expect(server.state.catalogCalls.length).toBeGreaterThan(3)
    expect((yield* mcp.health()).fenced?.phase).toBe("ready")
    expect((yield* mcp.health()).fenced?.observedGeneration).not.toBeNull()
  }),
)

it.instance("interrupting a catalog reader cancels its real protocol request and leaves the client reusable", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("cancel-catalog", { ...remote(server.url), timeout: { startup: 2000, request: 2000 } })
    server.state.catalogDelay = 1000
    const reading = yield* mcp.resourceTemplates().pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() => (server.state.catalogCalls.includes("templates") ? true : undefined)),
      "catalog request did not start",
    )
    yield* Fiber.interrupt(reading)
    yield* pollWithTimeout(
      Effect.sync(() => server.state.catalogCancelled || undefined),
      "catalog interruption did not cancel the protocol request",
    )
    server.state.catalogDelay = 0
    server.state.resourceTemplates = [{ name: "ready", uriTemplate: "test://ready/{id}" }]
    expect(Object.keys(yield* mcp.resourceTemplates())).toEqual(["cancel-catalog:test://ready/{id}"])
    expect((yield* mcp.status())["cancel-catalog"]?.status).toBe("connected")
  }),
)

it.instance("an oversized remote catalog is rejected without hiding another server's complete catalog", () =>
  Effect.gen(function* () {
    const oversized = yield* lifecycleServer({ capabilities: { prompts: {} } })
    const healthy = yield* lifecycleServer({ capabilities: { prompts: {} } })
    oversized.state.prompts = Array.from({ length: 10001 }, (_, index) => ({ name: `entry-${index}` }))
    healthy.state.prompts = [{ name: "ready" }]
    const mcp = yield* MCP.Service
    yield* mcp.add("oversized", remote(oversized.url))
    yield* mcp.add("healthy", remote(healthy.url))
    expect(Object.keys(yield* mcp.prompts())).toEqual(["healthy:ready"])
    expect((yield* mcp.capabilities!()).map((item) => item.id)).toEqual(["healthy:ready"])
    expect((yield* mcp.status()).healthy?.status).toBe("connected")
  }),
)

it.instance("advertises and lists the instance directory as its root", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ requestRoots: true })
    const mcp = yield* MCP.Service
    const test = yield* TestInstance
    yield* mcp.add("roots", remote(server.url))

    const roots = yield* pollWithTimeout(
      Effect.sync(() => server.state.roots),
      "server did not receive roots",
    )
    expect(roots).toEqual([{ uri: pathToFileURL(test.directory).href }])
  }),
)

it.instance("reads a server-side MCP task status without fetching its result", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({
      capabilities: {
        tools: {},
        tasks: { list: {}, requests: { tools: { call: {} } } },
      },
      task: {
        taskId: "task-42",
        status: "completed",
        lastUpdatedAt: "2026-08-30T00:00:07.000Z",
      },
    })
    const mcp = yield* MCP.Service
    yield* mcp.add("task-status", remote(server.url))
    yield* pollWithTimeout(
      Effect.map(mcp.status(), (status) => statusName(status, "task-status") === "connected"),
      "task status MCP server did not connect",
    )
    if (!mcp.lookupTask) throw new Error("MCP task lookup capability is unavailable")
    const state = yield* mcp.lookupTask("task-status", "task-42")
    expect(state).toEqual({ status: "completed", observedAt: Date.parse("2026-08-30T00:00:07.000Z") })
    expect(server.state.taskGets).toBe(1)
  }),
)

it.instance(
  "local mcp cwd resolves relative paths against instance directory",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      yield* mcp.add("rel-cwd", {
        type: "local",
        command: [process.execPath, stdioFixture],
        cwd: "plugins/sub",
      })
      // The fresh L3 human approval gates the spawn; only then does the
      // local stdio server start.
      expect((yield* mcp.status())["rel-cwd"]?.status).toBe("needs_approval")
      yield* approvePending(test.directory)
      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const status = (yield* mcp.status())["rel-cwd"]
          if (status?.status === "failed") return yield* Effect.fail(new Error(status.error))
          const listed = (yield* mcp.tools())["rel-cwd_current_directory"]
          return listed ? listed : undefined
        }),
        "local server did not connect after approval",
      )
      const expected = path.resolve(test.directory, "plugins/sub")
      expect(process.platform === "win32" ? tool?.def.description?.toLowerCase() : tool?.def.description).toBe(
        process.platform === "win32" ? expected.toLowerCase() : expected,
      )
    }),
  { init: (directory) => Effect.promise(() => Bun.$`mkdir -p ${path.join(directory, "plugins/sub")}`.quiet()) },
)

it.instance("tools() reuses cached definitions until a protocol notification", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: { listChanged: true } } })
    const mcp = yield* MCP.Service
    yield* mcp.add("cache-server", remote(server.url))
    server.state.tools = [{ name: "next_tool", inputSchema: { type: "object", properties: {} } }]

    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_test_tool"])
    yield* Effect.promise(server.sendToolListChanged)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const keys = Object.keys(yield* mcp.tools())
        return keys.includes("cache-server_next_tool") ? keys : undefined
      }),
      "tool cache did not refresh",
    )
    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_next_tool"])
  }),
)

it.instance("instructions() returns non-empty connected server instructions with tool names", () =>
  Effect.gen(function* () {
    const guide = yield* lifecycleServer({ instructions: "Use lookup before mutate." })
    const blank = yield* lifecycleServer({ instructions: "   " })
    const mcp = yield* MCP.Service
    yield* mcp.add("guide-server", remote(guide.url))
    yield* mcp.add("blank-server", remote(blank.url))

    expect(yield* mcp.instructions()).toEqual([
      { name: "guide-server", instructions: "Use lookup before mutate.", tools: ["guide-server_test_tool"] },
    ])
    yield* mcp.disconnect("guide-server")
    expect(yield* mcp.instructions()).toEqual([])
  }),
)

it.instance("follows cursors when listing tools, prompts, resources, and templates", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.toolPages = {
      initial: { items: [{ name: "tool-one", inputSchema: { type: "object" } }], nextCursor: "tools-2" },
      "tools-2": { items: [{ name: "tool-two", inputSchema: { type: "object" } }] },
    }
    server.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "prompts-2" },
      "prompts-2": { items: [{ name: "prompt-two" }] },
    }
    server.state.resourcePages = {
      initial: { items: [{ name: "resource-one", uri: "test://one" }], nextCursor: "resources-2" },
      "resources-2": { items: [{ name: "resource-two", uri: "test://two" }] },
    }
    server.state.resourceTemplatePages = {
      initial: { items: [{ name: "template-one", uriTemplate: "test://one/{id}" }], nextCursor: "templates-2" },
      "templates-2": { items: [{ name: "template-two", uriTemplate: "test://two/{id}" }] },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("paged-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["paged-server_tool-one", "paged-server_tool-two"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["paged-server:prompt-one", "paged-server:prompt-two"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["paged-server:test://one", "paged-server:test://two"])
    expect(Object.keys(yield* mcp.resourceTemplates())).toEqual([
      "paged-server:test://one/{id}",
      "paged-server:test://two/{id}",
    ])
    const capabilities = yield* mcp.capabilities!()
    expect(capabilities.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "prompt:paged-server:prompt-one",
      "prompt:paged-server:prompt-two",
      "resource:paged-server:test://one",
      "resource:paged-server:test://two",
      "resource_template:paged-server:test://one/{id}",
      "resource_template:paged-server:test://two/{id}",
      "tool:paged-server_tool-one",
      "tool:paged-server_tool-two",
    ])
  }),
)

it.instance("accepts empty cursors and rejects repeated cursors", () =>
  Effect.gen(function* () {
    const empty = yield* lifecycleServer({ capabilities: { prompts: {} } })
    empty.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "" },
      "": { items: [{ name: "prompt-two" }] },
    }
    const looping = yield* lifecycleServer({ capabilities: { tools: {} } })
    looping.state.toolPages = {
      initial: { items: [], nextCursor: "repeat" },
      repeat: { items: [], nextCursor: "repeat" },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("empty-cursor", remote(empty.url))
    const result = yield* mcp.add("looping-cursor", remote(looping.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["empty-cursor:prompt-one", "empty-cursor:prompt-two"])
    expect(statusName(result.status, "looping-cursor")).toBe("failed")
  }),
)

it.instance("disconnect removes protocol data and reconnect establishes a new session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("reconnect-server", remote(server.url))
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")
    expect((yield* mcp.health({ probe: true }))["reconnect-server"]).toMatchObject({
      phase: "ready",
      health: "healthy",
      desiredGeneration: expect.any(Number),
      observedGeneration: expect.any(Number),
    })

    yield* mcp.disconnect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("disabled")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    yield* pollWithTimeout(
      Effect.sync(() => (server.state.aborted > 0 ? server.state.aborted : undefined)),
      "disconnected HTTP session was not aborted",
    )

    yield* Effect.promise(server.restart)
    yield* mcp.connect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["reconnect-server_test_tool"])
  }),
)

it.instance("rejects a resource lease from a previous MCP generation after reconnect", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.resources = [
      { name: "docs", uri: "docs://readme" },
      { name: "other", uri: "docs://other" },
      { name: "query", uri: "docs://query?token=abc#section" },
    ]
    server.state.resourceTemplates = [{ name: "issue", uriTemplate: "docs://issues/{id}" }]
    const mcp = yield* MCP.Service
    yield* mcp.add("resource-lease-server", remote(server.url))

    const listedEntries = Object.entries(yield* mcp.resources("resource-lease-server"))
    const listedEntry = listedEntries.find(([, value]) => value.uri === "docs://readme")
    const otherEntry = listedEntries.find(([, value]) => value.uri === "docs://other")
    const listed = listedEntry?.[1]
    const other = otherEntry?.[1]
    if (!listed?.generation || !other?.generation || !listedEntry || !otherEntry)
      throw new Error("resource generations were not published")
    const lease = {
      id: listedEntry[0] ?? safeCapabilityKey("resource-lease-server", "docs://readme"),
      server: "resource-lease-server",
      generation: listed.generation,
      kind: "resource" as const,
      reference: "docs://readme",
    }
    const otherLease = {
      id: otherEntry[0] ?? safeCapabilityKey("resource-lease-server", "docs://other"),
      server: "resource-lease-server",
      generation: other.generation,
      kind: "resource" as const,
      reference: "docs://other",
    }
    expect(yield* mcp.readResource("resource-lease-server", "docs://readme", lease)).toBeDefined()

    // Both resources are current, so generation alone is insufficient: the
    // lease for `docs://other` must not redirect a read of `docs://readme`.
    const beforeMismatchedURI = server.state.requests.length
    expect(yield* mcp.readResource("resource-lease-server", "docs://readme", otherLease)).toBeUndefined()
    expect(server.state.requests.length).toBe(beforeMismatchedURI)
    const wrongReferenceLease = { ...lease, reference: "docs://other" }
    expect(yield* mcp.readResource("resource-lease-server", "docs://readme", wrongReferenceLease)).toBeUndefined()
    expect(server.state.requests.length).toBe(beforeMismatchedURI)

    const queryEntry = Object.entries(yield* mcp.resources("resource-lease-server")).find(
      ([, value]) => value.uri === "docs://query?token=abc#section",
    )
    if (!queryEntry?.[1]?.generation) throw new Error("query resource generation was not published")
    if (!mcp.leaseForCapability) throw new Error("MCP capability lease minting is unavailable")
    const queryLease = yield* mcp.leaseForCapability({
      id: safeCapabilityKey("resource-lease-server", queryEntry[1].uri),
      server: "resource-lease-server",
      generation: queryEntry[1].generation,
      kind: "resource",
      reference: "docs://query?token=abc#section",
    })
    expect(queryLease?.proof).toEqual(expect.any(String))
    expect(yield* mcp.readResource("resource-lease-server", "docs://query?token=abc#section", queryLease)).toBeDefined()
    const beforeForgedQuery = server.state.requests.length
    expect(
      yield* mcp.leaseForCapability({
        id: safeCapabilityKey("resource-lease-server", queryEntry[1].uri),
        server: "resource-lease-server",
        generation: queryEntry[1].generation,
        kind: "resource",
        reference: "docs://query?token=def#section",
      }),
    ).toBeUndefined()
    expect(server.state.requests.length).toBe(beforeForgedQuery)

    const templateEntries = Object.entries(yield* mcp.resourceTemplates("resource-lease-server"))
    const templateEntry = templateEntries.find(([, value]) => value.uriTemplate === "docs://issues/{id}")
    const template = templateEntry?.[1]
    if (!template?.generation || !templateEntry) throw new Error("resource template generation was not published")
    const templateLease = {
      id: templateEntry[0],
      server: "resource-lease-server",
      generation: template.generation,
      kind: "resource_template" as const,
      reference: "docs://issues/42",
    }
    expect(yield* mcp.readResource("resource-lease-server", "docs://issues/42", templateLease)).toBeDefined()
    const beforeMismatchedTemplateURI = server.state.requests.length
    expect(yield* mcp.readResource("resource-lease-server", "docs://issues/43", templateLease)).toBeUndefined()
    expect(server.state.requests.length).toBe(beforeMismatchedTemplateURI)

    if (!mcp.leaseForCapability) throw new Error("MCP capability lease minting is unavailable")
    const mintedTemplate = yield* mcp.leaseForCapability({
      id: templateEntry[0],
      server: "resource-lease-server",
      generation: template.generation,
      kind: "resource_template",
      reference: "docs://issues/42",
      template: "docs://issues/{id}",
    })
    expect(mintedTemplate?.proof).toEqual(expect.any(String))
    expect(mintedTemplate?.template).toBe("docs://issues/{id}")
    expect(yield* mcp.readResource("resource-lease-server", "docs://issues/42", mintedTemplate)).toBeDefined()
    const beforeForgedTemplate = server.state.requests.length
    expect(
      yield* mcp.readResource("resource-lease-server", "docs://issues/42", {
        ...mintedTemplate!,
        template: "docs://issues/{other}",
      }),
    ).toBeUndefined()
    expect(server.state.requests.length).toBe(beforeForgedTemplate)

    yield* mcp.disconnect("resource-lease-server")
    yield* Effect.promise(server.restart)
    yield* mcp.connect("resource-lease-server")

    // The old capability must not silently bind to the replacement Client.
    expect(yield* mcp.readResource("resource-lease-server", "docs://readme", lease)).toBeUndefined()
  }),
)

it.instance("automatically reconnects a dropped remote transport through the supervisor", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("auto-reconnect-server", remote(server.url))
    const before = (yield* mcp.health())["auto-reconnect-server"]
    expect(before?.phase).toBe("ready")
    expect(before?.observedGeneration).toBe(before?.desiredGeneration)

    yield* Effect.promise(server.drop)

    const recovered = yield* pollWithTimeout(
      Effect.gen(function* () {
        const snapshot = (yield* mcp.health({ probe: true }))["auto-reconnect-server"]
        const status = (yield* mcp.status())["auto-reconnect-server"]
        if (
          status?.status === "connected" &&
          snapshot?.phase === "ready" &&
          snapshot.observedGeneration !== before?.observedGeneration
        )
          return snapshot
        return undefined
      }),
      "remote MCP transport did not recover automatically",
    )

    expect(recovered.health).toBe("healthy")
    expect(recovered.observedGeneration).toBe(recovered.desiredGeneration)
    expect(Object.keys(yield* mcp.tools())).toEqual(["auto-reconnect-server_test_tool"])
  }),
)

it.instance(
  "background health monitoring recovers a remote drop without a manual probe",
  () =>
    Effect.gen(function* () {
      const server = yield* lifecycleServer()
      const mcp = yield* MCP.Service
      yield* mcp.add("background-recovery-server", remote(server.url))
      const before = (yield* mcp.health())["background-recovery-server"]
      expect(before?.phase).toBe("ready")

      yield* Effect.promise(server.drop)

      const final = yield* pollWithTimeout(
        Effect.gen(function* () {
          const snapshot = (yield* mcp.health())["background-recovery-server"]
          const status = (yield* mcp.status())["background-recovery-server"]
          if (
            status?.status === "connected" &&
            snapshot?.phase === "ready" &&
            snapshot.observedGeneration !== before?.observedGeneration
          )
            return snapshot
          return undefined
        }),
        "background MCP health monitor did not recover the remote drop",
        "12 seconds",
      )

      expect(final?.health).toBe("healthy")
      expect(Object.keys(yield* mcp.tools())).toEqual(["background-recovery-server_test_tool"])
    }),
  15_000,
)

it.instance("restores the redacted supervisor checkpoint across an instance reload", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const test = yield* TestInstance
    const mcp = yield* MCP.Service
    const config = remote(server.url)

    yield* mcp.add("checkpoint-server", config)
    // The public CLI persists configuration before the runtime is reloaded;
    // mirror that user-visible path here so the new state has the same server
    // entry after its old state is disposed.
    yield* Effect.promise(() =>
      Bun.write(path.join(test.directory, "arforge.json"), JSON.stringify({ mcp: { "checkpoint-server": config } })),
    )

    const before = (yield* mcp.health())["checkpoint-server"]
    expect(before?.phase).toBe("ready")
    expect(before?.lastKnown).toMatchObject({ phase: "ready", health: "healthy" })

    // Rotate the remote protocol session before the client runtime is
    // reloaded; this models a server that remains available while Arforge
    // disposes its old client.
    yield* Effect.promise(server.restart)
    yield* reloadInstance({ directory: test.directory })

    const after = yield* pollWithTimeout(
      Effect.gen(function* () {
        const snapshot = (yield* mcp.health())["checkpoint-server"]
        return snapshot?.phase === "ready" && snapshot.health === "healthy" ? snapshot : undefined
      }),
      "MCP supervisor did not reconnect after reload",
      "6 seconds",
    )
    expect(after?.lastKnown).toMatchObject({ phase: "ready", health: "healthy" })
    // A checkpoint never resurrects an old Client object. The fresh state
    // negotiates a new session and only then reports ready/healthy.
    expect(after?.phase).toBe("ready")
    expect(after?.health).toBe("healthy")
    expect(Object.keys(yield* mcp.tools())).toEqual(["checkpoint-server_test_tool"])
  }),
)

it.instance("explicit disconnect cancels a queued remote recovery", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("cancel-recovery-server", remote(server.url))
    yield* Effect.promise(server.drop)

    const failed = (yield* mcp.health({ probe: true }))["cancel-recovery-server"]
    expect(failed?.phase).toBe("backoff")
    yield* mcp.disconnect("cancel-recovery-server")
    yield* Effect.sleep("350 millis")

    expect((yield* mcp.status())["cancel-recovery-server"]?.status).toBe("disabled")
    expect((yield* mcp.health())["cancel-recovery-server"]?.phase).toBe("idle")
  }),
)

it.instance("add() closes the old protocol session when replacing a server", () =>
  Effect.gen(function* () {
    const first = yield* lifecycleServer()
    const second = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("replace-server", remote(first.url))
    yield* mcp.add("replace-server", remote(second.url))

    yield* pollWithTimeout(
      Effect.sync(() => (first.state.aborted > 0 ? first.state.aborted : undefined)),
      "replaced HTTP session was not aborted",
    )
    expect(second.state.aborted).toBe(0)
    expect(Object.keys(yield* mcp.tools())).toEqual(["replace-server_test_tool"])
  }),
)

it.instance("one failed server does not affect another connected server", () =>
  Effect.gen(function* () {
    const good = yield* lifecycleServer()
    good.state.tools = [{ name: "good_tool", inputSchema: { type: "object" } }]
    const bad = yield* lifecycleServer()
    bad.state.listToolsError = "listTools failed"
    const mcp = yield* MCP.Service
    yield* mcp.add("good-server", remote(good.url))
    yield* mcp.add("bad-server", remote(bad.url))

    expect((yield* mcp.status())["good-server"]?.status).toBe("connected")
    expect((yield* mcp.status())["bad-server"]?.status).toBe("failed")
    expect(Object.keys(yield* mcp.tools())).toEqual(["good-server_good_tool"])
  }),
)

it.instance("falls back when output schema refs fail SDK tool discovery", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      {
        name: "render_screen",
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        outputSchema: { type: "object", properties: { screen: { $ref: "#/$defs/ScreenInstance" } } },
      },
    ]
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("schema-server", remote(server.url))

    expect(statusName(result.status, "schema-server")).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["schema-server_render_screen"])
  }),
)

it.instance("does not fall back for protocol tool discovery errors", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.listToolsError = "transport closed"
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("broken-server", remote(server.url))

    expect(statusName(result.status, "broken-server")).toBe("failed")
  }),
)

it.instance("disabled server is marked disabled without opening a protocol session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("disabled-server", { ...remote(server.url), enabled: false })

    expect((yield* mcp.status())["disabled-server"]?.status).toBe("disabled")
    expect(server.state.requests).toEqual([])
  }),
)

it.instance("returns prompts and URI-keyed resources from connected servers", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.prompts = [{ name: "my-prompt", description: "A test prompt" }]
    server.state.resources = [
      { name: "same-name", uri: "file:///test.txt" },
      { name: "same-name", uri: "ui://component-state" },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("content-server", remote(server.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["content-server:my-prompt"])
    expect(Object.keys(yield* mcp.resources())).toEqual([
      "content-server:file:///test.txt",
      "content-server:ui://component-state",
    ])
    yield* mcp.disconnect("content-server")
    expect(yield* mcp.prompts()).toEqual({})
  }),
)

it.instance("native MCP prompt reads reject stale or mismatched generation leases", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.prompts = [{ name: "review", description: "Review the workspace" }]
    const mcp = yield* MCP.Service
    yield* mcp.add("prompt-lease-server", remote(server.url))

    const first = (yield* mcp.prompts())["prompt-lease-server:review"]
    expect(first?.generation).toBeDefined()
    const generation = first!.generation!
    const lease = {
      id: "prompt-lease-server:review",
      server: "prompt-lease-server",
      generation,
      kind: "prompt" as const,
    }
    if (!mcp.leaseForCapability) throw new Error("MCP capability lease minting is unavailable")
    const minted = yield* mcp.leaseForCapability({
      id: lease.id,
      server: lease.server,
      generation,
      kind: "prompt",
      reference: "review",
    })
    expect(minted?.proof).toEqual(expect.any(String))
    expect(minted?.reference).toBe("review")
    const before = server.state.requests.length
    expect(yield* mcp.getPrompt("prompt-lease-server", "review", {}, lease)).toMatchObject({
      messages: [{ content: { text: "prompt result" } }],
    })
    expect(yield* mcp.getPrompt("prompt-lease-server", "review", {}, minted)).toMatchObject({
      messages: [{ content: { text: "prompt result" } }],
    })
    const afterCurrent = server.state.requests.length
    expect(afterCurrent).toBeGreaterThan(before)
    const beforeForgedReference = server.state.requests.length
    expect(
      yield* mcp.getPrompt("prompt-lease-server", "review", {}, { ...minted!, reference: "other" }),
    ).toBeUndefined()
    expect(server.state.requests.length).toBe(beforeForgedReference)

    yield* mcp.disconnect("prompt-lease-server")
    // `add` is the explicit replacement path: it creates a new configured
    // generation and refreshes the protocol capability cache after disable.
    yield* Effect.promise(server.restart)
    yield* mcp.add("prompt-lease-server", remote(server.url))
    const second = (yield* mcp.prompts())["prompt-lease-server:review"]
    expect(second?.generation).toBeDefined()
    expect(second!.generation).not.toBe(generation)

    // The old lease is rejected before the SDK transport is touched.
    const beforeStale = server.state.requests.length
    expect(yield* mcp.getPrompt("prompt-lease-server", "review", {}, lease)).toBeUndefined()
    expect(server.state.requests.length).toBe(beforeStale)

    // A lease for another prompt cannot be used to redirect this request.
    expect(
      yield* mcp.getPrompt(
        "prompt-lease-server",
        "review",
        {},
        {
          ...lease,
          id: "prompt-lease-server:other",
          generation: second!.generation!,
        },
      ),
    ).toBeUndefined()
  }),
)

it.instance("uses per-server timeouts for prompt and resource requests", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.requestDelay = 200
    const mcp = yield* MCP.Service
    yield* mcp.add("timeout-server", remote(server.url, 50))

    expect(yield* mcp.getPrompt("timeout-server", "test")).toBeUndefined()
    expect(yield* mcp.readResource("timeout-server", "test://resource")).toBeUndefined()
  }),
)

it.instance("connects resource-only, prompt-only, and tools-only servers", () =>
  Effect.gen(function* () {
    const resources = yield* lifecycleServer({ capabilities: { resources: {} } })
    resources.state.resources = [{ name: "docs", uri: "docs://readme" }]
    const prompts = yield* lifecycleServer({ capabilities: { prompts: {} } })
    prompts.state.prompts = [{ name: "review" }]
    const tools = yield* lifecycleServer({ capabilities: { tools: {} } })
    const mcp = yield* MCP.Service
    yield* mcp.add("resource-only", remote(resources.url))
    yield* mcp.add("prompt-only", remote(prompts.url))
    yield* mcp.add("tools-only", remote(tools.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["tools-only_test_tool"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["prompt-only:review"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["resource-only:docs://readme"])
  }),
)

it.instance("connect and disconnect fail for unknown servers", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    for (const operation of [mcp.connect("missing"), mcp.disconnect("missing")]) {
      const exit = yield* operation.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "MCP.NotFoundError", name: "missing" })
      }
    }
    expect(yield* mcp.status()).toEqual({})
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("unavailable remote server is marked failed without tools", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => new Response("unavailable", { status: 503 }) })),
      (http) => Effect.promise(() => http.stop(true)),
    )
    const mcp = yield* MCP.Service
    yield* mcp.add("unavailable", remote(server.url.toString(), 500))

    expect((yield* mcp.status()).unavailable?.status).toBe("failed")
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("tools() prefixes sanitized server and tool names", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      { name: "tool-a", inputSchema: { type: "object" } },
      { name: "tool.b", inputSchema: { type: "object" } },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("my.special-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["my_special-server_tool-a", "my_special-server_tool_b"])
  }),
)

it.instance("local stdio timeout terminates the real server process", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pidFile = path.join(test.directory, "mcp.pid")
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-stdio", {
      type: "local",
      command: [process.execPath, stdioFixture, "--hang"],
      environment: { MCP_LIFECYCLE_PID_FILE: pidFile },
      timeout: 100,
    })

    // The intent is durable and pending before any spawn; the spawn only
    // happens after the fresh L3 human approval.
    expect(statusName(result.status, "hanging-stdio")).toBe("needs_approval")
    yield* approvePending(test.directory)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const status = (yield* mcp.status())["hanging-stdio"]?.status
        return status === "failed" ? status : undefined
      }),
      "hanging stdio never failed",
    )
    const pid = yield* pollWithTimeout(
      Effect.promise(async () => {
        const file = Bun.file(pidFile)
        return (await file.exists()) ? Number(await file.text()) : undefined
      }),
      "stdio fixture did not publish its pid",
    )
    yield* pollWithTimeout(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch {
          return true
        }
      }),
      "stdio fixture process was not terminated",
    )
  }),
)

it.instance("remote startup timeout aborts the active HTTP attempt without starting an expired fallback", () =>
  Effect.gen(function* () {
    const server = yield* hangingLifecycleServer()
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-remote", remote(server.url, 100))

    expect(statusName(result.status, "hanging-remote")).toBe("failed")
    yield* pollWithTimeout(
      Effect.sync(() => (server.aborted() >= 1 ? server.aborted() : undefined)),
      "remote transport request was not aborted",
    )
    expect(server.requests).toEqual(["POST"])
  }),
)

it.live("McpOAuthCallback.cancelPending rejects the pending callback", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => McpOAuthCallback.waitForCallback("abc123hexstate", "my-mcp-server")),
    (callback) =>
      Effect.gen(function* () {
        McpOAuthCallback.cancelPending("my-mcp-server")
        const exit = yield* Effect.tryPromise({
          try: () => callback,
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    () => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore),
  ),
)
