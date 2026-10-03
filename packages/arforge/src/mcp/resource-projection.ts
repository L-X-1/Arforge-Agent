import { Effect, Schema } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { ContextFirewall } from "@arforge-ai/core/context-firewall"
import { AgentV2 } from "@arforge-ai/core/agent"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema as DurableSessionSchema } from "@arforge-ai/core/session/schema"
import { capabilityPermission, safeCapabilityKey, safeCapabilityReference } from "./capability-registry"
import { McpGatewayAdapter } from "./gateway-adapter"
import { MCP } from "./index"
import { Plugin } from "@/plugin"
import { Tool } from "@/tool/tool"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"

const recordParameters = Schema.Record(Schema.String, Schema.Unknown)
const stringParameters = Schema.Record(Schema.String, Schema.String)
const MAX_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

type PromptArgument = {
  readonly name: string
  readonly description?: string
  readonly required?: boolean
}

export type PromptEntry = {
  readonly name: string
  readonly description?: string
  readonly arguments?: readonly PromptArgument[]
  readonly client: string
  readonly generation?: number
}

export type ResourceEntry = {
  readonly name: string
  readonly uri: string
  readonly description?: string
  readonly mimeType?: string
  readonly client: string
  readonly generation?: number
}

export type ResourceTemplateEntry = {
  readonly name: string
  readonly uriTemplate: string
  readonly description?: string
  readonly mimeType?: string
  readonly client: string
  readonly generation?: number
}

type BaseInput = {
  readonly key: string
  /** ID used by McpCapabilityRegistry, distinct from the readable Tool ID. */
  readonly capabilityID: string
  readonly server: string
  readonly generation?: number
  readonly mcp: MCP.Interface
  readonly plugin: Plugin.Interface
  readonly agents: Agent.Interface
  readonly truncate: Truncate.Interface
}

type CapabilityInput = BaseInput & {
  readonly kind: "prompt" | "resource" | "resource_template"
  readonly reference?: string
}

type ListInput = Omit<BaseInput, "capabilityID" | "generation"> & {
  readonly kind: "prompt" | "resource" | "resource_template"
}

const catalogEntrySchema = Schema.Struct({
  name: Schema.String,
  client: Schema.String,
  description: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  uriTemplate: Schema.optional(Schema.String),
})
const catalogEntriesSchema = Schema.Array(catalogEntrySchema)
type CatalogEntry = Schema.Schema.Type<typeof catalogEntrySchema>

const noArgsSchema = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
}

function invalid(tool: string, detail: string) {
  return new Tool.InvalidArgumentsError({ tool, detail })
}

function decodeRecord(tool: string, args: unknown) {
  return Schema.decodeUnknownEffect(recordParameters)(args).pipe(
    Effect.mapError((error) => invalid(tool, String(error))),
  )
}

function decodeStrings(tool: string, args: unknown, allowed: ReadonlySet<string>, required: ReadonlySet<string>) {
  return Schema.decodeUnknownEffect(stringParameters)(args).pipe(
    Effect.mapError((error) => invalid(tool, String(error))),
    Effect.flatMap((value) => {
      const unknown = Object.keys(value).filter((key) => !allowed.has(key))
      const missing = [...required].filter((key) => value[key] === undefined)
      if (unknown.length > 0)
        return Effect.fail(invalid(tool, `unexpected argument(s): ${unknown.toSorted().join(", ")}`))
      if (missing.length > 0) return Effect.fail(invalid(tool, `missing required argument(s): ${missing.join(", ")}`))
      return Effect.succeed(value)
    }),
  )
}

