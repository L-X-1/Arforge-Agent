import { afterAll, describe, expect } from "bun:test"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap, buildLocationServiceMap } from "@arforge-ai/core/location-services"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { Effect, Exit, Layer } from "effect"
import * as nodeFs from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { InstanceRef } from "@/effect/instance-ref"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { Tool as MatureTool } from "@/tool/tool"
import { WriteTool } from "@/tool/write"
import { makeLegacySessionTools } from "@/tool/core-bridge"
import type { Plugin } from "@/plugin"
import { testEffect } from "../lib/effect"

const workspace = nodeFs.mkdtempSync(path.join(os.tmpdir(), "arforge-core-bridge-write-"))
const artifactRoot = nodeFs.mkdtempSync(path.join(os.tmpdir(), "arforge-core-bridge-artifacts-"))

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
  await fs.rm(artifactRoot, { recursive: true, force: true })
})

const location = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make(workspace),
    project: { id: Project.ID.global, directory: AbsolutePath.make(workspace) },
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

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const format = Layer.succeed(
  Format.Service,
  Format.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    file: () => Effect.succeed(false),
  }),
)

const truncate = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.die("unused"),
    output: (content) => Effect.succeed({ content, truncated: false }),
    limits: () => Effect.succeed({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }),
  }),
)

const agent = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "primary",
        options: {},
        permission: [],
      } as Agent.Info),
    list: () => Effect.succeed([]),
    defaultInfo: () =>
      Effect.succeed({ name: "build", mode: "primary", options: {}, permission: [] } as Agent.Info),
    defaultAgent: () => Effect.succeed("build"),
    generate: () => Effect.die("unused"),
  }),
)

const locationMap = buildLocationServiceMap([
  [RollbackArtifact.node, RollbackArtifact.layerWith(artifactRoot)],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])

const runtime = AppNodeBuilder.build(
  LayerNode.group([
    CoreToolRegistry.node,
    CoreToolRegistry.toolsNode,
    ActionGateway.node,
    DurableAction.node,
    FSUtil.node,
    EventV2Bridge.node,
    LocationServiceMap.node,
    LSP.node,
    Format.node,
    Truncate.node,
    Agent.node,
    RollbackArtifact.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [Location.node, location],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [RollbackArtifact.node, RollbackArtifact.layerWith(artifactRoot)],
    [LocationServiceMap.node, locationMap],
    [LSP.node, lsp],
    [Format.node, format],
    [Truncate.node, truncate],
    [Agent.node, agent],
  ],
)

const it = testEffect(runtime)

describe("mature write through the Core ActionGateway", () => {
  it.effect("persists a real mutation intent and artifact through the bridge", () =>
    Effect.gen(function* () {
      const filepath = path.join(workspace, "bridge-report.xlsx")
      const before = Buffer.from(JSON.stringify([["状态", "旧版本"]]))
      yield* Effect.promise(() => fs.writeFile(filepath, before))

      const plugin = {
        trigger: ((_name: string, _input: unknown, output: unknown) =>
          Effect.succeed(output)) as Plugin.Interface["trigger"],
      } as Plugin.Interface
      const write = yield* MatureTool.init(yield* WriteTool)
      const carrier = makeLegacySessionTools(
        [write],
        { plugin, directory: workspace, worktree: workspace },
        {
          messages: [],
          sandboxProfile: SandboxPolicy.DefaultProfile,
          extra: {},
          workspace,
          metadata: () => Effect.void,
        },
      )
      const sessionID = SessionSchema.ID.make("ses_bridge_write")
      const assistantMessageID = SessionMessage.ID.make("msg_bridge_write")
      const toolCallID = "call_bridge_write"
      const registry = yield* CoreToolRegistry.Service
      const materialized = yield* registry.materialize([], sessionID, {
        includeRegistered: false,
        legacySessionTools: carrier,
      })
      const target = {
        type: "tool-call" as const,
        id: toolCallID,
        name: "write",
        input: {
          filePath: filepath,
          content: JSON.stringify([
            ["状态", "新版本"],
            ["金额", 128],
          ]),
        },
      }
      const settlementExit = yield* materialized
        .settle({
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID,
          call: target,
        })
        .pipe(Effect.exit)
      if (Exit.isFailure(settlementExit)) {
        return yield* Effect.failCause(settlementExit.cause)
      }
      const settlement = settlementExit.value
      const actionID = ActionGateway.stableActionID({ sessionID, assistantMessageID, toolCallID })

      expect(settlement.result.type).toBe("text")
      expect(settlement.output?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Wrote file") })
      expect(yield* Effect.promise(() => fs.readFile(filepath))).not.toEqual(before)

      const actions = yield* DurableAction.Service
      const snapshot = yield* actions.load(actionID)
      expect(snapshot.action.status).toBe("settled")
      expect(snapshot.mutationIntent?.phase).toBe("settled")
      const entry = snapshot.mutationIntent?.entries[0]
      expect(entry?.target).toBe("bridge-report.xlsx")
      expect(entry?.rollbackArtifact).toBeDefined()
      if (!entry?.rollbackArtifact) return

      const artifacts = yield* RollbackArtifact.Service
      const stored = yield* Effect.promise(() => artifacts.store.read(entry.rollbackArtifact!))
      expect(Buffer.from(stored.content)).toEqual(before)

      const gateway = yield* ActionGateway.Service
      const recovery = gateway.inspectRecovery ? yield* gateway.inspectRecovery({ actionID }) : undefined
      expect(recovery?.mutationIntent?.phase).toBe("settled")
      expect(recovery?.actionStatus).toBe("settled")
    }).pipe(
      Effect.provideService(InstanceRef, {
        directory: workspace,
        worktree: workspace,
        project: { id: "bridge-write", worktree: workspace },
      } as never),
    ),
  )
})
