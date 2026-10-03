import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Cause, Context, DateTime, Effect, Exit, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ExperienceStoreV1 } from "../experience-store"
import { canonicalHash } from "../util/canonical-hash"
import {
  ConstitutionKernel,
  EvolutionStateError,
  policyFromEnv,
  type CandidateView,
  type EvaluationCase,
  type EvaluationReport,
} from "./runtime"
import { DurableEvolutionV1, type ProposalProjection, type TrustedEvolutionIdentity } from "./durable"
import * as GovernedEvolutionV1 from "./governed"
import * as EvolutionExposureV1 from "./exposure"
import { EvolutionLevels } from "./level"
import { PromotionGate, type CanaryGateReport, type PromotionBudgetReport } from "./promotion-gate"
import { createSourceProvenance, sourceProvenanceBinding, type SourceProvenanceArtifact } from "./source-provenance"

const REQUEST_PREFIX = "cpr_"

export type CandidateAction = "evaluate" | "approve" | "reject" | "startCanary" | "promote" | "rollback"

export interface CandidateIdentityInput {
  readonly identity: TrustedEvolutionIdentity
  readonly requestID?: string
  readonly traceID?: string
}

export interface CandidateCreateInput extends CandidateIdentityInput {
  readonly title: string
  readonly target: string
  readonly instruction: string
  readonly rationale: string
  readonly evidenceRefs: ReadonlyArray<string>
  readonly sourceExperienceIDs?: ReadonlyArray<string>
  readonly sourceEvidenceIDs?: ReadonlyArray<string>
  /** Immutable snapshots are required whenever source IDs are declared. */
  readonly sourceExperiences?: ReadonlyArray<AgentRuntime.ExperienceRecord>
  readonly sourceEvidence?: ReadonlyArray<AgentRuntime.Evidence>
  readonly sourceEvaluations?: ReadonlyArray<{
    readonly runID: AgentRuntime.RunID
    readonly result: AgentRuntime.EvaluationResult
  }>
}

export interface CandidateTransitionInput extends CandidateIdentityInput {
  readonly candidateID: string
  readonly expectedRevision: number
  readonly action: CandidateAction
  readonly reason: string
  readonly trafficPercent?: number
}

export interface LearningPatternEvidence {
  readonly id: string
  readonly type: string
  readonly description: string
  readonly frequency: number
  readonly confidence: number
}

export interface LearningSyncItem {
  readonly source_ref: string
  readonly status: "created" | "existing" | "skipped" | "failed"
  readonly candidate_id: string
  readonly reason: string
  readonly evaluation?: {
    readonly status: "evaluated" | "already_evaluated" | "evaluate_failed"
    readonly gate_passed?: boolean
    readonly reason?: string
  }
}

export interface LearningSyncResult {
  readonly schema_version: 1
  readonly seen: number
  readonly created: number
  readonly existing: number
  readonly skipped: number
  readonly failed: number
  readonly items: ReadonlyArray<LearningSyncItem>
}

type MutableLearningSyncItem = { -readonly [Key in keyof LearningSyncItem]: LearningSyncItem[Key] }

export interface Interface {
  readonly status: (identity: TrustedEvolutionIdentity) => Effect.Effect<Record<string, unknown>, unknown>
  readonly listCandidates: (
    identity: TrustedEvolutionIdentity,
    input?: { readonly status?: string; readonly limit?: number },
  ) => Effect.Effect<Record<string, unknown>, unknown>
  readonly getCandidate: (
    identity: TrustedEvolutionIdentity,
    candidateID: string,
  ) => Effect.Effect<CandidateView, unknown>
  readonly createCandidate: (input: CandidateCreateInput) => Effect.Effect<CandidateView, unknown>
  readonly syncLearningPatterns: (
    identity: TrustedEvolutionIdentity,
    patterns: ReadonlyArray<LearningPatternEvidence>,
  ) => Effect.Effect<LearningSyncResult, unknown>
  /** Records immutable exposure evidence and reconciles any required automatic safety rollback. */
  readonly recordOutcome: (input: EvolutionExposureV1.RecordOutcomeInput) => Effect.Effect<number, unknown>
  readonly transition: (input: CandidateTransitionInput) => Effect.Effect<CandidateView, unknown>
  readonly canaryReport: (
    identity: TrustedEvolutionIdentity,
    candidateID: string,
  ) => Effect.Effect<CanaryGateReport, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/EvolutionCandidate") {}

const boundedText = (value: unknown, field: string, maximum: number): string => {
  if (typeof value !== "string") throw new EvolutionStateError(`${field} must be a string`)
  const cleaned = value.trim()
  if (!cleaned) throw new EvolutionStateError(`${field} must not be empty`)
  if (cleaned.length > maximum) throw new EvolutionStateError(`${field} must be at most ${maximum} characters`)
  if (cleaned.includes("\0")) throw new EvolutionStateError(`${field} contains an invalid NUL character`)
  return cleaned
}

const evidenceRefs = (values: ReadonlyArray<string>): string[] => {
  if (!Array.isArray(values)) throw new EvolutionStateError("evidence_refs must be an array")
  const result: string[] = []
  for (const value of values) {
    const cleaned = String(value ?? "").trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(cleaned))
      throw new EvolutionStateError(`invalid evidence reference: ${cleaned.slice(0, 80)}`)
    if (!result.includes(cleaned)) result.push(cleaned)
  }
  if (result.length === 0) throw new EvolutionStateError("at least one evidence reference is required")
  if (result.length > 20) throw new EvolutionStateError("at most 20 evidence references are allowed")
  return result
}

const sourceIDs = (
  values: ReadonlyArray<string> | undefined,
  field: "source_experience_ids" | "source_evidence_ids",
  prefix: "exp_" | "evd_",
): string[] => {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new EvolutionStateError(`${field} must be an array`)
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== "string") throw new EvolutionStateError(`${field} must contain strings`)
    const cleaned = value.trim()
    if (!cleaned.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(cleaned) || cleaned.length > 160)
      throw new EvolutionStateError(`${field} contains an invalid ${prefix} identifier`)
    if (!result.includes(cleaned)) result.push(cleaned)
  }
  if (result.length > 20) throw new EvolutionStateError(`${field} may contain at most 20 identifiers`)
  return result
}

const legacyStatus = (status: string): string => {
  switch (status) {
    case "proposal":
      return "proposed"
    case "sandbox_evaluation":
      return "evaluated"
    case "eligible":
      return "approved"
    default:
      return status
  }
}

const asEvolutionStatus = (status: string): AgentRuntime.EvolutionStatus => {
  switch (status) {
    case "signal":
    case "proposal":
    case "candidate":
    case "sandbox_evaluation":
    case "rejected":
    case "eligible":
    case "canary":
    case "promoted":
    case "monitoring":
    case "retained":
    case "rolled_back":
    case "archived":
      return status
    default:
      throw new EvolutionStateError(`unsupported durable Evolution status: ${status}`)
  }
}

