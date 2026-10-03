/**
 * Cross-aggregate child settlement intent and recovery contract.
 *
 * DurableRun and ExperienceStore remain the owners of their respective
 * aggregates.  This module does not write either owner and does not execute a
 * provider.  It records the immutable, payload-free facts a future recovery
 * outbox must use when a process crashes between admission Evidence, the child
 * result event, and the parent budget settlement event.
 *
 * The contract is deliberately declarative: a recovery worker may replay only
 * the missing idempotent persistence steps returned by `reconcile`; it may
 * never infer that a provider operation is safe to run again.
 */

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { childResultDigest, childRunIDFor, type ChildResultInput } from "./child-contract"
import { canonicalHash } from "../util/canonical-hash"
import type { ReferenceResolutionFacts } from "../evidence"

const DIGEST = /^[a-f0-9]{64}$/i
const RUN_ID = /^run_[A-Za-z0-9._:-]{1,255}$/
const ACTION_ID = /^act_[A-Za-z0-9._:-]{1,255}$/
const OBSERVATION_ID = /^obs_[A-Za-z0-9._:-]{1,255}$/
const EVIDENCE_ID = /^evd_[A-Za-z0-9._:-]{1,255}$/
const INTENT_ID = /^stl_[a-f0-9]{64}$/
const MAX_IDEMPOTENCY_BYTES = 256
const MAX_SUMMARY_BYTES = 16_000

export const SCHEMA_VERSION = 1 as const

export type SettlementWrite = "admission-evidence" | "child-result" | "parent-budget"

export type SettlementComponent<A extends string = string> =
  | { readonly state: "not-required" }
  | { readonly state: "missing" }
  | { readonly state: "present"; readonly digest: string; readonly identity?: string }
  | { readonly state: "conflict"; readonly reason: string }

export type SettlementFacts = Readonly<{
  /** The outbox row itself must have survived before reconciliation can begin. */
  readonly intent: "present" | "missing" | "conflict"
  readonly evidence: SettlementComponent<"evidence">
  readonly childResult: SettlementComponent<"child-result">
  readonly parentBudget: SettlementComponent<"parent-budget">
}>

/** DurableRun-owned subset; Evidence is resolved by ExperienceStore separately. */
export type DurableSettlementFacts = Readonly<Pick<SettlementFacts, "childResult" | "parentBudget">>

/**
 * Merge the two existing durable owners into one read-only settlement view.
 * DurableRun supplies child-result/parent-budget facts while ExperienceStore
 * supplies owner-scoped Evidence existence plus record digests.  The helper
 * deliberately has no Effect/database dependency, so a recovery worker can
 * make the same decision after a restart without creating a second state
 * machine or authorizing provider execution.
 */
export const mergeEvidenceFacts = (
  intent: SettlementIntent,
  durable: DurableSettlementFacts,
  resolved: ReferenceResolutionFacts,
): SettlementFacts => {
  const normalizedIntent = validateIntent(intent)
  if (durable === null || typeof durable !== "object")
    throw new ChildSettlementError("INVALID_FACTS", "DurableRun settlement facts are required")
  const childResult = durable.childResult
  const parentBudget = durable.parentBudget
  for (const [name, component] of Object.entries({ childResult, parentBudget })) {
    if (component === null || typeof component !== "object" || !("state" in component))
      throw new ChildSettlementError("INVALID_FACTS", `${name} facts are invalid`)
    if (component.state === "present") {
      digest(`${name} digest`, component.digest)
      if (component.identity !== undefined) requiredString(`${name} identity`, component.identity, 512)
    }
    if (component.state === "conflict") requiredString(`${name} conflict reason`, component.reason, 512)
    if (!(component.state === "missing" || component.state === "present" || component.state === "conflict"))
      throw new ChildSettlementError("INVALID_FACTS", `${name} state is invalid`)
  }
  if (
    resolved === null ||
    typeof resolved !== "object" ||
    resolved.resolution === null ||
    typeof resolved.resolution !== "object" ||
    !Array.isArray(resolved.resolution.requested) ||
    !Array.isArray(resolved.resolution.present) ||
    !Array.isArray(resolved.resolution.missing) ||
    !Array.isArray(resolved.resolution.duplicate) ||
    !Array.isArray(resolved.resolution.invalid) ||
    typeof resolved.resolution.valid !== "boolean" ||
    !Array.isArray(resolved.recordDigests)
  )
    throw new ChildSettlementError("INVALID_FACTS", "Evidence resolver facts are invalid")

  const resolution = resolved.resolution
  for (const value of [
    ...resolution.requested,
    ...resolution.present,
    ...resolution.missing,
    ...resolution.duplicate,
  ]) {
    if (typeof value !== "string" || !EVIDENCE_ID.test(value))
      throw new ChildSettlementError("INVALID_FACTS", "Evidence resolver returned an invalid EvidenceID")
  }
  if (resolution.invalid.some((value) => typeof value !== "string"))
    throw new ChildSettlementError("INVALID_FACTS", "Evidence resolver returned an invalid malformed reference")
  const digestEntries = resolved.recordDigests.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.evidenceID !== "string" ||
      !EVIDENCE_ID.test(entry.evidenceID)
    )
      throw new ChildSettlementError("INVALID_FACTS", "Evidence resolver returned an invalid digest identity")
    return { evidenceID: entry.evidenceID, recordDigest: digest("Evidence resolver recordDigest", entry.recordDigest) }
  })
  if (new Set(digestEntries.map((entry) => entry.evidenceID)).size !== digestEntries.length)
    throw new ChildSettlementError("INVALID_FACTS", "Evidence resolver returned duplicate record digests")
  if (digestEntries.length !== resolution.present.length)
    throw new ChildSettlementError("INVALID_FACTS", "Evidence resolver did not return every present record digest")
  if (digestEntries.some((entry) => !resolution.present.some((id) => String(id) === entry.evidenceID)))
    throw new ChildSettlementError("INVALID_FACTS", "Evidence resolver returned a digest for a non-present reference")

  const admission = normalizedIntent.admissionEvidence
  let evidence: SettlementComponent
  if (admission === undefined) {
    // Legacy children may carry placeholder evidenceRefs.  No admission
    // receipt means Evidence is not a required settlement owner and must not
    // be promoted to a gate merely because a caller supplied extra resolver
    // facts.
    evidence = { state: "not-required" }
  } else {
    const admissionID = String(admission.evidenceID)
    const digestEntry = digestEntries.find((entry) => String(entry.evidenceID) === admissionID)
    const invalidResolver = resolution.invalid.length > 0 || resolution.duplicate.length > 0
    const requested = resolution.requested.some((id) => String(id) === admissionID)
    const present = resolution.present.some((id) => String(id) === admissionID)
    const missing = resolution.missing.some((id) => String(id) === admissionID)
    if (invalidResolver)
      evidence = { state: "conflict", reason: "Evidence resolver returned malformed or duplicate references" }
    else if (!requested || missing || !present) evidence = { state: "missing" }
    else if (!resolution.valid)
      evidence = { state: "conflict", reason: "Evidence resolver reports unresolved settlement references" }
    else if (digestEntry === undefined)
      evidence = { state: "conflict", reason: "Evidence resolver did not return the owner record digest" }
    else if (digestEntry.recordDigest.toLowerCase() !== admission.recordDigest.toLowerCase())
      evidence = { state: "conflict", reason: "Evidence record digest does not match settlement intent" }
    else evidence = { state: "present", digest: digestEntry.recordDigest, identity: admissionID }
  }
  return Object.freeze({
    intent: "present",
    evidence,
    childResult,
    parentBudget,
  })
}

