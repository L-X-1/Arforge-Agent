import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { ResponseMessage } from "@modelcontextprotocol/sdk/shared/responseMessage.js"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { ConfigMCP } from "@arforge-ai/core/config/mcp"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Cause, DateTime, Effect, Fiber } from "effect"
import { Plugin } from "@/plugin"
import {
  isMcpTaskID,
  MCP_CHILD_ACTION_RESOURCE,
  MCP_SERVER_RESOURCE_PREFIX,
  MCP_TASK_RESOURCE_PREFIX,
} from "./reconciliation"
import { TransportOutcomeUnknownError } from "./transport-error"
import { McpCatalog } from "./catalog"

export { TransportOutcomeUnknownError } from "./transport-error"

/**
 * Auditable scope evidence declared by the MCP server configuration. The
 * canonical transport endpoint (resolved URL origin for remote, executable
 * identity for local), credential IDENTIFIER names (never values), and the
 * external service identity are bound into the child action semantics.
 */
export type DeclaredMcpScopes = {
  readonly endpoint: string
  readonly networkScope: ReadonlyArray<string>
  readonly secretScope: ReadonlyArray<string>
  readonly externalServices: ReadonlyArray<string>
}

export type McpGatewayAdapterInput = {
  readonly gateway: Pick<ActionGateway.Interface, "execute">
  readonly plugin: Plugin.Interface
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  /** Deterministic per-invocation identity, bound into the child action ID and tool call ID. */
  readonly invocation: string
  /** The durable action that owns this MCP call; the child action binds to it. */
  readonly parentActionID: AgentRuntime.ActionID
  readonly parentRunID?: AgentRuntime.RunID
  /** Native configured server name. */
  readonly server: string
  /** Exposed tool key (sanitized server + "_" + tool), also the permission key. */
  readonly key: string
  /** Native MCP tool name as registered on the server. */
  readonly toolName: string
  readonly client: Pick<Client, "callTool"> & {
    readonly experimental?: {
      readonly tasks?: Pick<NonNullable<Client["experimental"]>["tasks"], "callToolStream">
    }
  }
  readonly args: Record<string, unknown>
  readonly timeout?: number
  readonly abort: AbortSignal
  readonly traceID?: string
  /** Optional server-issued task ID, persisted for read-only `tasks/get`. */
  readonly taskID?: string
  /**
   * Declared network, secret, and service scopes plus the canonical transport
   * endpoint. Required: when scope evidence is unavailable the call blocks
   * before any permission request, plugin hook, or transport call — a human
   * prompt cannot substitute for missing auditable scope evidence.
   */
  readonly declaredScopes?: DeclaredMcpScopes
  /**
   * The normal session path emits child-call plugin hooks here.  When the
   * call is already materialized as a first-class Tool.Def, the outer shared
   * tool pipeline owns those hooks and sets this to false to avoid duplicate
   * before/after notifications.
   */
  readonly emitHooks?: boolean
  /** Re-checks the generation-bound capability immediately before transport. */
  readonly assertCurrent?: () => Effect.Effect<void, unknown>
}

/**
 * Shared child-action request seam for every generation-bound MCP capability.
 * Tools, prompts, resources and resource templates use the same authorization,
 * canonical identity and durable observation path; only the protocol operation
 * and result codec differ.
 */
export type McpGatewayRequestInput<A = unknown> = {
  readonly gateway: Pick<ActionGateway.Interface, "execute">
  readonly plugin: Plugin.Interface
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly invocation: string
  readonly parentActionID: AgentRuntime.ActionID
  readonly parentRunID?: AgentRuntime.RunID
  readonly server: string
  readonly key: string
  readonly operation: string
  /** Stable resource label kept for compatibility with tool-call audits. */
  readonly resourceLabel?: string
  readonly args: Record<string, unknown>
  readonly abort: AbortSignal
  readonly traceID?: string
  /** Optional server-issued task ID, persisted for read-only `tasks/get`. */
  readonly taskID?: string
  readonly declaredScopes?: DeclaredMcpScopes
  readonly emitHooks?: boolean
  /** Re-checks the generation-bound capability immediately before transport. */
  readonly assertCurrent?: () => Effect.Effect<void, unknown>
  /** Protocol request body. It runs inside the durable child action. */
  readonly execute: (context?: ActionGateway.OperationExecutionContext) => Effect.Effect<A, unknown, never>
  /** Validates/normalizes a replayed or freshly returned protocol result. */
  readonly decode: (value: unknown) => A
}

const unique = (values: ReadonlyArray<string>) =>
  values.filter((value, index) => value.length > 0 && values.indexOf(value) === index)

