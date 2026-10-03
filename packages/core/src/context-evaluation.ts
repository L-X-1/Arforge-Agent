export * as ContextEvaluation from "./context-evaluation"

import * as ContextPackage from "./context-package"

export type Dataset = {
  readonly id: string
  readonly revision: string
  readonly source: "external" | "recorded"
  readonly queryIDs: ReadonlyArray<string>
}

export type Citation = { readonly evidenceID: string }

export type Observation = {
  readonly dataset: Dataset
  readonly package: ContextPackage.Package
  readonly requiredEvidenceIDs: ReadonlyArray<string>
  readonly relevantUnitIDs?: ReadonlyArray<string>
  readonly citations?: ReadonlyArray<Citation>
  readonly topK: number
  readonly latencyMs: number
  readonly costMinor?: number
  readonly taskSuccess?: number
}

export type Metric = {
  readonly value: number
  readonly numerator?: number
  readonly denominator?: number
  readonly applicable: boolean
}

export interface Metrics {
  readonly requiredEvidenceRecallAtK: Metric
  readonly irrelevantTokenRatio: Metric
  readonly citationCoverage: Metric
  readonly instructionContaminationRate: Metric
  readonly protectedFactRetention: Metric
  readonly contextBuildLatencyMs: Metric
  readonly inputTokens: Metric
  readonly costMinor: Metric
  readonly taskSuccess?: Metric
}

export interface Snapshot {
  readonly kind: "baseline" | "candidate"
  readonly packageDigest: string
  readonly dataset: Dataset
  readonly metrics: Metrics
}

export interface PromotionThresholds {
  readonly minRequiredEvidenceRecallAtK?: number
  readonly maxIrrelevantTokenRatioIncrease?: number
  readonly minCitationCoverage?: number
  readonly maxInstructionContaminationRate?: number
  readonly minProtectedFactRetention?: number
  readonly maxContextBuildLatencyIncreaseMs?: number
  readonly maxCostIncreaseMinor?: number
  readonly minTaskSuccessDelta?: number
}

export interface Comparison {
  readonly baseline: Snapshot
  readonly candidate?: Snapshot
  readonly deltas?: Partial<Record<keyof Metrics, number | undefined>>
  readonly promotion: "not-evaluated" | "promoted" | "rejected"
  readonly reasons: ReadonlyArray<string>
}

export class EvaluationError extends Error {
  readonly _tag = "Context.EvaluationError"
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new EvaluationError(`${name} must be finite and non-negative`)
  return value
}

const fraction = (numerator: number, denominator: number): Metric => ({
  value: denominator === 0 ? 0 : numerator / denominator,
  numerator,
  denominator,
  applicable: denominator > 0,
})

const selectedEntries = (value: ContextPackage.Package) => {
  const manifest = new Map(value.manifest.map((entry) => [entry.unitID, entry]))
  return value.messages.map((message) => manifest.get(message.unitID)).filter((entry): entry is ContextPackage.ManifestEntry => entry !== undefined)
}

const validateDataset = (dataset: Dataset): Dataset => {
  if (!dataset.id.trim() || !dataset.revision.trim()) throw new EvaluationError("dataset id and revision are required")
  if (dataset.source !== "external" && dataset.source !== "recorded") throw new EvaluationError("dataset source is not evaluable")
  if (dataset.queryIDs.length === 0) throw new EvaluationError("dataset must contain query IDs")
  return dataset
}

const metricDelta = (candidate: Metric | undefined, baseline: Metric | undefined): number | undefined =>
  candidate === undefined || baseline === undefined ? undefined : candidate.value - baseline.value

export function evaluate(input: Observation, kind: Snapshot["kind"] = "baseline"): Snapshot {
  const dataset = validateDataset(input.dataset)
  const topK = Math.max(0, Math.floor(finite(input.topK, "topK")))
  const latencyMs = finite(input.latencyMs, "latencyMs")
  const costMinor = input.costMinor === undefined ? undefined : finite(input.costMinor, "costMinor")
  const taskSuccess = input.taskSuccess === undefined ? undefined : finite(input.taskSuccess, "taskSuccess")
  if (taskSuccess !== undefined && taskSuccess > 1) throw new EvaluationError("taskSuccess must be in [0, 1]")
  const selected = selectedEntries(input.package)
  const top = selected.slice(0, topK)
  const required = new Set(input.requiredEvidenceIDs)
  const topEvidence = new Set(top.flatMap((entry) => (entry.evidenceID === undefined ? [] : [entry.evidenceID])))
  const relevant = input.relevantUnitIDs === undefined ? undefined : new Set(input.relevantUnitIDs)
  const relevantTokens = relevant === undefined ? 0 : selected.filter((entry) => relevant.has(entry.unitID)).reduce((sum, entry) => sum + entry.tokens, 0)
  const contaminated = selected.filter((entry) => entry.instructionAllowed === true && entry.trust !== "trusted").length
  const protectedCoverage = input.package.protectedFactCoverage
  const citations = new Set((input.citations ?? []).map((citation) => citation.evidenceID))
  const metrics: Metrics = {
    requiredEvidenceRecallAtK: fraction([...required].filter((id) => topEvidence.has(id)).length, required.size),
    irrelevantTokenRatio: relevant === undefined ? { value: 0, applicable: false } : fraction(input.package.usedInputTokens - relevantTokens, input.package.usedInputTokens),
    citationCoverage: fraction([...required].filter((id) => citations.has(id)).length, required.size),
    instructionContaminationRate: fraction(contaminated, selected.length),
    protectedFactRetention: fraction(protectedCoverage.present.length, protectedCoverage.required.length),
    contextBuildLatencyMs: { value: latencyMs, applicable: true },
    inputTokens: { value: input.package.usedInputTokens, applicable: true },
    costMinor: { value: costMinor ?? 0, applicable: costMinor !== undefined },
    ...(taskSuccess === undefined ? {} : { taskSuccess: { value: taskSuccess, applicable: true } }),
  }
  return Object.freeze({ kind, packageDigest: input.package.digest, dataset, metrics: Object.freeze(metrics) })
}

