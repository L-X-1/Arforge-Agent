import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Plugin } from "@/plugin"
import { permissionPreflight } from "@/session/legacy-tool-authorization"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Tool as MatureTool } from "@/tool/tool"
import { ToolRegistry as MatureToolRegistry } from "@/tool/registry"
import type { TaskExecutionContext, TaskNativeParent, TaskPromptOps, TaskRuntimeValue } from "@/tool/task"
import { ShellPreflight } from "@/tool/shell"
import { makeGlobalNode } from "@arforge-ai/core/effect/app-node"
import { isReservedBuiltInName } from "@arforge-ai/core/tool/authorization-plan"
import { automaticRead, forToolCall, scopedChange } from "@arforge-ai/core/tool/effect-semantics"
import type { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { Tool as CoreTool } from "@arforge-ai/core/tool/tool"
import type { SessionRunner } from "@arforge-ai/core/session/runner"
import { TurnToolCarrier } from "@arforge-ai/core/tool/turn-carrier"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import type { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import type { SessionMessage } from "@arforge-ai/core/session/message"
import type { SessionV1 } from "@arforge-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { ToolOutput } from "@arforge-ai/llm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import path from "node:path"

export type Dependencies = {
  readonly plugin: Plugin.Interface
  readonly directory: string
  readonly worktree: string
}

type LegacyResult = MatureTool.ExecuteResult

const coreInput = (tool: MatureTool.Def) => tool.parameters as unknown as Schema.Codec<unknown, unknown, never, never>

const inputJsonSchema = (schema: JSONSchema7 | undefined) => schema as Readonly<Record<string, unknown>> | undefined

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

const dataAttachment = (attachment: NonNullable<LegacyResult["attachments"]>[number]) => {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/s.exec(attachment.url)
  if (!match?.[2]) return
  return {
    type: "file" as const,
    data: match[2].replaceAll(/\s/g, ""),
    mime: attachment.mime || match[1] || "application/octet-stream",
    ...(attachment.filename ? { name: attachment.filename } : {}),
  }
}

const modelOutput = (result: unknown): ReadonlyArray<CoreTool.Content> => {
  if (!result || typeof result !== "object") return [{ type: "text", text: String(result ?? "") }]
  const legacy = result as LegacyResult
  const output: CoreTool.Content[] = []
  if (typeof legacy.output === "string" && legacy.output.length > 0) output.push({ type: "text", text: legacy.output })
  let omitted = 0
  for (const attachment of legacy.attachments ?? []) {
    const projected = dataAttachment(attachment)
    if (projected) output.push(projected)
    else omitted += 1
  }
  if (omitted > 0)
    output.push({
      type: "text",
      text: `[${omitted} non-inline attachment${omitted === 1 ? " was" : "s were"} omitted from model transport]`,
    })
  return output
}

const structuredOutput = (result: unknown) => {
  if (!result || typeof result !== "object") return result
  const legacy = result as LegacyResult
  return {
    title: typeof legacy.title === "string" ? legacy.title : "",
    output: typeof legacy.output === "string" ? legacy.output : String(legacy.output ?? ""),
    metadata: legacy.metadata ?? {},
    ...(legacy.attachments?.length
      ? {
          attachments: legacy.attachments.map((attachment) => ({
            type: attachment.type,
            mime: attachment.mime,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
            inline: attachment.url.startsWith("data:"),
          })),
        }
      : {}),
  }
}

const executionMetadata = (origin: MatureTool.Origin): CoreTool.ToolExecutionMetadataConfig => {
  if (origin.kind !== "mcp")
    return {
      concurrency: "exclusive",
      sideEffect: "external",
      timeoutMode: "derived",
      outputPolicy: "both",
    }
  const serverDigest = canonicalHash(origin.server)
  return {
    concurrency: serverDigest ? "keyed" : "exclusive",
    ...(serverDigest ? { resourceKey: `mcp:${serverDigest}` } : {}),
    sideEffect: "external",
    timeoutMode: "derived",
    outputPolicy: "both",
  }
}

type MatureExecutionOptions = {
  readonly messages?: ReadonlyArray<SessionV1.WithParts>
  readonly sandboxProfile?: SandboxPolicy.Profile
  readonly extra?: MatureTool.Context["extra"]
  readonly metadata?: MatureTool.Context["metadata"]
  readonly permissionResources?: (request: Parameters<MatureTool.Context["ask"]>[0]) => ReadonlyArray<string>
  readonly emitHooks?: boolean
}

/**
 * The bridge's only mature executor seam. Every exported adapter below first
 * mints one opaque Core Tool, so callers can never invoke this function or a
 * mature definition without ToolRegistry materialization and settlement.
 */
const executeMature = (
  tool: MatureTool.Def,
  args: unknown,
  context: CoreTool.Context,
  dependencies: Dependencies,
  options: MatureExecutionOptions = {},
) =>
  Effect.gen(function* () {
    const abort = context.abort ?? new AbortController().signal
    const child = context.childActions
    let progress: { title?: string; metadata?: Record<string, unknown> } | undefined
    const matureContext: MatureTool.Context = {
      sessionID: SessionID.make(String(context.sessionID)),
      messageID: MessageID.make(String(context.assistantMessageID)),
      agent: String(context.agent),
      abort,
      callID: context.toolCallID,
      messages: options.messages ? [...options.messages] : [],
      ...(options.sandboxProfile ? { sandboxProfile: options.sandboxProfile } : {}),
      ...(options.extra ? { extra: options.extra } : {}),
      metadata: (input) =>
        Effect.sync(() => {
          progress = input
        }).pipe(Effect.andThen(options.metadata ? options.metadata(input) : Effect.void)),
      ask: (request) =>
        context.permission
          .assert({
            action: request.permission,
            resources: options.permissionResources?.(request) ?? request.patterns,
            metadata: request.metadata,
            sessionID: String(context.sessionID),
            agent: String(context.agent),
            source: {
              type: "tool",
              messageID: String(context.assistantMessageID),
              callID: context.toolCallID,
            },
          })
          .pipe(Effect.orDie),
      egress: context.egress,
      ...(child
        ? {
            gateway: {
              execute: child.execute,
              ...(child.recordMutationIntent ? { recordMutationIntent: child.recordMutationIntent } : {}),
            },
            parentAction: {
              actionID: child.parentActionID,
              ...(child.parentRunID ? { runID: child.parentRunID } : {}),
              ...(child.authority ? { authority: child.authority } : {}),
            },
          }
        : {}),
    }
    if (options.emitHooks !== false)
      yield* dependencies.plugin.trigger(
        "tool.execute.before",
        { tool: tool.id, sessionID: matureContext.sessionID, callID: context.toolCallID },
        { args: structuredClone(args) },
      )
    const result = yield* tool.execute(args, matureContext)
    const normalized = progress?.metadata
      ? { ...result, metadata: { ...progress.metadata, ...result.metadata } }
      : result
    // Every hook-enabled bridge attaches postprocess to this same Core Tool.
    // The execution body must never mutate its own successful Observation.
    return normalized
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.fail(new CoreTool.Failure({ message: failureMessage(cause) })),
    ),
  )

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** Preserve the plugin's documented title/output/metadata transformation contract. */
const postprocessMature = (
  tool: string,
  dependencies: Dependencies,
  input: {
    readonly input: unknown
    readonly output: ToolOutput
    readonly context: CoreTool.PostProcessingContext
  },
) =>
  Effect.gen(function* () {
    const original = input.output.structured
    if (!record(original) || typeof original.title !== "string" || typeof original.output !== "string")
      return yield* new CoreTool.Failure({ message: "The original tool presentation is invalid" })
    const draft = { title: original.title, output: original.output, metadata: structuredClone(original.metadata) }
    yield* dependencies.plugin.trigger(
      "tool.execute.after",
      {
        tool,
        sessionID: String(input.context.sessionID),
        callID: input.context.toolCallID,
        args: input.input,
      },
      draft,
    )
    if (typeof draft.title !== "string" || typeof draft.output !== "string")
      return yield* new CoreTool.Failure({ message: "The plugin returned an invalid tool presentation" })
    // Inline attachments and omission diagnostics keep their original trust
    // projection. The documented hook cannot reintroduce remote attachment URLs.
    const retained = original.output.length > 0 ? input.output.content.slice(1) : input.output.content
    return {
      structured: { ...original, ...draft },
      content: [...(draft.output ? [{ type: "text" as const, text: draft.output }] : []), ...retained],
    }
  })

/**
 * Mature read tools report leaf resources relative to the git worktree,
 * while Core Location preflight intentionally scopes them to the active
 * directory. Project the old spelling onto that same Location coordinate
 * system without widening the exact file grant.
 */
const legacyPermissionResources = (dependencies: Dependencies, request: Parameters<MatureTool.Context["ask"]>[0]) => {
  if (request.permission !== "read") return request.patterns
  return request.patterns.map((resource) => {
    if (resource === "*" || path.isAbsolute(resource)) return resource.replaceAll("\\", "/")
    const absolute = path.resolve(dependencies.worktree, resource)
    const relative = path.relative(dependencies.directory, absolute)
    return (relative.length > 0 ? relative : ".").replaceAll("\\", "/")
  })
}

/** Restores the local mature result without ever restoring omitted remote URLs. */
export function settlementToMatureResult(settlement: CoreToolRegistry.Settlement): MatureTool.ExecuteResult {
  if (settlement.result.type === "error") throw new Error(String(settlement.result.value))
  const projected =
    settlement.output?.structured ?? (settlement.result.type === "json" ? settlement.result.value : undefined)
  const structured = record(projected) ? projected : {}
  const content: NonNullable<CoreToolRegistry.Settlement["output"]>["content"] =
    settlement.output?.content ?? (settlement.result.type === "content" ? settlement.result.value : [])
  const text = content.find((item) => item.type === "text")
  const attachments = content.flatMap((item) =>
    item.type === "file" && item.uri.startsWith("data:")
      ? [
          {
            type: "file" as const,
            mime: item.mime,
            url: item.uri,
            ...(item.name ? { filename: item.name } : {}),
          },
        ]
      : [],
  )
  return {
    title: typeof structured.title === "string" ? structured.title : "",
    output:
      typeof structured.output === "string"
        ? structured.output
        : text?.type === "text"
          ? text.text
          : settlement.result.type === "text"
            ? String(settlement.result.value)
            : "",
    metadata: record(structured.metadata) ? structured.metadata : {},
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

export type ScheduledTaskProgress = Readonly<{
  assistantMessageID: SessionMessage.ID
  callID: string
  value: Parameters<MatureTool.Context["metadata"]>[0]
}>

export type ScheduledTaskNativeRoute = TaskNativeParent

/**
 * The sole scheduled-task adapter. It neither creates nor reads a Mature
 * parent assistant/tool shadow. The
 * route resolver consumes only durable Core task/session identity.
 */
export function makeScheduledTaskTool(
  runtime: TaskRuntimeValue,
  description: string,
  dependencies: Dependencies,
  options: {
    readonly sandboxProfile: SandboxPolicy.Profile
    readonly promptOps: TaskPromptOps
    readonly metadata: (input: ScheduledTaskProgress) => Effect.Effect<void>
    readonly route: (callID: string) => TaskNativeParent | undefined
    readonly modelRoute?: (context: CoreTool.Context) => Effect.Effect<TaskNativeParent | undefined>
    readonly abort?: AbortSignal
  },
) {
  const adapted = CoreTool.make({
    description,
    input: runtime.parameters,
    ...(runtime.jsonSchema ? { inputJsonSchema: inputJsonSchema(runtime.jsonSchema) } : {}),
    output: Schema.Unknown,
    structured: Schema.Unknown,
    effects: scopedChange({
      filesystemScope: [dependencies.worktree],
      idempotency: "conditional",
      retryability: "guarded",
      reversibility: "compensatable",
      compensation: "cancel the delegated child task and retain its audit trail",
      successCriteria: ["delegated result is returned within the parent authority and budget"],
    }),
    metadata: {
      concurrency: "exclusive",
      sideEffect: "external",
      idempotency: "conditional",
      timeoutMode: "derived",
      outputPolicy: "both",
    },
    execute: (args, context) =>
      Effect.gen(function* () {
        const scheduledRoute = options.route(context.toolCallID)
        const nativeParent = scheduledRoute ?? (options.modelRoute ? yield* options.modelRoute(context) : undefined)
        if (!nativeParent)
          return yield* new CoreTool.Failure({
            message: `Scheduled task route is unavailable for ${context.toolCallID}; no child task was started`,
          })
        const abort = options.abort
          ? context.abort
            ? AbortSignal.any([context.abort, options.abort])
            : options.abort
          : (context.abort ?? new AbortController().signal)
        const taskContext: TaskExecutionContext = {
          sessionID: SessionID.make(String(context.sessionID)),
          messageID: MessageID.make(String(context.assistantMessageID)),
          agent: String(context.agent),
          sandboxProfile: options.sandboxProfile,
          abort,
          callID: context.toolCallID,
          ...(context.childActions
            ? {
                parentAction: {
                  actionID: context.childActions.parentActionID,
                  ...(context.childActions.parentRunID ? { runID: context.childActions.parentRunID } : {}),
                  ...(context.childActions.authority ? { authority: context.childActions.authority } : {}),
                },
              }
            : {}),
          nativeParent,
          bypassAgentCheck: scheduledRoute !== undefined,
          promptOps: options.promptOps,
          metadata: (value) =>
            options.metadata({
              assistantMessageID: context.assistantMessageID,
              callID: context.toolCallID,
              value,
            }),
          ask: (request) =>
            context.permission
              .assert({
                action: request.permission,
                resources: request.patterns,
                metadata: request.metadata,
                sessionID: String(context.sessionID),
                agent: String(context.agent),
                source: {
                  type: "tool",
                  messageID: String(context.assistantMessageID),
                  callID: context.toolCallID,
                },
              })
              .pipe(Effect.orDie),
        }
        yield* dependencies.plugin.trigger(
          "tool.execute.before",
          { tool: "task", sessionID: taskContext.sessionID, callID: context.toolCallID },
          { args: structuredClone(args) },
        )
        return yield* runtime.execute(args, taskContext)
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.fail(new CoreTool.Failure({ message: failureMessage(cause) })),
        ),
      ),
    postprocess: (input) => postprocessMature("task", dependencies, input),
    toStructuredOutput: ({ output }) => structuredOutput(output),
    toModelOutput: ({ output }) => modelOutput(output),
  })
  return CoreTool.withPermission(adapted, "task")
}

export function makeUserAttachmentReadCarrier(
  tool: MatureTool.Def,
  dependencies: Dependencies,
  options: {
    readonly filePath: string
    readonly authorizationResource: string
    readonly model?: unknown
  },
) {
  const adapted = CoreTool.withPermission(
    CoreTool.make({
      description: tool.description,
      input: coreInput(tool),
      ...(tool.jsonSchema ? { inputJsonSchema: inputJsonSchema(tool.jsonSchema) } : {}),
      output: Schema.Unknown,
      structured: Schema.Unknown,
      effects: (input) =>
        automaticRead({
          filesystemScope: [record(input) ? String(input.filePath) : ""],
          successCriteria: ["the exact user-attached file is returned as a bounded validated result"],
        }),
      metadata: {
        concurrency: "safe",
        sideEffect: "read",
        idempotency: "idempotent",
        timeoutMode: "derived",
        outputPolicy: "both",
      },
      execute: (args, context) => {
        if (!record(args) || args.filePath !== options.filePath)
          return Effect.fail(
            new CoreTool.Failure({ message: "Attachment carrier input does not match its user grant" }),
          )
        return executeMature(tool, args, context, dependencies, {
          extra: { bypassCwdCheck: true, ...(options.model ? { model: options.model } : {}) },
          permissionResources: () => [options.authorizationResource],
          emitHooks: false,
        })
      },
      toStructuredOutput: ({ output }) => structuredOutput(output),
      toModelOutput: ({ output }) => modelOutput(output),
    }),
    "read",
  )
  return TurnToolCarrier.UserAttachmentRead.make(adapted)
}

export function makeLegacySessionTools(
  definitions: ReadonlyArray<MatureTool.Def>,
  dependencies: Dependencies,
  options: {
    readonly messages: ReadonlyArray<SessionV1.WithParts>
    readonly sandboxProfile: SandboxPolicy.Profile
    readonly extra: MatureTool.Context["extra"]
    /** Exact legacy provider-visible workspace used by the old Action intent. */
    readonly workspace: string
    readonly shell?: string
    readonly metadata: (input: {
      readonly callID: string
      readonly args: Readonly<Record<string, unknown>>
      readonly value: Parameters<MatureTool.Context["metadata"]>[0]
    }) => Effect.Effect<void>
  },
) {
  const entries = definitions.map((definition): TurnToolCarrier.LegacySessionToolEntry => {
    const adapted = CoreTool.make({
      description: definition.description,
      input: coreInput(definition),
      ...(definition.jsonSchema ? { inputJsonSchema: inputJsonSchema(definition.jsonSchema) } : {}),
      output: Schema.Unknown,
      structured: Schema.Unknown,
      effects: (input) =>
        forToolCall({
          name: definition.id,
          input: record(input) ? input : {},
          workspace: options.workspace,
        }),
      metadata: definition.origin
        ? executionMetadata(definition.origin)
        : {
            concurrency: "exclusive",
            sideEffect: "external",
            timeoutMode: "derived",
            outputPolicy: "both",
          },
      execute: (args, context) =>
        executeMature(definition, args, context, dependencies, {
          messages: options.messages,
          sandboxProfile: options.sandboxProfile,
          extra: options.extra,
          permissionResources: (request) => legacyPermissionResources(dependencies, request),
          metadata: (value) =>
            options.metadata({
              callID: context.toolCallID,
              args: record(args) ? args : {},
              value,
            }),
        }),
      postprocess: (input) => postprocessMature(definition.id, dependencies, input),
      toStructuredOutput: ({ output }) => structuredOutput(output),
      toModelOutput: ({ output }) => modelOutput(output),
    })
    const permission = definition.origin?.permission ?? definition.id
    const tool = permission === definition.id ? adapted : CoreTool.withPermission(adapted, permission)
    return {
      name: definition.id,
      tool,
      trusted: definition.origin === undefined,
      authorization: ({ name, input, semantics }) => {
        if (semantics.riskTier !== "L2" && semantics.riskTier !== "L3") return Effect.succeed(undefined)
        const riskTier: "L2" | "L3" = semantics.riskTier
        return Effect.gen(function* () {
          const command = typeof input.command === "string" ? input.command.trim() : ""
          const workdir = typeof input.workdir === "string" ? input.workdir : undefined
          const shellPreflight =
            (name.toLowerCase() === "bash" || name.toLowerCase() === "shell") && options.shell
              ? yield* ShellPreflight.preflight({
                  command,
                  cwd: workdir ? path.resolve(dependencies.directory, workdir) : dependencies.directory,
                  instanceDirectory: dependencies.directory,
                  shell: options.shell,
                })
              : undefined
          return permissionPreflight({
            name,
            input,
            workspace: options.workspace,
            locationDirectory: dependencies.directory,
            riskTier,
            ...(shellPreflight ? { shellPreflight } : {}),
          })
        })
      },
    }
  })
  return TurnToolCarrier.LegacySessionTools.make(entries)
}

/**
 * Converts one mature non-built-in definition into the sole executable Core
 * representation. The returned opaque value can only run through
 * CoreToolRegistry.materialize().settle(); NativeTool/SandboxTool remain wire
 * or interpreter adapters and are not registration owners.
 */
export function adaptExternalTool(tool: MatureTool.Def, dependencies: Dependencies): CoreTool.AnyTool {
  if (!tool.origin) throw new TypeError(`Cannot bridge unclassified mature tool: ${tool.id}`)
  const origin = tool.origin
  const adapted = CoreTool.make({
    description: tool.description,
    input: coreInput(tool),
    ...(tool.jsonSchema ? { inputJsonSchema: inputJsonSchema(tool.jsonSchema) } : {}),
    output: Schema.Unknown,
    structured: Schema.Unknown,
    metadata: executionMetadata(origin),
    execute: (args, context) => executeMature(tool, args, context, dependencies),
    postprocess: (input) => postprocessMature(tool.id, dependencies, input),
    toStructuredOutput: ({ output }) => structuredOutput(output),
    toModelOutput: ({ output }) => modelOutput(output),
  })
  return origin.permission === tool.id ? adapted : CoreTool.withPermission(adapted, origin.permission)
}

export interface Interface {
  /** Resolves current request sources without registering them in shared Location state. */
  readonly snapshot: SessionRunner.ExternalToolResolver
}

export class Service extends Context.Service<Service, Interface>()("@arforge/ToolCoreBridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* MatureToolRegistry.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service

    const snapshot: Interface["snapshot"] = Effect.fn("ToolCoreBridge.snapshot")(function* (input) {
      const session = yield* sessions.get(SessionID.make(String(input.sessionID))).pipe(Effect.orDie)
      const agent = yield* agents.get(input.agent)
      if (!agent) return yield* Effect.die(new Error(`External tool source agent not found: ${input.agent}`))
      const definitions = yield* registry.tools({
        modelID: ModelV2.ID.make(input.modelID),
        providerID: ProviderV2.ID.make(input.providerID),
        agent,
        permission: session.permission,
      })
      const instance = yield* InstanceState.context
      const canonical: Record<string, CoreTool.AnyTool> = {}
      for (const definition of definitions) {
        if (!definition.origin) continue
        const validName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(definition.id)
        if (!validName || isReservedBuiltInName(definition.id)) {
          yield* Effect.logWarning("Ignoring non-canonical external tool during Core registration", {
            tool: definition.id,
            source: definition.origin.kind,
            reason: validName ? "reserved Core built-in name" : "invalid Core tool name",
          })
          continue
        }
        canonical[definition.id] = adaptExternalTool(definition, {
          plugin,
          directory: instance.directory,
          worktree: instance.worktree,
        })
      }
      return canonical
    })

    return Service.of({ snapshot })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MatureToolRegistry.node, Session.node, Agent.node, Plugin.node],
})

export * as ToolCoreBridge from "./core-bridge"
