import * as Evaluation from "@arforge-ai/schema/memory-evaluation"

export type Observation = {
  readonly dataset: Evaluation.Dataset
  readonly topK: number
  readonly queries: ReadonlyArray<Evaluation.QueryCase>
}

export type Thresholds = {
  readonly minRecallAtK?: number
  readonly minMeanReciprocalRank?: number
  readonly maxFalseRecallRate?: number
  readonly maxCrossScopeLeakRate?: number
  readonly maxStaleRecallRate?: number
  readonly maxConflictingRecallRate?: number
  readonly minDeletionPropagationRate?: number
  readonly minForgetPropagationRate?: number
  readonly maxPromptInjectionContaminationRate?: number
  readonly maxLatencyIncreaseMs?: number
  readonly maxCostIncreaseMinor?: number
  readonly minDownstreamTaskDelta?: number
}

export type Comparison = {
  readonly baseline: Evaluation.Snapshot
  readonly candidate?: Evaluation.Snapshot
  readonly promotion: "not-evaluated" | "promoted" | "rejected"
  readonly reasons: ReadonlyArray<string>
}

const measured = (numerator: number, denominator: number, note: string): Evaluation.Metric => ({
  status: "measured",
  value: denominator === 0 ? 0 : numerator / denominator,
  numerator,
  denominator,
  note,
})

const average = (values: ReadonlyArray<number>, measuredNote: string, missingNote: string): Evaluation.Metric =>
  values.length === 0
    ? { status: "not_measured", note: missingNote }
    : {
        status: "measured",
        value: values.reduce((sum, value) => sum + value, 0) / values.length,
        note: measuredNote,
      }

const optionalRate = (
  queries: ReadonlyArray<Evaluation.QueryCase>,
  select: (query: Evaluation.QueryCase) => ReadonlyArray<string> | undefined,
  note: string,
): Evaluation.Metric => {
  const present = queries.flatMap((query) => select(query) ?? [])
  if (!queries.some((query) => select(query) !== undefined)) return { status: "not_measured", note }
  return measured(present.length, queries.reduce((sum, query) => sum + query.retrievedIDs.length, 0), note)
}

const propagation = (
  queries: ReadonlyArray<Evaluation.QueryCase>,
  select: (query: Evaluation.QueryCase) => ReadonlyArray<string> | undefined,
  note: string,
): Evaluation.Metric => {
  const expected = queries.flatMap((query) => select(query) ?? [])
  if (!queries.some((query) => select(query) !== undefined)) return { status: "not_measured", note }
  const retrieved = new Set(queries.flatMap((query) => query.retrievedIDs))
  return measured(expected.filter((id) => !retrieved.has(id)).length, expected.length, note)
}

export const evaluate = (input: Observation, kind: Evaluation.Snapshot["kind"] = "baseline"): Evaluation.Snapshot => {
  if (!input.dataset.id.trim() || !input.dataset.revision.trim()) throw new Error("dataset id and revision are required")
  if (input.dataset.source !== "external" && input.dataset.source !== "recorded") throw new Error("dataset source is not evaluable")
  if (input.queries.length === 0) throw new Error("evaluation requires query cases")
  if (input.topK < 0 || !Number.isFinite(input.topK)) throw new Error("topK must be finite and non-negative")
  const topK = Math.floor(input.topK)
  const queries = input.queries.map((query) => ({ ...query, retrievedIDs: query.retrievedIDs.slice(0, topK) }))
  const relevantTotal = queries.reduce((sum, query) => sum + new Set(query.relevantIDs).size, 0)
  const retrievedRelevant = queries.reduce(
    (sum, query) => sum + query.retrievedIDs.filter((id) => query.relevantIDs.includes(id)).length,
    0,
  )
  const reciprocalRanks = queries.map((query) => {
    const relevant = new Set(query.relevantIDs)
    const index = query.retrievedIDs.findIndex((id) => relevant.has(id))
    return index < 0 ? 0 : 1 / (index + 1)
  })
  const falseRetrieved = queries.reduce(
    (sum, query) => sum + query.retrievedIDs.filter((id) => !query.relevantIDs.includes(id)).length,
    0,
  )
  const retrievedTotal = queries.reduce((sum, query) => sum + query.retrievedIDs.length, 0)
  const metrics: Evaluation.Metrics = {
    recallAtK: measured(retrievedRelevant, relevantTotal, "Relevant retrieved IDs divided by all positive qrels."),
    meanReciprocalRank: average(reciprocalRanks, "Mean reciprocal rank over query cases.", "Query cases were not provided."),
    falseRecallRate: measured(falseRetrieved, retrievedTotal, "Retrieved IDs not present in positive qrels."),
    crossScopeLeakRate: optionalRate(queries, (query) => query.scopeLeakIDs, "Scope annotations were not provided."),
    staleRecallRate: optionalRate(queries, (query) => query.staleIDs, "Stale lifecycle annotations were not provided."),
    conflictingRecallRate: optionalRate(queries, (query) => query.conflictingIDs, "Conflict annotations were not provided."),
    deletionPropagationRate: propagation(queries, (query) => query.deletedIDs, "Deletion propagation cases were not provided."),
    forgetPropagationRate: propagation(queries, (query) => query.forgottenIDs, "Forget propagation cases were not provided."),
    promptInjectionContaminationRate: optionalRate(queries, (query) => query.contaminatedIDs, "Prompt-injection annotations were not provided."),
    latencyMs: average(
      queries.flatMap((query) => (query.latencyMs === undefined ? [] : [query.latencyMs])),
      "Mean per-query latency in milliseconds.",
      "Per-query latency annotations were not provided.",
    ),
    inputTokens: average(
      queries.flatMap((query) => (query.inputTokens === undefined ? [] : [query.inputTokens])),
      "Mean per-query input tokens.",
      "Per-query token usage was not provided.",
    ),
    costMinor: average(
      queries.flatMap((query) => (query.costMinor === undefined ? [] : [query.costMinor])),
      "Mean per-query cost in minor currency units.",
      "Per-query cost was not provided.",
    ),
    downstreamTaskDelta: average(
      queries.flatMap((query) => (query.downstreamTaskDelta === undefined ? [] : [query.downstreamTaskDelta])),
      "Mean downstream task delta.",
      "Downstream task outcomes were not provided.",
    ),
  }
  return { kind, dataset: input.dataset, topK, metrics }
}