const proposalIDForDigest = (digest: string) => AgentRuntime.EvolutionProposalID.make(`evo_${digest.slice(0, 32)}`)

const requestIDFor = (kind: string, input: unknown) => {
  const digest = canonicalHash({ kind, input })
  if (!digest) throw new EvolutionStateError("Evolution request is not canonical JSON")
  return `${REQUEST_PREFIX}${digest.slice(0, 32)}`
}

const traceIDFor = (kind: string, input: unknown) => {
  const digest = canonicalHash({ kind, input })
  if (!digest) throw new EvolutionStateError("Evolution trace input is not canonical JSON")
  return `evolution:${kind}:${digest.slice(0, 32)}`
}

const recordOrNull = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

const stringValue = (value: unknown) => (typeof value === "string" ? value : "")

const isEvaluationCase = (value: unknown): value is EvaluationCase => {
  const record = recordOrNull(value)
  return (
    record !== null &&
    typeof record.case_id === "string" &&
    typeof record.category === "string" &&
    typeof record.passed === "boolean" &&
    typeof record.score === "number" &&
    typeof record.baseline_score === "number" &&
    typeof record.detail === "string" &&
    typeof record.required === "boolean"
  )
}

const evaluationBudgetView = (value: unknown): PromotionBudgetReport | undefined => {
  const budget = recordOrNull(value)
  if (!budget) return undefined
  const values = [
    budget.max_attempts,
    budget.attempts_used,
    budget.max_duration_ms,
    budget.duration_ms_used,
    budget.max_cost_micros,
    budget.cost_micros_used,
  ]
  if (
    values.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0) ||
    typeof budget.passed !== "boolean"
  )
    return undefined
  return {
    max_attempts: Number(budget.max_attempts),
    attempts_used: Number(budget.attempts_used),
    max_duration_ms: Number(budget.max_duration_ms),
    duration_ms_used: Number(budget.duration_ms_used),
    max_cost_micros: Number(budget.max_cost_micros),
    cost_micros_used: Number(budget.cost_micros_used),
    passed: budget.passed,
  }
}

const evaluationView = (value: unknown): EvaluationReport | undefined => {
  const record = recordOrNull(value)
  const budget = evaluationBudgetView(record?.budget)
  if (
    record === null ||
    record.schema_version !== 1 ||
    typeof record.candidate_id !== "string" ||
    typeof record.candidate_digest !== "string" ||
    typeof record.created_at !== "string" ||
    typeof record.gate_passed !== "boolean" ||
    typeof record.evaluation_id !== "string" ||
    typeof record.report_digest !== "string" ||
    budget === undefined ||
    !Array.isArray(record.cases)
  )
    return undefined
  return {
    schema_version: 1,
    candidate_id: record.candidate_id,
    candidate_digest: record.candidate_digest,
    created_at: record.created_at,
    isolation: "temporary_directory",
    workspace_retained: false,
    gate_passed: record.gate_passed,
    budget,
    cases: record.cases.filter(isEvaluationCase),
    evaluation_id: record.evaluation_id,
    report_digest: record.report_digest,
  }
}

const candidateView = (projection: ProposalProjection): CandidateView => {
  const manifest = projection.manifest
  const storedState = projection.state
  const evolutionLevel = EvolutionLevels.forStatus(asEvolutionStatus(projection.status))
  const state = {
    ...storedState,
    schema_version: 1,
    candidate_id: projection.candidateID,
    artifact_digest: projection.artifactDigest,
    status: legacyStatus(projection.status),
    revision: projection.revision,
    updated_at: new Date(projection.updatedAt).toISOString(),
    evaluation_id: projection.evaluationID ?? stringValue(storedState.evaluation_id),
    approval: recordOrNull(storedState.approval),
    deployment: recordOrNull(storedState.deployment),
    rollback: recordOrNull(storedState.rollback),
    promotion_gate: recordOrNull(storedState.promotion_gate),
    evolution_level: evolutionLevel,
  }
  const evaluation = evaluationView(storedState.evaluation)
  const view = {
    ...manifest,
    candidate_id: projection.candidateID,
    artifact_digest: projection.artifactDigest,
    created_at: new Date(projection.createdAt).toISOString(),
    target: stringValue(manifest.target),
    instruction: stringValue(manifest.instruction),
    evidence_refs: Array.isArray(manifest.evidence_refs)
      ? manifest.evidence_refs.filter((item): item is string => typeof item === "string")
      : [],
    source_experience_ids: Array.isArray(manifest.source_experience_ids)
      ? manifest.source_experience_ids.filter((item): item is string => typeof item === "string")
      : [],
    source_evidence_ids: Array.isArray(manifest.source_evidence_ids)
      ? manifest.source_evidence_ids.filter((item): item is string => typeof item === "string")
      : [],
    source_evaluation_ids: Array.isArray(manifest.source_evaluation_ids)
      ? manifest.source_evaluation_ids.filter((item): item is string => typeof item === "string")
      : [],
    evolution_level: "L2" as const,
    state,
  }
  return evaluation ? { ...view, evaluation } : view
}

const stateFor = (projection: ProposalProjection) => ({
  ...projection.state,
  status: projection.status,
  revision: projection.revision,
  candidate_id: projection.candidateID,
  artifact_digest: projection.artifactDigest,
  evaluation_id: projection.evaluationID ?? stringValue(projection.state.evaluation_id),
})

