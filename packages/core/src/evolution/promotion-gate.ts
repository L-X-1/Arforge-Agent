export * as EvolutionPromotionGateV1 from "./promotion-gate"

import { POLICY_VERSION as ACTION_GATEWAY_POLICY_VERSION } from "../action-gateway"
import { canonicalHash } from "../util/canonical-hash"
import type { EvolutionPolicy } from "./runtime"

export const PROMOTION_POLICY_VERSION = "arforge-evolution-promotion/1"

const DIGEST = /^[0-9a-f]{64}$/
const EXPERIENCE_ID = /^exp_[A-Za-z0-9_-]+$/
const EVIDENCE_ID = /^evd_[A-Za-z0-9_-]+$/
const EVALUATION_ID = /^eva_[A-Za-z0-9_-]+$/

export interface PromotionPolicySnapshot {
  readonly version: typeof PROMOTION_POLICY_VERSION
  readonly action_gateway_policy_version: string
  readonly digest: string
}

export interface CanaryObservationInput {
  readonly id: string
  readonly candidateDigest: string
  readonly cohort: "candidate" | "control"
  readonly success: boolean
  readonly score: number
  readonly safetyIncident: boolean
  readonly evidenceRef: string
  readonly recordHash: string
}

export interface PromotionEvaluationCase {
  readonly case_id: string
  readonly category: string
  readonly passed: boolean
  readonly score: number
  readonly baseline_score: number
  readonly detail: string
  readonly required: boolean
}

export interface PromotionBudgetReport {
  readonly max_attempts: number
  readonly attempts_used: number
  readonly max_duration_ms: number
  readonly duration_ms_used: number
  readonly max_cost_micros: number
  readonly cost_micros_used: number
  readonly passed: boolean
}

export interface PromotionEvaluationReport {
  readonly schema_version: 1
  readonly candidate_id: string
  readonly candidate_digest: string
  readonly created_at: string
  readonly isolation: "temporary_directory"
  readonly workspace_retained: false
  readonly gate_passed: boolean
  readonly budget: PromotionBudgetReport
  readonly cases: ReadonlyArray<PromotionEvaluationCase>
  readonly evaluation_id: string
  readonly report_digest: string
}

export interface CanaryGateReport {
  readonly schema_version: 1
  readonly candidate_id: string
  readonly candidate_digest: string
  readonly candidate_observations: number
  readonly control_observations: number
  readonly candidate_success_rate: number
  readonly control_success_rate: number
  readonly success_rate_delta: number
  readonly safety_incidents: number
  readonly control_safety_incidents: number
  readonly observation_ids: ReadonlyArray<string>
  readonly observation_digest: string
  readonly policy_version: string
  readonly policy_digest: string
  readonly checks: Readonly<Record<string, boolean>>
  readonly gate_passed: boolean
}

export interface PromotionGateFacts {
  readonly actor: string
  readonly candidateID: string
  readonly candidateDigest: string
  readonly artifactVerified: boolean
  readonly sourceProvenanceVerified: boolean
  readonly manifest: Readonly<Record<string, unknown>>
  readonly evaluation: Readonly<Record<string, unknown>>
  readonly evaluationReport: PromotionEvaluationReport
  readonly evaluationStorageVerified: boolean
  readonly approval: Readonly<Record<string, unknown>>
  readonly canaryReport: CanaryGateReport
  readonly rollbackArtifactVerified: boolean
  readonly policy: EvolutionPolicy
}

export interface PromotionGateChecks {
  readonly immutable_artifact_digest: boolean
  readonly source_experience_evidence: boolean
  readonly baseline_candidate_evaluation: boolean
  readonly safety_pass: boolean
  readonly permission_pass: boolean
  readonly secret_pass: boolean
  readonly egress_pass: boolean
  readonly budget_pass: boolean
  readonly human_actor_approval: boolean
  readonly canary_cohort_observations: boolean
  readonly no_unacceptable_regression: boolean
  readonly rollback_artifact_plan: boolean
  readonly current_policy_version: boolean
}

