import { createHash } from "node:crypto"
import type { ExternalState } from "./recovery-planner"

const DIGEST = /^[0-9a-f]{64}$/
const IDENTIFIER = /^[a-z][a-z0-9._:-]{0,63}$/
const VERSION = /^[a-z0-9][a-z0-9._:-]{0,63}$/
const MAX_ID_BYTES = 160
const MAX_SUMMARY_BYTES = 512

export type ReconciliationState = Exclude<ExternalState, "not_applicable">

export type ReconciliationRequest = Readonly<{
  /** Durable action identity; no decoded tool arguments cross this seam. */
  readonly actionID: string
  readonly actionKind: string
  readonly actionVersion: string
  readonly intentDigest: string
  /** Required even for read-only inspection so a later write cannot be confused with this request. */
  readonly idempotencyKey: string
}>

export type ReconciliationEvidence = Readonly<{
  readonly state: ReconciliationState
  /** Digest of adapter-owned external evidence, never the raw response body. */
  readonly evidenceDigest: string
  readonly source: string
  readonly observedAt: number
  readonly summary?: string
}>

export type ReconciliationDecision = Readonly<{
  readonly kind: "confirmed" | "manual_review"
  readonly state: ReconciliationState
  readonly evidence: ReconciliationEvidence
  /** Hard invariant: this API never authorizes a second side effect. */
  readonly automaticRetryAllowed: false
  readonly reason: string
  readonly adapterFailure?: boolean
}>

export type MaybePromise<A> = A | PromiseLike<A>

export type ReconciliationAdapter = Readonly<{
  readonly actionKind: string
  readonly actionVersion: string
  /** Read-only lookup of the external operation by its durable identity. */
  readonly inspect: (input: ReconciliationRequest) => MaybePromise<ReconciliationEvidence>
  /** Optional second read-after-unknown lookup; it must not retry or mutate the operation. */
  readonly reconcile?: (
    input: ReconciliationRequest,
    initial: ReconciliationEvidence,
  ) => MaybePromise<ReconciliationEvidence>
}>

export class ReconciliationError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "DUPLICATE_ADAPTER" | "NO_ADAPTER" | "INVALID_EVIDENCE",
    message: string,
  ) {
    super(message)
    this.name = "ReconciliationError"
  }
}

const byteLength = (value: string) => Buffer.byteLength(value, "utf8")

const requiredIdentifier = (name: string, value: unknown, maxBytes = MAX_ID_BYTES) => {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maxBytes)
    throw new ReconciliationError("INVALID_REQUEST", `${name} is missing or too long`)
  return value
}

const adapterIdentifier = (name: string, value: unknown) => {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new ReconciliationError("INVALID_REQUEST", `${name} must be a bounded lowercase identifier`)
  return value
}

const adapterVersion = (name: string, value: unknown) => {
  if (typeof value !== "string" || !VERSION.test(value))
    throw new ReconciliationError("INVALID_REQUEST", `${name} must be a bounded lowercase version`)
  return value
}

const validateRequest = (input: ReconciliationRequest): ReconciliationRequest => {
  const actionID = requiredIdentifier("actionID", input.actionID)
  const actionKind = adapterIdentifier("actionKind", input.actionKind)
  const actionVersion = adapterVersion("actionVersion", input.actionVersion)
  if (typeof input.intentDigest !== "string" || !DIGEST.test(input.intentDigest))
    throw new ReconciliationError("INVALID_REQUEST", "intentDigest must be a SHA-256 digest")
  const idempotencyKey = requiredIdentifier("idempotencyKey", input.idempotencyKey)
  return Object.freeze({ actionID, actionKind, actionVersion, intentDigest: input.intentDigest, idempotencyKey })
}

const validateEvidence = (value: ReconciliationEvidence): ReconciliationEvidence => {
  if (value === null || typeof value !== "object")
    throw new ReconciliationError("INVALID_EVIDENCE", "reconciliation adapter returned no evidence")
  if (!(["known_success", "known_failure", "unknown"] as ReadonlyArray<string>).includes(value.state))
    throw new ReconciliationError("INVALID_EVIDENCE", "reconciliation evidence state is invalid")
  if (typeof value.evidenceDigest !== "string" || !DIGEST.test(value.evidenceDigest))
    throw new ReconciliationError("INVALID_EVIDENCE", "reconciliation evidence digest is invalid")
  if (typeof value.source !== "string" || !IDENTIFIER.test(value.source))
    throw new ReconciliationError("INVALID_EVIDENCE", "reconciliation evidence source is invalid")
  if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0)
    throw new ReconciliationError("INVALID_EVIDENCE", "reconciliation evidence timestamp is invalid")
  if (
    value.summary !== undefined &&
    (typeof value.summary !== "string" || byteLength(value.summary) > MAX_SUMMARY_BYTES || /[\u0000-\u001f\u007f]/.test(value.summary))
  )
    throw new ReconciliationError("INVALID_EVIDENCE", "reconciliation evidence summary is invalid")
  return Object.freeze({
    state: value.state,
    evidenceDigest: value.evidenceDigest,
    source: value.source,
    observedAt: value.observedAt,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
  })
}