export type AdmissionEvidenceReceipt = Readonly<{
  readonly evidenceID: AgentRuntime.EvidenceID
  readonly recordDigest: string
  readonly actionID?: AgentRuntime.ActionID
  readonly observationID?: AgentRuntime.ObservationID
}>

export type SettlementIntent = Readonly<{
  readonly schemaVersion: typeof SCHEMA_VERSION
  /** Stable identity of this immutable settlement attempt. */
  readonly intentID: string
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly idempotencyKey: string
  readonly idempotencyDigest: string
  readonly status: AgentRuntime.ChildRunResult["status"]
  readonly summary: string
  readonly artifactRefs: ReadonlyArray<AgentRuntime.ArtifactID>
  readonly evidenceRefs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly usage: AgentRuntime.ChildBudgetAmount
  readonly resultDigest: string
  readonly admissionEvidence?: AdmissionEvidenceReceipt
  readonly createdAtMs: number
}>

export type SettlementRecoveryDecision = Readonly<{
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly intentID?: string
  readonly deterministic: true
  /** Recovery steps are always ordered and never include provider execution. */
  readonly next: ReadonlyArray<SettlementWrite>
  readonly missing: ReadonlyArray<SettlementWrite>
  readonly conflicts: ReadonlyArray<string>
  readonly complete: boolean
  readonly providerExecutionAllowed: false
  readonly reason: string
}>

export class ChildSettlementError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "INVALID_FACTS" | "INTENT_CONFLICT" | "COMPONENT_CONFLICT" | "MISSING_INTENT",
    message: string,
  ) {
    super(message)
    this.name = "ChildSettlementError"
  }
}

const bytes = (value: string) => Buffer.byteLength(value, "utf8")

const requiredString = (name: string, value: unknown, maximum: number, allowLineBreaks = false) => {
  const unsafe = allowLineBreaks ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/
  if (typeof value !== "string" || value.length === 0 || bytes(value) > maximum || unsafe.test(value))
    throw new ChildSettlementError("INVALID_INPUT", `${name} is missing, unsafe, or too long`)
  return value
}

const runID = (name: string, value: unknown): AgentRuntime.RunID => {
  if (typeof value !== "string" || !RUN_ID.test(value))
    throw new ChildSettlementError("INVALID_INPUT", `${name} is not a bounded run identity`)
  return AgentRuntime.RunID.make(value)
}

const digest = (name: string, value: unknown) => {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new ChildSettlementError("INVALID_INPUT", `${name} must be a SHA-256 digest`)
  return value.toLowerCase()
}

const nonNegative = (name: string, value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ChildSettlementError("INVALID_INPUT", `${name} must be a non-negative safe integer`)
  return value as number
}

const boundedRefs = <A extends string>(name: string, values: ReadonlyArray<A>, pattern: RegExp, maximum = 32) => {
  if (!Array.isArray(values) || values.length > maximum)
    throw new ChildSettlementError("INVALID_INPUT", `${name} exceeds its bounded contract`)
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !pattern.test(value))
      throw new ChildSettlementError("INVALID_INPUT", `${name} contains an invalid identity`)
    return value
  })
  if (new Set(normalized).size !== normalized.length)
    throw new ChildSettlementError("INVALID_INPUT", `${name} contains duplicate identities`)
  return Object.freeze([...normalized]) as ReadonlyArray<A>
}

const budget = (value: AgentRuntime.ChildBudgetAmount): AgentRuntime.ChildBudgetAmount =>
  Object.freeze({
    attempts: nonNegative("usage.attempts", value.attempts),
    durationMs: nonNegative("usage.durationMs", value.durationMs),
    costMicros: nonNegative("usage.costMicros", value.costMicros),
    tokens: nonNegative("usage.tokens", value.tokens),
  })

const validateAdmission = (value: AdmissionEvidenceReceipt | undefined) => {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null)
    throw new ChildSettlementError("INVALID_INPUT", "admission Evidence receipt is invalid")
  if (typeof value.evidenceID !== "string" || !EVIDENCE_ID.test(value.evidenceID))
    throw new ChildSettlementError("INVALID_INPUT", "admission Evidence ID is invalid")
  const recordDigest = digest("admission Evidence recordDigest", value.recordDigest)
  const actionID =
    value.actionID === undefined
      ? undefined
      : typeof value.actionID === "string" && ACTION_ID.test(value.actionID)
        ? AgentRuntime.ActionID.make(value.actionID)
        : (() => {
            throw new ChildSettlementError("INVALID_INPUT", "admission Evidence actionID is invalid")
          })()
  const observationID =
    value.observationID === undefined
      ? undefined
      : typeof value.observationID === "string" && OBSERVATION_ID.test(value.observationID)
        ? AgentRuntime.ObservationID.make(value.observationID)
        : (() => {
            throw new ChildSettlementError("INVALID_INPUT", "admission Evidence observationID is invalid")
          })()
  return Object.freeze({
    evidenceID: AgentRuntime.EvidenceID.make(value.evidenceID),
    recordDigest,
    ...(actionID === undefined ? {} : { actionID }),
    ...(observationID === undefined ? {} : { observationID }),
  })
}