/**
 * Every undeclared MCP call runs at fresh L3 human approval with the resolved
 * scopes bound into its semantics. There is no public way to lower the risk
 * tier from this argument surface: future lowering must come from a trusted
 * capability registry service, not from a caller-supplied semantics object.
 */
const l3Semantics = (input: {
  readonly server: string
  readonly key: string
  readonly networkScope: ReadonlyArray<string>
  readonly secretScope: ReadonlyArray<string>
  readonly externalServices: ReadonlyArray<string>
}) =>
  AgentRuntime.EffectSemantics.make({
    riskTier: "L3",
    authority: "human",
    idempotency: "non_idempotent",
    retryability: "never",
    reversibility: "irreversible",
    filesystemScope: [],
    networkScope: [...input.networkScope],
    secretScope: [...input.secretScope],
    externalServices: [input.server, ...input.externalServices],
    expectedArtifacts: [],
    successCriteria: [`${input.key} returned a validated MCP call result`],
  })

/**
 * Executes one real MCP call as one child Durable Action through the shared
 * Action Gateway. The child action binds the parent action/run, the exact
 * external service, the resolved transport endpoint, any declared credential
 * or secret scope, the native server and tool names, the canonical argument
 * digest, and the invocation identity — all in the canonical permission
 * request set and the effect semantics. The raw unpersisted client.callTool
 * path is never used directly by callers.
 */
export const mcpRequestViaGateway = <A>(input: McpGatewayRequestInput<A>) =>
  Effect.gen(function* () {
    if (!input.declaredScopes) {
      return yield* Effect.fail(
        new Error(
          `MCP scope resolution failed for ${input.server}/${input.key}: the call was blocked before any permission request, plugin hook, or transport call.`,
        ),
      )
    }
    // The shared type-tagged canonical hash of the full decoded arguments is
    // bound into the child action identity. Non-canonicalizable input fails
    // closed before the gateway, any permission request, attempt, plugin hook,
    // or transport call; no durable identity is minted and raw input is never
    // logged.
    const argsDigest = canonicalHash(input.args)
    if (argsDigest === undefined) {
      RuntimeInsight.auditRecord({
        actor: "agent",
        action: "action.authorization.failed",
        resource: input.key,
        reason: "non-canonicalizable MCP arguments",
        metadata: {
          sessionID: input.sessionID,
          server: input.server,
          operation: input.operation,
          invocation: input.invocation,
          parentActionID: input.parentActionID,
        },
      })
      return yield* Effect.fail(
        new Error(
          `MCP scope resolution failed for ${input.server}/${input.key}: the call arguments are not canonically hashable and cannot be executed.`,
        ),
      )
    }
    if (input.taskID !== undefined && !isMcpTaskID(input.taskID))
      return yield* Effect.fail(
        new Error(
          `MCP operation reference for ${input.server}/${input.operation} is invalid; the call was blocked before any permission request or transport call.`,
        ),
      )
    const scopes = input.declaredScopes
    const endpoint = scopes.endpoint
    const networkScope = unique(scopes.networkScope)
    const secretScope = unique(scopes.secretScope)
    const externalServices = unique([input.server, ...scopes.externalServices])
    const invocationResources = unique([
      MCP_CHILD_ACTION_RESOURCE,
      `${MCP_SERVER_RESOURCE_PREFIX}${input.server}`,
      input.server,
      ...externalServices,
      `transport:${endpoint}`,
      ...networkScope,
      ...secretScope,
      input.resourceLabel ?? `mcp:${input.operation}`,
      `args:${argsDigest}`,
      `invocation:${input.invocation}`,
      ...(input.taskID ? [`${MCP_TASK_RESOURCE_PREFIX}${input.taskID}`] : []),
    ])
    const actionID = ActionGateway.stableChildActionID({
      parentActionID: input.parentActionID,
      server: input.server,
      tool: input.operation,
      argsDigest,
      invocation: input.invocation,
    })
    const semantics = l3Semantics({
      server: input.server,
      key: input.key,
      networkScope,
      secretScope,
      externalServices: scopes.externalServices,
    })
    const resources = [
      ...new Set([
        MCP_CHILD_ACTION_RESOURCE,
        `${MCP_SERVER_RESOURCE_PREFIX}${input.server}`,
        input.key,
        input.server,
        input.operation,
        `args:${argsDigest}`,
        `invocation:${input.invocation}`,
        ...(input.taskID ? [`${MCP_TASK_RESOURCE_PREFIX}${input.taskID}`] : []),
        `transport:${endpoint}`,
        ...networkScope,
        ...secretScope,
      ]),
    ]
    return yield* input.gateway.execute(
      {
        actionID,
        ...(input.parentRunID ? { runID: input.parentRunID } : {}),
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.invocation,
        name: input.key,
        resources,
        semantics,
        reasonSummary: `MCP 调用 ${input.key}（经由共享网关适配器）`,
        initiator: "agent",
        traceID: input.traceID ?? input.parentRunID ?? input.parentActionID,
        parentActionID: input.parentActionID,
        inputDigest: argsDigest,
      },
      {
        authorization: {
          requests: [{ action: input.key, resources: invocationResources }],
          metadata: {
            source: "mcp-gateway-adapter",
            server: input.server,
            operation: input.operation,
            ...(input.resourceLabel?.startsWith("tool:") ? { tool: input.operation } : {}),
            argsDigest,
            invocation: input.invocation,
            parentActionID: input.parentActionID,
            transport: endpoint,
            networkScope,
            secretScope,
            externalServices,
          },
        },
        execute: (_capability, context) =>
          Effect.gen(function* () {
            // Authorization and catalog lookup can yield to a reconnect. The
            // final generation check belongs inside the durable child action,
            // immediately before the protocol side effect, so a stale Client
            // can never be used merely because its earlier check succeeded.
            if (input.assertCurrent) yield* input.assertCurrent()
            if (input.emitHooks !== false)
              yield* input.plugin.trigger(
                "tool.execute.before",
                { tool: input.key, sessionID: input.sessionID, callID: input.invocation },
                { args: structuredClone(input.args) },
              )
            const raw = yield* input.execute(context)
            return input.decode(raw)
          }),
        ...(input.emitHooks !== false
          ? {
              afterSuccess: (value: A) =>
                Effect.gen(function* () {
                  if (input.abort.aborted) return yield* Effect.interrupt
                  // The original Gateway has already committed the validated
                  // wire result and supplies a detached copy. Hook mutation,
                  // failure or cancellation cannot replace that durable fact.
                  const hook = yield* Effect.suspend(() =>
                    input.plugin.trigger(
                      "tool.execute.after",
                      {
                        tool: input.key,
                        sessionID: input.sessionID,
                        callID: input.invocation,
                        args: structuredClone(input.args),
                      },
                      value,
                    ),
                  ).pipe(Effect.forkChild)
                  yield* Effect.raceFirst(
                    Fiber.join(hook),
                    Effect.callback<never>((resume) => {
                      const abort = () => resume(Effect.interrupt)
                      input.abort.addEventListener("abort", abort, { once: true })
                      if (input.abort.aborted) abort()
                      return Effect.sync(() => input.abort.removeEventListener("abort", abort))
                    }),
                  ).pipe(Effect.ensuring(Fiber.interrupt(hook)))
                }),
            }
          : {}),
        successSummary: () => `${input.key} returned a validated MCP ${input.operation} result`,
        outcomeUnknownOnFailure: (error) => error instanceof TransportOutcomeUnknownError,
        durableResult: {
          encode: (value: A) => value,
          decode: input.decode,
        },
      },
    )
  })