export interface PromotionGateReceipt {
  readonly schema_version: 1
  readonly candidate_id: string
  readonly candidate_digest: string
  readonly source_experience_ids: ReadonlyArray<string>
  readonly source_evidence_ids: ReadonlyArray<string>
  readonly source_evaluation_ids: ReadonlyArray<string>
  readonly source_provenance_digest: string
  readonly evaluation: {
    readonly id: string
    readonly baseline_digest: string
    readonly candidate_digest: string
    readonly report_digest: string
  }
  readonly approval_actor: string
  readonly canary: {
    readonly candidate_observations: number
    readonly control_observations: number
    readonly observation_ids: ReadonlyArray<string>
    readonly observation_digest: string
  }
  readonly rollback_artifact: {
    readonly artifact_id: string
    readonly digest: string
    readonly plan_digest: string
  }
  readonly policy: PromotionPolicySnapshot
  readonly checks: PromotionGateChecks
  readonly gate_passed: boolean
  readonly gate_digest: string
}

export class PromotionGateError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "PromotionGateError"
  }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const isHumanActor = (actor: unknown): actor is string =>
  typeof actor === "string" && (actor.startsWith("user:") || actor.startsWith("admin:"))

const policyCore = (policy: EvolutionPolicy) => ({
  version: PROMOTION_POLICY_VERSION,
  action_gateway_policy_version: ACTION_GATEWAY_POLICY_VERSION,
  thresholds: {
    min_canary_observations: policy.min_canary_observations,
    min_control_observations: policy.min_control_observations,
    min_canary_success_rate: policy.min_canary_success_rate,
    min_success_rate_delta: policy.min_success_rate_delta,
    auto_rollback_min_observations: policy.auto_rollback_min_observations,
    auto_rollback_success_rate: policy.auto_rollback_success_rate,
  },
})

export const promotionPolicySnapshot = (policy: EvolutionPolicy): PromotionPolicySnapshot => {
  const digest = canonicalHash(policyCore(policy))
  if (!digest) throw new PromotionGateError("promotion policy is not canonicalizable")
  return Object.freeze({
    version: PROMOTION_POLICY_VERSION,
    action_gateway_policy_version: ACTION_GATEWAY_POLICY_VERSION,
    digest,
  })
}

const round = (value: number) => Math.round(value * 10_000) / 10_000

export const canaryReportFor = (input: {
  readonly candidateID: string
  readonly candidateDigest: string
  readonly observations: ReadonlyArray<CanaryObservationInput>
  readonly policy: EvolutionPolicy
}): CanaryGateReport => {
  if (!input.candidateID.trim() || !DIGEST.test(input.candidateDigest))
    throw new PromotionGateError("canary report candidate binding is invalid")
  const observations = [...input.observations].sort((left, right) => left.id.localeCompare(right.id))
  if (
    observations.some(
      (item) =>
        !item.id.trim() ||
        item.candidateDigest !== input.candidateDigest ||
        !DIGEST.test(item.recordHash) ||
        !finite(item.score) ||
        !item.evidenceRef.trim(),
    )
  )
    throw new PromotionGateError("canary observation binding is invalid")
  const candidateRows = observations.filter((item) => item.cohort === "candidate")
  const controlRows = observations.filter((item) => item.cohort === "control")
  const candidateRate = candidateRows.length
    ? candidateRows.filter((item) => item.success).length / candidateRows.length
    : 0
  const controlRate = controlRows.length ? controlRows.filter((item) => item.success).length / controlRows.length : 0
  const delta = candidateRate - controlRate
  const safetyIncidents = candidateRows.filter((item) => item.safetyIncident).length
  const controlSafetyIncidents = controlRows.filter((item) => item.safetyIncident).length
  const checks = Object.freeze({
    minimum_canary_observations: candidateRows.length >= input.policy.min_canary_observations,
    minimum_control_observations: controlRows.length >= input.policy.min_control_observations,
    minimum_canary_success_rate: candidateRate >= input.policy.min_canary_success_rate,
    minimum_success_rate_delta: delta >= input.policy.min_success_rate_delta,
    no_safety_incidents: safetyIncidents === 0,
  })
  const observationCore = observations.map((item) => ({
    id: item.id,
    candidate_digest: item.candidateDigest,
    cohort: item.cohort,
    success: item.success,
    score: item.score,
    safety_incident: item.safetyIncident,
    evidence_ref: item.evidenceRef,
    record_hash: item.recordHash,
  }))
  const observationDigest = canonicalHash({
    candidate_id: input.candidateID,
    candidate_digest: input.candidateDigest,
    observations: observationCore,
  })
  if (!observationDigest) throw new PromotionGateError("canary observations are not canonicalizable")
  const policy = promotionPolicySnapshot(input.policy)
  return Object.freeze({
    schema_version: 1,
    candidate_id: input.candidateID,
    candidate_digest: input.candidateDigest,
    candidate_observations: candidateRows.length,
    control_observations: controlRows.length,
    candidate_success_rate: round(candidateRate),
    control_success_rate: round(controlRate),
    success_rate_delta: round(delta),
    safety_incidents: safetyIncidents,
    control_safety_incidents: controlSafetyIncidents,
    observation_ids: Object.freeze(observations.map((item) => item.id)),
    observation_digest: observationDigest,
    policy_version: policy.version,
    policy_digest: policy.digest,
    checks,
    gate_passed: Object.values(checks).every(Boolean),
  })
}

