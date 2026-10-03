import { Schema } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { TrustedExperienceIdentity } from "../experience-store"
import { childRunIDFor } from "./child-contract"
import { canonicalHash } from "../util/canonical-hash"

/** The existing durable owner that will eventually commit the record. */
export const WRITER_OWNER = "experience-store" as const

/** The only transaction boundary allowed for a successful child admission. */
export const SETTLEMENT_BOUNDARY = "child-result-and-budget-settlement" as const

export const SCHEMA_VERSION = 1 as const

export type AdmissionEvidenceIdentity = TrustedExperienceIdentity

/**
 * Inputs for the future admission-evidence writer.  This is deliberately a
 * planning contract: it does not receive a database handle and cannot write
 * an Evidence row by itself. The eventual writer must invoke it inside the
 * single owner boundary that atomically (or through an auditable recovery
 * outbox) commits the Evidence record together with child result and parent
 * budget settlement.
 */
export interface PlanInput {
  readonly identity: AdmissionEvidenceIdentity
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly idempotencyKey: string
  readonly admission: AgentRuntime.CustomAgentAdmissionEvidence
  /** Existing supporting EvidenceIDs; no payload crosses this boundary. */
  readonly evidenceRefs: ReadonlyArray<AgentRuntime.EvidenceID>
}

/**
 * Metadata-only write intent.  No profile path, prompt, credentials, raw
 * Evidence record, or provider payload is returned.  The deterministic IDs
 * are namespaced by the trusted owner and immutable child identity so a retry
 * can either replay the exact write or be rejected as a conflict.
 */
export interface Plan {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly writerOwner: typeof WRITER_OWNER
  readonly settlementBoundary: typeof SETTLEMENT_BOUNDARY
  readonly identity: Readonly<{
    readonly tenantID: string
    readonly userID: string
    readonly actor: string
  }>
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly idempotencyDigest: string
  readonly admissionDigest: string
  readonly evidenceID: AgentRuntime.EvidenceID
  readonly evidenceRefs: ReadonlyArray<AgentRuntime.EvidenceID>
}

/**
 * The minimum durable observation snapshot required to materialize the
 * admission record.  The writer obtains the full Action snapshot from the
 * existing DurableAction owner; this function intentionally receives no
 * provider payload, profile path, prompt, or credentials.
 */
export interface MaterializeInput {
  readonly plan: Plan
  readonly actionID: AgentRuntime.ActionID
  readonly observation: AgentRuntime.Observation
}

/** Metadata returned after a deterministic admission Evidence payload is
 * materialized.  Persistence is still performed by ExperienceStore. */
export interface Materialized {
  readonly evidence: AgentRuntime.Evidence
  readonly recordDigest: string
  readonly observationID: AgentRuntime.ObservationID
}

export class AdmissionEvidenceBoundaryError extends Error {
  readonly _tag = "Runtime.AdmissionEvidenceBoundaryError"

  constructor(readonly reason: string) {
    super(reason)
    this.name = this._tag
  }
}

const digestPattern = /^[a-f0-9]{64}$/i
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const runPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/
const evidencePattern = /^evd_[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

const reject = (reason: string): never => {
  throw new AdmissionEvidenceBoundaryError(reason)
}

const validText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    return reject(`${label} must contain 1-${maximum} characters`)
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value))
    return reject(`${label} contains unsupported whitespace or control characters`)
  return value
}

const normalizeIdentity = (identity: AdmissionEvidenceIdentity): AdmissionEvidenceIdentity => {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity))
    return reject("trusted admission identity is invalid")
  const tenantID = validText(identity.tenantID, "tenantID", 256)
  const userID = validText(identity.userID, "userID", 256)
  const actor = validText(identity.actor, "actor", 256)
  if (!identityPattern.test(tenantID) || !identityPattern.test(userID))
    return reject("trusted admission identity IDs are invalid")
  if (actor === "user:product") return reject("placeholder actors are forbidden")
  return Object.freeze({ tenantID, userID, actor })
}