function nativeInput(input: CapabilityInput, ctx: Tool.Context, operation: string, args: Record<string, unknown>) {
  return Effect.gen(function* () {
    const parent = ctx.parentAction
    const gateway = ctx.gateway
    const invocation = ctx.callID
    if (!gateway || !parent || !invocation)
      return yield* Effect.fail(
        new Error(`MCP capability ${input.key} requires a durable parent Action Gateway binding`),
      )

    const assertCurrent =
      input.generation === undefined || !input.mcp.assertCapability
        ? undefined
        : () =>
            input.mcp.assertCapability!({
              id: input.capabilityID,
              server: input.server,
              generation: input.generation!,
              kind: input.kind,
            })
    if (assertCurrent) yield* assertCurrent()

    // Scope evidence is checked before permission. A prompt cannot repair a
    // missing endpoint/intent because the child action would be unauditable.
    const declaredScopes = yield* input.mcp.declaredScope(input.server)
    if (!declaredScopes)
      return yield* Effect.fail(
        new Error(`MCP scope resolution failed for ${input.server}/${input.key}: no protected transport scope`),
      )

    const permission = capabilityPermission(input.kind, input.capabilityID, input.server, input.reference)
    yield* ctx.ask({
      permission: permission.permission,
      metadata: {
        source: "mcp-capability-registry",
        server: input.server,
        capability: input.key,
        kind: input.kind,
        ...(input.generation === undefined ? {} : { generation: input.generation }),
      },
      patterns: permission.patterns,
      always: permission.patterns,
    })

    const executionScopes = yield* input.mcp.declaredScope(input.server)
    if (!executionScopes)
      return yield* Effect.fail(
        new Error(`MCP scope resolution failed for ${input.server}/${input.key}: scope changed before execution`),
      )

    return {
      gateway,
      parent,
      invocation,
      declaredScopes: executionScopes,
      sessionID: DurableSessionSchema.ID.make(ctx.sessionID),
      agent: AgentV2.ID.make(ctx.agent),
      assistantMessageID: SessionMessage.ID.make(ctx.messageID),
      abort: ctx.abort,
      ...(assertCurrent === undefined ? {} : { assertCurrent }),
    }
  })
}

type RequestInput = ReturnType<typeof nativeInput> extends Effect.Effect<infer A, any, any> ? A : never

/**
 * Mint the service-owned generation lease at the final transport boundary.
 * The production MCP service returns an installation-bound proof for exact
 * prompt/resource targets; small compatibility doubles that predate the
 * optional method still receive the historical generation/reference lease.
 */
function generationLease(input: CapabilityInput, reference?: string, template?: string) {
  if (input.generation === undefined) return Effect.succeed<MCP.McpCapabilityLease | undefined>(undefined)
  if (input.mcp.leaseForCapability)
    return input.mcp.leaseForCapability({
      id: input.capabilityID,
      server: input.server,
      generation: input.generation,
      kind: input.kind,
      ...(reference === undefined ? {} : { reference }),
      ...(template === undefined ? {} : { template }),
    })
  return Effect.succeed({
    id: input.capabilityID,
    server: input.server,
    generation: input.generation,
    kind: input.kind,
    ...(reference === undefined ? {} : { reference: safeCapabilityReference(reference) }),
    ...(template === undefined ? {} : { template: safeCapabilityReference(template) }),
  } satisfies MCP.McpCapabilityLease)
}

function request(
  input: CapabilityInput,
  ctx: Tool.Context,
  operation: string,
  args: Record<string, unknown>,
  run: (scope: RequestInput) => Effect.Effect<unknown, unknown, never>,
) {
  return Effect.gen(function* () {
    const scope = yield* nativeInput(input, ctx, operation, args)
    const value = yield* McpGatewayAdapter.mcpRequestViaGateway({
      gateway: scope.gateway,
      plugin: input.plugin,
      sessionID: scope.sessionID,
      agent: scope.agent,
      assistantMessageID: scope.assistantMessageID,
      invocation: scope.invocation,
      parentActionID: scope.parent.actionID,
      ...(scope.parent.runID ? { parentRunID: scope.parent.runID } : {}),
      server: input.server,
      key: input.key,
      operation,
      args,
      abort: scope.abort,
      declaredScopes: scope.declaredScopes,
      ...(scope.assertCurrent === undefined ? {} : { assertCurrent: scope.assertCurrent }),
      // The outer native Tool pipeline owns plugin hooks and completion.
      emitHooks: false,
      execute: () => run(scope),
      decode: (value) => value,
    })
    return value
  })
}

/**
 * Run one server's catalog traversal through the same durable MCP child
 * action used by prompt/resource reads. Discovery remains owned by the
 * existing MCP supervisor (and therefore keeps its page/byte/deadline
 * budgets); this adapter stores only a JSON-safe projection, never Client
 * instances, so a replay cannot resurrect a transport object.
 */
