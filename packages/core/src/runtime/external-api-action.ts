import { createHash, randomUUID } from "node:crypto"
import type { ReconciliationAdapter, ReconciliationEvidence, ReconciliationRequest } from "./reconciliation"

export const ExternalApiOperationClass = {
  read: "read",
  idempotentWrite: "idempotent-write",
  nonIdempotentWrite: "non-idempotent-write",
} as const

export type ExternalApiOperationClass = (typeof ExternalApiOperationClass)[keyof typeof ExternalApiOperationClass]

export type ExternalApiActionState = "proposed" | "executing" | "settled" | "blocked" | "recovery_required"

export type ExternalApiLookupState = "missing" | "pending" | "settled"

export type ExternalApiPolicy = Readonly<{
  readonly allowedSchemes: ReadonlyArray<"http" | "https">
  readonly allowedHosts: ReadonlyArray<string>
  readonly allowedMethods: ReadonlyArray<string>
  readonly maxRedirects?: number
}>

export type ExternalApiSecretRef = Readonly<{
  readonly header: string
  readonly name: string
  readonly scope: string
  /** Defaults to the initial origin. Cross-origin secret forwarding must be explicit. */
  readonly allowedOrigins?: ReadonlyArray<string>
}>

export type ExternalApiResponse = Readonly<{
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly contentType?: string
  readonly url: string
  readonly attempt: number
}>

export type ExternalApiRequest = Readonly<{
  readonly operationID: string
  readonly method: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  readonly secretHeaders?: ReadonlyArray<ExternalApiSecretRef>
  readonly idempotencyKey: string
  readonly operationClass?: ExternalApiOperationClass
  readonly maxResponseBytes?: number
  readonly allowedResponseContentTypes?: ReadonlyArray<string>
  readonly maxRedirects?: number
  readonly retry?: Readonly<{
    readonly maxAttempts?: number
    readonly delayMs?: number
    readonly lookup?: (operationID: string) => Promise<ExternalApiLookupState> | ExternalApiLookupState
  }>
  readonly verify?: (response: ExternalApiResponse) => Promise<boolean> | boolean
}>

export type ExternalApiActionReceipt = Readonly<{
  readonly actionID: string
  readonly traceID: string
  readonly operationID: string
  readonly method: string
  readonly idempotencyKey: string
  readonly requestDigest: string
  readonly state: ExternalApiActionState
  readonly attemptCount: number
  readonly timeCreated: number
  readonly timeUpdated: number
  readonly responseStatus?: number
  readonly responseDigest?: string
  readonly responseByteLength?: number
  readonly responseContentType?: string
  readonly errorCode?: string
  readonly errorMessage?: string
}>

export type ExternalApiActionJournal = Readonly<{
  readonly append: (receipt: ExternalApiActionReceipt) => Promise<void>
  readonly load: () => Promise<ReadonlyArray<ExternalApiActionReceipt>>
}>

export type ExternalApiSecretResolver = (
  ref: ExternalApiSecretRef,
  target: URL,
) => Promise<string | undefined> | string | undefined

export type ExternalApiFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export class ExternalApiError extends Error {
  readonly code: string
  readonly receipt?: ExternalApiActionReceipt
  readonly status?: number

  constructor(code: string, message: string, receipt?: ExternalApiActionReceipt, status?: number) {
    super(redactExternalText(message))
    this.name = "ExternalApiError"
    this.code = code
    this.receipt = receipt
    this.status = status
  }
}

export class ExternalApiValidationError extends ExternalApiError {
  constructor(message: string) {
    super("EXTERNAL_API_INVALID_REQUEST", message)
    this.name = "ExternalApiValidationError"
  }
}

export class ExternalApiPolicyError extends ExternalApiError {
  constructor(message: string) {
    super("EXTERNAL_API_POLICY_BLOCKED", message)
    this.name = "ExternalApiPolicyError"
  }
}

export class ExternalApiSecretError extends ExternalApiError {
  constructor(message: string) {
    super("EXTERNAL_API_SECRET_SCOPE", message)
    this.name = "ExternalApiSecretError"
  }
}

export class ExternalApiResponseLimitError extends ExternalApiError {
  constructor(message: string) {
    super("EXTERNAL_API_RESPONSE_LIMIT", message)
    this.name = "ExternalApiResponseLimitError"
  }
}

