import { LLM, type LLMRequest, type Model as LLMModel, type PreparedRequest } from "@arforge-ai/llm"
import { RequestExecutor } from "@arforge-ai/llm/route"
import { canonicalHash } from "../util/canonical-hash"

export const REQUEST_ENVELOPE_SCHEMA_VERSION = "1.0" as const

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

export type RequestEnvelopeContext = {
  readonly run_id?: string
  readonly turn_step?: number
  /** Bounded durable provider-attempt identity; never a credential or payload. */
  readonly attempt?: number
  readonly prompt_digest?: string
  readonly context_digest?: string
  readonly compiler_revision?: string
  readonly tool_set_revision?: string
  readonly route_config_revision?: string
  /** Immutable SkillV2 snapshot identity used to assemble this request. */
  readonly skill_snapshot_digest?: string
  /** Reference only; never put a credential or secret value here. */
  readonly credential_identity?: {
    readonly id: string
    readonly version: string
  }
}

type RequestSnapshot = {
  readonly transmission?: {
    readonly transport: string
    readonly body: JsonValue
    readonly endpoint: { readonly url: string; readonly exact: true }
  }
  readonly id?: string
  readonly model: {
    readonly provider_id: string
    readonly model_id: string
    readonly route_id: string
    readonly protocol: string
    readonly endpoint?: {
      readonly base_url?: string
      readonly query?: Readonly<Record<string, string>>
      /** Static paths are persisted verbatim; dynamic paths are fenced by route revision. */
      readonly path?: string
      readonly path_mode?: "static" | "dynamic"
    }
  }
  readonly system: JsonValue
  readonly messages: JsonValue
  readonly tools: JsonValue
  readonly tool_choice?: JsonValue
  readonly generation?: JsonValue
  readonly provider_options?: JsonValue
  readonly http?: JsonValue
  readonly response_format?: JsonValue
  readonly cache?: JsonValue
  readonly metadata?: JsonValue
}

export type RequestEnvelope = {
  readonly schema_version: typeof REQUEST_ENVELOPE_SCHEMA_VERSION
  readonly execution: RequestEnvelopeContext
  readonly request: RequestSnapshot
  readonly request_digest: string
}

export class RequestEnvelopeError extends Error {
  readonly code: "REQUEST_ENVELOPE_NON_CANONICAL" | "REQUEST_ENVELOPE_MISMATCH" | "REQUEST_ENVELOPE_SECRET"

  constructor(code: RequestEnvelopeError["code"], message: string) {
    super(message)
    this.name = "RequestEnvelopeError"
    this.code = code
  }
}

const secretKeyPattern =
  /(?:api[_-]?key|authorization|cookie|password|private[_-]?key|secret|access[_-]?token|refresh[_-]?token|bearer|(?:^|[_-])token(?:$|[_-])|credential)/i
const sha256Digest = /^[0-9a-f]{64}$/

const isSecretKey = (key: string, path: string) =>
  key === "credential_identity" && (path === "execution" || path.endsWith(".execution"))
    ? false
    : secretKeyPattern.test(key)

const isBytes = (value: unknown): value is Uint8Array | ArrayBuffer =>
  value instanceof Uint8Array || value instanceof ArrayBuffer

type NormalizeMode = "value" | "schema" | "schema-name-map"

const schemaNameMapKeys = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"])