function catalogRequest(
  input: ListInput,
  ctx: Tool.Context,
  server: string,
  operation: string,
  key: string,
  source: (server: string) => Effect.Effect<unknown>,
) {
  return Effect.gen(function* () {
    const parent = ctx.parentAction
    const gateway = ctx.gateway
    const invocation = ctx.callID
    if (!gateway || !parent || !invocation)
      return yield* Effect.fail(new Error(`MCP catalog ${key} requires a durable parent Action Gateway binding`))

    const declaredScopes = yield* input.mcp.declaredScope(server)
    if (!declaredScopes)
      return yield* Effect.fail(
        new Error(`MCP scope resolution failed for ${server}/${key}: no protected transport scope`),
      )

    const executionScopes = yield* Effect.suspend(() => input.mcp.declaredScope(server))
    if (!executionScopes)
      return yield* Effect.fail(
        new Error(`MCP scope resolution failed for ${server}/${key}: scope changed before execution`),
      )

    // Bind the observed supervisor generation into the child identity when
    // the host exposes health snapshots. A reconnect at the same endpoint
    // must not replay a settled catalog from the previous Client generation.
    const generation =
      typeof input.mcp.health === "function"
        ? ((yield* input.mcp.health())[server]?.observedGeneration ?? undefined)
        : undefined

    const assertScope = () =>
      Effect.gen(function* () {
        const current = yield* input.mcp.declaredScope(server)
        if (!current || JSON.stringify(current) !== JSON.stringify(executionScopes))
          return yield* Effect.fail(new Error(`MCP scope resolution failed for ${server}/${key}: scope changed`))
        if (generation !== undefined && typeof input.mcp.health === "function") {
          const currentGeneration = (yield* input.mcp.health())[server]?.observedGeneration ?? undefined
          if (currentGeneration !== generation)
            return yield* Effect.fail(new Error(`MCP catalog generation changed for ${server}/${key}`))
        }
      })

    return yield* McpGatewayAdapter.mcpRequestViaGateway<ReadonlyArray<CatalogEntry>>({
      gateway,
      plugin: input.plugin,
      sessionID: DurableSessionSchema.ID.make(ctx.sessionID),
      agent: AgentV2.ID.make(ctx.agent),
      assistantMessageID: SessionMessage.ID.make(ctx.messageID),
      invocation: `${invocation}:${operation}:${server}`,
      parentActionID: parent.actionID,
      ...(parent.runID ? { parentRunID: parent.runID } : {}),
      server,
      key,
      operation,
      resourceLabel: `catalog:${input.kind}`,
      args: { server, generation: generation ?? null },
      abort: ctx.abort,
      declaredScopes: executionScopes,
      assertCurrent: assertScope,
      emitHooks: false,
      execute: () =>
        source(server).pipe(
          Effect.map((entries) => {
            if (typeof entries !== "object" || entries === null || Array.isArray(entries))
              throw new Error(`MCP ${input.kind} catalog returned an invalid projection`)
            return Object.values(entries as Record<string, unknown>).flatMap((entry) => {
              if (typeof entry !== "object" || entry === null || Array.isArray(entry))
                throw new Error(`MCP ${input.kind} catalog returned an invalid entry`)
              const value = entry as Record<string, unknown>
              const client = typeof value.client === "string" ? value.client : server
              if (client !== server) return []
              return {
                name: String(value.name ?? ""),
                client,
                ...(typeof value.description === "string" ? { description: value.description } : {}),
                ...(typeof value.uri === "string" ? { uri: value.uri } : {}),
                ...(typeof value.uriTemplate === "string" ? { uriTemplate: value.uriTemplate } : {}),
              } satisfies CatalogEntry
            })
          }),
        ),
      decode: (value) => Schema.decodeUnknownSync(catalogEntriesSchema)(value),
    })
  })
}