const thresholdNumber = (value: number | undefined, name: string): number | undefined =>
  value === undefined ? undefined : finite(value, name)

export function compare(
  baselineInput: Observation,
  candidateInput?: Observation,
  thresholds?: PromotionThresholds,
): Comparison {
  const baseline = evaluate(baselineInput, "baseline")
  if (candidateInput === undefined) return Object.freeze({ baseline, promotion: "not-evaluated", reasons: Object.freeze(["candidate is not provided"]) })
  if (baseline.dataset.id !== candidateInput.dataset.id || baseline.dataset.revision !== candidateInput.dataset.revision)
    throw new EvaluationError("baseline and candidate dataset must match")
  const candidate = evaluate(candidateInput, "candidate")
  if (thresholds === undefined)
    return Object.freeze({ baseline, candidate, promotion: "not-evaluated", reasons: Object.freeze(["promotion thresholds are not provided"]) })

  const deltas: Partial<Record<keyof Metrics, number | undefined>> = {
    requiredEvidenceRecallAtK: metricDelta(candidate.metrics.requiredEvidenceRecallAtK, baseline.metrics.requiredEvidenceRecallAtK),
    irrelevantTokenRatio: metricDelta(candidate.metrics.irrelevantTokenRatio, baseline.metrics.irrelevantTokenRatio),
    citationCoverage: metricDelta(candidate.metrics.citationCoverage, baseline.metrics.citationCoverage),
    instructionContaminationRate: metricDelta(candidate.metrics.instructionContaminationRate, baseline.metrics.instructionContaminationRate),
    protectedFactRetention: metricDelta(candidate.metrics.protectedFactRetention, baseline.metrics.protectedFactRetention),
    contextBuildLatencyMs: metricDelta(candidate.metrics.contextBuildLatencyMs, baseline.metrics.contextBuildLatencyMs),
    inputTokens: metricDelta(candidate.metrics.inputTokens, baseline.metrics.inputTokens),
    costMinor: metricDelta(candidate.metrics.costMinor, baseline.metrics.costMinor),
    taskSuccess: metricDelta(candidate.metrics.taskSuccess, baseline.metrics.taskSuccess),
  }
  const reasons: string[] = []
  const minRecall = thresholdNumber(thresholds.minRequiredEvidenceRecallAtK, "minRequiredEvidenceRecallAtK")
  if (minRecall !== undefined && candidate.metrics.requiredEvidenceRecallAtK.value < minRecall) reasons.push("required evidence recall is below threshold")
  const maxIrrelevant = thresholdNumber(thresholds.maxIrrelevantTokenRatioIncrease, "maxIrrelevantTokenRatioIncrease")
  if (maxIrrelevant !== undefined && (deltas.irrelevantTokenRatio ?? 0) > maxIrrelevant) reasons.push("irrelevant token ratio regressed")
  const minCitation = thresholdNumber(thresholds.minCitationCoverage, "minCitationCoverage")
  if (minCitation !== undefined && candidate.metrics.citationCoverage.value < minCitation) reasons.push("citation coverage is below threshold")
  const maxContamination = thresholdNumber(thresholds.maxInstructionContaminationRate, "maxInstructionContaminationRate")
  if (maxContamination !== undefined && candidate.metrics.instructionContaminationRate.value > maxContamination) reasons.push("instruction contamination exceeds threshold")
  const minProtected = thresholdNumber(thresholds.minProtectedFactRetention, "minProtectedFactRetention")
  if (minProtected !== undefined && candidate.metrics.protectedFactRetention.value < minProtected) reasons.push("protected fact retention is below threshold")
  const maxLatency = thresholdNumber(thresholds.maxContextBuildLatencyIncreaseMs, "maxContextBuildLatencyIncreaseMs")
  if (maxLatency !== undefined && (deltas.contextBuildLatencyMs ?? 0) > maxLatency) reasons.push("context build latency regressed")
  const maxCost = thresholdNumber(thresholds.maxCostIncreaseMinor, "maxCostIncreaseMinor")
  if (maxCost !== undefined && (deltas.costMinor ?? 0) > maxCost) reasons.push("cost regressed")
  const minSuccess = thresholds.minTaskSuccessDelta
  if (minSuccess !== undefined) {
    finite(minSuccess, "minTaskSuccessDelta")
    if ((deltas.taskSuccess ?? Number.NEGATIVE_INFINITY) < minSuccess) reasons.push("task success delta is below threshold")
  }
  return Object.freeze({
    baseline,
    candidate,
    deltas: Object.freeze(deltas),
    promotion: reasons.length === 0 ? "promoted" : "rejected",
    reasons: Object.freeze(reasons),
  })
}