const casePassed = (report: PromotionEvaluationReport, caseID: string) =>
  report.cases.some((item) => item.case_id === caseID && item.required && item.passed)

const reportDigestIsValid = (report: PromotionEvaluationReport) => {
  const { evaluation_id: _evaluationID, report_digest: reportDigest, ...core } = report
  return DIGEST.test(reportDigest) && canonicalHash(core) === reportDigest
}

const budgetPassed = (budget: PromotionBudgetReport) =>
  budget.passed &&
  [
    budget.max_attempts,
    budget.attempts_used,
    budget.max_duration_ms,
    budget.duration_ms_used,
    budget.max_cost_micros,
    budget.cost_micros_used,
  ].every((value) => finite(value) && value >= 0) &&
  budget.attempts_used <= budget.max_attempts &&
  budget.duration_ms_used <= budget.max_duration_ms &&
  budget.cost_micros_used <= budget.max_cost_micros

export const parsePromotionEvaluationReport = (value: unknown): PromotionEvaluationReport => {
  const input = record(value)
  const budget = record(input.budget)
  const rawCases = Array.isArray(input.cases) ? input.cases : []
  const cases = rawCases.map((item) => record(item))
  const validCases = cases.every(
    (item) =>
      typeof item.case_id === "string" &&
      typeof item.category === "string" &&
      typeof item.passed === "boolean" &&
      finite(item.score) &&
      finite(item.baseline_score) &&
      typeof item.detail === "string" &&
      typeof item.required === "boolean",
  )
  const budgetValues = [
    budget.max_attempts,
    budget.attempts_used,
    budget.max_duration_ms,
    budget.duration_ms_used,
    budget.max_cost_micros,
    budget.cost_micros_used,
  ]
  if (
    input.schema_version !== 1 ||
    typeof input.candidate_id !== "string" ||
    typeof input.candidate_digest !== "string" ||
    typeof input.created_at !== "string" ||
    input.isolation !== "temporary_directory" ||
    input.workspace_retained !== false ||
    typeof input.gate_passed !== "boolean" ||
    typeof input.evaluation_id !== "string" ||
    typeof input.report_digest !== "string" ||
    rawCases.length === 0 ||
    !validCases ||
    budgetValues.some((item) => !finite(item) || item < 0) ||
    typeof budget.passed !== "boolean"
  )
    throw new PromotionGateError("stored promotion evaluation report is invalid")
  const report: PromotionEvaluationReport = {
    schema_version: 1,
    candidate_id: input.candidate_id,
    candidate_digest: input.candidate_digest,
    created_at: input.created_at,
    isolation: "temporary_directory",
    workspace_retained: false,
    gate_passed: input.gate_passed,
    budget: {
      max_attempts: Number(budget.max_attempts),
      attempts_used: Number(budget.attempts_used),
      max_duration_ms: Number(budget.max_duration_ms),
      duration_ms_used: Number(budget.duration_ms_used),
      max_cost_micros: Number(budget.max_cost_micros),
      cost_micros_used: Number(budget.cost_micros_used),
      passed: budget.passed,
    },
    cases: cases.map((item) => ({
      case_id: String(item.case_id),
      category: String(item.category),
      passed: Boolean(item.passed),
      score: Number(item.score),
      baseline_score: Number(item.baseline_score),
      detail: String(item.detail),
      required: Boolean(item.required),
    })),
    evaluation_id: input.evaluation_id,
    report_digest: input.report_digest,
  }
  if (!reportDigestIsValid(report)) throw new PromotionGateError("stored promotion evaluation digest is invalid")
  return report
}