/**
 * Executes one real MCP tool call as one child Durable Action through the
 * generic MCP request seam. The raw unpersisted client.callTool path is never
 * used directly by callers.
 */
export const mcpCallViaGateway = Effect.fn("MCPGatewayAdapter.call")(function* (input: McpGatewayAdapterInput) {
  return yield* mcpRequestViaGateway<CallToolResult>({
    gateway: input.gateway,
    plugin: input.plugin,
    sessionID: input.sessionID,
    agent: input.agent,
    assistantMessageID: input.assistantMessageID,
    invocation: input.invocation,
    parentActionID: input.parentActionID,
    ...(input.parentRunID ? { parentRunID: input.parentRunID } : {}),
    server: input.server,
    key: input.key,
    operation: input.toolName,
    resourceLabel: `tool:${input.toolName}`,
    args: input.args,
    abort: input.abort,
    ...(input.traceID ? { traceID: input.traceID } : {}),
    ...(input.taskID ? { taskID: input.taskID } : {}),
    ...(input.declaredScopes ? { declaredScopes: input.declaredScopes } : {}),
    ...(input.emitHooks === undefined ? {} : { emitHooks: input.emitHooks }),
    ...(input.assertCurrent === undefined ? {} : { assertCurrent: input.assertCurrent }),
    execute: (context) => {
      let dispatched = false
      const unknown = () =>
        new TransportOutcomeUnknownError({
          server: input.server,
          key: input.key,
          operation: input.toolName,
        })
      const operation = Effect.scoped(
        Effect.gen(function* () {
          const budget = yield* Effect.acquireRelease(
            Effect.try({
              try: () => McpCatalog.openDeadline(input.timeout ?? ConfigMCP.DefaultTimeout, input.abort),
              catch: (error) => error,
            }),
            (budget) => Effect.sync(() => budget.close()),
          )
          const options = {
            resetTimeoutOnProgress: true,
            signal: budget.signal,
            timeout: budget.remaining(),
            maxTotalTimeout: budget.remaining(),
            // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
            onprogress: () => {},
          }
          const tasks = input.client.experimental?.tasks
          if (!tasks) {
            const raw = yield* Effect.tryPromise({
              try: (signal) =>
                budget.run(() => {
                  dispatched = true
                  return input.client.callTool(
                    { name: input.toolName, arguments: input.args },
                    CallToolResultSchema,
                    options,
                  )
                }, signal),
              catch: unknown,
            })
            if (raw.isError)
              return yield* Effect.fail(
                new Error(
                  raw.content
                    .flatMap((item) => (item.type === "text" ? [item.text] : []))
                    .filter((text) => text.trim())
                    .join("\n\n") || "MCP tool returned an error",
                ),
              )
            return raw
          }

          if (!context)
            return yield* Effect.fail(
              new Error(`MCP task operation ${input.key} requires the shared Action Gateway execution context`),
            )

          let result: CallToolResult | undefined
          let boundTaskID: string | undefined
          let terminalFailure: "failed" | "cancelled" | undefined
          const iterator = tasks.callToolStream(
            { name: input.toolName, arguments: input.args },
            CallToolResultSchema,
            options,
          )
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              // The pinned SDK patch aborts both requests and polling sleep.
              // Cancel before joining iterator cleanup; do not abandon a
              // pending iterator behind an already-rejected deadline race.
              budget.close()
              await iterator.return(undefined).catch(() => undefined)
            }),
          )
          while (true) {
            const next = yield* Effect.tryPromise({
              try: (signal) =>
                budget.run(() => {
                  dispatched = true
                  return iterator.next()
                }, signal),
              catch: unknown,
            })
            if (next.done) break
            const message: ResponseMessage<CallToolResult> = next.value
            yield* Effect.gen(function* () {
              if (message.type === "taskCreated") {
                const taskID = message.task.taskId
                if (!isMcpTaskID(taskID))
                  return yield* new TransportOutcomeUnknownError({
                    server: input.server,
                    key: input.key,
                    operation: input.toolName,
                  })
                if (boundTaskID !== undefined) {
                  if (boundTaskID !== taskID)
                    return yield* new TransportOutcomeUnknownError({
                      server: input.server,
                      key: input.key,
                      operation: input.toolName,
                    })
                  return
                }
                boundTaskID = taskID
                yield* context
                  .bindExternalOperation({
                    version: 1,
                    kind: "mcp_task",
                    server: input.server,
                    operation: input.toolName,
                    taskID,
                    boundAt: yield* DateTime.now,
                  })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new TransportOutcomeUnknownError({
                          server: input.server,
                          key: input.key,
                          operation: input.toolName,
                        }),
                    ),
                  )
                return
              }
              if (message.type === "taskStatus") {
                const taskID = message.task.taskId
                if (!isMcpTaskID(taskID) || boundTaskID !== taskID)
                  return yield* new TransportOutcomeUnknownError({
                    server: input.server,
                    key: input.key,
                    operation: input.toolName,
                  })
                if (message.task.status === "failed" || message.task.status === "cancelled")
                  terminalFailure = message.task.status
                return
              }
              // SDK error messages also wrap request timeouts, disconnects and
              // invalid result schemas. None proves the remote effect failed.
              if (message.type === "error") {
                if (terminalFailure) return yield* Effect.fail(new Error(`MCP task ${terminalFailure}`))
                return yield* unknown()
              }
              try {
                result = CallToolResultSchema.parse(message.result)
              } catch {
                return yield* new TransportOutcomeUnknownError({
                  server: input.server,
                  key: input.key,
                  operation: input.toolName,
                })
              }
            })
          }
          if (!result)
            return yield* new TransportOutcomeUnknownError({
              server: input.server,
              key: input.key,
              operation: input.toolName,
            })
          if (result.isError)
            return yield* Effect.fail(
              new Error(
                result.content
                  .flatMap((item) => (item.type === "text" ? [item.text] : []))
                  .filter((text) => text.trim())
                  .join("\n\n") || "MCP tool returned an error",
              ),
            )
          return result
        }),
      )
      // Transport cancellation is advisory, not proof of remote failure.
      // Keep execution interruptible, then classify a dispatched interruption
      // inside the existing durable action's error channel before settlement.
      return Effect.uninterruptibleMask((restore) =>
        restore(operation).pipe(
          Effect.catchCause((cause) =>
            dispatched && Cause.hasInterruptsOnly(cause) ? Effect.fail(unknown()) : Effect.failCause(cause),
          ),
        ),
      )
    },
    decode: (value) => CallToolResultSchema.parse(value),
  })
})

export * as McpGatewayAdapter from "./gateway-adapter"
