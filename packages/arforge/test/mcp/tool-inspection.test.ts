import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListPromptsRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { ConfigV1 } from "@arforge-ai/core/v1/config/config"
import { Mcp as McpSchema } from "@arforge-ai/schema/mcp"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { InstanceState } from "../../src/effect/instance-state"
import { disposeInstanceEffect } from "../../src/effect/instance-registry"
import { Database } from "@arforge-ai/core/database/database"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

class InspectionConfig extends Context.Service<
  InspectionConfig,
  {
    value: ConfigV1.Info
    beforeRead?: () => Effect.Effect<void>
  }
>()("test/InspectionConfig") {}

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([MCP.node, LocationServiceMap.node, Config.node]), [
    [
      Config.node,
      Layer.effect(
        Config.Service,
        Effect.gen(function* () {
          const source = yield* InspectionConfig
          return TestConfig.make({
            get: () =>
              Effect.gen(function* () {
                yield* source.beforeRead?.() ?? Effect.void
                return source.value
              }),
          })
        }),
      ),
    ],
  ]).pipe(Layer.provideMerge(Layer.sync(InspectionConfig, () => ({ value: {} })))),
)

const advertised: Tool = {
  name: "read.full",
  title: "Read the complete record",
  description: "Full advertised description\nincluding another line.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string", description: "Record key", default: "example" } },
    required: ["key"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
  annotations: { title: "Read only", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { "fixture/nested": { list: ["preserved", 7, true, null] } },
}

function fixture() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state = { definitions: [structuredClone(advertised)], requests: [] as string[] }
      const makeProtocol = async () => {
        const protocol = new Server(
          { name: "tool-inspection", version: "1" },
          { capabilities: { tools: {}, prompts: {} } },
        )
        protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.definitions }))
        protocol.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "inspection-prompt" }] }))
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        })
        await protocol.connect(transport)
        return { protocol, transport }
      }
      let current = await makeProtocol()
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          if (request.method === "POST") {
            const body = await request.clone().json()
            state.requests.push(body.method)
          }
          return current.transport.handleRequest(request)
        },
      })
      return {
        state,
        url: http.url.toString(),
        restart: async () => {
          current = await makeProtocol()
        },
        close: async () => {
          await current.protocol.close()
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

const connected = Effect.fnUntraced(function* () {
  const server = yield* fixture()
  const source = yield* InspectionConfig
  source.value = { mcp: { inspection: { type: "remote", url: server.url, oauth: false } } }
  const mcp = yield* MCP.Service
  yield* mcp.clients()
  const capability = (yield* mcp.capabilities!()).find((item) => item.kind === "tool")!
  expect(capability).toBeDefined()
  return {
    server,
    source,
    mcp,
    input: { server: capability.server, capabilityID: capability.id, generation: capability.generation },
  }
})

const retireOwnedInstance = Effect.gen(function* () {
  // The fixture's database is provided by its private layer, not a public
  // test-body requirement. Never widen disposal to other database owners.
  const owner = yield* Effect.serviceOption(Database.Service)
  if (Option.isNone(owner)) throw new Error("Owned inspection fixture database is unavailable")
  yield* disposeInstanceEffect(yield* InstanceState.directory, owner.value)
})

it.instance("cached inspection does not initialize an enabled cold MCP connection", () =>
  Effect.gen(function* () {
    const server = yield* fixture()
    const source = yield* InspectionConfig
    source.value = { mcp: { inspection: { type: "remote", url: server.url, oauth: false } } }
    const mcp = yield* MCP.Service
    expect(
      yield* mcp.describeTool!({ server: "inspection", capabilityID: "inspection_read_full", generation: 1 }),
    ).toBeUndefined()
    expect(server.state.requests).toEqual([])
  }),
)

it.instance("cached inspection does not recreate a retired MCP connection", () =>
  Effect.gen(function* () {
    const { server, mcp, input } = yield* connected()
    yield* retireOwnedInstance
    const before = [...server.state.requests]
    expect(yield* mcp.describeTool!(input)).toBeUndefined()
    expect(server.state.requests).toEqual(before)
  }),
)

it.instance("cached inspection does not recreate an instance retired while config validation is pending", () =>
  Effect.gen(function* () {
    const { server, source, mcp, input } = yield* connected()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let reads = 0
    source.beforeRead = () =>
      ++reads === 1 ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void
    const pending = yield* mcp.describeTool!(input).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    source.beforeRead = undefined
    yield* retireOwnedInstance
    const before = [...server.state.requests]
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(pending)).toBeUndefined()
    expect(server.state.requests).toEqual(before)
  }),
)

it.instance("inspects exactly one cached full definition without transport and returns an independent JSON copy", () =>
  Effect.gen(function* () {
    const { server, mcp, input } = yield* connected()
    expect(mcp.describeTool).toBeDefined()
    // Discovery owns SDK normalization. Any extra JSON field already present
    // in its cache must also survive this inspection boundary unchanged.
    const cached = (yield* mcp.tools())[input.capabilityID]!.def
    Reflect.set(cached, "fixture/extra", { retained: true })
    const expected = Schema.decodeUnknownSync(McpSchema.ToolDetails.fields.definition)({
      ...advertised,
      "fixture/extra": { retained: true },
    })
    const before = [...server.state.requests]
    const details = yield* mcp.describeTool!(input)
    expect(details).toBeDefined()
    expect(details!.definition).toEqual(expected)
    expect(Schema.is(McpSchema.ToolDetails)(details)).toBe(true)
    expect(details!.capability).toMatchObject({
      id: input.capabilityID,
      server: input.server,
      generation: input.generation,
      kind: "tool",
    })
    // Mutating any depth of the response must leave both caches untouched.
    Reflect.set(details!.definition, "description", "changed")
    const meta = details!.definition._meta
    if (!Schema.is(Schema.Record(Schema.String, Schema.Json))(meta)) throw new Error("missing metadata")
    const nested = meta["fixture/nested"]
    if (!Schema.is(Schema.Record(Schema.String, Schema.Json))(nested) || !Array.isArray(nested.list))
      throw new Error("missing nested list")
    Reflect.set(nested.list, "0", "changed")
    Reflect.set(details!.capability.patterns, "0", "changed")
    expect((yield* mcp.describeTool!(input))!.definition).toEqual(expected)
    expect((yield* mcp.capabilities!())[0]!.patterns).toEqual(["*"])
    expect(server.state.requests).toEqual(before)
    const catalog = yield* mcp.capabilities!()
    expect(JSON.stringify(catalog)).not.toContain("inputSchema")
    expect(JSON.stringify(details)).not.toContain(server.url)
  }),
)

it.instance("rejects unknown identities, disconnected clients and a capability retained across reconnect", () =>
  Effect.gen(function* () {
    const { server, mcp, input } = yield* connected()
    yield* mcp.prompts()
    const prompt = (yield* mcp.capabilities!()).find((item) => item.kind === "prompt")!
    const before = [...server.state.requests]
    for (const query of [
      { ...input, capabilityID: "unknown" },
      { ...input, server: "unknown" },
      { ...input, server: input.server + " " },
      { ...input, capabilityID: input.capabilityID + " " },
      { ...input, generation: input.generation + 1 },
      { ...input, generation: -1 },
      { server: prompt.server, capabilityID: prompt.id, generation: prompt.generation },
    ])
      expect(yield* mcp.describeTool!(query)).toBeUndefined()
    expect(server.state.requests).toEqual(before)
    yield* mcp.disconnect(input.server)
    expect(yield* mcp.describeTool!(input)).toBeUndefined()
    yield* Effect.promise(server.restart)
    yield* mcp.connect(input.server)
    const replacement = (yield* mcp.capabilities!())[0]!
    expect(replacement.generation).toBeGreaterThan(input.generation)
    const afterReconnect = [...server.state.requests]
    expect(yield* mcp.describeTool!(input)).toBeUndefined()
    expect(yield* mcp.describeTool!({ ...input, generation: replacement.generation })).toBeDefined()
    expect(server.state.requests).toEqual(afterReconnect)
  }),
)

it.instance("rejects removed, disabled and drifted configuration while the cached client remains alive", () =>
  Effect.gen(function* () {
    const { server, source, mcp, input } = yield* connected()
    const original = source.value
    const config = original.mcp!.inspection!
    const before = [...server.state.requests]
    for (const value of [
      {},
      { mcp: { inspection: { ...config, enabled: false } } },
      { mcp: { inspection: { ...config, url: server.url + "changed" } } },
      { mcp: { inspection: { ...config, headers: { "x-fixture": "changed" } } } },
    ]) {
      source.value = value
      expect(yield* mcp.describeTool!(input)).toBeUndefined()
    }
    source.value = original
    expect(yield* mcp.describeTool!(input)).toBeDefined()
    expect(server.state.requests).toEqual(before)
  }),
)

it.instance("revalidates after a suspended config read before copying cached details", () =>
  Effect.gen(function* () {
    const { server, source, mcp, input } = yield* connected()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let reads = 0
    source.beforeRead = () =>
      ++reads === 3 ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void
    const before = [...server.state.requests]
    const pending = yield* mcp.describeTool!(input).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    source.value = {}
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(pending)).toBeUndefined()
    expect(server.state.requests).toEqual(before)
  }),
)

it.instance("fails closed when a cached definition contains a non-JSON value", () =>
  Effect.gen(function* () {
    const { server, mcp, input } = yield* connected()
    const cached = (yield* mcp.tools())[input.capabilityID]!.def
    Reflect.set(cached, "fixture/invalid", Number.NaN)
    const before = [...server.state.requests]
    expect(yield* mcp.describeTool!(input)).toBeUndefined()
    expect(server.state.requests).toEqual(before)
  }),
)

it.instance("rejects a replaced client after scope resolution suspends", () =>
  Effect.gen(function* () {
    const { server, source, mcp, input } = yield* connected()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let reads = 0
    source.beforeRead = () =>
      ++reads === 3 ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void
    const pending = yield* mcp.describeTool!(input).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    source.beforeRead = undefined
    yield* mcp.disconnect(input.server)
    yield* Effect.promise(server.restart)
    yield* mcp.connect(input.server)
    const before = [...server.state.requests]
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(pending)).toBeUndefined()
    expect(server.state.requests).toEqual(before)
  }),
)