const check = (value: number | undefined, name: string, test: (value: number) => boolean, reasons: string[]) => {
  if (value !== undefined && !Number.isFinite(value)) throw new Error(`${name} must be finite`)
  if (value !== undefined && !test(value)) reasons.push(name)
}

export const compare = (baselineInput: Observation, candidateInput?: Observation, thresholds?: Thresholds): Comparison => {
  const baseline = evaluate(baselineInput, "baseline")
  if (candidateInput === undefined) return { baseline, promotion: "not-evaluated", reasons: ["candidate is not provided"] }
  if (baseline.dataset.id !== candidateInput.dataset.id || baseline.dataset.revision !== candidateInput.dataset.revision)
    throw new Error("baseline and candidate dataset must match")
  const candidate = evaluate(candidateInput, "candidate")
  if (thresholds === undefined) return { baseline, candidate, promotion: "not-evaluated", reasons: ["thresholds are not provided"] }
  const reasons: string[] = []
  const b = baseline.metrics
  const c = candidate.metrics
  check(thresholds.minRecallAtK, "minRecallAtK", (value) => c.recallAtK.value !== undefined && c.recallAtK.value >= value, reasons)
  check(thresholds.minMeanReciprocalRank, "minMeanReciprocalRank", (value) => c.meanReciprocalRank.value !== undefined && c.meanReciprocalRank.value >= value, reasons)
  check(thresholds.maxFalseRecallRate, "maxFalseRecallRate", (value) => c.falseRecallRate.value !== undefined && c.falseRecallRate.value <= value, reasons)
  check(thresholds.maxCrossScopeLeakRate, "maxCrossScopeLeakRate", (value) => c.crossScopeLeakRate.value !== undefined && c.crossScopeLeakRate.value <= value, reasons)
  check(thresholds.maxStaleRecallRate, "maxStaleRecallRate", (value) => c.staleRecallRate.value !== undefined && c.staleRecallRate.value <= value, reasons)
  check(thresholds.maxConflictingRecallRate, "maxConflictingRecallRate", (value) => c.conflictingRecallRate.value !== undefined && c.conflictingRecallRate.value <= value, reasons)
  check(thresholds.minDeletionPropagationRate, "minDeletionPropagationRate", (value) => c.deletionPropagationRate.value !== undefined && c.deletionPropagationRate.value >= value, reasons)
  check(thresholds.minForgetPropagationRate, "minForgetPropagationRate", (value) => c.forgetPropagationRate.value !== undefined && c.forgetPropagationRate.value >= value, reasons)
  check(thresholds.maxPromptInjectionContaminationRate, "maxPromptInjectionContaminationRate", (value) => c.promptInjectionContaminationRate.value !== undefined && c.promptInjectionContaminationRate.value <= value, reasons)
  if (thresholds.maxLatencyIncreaseMs !== undefined) {
    if (c.latencyMs.value === undefined || b.latencyMs.value === undefined) reasons.push("maxLatencyIncreaseMs:not_measured")
    else if (c.latencyMs.value - b.latencyMs.value > thresholds.maxLatencyIncreaseMs) reasons.push("maxLatencyIncreaseMs")
  }
  if (thresholds.maxCostIncreaseMinor !== undefined) {
    if (c.costMinor.value === undefined || b.costMinor.value === undefined) reasons.push("maxCostIncreaseMinor:not_measured")
    else if (c.costMinor.value - b.costMinor.value > thresholds.maxCostIncreaseMinor) reasons.push("maxCostIncreaseMinor")
  }
  if (thresholds.minDownstreamTaskDelta !== undefined) {
    if (c.downstreamTaskDelta.value === undefined) reasons.push("minDownstreamTaskDelta:not_measured")
    else if (c.downstreamTaskDelta.value < thresholds.minDownstreamTaskDelta) reasons.push("minDownstreamTaskDelta")
  }
  return { baseline, candidate, promotion: reasons.length === 0 ? "promoted" : "rejected", reasons }
}
