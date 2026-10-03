import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { SessionV2 } from "@arforge-ai/core/session"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { DeferredTools } from "@arforge-ai/core/tool/deferred"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { Tool } from "@arforge-ai/core/tool/tool"
import { Tools } from "@arforge-ai/core/tool/tools"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { ToolSearchTool } from "@arforge-ai/core/tool/search"
import { Config } from "@arforge-ai/core/config"
import { ConfigExperimental } from "@arforge-ai/core/config/experimental"
import { testEffect } from "./lib/effect"
import { location } from "./fixture/location"

const boundLocation = Layer.succeed(
  Location.Service,
  Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }))),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([DeferredTools.node, ToolRegistry.node, ToolRegistry.toolsNode, ToolRegistry.builtInsNode]),
    [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Location.node, boundLocation],
    ],
  ),
)
const deferredConfig = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ experimental: new ConfigExperimental.Experimental({ deferred_tools: true }) }),
        }),
      ]),
  }),
)
const toolSearchIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      DeferredTools.node,
      DeferredTools.configNode,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      ToolRegistry.builtInsNode,
      ToolSearchTool.node,
    ]),
    [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Location.node, boundLocation],
      [Config.node, deferredConfig],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_deferred_tools_test")
const otherSessionID = SessionV2.ID.make("ses_deferred_tools_other")

const tool = (description: string) =>
  Tool.make({
    description,
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ ok: true }),
  })

describe("DeferredTools", () => {
  toolSearchIt.effect("registers tool_search when the configuration flag is enabled", () =>
    Effect.gen(function* () {
      const deferred = yield* DeferredTools.Service
      const registry = yield* ToolRegistry.Service
      expect(deferred.enabled()).toBeTrue()
      expect((yield* registry.materialize([], sessionID)).definitions.map((item) => item.name)).toContain("tool_search")
    }),
  )

  it.effect("activates ranked heavy tools only for the current run and session", () =>
    Effect.gen(function* () {
      const deferred = yield* DeferredTools.Service
      const registry = yield* ToolRegistry.Service
      const tools = yield* Tools.BuiltIns
      yield* deferred.configure(true)
      yield* tools.register({
        read: tool("Read a local file"),
        webfetch: tool("Fetch content from an internet URL"),
        websearch: tool("Search the internet"),
      })

      yield* deferred.withinRun(
        sessionID,
        Effect.gen(function* () {
          expect((yield* registry.materialize([], sessionID)).definitions.map((item) => item.name)).toEqual(["read"])
          const discovered = yield* registry.discover({ sessionID, query: "+internet fetch", limit: 1 })
          expect(discovered).toMatchObject({
            tools: [
              {
                name: "webfetch",
                description: "Fetch content from an internet URL",
                inputSchema: expect.any(Object),
                outputSchema: { properties: { ok: { type: "boolean" } } },
              },
            ],
            activated: ["webfetch"],
          })
          expect((yield* registry.materialize([], sessionID)).definitions.map((item) => item.name)).toEqual([
            "read",
            "webfetch",
          ])
          expect((yield* registry.materialize([], otherSessionID)).definitions.map((item) => item.name)).toEqual([
            "read",
          ])
        }),
      )

      expect((yield* registry.materialize([], sessionID)).definitions.map((item) => item.name)).toEqual(["read"])
    }),
  )

  it.effect("does not reveal or activate a tool denied by the active agent rules", () =>
    Effect.gen(function* () {
      const deferred = yield* DeferredTools.Service
      const registry = yield* ToolRegistry.Service
      const tools = yield* Tools.BuiltIns
      yield* deferred.configure(true)
      yield* tools.register({
        read: tool("Read a local file"),
        webfetch: tool("Fetch content from an internet URL"),
      })
      yield* registry.materialize([{ action: "webfetch", resource: "*", effect: "deny" }], sessionID)

      expect(yield* registry.discover({ sessionID, query: "web", limit: 5 })).toEqual({ tools: [], activated: [] })
      expect(yield* Effect.flip(registry.discover({ sessionID, query: "select:webfetch", limit: 5 }))).toMatchObject({
        _tag: "ToolRegistry.DiscoverError",
        message: "One or more selected tools are unavailable",
      })
    }),
  )
})