const normalizeRunID = (value: AgentRuntime.RunID, label: string): AgentRuntime.RunID => {
  const text = validText(value, label, 512)
  if (!runPattern.test(text)) return reject(`${label} is invalid`)
  return text as AgentRuntime.RunID
}

const normalizeEvidenceRefs = (
  values: ReadonlyArray<AgentRuntime.EvidenceID>,
): ReadonlyArray<AgentRuntime.EvidenceID> => {
  if (!Array.isArray(values) || values.length > 32) return reject("admission evidence references must contain 0-32 IDs")
  const result: AgentRuntime.EvidenceID[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const text = validText(value, "evidenceID", 256)
    if (!evidencePattern.test(text)) return reject("admission evidence reference ID is invalid")
    if (seen.has(text)) return reject("admission evidence references must be unique")
    seen.add(text)
    result.push(text as AgentRuntime.EvidenceID)
  }
  return Object.freeze(result)
}

const normalizeAdmission = (value: AgentRuntime.CustomAgentAdmissionEvidence) => {
  let admission: AgentRuntime.CustomAgentAdmissionEvidence
  try {
    admission = Schema.decodeUnknownSync(AgentRuntime.CustomAgentAdmissionEvidence, {
      onExcessProperty: "error",
      errors: "all",
      propertyOrder: "original",
    })(value)
  } catch {
    return reject("admission evidence failed strict schema validation")
  }
  if (
    admission.kind !== "custom-agent-admission" ||
    admission.status !== "admitted" ||
    admission.decision !== "admitted" ||
    !admission.ready ||
    !admission.valid ||
    admission.violations.length > 0 ||
    !admission.checks.status_consistent ||
    !admission.checks.descriptor_digest_consistent ||
    !admission.checks.tool_projection_consistent ||
    !admission.checks.payload_free
  )
    return reject("only a valid admitted payload-free receipt may be planned for writing")
  if (!admission.role.startsWith("CustomAgent.")) return reject("admission role is not a custom-agent role")
  if (!admission.descriptor_digest || !digestPattern.test(admission.descriptor_digest))
    return reject("admission descriptor digest is invalid")
  return admission
}

const normalizeObservation = (value: AgentRuntime.Observation): AgentRuntime.Observation => {
  try {
    // Durable snapshots carry Effect DateTime instances while the wire
    // schema decodes epoch milliseconds. Round-trip through the canonical
    // encoder before strict decoding so the boundary checks both forms.
    const encoded = Schema.encodeUnknownSync(AgentRuntime.Observation)(value)
    return Schema.decodeUnknownSync(AgentRuntime.Observation, {
      onExcessProperty: "error",
      errors: "all",
      propertyOrder: "original",
    })(encoded)
  } catch {
    return reject("admission observation failed strict schema validation")
  }
}

const normalizePlanShape = (value: Plan): Plan => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return reject("admission Evidence plan is invalid")
  if (value.schemaVersion !== SCHEMA_VERSION) return reject("admission Evidence plan schema version is unsupported")
  if (value.writerOwner !== WRITER_OWNER) return reject("admission Evidence plan writer owner is invalid")
  if (value.settlementBoundary !== SETTLEMENT_BOUNDARY)
    return reject("admission Evidence plan settlement boundary is invalid")
  const identity = normalizeIdentity(value.identity)
  const parentRunID = normalizeRunID(value.parentRunID, "parentRunID")
  const childRunID = normalizeRunID(value.childRunID, "childRunID")
  const idempotencyDigest = validText(value.idempotencyDigest, "idempotencyDigest", 64)
  const admissionDigest = validText(value.admissionDigest, "admissionDigest", 64)
  if (!digestPattern.test(idempotencyDigest) || !digestPattern.test(admissionDigest))
    return reject("admission Evidence plan digest is invalid")
  const evidenceID = validText(value.evidenceID, "evidenceID", 256)
  const expectedEvidenceID = `evd_admission_${admissionDigest}`
  if (evidenceID !== expectedEvidenceID) return reject("admission Evidence plan ID does not match its digest")
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs)
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    writerOwner: WRITER_OWNER,
    settlementBoundary: SETTLEMENT_BOUNDARY,
    identity,
    parentRunID,
    childRunID,
    idempotencyDigest,
    admissionDigest,
    evidenceID: AgentRuntime.EvidenceID.make(evidenceID),
    evidenceRefs,
  })
}