const build = (facts: PromotionGateFacts): PromotionGateReceipt => {
  const sourceExperienceIDs = strings(facts.manifest.source_experience_ids)
  const sourceEvidenceIDs = strings(facts.manifest.source_evidence_ids)
  const sourceEvaluationIDs = strings(facts.manifest.source_evaluation_ids)
  const evaluationEvidenceIDs = strings(facts.evaluation.evidenceIDs)
  const capabilityBoundary = record(facts.manifest.capability_boundary)
  const rollback = record(facts.manifest.rollback_artifact)
  const policy = promotionPolicySnapshot(facts.policy)
  const evaluationID = typeof facts.evaluation.id === "string" ? facts.evaluation.id : ""
  const baselineDigest = typeof facts.evaluation.baseline === "string" ? facts.evaluation.baseline : ""
  const evaluationCandidate = typeof facts.evaluation.candidate === "string" ? facts.evaluation.candidate : ""
  const approvalActor = typeof facts.approval.actor === "string" ? facts.approval.actor : ""
  const rollbackArtifactID = typeof rollback.artifact_id === "string" ? rollback.artifact_id : ""
  const rollbackArtifactDigest = typeof rollback.digest === "string" ? rollback.digest : ""
  const rollbackPlanDigest = typeof rollback.plan_digest === "string" ? rollback.plan_digest : ""
  const sourceProvenanceDigest =
    typeof facts.manifest.source_provenance_digest === "string" ? facts.manifest.source_provenance_digest : ""
  const requiredCasesPass =
    facts.evaluationReport.cases.length > 0 &&
    facts.evaluationReport.cases.filter((item) => item.required).every((item) => item.passed)
  const checks: PromotionGateChecks = Object.freeze({
    immutable_artifact_digest:
      facts.artifactVerified &&
      DIGEST.test(facts.candidateDigest) &&
      facts.manifest.artifact_digest === facts.candidateDigest,
    source_experience_evidence:
      facts.sourceProvenanceVerified &&
      DIGEST.test(sourceProvenanceDigest) &&
      sourceExperienceIDs.length > 0 &&
      sourceExperienceIDs.every((id) => EXPERIENCE_ID.test(id)) &&
      sourceEvidenceIDs.length > 0 &&
      sourceEvidenceIDs.every((id) => EVIDENCE_ID.test(id)) &&
      sourceEvaluationIDs.length > 0 &&
      sourceEvaluationIDs.every((id) => EVALUATION_ID.test(id)) &&
      sourceEvidenceIDs.every((id) => evaluationEvidenceIDs.includes(id)),
    baseline_candidate_evaluation:
      facts.evaluationStorageVerified &&
      DIGEST.test(baselineDigest) &&
      evaluationCandidate === facts.candidateDigest &&
      evaluationID === facts.evaluationReport.evaluation_id &&
      facts.evaluationReport.candidate_id === facts.candidateID &&
      facts.evaluationReport.candidate_digest === facts.candidateDigest &&
      facts.evaluation.sampleSize === facts.evaluationReport.cases.length &&
      facts.evaluation.passed === true &&
      facts.evaluationReport.gate_passed &&
      requiredCasesPass &&
      reportDigestIsValid(facts.evaluationReport),
    safety_pass:
      casePassed(facts.evaluationReport, "constitution-boundary") &&
      casePassed(facts.evaluationReport, "evolution-level-boundary") &&
      casePassed(facts.evaluationReport, "context-trust-boundary"),
    permission_pass:
      strings(capabilityBoundary.permission_requests).length === 0 &&
      casePassed(facts.evaluationReport, "permission-boundary"),
    secret_pass:
      strings(capabilityBoundary.secret_refs).length === 0 && casePassed(facts.evaluationReport, "secret-boundary"),
    egress_pass:
      strings(capabilityBoundary.network_egress).length === 0 && casePassed(facts.evaluationReport, "egress-boundary"),
    budget_pass: budgetPassed(facts.evaluationReport.budget) && casePassed(facts.evaluationReport, "budget-boundary"),
    human_actor_approval:
      isHumanActor(facts.actor) &&
      isHumanActor(approvalActor) &&
      facts.approval.candidate_digest === facts.candidateDigest &&
      facts.approval.evaluation_id === evaluationID &&
      facts.approval.report_digest === facts.evaluationReport.report_digest &&
      facts.approval.policy_version === ACTION_GATEWAY_POLICY_VERSION,
    canary_cohort_observations:
      facts.canaryReport.candidate_id === facts.candidateID &&
      facts.canaryReport.candidate_digest === facts.candidateDigest &&
      facts.canaryReport.candidate_observations >= facts.policy.min_canary_observations &&
      facts.canaryReport.control_observations >= facts.policy.min_control_observations &&
      facts.canaryReport.observation_ids.length ===
        facts.canaryReport.candidate_observations + facts.canaryReport.control_observations &&
      DIGEST.test(facts.canaryReport.observation_digest),
    no_unacceptable_regression:
      facts.canaryReport.gate_passed &&
      facts.canaryReport.safety_incidents === 0 &&
      facts.canaryReport.success_rate_delta >= facts.policy.min_success_rate_delta &&
      finite(facts.evaluation.successDelta) &&
      Number(facts.evaluation.successDelta) >= facts.policy.min_success_rate_delta &&
      casePassed(facts.evaluationReport, "active-target-conflict"),
    rollback_artifact_plan:
      facts.rollbackArtifactVerified &&
      rollbackArtifactID.startsWith("art_") &&
      DIGEST.test(rollbackArtifactDigest) &&
      DIGEST.test(rollbackPlanDigest) &&
      rollback.operation === "deactivate_strategy_overlay",
    current_policy_version:
      facts.canaryReport.policy_version === policy.version &&
      facts.canaryReport.policy_digest === policy.digest &&
      facts.approval.policy_version === policy.action_gateway_policy_version,
  })
  const core = {
    schema_version: 1 as const,
    candidate_id: facts.candidateID,
    candidate_digest: facts.candidateDigest,
    source_experience_ids: Object.freeze([...sourceExperienceIDs]),
    source_evidence_ids: Object.freeze([...sourceEvidenceIDs]),
    source_evaluation_ids: Object.freeze([...sourceEvaluationIDs]),
    source_provenance_digest: sourceProvenanceDigest,
    evaluation: Object.freeze({
      id: evaluationID,
      baseline_digest: baselineDigest,
      candidate_digest: evaluationCandidate,
      report_digest: facts.evaluationReport.report_digest,
    }),
    approval_actor: approvalActor,
    canary: Object.freeze({
      candidate_observations: facts.canaryReport.candidate_observations,
      control_observations: facts.canaryReport.control_observations,
      observation_ids: Object.freeze([...facts.canaryReport.observation_ids]),
      observation_digest: facts.canaryReport.observation_digest,
    }),
    rollback_artifact: Object.freeze({
      artifact_id: rollbackArtifactID,
      digest: rollbackArtifactDigest,
      plan_digest: rollbackPlanDigest,
    }),
    policy,
    checks,
    gate_passed: Object.values(checks).every(Boolean),
  }
  const gateDigest = canonicalHash(core)
  if (!gateDigest) throw new PromotionGateError("promotion gate receipt is not canonicalizable")
  return Object.freeze({ ...core, gate_digest: gateDigest })
}

