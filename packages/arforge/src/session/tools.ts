import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ToolCoreBridge } from "@/tool/core-bridge"
import type { Tool as MatureTool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import type { TaskPromptOps } from "@/tool/task"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ModelV2 } from "@arforge-ai/core/model"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema as DurableSessionSchema } from "@arforge-ai/core/session/schema"
import { StructuredOutput as CoreStructuredOutput } from "@arforge-ai/core/tool/structured-output"
import type { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { type Tool as AITool, jsonSchema, tool, type ToolExecutionOptions } from "ai"
import { Effect } from "effect"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { Session } from "./session"

export { mcpServerFor, permissionPreflight } from "./legacy-tool-authorization"

/**
 * Provider-wire projection for the mature desktop loop. Model definitions and
 * executions both come from one immutable Core ToolRegistry materialization;
 * this module no longer owns authorization, Gateway execution, plugin hooks,
 * scheduling, or result settlement.
 */
export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  readonly runID?: AgentRuntime.RunID
  readonly agent: Agent.Info
  readonly model: Provider.Model
  readonly session: Session.Info
  readonly processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  readonly bypassAgentCheck: boolean
  readonly messages: SessionV1.WithParts[]
  readonly promptOps: TaskPromptOps
  readonly coreRegistry: CoreToolRegistry.Interface
  readonly structuredOutput?: {
    readonly schema: Readonly<Record<string, unknown>>
    readonly onSuccess: (output: unknown) => void
  }
  /** Resolved once from trusted local configuration by SessionPrompt. */
  readonly shell?: string
}) {
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const registry = yield* ToolRegistry.Service
  const instance = yield* InstanceState.context
  const definitions = yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })
  const carrier = ToolCoreBridge.makeLegacySessionTools(
    definitions,
    { plugin, directory: instance.directory, worktree: instance.worktree },
    {
      messages: input.messages,
      sandboxProfile: SandboxPolicy.profileFromMetadata(input.session.metadata),
      extra: {
        model: input.model,
        bypassAgentCheck: input.bypassAgentCheck,
        promptOps: input.promptOps,
      },
      workspace: input.processor.message.path.root,
      ...(input.shell ? { shell: input.shell } : {}),
      metadata: ({ callID, args, value }) =>
        input.processor.updateToolCall(callID, (match) => {
          if (!["running", "pending"].includes(match.state.status)) return match
          return {
            ...match,
            state: {
              title: value.title,
              metadata: value.metadata,
              status: "running",
              input: args,
              time: { start: Date.now() },
            },
          }
        }),
    },
  )
  const sessionID = DurableSessionSchema.ID.make(input.session.id)
  const assistantMessageID = SessionMessage.ID.make(input.processor.message.id)
  const materialized = yield* input.coreRegistry
    .materialize([], sessionID, {
      includeRegistered: false,
      legacySessionTools: carrier,
      ...(input.structuredOutput ? { structuredOutput: input.structuredOutput.schema } : {}),
    })
    .pipe(Effect.orDie)

  const tools: Record<string, AITool> = {}
  for (const definition of materialized.definitions) {
    const schema = ProviderTransform.schema(input.model, definition.inputSchema as JSONSchema7)
    const isStructuredOutput = definition.name === CoreStructuredOutput.name && input.structuredOutput !== undefined
    const projected = {
      description: definition.description,
      inputSchema: jsonSchema(schema),
      ...(definition.outputSchema === undefined
        ? {}
        : { outputSchema: jsonSchema(definition.outputSchema as JSONSchema7) }),
      execute(args: unknown, options: ToolExecutionOptions) {
        return run.promise(
          Effect.gen(function* () {
            const settlement = yield* materialized.settle({
              ...(input.runID ? { runID: input.runID } : {}),
              sessionID,
              agent: AgentV2.ID.make(input.agent.name),
              assistantMessageID,
              call: {
                type: "tool-call",
                id: options.toolCallId,
                name: definition.name,
                input: args,
              },
            })
            if (settlement.result.type === "error") return settlement.result
            let result: MatureTool.ExecuteResult
            if (isStructuredOutput) {
              if (settlement.output?.structured === undefined)
                return {
                  type: "error" as const,
                  value: "Structured output settlement did not contain a validated JSON object",
                }
              input.structuredOutput!.onSuccess(structuredClone(settlement.output.structured))
              result = {
                title: "Structured Output",
                output: "Structured output captured successfully.",
                metadata: { valid: true },
              }
            } else {
              result = ToolCoreBridge.settlementToMatureResult(settlement)
            }
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: input.session.id,
                messageID: input.processor.message.id,
              })),
            }
            // Some provider adapters omit or delay tool-result events for
            // parallel calls. This boundary is idempotent and closes the same
            // UI state from the canonical settlement result.
            yield* input.processor.completeToolCall(options.toolCallId, output)
            return output
          }),
          options.abortSignal ? { signal: options.abortSignal } : undefined,
        )
      },
    }
    const toModelOutput = isStructuredOutput
      ? ({ output }: { output: unknown }) => ({
          type: "text" as const,
          value: projectedOutputText(output),
        })
      : undefined
    // Definitions are materialized at runtime, so their output type is
    // intentionally unknown at this provider boundary. Core has already
    // decoded and settled the concrete result before it reaches this adapter.
    tools[definition.name] = tool<unknown, unknown>({
      ...projected,
      ...(toModelOutput ? { toModelOutput } : {}),
    })
  }
  return tools
})

function projectedOutputText(output: unknown) {
  if (typeof output !== "object" || output === null) return String(output)
  if ("output" in output) return String(output.output)
  if ("value" in output) return String(output.value)
  return String(output)
}

export * as SessionTools from "./tools"