const validateFacts = (facts: SettlementFacts) => {
  if (facts === null || typeof facts !== "object")
    throw new ChildSettlementError("INVALID_FACTS", "settlement facts are required")
  if (!(facts.intent === "present" || facts.intent === "missing" || facts.intent === "conflict"))
    throw new ChildSettlementError("INVALID_FACTS", "settlement intent state is invalid")
  for (const [name, component] of Object.entries({
    evidence: facts.evidence,
    childResult: facts.childResult,
    parentBudget: facts.parentBudget,
  })) {
    if (component === null || typeof component !== "object")
      throw new ChildSettlementError("INVALID_FACTS", `${name} facts are invalid`)
    if (!("state" in component)) throw new ChildSettlementError("INVALID_FACTS", `${name} state is missing`)
    if (component.state === "present") {
      digest(`${name} digest`, component.digest)
      if (component.identity !== undefined) requiredString(`${name} identity`, component.identity, 512)
    }
    if (component.state === "conflict") requiredString(`${name} conflict reason`, component.reason, 512)
    if (
      !(
        component.state === "not-required" ||
        component.state === "missing" ||
        component.state === "present" ||
        component.state === "conflict"
      )
    )
      throw new ChildSettlementError("INVALID_FACTS", `${name} state is invalid`)
  }
  return facts
}

const validateIntent = (input: SettlementIntent): SettlementIntent => {
  if (
    input === null ||
    typeof input !== "object" ||
    input.schemaVersion !== SCHEMA_VERSION ||
    typeof input.intentID !== "string" ||
    !INTENT_ID.test(input.intentID)
  )
    throw new ChildSettlementError("INVALID_INPUT", "settlement intent is invalid")
  let normalized: SettlementIntent
  try {
    normalized = createIntent({
      parentRunID: input.parentRunID,
      childRunID: input.childRunID,
      idempotencyKey: input.idempotencyKey,
      result: {
        status: input.status,
        summary: input.summary,
        artifactRefs: input.artifactRefs,
        evidenceRefs: input.evidenceRefs,
        usage: input.usage,
      },
      ...(input.admissionEvidence === undefined ? {} : { admissionEvidence: input.admissionEvidence }),
      createdAtMs: input.createdAtMs,
    })
  } catch (error) {
    if (error instanceof ChildSettlementError) throw error
    throw new ChildSettlementError("INVALID_INPUT", `settlement intent failed validation: ${String(error)}`)
  }
  if (
    normalized.intentID !== input.intentID ||
    normalized.idempotencyDigest !== input.idempotencyDigest ||
    normalized.resultDigest !== input.resultDigest ||
    JSON.stringify(normalized.artifactRefs) !== JSON.stringify(input.artifactRefs) ||
    JSON.stringify(normalized.evidenceRefs) !== JSON.stringify(input.evidenceRefs) ||
    JSON.stringify(normalized.usage) !== JSON.stringify(input.usage)
  )
    throw new ChildSettlementError("INVALID_INPUT", "settlement intent immutable fields do not match its digest")
  return normalized
}

const immutableResult = (input: {
  readonly status: AgentRuntime.ChildRunResult["status"]
  readonly summary: string
  readonly artifactRefs: ReadonlyArray<AgentRuntime.ArtifactID>
  readonly evidenceRefs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly usage: AgentRuntime.ChildBudgetAmount
}) => {
  if (!(input.status === "completed" || input.status === "failed" || input.status === "cancelled"))
    throw new ChildSettlementError("INVALID_INPUT", "child result status is invalid")
  // Summaries are already a bounded ChildRun receipt and may contain normal
  // line breaks; reject binary/control bytes without flattening useful text.
  const summary = requiredString("child result summary", input.summary, MAX_SUMMARY_BYTES, true)
  const artifactRefs = boundedRefs(
    "artifactRefs",
    input.artifactRefs,
    /^art_[A-Za-z0-9._:-]{1,255}$/,
    128,
  ) as ReadonlyArray<AgentRuntime.ArtifactID>
  const evidenceRefs = boundedRefs(
    "evidenceRefs",
    input.evidenceRefs,
    EVIDENCE_ID,
    32,
  ) as ReadonlyArray<AgentRuntime.EvidenceID>
  const usage = budget(input.usage)
  const result = { status: input.status, summary, artifactRefs, evidenceRefs, usage } satisfies ChildResultInput
  const resultDigest = childResultDigest(result)
  if (!resultDigest) throw new ChildSettlementError("INVALID_INPUT", "child result is not canonically hashable")
  return { result, resultDigest }
}

/**
 * Build the immutable outbox intent.  Repeated calls with the same input
 * produce byte-for-byte equivalent data and the same intent ID.
 */
export const createIntent = (input: {
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly idempotencyKey: string
  readonly result: ChildResultInput
  readonly admissionEvidence?: AdmissionEvidenceReceipt
  readonly createdAtMs: number
}): SettlementIntent => {
  const parentRunID = runID("parentRunID", input.parentRunID)
  const childRunID = runID("childRunID", input.childRunID)
  const idempotencyKey = requiredString("idempotencyKey", input.idempotencyKey, MAX_IDEMPOTENCY_BYTES)
  const expectedChildID = childRunIDFor(parentRunID, idempotencyKey)
  if (expectedChildID !== childRunID)
    throw new ChildSettlementError("INVALID_INPUT", "childRunID does not match parent/idempotency identity")
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0)
    throw new ChildSettlementError("INVALID_INPUT", "createdAtMs must be a non-negative safe integer")
  const normalized = immutableResult(input.result)
  const admissionEvidence = validateAdmission(input.admissionEvidence)
  if (
    admissionEvidence &&
    !normalized.result.evidenceRefs.some((id) => String(id) === String(admissionEvidence.evidenceID))
  )
    throw new ChildSettlementError("INVALID_INPUT", "admission Evidence ID must be carried by the child result")
  const idempotencyDigest = canonicalHash({ version: SCHEMA_VERSION, parentRunID, childRunID, idempotencyKey })
  if (!idempotencyDigest) throw new ChildSettlementError("INVALID_INPUT", "settlement identity is not canonicalizable")
  const intentDigest = canonicalHash({
    version: SCHEMA_VERSION,
    parentRunID,
    childRunID,
    idempotencyDigest,
    resultDigest: normalized.resultDigest,
    admissionEvidence: admissionEvidence ?? null,
  })
  if (!intentDigest) throw new ChildSettlementError("INVALID_INPUT", "settlement intent is not canonicalizable")
  const intentID = `stl_${intentDigest}`
  if (!INTENT_ID.test(intentID)) throw new ChildSettlementError("INVALID_INPUT", "settlement intent ID is invalid")
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    intentID,
    parentRunID,
    childRunID,
    idempotencyKey,
    idempotencyDigest,
    status: normalized.result.status,
    summary: normalized.result.summary,
    artifactRefs: normalized.result.artifactRefs,
    evidenceRefs: normalized.result.evidenceRefs,
    usage: normalized.result.usage,
    resultDigest: normalized.resultDigest,
    ...(admissionEvidence === undefined ? {} : { admissionEvidence }),
    createdAtMs: input.createdAtMs,
  })
}