export class ExternalApiContentTypeError extends ExternalApiError {
  constructor(message: string) {
    super("EXTERNAL_API_CONTENT_TYPE_BLOCKED", message)
    this.name = "ExternalApiContentTypeError"
  }
}

export class ExternalApiHttpError extends ExternalApiError {
  constructor(status: number, message: string) {
    super("EXTERNAL_API_HTTP_ERROR", message, undefined, status)
    this.name = "ExternalApiHttpError"
  }
}

export class ExternalApiRecoveryRequiredError extends ExternalApiError {
  constructor(message: string, receipt: ExternalApiActionReceipt) {
    super("EXTERNAL_API_RECOVERY_REQUIRED", message, receipt)
    this.name = "ExternalApiRecoveryRequiredError"
  }
}

/**
 * A durable external operation already has a terminal successful receipt.
 * The journal intentionally stores only response digests, not response bodies,
 * so a cold client cannot fabricate a response or repeat the side effect.  The
 * caller must use the provider's read-only lookup/reconciliation path to obtain
 * the result again.
 */
export class ExternalApiAlreadySettledError extends ExternalApiError {
  constructor(message: string, receipt: ExternalApiActionReceipt) {
    super("EXTERNAL_API_ALREADY_SETTLED", message, receipt)
    this.name = "ExternalApiAlreadySettledError"
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|api[_-]?key|authorization|code|key|password|refresh[_-]?token|secret|token)$/i
const SENSITIVE_HEADER = new Set([
  "authorization",
  "cookie",
  "host",
  "idempotency-key",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,160}$/
const SECRET_IDENTIFIER = /^[A-Za-z0-9._:/-]{1,160}$/
const MAX_SECRET_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_ATTEMPTS = 5

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))

const byteLength = (value: string) => Buffer.byteLength(value, "utf8")

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

const toBytes = (body: string | Uint8Array | undefined) => {
  if (body === undefined) return new Uint8Array()
  if (typeof body === "string") return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return new Uint8Array(body)
  throw new ExternalApiValidationError("request body is not byte-safe")
}

const validateIdentifier = (name: string, value: unknown) => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new ExternalApiValidationError(`${name} is invalid`)
  return value
}

const validateSecretIdentifier = (name: string, value: unknown) => {
  if (typeof value !== "string" || !SECRET_IDENTIFIER.test(value))
    throw new ExternalApiSecretError(`${name} is invalid`)
  return value
}

const validateHeaderName = (value: unknown) => {
  if (typeof value !== "string" || !HEADER_NAME.test(value) || SENSITIVE_HEADER.has(value.toLowerCase()))
    throw new ExternalApiValidationError("request header is reserved or invalid")
  return value.toLowerCase()
}

const validateHeaderValue = (value: unknown) => {
  if (typeof value !== "string" || /[\r\n]/.test(value) || byteLength(value) > 64 * 1024)
    throw new ExternalApiValidationError("request header value is invalid")
  return value.trim()
}

const normaliseHeaders = (headers: Readonly<Record<string, string>> | undefined) => {
  const output = new Map<string, string>()
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = validateHeaderName(rawName)
    if (output.has(name)) throw new ExternalApiValidationError("request contains duplicate headers")
    output.set(name, validateHeaderValue(rawValue))
  }
  return output
}

const canonicalUrl = (url: URL) => {
  const copy = new URL(url.toString())
  copy.hash = ""
  const query = [...copy.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    `${leftKey}\u0000${leftValue}`.localeCompare(`${rightKey}\u0000${rightValue}`),
  )
  copy.search = ""
  for (const [key, value] of query) copy.searchParams.append(key, value)
  return copy.toString()
}