const normalize = (value: unknown, path: string, mode: NormalizeMode = "value"): JsonValue | undefined => {
  if (value === undefined) return undefined
  // Inspect endpoint components separately: a path/query override must not hide
  // credentials in another component that will still be persisted verbatim.
  const endpointPath = path.replace(/^envelope\./, "")
  if (typeof value === "string" && endpointPath === "execution.skill_snapshot_digest" && !sha256Digest.test(value))
    throw new RequestEnvelopeError(
      "REQUEST_ENVELOPE_NON_CANONICAL",
      "skill snapshot digest must be a lowercase SHA-256 digest",
    )
  if (endpointPath === "request.transmission") {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "body,endpoint,transport" ||
      typeof value.transport !== "string" ||
      !value.transport.trim() ||
      value.body === undefined ||
      !isRecord(value.endpoint) ||
      Object.keys(value.endpoint).sort().join(",") !== "exact,url" ||
      value.endpoint.exact !== true ||
      typeof value.endpoint.url !== "string" ||
      !RequestExecutor.describeEndpoint(value.endpoint.url).exact
    )
      throw new RequestEnvelopeError("REQUEST_ENVELOPE_SECRET", "unverified transmission cannot be persisted")
  }
  if (
    typeof value === "string" &&
    (endpointPath === "request.model.endpoint.base_url" || endpointPath === "request.model.endpoint.path")
  ) {
    const address = endpointPath.endsWith(".path") ? URL.parse(value, "https://envelope.invalid/")?.href : value
    if (!address || !RequestExecutor.describeEndpoint(address).exact)
      throw new RequestEnvelopeError("REQUEST_ENVELOPE_SECRET", "unsafe endpoint cannot be persisted")
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", `non-finite number at ${path}`)
    return value
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", `unsupported value at ${path}`)
  }
  if (isBytes(value)) return { $binary: Buffer.from(value as Uint8Array).toString("base64") }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`, mode) ?? null)
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      // JSON Schema property/$defs names describe the shape accepted by a
      // tool; they are not request values. Keep scanning every schema node and
      // its defaults, but do not mistake a declared field such as
      // `clientSecretEnvironment` for a credential being persisted.
      const endpointQuerySecret =
        endpointPath === "request.model.endpoint.query" &&
        !RequestExecutor.describeEndpoint(`https://envelope.invalid/?${encodeURIComponent(key)}=value`).exact
      if (mode !== "schema-name-map" && (isSecretKey(key, path) || endpointQuerySecret)) {
        throw new RequestEnvelopeError(
          "REQUEST_ENVELOPE_SECRET",
          `secret-bearing field ${path}.${key} cannot be persisted`,
        )
      }
      const nextMode: NormalizeMode =
        mode === "schema-name-map"
          ? "schema"
          : mode === "schema" && schemaNameMapKeys.has(key)
            ? "schema-name-map"
            : mode === "value" && (key === "inputSchema" || key === "outputSchema")
              ? "schema"
              : mode
      const normalized = normalize(entry, `${path}.${key}`, nextMode)
      if (normalized !== undefined) result[key] = normalized
    }
    return result
  }
  throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", `unsupported value at ${path}`)
}

const requestSnapshot = (request: LLMRequest, transmission?: PreparedRequest["transmission"]): RequestSnapshot => {
  const model = request.model
  const route = model.route
  const endpoint = route.endpoint
  const input = {
    transmission,
    id: request.id,
    model: {
      provider_id: String(model.provider),
      model_id: String(model.id),
      route_id: route.id,
      protocol: String(route.protocol),
      endpoint: {
        base_url: endpoint.baseURL,
        query: endpoint.query,
        ...(typeof endpoint.path === "string"
          ? { path: endpoint.path, path_mode: "static" as const }
          : { path_mode: "dynamic" as const }),
      },
    },
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.toolChoice,
    generation: request.generation,
    provider_options: request.providerOptions,
    http: request.http,
    response_format: request.responseFormat,
    cache: request.cache,
    metadata: request.metadata,
  }
  return normalize(input, "request") as RequestSnapshot
}

const envelopeCore = (envelope: Omit<RequestEnvelope, "request_digest">) => ({
  schema_version: envelope.schema_version,
  execution: envelope.execution,
  request: envelope.request,
})

const digestEnvelopeCore = (envelope: Omit<RequestEnvelope, "request_digest">) => {
  const digest = canonicalHash(envelopeCore(envelope))
  if (!digest)
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", "request envelope is not canonicalizable")
  return digest
}

