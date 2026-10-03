import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Location } from "@arforge-ai/core/location"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionV2 } from "@arforge-ai/core/session"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { Tools as CoreTools } from "@arforge-ai/core/tool/tools"
import { TurnToolCarrier } from "@arforge-ai/core/tool/turn-carrier"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import {
  adaptExternalTool,
  makeLegacySessionTools,
  makeScheduledTaskTool,
  makeUserAttachmentReadCarrier,
  settlementToMatureResult,
  type ScheduledTaskProgress,
} from "@/tool/core-bridge"
import { Tool as MatureTool } from "@/tool/tool"
import type { Plugin } from "@/plugin"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { McpToolProjection } from "@/mcp/tool-projection"
import { MCP } from "@/mcp"
import type { Agent } from "@/agent/agent"
import type { Truncate } from "@/tool/truncate"
import { PluginToolSource } from "@/tool/plugin-source-adapter"
import z from "zod"
import path from "node:path"
import { Parameters as TaskParameters, type TaskExecutionContext, type TaskRuntimeValue } from "@/tool/task"

const permissionAssertions: PermissionV2.AssertInput[] = []
let permissionBlocked = false
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => permissionAssertions.push(input)).pipe(
        Effect.andThen(
          permissionBlocked
            ? Effect.fail(new PermissionV2.BlockedError({ rules: [{ action: "*", resource: "*", effect: "deny" }] }))
            : Effect.void,
        ),
      ),
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

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CoreToolRegistry.node, CoreToolRegistry.toolsNode, DurableAction.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [PermissionV2.node, permission],
    [Location.node, current],
  ]),
)

