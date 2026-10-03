import { writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { Config } from "@arforge-ai/core/config"
import { ConfigToolOutput } from "@arforge-ai/core/config/tool-output"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { Location } from "@arforge-ai/core/location"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { Tools } from "@arforge-ai/core/tool/tools"
import { Tool } from "@arforge-ai/core/tool/tool"
import { TurnToolCarrier } from "@arforge-ai/core/tool/turn-carrier"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { adaptExternalTool, makeLegacySessionTools, makeScheduledTaskTool } from "../../src/tool/core-bridge"
import { Parameters as TaskParameters } from "../../src/tool/task"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool as MatureTool } from "../../src/tool/tool"
import type { Plugin } from "../../src/plugin"

const [databasePath, mode, markerPath, size = "small", carrierKind = "external"] = Bun.argv.slice(2)
if (
  !databasePath ||
  !markerPath ||
  !["started", "completed", "historical", "read"].includes(mode ?? "") ||
  !["external", "legacy", "native-task"].includes(carrierKind)
)
  throw new Error("tool postprocessing fixture requires database, valid phase, marker and carrier")
const directory = AbsolutePath.make(dirname(databasePath))
const originalText = size === "original" || size === "both" ? "原".repeat(400_000) : "original result"
const displayText = size === "display" || size === "both" ? "展".repeat(400_000) : "display result"
const layer = AppNodeBuilder.build(
  LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, DurableAction.node, ToolOutputStore.node]),
  [
    [Database.node, Database.layerFromPath(databasePath)],
    [
      Config.node,
      Layer.mock(Config.Service, {
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: new Config.Info({
                tool_output: new ConfigToolOutput.Info({ max_lines: 10, max_bytes: 512 }),
              }),
            }),
          ]),
      }),
    ],
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of({ directory, project: { id: Project.ID.global, directory } }),
      ),
    ],
  ],
)