export const requestEnvelopeDigest = (envelope: RequestEnvelope) => digestEnvelopeCore(envelope)

export const createRequestEnvelope = (input: {
  readonly request: LLMRequest
  readonly execution?: RequestEnvelopeContext
  readonly transmission?: PreparedRequest["transmission"]
}): RequestEnvelope => {
  const core = {
    schema_version: REQUEST_ENVELOPE_SCHEMA_VERSION,
    execution: normalize(input.execution ?? {}, "execution") as RequestEnvelopeContext,
    request: requestSnapshot(input.request, input.transmission),
  } satisfies Omit<RequestEnvelope, "request_digest">
  return { ...core, request_digest: digestEnvelopeCore(core) }
}

const decodeBinary = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(decodeBinary)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (Object.keys(record).length === 1 && typeof record.$binary === "string")
      return Uint8Array.from(Buffer.from(record.$binary, "base64"))
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decodeBinary(entry)]))
  }
  return value
}

/** The identity must come from the current model resolver, never from the envelope being verified. */
export const rebuildRequest = (
  envelope: RequestEnvelope,
  model: LLMModel,
  resolvedCredential?: RequestEnvelopeContext["credential_identity"],
): LLMRequest => {
  const expectedCredential = envelope.execution.credential_identity
  if (
    expectedCredential !== undefined &&
    (!expectedCredential?.id ||
      !expectedCredential.version ||
      expectedCredential.id !== resolvedCredential?.id ||
      expectedCredential.version !== resolvedCredential?.version)
  )
    throw new RequestEnvelopeError(
      "REQUEST_ENVELOPE_MISMATCH",
      "resolved credential identity does not match request envelope; start a new request with the current credential",
    )
  const snapshot = envelope.request
  if (String(model.provider) !== snapshot.model.provider_id || String(model.id) !== snapshot.model.model_id) {
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "model identity does not match request envelope")
  }
  if (model.route.id !== snapshot.model.route_id || String(model.route.protocol) !== snapshot.model.protocol) {
    throw new RequestEnvelopeError(
      "REQUEST_ENVELOPE_MISMATCH",
      "route/protocol identity does not match request envelope",
    )
  }
  const expectedEndpoint = snapshot.model.endpoint
  const observedEndpoint = model.route.endpoint
  if (
    expectedEndpoint?.base_url !== observedEndpoint.baseURL ||
    canonicalHash(expectedEndpoint?.query ?? {}) !== canonicalHash(observedEndpoint.query ?? {}) ||
    expectedEndpoint?.path_mode !== (typeof observedEndpoint.path === "string" ? "static" : "dynamic") ||
    (expectedEndpoint?.path_mode === "static" && expectedEndpoint.path !== observedEndpoint.path)
  ) {
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "endpoint identity does not match request envelope")
  }
  const request = LLM.request({
    model,
    id: snapshot.id,
    system: decodeBinary(snapshot.system) as never,
    messages: decodeBinary(snapshot.messages) as never,
    tools: decodeBinary(snapshot.tools) as never,
    toolChoice: decodeBinary(snapshot.tool_choice) as never,
    generation: decodeBinary(snapshot.generation) as never,
    providerOptions: decodeBinary(snapshot.provider_options) as never,
    http: decodeBinary(snapshot.http) as never,
    responseFormat: decodeBinary(snapshot.response_format) as never,
    cache: decodeBinary(snapshot.cache) as never,
    metadata: decodeBinary(snapshot.metadata) as never,
  })
  const rebuilt = createRequestEnvelope({ request, execution: envelope.execution, transmission: snapshot.transmission })
  if (rebuilt.request_digest !== envelope.request_digest) {
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "rebuilt request does not match envelope digest")
  }
  return request
}

