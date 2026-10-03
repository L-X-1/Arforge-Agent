import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Schema } from "effect"
import { ContextFirewall } from "@arforge-ai/core/context-firewall"
import { AgentV2 } from "@arforge-ai/core/agent"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema as DurableSessionSchema } from "@arforge-ai/core/session/schema"
import { capabilityPermission, safeCapabilityReference } from "./capability-registry"
import { McpGatewayAdapter } from "./gateway-adapter"
import { MCP } from "./index"
import { McpCatalog } from "./catalog"
import { Plugin } from "@/plugin"
import { Tool } from "@/tool/tool"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"

const parameters = Schema.Record(Schema.String, Schema.Unknown)
const MAX_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export type Input = {
  readonly key: string
  readonly server: string
  readonly entry: MCP.McpTool
  readonly mcp: MCP.Interface
  readonly plugin: Plugin.Interface
  readonly agents: Agent.Interface
  readonly truncate: Truncate.Interface
}

/**
 * Materializes one generation-bound MCP tool as the host's native Tool.Def.
 * The caller's normal ToolRegistry/session pipeline owns the parent action,
 * plugin lifecycle and output completion; this projection only supplies the
 * MCP-specific child action body and stale-capability check.
 */
export function make(input: Input): Tool.Def {
  const decode = Schema.decodeUnknownEffect(parameters)
  return {
    id: input.key,
    origin: { kind: "mcp", permission: input.key, server: input.server },
    description: input.entry.def.description ?? "",
    parameters,
    jsonSchema: McpCatalog.inputSchemaFor(input.entry.def),
    execute: (args, ctx) =>
      Effect.gen(function* () {
        const decoded = yield* decode(args).pipe(
          Effect.mapError(
            (error) =>
              new Tool.InvalidArgumentsError({
                tool: input.key,
                detail: String(error),
              }),
          ),
        )
        const parent = ctx.parentAction
        const gateway = ctx.gateway
        const invocation = ctx.callID
        if (!gateway || !parent || !invocation)
          return yield* Effect.fail(new Error(`MCP tool ${input.key} requires a durable parent Action Gateway binding`))

        const assertCurrent =
          input.entry.generation === undefined || !input.mcp.assertCapability
            ? undefined
            : () =>
                input.mcp.assertCapability!({
                  id: input.key,
                  server: input.server,
                  generation: input.entry.generation!,
                  kind: "tool",
                })
        if (assertCurrent) yield* assertCurrent()

        // Resolve the protected transport scope before asking for permission.
        // A missing endpoint/intent is an invariant failure, not a user
        // decision that an interactive prompt could repair.
        const declaredScopes = input.mcp.declaredScope ? yield* input.mcp.declaredScope(input.server) : undefined
        if (!declaredScopes)
          return yield* Effect.fail(
            new Error(`MCP scope resolution failed for ${input.server}/${input.key}: no protected transport scope`),
          )

        const permission = capabilityPermission("tool", input.key, input.server)
        yield* ctx.ask({
          permission: permission.permission,
          metadata: {
            source: "mcp-capability-registry",
            server: input.server,
            tool: input.entry.def.name,
            ...(input.entry.generation === undefined ? {} : { generation: input.entry.generation }),
          },
          patterns: permission.patterns,
          always: permission.patterns,
        })

        const executionScopes = input.mcp.declaredScope ? yield* input.mcp.declaredScope(input.server) : undefined
        if (!executionScopes)
          return yield* Effect.fail(
            new Error(`MCP scope resolution failed for ${input.server}/${input.key}: scope changed before execution`),
          )

        // Re-resolve the protected transport scope at execution time. A
        // config replacement or local connect-intent drift must fail closed,
        // even if a caller retained this Tool.Def across a prompt boundary.
        const result = yield* McpGatewayAdapter.mcpCallViaGateway({
          gateway,
          plugin: input.plugin,
          sessionID: DurableSessionSchema.ID.make(ctx.sessionID),
          agent: AgentV2.ID.make(ctx.agent),
          assistantMessageID: SessionMessage.ID.make(ctx.messageID),
          invocation,
          parentActionID: parent.actionID,
          ...(parent.runID ? { parentRunID: parent.runID } : {}),
          server: input.server,
          key: input.key,
          toolName: input.entry.def.name,
          client: input.entry.client,
          args: decoded as Record<string, unknown>,
          timeout: input.entry.timeout,
          abort: ctx.abort,
          declaredScopes: executionScopes,
          ...(assertCurrent === undefined ? {} : { assertCurrent }),
          // The outer native Tool.Def pipeline already emits these hooks.
          emitHooks: false,
        })

        const formatted = formatResult(input, McpCatalog.normalizeCallToolResult(result))
        const agent = yield* input.agents.get(ctx.agent)
        const truncated = yield* input.truncate.output(formatted.output, {}, agent)
        return {
          ...formatted,
          output: truncated.content,
          metadata: {
            ...formatted.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          },
        }
      }).pipe(Effect.orDie),
  }
}

function formatResult(input: Input, result: CallToolResult): Tool.ExecuteResult {
  const textParts: string[] = []
  const attachments: Tool.ExecuteResult["attachments"] = []

  for (const item of result.content) {
    if (item.type === "text") {
      textParts.push(item.text)
      continue
    }
    if (item.type === "image") {
      attachments.push({
        type: "file",
        mime: item.mimeType,
        url: `data:${item.mimeType};base64,${item.data}`,
      })
      continue
    }
    if (item.type !== "resource") continue
    const resource = item.resource
    if ("text" in resource && resource.text) textParts.push(resource.text)
    if (!("blob" in resource) || !resource.blob) continue

    const mime = resource.mimeType ?? "application/octet-stream"
    const size = base64Size(resource.blob)
    const safeUri = safeCapabilityReference(resource.uri)
    if (!SUPPORTED_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
      textParts.push(
        `[Binary MCP resource omitted: ${safeUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
      )
      continue
    }
    if (size > MAX_RESOURCE_BLOB_BYTES) {
      textParts.push(`[Binary MCP resource omitted: ${safeUri} (${mime}, ${formatBytes(size)}) exceeds 10 MB]`)
      continue
    }
    attachments.push({
      type: "file",
      mime,
      url: `data:${mime};base64,${resource.blob}`,
      filename: safeUri,
    })
  }

  const output = textParts.join("\n\n") || `MCP tool ${input.key} returned no textual content.`
  return {
    title: "",
    output: ContextFirewall.untrusted("remote_instruction", output),
    metadata: {
      source: "mcp-capability-registry",
      server: input.server,
      tool: input.entry.def.name,
      contentItems: result.content.length,
      ...(input.entry.generation === undefined ? {} : { generation: input.entry.generation }),
    },
    attachments,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export { parameters as mcpToolParameters }

export * as McpToolProjection from "./tool-projection"