const program = Effect.gen(function* () {
  const actions = yield* DurableAction.Service
  const store = yield* ToolOutputStore.Service
  const request = {
    sessionID: SessionSchema.ID.make("ses_native_post_cold"),
    assistantMessageID: SessionMessage.ID.make("msg_native_post_cold"),
    agent: AgentV2.ID.make("build"),
    call: {
      type: "tool-call" as const,
      id: "call_native_post_cold",
      name: carrierKind === "external" ? "native_post_cold" : carrierKind === "legacy" ? "read" : "task",
      input:
        carrierKind === "external"
          ? {}
          : carrierKind === "legacy"
            ? { filePath: "fixture.txt" }
            : { prompt: "inspect", description: "inspect", subagent_type: "general" },
    },
  }
  const actionID = ActionGateway.stableActionID({ ...request, toolCallID: request.call.id })
  let executions = 0
  let hooks = 0
  const mark = (result?: unknown) =>
    Effect.gen(function* () {
      const snapshot = yield* actions.load(actionID)
      if (
        snapshot.action.status !== "settled" ||
        snapshot.observation?.status !== "succeeded" ||
        snapshot.activeAttempt
      )
        throw new Error("native postprocessing fixture did not retain durable success")
      const decode = (output: NonNullable<typeof snapshot.observation>["output"]) =>
        Effect.gen(function* () {
          if (output?.encoding !== "artifact") return output?.value
          const retained = yield* store.read({
            reference: output.value,
            owner: DurableAction.outputOwner(snapshot.action),
          })
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained.bytes))
        })
      const original = yield* decode(snapshot.observation.output)
      const projected = yield* decode(snapshot.postProcessing?.output)
      writeFileSync(
        markerPath,
        JSON.stringify({
          actionID,
          executions,
          hooks,
          sequence: snapshot.lastSequence,
          state: snapshot.postProcessing?.state,
          original,
          projected,
          originalEncoding: snapshot.observation.output?.encoding,
          projectedEncoding: snapshot.postProcessing?.output?.encoding,
          catalogSequence: (yield* store.listCatalog()).headSequence,
          ...(result === undefined ? {} : { result }),
        }),
        "utf8",
      )
      if (mode !== "read") {
        if (!process.send) throw new Error("native postprocessing seed requires parent IPC")
        process.send({ type: "native-post-ready" })
        yield* Effect.never
      }
    })
  const plugin = {
    trigger: ((name: string, _input: unknown, output: { title: string; output: string; metadata: unknown }) =>
      Effect.gen(function* () {
        if (name !== "tool.execute.after") return output
        hooks++
        if (mode === "started") yield* mark()
        output.title = "display title"
        output.output = displayText
        output.metadata = { transformed: true }
        return output
      })) as Plugin.Interface["trigger"],
  } as Plugin.Interface
  const execute = () =>
    Effect.sync(() => {
      executions++
      return {
        title: "original title",
        output: originalText,
        metadata: {
          original: true,
          parentSessionId: SessionID.make(String(request.sessionID)),
          sessionId: SessionID.make("ses_post_child"),
          model: { modelID: "test", providerID: "test" },
          reasoningLevel: "default" as const,
        },
      }
    })
  const parameters = carrierKind === "native-task" ? TaskParameters : Schema.Record(Schema.String, Schema.Unknown)
  const definition: MatureTool.Def = {
    id: request.call.name,
    description: "Native cold postprocessing fixture",
    parameters,
    execute,
  }
  const dependencies = { plugin, directory: String(directory), worktree: String(directory) }
  const common = {
    messages: [],
    sandboxProfile: SandboxPolicy.DefaultProfile,
    promptOps: {} as never,
    metadata: () => Effect.void,
  }
  let options: ToolRegistry.MaterializeOptions =
    carrierKind === "legacy"
      ? {
          legacySessionTools: makeLegacySessionTools([definition], dependencies, {
            ...common,
            workspace: String(directory),
            extra: {},
          }),
        }
      : carrierKind === "native-task"
        ? {
            scheduledTaskTool: makeScheduledTaskTool(
              { parameters: TaskParameters, description: definition.description, jsonSchema: undefined, execute },
              definition.description,
              dependencies,
              { ...common, route: () => ({ modelID: "test", providerID: "test" }) },
            ),
          }
        : {}
  let adapted = options.legacySessionTools
    ? TurnToolCarrier.legacySessionToolEntries(options.legacySessionTools)[0]!.tool
    : (options.scheduledTaskTool ??
      adaptExternalTool({ ...definition, origin: { kind: "plugin", permission: request.call.name } }, dependencies))
  if (mode === "historical") {
    // Test-only snapshot of the pre-projection wire contract. Seed through the
    // original Registry/Gateway, not by editing durable history or invoking a
    // leaf behind the Gateway. The reader always uses the real upgraded factory.
    const semantics = yield* Tool.effects(adapted, request.call)
    adapted = Tool.withPermission(
      Tool.make({
        description: definition.description,
        input: parameters,
        output: Schema.Unknown,
        structured: Schema.Unknown,
        effects: semantics,
        execute,
        toStructuredOutput: ({ output }) => output,
        toModelOutput: ({ output }) => [{ type: "text", text: (output as MatureTool.ExecuteResult).output }],
      }),
      Tool.permission(adapted, request.call.name),
    )
    if (options.legacySessionTools)
      options = {
        ...options,
        legacySessionTools: TurnToolCarrier.LegacySessionTools.make(
          TurnToolCarrier.legacySessionToolEntries(options.legacySessionTools).map((entry) => ({
            ...entry,
            tool: adapted,
          })),
        ),
      }
    else if (options.scheduledTaskTool) options = { ...options, scheduledTaskTool: adapted }
  }
  if (carrierKind === "external") yield* (yield* Tools.Service).register({ [request.call.name]: adapted })
  const materialized = yield* (yield* ToolRegistry.Service).materialize([], request.sessionID, {
    ...options,
    includeRegistered: carrierKind === "external",
  })
  const result = yield* materialized.settle(request)
  yield* mark(result)
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
