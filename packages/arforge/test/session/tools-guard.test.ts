import { beforeEach, describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Location } from "@arforge-ai/core/location"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { forToolCall } from "@arforge-ai/core/tool/effect-semantics"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema as DurableSessionSchema } from "@arforge-ai/core/session/schema"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { SessionTools } from "@/session/tools"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const legacyPermissionCalls: unknown[] = []
const toolBodyEffects: unknown[] = []
const permissionAssertions: PermissionV2.AssertInput[] = []
const hookEvents: string[] = []
let cancelStarted = false
let cancelObserved = false

const sessionID = SessionID.make("ses_guard_test")
const messageID = MessageID.make("msg_guard_test")

const resolveInput = (worktree: string) => ({
  runID: undefined,
  agent: { name: "build", permission: [] } as any,
  model: { api: { id: "test-model" }, providerID: "test-provider" } as any,
  session: { id: sessionID } as any,
  processor: {
    message: { id: messageID, path: { root: worktree } },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
  } as any,
  bypassAgentCheck: false,
  messages: [],
  promptOps: {} as any,
})

const resolveTools = Effect.fn("SessionToolsGuard.resolve")(function* (worktree: string) {
  const coreRegistry = yield* CoreToolRegistry.Service
  return yield* SessionTools.resolve({ ...resolveInput(worktree), coreRegistry })
})

const loadAction = Effect.fn("SessionToolsGuard.loadAction")(function* (toolCallID: string) {
  const actions = yield* DurableAction.Service
  const snapshot = yield* actions.load(
    ActionGateway.stableActionID({
      sessionID: DurableSessionSchema.ID.make(sessionID),
      assistantMessageID: SessionMessage.ID.make(messageID),
      toolCallID,
    }),
  )
  return { ...snapshot, action: snapshot.action as AgentRuntime.SessionAction }
})

const expectedIntent = (
  toolCallID: string,
  args: unknown,
  worktree: string,
  locationDirectory = worktree,
  digestOverride?: string,
) => {
  const input =
    typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  const semantics = forToolCall({ name: "custom_tool", input, workspace: worktree })
  const actionID = ActionGateway.stableActionID({
    sessionID: DurableSessionSchema.ID.make(sessionID),
    assistantMessageID: SessionMessage.ID.make(messageID),
    toolCallID,
  })
  const authorization = SessionTools.permissionPreflight({
    name: "custom_tool",
    input,
    workspace: worktree,
    locationDirectory,
    riskTier: "L3",
  })
  return ActionGateway.intentDigestOf(
    {
      actionID,
      sessionID: DurableSessionSchema.ID.make(sessionID),
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.make(messageID),
      toolCallID,
      name: "custom_tool",
      resources: [
        ...new Set([
          ...semantics.filesystemScope,
          ...semantics.networkScope,
          ...semantics.secretScope,
          ...semantics.externalServices,
        ]),
      ].filter(Boolean),
      semantics,
      reasonSummary: "执行工具 custom_tool；风险等级 L3",
      initiator: "agent",
      traceID: actionID,
      inputDigest: digestOverride ?? canonicalHash(args)!,
    },
    ActionGateway.canonicalPlan(authorization),
  )
}