const key = (actionKind: string, actionVersion: string) => `${actionKind}@${actionVersion}`

const registryEvidence = (input: ReconciliationRequest, summary: string): ReconciliationEvidence => {
  const evidenceDigest = createHash("sha256")
    .update(`${input.actionID}\0${input.intentDigest}\0${summary}`)
    .digest("hex")
  return {
    state: "unknown",
    evidenceDigest,
    source: "registry",
    observedAt: Date.now(),
    summary,
  }
}

const manualReview = (
  evidence: ReconciliationEvidence,
  reason: string,
  adapterFailure = false,
): ReconciliationDecision => ({
  kind: "manual_review",
  state: evidence.state,
  evidence,
  automaticRetryAllowed: false,
  reason,
  ...(adapterFailure ? { adapterFailure: true } : {}),
})

const confirmed = (evidence: ReconciliationEvidence, via: "inspect" | "reconcile"): ReconciliationDecision => ({
  kind: "confirmed",
  state: evidence.state,
  evidence,
  automaticRetryAllowed: false,
  reason: `${via} confirmed ${evidence.state}; no retry was executed.`,
})

/**
 * Read-only reconciliation seam for external file/MCP/API adapters.
 *
 * The registry owns only adapter selection and evidence validation. It does
 * not persist state, authorize a tool, settle an ActionGateway action, or
 * invoke a second side effect. Callers must use the returned evidence with
 * the existing durable authority and may never infer retry permission from it.
 */
export class ReconciliationRegistry {
  private readonly adapters = new Map<string, ReconciliationAdapter>()

  register(adapter: ReconciliationAdapter): this {
    const actionKind = adapterIdentifier("actionKind", adapter.actionKind)
    const actionVersion = adapterVersion("actionVersion", adapter.actionVersion)
    if (typeof adapter.inspect !== "function")
      throw new ReconciliationError("INVALID_REQUEST", "reconciliation adapter must provide inspect")
    const adapterKey = key(actionKind, actionVersion)
    if (this.adapters.has(adapterKey))
      throw new ReconciliationError("DUPLICATE_ADAPTER", `reconciliation adapter already registered: ${adapterKey}`)
    this.adapters.set(
      adapterKey,
      Object.freeze({ ...adapter, actionKind, actionVersion }),
    )
    return this
  }

  get(actionKind: string, actionVersion: string): ReconciliationAdapter | undefined {
    return this.adapters.get(key(actionKind, actionVersion))
  }

  list(): ReadonlyArray<ReconciliationAdapter> {
    return Object.freeze([...this.adapters.values()])
  }

  async inspect(input: ReconciliationRequest): Promise<ReconciliationEvidence> {
    const request = validateRequest(input)
    const adapter = this.get(request.actionKind, request.actionVersion)
    if (!adapter)
      throw new ReconciliationError(
        "NO_ADAPTER",
        `no reconciliation adapter registered for ${request.actionKind}@${request.actionVersion}`,
      )
    return validateEvidence(await adapter.inspect(request))
  }

  async reconcile(input: ReconciliationRequest): Promise<ReconciliationDecision> {
    const request = validateRequest(input)
    const adapter = this.get(request.actionKind, request.actionVersion)
    if (!adapter) {
      return manualReview(
        registryEvidence(request, "no reconciliation adapter"),
        "No read-only reconciliation adapter is registered; external state remains unknown and manual review is required.",
      )
    }

    const initial = validateEvidence(await adapter.inspect(request))
    if (initial.state !== "unknown") return confirmed(initial, "inspect")
    if (adapter.reconcile === undefined)
      return manualReview(
        initial,
        "External state is unknown and this adapter has no second read-only reconciliation query; manual review is required.",
      )

    let followUp: ReconciliationEvidence
    try {
      followUp = validateEvidence(await adapter.reconcile(request, initial))
    } catch {
      return manualReview(
        initial,
        "The reconciliation query failed closed; external state remains unknown and no retry was executed.",
        true,
      )
    }
    if (followUp.state === "unknown")
      return manualReview(
        followUp,
        "External state remains unknown after reconciliation; manual review is required and no retry was executed.",
      )
    return confirmed(followUp, "reconcile")
  }
}