export function makePrompt(input: BaseInput & { readonly entry: PromptEntry }): Tool.Def {
  const argumentsList = input.entry.arguments ?? []
  const allowed = new Set(argumentsList.map((argument) => argument.name))
  const required = new Set(argumentsList.filter((argument) => argument.required).map((argument) => argument.name))
  const properties = Object.fromEntries(
    argumentsList.map((argument) => [
      argument.name,
      { type: "string", ...(argument.description ? { description: argument.description } : {}) },
    ]),
  )
  return {
    id: input.key,
    origin: { kind: "mcp", permission: "read", server: input.server },
    description: input.entry.description ?? `Run MCP prompt ${input.entry.name} from connected server ${input.server}.`,
    parameters: stringParameters,
    jsonSchema: {
      type: "object",
      properties: properties as JSONSchema7["properties"],
      ...(required.size > 0 ? { required: [...required] } : {}),
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      Effect.gen(function* () {
        const decoded = yield* decodeStrings(input.key, args, allowed, required)
        const result = yield* request(
          {
            ...input,
            kind: "prompt",
            reference: input.entry.name,
          },
          ctx,
          "getPrompt",
          decoded,
          () =>
            Effect.gen(function* () {
              const lease = yield* generationLease({ ...input, kind: "prompt" }, input.entry.name)
              if (input.generation !== undefined && !lease)
                return yield* Effect.fail(
                  new Error(`MCP prompt lease unavailable: ${input.server}/${input.entry.name}`),
                )
              const prompt = yield* input.mcp.getPrompt(input.server, input.entry.name, decoded, lease)
              if (!prompt)
                return yield* Effect.fail(new Error(`MCP prompt unavailable: ${input.server}/${input.entry.name}`))
              return prompt
            }),
        )
        const formatted = formatPromptResult(input, result as PromptResult)
        return yield* finish(input, formatted, ctx.agent)
      }).pipe(Effect.orDie),
  }
}

export function makeResource(input: BaseInput & { readonly entry: ResourceEntry }): Tool.Def {
  return {
    id: input.key,
    origin: { kind: "mcp", permission: "read", server: input.server },
    description:
      input.entry.description ?? `Read MCP resource ${input.entry.name} from connected server ${input.server}.`,
    parameters: recordParameters,
    jsonSchema: noArgsSchema,
    execute: (args, ctx) =>
      Effect.gen(function* () {
        const decoded = yield* decodeRecord(input.key, args)
        if (Object.keys(decoded).length > 0)
          return yield* Effect.fail(invalid(input.key, "this resource takes no arguments"))
        const result = yield* request(
          {
            ...input,
            kind: "resource",
            reference: input.entry.uri,
          },
          ctx,
          "readResource",
          { uri: input.entry.uri },
          () =>
            Effect.gen(function* () {
              const lease = yield* generationLease({ ...input, kind: "resource" }, input.entry.uri)
              if (input.generation !== undefined && !lease)
                return yield* Effect.fail(
                  new Error(`MCP resource lease unavailable: ${input.server}/${input.entry.uri}`),
                )
              const resource = yield* input.mcp.readResource(input.server, input.entry.uri, lease, {
                propagateTransportError: true,
              })
              if (!resource)
                return yield* Effect.fail(
                  new Error(`MCP resource unavailable: ${input.server}/${safeCapabilityReference(input.entry.uri)}`),
                )
              return resource
            }),
        )
        const formatted = formatResourceResult(input.server, input.entry.uri, result as ResourceResult, input)
        return yield* finish(input, formatted, ctx.agent)
      }).pipe(Effect.orDie),
  }
}

export function makeResourceTemplate(input: BaseInput & { readonly entry: ResourceTemplateEntry }): Tool.Def {
  const names = templateArguments(input.entry.uriTemplate)
  const allowed = new Set(names)
  const required = new Set(names)
  const properties = Object.fromEntries(names.map((name) => [name, { type: "string" }]))
  return {
    id: input.key,
    origin: { kind: "mcp", permission: "read", server: input.server },
    description:
      input.entry.description ??
      `Read MCP resource template ${input.entry.name} from connected server ${input.server}.`,
    parameters: stringParameters,
    jsonSchema: {
      type: "object",
      properties: properties as JSONSchema7["properties"],
      ...(names.length > 0 ? { required: names } : {}),
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      Effect.gen(function* () {
        const decoded = yield* decodeStrings(input.key, args, allowed, required)
        const uri = expandUriTemplate(input.entry.uriTemplate, decoded)
        const result = yield* request(
          {
            ...input,
            kind: "resource_template",
            reference: input.entry.uriTemplate,
          },
          ctx,
          "readResourceTemplate",
          { ...decoded, uri },
          () =>
            Effect.gen(function* () {
              const lease = yield* generationLease(
                { ...input, kind: "resource_template" },
                uri,
                input.entry.uriTemplate,
              )
              if (input.generation !== undefined && !lease)
                return yield* Effect.fail(new Error(`MCP resource template lease unavailable: ${input.server}/${uri}`))
              const resource = yield* input.mcp.readResource(input.server, uri, lease, {
                propagateTransportError: true,
              })
              if (!resource)
                return yield* Effect.fail(
                  new Error(`MCP resource unavailable: ${input.server}/${safeCapabilityReference(uri)}`),
                )
              return resource
            }),
        )
        const formatted = formatResourceResult(input.server, uri, result as ResourceResult, input)
        return yield* finish(input, formatted, ctx.agent)
      }).pipe(Effect.orDie),
  }
}

/**
 * Compatibility reader for a URI that was discovered outside the native
 * per-resource definitions. It resolves the current registry entry at
 * execution time so the generation and permission proof are never guessed
 * from caller-provided strings.
 */
export function makeResourceRead(input: Omit<BaseInput, "capabilityID" | "generation">): Tool.Def {
  const parameters = Schema.Struct({
    server: Schema.String,
    uri: Schema.String,
  })
  return {
    id: input.key,
    origin: { kind: "mcp", permission: "read", server: input.server },
    description: "Read a specific MCP resource by its connected server and exact URI.",
    parameters,
    jsonSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Connected MCP server name." },
        uri: { type: "string", description: "Exact URI returned by the MCP resource catalog." },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeUnknownEffect(parameters)(args).pipe(
          Effect.mapError((error) => invalid(input.key, String(error))),
        )
        const server = parsed.server
        const uri = parsed.uri
        const listed = Object.values(yield* input.mcp.resources(server)).find((resource) => resource.uri === uri)
        if (!listed)
          return yield* Effect.fail(
            new Error(
              `MCP resource is not in the current capability catalog: ${server}/${safeCapabilityReference(uri)}`,
            ),
          )
        const projection = {
          ...input,
          capabilityID: safeCapabilityKey(server, uri),
          server,
          generation: listed.generation,
          kind: "resource" as const,
          reference: uri,
        }
        const result = yield* request(projection, ctx, "readResource", { server, uri }, () =>
          Effect.gen(function* () {
            const lease = yield* generationLease(projection, uri)
            if (projection.generation !== undefined && !lease)
              return yield* Effect.fail(new Error(`MCP resource lease unavailable: ${server}/${uri}`))
            const resource = yield* input.mcp.readResource(server, uri, lease, { propagateTransportError: true })
            if (!resource)
              return yield* Effect.fail(
                new Error(`MCP resource unavailable: ${server}/${safeCapabilityReference(uri)}`),
              )
            return resource
          }),
        )
        const formatted = formatResourceResult(server, uri, result as ResourceResult, projection)
        return yield* finish(input, formatted, ctx.agent)
      }).pipe(Effect.orDie),
  }
}