const toolLayer = Layer.mergeAll(
  Layer.mock(Plugin.Service, {
    trigger: ((name: string, _input: unknown, output: unknown) =>
      Effect.sync(() => {
        hookEvents.push(name)
        return output
      })) as Plugin.Interface["trigger"],
  }),
  Layer.mock(Permission.Service, {
    ask: (input) =>
      Effect.sync(() => {
        legacyPermissionCalls.push(input)
        throw new Error("unexpected legacy ask in guard test")
      }),
  }),
  Layer.mock(ToolRegistry.Service, {
    tools: () =>
      Effect.succeed([
        {
          id: "custom_tool",
          origin: { kind: "plugin", permission: "custom_tool" },
          description: "custom tool",
          parameters: Schema.Unknown,
          jsonSchema: { type: "object", properties: {} },
          execute: (args: unknown, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const request =
                typeof args === "object" && args !== null && "requestPermission" in args
                  ? (args.requestPermission as string)
                  : undefined
              if (request)
                yield* ctx.ask({
                  permission: request,
                  patterns: ["requested-resource"],
                  always: ["requested-resource"],
                  metadata: {},
                })
              toolBodyEffects.push(args)
              return { title: "custom", metadata: {}, output: "ran " + String(args) }
            }),
        } satisfies Tool.Def,
        {
          id: "cancel_tool",
          origin: { kind: "plugin", permission: "cancel_tool" },
          description: "cancellation probe",
          parameters: Schema.Struct({}),
          jsonSchema: { type: "object", properties: {} },
          execute: (_args: unknown, _ctx: Tool.Context) =>
            Effect.sync(() => {
              cancelStarted = true
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  cancelObserved = true
                }),
              ),
            ),
        } satisfies Tool.Def,
        {
          id: "edit",
          description: "edit authorization probe",
          parameters: Schema.Unknown,
          jsonSchema: { type: "object", properties: {} },
          execute: (args: unknown, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const requestedResource =
                typeof args === "object" && args !== null && "requestedResource" in args
                  ? (args.requestedResource as string)
                  : ""
              yield* ctx.ask({
                permission: "edit",
                patterns: [requestedResource],
                always: [requestedResource],
                metadata: {},
              })
              toolBodyEffects.push(args)
              return { title: "edit", metadata: {}, output: "edited" }
            }),
        } satisfies Tool.Def,
      ]),
  }),
  Layer.mock(MCP.Service, {
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    declaredScope: () => Effect.succeed(undefined),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
  }),
  Layer.mock(RuntimeFlags.Service, {
    experimentalCodeMode: false,
  } as never),
)

const corePermission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => permissionAssertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const locationDirectory = AbsolutePath.make(import.meta.dir)
const currentLocation = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: locationDirectory,
    project: { id: Project.ID.global, directory: locationDirectory },
  }),
)
const coreLayer = AppNodeBuilder.build(
  LayerNode.group([CoreToolRegistry.node, CoreToolRegistry.toolsNode, DurableAction.node]),
  [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [PermissionV2.node, corePermission],
    [Location.node, currentLocation],
  ],
)

const it = testEffect(Layer.mergeAll(toolLayer, coreLayer))

beforeEach(() => {
  legacyPermissionCalls.length = 0
  toolBodyEffects.length = 0
  permissionAssertions.length = 0
  hookEvents.length = 0
  cancelStarted = false
  cancelObserved = false
})