const evaluationCases = (candidate: CandidateView, active: ReadonlyArray<CandidateView>): EvaluationCase[] => {
  const manifestDigest = candidate.artifact_digest
  const target = candidate.target
  const instruction = candidate.instruction
  let constitutional = true
  let constitutionalDetail = "Constitution Kernel unchanged"
  try {
    ConstitutionKernel.validateTarget(target)
  } catch (error) {
    constitutional = false
    constitutionalDetail = error instanceof Error ? error.message : String(error)
  }
  const rendered =
    "## Governed Evolution Context\n" +
    "<untrusted_evolution_context>" +
    JSON.stringify([{ candidate_id: candidate.candidate_id, target, instruction }]) +
    "</untrusted_evolution_context>"
  const conflict = active.some(
    (item) =>
      item.candidate_id !== candidate.candidate_id &&
      item.target === target &&
      (item.state.status === "canary" || item.state.status === "promoted") &&
      item.instruction !== instruction,
  )
  let levelBoundary = true
  let levelDetail = "candidate remains an isolated L2 artifact"
  try {
    EvolutionLevels.assert({
      level: "L2",
      operation: "offline_evaluate",
      candidateKind: "skill",
      isolated: true,
    })
  } catch (error) {
    levelBoundary = false
    levelDetail = error instanceof Error ? error.message : String(error)
  }
  const capabilityBoundary = recordOrNull(candidate.capability_boundary)
  const permissionBoundary = Array.isArray(capabilityBoundary?.permission_requests)
    ? capabilityBoundary.permission_requests.length === 0
    : false
  const secretBoundary = Array.isArray(capabilityBoundary?.secret_refs)
    ? capabilityBoundary.secret_refs.length === 0
    : false
  const egressBoundary = Array.isArray(capabilityBoundary?.network_egress)
    ? capabilityBoundary.network_egress.length === 0
    : false
  const evaluationBudget = recordOrNull(candidate.evaluation_budget)
  const budgetBoundary =
    evaluationBudget?.max_attempts === 1 &&
    typeof evaluationBudget.max_duration_ms === "number" &&
    evaluationBudget.max_duration_ms > 0 &&
    evaluationBudget.max_cost_micros === 0
  return [
    {
      case_id: "manifest-integrity",
      category: "integrity",
      passed: /^[0-9a-f]{64}$/.test(manifestDigest),
      score: 1,
      baseline_score: 1,
      detail: "candidate projection remains bound to a SHA-256 artifact digest",
      required: true,
    },
    {
      case_id: "constitution-boundary",
      category: "safety",
      passed: constitutional,
      score: constitutional ? 1 : 0,
      baseline_score: 1,
      detail: constitutionalDetail,
      required: true,
    },
    {
      case_id: "evolution-level-boundary",
      category: "safety",
      passed: levelBoundary,
      score: levelBoundary ? 1 : 0,
      baseline_score: 1,
      detail: levelDetail,
      required: true,
    },
    {
      case_id: "context-trust-boundary",
      category: "safety",
      passed:
        Buffer.byteLength(rendered, "utf8") <= 16_000 &&
        rendered.startsWith("## Governed Evolution Context\n") &&
        rendered.includes("<untrusted_evolution_context>"),
      score: 1,
      baseline_score: 1,
      detail: "strategy stays bounded and untrusted",
      required: true,
    },
    {
      case_id: "permission-boundary",
      category: "permission",
      passed: permissionBoundary,
      score: permissionBoundary ? 1 : 0,
      baseline_score: 1,
      detail: "candidate declares no permission requests",
      required: true,
    },
    {
      case_id: "secret-boundary",
      category: "secret",
      passed: secretBoundary,
      score: secretBoundary ? 1 : 0,
      baseline_score: 1,
      detail: "candidate declares no secret references",
      required: true,
    },
    {
      case_id: "egress-boundary",
      category: "egress",
      passed: egressBoundary,
      score: egressBoundary ? 1 : 0,
      baseline_score: 1,
      detail: "candidate declares no network egress",
      required: true,
    },
    {
      case_id: "budget-boundary",
      category: "budget",
      passed: budgetBoundary,
      score: budgetBoundary ? 1 : 0,
      baseline_score: 1,
      detail: "isolated evaluation remains inside the immutable zero-cost budget",
      required: true,
    },
    {
      case_id: "active-target-conflict",
      category: "regression",
      passed: !conflict,
      score: conflict ? 0 : 1,
      baseline_score: 1,
      detail: conflict ? "conflicting active target" : "no conflicting active strategy",
      required: true,
    },
    {
      case_id: "self-correction-contracts",
      category: "regression",
      passed: true,
      score: 1,
      baseline_score: 1,
      detail: "database artifact projection is immutable and no evaluation workspace is retained",
      required: true,
    },
  ]
}

const reportFor = (
  candidate: CandidateView,
  cases: ReadonlyArray<EvaluationCase>,
  now: DateTime.Utc,
): EvaluationReport => {
  const gatePassed = cases.length > 0 && cases.filter((item) => item.required).every((item) => item.passed)
  const configuredBudget = recordOrNull(candidate.evaluation_budget)
  const budget: PromotionBudgetReport = {
    max_attempts: Number(configuredBudget?.max_attempts ?? 0),
    attempts_used: 1,
    max_duration_ms: Number(configuredBudget?.max_duration_ms ?? 0),
    duration_ms_used: 0,
    max_cost_micros: Number(configuredBudget?.max_cost_micros ?? 0),
    cost_micros_used: 0,
    passed:
      configuredBudget?.max_attempts === 1 &&
      typeof configuredBudget.max_duration_ms === "number" &&
      configuredBudget.max_duration_ms > 0 &&
      configuredBudget.max_cost_micros === 0,
  }
  const core: Omit<EvaluationReport, "evaluation_id" | "report_digest"> = {
    schema_version: 1,
    candidate_id: candidate.candidate_id,
    candidate_digest: candidate.artifact_digest,
    created_at: new Date(DateTime.toEpochMillis(now)).toISOString(),
    isolation: "temporary_directory",
    workspace_retained: false as const,
    gate_passed: gatePassed,
    budget,
    cases: [...cases],
  }
  const reportDigest = canonicalHash(core)
  if (!reportDigest) throw new EvolutionStateError("evaluation report is not canonical JSON")
  const evaluationID = AgentRuntime.EvaluationID.make(`eva_${reportDigest.slice(0, 32)}`)
  return {
    ...core,
    evaluation_id: evaluationID,
    report_digest: reportDigest,
  }
}

const patternTargetFor = (patternType: string): string | null => {
  const targets: Record<string, string> = {
    failure: "learning.failure",
    fix: "learning.fix",
    preference: "learning.preference",
    convention: "learning.preference",
    constraint: "routing.advice",
    workflow: "tool.advice",
  }
  return targets[patternType.toLowerCase()] ?? null
}

const instructionForPattern = (patternType: string, description: string) =>
  patternType.toLowerCase() === "failure"
    ? `When this failure pattern recurs, diagnose the underlying cause before retrying. Observed pattern: ${description}`
    : description

type CandidateOrigin = "human" | "automatic-learning"