export function makePromptList(input: ListInput): Tool.Def {
  return makeList(input, "prompt", "list_mcp_prompts", "Lists prompts provided by connected MCP servers.")
}

export function makeResourceList(input: ListInput): Tool.Def {
  return makeList(input, "resource", "list_mcp_resources", "Lists resources provided by connected MCP servers.")
}

export function makeResourceTemplateList(input: ListInput): Tool.Def {
  return makeList(
    input,
    "resource_template",
    "list_mcp_resource_templates",
    "Lists parameterized resource templates provided by connected MCP servers.",
  )
}

function makeList(input: ListInput, kind: ListInput["kind"], id: string, description: string): Tool.Def {
  const source =
    kind === "prompt" ? input.mcp.prompts : kind === "resource" ? input.mcp.resources : input.mcp.resourceTemplates
  return {
    id,
    origin: { kind: "mcp", permission: "read", server: input.server },
    description,
    parameters: stringParameters,
    jsonSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Optional connected MCP server name." },
      },
      additionalProperties: false,
    },
    execute: (args, ctx) =>
      Effect.gen(function* () {
        const decoded = yield* decodeStrings(id, args, new Set(["server"]), new Set())
        const server = decoded.server
        const clients = yield* input.mcp.clients()
        const availableServers = Object.keys(clients).sort((a, b) => a.localeCompare(b))
        if (server && !availableServers.includes(server))
          return yield* Effect.fail(
            new Error(
              `MCP server "${server}" is not connected. Available servers: ${availableServers.join(", ") || "none"}`,
            ),
          )
        const servers = server ? [server] : availableServers
        // Catalog discovery is an external read just like a concrete
        // capability. Resolve every selected server's protected transport
        // scope before asking for permission; a missing scope must not be
        // hidden behind an interactive prompt.
        yield* Effect.forEach(servers, (target) =>
          input.mcp
            .declaredScope(target)
            .pipe(
              Effect.flatMap((declared) =>
                declared
                  ? Effect.void
                  : Effect.fail(
                      new Error(`MCP scope resolution failed for ${target}/${id}: no protected transport scope`),
                    ),
              ),
            ),
        )
        const permissionPatterns = server ? [`mcp:${server}:*`] : availableServers.map((name) => `mcp:${name}:*`)
        yield* ctx.ask({
          permission: "read",
          metadata: { source: "mcp-capability-registry", kind, ...(server ? { server } : {}) },
          patterns: permissionPatterns,
          always: permissionPatterns,
        })
        const values = (yield* Effect.forEach(servers, (target) =>
          catalogRequest(input, ctx, target, `list_${kind}s`, id, source),
        ))
          .flat()
          .toSorted((a, b) => (a.client + "\u0000" + a.name).localeCompare(b.client + "\u0000" + b.name))
        const content = JSON.stringify(
          {
            [kind === "prompt" ? "prompts" : kind === "resource" ? "resources" : "resourceTemplates"]: values.map(
              (entry) =>
                kind === "resource"
                  ? {
                      name: entry.name,
                      uri: safeCapabilityReference(entry.uri ?? "mcp://invalid-resource-uri"),
                      ...(entry.description ? { description: entry.description } : {}),
                      server: entry.client,
                    }
                  : kind === "resource_template"
                    ? {
                        name: entry.name,
                        uriTemplate: safeCapabilityReference(entry.uriTemplate ?? "mcp://invalid-resource-template"),
                        ...(entry.description ? { description: entry.description } : {}),
                        server: entry.client,
                      }
                    : {
                        name: entry.name,
                        ...(entry.description ? { description: entry.description } : {}),
                        server: entry.client,
                      },
            ),
          },
          null,
          2,
        )
        const truncated = yield* input.truncate.output(
          ContextFirewall.untrusted("remote_instruction", content),
          {},
          yield* input.agents.get(ctx.agent),
        )
        return {
          title: server ? `MCP ${kind}: ${server}` : `MCP ${kind}`,
          output: truncated.content,
          metadata: {
            source: "mcp-capability-registry",
            kind,
            count: values.length,
            ...(server ? { server } : {}),
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          },
        }
      }).pipe(Effect.orDie),
  }
}

