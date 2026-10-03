import { writeFileSync } from "node:fs"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { ReconciliationRegistry } from "@arforge-ai/core/runtime/reconciliation"
import { Effect, Exit, Layer } from "effect"
import { Plugin } from "../../src/plugin"
import { mcpCallViaGateway, type McpGatewayAdapterInput } from "../../src/mcp/gateway-adapter"
import { createMcpReconciliationAdapter, createMcpTaskReconciliationLookup } from "../../src/mcp/reconciliation"
import { runtimeLayer } from "../../../core/test/fixture/action-crash-contract"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { setTimeout as delay } from "node:timers/promises"

const [databasePath, mode, markerPath] = Bun.argv.slice(2)
if (
  !databasePath ||
  !mode ||
  !markerPath ||
  ![
    "seed",
    "read",
    "seed-task",
    "read-task",
    "seed-timeout-kill",
    "read-timeout",
    "seed-hook-kill",
    "read-hook",
  ].includes(mode)
)
  throw new Error("MCP reconciliation worker requires database, mode and marker paths")

const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () => Effect.succeed([]),
  }),
)

const parentContext = {
  sessionID: SessionSchema.ID.make("ses_mcp_cold_reconcile"),
  assistantMessageID: SessionMessage.ID.make("msg_mcp_cold_reconcile"),
  toolCallID: "call_mcp_cold_reconcile_parent",
}

const semantics = AgentRuntime.EffectSemantics.make({
  riskTier: "L3",
  authority: "human",
  idempotency: "non_idempotent",
  retryability: "never",
  reversibility: "irreversible",
  filesystemScope: [],
  networkScope: ["https://mcp.example.test"],
  secretScope: ["MCP_TOKEN"],
  externalServices: ["cold-mcp"],
  expectedArtifacts: [],
  successCriteria: ["MCP response is observed"],
})

const parent = {
  ...parentContext,
  actionID: ActionGateway.stableActionID(parentContext),
  agent: AgentV2.ID.make("build"),
  name: "cold-mcp-parent",
  resources: ["cold_mcp_call"],
  semantics,
  reasonSummary: "MCP cold reconciliation fixture parent",
  inputDigest: "cold-mcp-parent-input",
} as const

const args = { operation: "publish", value: "fixture" }
const declaredScopes = {
  endpoint: "https://mcp.example.test",
  networkScope: ["https://mcp.example.test"],
  secretScope: ["MCP_TOKEN"],
  externalServices: ["cold-mcp"],
} as const

const runSeed = Effect.gen(function* () {
  const gateway = yield* ActionGateway.Service
  let plugin = yield* Plugin.Service
  yield* gateway.execute(parent, {
    authorization: { requests: [{ action: "cold_mcp_call", resources: ["*"] }] },
    execute: () => Effect.succeed("parent-ready"),
  })

  let transportCalls = 0
  const invocation = "cold/1"
  const argsDigest = canonicalHash(args)
  if (!argsDigest) throw new Error("cold MCP fixture arguments were not canonicalizable")
  const childActionID = ActionGateway.stableChildActionID({
    parentActionID: parent.actionID,
    server: "cold-mcp",
    tool: "publish",
    argsDigest,
    invocation,
  })
  let client: McpGatewayAdapterInput["client"] =
    mode === "seed-task"
      ? {
          callTool: async () => {
            throw new Error("task stream fixture must not fall back to callTool")
          },
          experimental: {
            tasks: {
              callToolStream: async function* () {
                transportCalls += 1
                yield {
                  type: "taskCreated" as const,
                  task: {
                    taskId: "task-cold-auto-42",
                    status: "working" as const,
                    ttl: null,
                    createdAt: "2026-08-30T00:00:00.000Z",
                    lastUpdatedAt: "2026-08-30T00:00:00.000Z",
                  },
                }
                throw new Error("simulated MCP disconnect after taskCreated")
              },
            },
          },
        }
      : {
          callTool: async () => {
            transportCalls += 1
            throw new Error("simulated MCP disconnect after dispatch")
          },
        }
  if (mode === "seed-timeout-kill" || mode === "seed-hook-kill") {
    const server = new Server({ name: "cold-timeout", version: "1" }, { capabilities: { tools: {} } })
    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      transportCalls++
      if (mode === "seed-timeout-kill") await delay(5000, undefined, { signal: extra.signal })
      return {
        content: [{ type: "text", text: mode === "seed-hook-kill" ? "committed remote result" : "late result" }],
      }
    })
    const sdkClient = new Client({ name: "cold-timeout-client", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    yield* Effect.acquireRelease(
      Effect.promise(() => Promise.all([sdkClient.connect(clientTransport), server.connect(serverTransport)])),
      () => Effect.promise(() => Promise.all([sdkClient.close(), server.close()])),
    )
    client = sdkClient
  }
  if (mode === "seed-hook-kill") {
    const actions = yield* DurableAction.Service
    plugin = {
      ...plugin,
      trigger: ((name: string, _input: unknown, output: unknown) => {
        if (name !== "tool.execute.after") return Effect.succeed(output)
        return Effect.gen(function* () {
          const snapshot = yield* actions.load(childActionID)
          if (
            snapshot.action.status !== "settled" ||
            snapshot.observation?.status !== "succeeded" ||
            snapshot.activeAttempt
          )
            throw new Error("MCP post-result hook started before durable success")
          writeFileSync(
            markerPath,
            JSON.stringify({
              actionID: childActionID,
              intentDigest: snapshot.action.intentDigest,
              idempotencyKey: snapshot.action.idempotencyKey,
              transportCalls,
              hookCalls: 1,
              sequence: snapshot.lastSequence,
              output: snapshot.observation.output?.value,
            }),
            "utf8",
          )
          if (!process.send) throw new Error("cold post-result hook fixture requires parent IPC")
          process.send({ type: "post-result-hook-started" })
          yield* Effect.never
        })
      }) as Plugin.Interface["trigger"],
    }
  }
  const result = yield* mcpCallViaGateway({
    gateway,
    plugin,
    ...parentContext,
    agent: parent.agent,
    invocation,
    parentActionID: parent.actionID,
    server: "cold-mcp",
    key: "cold_mcp_publish",
    toolName: "publish",
    client,
    ...(mode === "seed-timeout-kill" ? { timeout: 100 } : {}),
    args,
    abort: new AbortController().signal,
    declaredScopes,
  }).pipe(Effect.exit)
  if (Exit.isSuccess(result)) throw new Error("cold MCP transport unexpectedly succeeded")

  const snapshot = yield* (yield* DurableAction.Service).load(childActionID)
  if (
    snapshot.action.status !== "blocked" ||
    snapshot.observation !== undefined ||
    snapshot.activeAttempt !== undefined
  )
    throw new Error("cold MCP unknown outcome did not settle as blocked without observation")
  writeFileSync(
    markerPath,
    JSON.stringify({
      actionID: childActionID,
      intentDigest: snapshot.action.intentDigest,
      idempotencyKey: snapshot.action.idempotencyKey,
      transportCalls,
      bindingPresent: snapshot.externalOperation !== undefined,
      ...(mode === "seed-timeout-kill" ? { killedAfterTimeout: true } : {}),
    }),
    "utf8",
  )
  if (mode === "seed-timeout-kill") {
    if (!process.send) throw new Error("cold timeout crash fixture requires its parent IPC channel")
    process.send({ type: "timeout-persisted" })
    // The parent kills this process only after observing the committed marker.
    // No graceful scope or database finalizer runs before that external kill.
    yield* Effect.never
  }
})

