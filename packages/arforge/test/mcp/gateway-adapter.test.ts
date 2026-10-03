import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { Plugin } from "@/plugin"
import { buildDeclaredScope } from "@/mcp"
import { mcpCallViaGateway, type DeclaredMcpScopes, type McpGatewayAdapterInput } from "@/mcp/gateway-adapter"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { testEffect } from "../lib/effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  CallToolRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { setTimeout as delay } from "node:timers/promises"

const authorizationRequests: PermissionV2.AssertInput[] = []
const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" }),
    assert: (input) =>
      Effect.sync(() => authorizationRequests.push(input)).pipe(
        Effect.andThen(
          input.action === "reject" ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const secretLayer = Layer.succeed(
  SecretProvider.Service,
  SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(7), "test-authorization-aes-256-gcm"),
)
const pluginHooks: string[] = []
const pluginLayer = Layer.mock(Plugin.Service, {
  trigger: ((_name: unknown, _input: unknown, output: unknown) =>
    Effect.sync(() => {
      pluginHooks.push(String(_name))
      return output
    })) as Plugin.Interface["trigger"],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableAction.node, ActionGateway.node]), [
    [PermissionV2.node, permissionLayer],
    [SecretProvider.node, secretLayer],
  ]).pipe(Layer.merge(pluginLayer)),
)

const semantics = (riskTier: AgentRuntime.RiskTier) =>
  AgentRuntime.EffectSemantics.make({
    riskTier,
    authority: ActionGateway.authorityFor(riskTier),
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "not_applicable",
    filesystemScope: [],
    networkScope: [],
    secretScope: [],
    externalServices: [],
    expectedArtifacts: [],
    successCriteria: ["operation returns"],
  })

const parentInput = () => {
  const context = {
    sessionID: SessionSchema.ID.create(),
    assistantMessageID: SessionMessage.ID.create(),
    toolCallID: "call-parent",
  }
  return {
    ...context,
    actionID: ActionGateway.stableActionID(context),
    agent: AgentV2.ID.make("build"),
    name: "github_list_issues",
    resources: ["github_list_issues"],
    semantics: semantics("L2"),
    reasonSummary: "parent mcp call",
    inputDigest: "parent-digest",
  }
}

const githubScopes: DeclaredMcpScopes = {
  endpoint: "https://api.github.com",
  networkScope: ["https://api.github.com"],
  secretScope: ["Authorization"],
  externalServices: [],
}

const baseChild = (parent: ReturnType<typeof parentInput>, invocation: string) => ({
  sessionID: parent.sessionID,
  agent: parent.agent,
  assistantMessageID: parent.assistantMessageID,
  invocation,
  parentActionID: parent.actionID,
  server: "github",
  key: "github_list_issues",
  toolName: "list_issues",
  args: { owner: "arforge", repo: "agent" },
  timeout: 5_000,
  abort: new AbortController().signal,
  declaredScopes: githubScopes,
})

function clientRecording(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return {
    callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
      calls.push({ name: params.name, args: (params.arguments ?? {}) as Record<string, unknown> })
      return { content: [{ type: "text" as const, text: "ok" }] }
    },
  }
}