type PromptResult = {
  readonly messages?: readonly { readonly role: string; readonly content: ContentBlock }[]
}

type ResourceResult = {
  readonly contents?: readonly ResourceContent[]
}

type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "resource"; readonly resource: ResourceContent }
  | { readonly type: "resource_link"; readonly uri: string; readonly name?: string; readonly description?: string }

type ResourceContent = {
  readonly uri: string
  readonly mimeType?: string
  readonly text?: string
  readonly blob?: string
}

function formatPromptResult(
  input: BaseInput & { readonly entry: PromptEntry },
  result: PromptResult,
): Tool.ExecuteResult {
  const text: string[] = []
  const attachments: Tool.ExecuteResult["attachments"] = []
  for (const message of result.messages ?? []) {
    const before = text.length
    appendContent(message.content, text, attachments)
    if (text.length > before) text[before] = `${message.role}: ${text[before]}`
  }
  return {
    title: `MCP prompt: ${input.entry.name}`,
    output: ContextFirewall.untrusted(
      "remote_instruction",
      text.join("\n\n") || `MCP prompt ${input.entry.name} returned no textual content.`,
    ),
    metadata: {
      source: "mcp-capability-registry",
      kind: "prompt",
      server: input.server,
      prompt: input.entry.name,
      contentItems: result.messages?.length ?? 0,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
    },
    attachments,
  }
}

function formatResourceResult(
  server: string,
  uri: string,
  result: ResourceResult,
  input: BaseInput,
): Tool.ExecuteResult {
  const text: string[] = []
  const attachments: Tool.ExecuteResult["attachments"] = []
  for (const content of result.contents ?? []) appendResource(content, text, attachments)
  return {
    title: `MCP resource: ${safeCapabilityReference(uri)}`,
    output: ContextFirewall.untrusted(
      "remote_instruction",
      text.join("\n\n") || `MCP resource ${uri} returned no textual content.`,
    ),
    metadata: {
      source: "mcp-capability-registry",
      kind: "resource",
      server,
      uri: safeCapabilityReference(uri),
      contents: result.contents?.length ?? 0,
      attachments: attachments.length,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
    },
    attachments,
  }
}

function appendContent(
  content: ContentBlock,
  text: string[],
  attachments: NonNullable<Tool.ExecuteResult["attachments"]>,
) {
  if (content.type === "text") {
    text.push(content.text)
    return
  }
  if (content.type === "image") {
    const size = base64Size(content.data)
    if (!SUPPORTED_RESOURCE_ATTACHMENT_MIMES.has(content.mimeType)) {
      text.push(
        `[Binary MCP prompt image omitted: ${content.mimeType} (${formatBytes(size)}) is not a supported attachment type]`,
      )
      return
    }
    if (size > MAX_RESOURCE_BLOB_BYTES) {
      text.push(`[Binary MCP prompt image omitted: ${content.mimeType} (${formatBytes(size)}) exceeds 10 MB]`)
      return
    }
    attachments.push({ type: "file", mime: content.mimeType, url: `data:${content.mimeType};base64,${content.data}` })
    return
  }
  if (content.type === "resource") {
    appendResource(content.resource, text, attachments)
    return
  }
  text.push(`Resource link: ${safeCapabilityReference(content.uri)}${content.name ? ` (${content.name})` : ""}`)
}