const canonicalSecretRefs = (refs: ReadonlyArray<ExternalApiSecretRef>) =>
  refs
    .map((ref) => ({
      header: ref.header.toLowerCase(),
      name: ref.name,
      scope: ref.scope,
      allowedOrigins: [...(ref.allowedOrigins ?? [])].sort(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

const createRequestDigest = (input: {
  readonly method: string
  readonly url: URL
  readonly headers: ReadonlyMap<string, string>
  readonly secretHeaders: ReadonlyArray<ExternalApiSecretRef>
  readonly idempotencyKey: string
  readonly body: Uint8Array
}) =>
  sha256(
    JSON.stringify({
      method: input.method,
      url: canonicalUrl(input.url),
      headers: [...input.headers.entries()].sort(([left], [right]) => left.localeCompare(right)),
      secretHeaders: canonicalSecretRefs(input.secretHeaders),
      idempotencyKey: input.idempotencyKey,
      bodyDigest: sha256(input.body),
      bodyByteLength: input.body.byteLength,
    }),
  )

const redactSecretValues = (value: string, secrets: ReadonlyArray<string>) => {
  let redacted = value
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => right.length - left.length))
    redacted = redacted.split(secret).join("[REDACTED]")
  return redacted
}

export function redactExternalText(value: unknown, secrets: ReadonlyArray<string> = []): string {
  let redacted = redactSecretValues(value instanceof Error ? value.message : String(value), secrets)
  redacted = redacted.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
  redacted = redacted.replace(
    /([?&](?:access[_-]?token|api[_-]?key|authorization|code|password|refresh[_-]?token|secret|token)=)[^&#\s]*/gi,
    "$1[REDACTED]",
  )
  redacted = redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_PII]")
  return redacted.slice(0, 2_000)
}

const contentTypeMatches = (contentType: string, pattern: string) => {
  const normalised = pattern.toLowerCase().trim()
  return (
    normalised === "*/*" ||
    (normalised.endsWith("/*") && contentType.startsWith(normalised.slice(0, -1))) ||
    normalised === contentType
  )
}

const responseHeaders = (headers: Headers): Readonly<Record<string, string>> => {
  const output: Record<string, string> = {}
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value
  })
  return output
}

const responseContentType = (headers: Headers) => {
  const raw = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  return raw || undefined
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  allowedContentTypes: ReadonlyArray<string>,
): Promise<{ readonly body: Uint8Array; readonly contentType?: string }> {
  const contentType = responseContentType(response.headers)
  if (
    allowedContentTypes.length > 0 &&
    (!contentType || !allowedContentTypes.some((pattern) => contentTypeMatches(contentType, pattern)))
  )
    throw new ExternalApiContentTypeError("response content type is not allowlisted")
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10)
    if (Number.isSafeInteger(parsed) && parsed > maximumBytes)
      throw new ExternalApiResponseLimitError("response exceeds byte limit")
  }
  if (!response.body) return { body: new Uint8Array(), contentType }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new ExternalApiResponseLimitError("response exceeds byte limit")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { body, contentType }
}

const validatePolicy = (policy: ExternalApiPolicy) => {
  const schemes = new Set(policy.allowedSchemes)
  if (schemes.size === 0 || [...schemes].some((scheme) => scheme !== "http" && scheme !== "https"))
    throw new ExternalApiValidationError("external API policy must allow at least one http(s) scheme")
  const hosts = new Set(policy.allowedHosts.map((host) => host.toLowerCase()))
  if (hosts.size === 0 || [...hosts].some((host) => !host || host.includes("/") || host.includes("@")))
    throw new ExternalApiValidationError("external API policy host allowlist is invalid")
  const methods = new Set(policy.allowedMethods.map((method) => method.toUpperCase()))
  if (methods.size === 0 || [...methods].some((method) => !/^[A-Z]+$/.test(method)))
    throw new ExternalApiValidationError("external API policy method allowlist is invalid")
  const maxRedirects = policy.maxRedirects ?? 3
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5)
    throw new ExternalApiValidationError("external API redirect budget is invalid")
  return { schemes, hosts, methods, maxRedirects }
}

const validateTarget = (value: string | URL, policy: ReturnType<typeof validatePolicy>) => {
  let target: URL
  try {
    target = new URL(value.toString())
  } catch {
    throw new ExternalApiPolicyError("external API URL is invalid")
  }
  const scheme = target.protocol.slice(0, -1)
  if (
    (scheme !== "http" && scheme !== "https") ||
    !policy.schemes.has(scheme) ||
    !policy.hosts.has(target.hostname.toLowerCase())
  )
    throw new ExternalApiPolicyError("external API URL is outside the allowlist")
  if (target.username || target.password || target.hash)
    throw new ExternalApiPolicyError("external API URL contains forbidden credentials")
  for (const key of target.searchParams.keys())
    if (SENSITIVE_QUERY_KEY.test(key))
      throw new ExternalApiPolicyError("external API URL contains a secret query parameter")
  return target
}

