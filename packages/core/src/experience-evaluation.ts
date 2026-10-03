export * as ExperienceEvaluationV2 from "./experience-evaluation"

import { canonicalHash } from "./util/canonical-hash"

export type ExperienceVariant = "without_experience" | "candidate_experience" | "active_experience"

export interface Dataset {
  readonly id: string
  readonly revision: string
  readonly source: "external" | "recorded"
  readonly caseIDs: ReadonlyArray<string>
}

export interface ReplayCase {
  readonly caseID: string
  readonly success: boolean
  readonly steps: number
  readonly tokens: number
  readonly costMinor: number
  readonly newFailures: number
}

export interface ReplayObservation {
  readonly dataset: Dataset
  readonly variant: ExperienceVariant
  readonly experienceDigest?: string
  readonly cases: ReadonlyArray<ReplayCase>
}

export interface Metric {
  readonly value: number
  readonly numerator?: number
  readonly denominator?: number
  readonly applicable: boolean
}

export interface Metrics {
  readonly sampleSize: number
  readonly successRate: Metric
  readonly averageSteps: Metric
  readonly averageTokens: Metric
  readonly averageCostMinor: Metric
  readonly newFailureCount: Metric
  readonly newFailureRate: Metric
}

export interface Snapshot {
  readonly variant: ExperienceVariant
  readonly experienceDigest?: string
  readonly dataset: Dataset
  readonly metrics: Metrics
  readonly replayDigest: string
}

export interface MetricDeltas {
  readonly successRate: number
  readonly averageSteps: number
  readonly averageTokens: number
  readonly averageCostMinor: number
  readonly newFailureCount: number
  readonly newFailureRate: number
}

export interface Comparison {
  readonly withoutExperience: Snapshot
  readonly candidateExperience: Snapshot
  readonly activeExperience: Snapshot
  readonly candidateVsWithout: MetricDeltas
  readonly activeVsWithout: MetricDeltas
  readonly candidateVsActive: MetricDeltas
  readonly interpretation: "observational_correlation_only"
  readonly note: string
}

export class ExperienceEvaluationError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "ExperienceEvaluationError"
  }
}

const digestPattern = /^[a-f0-9]{64}$/i
const finiteNonNegative = (value: number, name: string) => {
  if (!Number.isFinite(value) || value < 0)
    throw new ExperienceEvaluationError(`${name} must be finite and non-negative`)
  return value
}

const normalizeDataset = (dataset: Dataset): Dataset => {
  const id = dataset.id.trim()
  const revision = dataset.revision.trim()
  const caseIDs = [...new Set(dataset.caseIDs.map((caseID) => caseID.trim()).filter(Boolean))]
  if (!id || !revision) throw new ExperienceEvaluationError("dataset id and revision are required")
  if (dataset.source !== "external" && dataset.source !== "recorded")
    throw new ExperienceEvaluationError("dataset source is not evaluable")
  if (caseIDs.length === 0) throw new ExperienceEvaluationError("dataset must contain case IDs")
  if (caseIDs.length !== dataset.caseIDs.length) throw new ExperienceEvaluationError("dataset case IDs must be unique")
  return { id, revision, source: dataset.source, caseIDs }
}

const normalizeCases = (cases: ReadonlyArray<ReplayCase>, dataset: Dataset): ReadonlyArray<ReplayCase> => {
  if (cases.length !== dataset.caseIDs.length)
    throw new ExperienceEvaluationError("replay must cover every dataset case exactly once")
  const expected = new Set(dataset.caseIDs)
  const seen = new Set<string>()
  const normalized = cases.map((value) => {
    const caseID = value.caseID.trim()
    if (!caseID || !expected.has(caseID) || seen.has(caseID))
      throw new ExperienceEvaluationError(`replay case is missing, unknown, or duplicated: ${caseID}`)
    seen.add(caseID)
    return {
      caseID,
      success: value.success,
      steps: finiteNonNegative(value.steps, "steps"),
      tokens: finiteNonNegative(value.tokens, "tokens"),
      costMinor: finiteNonNegative(value.costMinor, "costMinor"),
      newFailures: finiteNonNegative(value.newFailures, "newFailures"),
    }
  })
  if (seen.size !== expected.size) throw new ExperienceEvaluationError("replay must cover every dataset case")
  return normalized.toSorted((left, right) => left.caseID.localeCompare(right.caseID))
}

const average = (values: ReadonlyArray<number>): Metric => ({
  value: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
  denominator: values.length,
  applicable: values.length > 0,
})

