import { createRequestEnvelope, type RequestEnvelopeContext } from "@arforge-ai/core/session/request-envelope"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { asSchema, type ModelMessage, type Tool } from "ai"
import type { LLMRequest } from "@arforge-ai/llm"
import type { Provider } from "@/provider/provider"

const DIGEST = /^[0-9a-f]{64}$/
const MAX_REVISION_LENGTH = 128

/**
 * The only durable identity needed to bind a mature provider call to its
 * owner. The request body, prompt, tool arguments, and credentials are not
 * part of this context.
 */
export type RequestBindingContext = {
  readonly runID: string
  readonly turnStep: number
  readonly attempt: number
  /** Immutable SkillV2 snapshot identity used to assemble this request. */
  readonly skillSnapshotDigest?: string
}

export type Binding = RequestBindingContext & {
  readonly schemaVersion: 1
  readonly runtime: "mature"
  /** Native bindings are derived from Core's exact RequestEnvelope. */
  readonly mode: "native-envelope" | "prepared-projection"
  readonly requestDigest: string
  readonly contextDigest: string
  readonly toolSetRevision: string
  readonly routeConfigRevision: string
  readonly skillSnapshotDigest?: string
  readonly compilerRevision: string
}

export class RequestBindingError extends Error {
  readonly code: "INVALID_CONTEXT" | "NON_CANONICAL_REQUEST"

  constructor(code: RequestBindingError["code"], message: string) {
    super(message)
    this.name = "MatureRequestBindingError"
    this.code = code
  }
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

const isDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value)

const hash = (value: unknown, field: string) => {
  const result = canonicalHash(value)
  if (!result) throw new RequestBindingError("NON_CANONICAL_REQUEST", `${field} is not canonically hashable`)
  return result
}

const validateContext = (input: RequestBindingContext) => {
  if (typeof input.runID !== "string" || input.runID.length === 0)
    throw new RequestBindingError("INVALID_CONTEXT", "mature request binding requires a run ID")
  if (!isPositiveInteger(input.turnStep))
    throw new RequestBindingError("INVALID_CONTEXT", "mature request binding turnStep must be positive")
  if (!isPositiveInteger(input.attempt))
    throw new RequestBindingError("INVALID_CONTEXT", "mature request binding attempt must be positive")
  if (input.skillSnapshotDigest !== undefined && !isDigest(input.skillSnapshotDigest))
    throw new RequestBindingError("INVALID_CONTEXT", "mature request binding skill snapshot digest is invalid")
}

const compilerRevision = (value: string | undefined) => {
  const result = value ?? "mature-request-projection/v1"
  if (result.length === 0 || result.length > MAX_REVISION_LENGTH)
    throw new RequestBindingError("INVALID_CONTEXT", "mature request binding compiler revision is invalid")
  return result
}

const routeIdentity = (model: {
  readonly provider?: unknown
  readonly providerID?: unknown
  readonly id: unknown
  readonly route?: {
    readonly id: string
    readonly protocol: unknown
    readonly endpoint: {
      readonly baseURL?: string
      readonly query?: Readonly<Record<string, string>>
      readonly path?: string
    }
  }
  readonly api?: { readonly id?: string; readonly npm?: string; readonly url?: string }
}) => ({
  provider: String(model.provider ?? model.providerID ?? ""),
  model: String(model.id),
  api: model.api
    ? {
        id: model.api.id,
        npm: model.api.npm,
        url: model.api.url,
      }
    : undefined,
  ...(model.route === undefined
    ? {}
    : {
        route: {
          id: model.route.id,
          protocol: String(model.route.protocol),
          endpoint: {
            baseURL: model.route.endpoint.baseURL,
            query: model.route.endpoint.query,
            path: typeof model.route.endpoint.path === "string" ? model.route.endpoint.path : "dynamic",
          },
        },
      }),
})

const requestContext = (input: {
  readonly binding: RequestBindingContext
  readonly promptDigest?: string
  readonly contextDigest: string
  readonly toolSetRevision: string
  readonly routeConfigRevision: string
  readonly compilerRevision: string
}): RequestEnvelopeContext => ({
  run_id: input.binding.runID,
  turn_step: input.binding.turnStep,
  attempt: input.binding.attempt,
  ...(input.promptDigest === undefined ? {} : { prompt_digest: input.promptDigest }),
  context_digest: input.contextDigest,
  tool_set_revision: input.toolSetRevision,
  route_config_revision: input.routeConfigRevision,
  ...(input.binding.skillSnapshotDigest === undefined
    ? {}
    : { skill_snapshot_digest: input.binding.skillSnapshotDigest }),
  compiler_revision: input.compilerRevision,
})

const finish = (input: {
  readonly binding: RequestBindingContext
  readonly mode: Binding["mode"]
  readonly requestDigest: string
  readonly contextDigest: string
  readonly toolSetRevision: string
  readonly routeConfigRevision: string
  readonly compilerRevision: string
}): Binding => {
  validateContext(input.binding)
  for (const [field, value] of [
    ["requestDigest", input.requestDigest],
    ["contextDigest", input.contextDigest],
    ["toolSetRevision", input.toolSetRevision],
    ["routeConfigRevision", input.routeConfigRevision],
  ] as const) {
    if (!isDigest(value)) throw new RequestBindingError("NON_CANONICAL_REQUEST", `${field} is not a SHA-256 digest`)
  }
  if (input.compilerRevision.length === 0 || input.compilerRevision.length > MAX_REVISION_LENGTH)
    throw new RequestBindingError("INVALID_CONTEXT", "mature request binding compiler revision is invalid")
  return {
    schemaVersion: 1,
    runtime: "mature",
    mode: input.mode,
    ...input.binding,
    requestDigest: input.requestDigest,
    contextDigest: input.contextDigest,
    toolSetRevision: input.toolSetRevision,
    routeConfigRevision: input.routeConfigRevision,
    ...(input.binding.skillSnapshotDigest === undefined
      ? {}
      : { skillSnapshotDigest: input.binding.skillSnapshotDigest }),
    compilerRevision: input.compilerRevision,
  }
}