const validateSecretRefs = (refs: ReadonlyArray<ExternalApiSecretRef>, headers: ReadonlyMap<string, string>) => {
  const seen = new Set<string>()
  for (const ref of refs) {
    const header = validateSecretIdentifier("secret header", ref.header)
    if (!HEADER_NAME.test(header) || seen.has(header.toLowerCase()) || headers.has(header.toLowerCase()))
      throw new ExternalApiSecretError("secret header is invalid or duplicated")
    validateSecretIdentifier("secret name", ref.name)
    validateSecretIdentifier("secret scope", ref.scope)
    for (const origin of ref.allowedOrigins ?? []) {
      let parsed: URL
      try {
        parsed = new URL(origin)
      } catch {
        throw new ExternalApiSecretError("secret allowed origin is invalid")
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      )
        throw new ExternalApiSecretError("secret allowed origin is invalid")
    }
    seen.add(header.toLowerCase())
  }
}

const validateResponseBudget = (maximumBytes: number, allowedContentTypes: ReadonlyArray<string>) => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > MAX_RESPONSE_BYTES)
    throw new ExternalApiValidationError("response byte limit is invalid")
  for (const pattern of allowedContentTypes)
    if (typeof pattern !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(pattern.trim()))
      throw new ExternalApiValidationError("response content type allowlist is invalid")
}

export function createMemoryExternalApiActionJournal(
  initial: ReadonlyArray<ExternalApiActionReceipt> = [],
): ExternalApiActionJournal {
  const records = [...initial]
  return {
    append: async (receipt) => {
      records.push(receipt)
    },
    load: async () => [...records],
  }
}

export type ExternalApiReconciliationLookup = (
  operationID: string,
) => Promise<ExternalApiLookupState> | ExternalApiLookupState

export type ExternalApiReconciliationOptions = Readonly<{
  /** The same durable journal used by the External API Action client. */
  readonly journal: ExternalApiActionJournal
  /** Optional read-only operation lookup; it must not submit or mutate the operation. */
  readonly lookup?: ExternalApiReconciliationLookup
  readonly now?: () => number
}>

const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const isExternalIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value)

/**
 * Adapts the existing External API Action journal to the shared read-only
 * reconciliation seam. It projects only durable identity/digest metadata;
 * request bodies, URLs, headers, response bodies and error text never cross
 * into reconciliation evidence. The optional lookup is read-only and cannot
 * grant retry permission.
 */
export function createExternalApiReconciliationAdapter(
  options: ExternalApiReconciliationOptions,
): ReconciliationAdapter {
  const now = options.now ?? Date.now

  const latestReceipt = async (input: ReconciliationRequest) => {
    const records = await options.journal.load()
    let latest: ExternalApiActionReceipt | undefined
    for (const record of records)
      if (record && typeof record === "object" && record.actionID === input.actionID) latest = record
    return latest
  }

  const receiptMatches = (input: ReconciliationRequest, receipt: ExternalApiActionReceipt) =>
    isExternalIdentifier(receipt.operationID) &&
    receipt.idempotencyKey === input.idempotencyKey &&
    receipt.requestDigest === input.intentDigest &&
    isDigest(receipt.requestDigest) &&
    (receipt.responseDigest === undefined || isDigest(receipt.responseDigest))

  const evidence = (
    input: ReconciliationRequest,
    state: ReconciliationEvidence["state"],
    source: string,
    summary: string,
    receipt?: ExternalApiActionReceipt,
  ): ReconciliationEvidence => {
    const observedAt =
      receipt && Number.isSafeInteger(receipt.timeUpdated) && receipt.timeUpdated >= 0 ? receipt.timeUpdated : now()
    const evidenceDigest = sha256(
      JSON.stringify({
        actionID: input.actionID,
        intentDigest: input.intentDigest,
        idempotencyKey: input.idempotencyKey,
        state,
        source,
        receiptState: receipt?.state ?? "missing",
        receiptRequestDigest: receipt?.requestDigest ?? null,
        responseDigest: receipt?.responseDigest ?? null,
        errorCode: receipt?.errorCode ?? null,
        observedAt,
      }),
    )
    return {
      state,
      evidenceDigest,
      source,
      observedAt,
      summary,
    }
  }

  const inspect = async (input: ReconciliationRequest): Promise<ReconciliationEvidence> => {
    const receipt = await latestReceipt(input)
    if (!receipt) return evidence(input, "unknown", "external-api", "no durable external API receipt was found")
    if (!receiptMatches(input, receipt))
      return evidence(
        input,
        "unknown",
        "external-api",
        "durable receipt identity or intent digest does not match",
        receipt,
      )
    if (receipt.state === "settled")
      return evidence(input, "known_success", "external-api", "durable external API receipt is settled", receipt)
    if (receipt.state === "blocked")
      return evidence(input, "known_failure", "external-api", "durable external API receipt is blocked", receipt)
    return evidence(input, "unknown", "external-api", "external API receipt has no terminal observation", receipt)
  }

  const adapter: ReconciliationAdapter = {
    actionKind: "api",
    actionVersion: "1",
    inspect,
    ...(options.lookup
      ? {
          reconcile: async (input: ReconciliationRequest, initial: ReconciliationEvidence) => {
            if (initial.state !== "unknown") return initial
            const receipt = await latestReceipt(input)
            if (!receipt || !receiptMatches(input, receipt)) return initial
            const lookupState = await options.lookup!(receipt.operationID)
            if (lookupState === "settled")
              return evidence(
                input,
                "known_success",
                "external-api-lookup",
                "read-only lookup confirms the operation",
                receipt,
              )
            return evidence(input, "unknown", "external-api-lookup", `read-only lookup reports ${lookupState}`, receipt)
          },
        }
      : {}),
  }
  return Object.freeze(adapter)
}