const assert = (facts: PromotionGateFacts): PromotionGateReceipt => {
  const receipt = build(facts)
  if (!receipt.gate_passed) {
    const failed = Object.entries(receipt.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
    throw new PromotionGateError(`promotion prerequisites failed: ${failed.join(", ")}`)
  }
  return receipt
}

const assertPresented = (facts: PromotionGateFacts, presented: PromotionGateReceipt): PromotionGateReceipt => {
  const expected = assert(facts)
  return assertExpected(expected, presented)
}

const assertIntegrity = (presented: unknown): PromotionGateReceipt => {
  const value = record(presented)
  const presentedDigest = typeof value.gate_digest === "string" ? value.gate_digest : ""
  const { gate_digest: _gateDigest, ...presentedCore } = value
  if (!DIGEST.test(presentedDigest) || value.gate_passed !== true || canonicalHash(presentedCore) !== presentedDigest)
    throw new PromotionGateError("stored promotion receipt has invalid integrity")
  return value as unknown as PromotionGateReceipt
}

const assertExpected = (expected: PromotionGateReceipt, presented: unknown): PromotionGateReceipt => {
  const value = assertIntegrity(presented)
  if (canonicalHash(value) !== canonicalHash(expected))
    throw new PromotionGateError("presented promotion receipt is forged or stale")
  return expected
}

export const PromotionGate = Object.freeze({
  VERSION: PROMOTION_POLICY_VERSION,
  ACTION_GATEWAY_POLICY_VERSION,
  build,
  assert,
  assertPresented,
  assertIntegrity,
  assertExpected,
})