describe("McpGatewayAdapter scope resolution", () => {
  it.effect("binds a canonical redacted remote endpoint and credential identifiers only", () =>
    Effect.gen(function* () {
      const scopes = buildDeclaredScope({
        type: "remote",
        url: "https://api.example.com/mcp?token=SUPER_SECRET#frag",
        headers: { Authorization: "Bearer SUPER_SECRET" },
        oauth: false,
      })
      expect(scopes).toBeDefined()
      const all = JSON.stringify(scopes)
      expect(scopes!.endpoint).toBe("https://api.example.com/mcp")
      expect(scopes!.networkScope).toEqual(["https://api.example.com"])
      expect(scopes!.secretScope).toContain("Authorization")
      expect(all).not.toContain("SUPER_SECRET")
      expect(all).not.toContain("Bearer")
      expect(all).not.toContain("token=")
      expect(all).not.toContain("frag")
    }),
  )

  it.effect("binds environment key identifiers without persisting their values", () =>
    Effect.gen(function* () {
      const scopes = buildDeclaredScope({
        type: "local",
        command: ["node", "server.js"],
        environment: { GITHUB_TOKEN: "SUPER_SECRET" },
      })
      expect(scopes).toBeDefined()
      expect(scopes!.secretScope).toEqual(["GITHUB_TOKEN"])
      expect(JSON.stringify(scopes)).not.toContain("SUPER_SECRET")
    }),
  )

  it.effect("keeps the synchronous local scope free of unsafe configuration digests", () =>
    Effect.gen(function* () {
      const a = buildDeclaredScope({ type: "local", command: ["npx", "server-A", "--token", "SECRET"] })
      const b = buildDeclaredScope({ type: "local", command: ["npx", "server-B", "--token", "SECRET"] })
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      // `buildDeclaredScope` has no protected key, so it must never use an
      // unhashed/config-derived endpoint that could leak or permit guessing
      // of secrets in argv. The effectful MCP Service binds the frozen config
      // with an installation-local HMAC before authorizing a tool call.
      expect(a!.endpoint).toBe("exec:npx")
      expect(a!.endpoint).toBe(b!.endpoint)
      expect(a!.endpoint).not.toContain("server-A")
      expect(b!.endpoint).not.toContain("server-B")
      expect(JSON.stringify(a)).not.toContain("SECRET")
    }),
  )

  it.effect("fails closed when the config or transport endpoint cannot be resolved", () =>
    Effect.gen(function* () {
      expect(buildDeclaredScope({ type: "remote", url: "not-a-url" })).toBeUndefined()
      expect(buildDeclaredScope({ type: "local", command: [] })).toBeUndefined()
      expect(buildDeclaredScope({ type: "unsupported" as never, command: ["node"] })).toBeUndefined()
    }),
  )

  it.effect("canonical argument digest is order-insensitive and value-sensitive", () =>
    Effect.gen(function* () {
      const first = canonicalHash({ owner: "a", repo: "b", nested: { x: 1, y: 2 } })
      expect(canonicalHash({ nested: { y: 2, x: 1 }, repo: "b", owner: "a" })).toBe(first)
      expect(canonicalHash({ owner: "a", repo: "c", nested: { x: 1, y: 2 } })).not.toBe(first)
    }),
  )
})

