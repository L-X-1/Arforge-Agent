import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Location } from "@arforge-ai/core/location"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema as CoreSessionSchema } from "@arforge-ai/core/session/schema"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { ToolCoreBridge } from "@/tool/core-bridge"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let executions = 0
const hooks: string[] = []
const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((name: string, _input: unknown, output: unknown) =>
      Effect.sync(() => {
        hooks.push(name)
        return output
      })) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            bridge_dynamic: {
              description: "Dynamic bridge tool",
              args: { value: z.string().min(1) },
              execute: async ({ value }: { value: string }) => {
                executions += 1
                return value.toUpperCase()
              },
            },
          },
        },
      ]),
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const directory = AbsolutePath.make(import.meta.dir)
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory,
    project: { id: Project.ID.global, directory },
  }),
)

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((value) => [path.join(value, ".arforge")])),
})

const sessionID = CoreSessionSchema.ID.make("ses_core_bridge_service")
const sessionLayer = Layer.succeed(
  Session.Service,
  Session.Service.of({
    get: () =>
      Effect.succeed({
        id: sessionID,
        agent: undefined,
        model: undefined,
        permission: [],
      } as unknown as Session.Info),
  } as unknown as Session.Interface),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolCoreBridge.node, CoreToolRegistry.node, CoreToolRegistry.toolsNode]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    [Plugin.node, pluginLayer],
    [Session.node, sessionLayer],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [PermissionV2.node, permission],
    [Location.node, current],
  ]),
)

afterEach(async () => {
  executions = 0
  hooks.length = 0
  await disposeAllInstances()
})

describe("ToolCoreBridge service", () => {
  it.instance("snapshots real plugin discovery without mutating the shared Core Tools scope", () =>
    Effect.gen(function* () {
      const externalTools = yield* (yield* ToolCoreBridge.Service).snapshot({
        sessionID,
        agent: "build",
        modelID: "test-model",
        providerID: "test",
      })
      const registry = yield* CoreToolRegistry.Service
      expect((yield* registry.materialize()).definitions).toEqual([])
      const materialized = yield* registry.materialize([], sessionID, { externalTools })
      const definition = materialized.definitions.find((item) => item.name === "bridge_dynamic")
      expect(definition?.inputSchema).toMatchObject({
        type: "object",
        properties: { value: { type: "string", minLength: 1 } },
        required: ["value"],
      })
      const settlement = yield* materialized.settle({
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_bridge_service"),
        call: {
          type: "tool-call",
          id: "call_bridge_service",
          name: "bridge_dynamic",
          input: { value: "hello" },
        },
      })
      expect(executions).toBe(1)
      expect(settlement.result).toEqual({ type: "text", value: "HELLO" })
      expect(hooks.filter((name) => name === "tool.execute.before")).toHaveLength(1)
      expect(hooks.filter((name) => name === "tool.execute.after")).toHaveLength(1)

      const invalid = yield* materialized.settle({
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_bridge_service_invalid"),
        call: {
          type: "tool-call",
          id: "call_bridge_service_invalid",
          name: "bridge_dynamic",
          input: { value: "" },
        },
      })
      expect(invalid.result).toMatchObject({ type: "error", value: expect.stringContaining("Invalid tool input") })
      expect(executions).toBe(1)
      expect(hooks.filter((name) => name === "tool.execute.before")).toHaveLength(1)
      expect(hooks.filter((name) => name === "tool.execute.after")).toHaveLength(1)
    }),
  )
})