export function createExternalApiActionClient(options: {
  readonly policy: ExternalApiPolicy
  readonly resolveSecret?: ExternalApiSecretResolver
  readonly fetch?: ExternalApiFetch
  readonly journal?: ExternalApiActionJournal
  readonly now?: () => number
  readonly sleep?: (delayMs: number) => Promise<void>
}) {
  const policy = validatePolicy(options.policy)
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== "function") throw new ExternalApiValidationError("fetch is unavailable")
  const journal = options.journal ?? createMemoryExternalApiActionJournal()
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep

  const execute = async (
    request: ExternalApiRequest,
  ): Promise<{ readonly response: ExternalApiResponse; readonly receipt: ExternalApiActionReceipt }> => {
    const operationID = validateIdentifier("operationID", request.operationID)
    const method = validateIdentifier("method", request.method).toUpperCase()
    if (!policy.methods.has(method)) throw new ExternalApiPolicyError("external API method is outside the allowlist")
    const initialTarget = validateTarget(request.url, policy)
    const headers = normaliseHeaders(request.headers)
    const secretHeaders = [...(request.secretHeaders ?? [])]
    validateSecretRefs(secretHeaders, headers)
    if (secretHeaders.length > 0 && !options.resolveSecret)
      throw new ExternalApiSecretError("secret resolver is unavailable")
    const idempotencyKey = validateIdentifier("idempotencyKey", request.idempotencyKey)
    const body = toBytes(request.body)
    const operationClass =
      request.operationClass ??
      (method === "GET" || method === "HEAD" || method === "OPTIONS" ? "read" : "non-idempotent-write")
    const maximumBytes = request.maxResponseBytes ?? 4 * 1024 * 1024
    const allowedContentTypes = [...(request.allowedResponseContentTypes ?? [])]
    validateResponseBudget(maximumBytes, allowedContentTypes)
    const maxRedirects = request.maxRedirects ?? policy.maxRedirects
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > policy.maxRedirects)
      throw new ExternalApiValidationError("request redirect budget exceeds policy")
    const maxAttempts = request.retry?.maxAttempts ?? 1
    const delayMs = request.retry?.delayMs ?? 0
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS)
      throw new ExternalApiValidationError("request retry budget is invalid")
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000)
      throw new ExternalApiValidationError("request retry delay is invalid")
    if (operationClass === "non-idempotent-write" && maxAttempts > 1 && !request.retry?.lookup)
      throw new ExternalApiValidationError("non-idempotent API retries require an operation lookup")
    if (operationClass !== "read" && !["idempotent-write", "non-idempotent-write"].includes(operationClass))
      throw new ExternalApiValidationError("operation class is invalid")
    const requestDigest = createRequestDigest({
      method,
      url: initialTarget,
      headers,
      secretHeaders,
      idempotencyKey,
      body,
    })

    // The journal is the durable cross-process idempotency boundary.  A new
    // client instance must inspect it before minting a fresh random action ID;
    // otherwise a cold restart could submit the same non-idempotent operation a
    // second time after the first process had already reached the provider.
    // Operation identity is exact: reusing an operationID with a changed
    // request or idempotency key is an intent error, never a new attempt.
    const priorRecords = await journal.load()
    let prior: ExternalApiActionReceipt | undefined
    for (const record of priorRecords)
      if (record && typeof record === "object" && record.operationID === operationID) prior = record
    if (prior) {
      if (prior.idempotencyKey !== idempotencyKey || prior.requestDigest !== requestDigest)
        throw new ExternalApiValidationError("operationID is already bound to a different request intent")
      if (prior.state === "settled")
        throw new ExternalApiAlreadySettledError(
          "external API operation already has a durable settled receipt; use read-only reconciliation to recover its result",
          prior,
        )
      if (prior.state === "blocked")
        throw new ExternalApiError(
          "EXTERNAL_API_ALREADY_BLOCKED",
          "external API operation already has a durable blocked receipt and was not retried",
          prior,
        )
      throw new ExternalApiRecoveryRequiredError(
        "external API operation has a non-terminal durable receipt; read-only reconciliation is required before retry",
        prior,
      )
    }

    const actionID = `act_api_${randomUUID()}`
    const traceID = `trace_api_${randomUUID()}`
    const created = now()
    let attemptCount = 0
    let lastSecretValues: string[] = []

    const makeReceipt = (
      state: ExternalApiActionState,
      extra: Partial<
        Omit<
          ExternalApiActionReceipt,
          | "actionID"
          | "traceID"
          | "operationID"
          | "method"
          | "idempotencyKey"
          | "requestDigest"
          | "state"
          | "attemptCount"
          | "timeCreated"
          | "timeUpdated"
        >
      > = {},
    ): ExternalApiActionReceipt =>
      Object.freeze({
        actionID,
        traceID,
        operationID,
        method,
        idempotencyKey,
        requestDigest,
        state,
        attemptCount,
        timeCreated: created,
        timeUpdated: now(),
        ...extra,
      })

    const record = async (state: ExternalApiActionState, extra = {}) => {
      const receipt = makeReceipt(state, extra)
      await journal.append(receipt)
      return receipt
    }

    await record("proposed")
    await record("executing")

    const finaliseFailure = async (
      error: unknown,
      state: "blocked" | "recovery_required",
      response?: ExternalApiResponse,
    ) => {
      const code = error instanceof ExternalApiError ? error.code : "EXTERNAL_API_TRANSPORT"
      const message = redactExternalText(error, lastSecretValues)
      const receipt = await record(state, {
        responseStatus: response?.status,
        responseDigest: response ? sha256(response.body) : undefined,
        responseByteLength: response?.body.byteLength,
        responseContentType: response?.contentType,
        errorCode: code,
        errorMessage: message,
      })
      if (state === "recovery_required") throw new ExternalApiRecoveryRequiredError(message, receipt)
      throw new ExternalApiError(code, message, receipt, error instanceof ExternalApiError ? error.status : undefined)
    }

    const retryAfterLookup = async () => {
      const lookup = request.retry?.lookup
      if (operationClass === "non-idempotent-write") {
        if (!lookup) return false
        let state: ExternalApiLookupState
        try {
          state = await lookup(operationID)
        } catch (error) {
          await finaliseFailure(
            new ExternalApiRecoveryRequiredError(
              redactExternalText(error, lastSecretValues),
              makeReceipt("recovery_required"),
            ),
            "recovery_required",
          )
          return false
        }
        if (state !== "missing")
          await finaliseFailure(
            new ExternalApiRecoveryRequiredError(`operation lookup is ${state}`, makeReceipt("recovery_required")),
            "recovery_required",
          )
      }
      if (delayMs > 0) await sleep(delayMs)
      return true
    }

    const performAttempt = async (): Promise<{
      readonly response: ExternalApiResponse
      readonly secretValues: ReadonlyArray<string>
    }> => {
      let currentTarget = initialTarget
      let currentMethod = method
      let currentBody: Uint8Array | undefined = body
      let redirectCount = 0
      let secretValues: string[] = []
      while (true) {
        const requestHeaders = new Headers()
        headers.forEach((value, name) => requestHeaders.set(name, value))
        requestHeaders.set("idempotency-key", idempotencyKey)
        for (const ref of secretHeaders) {
          const allowedOrigins = ref.allowedOrigins ?? [initialTarget.origin]
          if (!allowedOrigins.includes(currentTarget.origin))
            throw new ExternalApiSecretError("secret scope does not allow redirect origin")
          const value = await options.resolveSecret!(ref, currentTarget)
          if (value === undefined) throw new ExternalApiSecretError("scoped secret is unavailable")
          if (/[\r\n]/.test(value) || byteLength(value) > MAX_SECRET_BYTES)
            throw new ExternalApiSecretError("scoped secret is invalid")
          requestHeaders.set(ref.header, value)
          secretValues.push(value)
        }
        let response: Response
        try {
          response = await fetchImpl(currentTarget.toString(), {
            method: currentMethod,
            headers: requestHeaders,
            body:
              currentMethod === "GET" || currentMethod === "HEAD"
                ? undefined
                : currentBody
                  ? Buffer.from(currentBody)
                  : undefined,
            redirect: "manual",
          })
        } catch (error) {
          throw new ExternalApiError("EXTERNAL_API_TRANSPORT", redactExternalText(error, secretValues))
        }
        if (!REDIRECT_STATUSES.has(response.status)) {
          const payload = await readBoundedResponse(response, maximumBytes, allowedContentTypes)
          return {
            response: {
              status: response.status,
              headers: responseHeaders(response.headers),
              body: payload.body,
              ...(payload.contentType ? { contentType: payload.contentType } : {}),
              url: currentTarget.toString(),
              attempt: attemptCount,
            },
            secretValues,
          }
        }
        await response.body?.cancel()
        const location = response.headers.get("location")
        if (!location || redirectCount >= maxRedirects)
          throw new ExternalApiPolicyError("external API redirect budget is exhausted")
        const nextTarget = validateTarget(new URL(location, currentTarget), policy)
        redirectCount += 1
        if (response.status === 303) {
          currentMethod = "GET"
          currentBody = undefined
        }
        currentTarget = nextTarget
      }
    }

    while (attemptCount < maxAttempts) {
      attemptCount += 1
      try {
        const result = await performAttempt()
        lastSecretValues = [...result.secretValues]
        const response = result.response
        const successful = response.status >= 200 && response.status < 300
        if (successful) {
          if (operationClass !== "read") {
            if (!request.verify)
              await finaliseFailure(
                new ExternalApiError(
                  "EXTERNAL_API_VERIFIER_REQUIRED",
                  "write response requires a read-after-write verifier",
                ),
                "recovery_required",
                response,
              )
            let verified = false
            try {
              verified = await request.verify!(response)
            } catch (error) {
              await finaliseFailure(
                new ExternalApiError("EXTERNAL_API_VERIFIER_FAILED", redactExternalText(error, lastSecretValues)),
                "recovery_required",
                response,
              )
            }
            if (!verified)
              await finaliseFailure(
                new ExternalApiError(
                  "EXTERNAL_API_VERIFIER_FAILED",
                  "read-after-write verifier did not confirm settled state",
                ),
                "recovery_required",
                response,
              )
          }
          const receipt = await record("settled", {
            responseStatus: response.status,
            responseDigest: sha256(response.body),
            responseByteLength: response.body.byteLength,
            responseContentType: response.contentType,
          })
          return { response, receipt }
        }
        const retryable =
          response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
        if (retryable && attemptCount < maxAttempts && (await retryAfterLookup())) continue
        const error = new ExternalApiHttpError(response.status, `external API returned HTTP ${response.status}`)
        await finaliseFailure(
          error,
          operationClass === "read" || !retryable ? "blocked" : "recovery_required",
          response,
        )
      } catch (error) {
        if (error instanceof ExternalApiRecoveryRequiredError) throw error
        if (error instanceof ExternalApiError && error.receipt) throw error
        const retryableTransport = error instanceof ExternalApiError && error.code === "EXTERNAL_API_TRANSPORT"
        if (retryableTransport && attemptCount < maxAttempts && (await retryAfterLookup())) continue
        await finaliseFailure(error, operationClass === "read" ? "blocked" : "recovery_required")
      }
    }
    throw new ExternalApiError("EXTERNAL_API_ATTEMPTS_EXHAUSTED", "external API attempt budget exhausted")
  }

  return { execute }
}