const componentDigest = (component: SettlementComponent, name: SettlementWrite, expected: string) => {
  if (component.state === "not-required") {
    if (name === "admission-evidence") return undefined
    return `${name} cannot be marked not-required`
  }
  if (component.state === "missing") return undefined
  if (component.state === "conflict") return component.reason
  return component.digest === expected ? undefined : `${name} digest does not match settlement intent`
}

/**
 * Reconcile a durable intent after restart.  The result is a deterministic,
 * payload-free list of idempotent owner writes.  It never authorizes provider
 * execution, even when all three durable components are absent.
 */
export const reconcile = (intent: SettlementIntent, rawFacts: SettlementFacts): SettlementRecoveryDecision => {
  const normalizedIntent = validateIntent(intent)
  validateFacts(rawFacts)
  if (rawFacts.intent === "missing")
    throw new ChildSettlementError("MISSING_INTENT", "settlement intent is missing; automatic recovery is forbidden")
  if (rawFacts.intent === "conflict")
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      intentID: normalizedIntent.intentID,
      deterministic: true,
      next: Object.freeze([]),
      missing: Object.freeze([]),
      conflicts: Object.freeze(["settlement intent row conflicts with the immutable request"]),
      complete: false,
      providerExecutionAllowed: false,
      reason: "The recovery outbox row is divergent; manual review is required.",
    })

  const conflicts: string[] = []
  const missing: SettlementWrite[] = []
  const expectedEvidence = normalizedIntent.admissionEvidence?.recordDigest
  const evidenceState: SettlementComponent =
    normalizedIntent.admissionEvidence === undefined ? { state: "not-required" } : rawFacts.evidence
  if (
    normalizedIntent.admissionEvidence !== undefined &&
    evidenceState.state === "present" &&
    evidenceState.identity !== undefined &&
    evidenceState.identity !== String(normalizedIntent.admissionEvidence.evidenceID)
  )
    conflicts.push("admission-evidence identity does not match settlement intent")
  const evidenceConflict = componentDigest(evidenceState, "admission-evidence", expectedEvidence ?? "")
  if (evidenceConflict && !conflicts.includes(evidenceConflict)) conflicts.push(evidenceConflict)
  else if (evidenceState.state === "missing") missing.push("admission-evidence")
  const resultConflict = componentDigest(rawFacts.childResult, "child-result", normalizedIntent.resultDigest)
  if (resultConflict) conflicts.push(resultConflict)
  else if (rawFacts.childResult.state === "missing") missing.push("child-result")
  if (
    rawFacts.childResult.state === "present" &&
    rawFacts.childResult.identity !== undefined &&
    rawFacts.childResult.identity !== String(normalizedIntent.childRunID)
  )
    conflicts.push("child-result identity does not match settlement intent")
  const expectedBudgetDigest = canonicalHash(normalizedIntent.usage)
  if (!expectedBudgetDigest) throw new ChildSettlementError("INVALID_INPUT", "settlement usage is not canonicalizable")
  const budgetConflict = componentDigest(rawFacts.parentBudget, "parent-budget", expectedBudgetDigest)
  if (budgetConflict) conflicts.push(budgetConflict)
  else if (rawFacts.parentBudget.state === "missing") missing.push("parent-budget")
  if (
    rawFacts.parentBudget.state === "present" &&
    rawFacts.parentBudget.identity !== undefined &&
    rawFacts.parentBudget.identity !== String(normalizedIntent.childRunID)
  )
    conflicts.push("parent-budget identity does not match settlement intent")

  if (conflicts.length > 0)
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      intentID: normalizedIntent.intentID,
      deterministic: true,
      next: Object.freeze([]),
      missing: Object.freeze(missing),
      conflicts: Object.freeze(conflicts),
      complete: false,
      providerExecutionAllowed: false,
      reason: "A durable component conflicts with the immutable intent; recovery stops fail-closed.",
    })
  if (missing.length === 0)
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      intentID: normalizedIntent.intentID,
      deterministic: true,
      next: Object.freeze([]),
      missing: Object.freeze([]),
      conflicts: Object.freeze([]),
      complete: true,
      providerExecutionAllowed: false,
      reason: "Evidence, child result, and parent budget settlement are all durably present.",
    })
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    intentID: normalizedIntent.intentID,
    deterministic: true,
    next: Object.freeze([...missing]),
    missing: Object.freeze([...missing]),
    conflicts: Object.freeze([]),
    complete: false,
    providerExecutionAllowed: false,
    reason: `Recovery may replay only the missing owner writes: ${missing.join(", ")}.`,
  })
}

/**
 * The commit contract is intentionally plan-only.  It describes how the
 * existing DurableRun and ExperienceStore owners must be joined, but it does
 * not acquire a database handle, write an event, or authorize provider work.
 * Until a real shared transaction is proven, callers must select the durable
 * recovery-outbox mode and replay only the idempotent owner writes returned by
 * `reconcile`.
 */
export type SettlementCommitMode = "same-transaction" | "recovery-outbox"

/**
 * The owners that must be observed inside one production transaction when an
 * admission Evidence receipt is present.  The evidence card below is a
 * structural attestation only; it is never itself an authorization to
 * promote the production gate or to execute a provider.
 */
export type SettlementTransactionOwner = "event-v2" | "experience-store" | "durable-run"

export type SettlementTransactionBinding = Readonly<{
  readonly owner: SettlementTransactionOwner
  readonly operation: "publish-durable-event" | "record-admission-evidence" | "record-child-result-and-parent-budget"
  readonly transactionKey: string
  readonly transactionID: string
  readonly commitBoundary: "shared"
}>