const runRead = Effect.gen(function* () {
  const marker = JSON.parse(yield* Effect.promise(() => Bun.file(markerPath).text())) as {
    readonly actionID: string
    readonly intentDigest: string
    readonly idempotencyKey: string
  }
  const actions = yield* DurableAction.Service
  let lookupCalls = 0
  const registry = new ReconciliationRegistry().register(
    createMcpReconciliationAdapter({
      loadAction: async (actionID) => {
        const loaded = await Effect.runPromiseExit(actions.load(AgentRuntime.ActionID.make(actionID)))
        return Exit.isSuccess(loaded) ? loaded.value : undefined
      },
      ...(mode === "read-task"
        ? {
            lookup: createMcpTaskReconciliationLookup({
              now: () => 12_000,
              lookupTask: async () => {
                lookupCalls += 1
                return { status: "completed", observedAt: 11_000 }
              },
            }),
          }
        : {}),
    }),
  )
  const decision = yield* Effect.promise(() =>
    registry.reconcile({
      actionID: marker.actionID,
      actionKind: "mcp",
      actionVersion: "1",
      intentDigest: marker.intentDigest,
      idempotencyKey: marker.idempotencyKey,
    }),
  )
  let transportCalls = 0
  let replayBlocked = false
  let hookCalls = 0
  let replayedOutput: unknown
  if (mode === "read-timeout" || mode === "read-hook") {
    const plugin = yield* Plugin.Service
    const replay = yield* mcpCallViaGateway({
      gateway: yield* ActionGateway.Service,
      plugin: {
        ...plugin,
        trigger: (() => {
          hookCalls++
          return Effect.die(new Error("cold MCP recovery must not replay hooks"))
        }) as Plugin.Interface["trigger"],
      },
      ...parentContext,
      agent: parent.agent,
      invocation: "cold/1",
      parentActionID: parent.actionID,
      server: "cold-mcp",
      key: "cold_mcp_publish",
      toolName: "publish",
      client: {
        callTool: async () => {
          transportCalls++
          throw new Error("cold MCP recovery must not replay transport")
        },
      },
      args,
      abort: new AbortController().signal,
      declaredScopes,
    }).pipe(Effect.exit)
    if (mode === "read-timeout") {
      replayBlocked = String(replay).includes("ActionGateway.BlockedError")
      if (!replayBlocked || transportCalls !== 0) throw new Error("cold timeout replay guard failed")
    } else {
      if (Exit.isFailure(replay)) throw new Error("cold post-result hook recovery could not replay its durable result")
      replayedOutput = replay.value
      if (transportCalls !== 0 || hookCalls !== 0) throw new Error("cold post-result hook recovery repeated an effect")
    }
  }
  writeFileSync(
    markerPath,
    JSON.stringify({
      ...marker,
      decision: {
        kind: decision.kind,
        state: decision.state,
        automaticRetryAllowed: decision.automaticRetryAllowed,
        source: decision.evidence.source,
        evidenceDigest: decision.evidence.evidenceDigest,
        lookupCalls,
      },
      transportCalls,
      ...(mode === "read-timeout" ? { replayBlocked } : {}),
      ...(mode === "read-hook"
        ? {
            hookCalls,
            replayedOutput,
            sequence: (yield* actions.load(AgentRuntime.ActionID.make(marker.actionID))).lastSequence,
          }
        : {}),
    }),
    "utf8",
  )
})

const program = mode.startsWith("seed") ? runSeed : runRead
await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(runtimeLayer(databasePath), pluginLayer))),
)
