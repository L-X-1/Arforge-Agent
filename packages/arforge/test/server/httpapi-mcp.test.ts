import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { AppRuntime } from "../../src/effect/app-runtime"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Server } from "../../src/server/server"
import { Plugin } from "../../src/plugin"
import { mcpCallViaGateway } from "../../src/mcp/gateway-adapter"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)

function app() {
  return Server.Default().app
}
type TestApp = ReturnType<typeof app>
type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  directory: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers)
  headers.set("x-arforge-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(
      handler.handler(
        new Request(`http://localhost${route}`, {
          ...init,
          headers,
        }),
        context,
      ),
    ),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const readResponse = Effect.fnUntraced(function* (input: { app: TestApp; path: string; headers: HeadersInit }) {
  const response = yield* Effect.promise(() =>
    Promise.resolve(input.app.request(input.path, { method: "POST", headers: input.headers })),
  )
  return {
    status: response.status,
    body: yield* Effect.promise(() => response.text()),
  }
})

describe("mcp HttpApi", () => {
  it.instance(
    "serves status endpoint",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const response = yield* request(handler, McpPaths.status, tmp.directory)

        expect(response.status).toBe(200)
        expect(yield* json(response)).toEqual({ demo: { status: "disabled" } })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves the unified MCP list and resource catalog used by the desktop client",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()

        const listResponse = yield* request(handler, "/api/mcp", tmp.directory)
        expect(listResponse.status).toBe(200)
        expect(yield* json(listResponse)).toMatchObject({
          location: { directory: tmp.directory },
          data: [{ name: "demo", status: { status: "disabled" } }],
        })

        const resourceResponse = yield* request(handler, "/api/mcp/resource", tmp.directory)
        expect(resourceResponse.status).toBe(200)
        expect(yield* json(resourceResponse)).toMatchObject({
          location: { directory: tmp.directory },
          data: { resources: [], templates: [] },
        })

        const capabilitiesResponse = yield* request(handler, "/api/mcp/capabilities", tmp.directory)
        expect(capabilitiesResponse.status).toBe(200)
        expect(yield* json(capabilitiesResponse)).toMatchObject({
          location: { directory: tmp.directory },
          data: [],
        })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "records an explicitly confirmed fresh MCP reconciliation without replaying transport",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const seeded = (yield* Effect.promise(() =>
          AppRuntime.runPromise(
            Effect.scoped(
              Effect.provide(
                Effect.gen(function* () {
                  const locations = yield* LocationServiceMap.Service
                  const locationContext = yield* locations.contextEffect(
                    Location.Ref.make({ directory: AbsolutePath.make(tmp.directory) }),
                  )
                  const database = yield* Database.Service
                  const authorizerLayer = Layer.succeed(
                    Authorizer.Service,
                    Authorizer.Service.of({
                      assert: () => Effect.void,
                      reply: () => Effect.void,
                      get: () => Effect.succeed(undefined),
                      list: () => Effect.succeed([]),
                    }),
                  )
                  const secretLayer = Layer.succeed(
                    SecretProvider.Service,
                    SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(17), "http-mcp-reconciliation-test"),
                  )
                  const pluginLayer = Layer.succeed(
                    Plugin.Service,
                    Plugin.Service.of({
                      init: () => Effect.void,
                      trigger: ((_name: unknown, _input: unknown, output: unknown) =>
                        Effect.succeed(output)) as Plugin.Interface["trigger"],
                      list: () => Effect.succeed([]),
                    }),
                  )
                  const runtimeLayer = AppNodeBuilder.build(
                    LayerNode.group([
                      Database.node,
                      EventV2.node,
                      DurableAction.node,
                      DurableRun.node,
                      ActionGateway.node,
                    ]),
                    [
                      [Database.node, Layer.succeed(Database.Service, database)],
                      [Authorizer.node, authorizerLayer],
                      [SecretProvider.node, secretLayer],
                    ],
                  ).pipe(Layer.merge(pluginLayer))
                  return yield* Effect.provide(
                    Effect.gen(function* () {
                      const gateway = yield* ActionGateway.Service
                      const actions = yield* DurableAction.Service
                      const plugin = yield* Plugin.Service
                      const parentContext = {
                        sessionID: SessionSchema.ID.create(),
                        assistantMessageID: SessionMessage.ID.create(),
                        toolCallID: "call-http-mcp-parent",
                      }
                      const parent = {
                        ...parentContext,
                        actionID: ActionGateway.stableActionID(parentContext),
                        agent: AgentV2.ID.make("build"),
                        name: "http-mcp-parent",
                        resources: ["http_mcp_call"],
                        semantics: AgentRuntime.EffectSemantics.make({
                          riskTier: "L2",
                          authority: "scoped_grant",
                          idempotency: "idempotent",
                          retryability: "safe",
                          reversibility: "not_applicable",
                          filesystemScope: [],
                          networkScope: [],
                          secretScope: [],
                          externalServices: [],
                          expectedArtifacts: [],
                          successCriteria: ["parent is ready"],
                        }),
                        reasonSummary: "HTTP MCP reconciliation fixture parent",
                        inputDigest: "http-mcp-parent-input",
                      } as const
                      yield* gateway.execute(parent, {
                        authorization: { requests: [{ action: "http_mcp_call", resources: ["*"] }] },
                        execute: () => Effect.succeed("parent-ready"),
                      })

                      const args = { operation: "publish", value: "http-fixture" }
                      const invocation = "http/1"
                      const argsDigest = canonicalHash(args)
                      if (!argsDigest) throw new Error("HTTP MCP fixture arguments were not canonicalizable")
                      const childActionID = ActionGateway.stableChildActionID({
                        parentActionID: parent.actionID,
                        server: "http-mcp",
                        tool: "publish",
                        argsDigest,
                        invocation,
                      })
                      let transportCalls = 0
                      const failed = yield* mcpCallViaGateway({
                        gateway,
                        plugin,
                        ...parentContext,
                        agent: parent.agent,
                        invocation,
                        parentActionID: parent.actionID,
                        server: "http-mcp",
                        key: "http_mcp_publish",
                        toolName: "publish",
                        client: {
                          callTool: async () => {
                            transportCalls += 1
                            throw new Error("simulated HTTP MCP disconnect after dispatch")
                          },
                        } as never,
                        args,
                        abort: new AbortController().signal,
                        declaredScopes: {
                          endpoint: "https://http-mcp.example.test",
                          networkScope: ["https://http-mcp.example.test"],
                          secretScope: ["HTTP_MCP_TOKEN"],
                          externalServices: ["http-mcp"],
                        },
                      }).pipe(Effect.exit)
                      if (failed._tag === "Success")
                        throw new Error("HTTP MCP fixture transport unexpectedly succeeded")
                      const snapshot = yield* actions.load(childActionID)
                      if (!snapshot.action.intentDigest) throw new Error("HTTP MCP child action has no intent digest")
                      return {
                        childActionID,
                        intentDigest: snapshot.action.intentDigest,
                        idempotencyKey: snapshot.action.idempotencyKey,
                        transportCalls: () => transportCalls,
                      }
                    }).pipe(Effect.provide(runtimeLayer)),
                    locationContext,
                  )
                }),
                HttpApiApp.locationServiceMapV2,
              ),
            ) as never,
          ),
        )) as {
          readonly childActionID: string
          readonly intentDigest: string
          readonly idempotencyKey: string
          readonly transportCalls: () => number
        }
        const handler = HttpApiApp.webHandler()
        const query = `intentDigest=${seeded.intentDigest}&idempotencyKey=${encodeURIComponent(seeded.idempotencyKey)}`
        const inspectedResponse = yield* request(
          handler,
          `/api/mcp/actions/${seeded.childActionID}/reconciliation?${query}`,
          tmp.directory,
        )
        expect(inspectedResponse.status).toBe(200)
        const inspected = (yield* json(inspectedResponse)) as {
          readonly data: { readonly evidence: { readonly evidenceDigest: string } }
        }
        const evidenceDigest = inspected.data.evidence.evidenceDigest
        expect(evidenceDigest).toMatch(/^[a-f0-9]{64}$/)

        const stale = yield* request(
          handler,
          `/api/mcp/actions/${seeded.childActionID}/reconciliation/record?${query}`,
          tmp.directory,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedEvidenceDigest: "f".repeat(64), approval: "record_evidence" }),
          },
        )
        expect(stale.status).toBe(400)

        const recorded = yield* request(
          handler,
          `/api/mcp/actions/${seeded.childActionID}/reconciliation/record?${query}`,
          tmp.directory,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedEvidenceDigest: evidenceDigest, approval: "record_evidence" }),
          },
        )
        expect(recorded.status).toBe(200)
        expect(yield* json(recorded)).toMatchObject({
          data: {
            actionID: seeded.childActionID,
            kind: "manual_review",
            state: "unknown",
            automaticRetryAllowed: false,
            evidence: { evidenceDigest },
          },
        })
        const duplicate = yield* request(
          handler,
          `/api/mcp/actions/${seeded.childActionID}/reconciliation/record?${query}`,
          tmp.directory,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedEvidenceDigest: evidenceDigest, approval: "record_evidence" }),
          },
        )
        expect(duplicate.status).toBe(200)
        expect(yield* json(duplicate)).toMatchObject({
          data: {
            actionID: seeded.childActionID,
            state: "unknown",
            evidence: { evidenceDigest },
          },
        })
        expect(seeded.transportCalls()).toBe(1)
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves identity-bound read-only MCP reconciliation without contacting transport",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const intentDigest = "a".repeat(64)
        const response = yield* request(
          handler,
          `/api/mcp/actions/act_missing/reconciliation?intentDigest=${intentDigest}&idempotencyKey=idem_mcp_missing`,
          tmp.directory,
        )
        expect(response.status).toBe(200)
        const body = yield* json(response)
        expect(body).toMatchObject({
          location: { directory: tmp.directory },
          data: {
            actionID: "act_missing",
            kind: "manual_review",
            state: "unknown",
            automaticRetryAllowed: false,
            evidence: { state: "unknown", source: "mcp-durable-action" },
          },
        })
        expect(JSON.stringify(body)).not.toContain("secret")
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves add, connect, and disconnect endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const added = yield* request(handler, McpPaths.status, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "added",
            config: {
              type: "local",
              command: ["echo", "added"],
              enabled: false,
            },
          }),
        })
        expect(added.status).toBe(200)
        expect(yield* json(added)).toMatchObject({ added: { status: "disabled" } })

        const addedDisconnected = yield* request(handler, "/mcp/added/disconnect", tmp.directory, { method: "POST" })
        expect(addedDisconnected.status).toBe(200)
        expect(yield* json(addedDisconnected)).toBe(true)

        const connected = yield* request(handler, "/mcp/demo/connect", tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)
        expect(yield* json(connected)).toBe(true)

        const disconnected = yield* request(handler, "/mcp/demo/disconnect", tmp.directory, { method: "POST" })
        expect(disconnected.status).toBe(200)
        expect(yield* json(disconnected)).toBe(true)
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves deterministic OAuth endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const start = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "POST" })
        expect(start.status).toBe(400)

        const authenticate = yield* request(handler, "/mcp/demo/auth/authenticate", tmp.directory, { method: "POST" })
        expect(authenticate.status).toBe(400)

        const removed = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toEqual({ success: true })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns unsupported OAuth error responses",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const dir = tmp.directory
        const headers = { "x-arforge-directory": dir }

        yield* Effect.forEach(["/mcp/demo/auth", "/mcp/demo/auth/authenticate"], (path) =>
          Effect.gen(function* () {
            const response = yield* readResponse({ app: app(), path, headers })

            expect(response).toEqual({
              status: 400,
              body: JSON.stringify({ error: "MCP server demo does not support OAuth" }),
            })
          }),
        )
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns typed not found errors for missing MCP servers",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()

        for (const input of [
          { method: "POST", route: "/mcp/missing/auth" },
          { method: "POST", route: "/mcp/missing/auth/authenticate" },
          {
            method: "POST",
            route: "/mcp/missing/auth/callback",
            body: JSON.stringify({ code: "code", oauthState: "state" }),
          },
          { method: "DELETE", route: "/mcp/missing/auth" },
          { method: "POST", route: "/mcp/missing/connect" },
          { method: "POST", route: "/mcp/missing/disconnect" },
        ]) {
          const response = yield* request(handler, input.route, tmp.directory, {
            method: input.method,
            headers: input.body ? { "content-type": "application/json" } : undefined,
            body: input.body,
          })

          expect(response.status).toBe(404)
          expect(yield* json(response)).toEqual({
            _tag: "McpServerNotFoundError",
            name: "missing",
            message: "MCP server not found: missing",
          })
        }
      }),
    { config: { mcp: {} } },
  )
})