/**
 * A payload-free, replay-safe shape that a future production coordinator must
 * emit after it has actually observed one EventV2 SQL transaction.  Keeping
 * this card separate from the enable gate prevents a caller from mistaking a
 * boolean `atomicDatabaseTransaction` flag or a test double for production
 * evidence.
 */
export type SettlementSharedTransactionEvidence = Readonly<{
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly transactionKey: string
  readonly transactionID: string
  readonly ownerOrder: ReadonlyArray<SettlementWrite>
  readonly bindings: ReadonlyArray<SettlementTransactionBinding>
  readonly atomicCommit: true
  readonly rollbackOnFailure: true
  readonly providerExecutionAllowed: false
  readonly evidenceDigest: string
}>

export interface SettlementCommitCapabilities {
  readonly mode: SettlementCommitMode
  /** True only when all required owners share one atomic database transaction. */
  readonly atomicDatabaseTransaction: boolean
  /** True only when the existing durable settlement intent/outbox can be replayed. */
  readonly durableRecoveryOutbox: boolean
  /**
   * Optional structural attestation for a future cross-owner coordinator.
   * Supplying it does not change the production enable gate; the current
   * runtime has no trusted adapter that can produce this evidence.
   */
  readonly sharedTransactionEvidence?: SettlementSharedTransactionEvidence
}

export type SettlementCommitGateID =
  | "event-v2-shared-transaction"
  | "durable-recovery-outbox"
  | "owner-order-invariant"
  | "provider-execution-fence"

export type SettlementCommitGate = Readonly<{
  readonly id: SettlementCommitGateID
  readonly status: "blocked" | "satisfied"
  readonly evidenceScope: "production" | "isolated-test"
  readonly requirement: string
  readonly blocker: string
}>

/**
 * Machine-readable production decision for the cross-owner settlement path.
 *
 * EventV2, DurableRun and ExperienceStore currently own separate transaction
 * callbacks.  A boolean `atomicDatabaseTransaction` capability is therefore
 * not evidence that one SQL transaction is shared by all three owners.  This
 * card makes the safe choice explicit: use the durable, payload-free recovery
 * outbox until a coordinator can provide and prove a shared EventV2
 * transaction.  It is intentionally pure and cannot authorize a provider or
 * perform an owner write.
 */
export type SettlementCommitEnableGate = Readonly<{
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly mode: SettlementCommitMode
  /** `ready` means promotion to same-transaction mode is safe to enable. */
  readonly ready: boolean
  readonly decision: "keep-recovery-outbox" | "enable-same-transaction" | "blocked"
  readonly gates: ReadonlyArray<SettlementCommitGate>
  readonly blocking_gate_ids: ReadonlyArray<SettlementCommitGateID>
  readonly providerExecutionAllowed: false
  readonly decisionDigest: string
}>

const settlementCommitGateSemantic = (
  gate: Pick<
    SettlementCommitEnableGate,
    "schemaVersion" | "mode" | "ready" | "decision" | "gates" | "blocking_gate_ids" | "providerExecutionAllowed"
  >,
) => ({
  domain: "arforge/child-settlement-enable-gate/v1",
  schemaVersion: gate.schemaVersion,
  mode: gate.mode,
  ready: gate.ready,
  decision: gate.decision,
  gates: gate.gates,
  blocking_gate_ids: [...gate.blocking_gate_ids],
  providerExecutionAllowed: gate.providerExecutionAllowed,
})

/** Return the current authoritative settlement promotion decision. */
export const settlementCommitEnableGate = (): SettlementCommitEnableGate => {
  const gates: ReadonlyArray<SettlementCommitGate> = Object.freeze([
    {
      id: "event-v2-shared-transaction",
      status: "blocked",
      evidenceScope: "production",
      requirement: "Evidence、ChildResult、ParentBudget 必须由同一生产 coordinator 绑定到一个 EventV2 SQL transaction",
      blocker:
        "受控本地 PostgreSQL 已证明 concrete owner adapter 的 backend/txid、主体绑定、提交/回滚，以及 outbox owner promotion 前 Evidence/audit 已提交的跨进程 SIGKILL 重启晋级；正式 DurableRun 长时 production observation 与最终 cutover approval 仍未闭合，继续保持 recovery-outbox",
    },
    {
      id: "durable-recovery-outbox",
      status: "satisfied",
      evidenceScope: "production",
      requirement: "跨 owner 事务失败或进程崩溃时必须落 durable、payload-free、可重放的 settlement outbox",
      blocker: "",
    },
    {
      id: "owner-order-invariant",
      status: "satisfied",
      evidenceScope: "production",
      requirement: "恢复顺序固定为 Evidence → ChildResult → ParentBudget，并由 immutable intent/digest 校验",
      blocker: "",
    },
    {
      id: "provider-execution-fence",
      status: "satisfied",
      evidenceScope: "production",
      requirement: "settlement/recovery 只允许幂等 owner write，永远不能授权 Provider 重试",
      blocker: "",
    },
  ])
  const blocking_gate_ids = Object.freeze(gates.filter((gate) => gate.status !== "satisfied").map((gate) => gate.id))
  const semantic = {
    schemaVersion: SCHEMA_VERSION,
    mode: "recovery-outbox" as const,
    ready: false as const,
    decision: "keep-recovery-outbox" as const,
    gates,
    blocking_gate_ids,
    providerExecutionAllowed: false as const,
  }
  const decisionDigest = canonicalHash(settlementCommitGateSemantic(semantic))
  if (decisionDigest === undefined)
    throw new ChildSettlementError("INVALID_INPUT", "settlement gate is not canonicalizable")
  return Object.freeze({ ...semantic, decisionDigest })
}