/**
 * Build the deterministic, metadata-only write intent.  Calling this function
 * repeatedly with the same trusted identity and immutable child contract
 * returns the same evidence ID and digests; changing any of those facts
 * produces a different intent and must be treated as an idempotency conflict.
 */
export const plan = (input: PlanInput): Plan => {
  const identity = normalizeIdentity(input.identity)
  const parentRunID = normalizeRunID(input.parentRunID, "parentRunID")
  const childRunID = normalizeRunID(input.childRunID, "childRunID")
  const idempotencyKey = validText(input.idempotencyKey, "idempotencyKey", 256)
  const admission = normalizeAdmission(input.admission)
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs)
  const expectedChildRunID = childRunIDFor(parentRunID, idempotencyKey)
  if (!expectedChildRunID || expectedChildRunID !== childRunID)
    return reject("childRunID does not match the parent/idempotency identity")

  const idempotencyDigest = canonicalHash({
    domain: "arforge/admission-evidence-idempotency/v1",
    tenantID: identity.tenantID,
    userID: identity.userID,
    parentRunID,
    childRunID,
    idempotencyKey,
  })
  const admissionDigest = canonicalHash({
    domain: "arforge/admission-evidence-record/v1",
    schemaVersion: SCHEMA_VERSION,
    identity,
    parentRunID,
    childRunID,
    idempotencyDigest,
    admission,
    evidenceRefs: [...evidenceRefs],
  })
  if (!idempotencyDigest || !admissionDigest) return reject("admission evidence identity is not canonically hashable")

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    writerOwner: WRITER_OWNER,
    settlementBoundary: SETTLEMENT_BOUNDARY,
    identity,
    parentRunID,
    childRunID,
    idempotencyDigest,
    admissionDigest,
    evidenceID: AgentRuntime.EvidenceID.make(`evd_admission_${admissionDigest}`),
    evidenceRefs,
  })
}

/**
 * Materialize the one runtime admission Evidence record that the existing
 * ExperienceStore can persist.  This is deliberately separate from
 * `plan()`: an admission receipt may only become durable after a real,
 * successful Action Observation is available.  The resulting record is
 * payload-free and cannot be used as a retry or provider execution token.
 */
export const materialize = (input: MaterializeInput): Materialized => {
  const plan = normalizePlanShape(input.plan)
  const observation = normalizeObservation(input.observation)
  const actionID = validText(input.actionID, "actionID", 256)
  if (!/^act_[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(actionID)) return reject("actionID is invalid")
  if (observation.actionID !== actionID)
    return reject("admission observation does not belong to the supplied Action")
  if (observation.status !== "succeeded")
    return reject("only a successful Action Observation may materialize admission Evidence")

  const evidence = AgentRuntime.Evidence.make({
    id: plan.evidenceID,
    source: "runtime:custom-agent-admission",
    sourceDigest: plan.admissionDigest,
    trust: "trusted",
    instructionAllowed: false,
    summary: "Custom agent admission receipt accepted",
    capturedAt: observation.observedAt,
    contentDigest: plan.admissionDigest,
    extractionMethod: "runtime-admission",
    extractionVersion: "1",
    observationIDs: [observation.id],
    runID: plan.childRunID,
    actionID: actionID as AgentRuntime.ActionID,
    sensitivity: "internal",
    validAt: observation.observedAt,
    verificationStatus: "verified",
  })
  const encoded = Schema.encodeUnknownSync(AgentRuntime.Evidence)(evidence)
  const recordDigest = canonicalHash(encoded)
  if (!recordDigest || !digestPattern.test(recordDigest)) return reject("admission Evidence is not canonically hashable")
  return Object.freeze({
    evidence,
    recordDigest,
    observationID: observation.id,
  })
}