export const assertRequestEnvelope = (envelope: RequestEnvelope, request: LLMRequest) => {
  if (requestEnvelopeDigest(envelope) !== envelope.request_digest) {
    throw new RequestEnvelopeError(
      "REQUEST_ENVELOPE_MISMATCH",
      "durable request envelope digest is internally inconsistent",
    )
  }
  // Common-request equivalence is separate from final preparation equivalence.
  // Retain the recorded transmission here; the send boundary must also call
  // assertPreparedRequestEnvelope with the actual preparation it will consume.
  const observed = createRequestEnvelope({
    request,
    execution: envelope.execution,
    transmission: envelope.request.transmission,
  })
  if (observed.request_digest !== envelope.request_digest) {
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "observed model request differs from durable envelope")
  }
  return true as const
}

export const assertPreparedRequestEnvelope = (envelope: RequestEnvelope, prepared: PreparedRequest) => {
  const recorded = envelope.request.transmission
  if (!recorded || !prepared.transmission)
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "final transmission is missing")
  const actual = normalize(prepared.transmission, "request.transmission")
  const identity = envelope.request.model
  if (
    requestEnvelopeDigest(envelope) !== envelope.request_digest ||
    String(prepared.model.id) !== identity.model_id ||
    String(prepared.model.provider) !== identity.provider_id ||
    prepared.route !== identity.route_id ||
    prepared.protocol !== identity.protocol ||
    canonicalHash(recorded) !== canonicalHash(actual)
  )
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "final preparation differs from durable envelope")
  return true as const
}

export const requestEnvelopeJson = (envelope: RequestEnvelope) => {
  const stable = (value: JsonValue): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
    if (value && typeof value === "object") {
      const entries = Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable(value[key]!)}`)
      return `{${entries.join(",")}}`
    }
    return JSON.stringify(value)
  }
  const normalized = normalize(envelope, "envelope")
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized))
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", "request envelope cannot be serialized")
  return stable(normalized)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Parse the persisted JSON form and verify both canonical ordering and the
 * digest before it can be used to rebuild a provider request.
 */
export const parseRequestEnvelopeJson = (serialized: string): RequestEnvelope => {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw new RequestEnvelopeError(
      "REQUEST_ENVELOPE_NON_CANONICAL",
      `request envelope is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isRecord(parsed))
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", "request envelope must be a JSON object")
  const keys = Object.keys(parsed).sort()
  if (keys.join(",") !== "execution,request,request_digest,schema_version")
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", "request envelope has an invalid top-level shape")
  if (parsed.schema_version !== REQUEST_ENVELOPE_SCHEMA_VERSION)
    throw new RequestEnvelopeError(
      "REQUEST_ENVELOPE_NON_CANONICAL",
      `unsupported request envelope schema ${String(parsed.schema_version)}`,
    )
  if (!isRecord(parsed.execution) || !isRecord(parsed.request) || typeof parsed.request_digest !== "string")
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", "request envelope has invalid fields")
  const normalized = normalize(parsed, "envelope")
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized))
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", "request envelope cannot be normalized")
  const canonical = requestEnvelopeJson(normalized as RequestEnvelope)
  if (canonical !== serialized)
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", "request envelope JSON is not canonical")
  const envelope = normalized as RequestEnvelope
  if (requestEnvelopeDigest(envelope) !== envelope.request_digest)
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "persisted request envelope digest does not match")
  return envelope
}

/** A model Action binds the canonical envelope to its immutable decoded input. */
export const parseActionRequestEnvelope = (
  serialized: string,
  action: { readonly inputDigest?: string; readonly runID?: string },
): RequestEnvelope => {
  if (Buffer.byteLength(serialized, "utf8") > 65_536)
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_NON_CANONICAL", "action request envelope exceeds byte limit")
  const envelope = parseRequestEnvelopeJson(serialized)
  if (envelope.request_digest !== action.inputDigest)
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "action input does not bind this model request")
  if (envelope.execution.run_id !== undefined && envelope.execution.run_id !== action.runID)
    throw new RequestEnvelopeError("REQUEST_ENVELOPE_MISMATCH", "action run does not match model request")
  return envelope
}