const rate = (numerator: number, denominator: number): Metric => ({
  value: denominator === 0 ? 0 : numerator / denominator,
  numerator,
  denominator,
  applicable: denominator > 0,
})

const metricDeltas = (left: Snapshot, right: Snapshot): MetricDeltas => ({
  successRate: left.metrics.successRate.value - right.metrics.successRate.value,
  averageSteps: left.metrics.averageSteps.value - right.metrics.averageSteps.value,
  averageTokens: left.metrics.averageTokens.value - right.metrics.averageTokens.value,
  averageCostMinor: left.metrics.averageCostMinor.value - right.metrics.averageCostMinor.value,
  newFailureCount: left.metrics.newFailureCount.value - right.metrics.newFailureCount.value,
  newFailureRate: left.metrics.newFailureRate.value - right.metrics.newFailureRate.value,
})

export function evaluate(input: ReplayObservation): Snapshot {
  const dataset = normalizeDataset(input.dataset)
  if (
    input.variant !== "without_experience" &&
    input.variant !== "candidate_experience" &&
    input.variant !== "active_experience"
  )
    throw new ExperienceEvaluationError("replay variant is not evaluable")
  if (input.variant === "without_experience" && input.experienceDigest !== undefined)
    throw new ExperienceEvaluationError("without_experience must not carry an experience digest")
  if (
    input.variant !== "without_experience" &&
    (!input.experienceDigest || !digestPattern.test(input.experienceDigest))
  )
    throw new ExperienceEvaluationError("experience variants require a 64-character immutable digest")
  const cases = normalizeCases(input.cases, dataset)
  const successCount = cases.filter((value) => value.success).length
  const newFailureCount = cases.reduce((sum, value) => sum + value.newFailures, 0)
  const newFailureCases = cases.filter((value) => value.newFailures > 0).length
  const replayDigest = canonicalHash({
    dataset,
    variant: input.variant,
    experienceDigest: input.experienceDigest,
    cases,
  })
  if (!replayDigest) throw new ExperienceEvaluationError("replay is not canonicalizable")
  return Object.freeze({
    variant: input.variant,
    ...(input.experienceDigest === undefined ? {} : { experienceDigest: input.experienceDigest.toLowerCase() }),
    dataset,
    metrics: {
      sampleSize: cases.length,
      successRate: rate(successCount, cases.length),
      averageSteps: average(cases.map((value) => value.steps)),
      averageTokens: average(cases.map((value) => value.tokens)),
      averageCostMinor: average(cases.map((value) => value.costMinor)),
      newFailureCount: {
        value: newFailureCount,
        numerator: newFailureCount,
        denominator: cases.length,
        applicable: cases.length > 0,
      },
      newFailureRate: rate(newFailureCases, cases.length),
    },
    replayDigest,
  })
}

export function compare(inputs: ReadonlyArray<ReplayObservation>): Comparison {
  if (inputs.length !== 3)
    throw new ExperienceEvaluationError("experience evaluation requires exactly three replay variants")
  const snapshots = inputs.map(evaluate)
  const byVariant = new Map(snapshots.map((snapshot) => [snapshot.variant, snapshot]))
  if (byVariant.size !== 3) throw new ExperienceEvaluationError("each replay variant must be provided exactly once")
  const withoutExperience = byVariant.get("without_experience")
  const candidateExperience = byVariant.get("candidate_experience")
  const activeExperience = byVariant.get("active_experience")
  if (!withoutExperience || !candidateExperience || !activeExperience)
    throw new ExperienceEvaluationError("without, candidate, and active experience replays are required")
  for (const snapshot of [candidateExperience, activeExperience]) {
    if (
      snapshot.dataset.id !== withoutExperience.dataset.id ||
      snapshot.dataset.revision !== withoutExperience.dataset.revision ||
      snapshot.dataset.source !== withoutExperience.dataset.source ||
      snapshot.dataset.caseIDs.join("\u0000") !== withoutExperience.dataset.caseIDs.join("\u0000")
    )
      throw new ExperienceEvaluationError("all replay variants must use the same dataset")
  }
  return Object.freeze({
    withoutExperience,
    candidateExperience,
    activeExperience,
    candidateVsWithout: metricDeltas(candidateExperience, withoutExperience),
    activeVsWithout: metricDeltas(activeExperience, withoutExperience),
    candidateVsActive: metricDeltas(candidateExperience, activeExperience),
    interpretation: "observational_correlation_only",
    note: "Replay deltas are observational experiment results, not randomized causal proof.",
  })
}