describe("McpGatewayAdapter child durable actions", () => {
  it.effect("executes one real MCP call as one child action bound to the parent grant", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const calls: Array<{ name: string; args: Record<string, unknown> }> = []
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const parentGrant = (yield* actions.load(parent.actionID)).authorization
      if (!parentGrant) throw new Error("parent authorization grant was not persisted")

      const result = yield* mcpCallViaGateway({
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, "call/1"),
        client: clientRecording(calls),
      })

      expect(result.content).toEqual([{ type: "text", text: "ok" }])
      expect(calls).toEqual([{ name: "list_issues", args: { owner: "arforge", repo: "agent" } }])
      // The child inherited the validated parent grant: no new permission request.
      expect(authorizationRequests).toHaveLength(1)

      const childActionID = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: canonicalHash(baseChild(parent, "call/1").args)!,
        invocation: "call/1",
      })
      const snapshot = yield* actions.load(childActionID)
      expect(snapshot.action.parentActionID).toBe(parent.actionID)
      expect(snapshot.action.semantics.riskTier).toBe("L3")
      expect(snapshot.action.semantics.networkScope).toEqual(["https://api.github.com"])
      expect(snapshot.action.semantics.secretScope).toEqual(["Authorization"])
      expect(snapshot.action.semantics.externalServices).toEqual(["github"])
      expect(snapshot.action.resources).toContain("transport:https://api.github.com")
      expect(snapshot.action.resources).toContain("args:" + canonicalHash(baseChild(parent, "call/1").args)!)
      expect(snapshot.action.resources).toContain("invocation:call/1")
      expect(snapshot.authorization).toMatchObject({
        parentActionID: parent.actionID,
        parentGrantID: parentGrant.id,
        requests: [
          {
            action: "github_list_issues",
            resources: expect.arrayContaining([
              "github",
              "transport:https://api.github.com",
              "tool:list_issues",
              "invocation:call/1",
            ]),
          },
        ],
      })
    }),
  )

  it.effect("persists a bounded server task reference for read-only reconciliation", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const invocation = "call/task"
      const args = baseChild(parent, invocation).args
      const child = yield* mcpCallViaGateway({
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, invocation),
        taskID: "task-42",
        args,
        client: clientRecording([]),
      })
      expect(child.content).toHaveLength(1)
      const childActionID = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: canonicalHash(args)!,
        invocation,
      })
      const snapshot = yield* actions.load(childActionID)
      expect(snapshot.action.resources).toContain("mcp:child-action")
      expect(snapshot.action.resources).toContain("mcp-server:github")
      expect(snapshot.action.resources).toContain("mcp-task:task-42")
    }),
  )

  it.effect("durably captures the first MCP taskCreated reference without persisting task payloads", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })

      let streamCalls = 0
      let legacyCalls = 0
      const client = {
        callTool: async () => {
          legacyCalls += 1
          throw new Error("legacy callTool must not be selected when task streaming is available")
        },
        experimental: {
          tasks: {
            callToolStream: async function* () {
              streamCalls += 1
              yield {
                type: "taskCreated" as const,
                task: {
                  taskId: "task-auto-42",
                  status: "working" as const,
                  ttl: null,
                  createdAt: "2026-08-30T00:00:00.000Z",
                  lastUpdatedAt: "2026-08-30T00:00:00.000Z",
                },
              }
              yield {
                type: "result" as const,
                result: { content: [{ type: "text" as const, text: "completed" }] },
              }
            },
          },
        },
      } as unknown as McpGatewayAdapterInput["client"]
      const invocation = "call/task-created"
      const args = baseChild(parent, invocation).args
      const child = yield* mcpCallViaGateway({
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, invocation),
        client,
        args,
      })
      expect(child.content).toEqual([{ type: "text", text: "completed" }])
      expect(streamCalls).toBe(1)
      expect(legacyCalls).toBe(0)

      const childActionID = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: canonicalHash(args)!,
        invocation,
      })
      const snapshot = yield* actions.load(childActionID)
      expect(snapshot.externalOperation).toMatchObject({
        version: 1,
        kind: "mcp_task",
        server: "github",
        operation: "list_issues",
        taskID: "task-auto-42",
      })
      expect(snapshot.action.resources).not.toContain("mcp-task:task-auto-42")
      expect(JSON.stringify(snapshot.externalOperation)).not.toContain("completed")
      expect(JSON.stringify(snapshot.externalOperation)).not.toContain("statusMessage")

      const duplicate = yield* actions.bindExternalOperation({
        actionID: childActionID,
        binding: snapshot.externalOperation!,
      })
      expect(duplicate.lastSequence).toBe(snapshot.lastSequence)
      const conflicting = yield* actions
        .bindExternalOperation({
          actionID: childActionID,
          binding: {
            ...snapshot.externalOperation!,
            taskID: "task-auto-43",
          },
        })
        .pipe(Effect.exit)
      expect(conflicting._tag).toBe("Failure")
      expect(String(conflicting)).toContain("DurableAction.ExternalOperationBindingMismatchError")

      const replay = yield* mcpCallViaGateway({
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, invocation),
        client,
        args,
      })
      expect(replay.content).toEqual(child.content)
      expect(streamCalls).toBe(1)
      expect(legacyCalls).toBe(0)
    }),
  )

  it.effect("creates two child actions for two intentional identical calls", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const calls: Array<{ name: string; args: Record<string, unknown> }> = []
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })

      yield* mcpCallViaGateway({
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, "call/1"),
        client: clientRecording(calls),
      })
      yield* mcpCallViaGateway({
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, "call/2"),
        client: clientRecording(calls),
      })

      expect(calls).toHaveLength(2)
      const first = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: canonicalHash(baseChild(parent, "call/1").args)!,
        invocation: "call/1",
      })
      const second = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: canonicalHash(baseChild(parent, "call/1").args)!,
        invocation: "call/2",
      })
      expect(second).not.toBe(first)
      expect((yield* actions.load(first)).action.status).toBe("settled")
      expect((yield* actions.load(second)).action.status).toBe("settled")
    }),
  )

  it.effect("replays the same invocation without repeating the transport call", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const calls: Array<{ name: string; args: Record<string, unknown> }> = []
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const client = clientRecording(calls)
      const child = {
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, "call/1"),
        client,
      }

      const first = yield* mcpCallViaGateway(child)
      const replayed = yield* mcpCallViaGateway(child)

      expect(replayed).toEqual(first)
      expect(calls).toHaveLength(1)
    }),
  )

  for (const mode of ["mutate", "defect", "throw"] as const) {
    it.live(`post-result hook ${mode} cannot change the durable MCP success or replay the transport`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const parent = parentInput()
        yield* gateway.execute(parent, {
          authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
          execute: () => Effect.succeed("parent"),
        })
        const base = baseChild(parent, `call/post-${mode}`)
        const actionID = ActionGateway.stableChildActionID({
          parentActionID: parent.actionID,
          server: base.server,
          tool: base.toolName,
          argsDigest: canonicalHash(base.args)!,
          invocation: base.invocation,
        })
        let calls = 0
        const expected = { content: [{ type: "text" as const, text: "authentic remote result" }] }
        const server = new Server({ name: "post-result", version: "1" }, { capabilities: { tools: {} } })
        server.setRequestHandler(CallToolRequestSchema, async () => {
          calls++
          return expected
        })
        const client = new Client({ name: "post-result-client", version: "1" })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        yield* Effect.acquireRelease(
          Effect.promise(() => Promise.all([client.connect(clientTransport), server.connect(serverTransport)])),
          () => Effect.promise(() => Promise.all([client.close(), server.close()])),
        )
        const hooks: string[] = []
        let hookState: string | undefined
        const plugin = {
          ...(yield* Plugin.Service),
          trigger: ((name: string, hookInput: { args?: Record<string, unknown> }, output: unknown) => {
            hooks.push(name)
            if (name !== "tool.execute.after") return Effect.succeed(output)
            if (mode === "throw") throw new Error("POST_HOOK_PRIVATE_PAYLOAD")
            return Effect.gen(function* () {
              hookState = (yield* actions.load(actionID)).action.status
              if (mode === "defect") return yield* Effect.die(new Error("POST_HOOK_PRIVATE_PAYLOAD"))
              const value = output as { content: Array<{ text: string }> }
              value.content[0]!.text = "forged plugin result"
              hookInput.args!.repo = "forged-repo"
              return output
            })
          }) as Plugin.Interface["trigger"],
        }
        const child = { gateway, plugin, ...base, client }
        const first = yield* mcpCallViaGateway(child).pipe(Effect.exit)
        const snapshot = yield* actions.load(actionID)
        expect(snapshot.action.status).toBe("settled")
        expect(snapshot.observation?.status).toBe("succeeded")
        expect(snapshot.observation?.output?.value).toEqual(expected)
        expect(snapshot.activeAttempt).toBeUndefined()
        expect(base.args).toEqual({ owner: "arforge", repo: "agent" })
        if (mode !== "throw") expect(hookState).toBe("settled")
        if (mode === "mutate") expect(first).toEqual(Exit.succeed(expected))
        else {
          expect(Exit.isFailure(first)).toBe(true)
          expect(String(first)).toContain("ActionGateway.PostProcessingError")
          expect(String(first)).not.toContain("POST_HOOK_PRIVATE_PAYLOAD")
        }
        const replay = yield* mcpCallViaGateway(child)
        expect(replay).toEqual(expected)
        expect(calls).toBe(1)
        expect(hooks).toEqual(["tool.execute.before", "tool.execute.after"])
        expect((yield* actions.load(actionID)).lastSequence).toBe(snapshot.lastSequence)
      }),
    )
  }

  for (const mode of ["signal", "fiber"] as const) {
    it.live(`post-result hook ${mode} cancellation preserves success and joins hook cleanup`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const parent = parentInput()
        yield* gateway.execute(parent, {
          authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
          execute: () => Effect.succeed("parent"),
        })
        const ready = yield* Deferred.make<void>()
        let cleaned = false
        let afterCalls = 0
        const plugin = {
          ...(yield* Plugin.Service),
          trigger: ((name: string, _input: unknown, output: unknown) => {
            if (name !== "tool.execute.after") return Effect.succeed(output)
            afterCalls++
            return Deferred.succeed(ready, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true
                }),
              ),
            )
          }) as Plugin.Interface["trigger"],
        }
        const calls: Array<{ name: string; args: Record<string, unknown> }> = []
        const abort = new AbortController()
        const child = {
          gateway,
          plugin,
          ...baseChild(parent, `call/post-cancel-${mode}`),
          client: clientRecording(calls),
          abort: abort.signal,
        }
        const fiber = yield* mcpCallViaGateway(child).pipe(Effect.forkChild)
        yield* Deferred.await(ready).pipe(Effect.timeout(2000))
        if (mode === "signal") abort.abort("fixture cancellation")
        else yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber).pipe(Effect.timeout(2000))
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(cleaned).toBe(true)
        const actionID = ActionGateway.stableChildActionID({
          parentActionID: parent.actionID,
          server: child.server,
          tool: child.toolName,
          argsDigest: canonicalHash(child.args)!,
          invocation: child.invocation,
        })
        const snapshot = yield* actions.load(actionID)
        expect(snapshot.action.status).toBe("settled")
        expect(snapshot.observation?.status).toBe("succeeded")
        expect(snapshot.activeAttempt).toBeUndefined()
        const replay = yield* mcpCallViaGateway({ ...child, abort: new AbortController().signal })
        expect(replay.content).toEqual([{ type: "text", text: "ok" }])
        expect(calls).toHaveLength(1)
        expect(afterCalls).toBe(1)
        expect((yield* actions.load(actionID)).lastSequence).toBe(snapshot.lastSequence)
      }),
    )
  }

  it.effect("records a disconnected child transport as outcome_unknown and refuses invocation replay", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })

      let transportCalls = 0
      const client = {
        callTool: async () => {
          transportCalls += 1
          throw new Error("MCP connection closed after dispatch")
        },
      }
      const child = {
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, "call/disconnected"),
        client,
      }

      const first = yield* mcpCallViaGateway(child).pipe(Effect.exit)
      expect(String(first)).toContain("ActionGateway.RecoveryRequiredError")
      const childActionID = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: canonicalHash(baseChild(parent, "call/disconnected").args)!,
        invocation: "call/disconnected",
      })
      const snapshot = yield* actions.load(childActionID)
      expect(snapshot.action.status).toBe("blocked")
      expect(snapshot.observation).toBeUndefined()
      expect(snapshot.activeAttempt).toBeUndefined()
      const recovery = yield* gateway.inspectRecovery!({ actionID: childActionID })
      expect(recovery.state).toBe("outcome_unknown")
      expect(recovery.repair.required).toBe(true)

      const replay = yield* mcpCallViaGateway(child).pipe(Effect.exit)
      expect(String(replay)).toContain("ActionGateway.BlockedError")
      const replayReason = Exit.isFailure(replay)
        ? String((Cause.squash(replay.cause) as { readonly reason?: unknown }).reason ?? "")
        : ""
      expect(replayReason).toContain("Tool outcome is unknown")
      expect(transportCalls).toBe(1)
    }),
  )

  for (const mode of ["call", "stream"] as const) {
    it.live(`real SDK ${mode} progress deadline is unknown and never dispatches the invocation again`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const parent = parentInput()
        yield* gateway.execute(parent, {
          authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
          execute: () => Effect.succeed("parent"),
        })
        let calls = 0
        let progress = 0
        const server = new Server({ name: "progress", version: "1" }, { capabilities: { tools: {} } })
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          calls++
          for (let index = 0; index < 15; index++) {
            await delay(20, undefined, { signal: extra.signal })
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken: request.params._meta!.progressToken!, progress: ++progress },
            })
          }
          return { content: [{ type: "text", text: "late success" }] }
        })
        const client = new Client({ name: "progress-client", version: "1" })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        yield* Effect.acquireRelease(
          Effect.promise(() => Promise.all([client.connect(clientTransport), server.connect(serverTransport)])),
          () => Effect.promise(() => Promise.all([client.close(), server.close()])),
        )
        const child = {
          gateway,
          plugin: yield* Plugin.Service,
          ...baseChild(parent, `call/progress-${mode}`),
          timeout: 100,
          client: mode === "call" ? { callTool: client.callTool.bind(client) } : client,
        }
        const first = yield* mcpCallViaGateway(child).pipe(Effect.exit)
        expect(String(first)).toContain("ActionGateway.RecoveryRequiredError")
        const actionID = ActionGateway.stableChildActionID({
          parentActionID: parent.actionID,
          server: child.server,
          tool: child.toolName,
          argsDigest: canonicalHash(child.args)!,
          invocation: child.invocation,
        })
        const snapshot = yield* actions.load(actionID)
        expect(snapshot.observation).toBeUndefined()
        expect(snapshot.activeAttempt).toBeUndefined()
        expect((yield* gateway.inspectRecovery!({ actionID })).state).toBe("outcome_unknown")
        const replay = yield* mcpCallViaGateway(child).pipe(Effect.exit)
        expect(String(replay)).toContain("ActionGateway.BlockedError")
        expect(calls).toBe(1)
        expect(progress).toBeGreaterThan(0)
        expect(progress).toBeLessThan(15)
      }),
    )
  }

  for (const scenario of ["polling", "sleep", "result", "disconnect", "failed", "cancelled", "success"] as const) {
    it.live(`real SDK task ${scenario} preserves its durable reference and has a bounded non-replaying outcome`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const parent = parentInput()
        yield* gateway.execute(parent, {
          authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
          execute: () => Effect.succeed("parent"),
        })
        let calls = 0
        let polls = 0
        let results = 0
        const taskID = `budget-task-${scenario}`
        const task = {
          taskId: taskID,
          status: "working" as const,
          ttl: null,
          createdAt: "2026-09-13T00:00:00Z",
          lastUpdatedAt: "2026-09-13T00:00:00Z",
          pollInterval: scenario === "sleep" ? 1500 : 20,
        }
        const server = new Server(
          { name: "task-budget", version: "1" },
          {
            capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
          },
        )
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: "list_issues", inputSchema: { type: "object" }, execution: { taskSupport: "required" } }],
        }))
        server.setRequestHandler(CallToolRequestSchema, async () => {
          calls++
          return { task }
        })
        server.setRequestHandler(GetTaskRequestSchema, async () => {
          polls++
          if (scenario === "disconnect") throw new Error("fixture task status transport error")
          const status =
            scenario === "failed" || scenario === "cancelled"
              ? scenario
              : scenario === "result" || scenario === "success" || polls > 12
                ? "completed"
                : "working"
          return { ...task, status }
        })
        server.setRequestHandler(GetTaskPayloadRequestSchema, async (_request, extra) => {
          results++
          if (scenario === "result") await delay(600, undefined, { signal: extra.signal })
          return { content: [{ type: "text", text: "task success" }] }
        })
        const client = new Client({ name: "task-budget-client", version: "1" })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
            await client.listTools()
          }),
          () => Effect.promise(() => Promise.all([client.close(), server.close()])),
        )
        const child = {
          gateway,
          plugin: yield* Plugin.Service,
          ...baseChild(parent, `call/task-${scenario}`),
          client,
          timeout: 100,
        }
        const start = performance.now()
        const first = yield* mcpCallViaGateway(child).pipe(Effect.exit)
        expect(performance.now() - start).toBeLessThan(1000)
        const actionID = ActionGateway.stableChildActionID({
          parentActionID: parent.actionID,
          server: child.server,
          tool: child.toolName,
          argsDigest: canonicalHash(child.args)!,
          invocation: child.invocation,
        })
        const snapshot = yield* actions.load(actionID)
        expect(snapshot.externalOperation?.taskID).toBe(taskID)
        expect(snapshot.activeAttempt).toBeUndefined()
        const known = scenario === "failed" || scenario === "cancelled" || scenario === "success"
        if (known) {
          expect(String(first)).not.toContain("RecoveryRequiredError")
          expect(Exit.isSuccess(first)).toBe(scenario === "success")
        } else {
          expect(String(first)).toContain("ActionGateway.RecoveryRequiredError")
          expect((yield* gateway.inspectRecovery!({ actionID })).state).toBe("outcome_unknown")
          expect(snapshot.observation).toBeUndefined()
        }
        const counts = { calls, polls, results }
        const replay = yield* mcpCallViaGateway(child).pipe(Effect.exit)
        if (!known) expect(String(replay)).toContain("ActionGateway.BlockedError")
        expect({ calls, polls, results }).toEqual(counts)
        expect(calls).toBe(1)
        if (scenario === "polling") {
          expect(polls).toBeGreaterThan(1)
          expect(polls).toBeLessThan(13)
        }
        if (scenario === "sleep") {
          // Let the SDK's non-abortable sleep unwind, then verify it sends no
          // further status/result requests after the caller has recovered.
          yield* Effect.promise(() => delay(1600))
          expect({ calls, polls, results }).toEqual(counts)
        }
      }),
    )
  }

  for (const mode of ["signal", "fiber"] as const) {
    it.live(`real SDK ${mode} cancellation after dispatch remains unknown instead of a false failure`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const parent = parentInput()
        yield* gateway.execute(parent, {
          authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
          execute: () => Effect.succeed("parent"),
        })
        let calls = 0
        let started!: () => void
        const ready = new Promise<void>((resolve) => {
          started = resolve
        })
        let cancelled!: () => void
        const stopped = new Promise<void>((resolve) => {
          cancelled = resolve
        })
        const server = new Server({ name: "cancel", version: "1" }, { capabilities: { tools: {} } })
        server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
          calls++
          started()
          try {
            await delay(5000, undefined, { signal: extra.signal })
          } finally {
            if (extra.signal.aborted) cancelled()
          }
          return { content: [{ type: "text", text: "late" }] }
        })
        const client = new Client({ name: "cancel-client", version: "1" })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        yield* Effect.acquireRelease(
          Effect.promise(() => Promise.all([client.connect(clientTransport), server.connect(serverTransport)])),
          () => Effect.promise(() => Promise.all([client.close(), server.close()])),
        )
        const abort = new AbortController()
        const child = {
          gateway,
          plugin: yield* Plugin.Service,
          ...baseChild(parent, `call/cancel-${mode}`),
          client,
          abort: abort.signal,
        }
        const fiber = yield* mcpCallViaGateway(child).pipe(Effect.exit, Effect.forkChild)
        yield* Effect.promise(() => ready).pipe(Effect.timeout(2000))
        if (mode === "fiber") yield* Fiber.interrupt(fiber)
        else {
          abort.abort(new Error("fixture user cancellation"))
          yield* Fiber.join(fiber)
        }
        yield* Effect.promise(() => stopped).pipe(Effect.timeout(1000))
        const actionID = ActionGateway.stableChildActionID({
          parentActionID: parent.actionID,
          server: child.server,
          tool: child.toolName,
          argsDigest: canonicalHash(child.args)!,
          invocation: child.invocation,
        })
        expect((yield* gateway.inspectRecovery!({ actionID })).state).toBe("outcome_unknown")
        expect((yield* actions.load(actionID)).observation).toBeUndefined()
        const replay = yield* mcpCallViaGateway({ ...child, abort: new AbortController().signal }).pipe(Effect.exit)
        expect(String(replay)).toContain("ActionGateway.BlockedError")
        expect(calls).toBe(1)
      }),
    )
  }

  it.effect("ignores any caller-supplied risk override and stays at fresh L3 with the full declared scope", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const calls: Array<{ name: string; args: Record<string, unknown> }> = []
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const l0Override = semantics("L0")
      const result = yield* mcpCallViaGateway({
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, "call/1"),
        client: clientRecording(calls),
        // A caller-supplied lowering override must be ignored: the adapter
        // has no trusted-semantics capability in this batch.
        semantics: l0Override,
      } as never)

      expect(result).toBeDefined()
      const childActionID = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: canonicalHash(baseChild(parent, "call/1").args)!,
        invocation: "call/1",
      })
      const snapshot = yield* actions.load(childActionID)
      expect(snapshot.action.semantics.riskTier).toBe("L3")
      expect(snapshot.action.semantics.authority).toBe("human")
      expect(snapshot.action.semantics.networkScope).toEqual(["https://api.github.com"])
      expect(snapshot.action.semantics.secretScope).toEqual(["Authorization"])
      expect(snapshot.action.semantics.externalServices).toEqual(["github"])
    }),
  )

  it.effect("blocks before any permission, plugin, or transport call when scope evidence is missing", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      pluginHooks.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const calls: Array<{ name: string; args: Record<string, unknown> }> = []
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const exit = yield* mcpCallViaGateway({
        gateway,
        plugin: yield* Plugin.Service,
        ...baseChild(parent, "call/1"),
        client: clientRecording(calls),
        declaredScopes: undefined,
      }).pipe(Effect.exit)

      expect(String(exit)).toContain("MCP scope resolution failed")
      expect(authorizationRequests).toHaveLength(1)
      expect(pluginHooks).toEqual([])
      expect(calls).toHaveLength(0)
      const childActionID = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: canonicalHash(baseChild(parent, "call/1").args)!,
        invocation: "call/1",
      })
      expect(yield* actions.load(childActionID).pipe(Effect.option)).toEqual(Option.none())
    }),
  )

  it.effect("fails closed on non-canonicalizable arguments with no shared replay identity", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      pluginHooks.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const calls: Array<{ name: string; args: Record<string, unknown> }> = []
      const parent = parentInput()
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })

      for (const [index, args] of [{ data: 1n }, { data: 2n }].entries()) {
        const exit = yield* mcpCallViaGateway({
          gateway,
          plugin: yield* Plugin.Service,
          ...baseChild(parent, `call/1`),
          client: clientRecording(calls),
          args: args as unknown as Record<string, unknown>,
        }).pipe(Effect.exit)

        expect(String(exit), `variant ${index}`).toContain("not canonically hashable")
      }
      // Fail closed before the gateway, any permission request, plugin hook,
      // or transport call — and no durable identity is minted, so two
      // distinct non-canonicalizable inputs can never share a replay identity.
      expect(authorizationRequests).toHaveLength(1)
      expect(pluginHooks).toEqual([])
      expect(calls).toHaveLength(0)
      const childActionID = ActionGateway.stableChildActionID({
        parentActionID: parent.actionID,
        server: "github",
        tool: "list_issues",
        argsDigest: "0".repeat(64),
        invocation: "call/1",
      })
      expect(yield* actions.load(childActionID).pipe(Effect.option)).toEqual(Option.none())
    }),
  )
})
