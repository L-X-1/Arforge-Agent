import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import type { ToolContext as PluginToolContext, ToolDefinition } from "@arforge-ai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Effect, Schema } from "effect"
import z from "zod"
import { Tool } from "./tool"
import type { Truncate } from "./truncate"

export type Dependencies = {
  readonly instance: InstanceContext
  readonly agents: Agent.Interface
  readonly truncate: Truncate.Interface
}

export type PluginToolContractCode = "invalid-definition"

/** Runtime boundary for tools discovered from plugin/filesystem modules. */
export class PluginToolContractError extends Error {
  readonly _tag = "PluginToolContractError"

  constructor(readonly code: PluginToolContractCode = "invalid-definition") {
    super(`Plugin tool contract rejected (${code})`)
    this.name = "PluginToolContractError"
  }
}

const isDefinitionRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * Validate a legacy Plugin ToolDefinition without creating a second tool
 * representation.  `args: undefined` remains a supported legacy shorthand;
 * the executable handler and description are the non-negotiable typed seam.
 */
export function validateDefinition(value: unknown): ToolDefinition {
  if (!isDefinitionRecord(value)) throw new PluginToolContractError()
  if (typeof value.description !== "string" || value.description.length > 16_384)
    throw new PluginToolContractError()
  if (value.args !== undefined && (!isDefinitionRecord(value.args) || Object.keys(value.args).length > 256))
    throw new PluginToolContractError()
  if (typeof value.execute !== "function") throw new PluginToolContractError()
  return value as ToolDefinition
}

/**
 * The sole Plugin ToolDefinition -> mature source adapter. It creates a
 * provenance-bearing definition but never registers or executes a Core tool;
 * product execution can reach the returned body only through ToolCoreBridge
 * and Core ToolRegistry settlement.
 */
export function make(id: string, definition: ToolDefinition, dependencies: Dependencies): Tool.Def {
  const validated = validateDefinition(definition)
  // Plugin tools still expose Zod args publicly; keep that compatibility
  // boxed at this source boundary and give the provider the original schema.
  const args = validated.args ?? {}
  const entries = Object.entries(args)
  const allZod = entries.every((entry) => isZodType(entry[1]))
  const zodParams = allZod ? z.object(args) : undefined
  const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
  const parameters = zodParams
    ? Schema.declare<unknown>((value): value is unknown => zodParams.safeParse(value).success)
    : Schema.Unknown

  return {
    id,
    origin: { kind: "plugin", permission: id },
    parameters,
    jsonSchema,
    description: validated.description,
    execute: (input, toolContext) =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const pluginContext: PluginToolContext = {
          ...toolContext,
          ask: (request) => bridge.promise(toolContext.ask(request)),
          metadata: (value) => {
            bridge.fork(toolContext.metadata(value))
          },
          directory: dependencies.instance.directory,
          worktree: dependencies.instance.worktree,
        }
        // Third-party code receives no execution opportunity until the exact
        // plugin namespace has been authorized by the parent Core Action.
        yield* toolContext.ask({
          permission: id,
          metadata: { source: "plugin" },
          patterns: ["*"],
          always: ["*"],
        })
        const result = yield* Effect.promise(() => validated.execute(input as never, pluginContext))
        const output = typeof result === "string" ? result : result.output
        const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
        const attachments = typeof result === "string" ? undefined : result.attachments
        const agent = yield* dependencies.agents.get(toolContext.agent)
        const bounded = yield* dependencies.truncate.output(output, {}, agent)
        return {
          title: typeof result === "string" ? "" : (result.title ?? ""),
          output: bounded.truncated ? bounded.content : output,
          attachments,
          metadata: {
            ...metadata,
            truncated: bounded.truncated,
            ...(bounded.truncated ? { outputPath: bounded.outputPath } : {}),
          },
        }
      }).pipe(
        Effect.withSpan("Tool.execute", {
          attributes: {
            "tool.name": id,
            "session.id": toolContext.sessionID,
            "message.id": toolContext.messageID,
            ...(toolContext.callID ? { "tool.call_id": toolContext.callID } : {}),
          },
        }),
      ),
  }
}

export function isDefinition(value: unknown): value is ToolDefinition {
  try {
    validateDefinition(value)
    return true
  } catch {
    return false
  }
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return { type: "object", properties, required: Object.keys(properties) }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null || seen.has(value)) return
    seen.add(value)
    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }
    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeZodJsonSchema)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) => !((key === "exclusiveMaximum" || key === "exclusiveMinimum") && typeof item === "boolean"),
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as PluginToolSource from "./plugin-source-adapter"