describe("SessionTools guarded execution", () => {
  it.instance("persists a successful tool result even when the adapter does not emit tool-result", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const completed: Array<{ id: string; output: string }> = []
      const input = resolveInput(test.directory)
      const coreRegistry = yield* CoreToolRegistry.Service
      const tools = yield* SessionTools.resolve({
        ...input,
        coreRegistry,
        processor: {
          ...input.processor,
          completeToolCall: (id: string, output: { output: string }) =>
            Effect.sync(() => completed.push({ id, output: output.output })),
        },
      } as any)

      const result = yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!({}, { toolCallId: "call-success", messages: [] }),
      )

      expect((result as { output: string }).output).toBe("ran [object Object]")
      expect(completed).toEqual([{ id: "call-success", output: "ran [object Object]" }])
    }),
  )

  it.instance("fails closed without a legacy ask when an active durable grant requests another action", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      legacyPermissionCalls.length = 0
      toolBodyEffects.length = 0
      const tools = yield* resolveTools(test.directory)

      const result = yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!(
          { requestPermission: "bash" },
          { toolCallId: "call-action-escalation", messages: [] },
        ),
      )

      expect(result).toEqual({ type: "error", value: "Unplanned permission action bash" })
      expect(legacyPermissionCalls).toEqual([])
      expect(toolBodyEffects).toEqual([])
    }),
  )

  it.instance("continues through the covered same-action wildcard without a legacy ask", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      legacyPermissionCalls.length = 0
      toolBodyEffects.length = 0
      const tools = yield* resolveTools(test.directory)

      const result = yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!(
          { requestPermission: "custom_tool" },
          { toolCallId: "call-covered-action", messages: [] },
        ),
      )

      expect(result).toMatchObject({ title: "custom", output: "ran [object Object]" })
      expect(legacyPermissionCalls).toEqual([])
      expect(toolBodyEffects).toHaveLength(1)
    }),
  )

  it.instance("fails closed without a legacy ask when a same-action leaf expands the durable scope", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      legacyPermissionCalls.length = 0
      toolBodyEffects.length = 0
      const tools = yield* resolveTools(test.directory)

      const result = yield* Effect.promise(() =>
        tools["edit"]!.execute!(
          { filePath: "approved.txt", requestedResource: "expanded.txt" },
          { toolCallId: "call-scope-escalation", messages: [] },
        ),
      )

      expect(result).toEqual({
        type: "error",
        value: "Leaf scope expanded.txt exceeds the trusted authorization scope",
      })
      expect(legacyPermissionCalls).toEqual([])
      expect(toolBodyEffects).toEqual([])
    }),
  )

  it.instance("fails closed on non-canonicalizable input before the gateway, with no shared replay identity", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      permissionAssertions.length = 0
      toolBodyEffects.length = 0
      const tools = yield* resolveTools(test.directory)

      const first = yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!({ data: 1n }, { toolCallId: "call-guard-a", messages: [] }),
      )
      const second = yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!({ data: 2n }, { toolCallId: "call-guard-b", messages: [] }),
      )

      // Two distinct non-canonicalizable inputs fail closed with a clean
      // model-visible error; the gateway (and therefore permission,
      // attempt-started, plugin hooks, and the tool body) never runs, and no
      // durable action identity is minted that could replay either result.
      expect(first).toEqual({
        type: "error",
        value: "Preflight blocked: the tool input is not canonically hashable and cannot be executed",
      })
      expect(second).toEqual(first)
      expect(permissionAssertions).toEqual([])
      expect(toolBodyEffects).toEqual([])
      expect(Option.isNone(yield* loadAction("call-guard-a").pipe(Effect.option))).toBe(true)
      expect(Option.isNone(yield* loadAction("call-guard-b").pipe(Effect.option))).toBe(true)
    }),
  )

  it.instance("routes canonical input through the gateway with the canonical input digest", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      permissionAssertions.length = 0
      const tools = yield* resolveTools(test.directory)

      yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!({ path: "a.txt" }, { toolCallId: "call-guard-ok", messages: [] }),
      )

      const action = yield* loadAction("call-guard-ok")
      expect(action.action.name).toBe("custom_tool")
      expect(action.action.intentDigest).toBe(expectedIntent("call-guard-ok", { path: "a.txt" }, test.directory))
      expect(permissionAssertions).toHaveLength(1)
    }),
  )

  it.instance("projects StructuredOutput from the same Core materialization and settles semantic validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      permissionAssertions.length = 0
      let captured: unknown
      const schema: Record<string, unknown> = {
        type: "object",
        properties: { company: { type: "string" }, founded: { type: "number" } },
        required: ["company", "founded"],
        additionalProperties: false,
      }
      const coreRegistry = yield* CoreToolRegistry.Service
      const tools = yield* SessionTools.resolve({
        ...resolveInput(test.directory),
        coreRegistry,
        structuredOutput: {
          schema,
          onSuccess: (output) => {
            captured = output
          },
        },
      })
      ;(schema.properties as Record<string, { type: string }>).company!.type = "number"

      const projected = tools["StructuredOutput"]!
      expect((projected.inputSchema as any).jsonSchema.properties.company.type).toBe("string")
      const success = yield* Effect.promise(() =>
        projected.execute!({ company: "Arforge", founded: 2026 }, { toolCallId: "call-structured-core", messages: [] }),
      )
      expect(captured).toEqual({ company: "Arforge", founded: 2026 })
      expect(success).toEqual({
        title: "Structured Output",
        output: "Structured output captured successfully.",
        metadata: { valid: true },
      })
      expect(
        yield* Effect.promise(() =>
          Promise.resolve(
            projected.toModelOutput!({
              toolCallId: "call-structured-core",
              input: { company: "Arforge", founded: 2026 },
              output: success,
            }),
          ),
        ),
      ).toEqual({ type: "text", value: "Structured output captured successfully." })

      captured = undefined
      const invalid = yield* Effect.promise(() =>
        projected.execute!({ company: "Arforge" }, { toolCallId: "call-structured-invalid", messages: [] }),
      )
      expect(invalid).toMatchObject({ type: "error", value: expect.stringContaining("founded") })
      expect(captured).toBeUndefined()
      expect(permissionAssertions).toEqual([])
    }),
  )

  it.instance("hashes the full raw arguments, not the lossy record projection", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = yield* resolveTools(test.directory)

      // Schema.Unknown tools accept non-record inputs: distinct arrays must
      // produce distinct digests and must never collapse to the digest of {}.
      yield* Effect.promise(() => tools["custom_tool"]!.execute!(["a"], { toolCallId: "call-arr-a", messages: [] }))
      yield* Effect.promise(() => tools["custom_tool"]!.execute!(["b"], { toolCallId: "call-arr-b", messages: [] }))
      yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!("primitive-a", { toolCallId: "call-str-a", messages: [] }),
      )
      yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!("primitive-b", { toolCallId: "call-str-b", messages: [] }),
      )

      const calls = [
        ["call-arr-a", ["a"]],
        ["call-arr-b", ["b"]],
        ["call-str-a", "primitive-a"],
        ["call-str-b", "primitive-b"],
      ] as const
      const emptyDigest = canonicalHash({})
      for (const [callID, args] of calls) {
        const action = yield* loadAction(callID)
        expect(action.action.intentDigest).toBe(expectedIntent(callID, args, test.directory))
        expect(action.action.intentDigest).not.toBe(
          expectedIntent(callID, args, test.directory, test.directory, emptyDigest),
        )
      }
    }),
  )

  it.instance("a direct non-canonicalizable primitive fails closed and leaves no stale state", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      permissionAssertions.length = 0
      const tools = yield* resolveTools(test.directory)

      // A bare BigInt is not wrapped in an object and is not canonicalizable.
      const failed = yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!(1n, { toolCallId: "call-bigint", messages: [] }),
      )
      expect(failed).toEqual({
        type: "error",
        value: "Preflight blocked: the tool input is not canonically hashable and cannot be executed",
      })
      expect(permissionAssertions).toEqual([])
      expect(Option.isNone(yield* loadAction("call-bigint").pipe(Effect.option))).toBe(true)

      // Reusing the same toolCallId afterwards with canonical input must work
      // normally: the fail-closed path left no stale authorization entry.
      yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!({ path: "after.txt" }, { toolCallId: "call-bigint", messages: [] }),
      )
      const action = yield* loadAction("call-bigint")
      expect(action.action.intentDigest).toBe(expectedIntent("call-bigint", { path: "after.txt" }, test.directory))
    }),
  )

  it.instance("uses the active Location, not the worktree, as the external-directory boundary", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      permissionAssertions.length = 0
      // The worktree root is a sibling of the active Location; a target
      // inside the Location must not produce a spurious external_directory
      // preflight request that would block the atomic grant.
      const tools = yield* resolveTools(path.join(test.directory, "..", "unrelated-worktree"))
      yield* Effect.promise(() =>
        tools["custom_tool"]!.execute!(
          { filePath: path.join(test.directory, "inside.txt"), content: "x" },
          { toolCallId: "call-guard-boundary", messages: [] },
        ),
      )
      expect((yield* loadAction("call-guard-boundary")).action.intentDigest).toBe(
        expectedIntent(
          "call-guard-boundary",
          { filePath: path.join(test.directory, "inside.txt"), content: "x" },
          path.join(test.directory, "..", "unrelated-worktree"),
          test.directory,
        ),
      )
      expect(permissionAssertions).toHaveLength(1)
    }),
  )

  it.instance("propagates the provider AbortSignal into the canonical Core execution", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = yield* resolveTools(test.directory)
      const controller = new AbortController()
      const running = tools["cancel_tool"]!.execute!(
        {},
        { toolCallId: "call-provider-cancel", messages: [], abortSignal: controller.signal },
      )
      for (let attempt = 0; attempt < 20 && !cancelStarted; attempt++) yield* Effect.sleep("5 millis")
      expect(cancelStarted).toBe(true)
      controller.abort("user cancelled the provider turn")
      const exit = yield* Effect.promise(() => running).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(cancelObserved).toBe(true)
      expect(hookEvents.filter((name) => name === "tool.execute.before")).toHaveLength(1)
      expect(hookEvents.filter((name) => name === "tool.execute.after")).toHaveLength(0)
    }),
  )
})