/**
 * Build a metadata-only binding from the exact native LLM request. The
 * RequestEnvelope is created transiently so its canonical digest covers the
 * complete request, but the envelope itself is deliberately not returned or
 * persisted by this mature projection.
 */
export const fromRequest = (input: {
  readonly request: LLMRequest
  readonly binding: RequestBindingContext
  readonly promptDigest?: string
  readonly compilerRevision?: string
}): Binding => {
  validateContext(input.binding)
  const revision = compilerRevision(input.compilerRevision)
  try {
    // First normalize the class-based LLM request into the same plain snapshot
    // used by RequestEnvelope. canonicalHash intentionally rejects arbitrary
    // class instances, so hashing the raw request would make valid native
    // requests look non-canonical.
    const normalized = createRequestEnvelope({ request: input.request, execution: {} })
    const contextDigest = hash({ system: normalized.request.system, messages: normalized.request.messages }, "context")
    const toolSetRevision = hash(normalized.request.tools, "tool set")
    const routeConfigRevision = hash(normalized.request.model, "route config")
    const envelope = createRequestEnvelope({
      request: input.request,
      execution: requestContext({
        binding: input.binding,
        promptDigest: input.promptDigest,
        contextDigest,
        toolSetRevision,
        routeConfigRevision,
        compilerRevision: revision,
      }),
    })
    return finish({
      binding: input.binding,
      mode: "native-envelope",
      requestDigest: envelope.request_digest,
      contextDigest,
      toolSetRevision,
      routeConfigRevision,
      compilerRevision: revision,
    })
  } catch (error) {
    if (error instanceof RequestBindingError) throw error
    throw new RequestBindingError(
      "NON_CANONICAL_REQUEST",
      `native request cannot be safely bound: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const schema = (value: unknown) => {
  try {
    const result = asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema
    if (!result) throw new Error("tool schema is empty")
    return result
  } catch (error) {
    throw new RequestBindingError(
      "NON_CANONICAL_REQUEST",
      `tool schema cannot be safely bound: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const preparedTools = (tools: Record<string, Tool>) =>
  Object.entries(tools)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => ({
      name,
      description: tool.description ?? "",
      inputSchema: schema(tool.inputSchema),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: schema(tool.outputSchema) }),
    }))

/**
 * Build a safe fallback projection for the mature AI SDK path. It hashes the
 * normalized input that Arforge hands to the SDK and never returns the input
 * body, headers, auth, or tool executors. Native callers should prefer
 * `fromRequest`, whose digest is tied to the exact Core request envelope.
 */
export const fromPrepared = (input: {
  readonly model: Provider.Model
  readonly system: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: unknown
  readonly binding: RequestBindingContext
  readonly promptDigest?: string
  readonly compilerRevision?: string
}): Binding => {
  validateContext(input.binding)
  const tools = preparedTools(input.tools)
  const contextDigest = hash({ system: input.system, messages: input.messages }, "context")
  const toolSetRevision = hash(tools, "tool set")
  const routeConfigRevision = hash(routeIdentity(input.model), "route config")
  const revision = compilerRevision(input.compilerRevision)
  const requestDigest = hash(
    {
      schemaVersion: 1,
      kind: "mature-prepared-request",
      model: routeIdentity(input.model),
      system: input.system,
      messages: input.messages,
      tools,
      toolChoice: input.toolChoice,
      generation: {
        temperature: input.temperature,
        topP: input.topP,
        topK: input.topK,
        maxOutputTokens: input.maxOutputTokens,
      },
      providerOptions: input.providerOptions,
      skillSnapshotDigest: input.binding.skillSnapshotDigest,
    },
    "prepared request",
  )
  return finish({
    binding: input.binding,
    mode: "prepared-projection",
    requestDigest,
    contextDigest,
    toolSetRevision,
    routeConfigRevision,
    compilerRevision: revision,
  })
}

export const isBinding = (value: unknown): value is Binding => {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<Binding>
  return (
    item.schemaVersion === 1 &&
    item.runtime === "mature" &&
    (item.mode === "native-envelope" || item.mode === "prepared-projection") &&
    typeof item.runID === "string" &&
    isPositiveInteger(item.turnStep) &&
    isPositiveInteger(item.attempt) &&
    isDigest(item.requestDigest) &&
    isDigest(item.contextDigest) &&
    isDigest(item.toolSetRevision) &&
    isDigest(item.routeConfigRevision) &&
    (item.skillSnapshotDigest === undefined || isDigest(item.skillSnapshotDigest)) &&
    typeof item.compilerRevision === "string" &&
    item.compilerRevision.length > 0 &&
    item.compilerRevision.length <= MAX_REVISION_LENGTH
  )
}

export * as MatureRequestBinding from "./mature-binding"