/** Validate a persisted/copied settlement decision card before displaying it. */
export const assertSettlementCommitEnableGate = (value: SettlementCommitEnableGate): void => {
  if (value === null || typeof value !== "object" || value.schemaVersion !== SCHEMA_VERSION)
    settlementCommitError("settlement enable gate schema is invalid")
  if (!(value.mode === "same-transaction" || value.mode === "recovery-outbox"))
    settlementCommitError("settlement enable gate mode is invalid")
  if (
    !(
      value.decision === "keep-recovery-outbox" ||
      value.decision === "enable-same-transaction" ||
      value.decision === "blocked"
    )
  )
    settlementCommitError("settlement enable gate decision is invalid")
  if (typeof value.ready !== "boolean" || value.providerExecutionAllowed !== false)
    settlementCommitError("settlement enable gate readiness or provider fence is invalid")
  const expectedIDs: ReadonlyArray<SettlementCommitGateID> = [
    "event-v2-shared-transaction",
    "durable-recovery-outbox",
    "owner-order-invariant",
    "provider-execution-fence",
  ]
  if (
    !Array.isArray(value.gates) ||
    value.gates.length !== expectedIDs.length ||
    value.gates.some(
      (gate, index) =>
        gate === null ||
        typeof gate !== "object" ||
        gate.id !== expectedIDs[index] ||
        !(gate.status === "blocked" || gate.status === "satisfied") ||
        !(gate.evidenceScope === "production" || gate.evidenceScope === "isolated-test") ||
        typeof gate.requirement !== "string" ||
        gate.requirement.trim().length === 0 ||
        typeof gate.blocker !== "string" ||
        (gate.status === "blocked" ? gate.blocker.trim().length === 0 : gate.blocker !== ""),
    )
  )
    settlementCommitError("settlement enable gate entries are invalid")
  const expectedBlocking = value.gates.filter((gate) => gate.status !== "satisfied").map((gate) => gate.id)
  if (JSON.stringify(value.blocking_gate_ids) !== JSON.stringify(expectedBlocking))
    settlementCommitError("settlement enable gate blocking ids drifted")
  if (value.decision === "enable-same-transaction" && expectedBlocking.length > 0)
    settlementCommitError("settlement enable gate cannot enable with blocking gates")
  if (value.decision === "blocked" && expectedBlocking.length === 0)
    settlementCommitError("blocked settlement enable gate has no blocking gates")
  if (
    value.ready !== (value.decision === "enable-same-transaction") ||
    value.mode !== (value.ready ? "same-transaction" : "recovery-outbox")
  )
    settlementCommitError("settlement enable gate decision and mode disagree")
  if (!DIGEST.test(value.decisionDigest)) settlementCommitError("settlement enable gate digest is invalid")
  const expected = canonicalHash(settlementCommitGateSemantic(value))
  if (expected === undefined || expected !== value.decisionDigest)
    settlementCommitError("settlement enable gate digest drifted")
}

export interface SettlementCommitPlan {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly mode: SettlementCommitMode
  readonly intentID: string
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly transactionKey: string
  readonly ownerOrder: ReadonlyArray<SettlementWrite>
  readonly owners: Readonly<{
    readonly evidence: "experience-store" | "not-required"
    readonly childResult: "durable-run"
    readonly parentBudget: "durable-run"
  }>
  readonly expectedDigests: Readonly<{
    readonly evidence?: string
    readonly childResult: string
    readonly parentBudget: string
  }>
  /** Digest of the structural shared-transaction attestation, when present. */
  readonly sharedTransactionEvidenceDigest?: string
  readonly outboxRequired: boolean
  readonly providerExecutionAllowed: false
  readonly commitDigest: string
}

const settlementCommitSemantic = (
  plan: Pick<
    SettlementCommitPlan,
    | "schemaVersion"
    | "mode"
    | "intentID"
    | "parentRunID"
    | "childRunID"
    | "transactionKey"
    | "ownerOrder"
    | "owners"
    | "expectedDigests"
    | "sharedTransactionEvidenceDigest"
    | "outboxRequired"
    | "providerExecutionAllowed"
  >,
) => ({
  domain: "arforge/child-settlement-commit/v1",
  schemaVersion: plan.schemaVersion,
  mode: plan.mode,
  intentID: plan.intentID,
  parentRunID: plan.parentRunID,
  childRunID: plan.childRunID,
  transactionKey: plan.transactionKey,
  ownerOrder: [...plan.ownerOrder],
  owners: plan.owners,
  expectedDigests: plan.expectedDigests,
  ...(plan.sharedTransactionEvidenceDigest === undefined
    ? {}
    : { sharedTransactionEvidenceDigest: plan.sharedTransactionEvidenceDigest }),
  outboxRequired: plan.outboxRequired,
  providerExecutionAllowed: plan.providerExecutionAllowed,
})

const settlementCommitError = (message: string): never => {
  throw new ChildSettlementError("INVALID_INPUT", message)
}

const TRANSACTION_ID = /^tx_[A-Za-z0-9._:-]{1,255}$/
const SHARED_TRANSACTION_OWNERS: ReadonlyArray<SettlementTransactionOwner> = Object.freeze([
  "event-v2",
  "experience-store",
  "durable-run",
])

const SHARED_TRANSACTION_OPERATIONS: ReadonlyArray<SettlementTransactionBinding["operation"]> = Object.freeze([
  "publish-durable-event",
  "record-admission-evidence",
  "record-child-result-and-parent-budget",
])

const sharedTransactionEvidenceSemantic = (value: Omit<SettlementSharedTransactionEvidence, "evidenceDigest">) => ({
  domain: "arforge/child-settlement-shared-transaction/v1",
  schemaVersion: value.schemaVersion,
  transactionKey: value.transactionKey,
  transactionID: value.transactionID,
  ownerOrder: [...value.ownerOrder],
  bindings: value.bindings.map((binding) => ({ ...binding })),
  atomicCommit: value.atomicCommit,
  rollbackOnFailure: value.rollbackOnFailure,
  providerExecutionAllowed: value.providerExecutionAllowed,
})

/** Compute the digest over a payload-free shared-transaction evidence card. */
export const settlementSharedTransactionEvidenceDigest = (
  value: Omit<SettlementSharedTransactionEvidence, "evidenceDigest">,
): string | undefined => canonicalHash(sharedTransactionEvidenceSemantic(value))

const sharedTransactionInputError = (message: string): never => {
  throw new ChildSettlementError("INVALID_INPUT", message)
}

const assertPlainRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return sharedTransactionInputError(`${name} must be a plain object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    return sharedTransactionInputError(`${name} must be a plain object`)
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
    return sharedTransactionInputError(`${name} cannot contain symbol keys`)
  return value as Record<string, unknown>
}

const assertExactKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>, name: string): void => {
  const actual = Reflect.ownKeys(value)
    .filter((key): key is string => typeof key === "string")
    .sort()
  const canonical = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) sharedTransactionInputError(`${name} fields drifted`)
}

/**
 * Create the deterministic shape a trusted coordinator can emit after its
 * database transaction has committed.  This helper only constructs metadata;
 * it does not open a transaction, inspect a database, or change the enable
 * gate.  Production callers must still retain independent commit/rollback
 * evidence before presenting the card to an operator.
 */
export const makeSettlementSharedTransactionEvidence = (input: {
  readonly transactionKey: string
  readonly transactionID: string
  readonly ownerOrder: ReadonlyArray<SettlementWrite>
}): SettlementSharedTransactionEvidence => {
  if (
    typeof input?.transactionKey !== "string" ||
    input.transactionKey.length === 0 ||
    input.transactionKey.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(input.transactionKey)
  )
    return sharedTransactionInputError("shared transaction key is invalid")
  if (typeof input.transactionID !== "string" || !TRANSACTION_ID.test(input.transactionID))
    return sharedTransactionInputError("shared transaction identity is invalid")
  if (JSON.stringify(input.ownerOrder) !== JSON.stringify(["admission-evidence", "child-result", "parent-budget"]))
    return sharedTransactionInputError("shared transaction owner order must include Evidence, result, and budget")
  const bindings = Object.freeze([
    {
      owner: "event-v2" as const,
      operation: "publish-durable-event" as const,
      transactionKey: input.transactionKey,
      transactionID: input.transactionID,
      commitBoundary: "shared" as const,
    },
    {
      owner: "experience-store" as const,
      operation: "record-admission-evidence" as const,
      transactionKey: input.transactionKey,
      transactionID: input.transactionID,
      commitBoundary: "shared" as const,
    },
    {
      owner: "durable-run" as const,
      operation: "record-child-result-and-parent-budget" as const,
      transactionKey: input.transactionKey,
      transactionID: input.transactionID,
      commitBoundary: "shared" as const,
    },
  ]) as ReadonlyArray<SettlementTransactionBinding>
  const semantic = {
    schemaVersion: SCHEMA_VERSION,
    transactionKey: input.transactionKey,
    transactionID: input.transactionID,
    ownerOrder: Object.freeze([...input.ownerOrder]),
    bindings,
    atomicCommit: true as const,
    rollbackOnFailure: true as const,
    providerExecutionAllowed: false as const,
  }
  const evidenceDigest = settlementSharedTransactionEvidenceDigest(semantic)
  if (evidenceDigest === undefined)
    return sharedTransactionInputError("shared transaction evidence is not canonicalizable")
  return Object.freeze({ ...semantic, evidenceDigest })
}

/**
 * Validate shared-transaction evidence against the immutable settlement key.
 * This is intentionally stricter than checking a boolean capability: every
 * owner must name the same transaction key and ID, all required operations
 * must be present exactly once, and the digest must cover the full card.
 */
export const assertSettlementSharedTransactionEvidence = (
  value: SettlementSharedTransactionEvidence,
  expected: Readonly<{
    readonly transactionKey: string
    readonly ownerOrder: ReadonlyArray<SettlementWrite>
  }>,
): void => {
  const card = assertPlainRecord(value, "shared transaction evidence")
  assertExactKeys(
    card,
    [
      "schemaVersion",
      "transactionKey",
      "transactionID",
      "ownerOrder",
      "bindings",
      "atomicCommit",
      "rollbackOnFailure",
      "providerExecutionAllowed",
      "evidenceDigest",
    ],
    "shared transaction evidence",
  )
  if (value.schemaVersion !== SCHEMA_VERSION)
    sharedTransactionInputError("shared transaction evidence schema is invalid")
  if (value.transactionKey !== expected.transactionKey) sharedTransactionInputError("shared transaction key drifted")
  if (typeof value.transactionID !== "string" || !TRANSACTION_ID.test(value.transactionID))
    sharedTransactionInputError("shared transaction identity is invalid")
  if (JSON.stringify(value.ownerOrder) !== JSON.stringify(expected.ownerOrder))
    sharedTransactionInputError("shared transaction owner order drifted")
  if (JSON.stringify(value.ownerOrder) !== JSON.stringify(["admission-evidence", "child-result", "parent-budget"]))
    sharedTransactionInputError("shared transaction owner order is incomplete")
  if (value.atomicCommit !== true || value.rollbackOnFailure !== true || value.providerExecutionAllowed !== false)
    sharedTransactionInputError("shared transaction atomicity or provider fence is invalid")
  if (!Array.isArray(value.bindings) || value.bindings.length !== SHARED_TRANSACTION_OWNERS.length)
    sharedTransactionInputError("shared transaction owner bindings are incomplete")
  value.bindings.forEach((binding, index) => {
    const record = assertPlainRecord(binding, `shared transaction binding ${index}`)
    assertExactKeys(
      record,
      ["owner", "operation", "transactionKey", "transactionID", "commitBoundary"],
      `shared transaction binding ${index}`,
    )
    if (binding.owner !== SHARED_TRANSACTION_OWNERS[index])
      sharedTransactionInputError("shared transaction owner binding order drifted")
    if (binding.operation !== SHARED_TRANSACTION_OPERATIONS[index])
      sharedTransactionInputError("shared transaction operation binding drifted")
    if (binding.transactionKey !== value.transactionKey || binding.transactionID !== value.transactionID)
      sharedTransactionInputError("shared transaction owner does not use the same transaction")
    if (binding.commitBoundary !== "shared")
      sharedTransactionInputError("shared transaction commit boundary is invalid")
  })
  if (new Set(value.bindings.map((binding) => binding.owner)).size !== SHARED_TRANSACTION_OWNERS.length)
    sharedTransactionInputError("shared transaction owners must be unique")
  if (typeof value.evidenceDigest !== "string" || !DIGEST.test(value.evidenceDigest))
    sharedTransactionInputError("shared transaction evidence digest is invalid")
  const { evidenceDigest: _ignored, ...semantic } = value
  const expectedDigest = settlementSharedTransactionEvidenceDigest(semantic)
  if (expectedDigest === undefined || expectedDigest !== value.evidenceDigest)
    sharedTransactionInputError("shared transaction evidence digest drifted")
}

/**
 * Build a deterministic, payload-free commit plan for the three existing
 * settlement owners.  The default production-safe choice is
 * `recovery-outbox`: it gives the caller an auditable order without claiming
 * that ExperienceStore and DurableRun already share one SQL transaction.
 */
export const planSettlementCommit = (
  input: SettlementIntent,
  capabilities: SettlementCommitCapabilities,
): SettlementCommitPlan => {
  const intent = validateIntent(input)
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities))
    return settlementCommitError("settlement commit capabilities are required")
  if (!(capabilities.mode === "same-transaction" || capabilities.mode === "recovery-outbox"))
    return settlementCommitError("settlement commit mode is invalid")
  if (typeof capabilities.atomicDatabaseTransaction !== "boolean")
    return settlementCommitError("atomic database transaction capability is invalid")
  if (typeof capabilities.durableRecoveryOutbox !== "boolean")
    return settlementCommitError("durable recovery outbox capability is invalid")
  if (capabilities.mode === "same-transaction" && !capabilities.atomicDatabaseTransaction)
    return settlementCommitError("same-transaction mode requires one atomic database transaction")
  if (capabilities.mode === "recovery-outbox" && !capabilities.durableRecoveryOutbox)
    return settlementCommitError("recovery-outbox mode requires a durable recovery outbox")

  const ownerOrder: ReadonlyArray<SettlementWrite> = intent.admissionEvidence
    ? Object.freeze(["admission-evidence", "child-result", "parent-budget"])
    : Object.freeze(["child-result", "parent-budget"])
  const transactionKey = `settlement:${intent.intentID}`
  if (capabilities.mode === "same-transaction" && intent.admissionEvidence !== undefined) {
    if (capabilities.sharedTransactionEvidence === undefined)
      return settlementCommitError(
        "cross-owner settlement requires an explicit shared EventV2 transaction; use recovery-outbox until implemented",
      )
    try {
      assertSettlementSharedTransactionEvidence(capabilities.sharedTransactionEvidence, {
        transactionKey,
        ownerOrder,
      })
    } catch (cause) {
      return settlementCommitError(`shared EventV2 transaction evidence is invalid: ${String(cause)}`)
    }
  } else if (capabilities.sharedTransactionEvidence !== undefined) {
    return settlementCommitError(
      "shared EventV2 transaction evidence is only valid for an Evidence-bearing same-transaction plan",
    )
  }
  const expectedDigests = Object.freeze({
    ...(intent.admissionEvidence === undefined ? {} : { evidence: intent.admissionEvidence.recordDigest }),
    childResult: intent.resultDigest,
    parentBudget: canonicalHash(intent.usage) ?? settlementCommitError("settlement usage is not canonicalizable"),
  })
  const owners = Object.freeze({
    evidence: intent.admissionEvidence === undefined ? ("not-required" as const) : ("experience-store" as const),
    childResult: "durable-run" as const,
    parentBudget: "durable-run" as const,
  })
  const semantic = {
    schemaVersion: SCHEMA_VERSION,
    mode: capabilities.mode,
    intentID: intent.intentID,
    parentRunID: intent.parentRunID,
    childRunID: intent.childRunID,
    transactionKey,
    ownerOrder,
    owners,
    expectedDigests,
    ...(capabilities.sharedTransactionEvidence === undefined
      ? {}
      : { sharedTransactionEvidenceDigest: capabilities.sharedTransactionEvidence.evidenceDigest }),
    outboxRequired: capabilities.mode === "recovery-outbox",
    providerExecutionAllowed: false as const,
  } as const
  const commitDigest = canonicalHash(settlementCommitSemantic(semantic))
  if (!commitDigest) return settlementCommitError("settlement commit plan is not canonicalizable")
  return Object.freeze({ ...semantic, commitDigest })
}

/** Validate a persisted/replayed plan before it can drive any owner write. */
export const assertSettlementCommitPlan = (value: SettlementCommitPlan): void => {
  if (value === null || typeof value !== "object" || value.schemaVersion !== SCHEMA_VERSION)
    settlementCommitError("settlement commit plan schema is invalid")
  if (!(value.mode === "same-transaction" || value.mode === "recovery-outbox"))
    settlementCommitError("settlement commit plan mode is invalid")
  if (!INTENT_ID.test(value.intentID)) settlementCommitError("settlement commit plan intent identity is invalid")
  if (!RUN_ID.test(String(value.parentRunID)) || !RUN_ID.test(String(value.childRunID)))
    settlementCommitError("settlement commit plan run identity is invalid")
  if (value.transactionKey !== `settlement:${value.intentID}`)
    settlementCommitError("settlement commit plan transaction key drifted")
  const hasEvidence = value.owners?.evidence === "experience-store"
  const expectedOrder = hasEvidence
    ? ["admission-evidence", "child-result", "parent-budget"]
    : ["child-result", "parent-budget"]
  if (JSON.stringify(value.ownerOrder) !== JSON.stringify(expectedOrder))
    settlementCommitError("settlement commit plan owner order drifted")
  if (
    value.owners === null ||
    typeof value.owners !== "object" ||
    value.owners.childResult !== "durable-run" ||
    value.owners.parentBudget !== "durable-run" ||
    (hasEvidence ? value.owners.evidence !== "experience-store" : value.owners.evidence !== "not-required")
  )
    settlementCommitError("settlement commit plan owner binding is invalid")
  if (value.expectedDigests === null || typeof value.expectedDigests !== "object")
    settlementCommitError("settlement commit plan digest projection is invalid")
  if (!DIGEST.test(value.expectedDigests.childResult) || !DIGEST.test(value.expectedDigests.parentBudget))
    settlementCommitError("settlement commit plan durable digest is invalid")
  if (hasEvidence) {
    if (typeof value.expectedDigests.evidence !== "string" || !DIGEST.test(value.expectedDigests.evidence))
      settlementCommitError("settlement commit plan Evidence digest is invalid")
  } else if (value.expectedDigests.evidence !== undefined) {
    settlementCommitError("settlement commit plan carries an unexpected Evidence digest")
  }
  if (value.mode === "same-transaction" && hasEvidence) {
    if (
      typeof value.sharedTransactionEvidenceDigest !== "string" ||
      !DIGEST.test(value.sharedTransactionEvidenceDigest)
    )
      settlementCommitError("same-transaction Evidence plan requires shared transaction evidence")
  } else if (value.sharedTransactionEvidenceDigest !== undefined) {
    settlementCommitError("settlement commit plan carries unexpected shared transaction evidence")
  }
  if (value.outboxRequired !== (value.mode === "recovery-outbox"))
    settlementCommitError("settlement commit plan outbox mode drifted")
  if (value.providerExecutionAllowed !== false)
    settlementCommitError("settlement commit plan cannot authorize provider execution")
  if (!DIGEST.test(value.commitDigest)) settlementCommitError("settlement commit plan digest is invalid")
  const expected = canonicalHash(settlementCommitSemantic(value))
  if (expected === undefined || expected !== value.commitDigest)
    settlementCommitError("settlement commit plan digest drifted")
}