describe("ToolCoreBridge", () => {
  for (const carrierKind of ["legacy", "native-task"] as const) {
    for (const failure of ["none", "hook", "cancel", "oversized"] as const) {
      it.effect(`${carrierKind} postprocessing ${failure} keeps the original success and never replays effects`, () =>
        Effect.gen(function* () {
          permissionBlocked = false
          const actions = yield* DurableAction.Service
          const registry = yield* CoreToolRegistry.Service
          const sessionID = SessionV2.ID.create()
          const request = {
            sessionID,
            agent: AgentV2.ID.make("build"),
            assistantMessageID: SessionMessage.ID.create(),
            call: {
              type: "tool-call" as const,
              id: "call-post-carrier",
              name: carrierKind === "legacy" ? "read" : "task",
              input:
                carrierKind === "legacy"
                  ? { filePath: "post-test.txt" }
                  : { prompt: "inspect", description: "inspect", subagent_type: "general" },
            },
          }
          const actionID = ActionGateway.stableActionID({ ...request, toolCallID: request.call.id })
          let executions = 0
          let afterHooks = 0
          const plugin = {
            trigger: ((hook: string, _input: unknown, output: { title: string; output: string; metadata: unknown }) =>
              Effect.gen(function* () {
                if (hook !== "tool.execute.after") return output
                afterHooks++
                const before = yield* actions.load(actionID)
                expect(before.action.status).toBe("settled")
                expect(before.observation?.status).toBe("succeeded")
                expect(before.postProcessing?.state).toBe("started")
                if (failure === "hook") throw new Error("PRIVATE_POST_CARRIER_FAILURE")
                if (failure === "cancel") return yield* Effect.interrupt
                output.title = "display title"
                output.output =
                  failure === "oversized" ? "x".repeat(AgentRuntime.ManagedArtifactMaxBytes) : "display output"
                output.metadata = { displayed: true }
                return output
              })) as Plugin.Interface["trigger"],
          } as Plugin.Interface
          const execute = () =>
            Effect.sync(() => {
              executions++
              return {
                title: "original title",
                output: "original output",
                metadata: {
                  original: true,
                  parentSessionId: SessionID.make(String(sessionID)),
                  sessionId: SessionID.make("ses_post_child"),
                  model: { modelID: "test", providerID: "test" },
                  reasoningLevel: "default" as const,
                },
              }
            })
          const definition: MatureTool.Def = {
            id: request.call.name,
            description: "Postprocessing carrier regression",
            parameters: Schema.Record(Schema.String, Schema.Unknown),
            execute,
          }
          const dependencies = { plugin, directory: String(directory), worktree: String(directory) }
          const common = {
            messages: [],
            sandboxProfile: SandboxPolicy.DefaultProfile,
            promptOps: {} as never,
            metadata: () => Effect.void,
          }
          const options: CoreToolRegistry.MaterializeOptions =
            carrierKind === "legacy"
              ? {
                  legacySessionTools: makeLegacySessionTools([definition], dependencies, {
                    ...common,
                    workspace: String(directory),
                    extra: {},
                  }),
                }
              : {
                  scheduledTaskTool: makeScheduledTaskTool(
                    { parameters: TaskParameters, description: definition.description, jsonSchema: undefined, execute },
                    definition.description,
                    dependencies,
                    { ...common, route: () => ({ modelID: "test", providerID: "test" }) },
                  ),
                }
          const materialized = yield* registry.materialize([], sessionID, { ...options, includeRegistered: false })
          const firstExit = yield* materialized.settle(request).pipe(Effect.exit)
          const before = yield* actions.load(actionID)
          expect(before.action.status).toBe("settled")
          expect(before.observation?.status).toBe("succeeded")
          expect(before.observation?.output?.value).toMatchObject({
            structured: { title: "original title", output: "original output", metadata: { original: true } },
          })
          if (failure === "cancel") {
            expect(Exit.isFailure(firstExit) && Cause.hasInterruptsOnly(firstExit.cause)).toBe(true)
            expect(before.postProcessing?.state).toBe("interrupted")
            expect((yield* materialized.settle(request)).result).toMatchObject({
              type: "error",
              value: expect.stringContaining("postprocessing failed"),
            })
            expect([executions, afterHooks]).toEqual([1, 1])
            expect((yield* actions.load(actionID)).lastSequence).toBe(before.lastSequence)
            return
          }
          if (Exit.isFailure(firstExit)) return yield* Effect.failCause(firstExit.cause)
          const first = firstExit.value
          expect(before.postProcessing?.state).toBe(failure === "none" ? "completed" : "failed")
          if (failure === "none")
            expect(settlementToMatureResult(first)).toMatchObject({
              title: "display title",
              output: "display output",
              metadata: { displayed: true },
            })
          else {
            expect(first.result).toMatchObject({
              type: "error",
              value: expect.stringContaining("postprocessing failed"),
            })
            expect(JSON.stringify(first)).not.toContain("PRIVATE_")
          }
          expect(yield* materialized.settle(request)).toEqual(first)
          expect([executions, afterHooks]).toEqual([1, 1])
          expect((yield* actions.load(actionID)).lastSequence).toBe(before.lastSequence)
        }),
      )
    }
  }

  for (const mode of ["transform", "failure"] as const) {
    it.effect(`durably separates a plugin postprocessing ${mode} from the successful tool effect`, () =>
      Effect.gen(function* () {
        permissionBlocked = false
        let executions = 0
        const hooks: string[] = []
        const name = `plugin_post_${mode}`
        const plugin = {
          trigger: ((hook: string, _input: unknown, output: { title: string; output: string; metadata: unknown }) =>
            Effect.sync(() => {
              hooks.push(hook)
              if (hook !== "tool.execute.after") return output
              if (mode === "failure") throw new Error("POSTPROCESS_PRIVATE_DETAIL")
              output.title = "presented title"
              output.output = "presented result"
              output.metadata = { presented: true }
              return output
            })) as Plugin.Interface["trigger"],
        } as Plugin.Interface
        const tools = yield* CoreTools.Service
        const registry = yield* CoreToolRegistry.Service
        yield* tools.register({
          [name]: adaptExternalTool(
            {
              id: name,
              description: "Durable postprocessing regression",
              parameters: Schema.Struct({}),
              origin: { kind: "plugin", permission: name },
              execute: () =>
                Effect.sync(() => {
                  executions++
                  return { title: "original title", output: "original result", metadata: { original: true } }
                }),
            },
            { plugin, directory: String(directory), worktree: String(directory) },
          ),
        })
        const materialized = yield* registry.materialize()
        const request = {
          sessionID: SessionV2.ID.make(`ses_post_${mode}`),
          assistantMessageID: SessionMessage.ID.make(`msg_post_${mode}`),
          agent: AgentV2.ID.make("build"),
          call: { type: "tool-call" as const, id: `call_post_${mode}`, name, input: {} },
        }
        const first = yield* materialized.settle(request)
        const actionID = ActionGateway.stableActionID({ ...request, toolCallID: request.call.id })
        const snapshot = yield* (yield* DurableAction.Service).load(actionID)
        expect(snapshot.action.status).toBe("settled")
        expect(snapshot.observation?.status).toBe("succeeded")
        expect(snapshot.observation?.output?.value).toMatchObject({
          structured: { title: "original title", output: "original result", metadata: { original: true } },
        })
        if (mode === "transform")
          expect(settlementToMatureResult(first)).toMatchObject({
            title: "presented title",
            output: "presented result",
            metadata: { presented: true },
          })
        else {
          expect(first.result).toMatchObject({ type: "error", value: expect.stringContaining("postprocessing failed") })
          expect(JSON.stringify(first)).not.toContain("POSTPROCESS_PRIVATE_DETAIL")
        }
        const replay = yield* materialized.settle(request)
        expect(replay).toEqual(first)
        expect(executions).toBe(1)
        expect(hooks).toEqual(["tool.execute.before", "tool.execute.after"])
        expect((yield* (yield* DurableAction.Service).load(actionID)).lastSequence).toBe(snapshot.lastSequence)
      }),
    )
  }

  for (const originalText of ["", "original text"]) {
    for (const displayText of ["", "display text"]) {
      it.effect(
        `postprocessing preserves inline attachments when text changes from ${JSON.stringify(originalText)} to ${JSON.stringify(displayText)}`,
        () =>
          Effect.gen(function* () {
            permissionBlocked = false
            const plugin = {
              trigger: ((name: string, _input: unknown, output: { output: string }) =>
                Effect.sync(() => {
                  if (name === "tool.execute.after") output.output = displayText
                  return output
                })) as Plugin.Interface["trigger"],
            } as Plugin.Interface
            const name = "plugin_attachment_projection"
            yield* (yield* CoreTools.Service).register({
              [name]: adaptExternalTool(
                {
                  id: name,
                  description: "Attachment projection fixture",
                  parameters: Schema.Struct({}),
                  origin: { kind: "plugin", permission: name },
                  execute: () =>
                    Effect.succeed({
                      title: "attachment",
                      output: originalText,
                      metadata: {},
                      attachments: [
                        {
                          type: "file",
                          mime: "image/png",
                          url: "data:image/png;base64,aGVsbG8=",
                          filename: "inline.png",
                        },
                        { type: "file", mime: "text/plain", url: "https://example.invalid/private.txt" },
                      ],
                    }),
                },
                { plugin, directory: String(directory), worktree: String(directory) },
              ),
            })
            const materialized = yield* (yield* CoreToolRegistry.Service).materialize()
            const request = {
              sessionID: SessionV2.ID.create(),
              assistantMessageID: SessionMessage.ID.create(),
              agent: AgentV2.ID.make("build"),
              call: { type: "tool-call" as const, id: "attachment_projection", name, input: {} },
            }
            const result = yield* materialized.settle(request)
            expect(result.output?.content).toEqual([
              ...(displayText ? [{ type: "text" as const, text: displayText }] : []),
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "inline.png" },
              { type: "text", text: "[1 non-inline attachment was omitted from model transport]" },
            ])
            expect(JSON.stringify(result)).not.toContain("https://example.invalid")
            expect(settlementToMatureResult(result).output).toBe(displayText)
            expect(yield* materialized.settle(request)).toEqual(result)
          }),
      )
    }
  }

  it.effect("settles a plugin-origin definition only through the Core ToolRegistry pipeline", () =>
    Effect.gen(function* () {
      permissionAssertions.length = 0
      permissionBlocked = false
      const hooks: string[] = []
      let executions = 0
      const plugin = {
        trigger: ((name: string, _input: unknown, output: unknown) =>
          Effect.sync(() => {
            hooks.push(name)
            return output
          })) as Plugin.Interface["trigger"],
      } as Plugin.Interface
      const mature = PluginToolSource.make(
        "plugin_echo",
        {
          args: { value: z.string().min(1) },
          description: "Echo through a plugin adapter",
          execute: async (input, context) => {
            executions += 1
            await context.ask({
              permission: "plugin_echo",
              patterns: ["*"],
              always: ["*"],
              metadata: { source: "test-plugin" },
            })
            context.metadata({ title: "running", metadata: { progress: true } })
            return {
              title: "echo",
              output: String(input.value),
              metadata: { completed: true },
              attachments: [
                { type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=", filename: "ok.png" },
                { type: "file", mime: "text/plain", url: "https://example.invalid/private.txt" },
              ],
            }
          },
        },
        {
          instance: {
            directory: String(directory),
            worktree: String(directory),
            project: { id: "plugin-source-test", directory: String(directory), worktree: String(directory) } as never,
          },
          agents: {
            get: () => Effect.succeed({ name: "build" } as Agent.Info),
          } as unknown as Agent.Interface,
          truncate: {
            output: (output: string) => Effect.succeed({ content: output, truncated: false }),
          } as Truncate.Interface,
        },
      )
      const tools = yield* CoreTools.Service
      const registry = yield* CoreToolRegistry.Service
      yield* tools.register({
        plugin_echo: adaptExternalTool(mature, {
          plugin,
          directory: String(directory),
          worktree: String(directory),
        }),
      })
      const materialized = yield* registry.materialize()
      expect(materialized.definitions.find((item) => item.name === "plugin_echo")?.inputSchema).toEqual(
        mature.jsonSchema as unknown as Record<string, unknown>,
      )

      const result = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_core_bridge"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_core_bridge"),
        call: {
          type: "tool-call",
          id: "call_core_bridge",
          name: "plugin_echo",
          input: { value: "hello" },
        },
      })

      expect(executions).toBe(1)
      expect(hooks).toEqual(["tool.execute.before", "tool.execute.after"])
      expect(permissionAssertions).toContainEqual(expect.objectContaining({ action: "plugin_echo", resources: ["*"] }))
      expect(result.result).toMatchObject({ type: "content" })
      expect(result.output?.content).toEqual([
        { type: "text", text: "hello" },
        { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "ok.png" },
        { type: "text", text: "[1 non-inline attachment was omitted from model transport]" },
      ])
      expect(result.output?.structured).toEqual({
        title: "echo",
        output: "hello",
        metadata: { progress: true, completed: true, truncated: false },
        attachments: [
          { type: "file", mime: "image/png", filename: "ok.png", inline: true },
          { type: "file", mime: "text/plain", inline: false },
        ],
      })
      expect(JSON.stringify(result)).not.toContain("example.invalid")
    }),
  )

  it.effect("blocks a real plugin source before plugin code or hooks can run", () =>
    Effect.gen(function* () {
      permissionAssertions.length = 0
      permissionBlocked = true
      let executions = 0
      const hooks: string[] = []
      const plugin = {
        trigger: ((name: string, _input: unknown, output: unknown) =>
          Effect.sync(() => {
            hooks.push(name)
            return output
          })) as Plugin.Interface["trigger"],
      } as Plugin.Interface
      const mature = PluginToolSource.make(
        "plugin_denied",
        {
          args: {},
          description: "Must not execute without fresh approval",
          execute: async () => {
            executions += 1
            return "should not run"
          },
        },
        {
          instance: {
            directory: String(directory),
            worktree: String(directory),
            project: { id: "plugin-denied-test", directory: String(directory), worktree: String(directory) } as never,
          },
          agents: { get: () => Effect.succeed({ name: "build" } as Agent.Info) } as unknown as Agent.Interface,
          truncate: {
            output: (output: string) => Effect.succeed({ content: output, truncated: false }),
          } as Truncate.Interface,
        },
      )
      const tools = yield* CoreTools.Service
      yield* tools.register({
        plugin_denied: adaptExternalTool(mature, {
          plugin,
          directory: String(directory),
          worktree: String(directory),
        }),
      })
      const materialized = yield* (yield* CoreToolRegistry.Service).materialize()
      const settlement = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_plugin_denied"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_plugin_denied"),
        call: { type: "tool-call", id: "call_plugin_denied", name: "plugin_denied", input: {} },
      })

      expect(settlement.result).toMatchObject({ type: "error" })
      expect(executions).toBe(0)
      expect(hooks).toEqual([])
      expect(permissionAssertions).toEqual([
        expect.objectContaining({ action: "plugin_denied", resources: ["*"], forceAsk: true }),
      ])
      permissionBlocked = false
    }),
  )

  it.effect("preserves mature shell preflight and process egress inside the legacy Core carrier", () =>
    Effect.gen(function* () {
      permissionAssertions.length = 0
      const hooks: string[] = []
      let executions = 0
      let mutationRecorderAvailable = false
      const plugin = {
        trigger: ((name: string, _input: unknown, output: unknown) =>
          Effect.sync(() => {
            hooks.push(name)
            return output
          })) as Plugin.Interface["trigger"],
      } as Plugin.Interface
      const command = "curl https://example.com"
      const mature: MatureTool.Def = {
        id: "bash",
        description: "Run one shell command",
        parameters: Schema.Struct({ command: Schema.String }),
        jsonSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        execute: (input, context) =>
          Effect.gen(function* () {
            executions += 1
            mutationRecorderAvailable = context.gateway?.recordMutationIntent !== undefined
            const value = input as { command: string }
            yield* context.ask({
              permission: "bash",
              patterns: [value.command],
              always: [value.command],
              metadata: {},
            })
            yield* context.egress!.assertProcess!({ command: value.command }).pipe(Effect.orDie)
            return { title: "shell", output: "network allowed", metadata: {} }
          }),
      }
      const carrier = makeLegacySessionTools(
        [mature],
        { plugin, directory: String(directory), worktree: String(directory) },
        {
          messages: [],
          sandboxProfile: SandboxPolicy.DefaultProfile,
          extra: {},
          workspace: String(directory),
          shell: "bash",
          metadata: () => Effect.void,
        },
      )
      const registry = yield* CoreToolRegistry.Service
      const sessionID = SessionV2.ID.make("ses_legacy_shell_bridge")
      const materialized = yield* registry.materialize([], sessionID, {
        includeRegistered: false,
        legacySessionTools: carrier,
      })
      const settlement = yield* materialized.settle({
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_legacy_shell_bridge"),
        call: { type: "tool-call", id: "call_legacy_shell_bridge", name: "bash", input: { command } },
      })

      expect(settlementToMatureResult(settlement).output).toBe("network allowed")
      expect(executions).toBe(1)
      expect(mutationRecorderAvailable).toBe(true)
      expect(hooks).toEqual(["tool.execute.before", "tool.execute.after"])
      expect(permissionAssertions).toEqual([
        expect.objectContaining({ action: "bash", resources: [command, `process:${command}`] }),
      ])
    }),
  )

  it.effect("normalizes mature read leaf scope from worktree coordinates into the active Location", () =>
    Effect.gen(function* () {
      permissionAssertions.length = 0
      permissionBlocked = false
      let executions = 0
      const worktree = path.dirname(String(directory))
      const filePath = path.join(String(directory), "nested.txt")
      const mature: MatureTool.Def = {
        id: "read",
        description: "Read one exact file",
        parameters: Schema.Struct({ filePath: Schema.String }),
        execute: (raw, context) =>
          Effect.gen(function* () {
            executions += 1
            const input = raw as { filePath: string }
            yield* context.ask({
              permission: "read",
              patterns: [path.relative(worktree, input.filePath)],
              always: ["*"],
              metadata: {},
            })
            return { title: "read", output: "ok", metadata: {} }
          }),
      }
      const carrier = makeLegacySessionTools(
        [mature],
        {
          plugin: { trigger: (_name, _input, output) => Effect.succeed(output) } as Plugin.Interface,
          directory: String(directory),
          worktree,
        },
        {
          messages: [],
          sandboxProfile: SandboxPolicy.DefaultProfile,
          extra: {},
          workspace: worktree,
          metadata: () => Effect.void,
        },
      )
      const sessionID = SessionV2.ID.make("ses_nested_read_bridge")
      const materialized = yield* (yield* CoreToolRegistry.Service).materialize([], sessionID, {
        includeRegistered: false,
        legacySessionTools: carrier,
      })
      const settlement = yield* materialized.settle({
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_nested_read_bridge"),
        call: { type: "tool-call", id: "call_nested_read_bridge", name: "read", input: { filePath } },
      })

      expect(settlementToMatureResult(settlement).output).toBe("ok")
      expect(executions).toBe(1)
      expect(permissionAssertions).toEqual([])
    }),
  )

  it.effect("runs the canonical scheduled task once with progress, hooks, permission and parent lineage intact", () =>
    Effect.gen(function* () {
      permissionBlocked = false
      const hooks: string[] = []
      const progress: ScheduledTaskProgress[] = []
      let executions = 0
      let observed: TaskExecutionContext | undefined
      const plugin = {
        trigger: ((name: string, _input: unknown, output: unknown) =>
          Effect.sync(() => {
            hooks.push(name)
            return output
          })) as Plugin.Interface["trigger"],
      } as Plugin.Interface
      const runtime: TaskRuntimeValue = {
        description: "Execute one scheduled task",
        parameters: TaskParameters,
        jsonSchema: undefined,
        execute: (input, context) =>
          Effect.gen(function* () {
            executions++
            observed = context
            yield* context.ask({ permission: "task", patterns: [input.subagent_type], always: ["*"], metadata: {} })
            yield* context.metadata({ title: "working", metadata: { phase: "child" } })
            return {
              title: input.description,
              output: "child done",
              metadata: {
                done: true,
                parentSessionId: context.sessionID,
                sessionId: SessionID.make("ses_native_child"),
                model: { modelID: "test", providerID: "test" },
                reasoningLevel: "default" as const,
              },
            }
          }),
      }
      const registry = yield* CoreToolRegistry.Service
      const sessionID = SessionV2.ID.make("ses_native_scheduled_bridge")
      const scheduledTaskTool = makeScheduledTaskTool(
        runtime,
        runtime.description,
        { plugin, directory: String(directory), worktree: String(directory) },
        {
          sandboxProfile: SandboxPolicy.DefaultProfile,
          promptOps: {} as never,
          metadata: (input) =>
            Effect.sync(() => {
              progress.push(input)
            }),
          route: () => ({ modelID: "test", providerID: "test" }),
        },
      )
      const materialized = yield* registry.materialize([], sessionID, { includeRegistered: false, scheduledTaskTool })
      const input = {
        runID: AgentRuntime.RunID.make("run_native_scheduled_bridge"),
        sessionID,
        agent: AgentV2.ID.make("general"),
        assistantMessageID: SessionMessage.ID.make("msg_native_scheduled_bridge"),
        call: {
          type: "tool-call" as const,
          id: "call_native_scheduled_bridge",
          name: "task",
          input: { prompt: "inspect", description: "inspect workspace", subagent_type: "general" },
        },
      }
      expect(materialized.definitions.map((item) => item.name)).toEqual(["task"])
      const first = yield* materialized.settle(input)
      expect(settlementToMatureResult(first)).toMatchObject({
        title: "inspect workspace",
        output: "child done",
        metadata: { done: true },
      })
      expect(yield* materialized.settle(input)).toEqual(first)
      expect(executions).toBe(1)
      expect(hooks).toEqual(["tool.execute.before", "tool.execute.after"])
      expect(progress).toEqual([
        {
          assistantMessageID: input.assistantMessageID,
          callID: input.call.id,
          value: { title: "working", metadata: { phase: "child" } },
        },
      ])
      expect(observed?.sandboxProfile).toBe(SandboxPolicy.DefaultProfile)
      expect(observed?.messageID).toBe(MessageID.make(String(input.assistantMessageID)))
      expect(observed?.bypassAgentCheck).toBe(true)
      expect(observed?.nativeParent).toEqual({ modelID: "test", providerID: "test" })
      expect(observed?.parentAction?.runID).toBe(input.runID)
      expect(observed?.parentAction?.actionID).toBe(
        ActionGateway.stableActionID({
          sessionID,
          assistantMessageID: input.assistantMessageID,
          toolCallID: input.call.id,
        }),
      )
      expect(
        permissionAssertions
          .filter((item) => item.sessionID === sessionID)
          .map(({ action, resources }) => ({ action, resources })),
      ).toEqual([{ action: "task", resources: ["general"] }])
      expect((yield* registry.materialize([], sessionID, { includeRegistered: false })).definitions).toEqual([])
    }),
  )

  it.effect("a failed native scheduled task closes visibly without a success or a post callback", () =>
    Effect.gen(function* () {
      permissionBlocked = false
      const hooks: string[] = []
      const runtime: TaskRuntimeValue = {
        description: "Fail one scheduled task",
        parameters: TaskParameters,
        jsonSchema: undefined,
        execute: () => Effect.die(new Error("child failed visibly")),
      }
      const plugin = {
        trigger: ((name: string, _input: unknown, output: unknown) =>
          Effect.sync(() => {
            hooks.push(name)
            return output
          })) as Plugin.Interface["trigger"],
      } as Plugin.Interface
      const registry = yield* CoreToolRegistry.Service
      const sessionID = SessionV2.ID.make("ses_failed_native_task")
      const scheduledTaskTool = makeScheduledTaskTool(
        runtime,
        runtime.description,
        { plugin, directory: String(directory), worktree: String(directory) },
        {
          sandboxProfile: SandboxPolicy.DefaultProfile,
          promptOps: {} as never,
          metadata: () => Effect.void,
          route: () => ({ modelID: "test", providerID: "test" }),
        },
      )
      const materialized = yield* registry.materialize([], sessionID, { includeRegistered: false, scheduledTaskTool })
      const request = {
        sessionID,
        agent: AgentV2.ID.make("general"),
        assistantMessageID: SessionMessage.ID.create(),
        call: {
          type: "tool-call" as const,
          id: "call_failed_native_task",
          name: "task",
          input: { description: "failure", prompt: "fail", subagent_type: "general" },
        },
      }
      const settlement = yield* materialized.settle(request)
      expect(settlement.result).toMatchObject({ type: "error", value: "child failed visibly" })
      expect(hooks).toEqual(["tool.execute.before"])
      const before = yield* (yield* DurableAction.Service).load(
        ActionGateway.stableActionID({ ...request, toolCallID: request.call.id }),
      )
      expect(before.observation?.status).toBe("failed")
      expect(before.postProcessing).toBeUndefined()
      expect(yield* materialized.settle(request)).toEqual(settlement)
      expect(hooks).toEqual(["tool.execute.before"])
    }),
  )

  it.effect("reads one exact user attachment without a second prompt or remote URL restoration", () =>
    Effect.gen(function* () {
      const hooks: string[] = []
      let executions = 0
      const plugin = {
        trigger: ((name: string, _input: unknown, output: unknown) =>
          Effect.sync(() => {
            hooks.push(name)
            return output
          })) as Plugin.Interface["trigger"],
      } as Plugin.Interface
      const parameters = Schema.Struct({ filePath: Schema.String })
      const mature: MatureTool.Def<typeof parameters> = {
        id: "read",
        description: "Read one attachment",
        parameters,
        execute: (_input, context) =>
          Effect.gen(function* () {
            executions += 1
            yield* context.ask({
              permission: "read",
              patterns: ["caller-controlled-wrong-scope"],
              always: ["*"],
              metadata: {},
            })
            return {
              title: "attachment",
              output: "attached text",
              metadata: { exact: true },
              attachments: [
                { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=", filename: "ok.txt" },
                { type: "file", mime: "text/plain", url: "https://example.invalid/private.txt" },
              ],
            }
          }),
      }
      const registry = yield* CoreToolRegistry.Service
      const sessionID = SessionV2.ID.make("ses_attachment_carrier_bridge")
      const carrier = makeUserAttachmentReadCarrier(
        mature,
        { plugin, directory: String(directory), worktree: String(directory) },
        { filePath: import.meta.file, authorizationResource: "core-bridge.test.ts" },
      )
      const materialized = yield* registry.materialize([], sessionID, {
        includeRegistered: false,
        userAttachmentRead: carrier,
      })
      const settlement = yield* materialized.settle({
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_attachment_carrier_bridge"),
        call: {
          type: "tool-call",
          id: "call_attachment_carrier_bridge",
          name: TurnToolCarrier.userAttachmentReadName,
          input: { filePath: import.meta.file },
        },
      })

      expect(settlementToMatureResult(settlement)).toEqual({
        title: "attachment",
        output: "attached text",
        metadata: { exact: true },
        attachments: [{ type: "file", mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=", filename: "ok.txt" }],
      })
      expect(JSON.stringify(settlement)).not.toContain("example.invalid")
      expect(hooks).toEqual([])
      expect(permissionAssertions.filter((item) => item.sessionID === sessionID)).toEqual([])

      const mismatch = yield* materialized.settle({
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_attachment_carrier_bridge"),
        call: {
          type: "tool-call",
          id: "call_attachment_carrier_mismatch",
          name: TurnToolCarrier.userAttachmentReadName,
          input: { filePath: import.meta.dir },
        },
      })
      expect(mismatch.result).toMatchObject({ type: "error", value: expect.stringContaining("does not match") })
      expect(executions).toBe(1)
      expect((yield* registry.materialize([], sessionID, { includeRegistered: false })).definitions).toEqual([])
    }),
  )

  it.effect("runs a generation-bound MCP origin as a keyed Core tool with one durable child call", () =>
    Effect.gen(function* () {
      let capabilityAssertions = 0
      let transportCalls = 0
      const hooks: string[] = []
      const plugin = {
        trigger: ((name: string, _input: unknown, output: unknown) =>
          Effect.sync(() => {
            hooks.push(name)
            return output
          })) as Plugin.Interface["trigger"],
      } as Plugin.Interface
      const mcp = {
        assertCapability: () =>
          Effect.sync(() => {
            capabilityAssertions += 1
          }),
        declaredScope: () =>
          Effect.succeed({
            endpoint: "https://weather.example/mcp",
            networkScope: ["https://weather.example"],
            secretScope: [],
            externalServices: [],
          }),
      } as unknown as MCP.Interface
      const agents = {
        get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} }),
      } as unknown as Agent.Interface
      const truncate = {
        output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      } as unknown as Truncate.Interface
      const projected = McpToolProjection.make({
        key: "weather_current",
        server: "weather",
        entry: {
          def: {
            name: "current",
            description: "Current weather",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
              additionalProperties: false,
            },
          },
          generation: 9,
          client: {
            callTool: async () => {
              transportCalls += 1
              return { content: [{ type: "text" as const, text: "sunny" }] }
            },
          },
        } as unknown as MCP.McpTool,
        mcp,
        plugin,
        agents,
        truncate,
      })
      const tools = yield* CoreTools.Service
      const registry = yield* CoreToolRegistry.Service
      yield* tools.register({
        weather_current: adaptExternalTool(projected, {
          plugin,
          directory: String(directory),
          worktree: String(directory),
        }),
      })
      expect((yield* registry.catalog()).find((item) => item.name === "weather_current")).toMatchObject({
        concurrency: "keyed",
        sideEffect: "external",
        resourceKey: expect.stringMatching(/^mcp:[a-f0-9]{64}$/),
      })
      const materialized = yield* registry.materialize()
      const settlement = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_core_mcp_bridge"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_core_mcp_bridge"),
        call: {
          type: "tool-call",
          id: "call_core_mcp_bridge",
          name: "weather_current",
          input: { city: "Shanghai" },
        },
      })
      // Generation-bound MCP capabilities are checked once before scope and
      // approval, then once more inside the durable child action immediately
      // before transport. The second check closes the reconnect/replacement
      // window without creating a second child action or duplicate hooks.
      expect(capabilityAssertions).toBe(2)
      expect(transportCalls).toBe(1)
      // The outer Core pipeline owns hooks; the MCP child adapter has
      // emitHooks=false, so the same logical tool never emits duplicates.
      expect(hooks).toEqual(["tool.execute.before", "tool.execute.after"])
      expect(settlement.result).toMatchObject({ type: "text", value: expect.stringContaining("sunny") })
      expect(settlement.output?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining('source="remote_instruction"'),
      })
    }),
  )
})

const parameters = Schema.Struct({ value: Schema.String })