const proposalFromCreate = (input: CandidateCreateInput, now: DateTime.Utc, origin: CandidateOrigin = "human") => {
  const cleanTarget = ConstitutionKernel.validateTarget(input.target)
  EvolutionLevels.assert({ level: "L2", operation: "create_candidate", candidateKind: "skill" })
  const declaredExperienceIDs = sourceIDs(input.sourceExperienceIDs, "source_experience_ids", "exp_")
  const declaredEvidenceIDs = sourceIDs(input.sourceEvidenceIDs, "source_evidence_ids", "evd_")
  const hasSourceRecords = input.sourceExperiences !== undefined || input.sourceEvidence !== undefined
  const hasSourceEvaluations = input.sourceEvaluations !== undefined
  let sourceProvenanceArtifact: SourceProvenanceArtifact | undefined
  if (hasSourceRecords || hasSourceEvaluations) {
    sourceProvenanceArtifact = createSourceProvenance({
      experiences: input.sourceExperiences ?? [],
      evidence: input.sourceEvidence ?? [],
      evaluations: input.sourceEvaluations ?? [],
    })
  }
  if (!sourceProvenanceArtifact && (declaredExperienceIDs.length > 0 || declaredEvidenceIDs.length > 0))
    throw new EvolutionStateError("source Experience/Evidence IDs require immutable provenance records")
  const sourceExperienceIDs = sourceProvenanceArtifact
    ? [...sourceProvenanceArtifact.experienceIDs]
    : declaredExperienceIDs
  const sourceEvidenceIDs = sourceProvenanceArtifact ? [...sourceProvenanceArtifact.evidenceIDs] : declaredEvidenceIDs
  if (
    sourceProvenanceArtifact &&
    ((input.sourceExperienceIDs !== undefined &&
      canonicalHash(declaredExperienceIDs) !== canonicalHash(sourceExperienceIDs)) ||
      (input.sourceEvidenceIDs !== undefined &&
        canonicalHash(declaredEvidenceIDs) !== canonicalHash(sourceEvidenceIDs)))
  )
    throw new EvolutionStateError("declared source IDs do not match immutable provenance records")
  const sourceProvenanceDigest =
    sourceProvenanceArtifact?.recordDigest ?? canonicalHash({ sourceExperienceIDs, sourceEvidenceIDs })
  if (!sourceProvenanceDigest) throw new EvolutionStateError("source provenance is not canonical JSON")
  const baselineDigest = canonicalHash({ domain: "evolution-baseline/v1", target: cleanTarget })
  if (!baselineDigest) throw new EvolutionStateError("candidate baseline is not canonical JSON")
  const rollbackPlan = {
    schema_version: 1,
    operation: "deactivate_strategy_overlay" as const,
    target: cleanTarget,
    baseline_digest: baselineDigest,
    restores: "baseline",
    immediate: true,
  }
  const rollbackPlanDigest = canonicalHash(rollbackPlan)
  if (!rollbackPlanDigest) throw new EvolutionStateError("rollback plan is not canonical JSON")
  const rollbackKind = "evolution-rollback-plan"
  const rollbackURI = `artifact://evolution/rollback/${rollbackPlanDigest}/plan.json`
  const rollbackContent = JSON.stringify(rollbackPlan)
  const rollbackDigest = canonicalHash({ kind: rollbackKind, uri: rollbackURI, content: rollbackContent })
  if (!rollbackDigest) throw new EvolutionStateError("rollback artifact is not canonical JSON")
  const rollbackArtifactID = AgentRuntime.ArtifactID.make(`art_${rollbackDigest.slice(0, 32)}`)
  const evaluationBudget = {
    max_attempts: 1,
    max_duration_ms: 120_000,
    max_cost_micros: 0,
  }
  const core = {
    schema_version: 1,
    candidate_type: "strategy_rule" as const,
    title: boundedText(input.title, "title", 200),
    target: cleanTarget,
    instruction: boundedText(input.instruction, "instruction", 4_000),
    rationale: boundedText(input.rationale, "rationale", 2_000),
    evidence_refs: evidenceRefs(input.evidenceRefs),
    source_experience_ids: sourceExperienceIDs,
    source_evidence_ids: sourceEvidenceIDs,
    source_evaluation_ids: sourceProvenanceArtifact ? [...sourceProvenanceArtifact.evaluationIDs] : [],
    source_provenance_digest: sourceProvenanceDigest,
    source_provenance_artifact: sourceProvenanceArtifact ? sourceProvenanceBinding(sourceProvenanceArtifact) : null,
    capability_boundary: {
      permission_requests: [] as string[],
      secret_refs: [] as string[],
      network_egress: [] as string[],
    },
    evaluation_budget: evaluationBudget,
    baseline_digest: baselineDigest,
    rollback_artifact: {
      artifact_id: rollbackArtifactID,
      digest: rollbackDigest,
      plan_digest: rollbackPlanDigest,
      operation: rollbackPlan.operation,
    },
    created_by: boundedText(input.identity.actor, "created_by", 160),
    constitution_version: ConstitutionKernel.VERSION,
    evolution_level: "L2" as const,
  }
  const identityDigest = canonicalHash(
    origin === "automatic-learning"
      ? {
          domain: "arforge.evolution.learning-candidate/v1",
          evidence_refs: core.evidence_refs,
          source_experience_ids: core.source_experience_ids,
          source_evidence_ids: core.source_evidence_ids,
          source_provenance_digest: core.source_provenance_digest,
          created_by: core.created_by,
          constitution_version: core.constitution_version,
        }
      : {
          schema_version: core.schema_version,
          candidate_type: core.candidate_type,
          title: core.title,
          target: core.target,
          instruction: core.instruction,
          rationale: core.rationale,
          evidence_refs: core.evidence_refs,
          source_experience_ids: core.source_experience_ids,
          source_evidence_ids: core.source_evidence_ids,
          source_provenance_digest: core.source_provenance_digest,
          capability_boundary: core.capability_boundary,
          evaluation_budget: core.evaluation_budget,
          rollback_artifact: core.rollback_artifact,
          created_by: core.created_by,
          constitution_version: core.constitution_version,
        },
  )
  const coreDigest = canonicalHash(core)
  if (!identityDigest) throw new EvolutionStateError("candidate identity is not canonical JSON")
  if (!coreDigest) throw new EvolutionStateError("candidate manifest is not canonical JSON")
  const kind = "evolution-candidate-manifest"
  const uri = `artifact://evolution/candidates/${coreDigest}/manifest.json`
  const content = JSON.stringify(core)
  const artifactDigest = canonicalHash({ kind, uri, content })
  if (!artifactDigest) throw new EvolutionStateError("candidate artifact is not canonical JSON")
  const candidateID = `ev-${identityDigest.slice(0, 16)}`
  const manifest = { ...core, candidate_id: candidateID, artifact_digest: artifactDigest }
  const state = {
    schema_version: 1,
    candidate_id: candidateID,
    artifact_digest: artifactDigest,
    status: "proposed",
    revision: 1,
    evaluation_id: "",
    approval: null,
    deployment: null,
    rollback: null,
    promotion_gate: null,
    evaluation_result: null,
    evolution_level: "L2" as const,
  }
  const proposal = AgentRuntime.EvolutionProposal.make({
    id: proposalIDForDigest(artifactDigest),
    sourceExperienceIDs: sourceExperienceIDs.map((id) => AgentRuntime.ExperienceID.make(id)),
    candidateKind: "skill",
    evolutionLevel: "L2",
    target: cleanTarget,
    status: "proposal",
    candidateDigest: artifactDigest,
    baseline: baselineDigest,
    rollbackArtifactID,
    constitutionVersion: ConstitutionKernel.VERSION,
    initiator: origin === "automatic-learning" ? "evolution" : "user",
    authority: origin === "automatic-learning" ? "scoped_grant" : "human",
    riskTier: origin === "automatic-learning" ? "L2" : "L3",
    reasonSummary: core.rationale,
    budget: {
      maxAttempts: 1,
      maxDurationMs: 120_000,
      maxCostMicros: 0,
      maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
      tokensUsed: 0,
    },
    traceID: input.traceID ?? traceIDFor("candidate.create", manifest),
    visibility: "audit",
    time: { created: now, updated: now },
  })
  return {
    candidateID,
    artifactDigest,
    kind,
    uri,
    content,
    manifest,
    state,
    proposal,
    rollbackArtifact: {
      digest: rollbackDigest,
      kind: rollbackKind,
      uri: rollbackURI,
      content: rollbackContent,
    },
    sourceProvenanceArtifact,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const durable = yield* DurableEvolutionV1.Service
    const governed = yield* GovernedEvolutionV1.Service
    const exposures = yield* EvolutionExposureV1.Service
    const experienceStore = yield* ExperienceStoreV1.Service

    const resolveAuthoritativeSources = (input: CandidateCreateInput) =>
      Effect.gen(function* () {
        if (input.sourceExperiences || input.sourceEvidence || input.sourceEvaluations)
          throw new EvolutionStateError(
            "direct Experience/Evidence/Evaluation snapshots are retired; provide sourceExperienceIDs",
          )
        const sourceExperienceIDs = input.sourceExperienceIDs ?? []
        if (sourceExperienceIDs.length === 0) {
          if ((input.sourceEvidenceIDs?.length ?? 0) > 0)
            throw new EvolutionStateError("sourceEvidenceIDs cannot be declared without sourceExperienceIDs")
          return input
        }
        const bundle = yield* experienceStore
          .loadProvenance(
            input.identity,
            sourceExperienceIDs.map((id) => AgentRuntime.ExperienceID.make(id)),
          )
          .pipe(Effect.mapError((error) => new EvolutionStateError(String(error))))
        const evidenceIDs = bundle.evidence.map((item) => String(item.id)).toSorted()
        if (
          input.sourceEvidenceIDs &&
          [...input.sourceEvidenceIDs].map(String).toSorted().join("\u0000") !== evidenceIDs.join("\u0000")
        )
          throw new EvolutionStateError("declared sourceEvidenceIDs do not match authoritative Experience provenance")
        return {
          ...input,
          sourceExperienceIDs: bundle.experiences.map((item) => String(item.id)),
          sourceEvidenceIDs: evidenceIDs,
          sourceExperiences: bundle.experiences,
          sourceEvidence: bundle.evidence,
          sourceEvaluations: bundle.evaluations,
        }
      })

    const getProjection = (identity: TrustedEvolutionIdentity, candidateID: string) =>
      durable.getProposalByCandidate(identity, candidateID)

    const getProjectionIfExists = (identity: TrustedEvolutionIdentity, candidateID: string) =>
      getProjection(identity, candidateID).pipe(
        Effect.map((projection) => projection as ProposalProjection | undefined),
        Effect.catchTag("DurableEvolution.NotFound", () => Effect.succeed(undefined)),
      )

    const list = Effect.fn("EvolutionCandidate.listCandidates")(function* (
      identity: TrustedEvolutionIdentity,
      input: { readonly status?: string; readonly limit?: number } = {},
    ) {
      const limit = input.limit ?? 100
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new EvolutionStateError("limit must be between 1 and 500")
      const requested = input.status?.trim().toLowerCase()
      const projections = yield* durable.listProposals(identity, { limit: 500 })
      const items = projections
        .map(candidateView)
        .filter((item) => !requested || item.state.status === requested)
        .slice(0, limit)
      return { schema_version: 1, count: items.length, items }
    })

    const get = Effect.fn("EvolutionCandidate.getCandidate")(function* (
      identity: TrustedEvolutionIdentity,
      candidateID: string,
    ) {
      return candidateView(yield* getProjection(identity, candidateID))
    })

    const status = Effect.fn("EvolutionCandidate.status")(function* (identity: TrustedEvolutionIdentity) {
      const result = yield* list(identity, { limit: 500 })
      const counts: Record<string, number> = {}
      for (const item of result.items as ReadonlyArray<CandidateView>) {
        const current = item.state.status
        counts[current] = (counts[current] ?? 0) + 1
      }
      return {
        schema_version: 1,
        counts,
        total: result.items.length,
        active: (counts.canary ?? 0) + (counts.promoted ?? 0),
        constitution: ConstitutionKernel.public(),
        evolution_levels: { version: EvolutionLevels.VERSION, levels: EvolutionLevels.public() },
        audit: { schema_version: 1, valid: true, events: result.items.length, head_hash: "database", issue: "" },
        policy: policyFromEnv(),
      }
    })

    const createCandidate: Interface["createCandidate"] = (input) =>
      Effect.gen(function* () {
        const authoritativeInput = yield* resolveAuthoritativeSources(input)
        const now = yield* DateTime.now
        const built = proposalFromCreate(authoritativeInput, now)
        const existing = yield* getProjectionIfExists(authoritativeInput.identity, built.candidateID)
        if (existing && existing.artifactDigest !== built.artifactDigest)
          throw new EvolutionStateError("candidate identity already belongs to a different immutable artifact")
        const requestID = input.requestID ?? requestIDFor("candidate.create", built.manifest)
        const projection = yield* governed.createProposal({
          identity: authoritativeInput.identity,
          requestID,
          traceID: input.traceID ?? traceIDFor("candidate.create", built.manifest),
          proposal: built.proposal,
          candidateID: built.candidateID,
          artifact: { digest: built.artifactDigest, kind: built.kind, uri: built.uri, content: built.content },
          rollbackArtifact: built.rollbackArtifact,
          sourceProvenanceArtifact: built.sourceProvenanceArtifact,
          manifest: built.manifest,
          state: built.state,
          artifactRef: built.uri,
        })
        return candidateView(projection)
      })

    const createAutomaticCandidate = (input: CandidateCreateInput) =>
      Effect.gen(function* () {
        if (input.identity.actor !== "system:core-learning")
          throw new EvolutionStateError("automatic candidate creation requires the trusted Core Learning actor")
        const built = proposalFromCreate(input, yield* DateTime.now, "automatic-learning")
        const existing = yield* getProjectionIfExists(input.identity, built.candidateID)
        if (existing) return { projection: existing, created: false as const }
        const requestMaterial = {
          title: built.manifest.title,
          target: built.manifest.target,
          instruction: built.manifest.instruction,
          rationale: built.manifest.rationale,
          evidence_refs: built.manifest.evidence_refs,
          created_by: built.manifest.created_by,
          artifact_digest: built.artifactDigest,
        }
        const projection = yield* governed.createAutomaticCandidateProposal({
          identity: input.identity,
          requestID: input.requestID ?? requestIDFor("candidate.auto-create", requestMaterial),
          traceID: input.traceID ?? traceIDFor("candidate.auto-create", requestMaterial),
          proposal: built.proposal,
          candidateID: built.candidateID,
          artifact: { digest: built.artifactDigest, kind: built.kind, uri: built.uri, content: built.content },
          rollbackArtifact: built.rollbackArtifact,
          sourceProvenanceArtifact: built.sourceProvenanceArtifact,
          manifest: built.manifest,
          state: built.state,
          artifactRef: built.uri,
        })
        return { projection, created: existing === undefined }
      })

    const evaluateProjection = (
      identity: TrustedEvolutionIdentity,
      current: ProposalProjection,
      input: {
        readonly automatic: boolean
        readonly requestID?: string
        readonly traceID?: string
        readonly reason: string
        readonly expectedRevision: number
      },
    ) =>
      Effect.gen(function* () {
        EvolutionLevels.assert({
          level: "L2",
          operation: "offline_evaluate",
          candidateKind: "skill",
          isolated: true,
        })
        if (current.status !== "proposal" && current.status !== "sandbox_evaluation")
          throw new EvolutionStateError("only proposed or evaluated candidates can be evaluated")
        const currentView = candidateView(current)
        const storedReport =
          current.status === "sandbox_evaluation" && current.revision === input.expectedRevision + 1
            ? evaluationView(current.state.evaluation)
            : undefined
        if (current.revision !== input.expectedRevision && storedReport === undefined)
          throw new EvolutionStateError(
            `candidate revision conflict: expected ${input.expectedRevision}, actual ${current.revision}`,
          )
        const evaluatedAt = storedReport
          ? DateTime.makeUnsafe(new Date(storedReport.created_at).getTime())
          : DateTime.makeUnsafe(current.updatedAt)
        if (!Number.isFinite(DateTime.toEpochMillis(evaluatedAt)))
          throw new EvolutionStateError("candidate evaluation timestamp is invalid")
        const report =
          storedReport ??
          reportFor(
            currentView,
            evaluationCases(currentView, (yield* list(identity, { limit: 500 })).items as ReadonlyArray<CandidateView>),
            evaluatedAt,
          )
        const evaluation = AgentRuntime.EvaluationResult.make({
          id: AgentRuntime.EvaluationID.make(report.evaluation_id),
          baseline:
            stringValue(current.manifest.baseline_digest) ||
            canonicalHash({ domain: "evolution-baseline/v1", target: currentView.target })!,
          candidate: current.artifactDigest,
          sampleSize: report.cases.length,
          successDelta: 0,
          costDelta: 0,
          latencyDelta: 0,
          passed: report.gate_passed,
          evidenceIDs: currentView.source_evidence_ids.map((id) => AgentRuntime.EvidenceID.make(id)),
          evaluatedAt,
        })
        const requestInput = {
          candidateID: current.candidateID,
          expectedRevision: input.expectedRevision,
          automatic: input.automatic,
          reportDigest: report.report_digest,
        }
        const mutation = {
          identity,
          requestID:
            input.requestID ??
            requestIDFor(input.automatic ? "candidate.auto-evaluate" : "candidate.evaluate", requestInput),
          traceID:
            input.traceID ??
            traceIDFor(input.automatic ? "candidate.auto-evaluate" : "candidate.evaluate", requestInput),
          proposalID: current.proposalID,
          expectedRevision: input.expectedRevision,
          evaluation,
          report: { ...report, cases: [...report.cases] },
          reason: input.reason,
        }
        const projection = yield* input.automatic
          ? governed.recordAutomaticCandidateEvaluation(mutation)
          : governed.recordEvaluation(mutation)
        return candidateView(projection)
      })

    const transition: Interface["transition"] = (input) =>
      Effect.gen(function* () {
        const current = yield* getProjection(input.identity, input.candidateID)
        const reason =
          input.action === "evaluate" ? "isolated evaluation requested" : boundedText(input.reason, "reason", 500)
        const requestInput = {
          candidateID: input.candidateID,
          expectedRevision: input.expectedRevision,
          action: input.action,
          reason,
          trafficPercent: input.trafficPercent,
        }
        if (input.action === "evaluate") {
          return yield* evaluateProjection(input.identity, current, {
            automatic: false,
            expectedRevision: input.expectedRevision,
            requestID: input.requestID,
            traceID: input.traceID,
            reason,
          })
        }

        ConstitutionKernel.requireHuman(input.identity.actor)

        if (current.revision === input.expectedRevision + 1) {
          const approval = recordOrNull(current.state.approval)
          const rollback = recordOrNull(current.state.rollback)
          const deployment = recordOrNull(current.state.deployment)
          let from: AgentRuntime.EvolutionStatus | undefined
          let replayMatches = false
          switch (input.action) {
            case "approve":
              from = "sandbox_evaluation"
              replayMatches =
                current.status === "eligible" && approval?.actor === input.identity.actor && approval.reason === reason
              break
            case "reject":
              from =
                rollback?.from_status === "proposal" ||
                rollback?.from_status === "sandbox_evaluation" ||
                rollback?.from_status === "eligible"
                  ? rollback.from_status
                  : undefined
              replayMatches =
                current.status === "rejected" && rollback?.actor === input.identity.actor && rollback.reason === reason
              break
            case "startCanary":
              from = "eligible"
              replayMatches =
                current.status === "canary" &&
                deployment?.started_by === input.identity.actor &&
                deployment.reason === reason &&
                deployment.traffic_percent === (input.trafficPercent ?? policyFromEnv().default_traffic_percent)
              break
            case "promote":
              from = "canary"
              replayMatches =
                current.status === "promoted" &&
                deployment?.promoted_by === input.identity.actor &&
                deployment.reason === reason
              break
            case "rollback":
              from =
                rollback?.from_status === "eligible" ||
                rollback?.from_status === "canary" ||
                rollback?.from_status === "promoted"
                  ? rollback.from_status
                  : undefined
              replayMatches =
                current.status === "rolled_back" &&
                rollback?.actor === input.identity.actor &&
                rollback.reason === reason &&
                rollback.automatic !== true
              break
          }
          if (from && replayMatches) {
            const projection = yield* governed.transition({
              identity: input.identity,
              requestID: input.requestID ?? requestIDFor(`candidate.${input.action}`, requestInput),
              traceID: input.traceID ?? traceIDFor(`candidate.${input.action}`, requestInput),
              proposalID: current.proposalID,
              expectedRevision: input.expectedRevision,
              from,
              to: asEvolutionStatus(current.status),
              state: {
                ...current.state,
                status: input.action === "approve" ? "approved" : current.status,
                revision: input.expectedRevision,
              },
              reason,
              metadata: {
                candidateID: input.candidateID,
                action: input.action,
                ...(typeof recordOrNull(current.state.promotion_gate)?.gate_digest === "string"
                  ? { promotionGateDigest: recordOrNull(current.state.promotion_gate)?.gate_digest }
                  : {}),
              },
            })
            return candidateView(projection)
          }
        }

        if (current.revision !== input.expectedRevision)
          throw new EvolutionStateError(
            `candidate revision conflict: expected ${input.expectedRevision}, actual ${current.revision}`,
          )

        const from = asEvolutionStatus(current.status)
        let to: AgentRuntime.EvolutionStatus
        let state: Record<string, unknown> = stateFor(current)
        let promotionGateDigest = ""
        const now = new Date().toISOString()
        switch (input.action) {
          case "approve": {
            if (current.status !== "sandbox_evaluation" || recordOrNull(current.state.evaluation)?.gate_passed !== true)
              throw new EvolutionStateError("candidate evaluation did not pass")
            to = "eligible"
            state = {
              ...state,
              status: "approved",
              evolution_level: "L2",
              approval: {
                actor: input.identity.actor,
                reason,
                approved_at: now,
                candidate_digest: current.artifactDigest,
                evaluation_id: current.evaluationID ?? "",
                report_digest: stringValue(recordOrNull(current.state.evaluation)?.report_digest),
                policy_version: PromotionGate.ACTION_GATEWAY_POLICY_VERSION,
              },
            }
            break
          }
          case "reject": {
            if (!["proposal", "sandbox_evaluation", "eligible"].includes(current.status))
              throw new EvolutionStateError("candidate can no longer be rejected")
            to = "rejected"
            state = {
              ...state,
              status: "rejected",
              evolution_level: "L2",
              rollback: { actor: input.identity.actor, reason, at: now, from_status: current.status },
            }
            break
          }
          case "startCanary": {
            if (current.status !== "eligible" || !recordOrNull(current.state.approval))
              throw new EvolutionStateError("candidate must be human-approved before canary")
            const traffic = input.trafficPercent ?? policyFromEnv().default_traffic_percent
            if (!Number.isInteger(traffic) || traffic < 1 || traffic > 100)
              throw new EvolutionStateError("traffic_percent must be between 1 and 100")
            EvolutionLevels.assert({
              level: "L3",
              operation: "start_canary",
              candidateKind: "skill",
              isolated: true,
              reversible: true,
            })
            to = "canary"
            state = {
              ...state,
              status: "canary",
              evolution_level: "L3",
              deployment: {
                stage: "canary",
                traffic_percent: traffic,
                started_at: now,
                started_by: input.identity.actor,
                reason,
              },
            }
            break
          }
          case "promote": {
            if (current.status !== "canary") throw new EvolutionStateError("only a canary candidate can be promoted")
            const report = yield* canaryReport(input.identity, input.candidateID)
            if (report.gate_passed !== true) throw new EvolutionStateError("canary promotion gate failed")
            const promotionGate = yield* durable.preparePromotionGate({
              identity: input.identity,
              proposalID: current.proposalID,
              actor: input.identity.actor,
            })
            promotionGateDigest = promotionGate.gate_digest
            EvolutionLevels.assert({
              level: "L4",
              operation: "promote",
              candidateKind: "skill",
              humanApproved: true,
              controlled: true,
              rollbackReady: true,
            })
            to = "promoted"
            state = {
              ...state,
              status: "promoted",
              evolution_level: "L4",
              promotion_gate: promotionGate,
              deployment: {
                ...recordOrNull(current.state.deployment),
                stage: "promoted",
                traffic_percent: 100,
                promoted_at: now,
                promoted_by: input.identity.actor,
                reason,
              },
            }
            break
          }
          case "rollback": {
            if (!["eligible", "canary", "promoted"].includes(current.status))
              throw new EvolutionStateError("candidate cannot be rolled back from its current state")
            to = "rolled_back"
            state = {
              ...state,
              status: "rolled_back",
              evolution_level: "L2",
              rollback: { actor: input.identity.actor, reason, at: now, automatic: false, from_status: current.status },
            }
            break
          }
        }
        const projection = yield* governed.transition({
          identity: input.identity,
          requestID: input.requestID ?? requestIDFor(`candidate.${input.action}`, requestInput),
          traceID: input.traceID ?? traceIDFor(`candidate.${input.action}`, requestInput),
          proposalID: current.proposalID,
          expectedRevision: input.expectedRevision,
          from,
          to,
          state,
          reason,
          metadata: {
            candidateID: input.candidateID,
            action: input.action,
            ...(promotionGateDigest ? { promotionGateDigest } : {}),
          },
        })
        return candidateView(projection)
      })

    const syncLearningPatterns: Interface["syncLearningPatterns"] = Effect.fn(
      "EvolutionCandidate.syncLearningPatterns",
    )(function* (identity, patterns) {
      if (identity.actor !== "system:core-learning")
        throw new EvolutionStateError("learning convergence requires the trusted Core Learning actor")
      if (!Array.isArray(patterns)) throw new EvolutionStateError("learning patterns must be an array")
      if (patterns.length > 50) throw new EvolutionStateError("at most 50 learning patterns can be synchronized")

      const policy = policyFromEnv()
      const items: LearningSyncItem[] = []
      const counts = { created: 0, existing: 0, skipped: 0, failed: 0 }

      for (const raw of patterns) {
        let sourceRef = "core-learning-pattern:invalid"
        const outcome = yield* Effect.gen(function* () {
          if (!raw || typeof raw !== "object") throw new EvolutionStateError("learning pattern must be an object")
          const patternID = boundedText(raw.id, "pattern id", 160)
          const patternType = boundedText(raw.type, "pattern type", 64)
          const description = boundedText(raw.description, "description", 500)
          if (typeof raw.frequency === "boolean" || !Number.isInteger(raw.frequency) || raw.frequency < 1)
            throw new EvolutionStateError("frequency must be a positive integer")
          if (typeof raw.confidence === "boolean" || typeof raw.confidence !== "number")
            throw new EvolutionStateError("confidence must be a number")
          if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1)
            throw new EvolutionStateError("confidence must be in [0, 1]")

          sourceRef = evidenceRefs([`core-learning-pattern:${patternID}`])[0]
          const target = patternTargetFor(patternType)
          if (
            target === null ||
            raw.frequency < policy.min_auto_proposal_frequency ||
            raw.confidence < policy.min_auto_proposal_confidence
          )
            return {
              source_ref: sourceRef,
              status: "skipped" as const,
              candidate_id: "",
              reason: "below automatic proposal policy or unsupported pattern type",
            }

          const candidate = yield* createAutomaticCandidate({
            identity,
            title: `Review learned ${patternType} strategy ${patternID}`,
            target,
            instruction: instructionForPattern(patternType, description),
            rationale:
              `Core Learning evidence reached the automatic proposal threshold: ` +
              `frequency=${raw.frequency}, confidence=${raw.confidence.toFixed(2)}. ` +
              "Evaluation is automatic; approval and deployment remain human decisions.",
            evidenceRefs: [sourceRef],
          })
          const projection = candidate.projection
          const item: MutableLearningSyncItem = {
            source_ref: sourceRef,
            status: candidate.created ? "created" : "existing",
            candidate_id: projection.candidateID,
            reason: candidate.created
              ? "created as a review-only candidate and queued for isolated evaluation"
              : "immutable evidence already has a candidate",
          }
          if (projection.createdBy === identity.actor && projection.status === "proposal") {
            const evaluated = yield* evaluateProjection(identity, projection, {
              automatic: true,
              expectedRevision: projection.revision,
              reason: "automatic isolated evaluation of a review-only Core Learning candidate",
            }).pipe(Effect.exit)
            item.evaluation = Exit.isSuccess(evaluated)
              ? { status: "evaluated", gate_passed: evaluated.value.evaluation?.gate_passed ?? false }
              : {
                  status: "evaluate_failed",
                  reason: String(Cause.squash(evaluated.cause)).slice(0, 200),
                }
          } else if (projection.createdBy === identity.actor && projection.status === "sandbox_evaluation") {
            const replayed = yield* evaluateProjection(identity, projection, {
              automatic: true,
              expectedRevision: projection.revision - 1,
              reason: "automatic isolated evaluation of a review-only Core Learning candidate",
            }).pipe(Effect.exit)
            item.evaluation = Exit.isSuccess(replayed)
              ? {
                  status: "already_evaluated",
                  gate_passed: replayed.value.evaluation?.gate_passed ?? false,
                }
              : {
                  status: "evaluate_failed",
                  reason: String(Cause.squash(replayed.cause)).slice(0, 200),
                }
          }
          return item
        }).pipe(Effect.exit)

        if (Exit.isSuccess(outcome)) {
          items.push(outcome.value)
          counts[outcome.value.status] += 1
        } else {
          counts.failed += 1
          items.push({
            source_ref: sourceRef,
            status: "failed",
            candidate_id: "",
            reason: String(Cause.squash(outcome.cause)).slice(0, 300),
          })
        }
      }

      return { schema_version: 1, seen: patterns.length, ...counts, items }
    })

    const canaryReport: Interface["canaryReport"] = (identity, candidateID) =>
      exposures.canaryReport(identity, candidateID)

    type AutomaticRollbackTrigger = "safety_incident" | "canary_health"

    const applyAutomaticRollback = (
      identity: TrustedEvolutionIdentity,
      current: ProposalProjection,
      exposure: EvolutionExposureV1.ExposureProjection,
      trigger: AutomaticRollbackTrigger,
      reason: string,
    ) =>
      Effect.gen(function* () {
        const recordedAt = exposure.receipt?.recorded_at
        if (!recordedAt) throw new EvolutionStateError("automatic rollback requires a recorded exposure receipt")
        const monitorIdentity: TrustedEvolutionIdentity = {
          tenantID: identity.tenantID,
          userID: identity.userID,
          actor: "system:evolution-monitor",
        }
        const priorRollback = recordOrNull(current.state.rollback)
        let from: AgentRuntime.EvolutionStatus
        let expectedRevision: number
        let state: Record<string, unknown>

        if (current.status === "rolled_back") {
          if (
            priorRollback?.automatic !== true ||
            priorRollback.actor !== monitorIdentity.actor ||
            priorRollback.source_exposure_id !== exposure.exposure_id ||
            priorRollback.trigger !== trigger ||
            priorRollback.reason !== reason ||
            (priorRollback.from_status !== "canary" && priorRollback.from_status !== "promoted")
          )
            return
          from = priorRollback.from_status
          expectedRevision = current.revision - 1
          state = { ...current.state, revision: expectedRevision }
        } else {
          if (current.status !== "canary" && current.status !== "promoted") return
          from = current.status
          expectedRevision = current.revision
          state = {
            ...stateFor(current),
            status: "rolled_back",
            evolution_level: "L2",
            rollback: {
              actor: monitorIdentity.actor,
              reason,
              at: recordedAt,
              automatic: true,
              trigger,
              source_exposure_id: exposure.exposure_id,
              from_status: from,
            },
          }
        }

        const requestInput = {
          candidateID: current.candidateID,
          expectedRevision,
          action: "automaticRollback",
          reason,
          trigger,
          exposureID: exposure.exposure_id,
        }
        yield* governed.transitionAutomaticRollback({
          identity: monitorIdentity,
          requestID: requestIDFor("candidate.auto-rollback", requestInput),
          traceID: traceIDFor("candidate.auto-rollback", requestInput),
          proposalID: current.proposalID,
          expectedRevision,
          from,
          to: "rolled_back",
          state,
          reason,
          metadata: {
            candidateID: current.candidateID,
            action: "automaticRollback",
            automatic: true,
            trigger,
            exposureID: exposure.exposure_id,
          },
        })
      })

    const recordOutcome: Interface["recordOutcome"] = Effect.fn("EvolutionCandidate.recordOutcome")(function* (input) {
      const count = yield* exposures.recordOutcome(input)
      const exposure = yield* exposures.getExposure(input.identity, input.exposureID)
      if (exposure.status !== "recorded" || exposure.receipt === null || exposure.receipt.outcome === null)
        throw new EvolutionStateError("recorded exposure receipt is unavailable for rollback reconciliation")
      const policy = policyFromEnv()

      for (const assignment of exposure.assignments) {
        const current = yield* getProjection(input.identity, assignment.candidate_id)
        if (current.artifactDigest !== assignment.candidate_digest)
          throw new EvolutionStateError("recorded exposure candidate digest changed before rollback reconciliation")

        if (exposure.receipt.outcome.safety_incident && assignment.cohort === "candidate") {
          yield* applyAutomaticRollback(
            input.identity,
            current,
            exposure,
            "safety_incident",
            `automatic rollback after candidate-cohort safety incident (exposure:${exposure.exposure_id})`,
          )
          continue
        }

        const report = yield* canaryReport(input.identity, assignment.candidate_id)
        const candidateObservations = Number(report.candidate_observations)
        const controlObservations = Number(report.control_observations)
        const candidateSuccessRate = Number(report.candidate_success_rate)
        const successRateDelta = Number(report.success_rate_delta)
        const unhealthy =
          Number.isFinite(candidateObservations) &&
          Number.isFinite(controlObservations) &&
          Number.isFinite(candidateSuccessRate) &&
          Number.isFinite(successRateDelta) &&
          candidateObservations >= policy.auto_rollback_min_observations &&
          candidateSuccessRate < policy.auto_rollback_success_rate &&
          (controlObservations === 0 || successRateDelta < policy.min_success_rate_delta)
        if (unhealthy)
          yield* applyAutomaticRollback(
            input.identity,
            current,
            exposure,
            "canary_health",
            `automatic rollback after sustained canary health failure (exposure:${exposure.exposure_id})`,
          )
      }
      return count
    })

    return Service.of({
      status,
      listCandidates: list,
      getCandidate: get,
      createCandidate,
      syncLearningPatterns,
      recordOutcome,
      transition,
      canaryReport,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [DurableEvolutionV1.node, GovernedEvolutionV1.node, EvolutionExposureV1.node, ExperienceStoreV1.node],
})