function appendResource(
  content: ResourceContent,
  text: string[],
  attachments: NonNullable<Tool.ExecuteResult["attachments"]>,
) {
  const safeUri = safeCapabilityReference(content.uri)
  if (content.text) text.push(content.text)
  if (!content.blob) return
  const mime = content.mimeType ?? "application/octet-stream"
  const size = base64Size(content.blob)
  if (!SUPPORTED_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
    text.push(
      `[Binary MCP resource omitted: ${safeUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
    )
    return
  }
  if (size > MAX_RESOURCE_BLOB_BYTES) {
    text.push(`[Binary MCP resource omitted: ${safeUri} (${mime}, ${formatBytes(size)}) exceeds 10 MB]`)
    return
  }
  attachments.push({ type: "file", mime, url: `data:${mime};base64,${content.blob}`, filename: safeUri })
}

function finish(input: Pick<BaseInput, "agents" | "truncate">, result: Tool.ExecuteResult, agentName: string) {
  return Effect.gen(function* () {
    const agent = yield* input.agents.get(agentName)
    const truncated = yield* input.truncate.output(result.output, {}, agent)
    return {
      ...result,
      output: truncated.content,
      metadata: {
        ...result.metadata,
        truncated: truncated.truncated,
        ...(truncated.truncated && { outputPath: truncated.outputPath }),
      },
    }
  })
}

/**
 * RFC 6570 URI-template values accepted by the pure expander. MCP native
 * resource tools currently decode model arguments as strings, but keeping
 * arrays/maps here makes the implementation complete and gives the parser a
 * deterministic contract for future typed MCP argument schemas.
 */
export type UriTemplateValue = string | number | boolean | readonly unknown[] | Readonly<Record<string, unknown>>

type VariableSpec = {
  readonly name: string
  readonly explode: boolean
  readonly prefixLength?: number
}

type TemplatePart = { readonly literal: string } | { readonly expression: string; readonly variables: VariableSpec[] }

type TemplateOperator = {
  readonly prefix: string
  readonly separator: string
  readonly named: boolean
  readonly ifEmpty: boolean
  readonly allowReserved: boolean
}

const URI_TEMPLATE_OPERATORS: Readonly<Record<string, TemplateOperator>> = {
  "": { prefix: "", separator: ",", named: false, ifEmpty: false, allowReserved: false },
  "+": { prefix: "", separator: ",", named: false, ifEmpty: false, allowReserved: true },
  "#": { prefix: "#", separator: ",", named: false, ifEmpty: false, allowReserved: true },
  ".": { prefix: ".", separator: ".", named: false, ifEmpty: false, allowReserved: false },
  "/": { prefix: "/", separator: "/", named: false, ifEmpty: false, allowReserved: false },
  ";": { prefix: ";", separator: ";", named: true, ifEmpty: true, allowReserved: false },
  "?": { prefix: "?", separator: "&", named: true, ifEmpty: false, allowReserved: false },
  "&": { prefix: "&", separator: "&", named: true, ifEmpty: false, allowReserved: false },
}

const URI_TEMPLATE_OPERATOR_CHARS = new Set(Object.keys(URI_TEMPLATE_OPERATORS).filter(Boolean))
const URI_TEMPLATE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

function parseVariableSpec(value: string): VariableSpec {
  if (!value) throw new Error("URI template contains an empty variable specification")
  const explode = value.endsWith("*")
  const withoutExplode = explode ? value.slice(0, -1) : value
  const prefix = withoutExplode.match(/^(.*):(\d+)$/)
  const name = prefix ? prefix[1]! : withoutExplode
  const prefixLength = prefix ? Number(prefix[2]) : undefined
  if (!URI_TEMPLATE_NAME.test(name)) throw new Error(`URI template contains an invalid variable name: ${name}`)
  if (prefixLength !== undefined && (!Number.isSafeInteger(prefixLength) || prefixLength < 1))
    throw new Error(`URI template prefix length must be a positive integer: ${value}`)
  if (explode && prefixLength !== undefined)
    throw new Error(`URI template variable cannot combine explode and prefix modifiers: ${value}`)
  return {
    name,
    explode,
    ...(prefixLength === undefined ? {} : { prefixLength }),
  }
}

function parseUriTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  const expression = /\{([^{}]*)\}/g
  let cursor = 0
  for (const match of template.matchAll(expression)) {
    const index = match.index ?? 0
    const literal = template.slice(cursor, index)
    if (literal.includes("{") || literal.includes("}")) throw new Error("URI template contains an unmatched brace")
    if (literal) parts.push({ literal })
    const raw = match[1] ?? ""
    const operatorKey = raw[0] && URI_TEMPLATE_OPERATOR_CHARS.has(raw[0]) ? raw[0] : ""
    const body = operatorKey ? raw.slice(1) : raw
    const operator = URI_TEMPLATE_OPERATORS[operatorKey]
    if (!operator || !body) throw new Error(`URI template contains an invalid expression: {${raw}}`)
    const variables = body.split(",").map(parseVariableSpec)
    parts.push({ expression: raw, variables })
    cursor = index + match[0].length
  }
  const trailing = template.slice(cursor)
  if (trailing.includes("{") || trailing.includes("}")) throw new Error("URI template contains an unmatched brace")
  if (trailing) parts.push({ literal: trailing })
  return parts
}

function templateOperator(expression: string): TemplateOperator {
  const key = expression[0] && URI_TEMPLATE_OPERATOR_CHARS.has(expression[0]) ? expression[0] : ""
  return URI_TEMPLATE_OPERATORS[key]!
}

function encodeTemplateValue(value: string, allowReserved: boolean) {
  // encodeURI is the standard JS primitive whose preserved set matches RFC
  // 6570 reserved expansion closely; the normal form uses encodeURIComponent.
  if (allowReserved) return encodeURI(value)
  // encodeURIComponent intentionally leaves ! ' ( ) * unescaped for legacy
  // web-form compatibility. RFC 6570's pct-encode set is stricter: only
  // ALPHA / DIGIT / '-' / '.' / '_' / '~' remain literal.
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function namedValue(name: string, value: string, operator: TemplateOperator) {
  if (value === "" && operator.ifEmpty) return name
  return `${name}=${value}`
}

function stringPrefix(value: string, prefixLength: number | undefined) {
  if (prefixLength === undefined) return value
  return Array.from(value).slice(0, prefixLength).join("")
}

function expandVariable(spec: VariableSpec, raw: UriTemplateValue | undefined, operator: TemplateOperator): string[] {
  if (raw === undefined || raw === null) return []

  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    const value = encodeTemplateValue(stringPrefix(String(raw), spec.prefixLength), operator.allowReserved)
    if (!operator.named && value === "" && operator.prefix) return []
    return [operator.named ? namedValue(spec.name, value, operator) : value]
  }

  if (spec.prefixLength !== undefined)
    throw new Error(`URI template prefix modifiers only apply to scalar values: ${spec.name}`)

  if (Array.isArray(raw)) {
    const values = raw.map((value) => encodeTemplateValue(String(value), operator.allowReserved))
    if (operator.named) {
      if (spec.explode) return values.map((value) => namedValue(spec.name, value, operator))
      return values.length === 0 ? [] : [`${spec.name}=${values.join(",")}`]
    }
    if (spec.explode) return values
    return values.length === 0 ? [] : [values.join(",")]
  }

  const entries = Object.entries(raw).map(([key, value]) => [
    encodeTemplateValue(key, operator.allowReserved),
    encodeTemplateValue(String(value), operator.allowReserved),
  ])
  if (operator.named) {
    if (spec.explode) return entries.map(([key, value]) => namedValue(key, value, operator))
    return entries.length === 0 ? [] : [`${spec.name}=${entries.flat().join(",")}`]
  }
  if (spec.explode) return entries.map(([key, value]) => `${key},${value}`)
  return entries.length === 0 ? [] : [entries.flat().join(",")]
}

function expandExpression(expression: string, variables: VariableSpec[], args: Record<string, UriTemplateValue>) {
  const operator = templateOperator(expression)
  const values = variables.flatMap((variable) => expandVariable(variable, args[variable.name], operator))
  return values.length === 0 ? "" : operator.prefix + values.join(operator.separator)
}

/** Expand an RFC 6570 URI template without interpreting or executing it. */
export function expandUriTemplate(template: string, args: Record<string, UriTemplateValue>) {
  return parseUriTemplate(template)
    .map((part) => ("literal" in part ? part.literal : expandExpression(part.expression, part.variables, args)))
    .join("")
}

function templateArguments(template: string) {
  try {
    return parseUriTemplate(template)
      .flatMap((part) => ("literal" in part ? [] : part.variables.map((variable) => variable.name)))
      .filter((name, index, names) => names.indexOf(name) === index)
  } catch {
    // Do not let untrusted MCP metadata crash ToolRegistry materialization;
    // execution will fail closed when expandUriTemplate validates the source.
    return []
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

export { recordParameters as mcpResourceParameters, stringParameters as mcpStringParameters }

export * as McpResourceProjection from "./resource-projection"
