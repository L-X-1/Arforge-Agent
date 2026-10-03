/**
 * Multi-agent scheduling benefit gate.
 *
 * This module is deliberately pure.  A model may suggest a decomposition, but
 * only structured task facts, immutable benchmark evidence, and an explicitly
 * supplied promotion policy can authorize execution in multi-agent mode.
 * Missing evidence or policy is a candidate for measurement, never an
 * automatic split.
 */

import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { WorkflowDefinition } from "../analysis/workflow-graph"
import { canonicalHash } from "../util/canonical-hash"

export const MULTI_AGENT_SCHEDULING_SCHEMA_VERSION = 1 as const
export const MULTI_AGENT_SCHEDULING_POLICY_VERSION = "multi-agent-benefit-v1"

export type MultiAgentSplitReason =
  | "independent-read"
  | "specialized-tool-isolation"
  | "risk-isolation"
  | "long-context-isolation"
  | "independent-dag-node"

export type MultiAgentGateAction = "single" | "candidate" | "multi"

export interface MultiAgentSchedulingTask {
  readonly id: string
  readonly kind: WorkflowDefinition["steps"][number]["kind"]
  readonly access: "read" | "write"
  readonly dependsOn: ReadonlyArray<string>
  readonly requiredTools?: ReadonlyArray<string>
  readonly riskTier?: AgentRuntime.RiskTier
  readonly contextTokens?: number
}

export interface MultiAgentSplitSignals {
  /** These are trusted, structured planner facts, not free-form model text. */
  readonly specializedToolIsolation?: boolean
  readonly riskIsolation?: boolean
  readonly longContextIsolation?: boolean
}

export interface MultiAgentSchedulingRequest {
  readonly requestedParallelism: number
  readonly tasks: ReadonlyArray<MultiAgentSchedulingTask>
  readonly signals?: MultiAgentSplitSignals
}

export interface MultiAgentExecutionMetrics {
  /** Aggregate metrics over one fixed dataset, not a single arbitrary run. */
  readonly sampleSize: number
  readonly succeeded: number
  readonly totalDurationMs: number
  readonly totalTokens: number
  readonly totalCostMinor: number
  readonly conflicts: number
}

export interface MultiAgentMetricSummary {
  readonly sampleSize: number
  readonly successRate: number
  readonly meanDurationMs: number
  readonly meanTokens: number
  readonly meanCostMinor: number
  readonly conflictRate: number
}

export interface MultiAgentBenefitEvidence {
  readonly schemaVersion: typeof MULTI_AGENT_SCHEDULING_SCHEMA_VERSION
  readonly datasetDigest: string
  readonly suiteID: string
  readonly suiteRevision: number
  readonly requestDigest: string
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly baseline: MultiAgentExecutionMetrics
  readonly multi: MultiAgentExecutionMetrics
  readonly source: "recorded" | "replay" | "live"
}

/**
 * Thresholds are intentionally caller-supplied.  The V2 plan forbids
 * inventing a universal success/cost threshold before a fixed baseline is
 * measured and approved by the product/engineering owner.
 */
export interface MultiAgentBenefitPolicy {
  readonly revision: string
  readonly minSamples: number
  readonly maxSuccessRegression: number
  readonly maxDurationRatio: number
  readonly maxTokenRatio: number
  readonly maxCostRatio: number
  readonly maxConflictRateDelta: number
}

export interface MultiAgentBenefitComparison {
  readonly baseline: MultiAgentMetricSummary
  readonly multi: MultiAgentMetricSummary
  readonly successRateDelta: number
  readonly durationRatio: number
  readonly tokenRatio: number
  readonly costRatio: number
  readonly conflictRateDelta: number
}

export interface MultiAgentGateDecision {
  readonly schemaVersion: typeof MULTI_AGENT_SCHEDULING_SCHEMA_VERSION
  readonly action: MultiAgentGateAction
  /** Whether the caller may actually execute multiple child runs. */
  readonly executeMode: "single" | "multi"
  readonly eligible: boolean
  readonly reasons: ReadonlyArray<MultiAgentSplitReason>
  readonly requestDigest: string
  readonly evidenceDigest?: string
  readonly policyRevision?: string
  readonly comparison?: MultiAgentBenefitComparison
  readonly failedChecks: ReadonlyArray<string>
  readonly reason: string
  readonly decisionDigest: string
}

const digestPattern = /^[a-f0-9]{64}$/i

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0
const safeCount = (value: number) => Number.isSafeInteger(value) && value >= 0

const sortedUnique = (values: ReadonlyArray<string>) => [...new Set(values)].toSorted()

const normalizeRequest = (request: MultiAgentSchedulingRequest) => ({
  requestedParallelism: request.requestedParallelism,
  tasks: request.tasks.map((task) => ({
    id: task.id,
    kind: task.kind,
    access: task.access,
    dependsOn: sortedUnique(task.dependsOn),
    ...(task.requiredTools === undefined ? {} : { requiredTools: sortedUnique(task.requiredTools) }),
    ...(task.riskTier === undefined ? {} : { riskTier: task.riskTier }),
    ...(task.contextTokens === undefined ? {} : { contextTokens: task.contextTokens }),
  })),
  ...(request.signals === undefined
    ? {}
    : {
        signals: {
          specializedToolIsolation: request.signals.specializedToolIsolation === true,
          riskIsolation: request.signals.riskIsolation === true,
          longContextIsolation: request.signals.longContextIsolation === true,
        },
      }),
})

export const schedulingRequestDigest = (request: MultiAgentSchedulingRequest): string =>
  canonicalHash(normalizeRequest(request)) ?? ""

export const benefitEvidenceDigest = (evidence: MultiAgentBenefitEvidence): string =>
  canonicalHash({
    schemaVersion: evidence.schemaVersion,
    datasetDigest: evidence.datasetDigest,
    suiteID: evidence.suiteID,
    suiteRevision: evidence.suiteRevision,
    requestDigest: evidence.requestDigest,
    evidenceIDs: sortedUnique(evidence.evidenceIDs.map(String)),
    baseline: evidence.baseline,
    multi: evidence.multi,
    source: evidence.source,
  }) ?? ""

const invalidRequest = (request: MultiAgentSchedulingRequest): ReadonlyArray<string> => {
  const errors: string[] = []
  if (!Number.isSafeInteger(request.requestedParallelism) || request.requestedParallelism < 1)
    errors.push("requested parallelism must be a positive safe integer")
  if (request.tasks.length > 64) errors.push("scheduling request exceeds the 64-task bound")
  const ids = new Set<string>()
  for (const task of request.tasks) {
    if (!task.id.trim()) errors.push("task IDs must be non-empty")
    if (ids.has(task.id)) errors.push(`duplicate task ID: ${task.id}`)
    ids.add(task.id)
    if (!Number.isSafeInteger(task.contextTokens ?? 0) || (task.contextTokens ?? 0) < 0)
      errors.push(`invalid context token estimate for task ${task.id}`)
    if (task.requiredTools?.some((tool) => !tool.trim())) errors.push(`empty required tool for task ${task.id}`)
  }
  for (const task of request.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) errors.push(`task ${task.id} depends on unknown task ${dependency}`)
    }
  }
  if (dependencyCycle(request)) errors.push("task dependency graph must be acyclic")
  return [...new Set(errors)]
}

const dependencyCycle = (request: MultiAgentSchedulingRequest) => {
  const dependencies = new Map(request.tasks.map((task) => [task.id, task.dependsOn]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const dependency of dependencies.get(id) ?? []) {
      if (visit(dependency)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return request.tasks.some((task) => visit(task.id))
}

const dependsTransitively = (
  dependencies: ReadonlyMap<string, ReadonlyArray<string>>,
  taskID: string,
  dependencyID: string,
) => {
  const pending = [...(dependencies.get(taskID) ?? [])]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === dependencyID) return true
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...(dependencies.get(current) ?? []))
  }
  return false
}

/** A DAG is splittable when it contains at least one pair of incomparable tasks. */
const hasIndependentTaskPair = (request: MultiAgentSchedulingRequest) => {
  const dependencies = new Map(request.tasks.map((task) => [task.id, task.dependsOn]))
  for (let left = 0; left < request.tasks.length; left += 1) {
    for (let right = left + 1; right < request.tasks.length; right += 1) {
      const leftID = request.tasks[left]!.id
      const rightID = request.tasks[right]!.id
      if (!dependsTransitively(dependencies, leftID, rightID) && !dependsTransitively(dependencies, rightID, leftID)) {
        return true
      }
    }
  }
  return false
}

/**
 * Derive split eligibility only from structured facts.  Write tasks are
 * excluded here; their exclusive lane/merge contract belongs to Step 8.4.
 */
export const splitEligibilityReasons = (
  request: MultiAgentSchedulingRequest,
): ReadonlyArray<MultiAgentSplitReason> => {
  if (invalidRequest(request).length > 0 || request.tasks.length < 2 || request.requestedParallelism < 2) return []
  if (request.tasks.some((task) => task.access !== "read")) return []
  if (dependencyCycle(request) || !hasIndependentTaskPair(request)) return []

  const reasons: MultiAgentSplitReason[] = []
  if (request.tasks.every((task) => task.dependsOn.length === 0)) reasons.push("independent-read")
  reasons.push("independent-dag-node")
  if (request.signals?.specializedToolIsolation === true) reasons.push("specialized-tool-isolation")
  if (request.signals?.riskIsolation === true) reasons.push("risk-isolation")
  if (request.signals?.longContextIsolation === true) reasons.push("long-context-isolation")
  return reasons
}

const invalidMetrics = (metrics: MultiAgentExecutionMetrics): ReadonlyArray<string> => {
  const errors: string[] = []
  if (!safeCount(metrics.sampleSize) || metrics.sampleSize === 0) errors.push("sampleSize must be a positive safe integer")
  if (!safeCount(metrics.succeeded) || metrics.succeeded > metrics.sampleSize)
    errors.push("succeeded must be between zero and sampleSize")
  if (![metrics.totalDurationMs, metrics.totalTokens, metrics.totalCostMinor, metrics.conflicts].every(finiteNonNegative))
    errors.push("duration, tokens, cost, and conflicts must be finite and non-negative")
  if (!safeCount(metrics.conflicts) || metrics.conflicts > metrics.sampleSize)
    errors.push("conflicts must be between zero and sampleSize")
  return errors
}

export const summarizeMetrics = (metrics: MultiAgentExecutionMetrics): MultiAgentMetricSummary => {
  const errors = invalidMetrics(metrics)
  if (errors.length > 0) throw new Error(`Invalid multi-agent metrics: ${errors.join("; ")}`)
  return {
    sampleSize: metrics.sampleSize,
    successRate: metrics.succeeded / metrics.sampleSize,
    meanDurationMs: metrics.totalDurationMs / metrics.sampleSize,
    meanTokens: metrics.totalTokens / metrics.sampleSize,
    meanCostMinor: metrics.totalCostMinor / metrics.sampleSize,
    conflictRate: metrics.conflicts / metrics.sampleSize,
  }
}

export const aggregateMetrics = (
  observations: ReadonlyArray<{
    readonly succeeded: boolean
    readonly durationMs: number
    readonly tokens: number
    readonly costMinor: number
    readonly conflict: boolean
  }>,
): MultiAgentExecutionMetrics => {
  const metrics: MultiAgentExecutionMetrics = {
    sampleSize: observations.length,
    succeeded: observations.filter((observation) => observation.succeeded).length,
    totalDurationMs: observations.reduce((total, observation) => total + observation.durationMs, 0),
    totalTokens: observations.reduce((total, observation) => total + observation.tokens, 0),
    totalCostMinor: observations.reduce((total, observation) => total + observation.costMinor, 0),
    conflicts: observations.filter((observation) => observation.conflict).length,
  }
  const errors = invalidMetrics(metrics)
  if (errors.length > 0) throw new Error(`Invalid multi-agent observations: ${errors.join("; ")}`)
  return metrics
}

const metricRatio = (multi: number, baseline: number) => {
  if (baseline === 0) return multi === 0 ? 1 : Number.MAX_SAFE_INTEGER
  const ratio = multi / baseline
  return Number.isFinite(ratio) ? Math.max(0, ratio) : Number.MAX_SAFE_INTEGER
}

export const compareBenefit = (
  baseline: MultiAgentExecutionMetrics,
  multi: MultiAgentExecutionMetrics,
): MultiAgentBenefitComparison => {
  const baselineSummary = summarizeMetrics(baseline)
  const multiSummary = summarizeMetrics(multi)
  return {
    baseline: baselineSummary,
    multi: multiSummary,
    successRateDelta: multiSummary.successRate - baselineSummary.successRate,
    durationRatio: metricRatio(multiSummary.meanDurationMs, baselineSummary.meanDurationMs),
    tokenRatio: metricRatio(multiSummary.meanTokens, baselineSummary.meanTokens),
    costRatio: metricRatio(multiSummary.meanCostMinor, baselineSummary.meanCostMinor),
    conflictRateDelta: multiSummary.conflictRate - baselineSummary.conflictRate,
  }
}

const invalidEvidence = (
  evidence: MultiAgentBenefitEvidence,
  requestDigest: string,
): ReadonlyArray<string> => {
  const errors: string[] = []
  if (evidence.schemaVersion !== MULTI_AGENT_SCHEDULING_SCHEMA_VERSION) errors.push("unsupported evidence schema version")
  if (!digestPattern.test(evidence.datasetDigest)) errors.push("datasetDigest is not an immutable sha256 digest")
  if (!evidence.suiteID.trim()) errors.push("suiteID is required")
  if (!Number.isSafeInteger(evidence.suiteRevision) || evidence.suiteRevision < 1)
    errors.push("suiteRevision must be a positive safe integer")
  if (evidence.requestDigest !== requestDigest) errors.push("evidence requestDigest does not match the scheduling request")
  if (evidence.evidenceIDs.length === 0 || evidence.evidenceIDs.some((id) => !String(id).startsWith("evd_")))
    errors.push("immutable evidence IDs are required")
  if (new Set(evidence.evidenceIDs.map(String)).size !== evidence.evidenceIDs.length)
    errors.push("evidence IDs must be unique")
  errors.push(...invalidMetrics(evidence.baseline).map((error) => `baseline: ${error}`))
  errors.push(...invalidMetrics(evidence.multi).map((error) => `multi: ${error}`))
  if (evidence.baseline.sampleSize !== evidence.multi.sampleSize)
    errors.push("baseline and multi evidence must use the same fixed-dataset sample size")
  return [...new Set(errors)]
}

const invalidPolicy = (policy: MultiAgentBenefitPolicy): ReadonlyArray<string> => {
  const errors: string[] = []
  if (!policy.revision.trim()) errors.push("policy revision is required")
  if (!safeCount(policy.minSamples) || policy.minSamples === 0) errors.push("minSamples must be a positive safe integer")
  if (![policy.maxSuccessRegression, policy.maxConflictRateDelta].every((value) => value >= 0 && value <= 1))
    errors.push("success/conflict deltas must be between zero and one")
  if (![policy.maxDurationRatio, policy.maxTokenRatio, policy.maxCostRatio].every((value) => finiteNonNegative(value) && value > 0))
    errors.push("duration/token/cost ratios must be positive finite numbers")
  return errors
}

const decisionDigest = (decision: Omit<MultiAgentGateDecision, "decisionDigest">) =>
  canonicalHash(decision) ?? ""

const makeDecision = (
  decision: Omit<MultiAgentGateDecision, "decisionDigest">,
): MultiAgentGateDecision => ({ ...decision, decisionDigest: decisionDigest(decision) })

export const evaluateMultiAgentGate = (
  request: MultiAgentSchedulingRequest,
  evidence?: MultiAgentBenefitEvidence,
  policy?: MultiAgentBenefitPolicy,
): MultiAgentGateDecision => {
  const requestDigest = schedulingRequestDigest(request)
  const requestErrors = [
    ...invalidRequest(request),
    ...(requestDigest === "" ? ["scheduling request is not canonically hashable"] : []),
  ]
  const reasons = splitEligibilityReasons(request)
  if (requestDigest === "" || requestErrors.length > 0) {
    return makeDecision({
      schemaVersion: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
      action: "single",
      executeMode: "single",
      eligible: false,
      reasons: [],
      requestDigest,
      failedChecks: requestErrors,
      reason: `split rejected by invalid request: ${requestErrors.join("; ")}`,
    })
  }
  if (reasons.length === 0) {
    return makeDecision({
      schemaVersion: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
      action: "single",
      executeMode: "single",
      eligible: false,
      reasons: [],
      requestDigest,
      failedChecks: ["no approved independent read/isolation/DAG split condition"],
      reason: "multi-agent split is not structurally eligible; keep a single agent",
    })
  }
  if (!evidence) {
    return makeDecision({
      schemaVersion: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
      action: "candidate",
      executeMode: "single",
      eligible: true,
      reasons,
      requestDigest,
      failedChecks: ["fixed-dataset multi-agent benefit evidence is missing"],
      reason: "eligible decomposition is a measurement candidate; automatic split is disabled without evidence",
    })
  }
  const evidenceErrors = invalidEvidence(evidence, requestDigest)
  const evidenceDigest = benefitEvidenceDigest(evidence)
  if (evidenceDigest === "" || evidenceErrors.length > 0) {
    return makeDecision({
      schemaVersion: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
      action: "candidate",
      executeMode: "single",
      eligible: true,
      reasons,
      requestDigest,
      ...(evidenceDigest ? { evidenceDigest } : {}),
      failedChecks: evidenceErrors.length > 0 ? evidenceErrors : ["benefit evidence is not canonically hashable"],
      reason: "benefit evidence is incomplete or mismatched; automatic split is disabled",
    })
  }
  if (!policy) {
    return makeDecision({
      schemaVersion: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
      action: "candidate",
      executeMode: "single",
      eligible: true,
      reasons,
      requestDigest,
      evidenceDigest,
      failedChecks: ["no approved promotion policy was supplied"],
      reason: "benefit evidence exists, but promotion thresholds are not approved; keep a single agent",
    })
  }
  const policyErrors = invalidPolicy(policy)
  if (policyErrors.length > 0) {
    return makeDecision({
      schemaVersion: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
      action: "candidate",
      executeMode: "single",
      eligible: true,
      reasons,
      requestDigest,
      evidenceDigest,
      policyRevision: policy.revision,
      failedChecks: policyErrors,
      reason: "promotion policy is invalid; automatic split is disabled",
    })
  }
  const comparison = compareBenefit(evidence.baseline, evidence.multi)
  const failedChecks: string[] = []
  if (comparison.baseline.sampleSize < policy.minSamples || comparison.multi.sampleSize < policy.minSamples)
    failedChecks.push(`sample size must be at least ${policy.minSamples} for both modes`)
  if (comparison.successRateDelta < -policy.maxSuccessRegression)
    failedChecks.push(`success rate regression ${comparison.successRateDelta.toFixed(6)} exceeds policy`)
  if (comparison.durationRatio > policy.maxDurationRatio)
    failedChecks.push(`duration ratio ${comparison.durationRatio.toFixed(6)} exceeds policy`)
  if (comparison.tokenRatio > policy.maxTokenRatio)
    failedChecks.push(`token ratio ${comparison.tokenRatio.toFixed(6)} exceeds policy`)
  if (comparison.costRatio > policy.maxCostRatio)
    failedChecks.push(`cost ratio ${comparison.costRatio.toFixed(6)} exceeds policy`)
  if (comparison.conflictRateDelta > policy.maxConflictRateDelta)
    failedChecks.push(`conflict rate delta ${comparison.conflictRateDelta.toFixed(6)} exceeds policy`)

  if (failedChecks.length > 0) {
    return makeDecision({
      schemaVersion: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
      action: "single",
      executeMode: "single",
      eligible: true,
      reasons,
      requestDigest,
      evidenceDigest,
      policyRevision: policy.revision,
      comparison,
      failedChecks,
      reason: "multi-agent benefit evidence does not pass the approved policy; keep a single agent",
    })
  }
  return makeDecision({
    schemaVersion: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
    action: "multi",
    executeMode: "multi",
    eligible: true,
    reasons,
    requestDigest,
    evidenceDigest,
    policyRevision: policy.revision,
    comparison,
    failedChecks: [],
    reason: "multi-agent benefit evidence passes the approved policy",
  })
}

/** Build the conservative workflow-level request used before any child split. */
export const workflowSchedulingRequest = (
  definition: WorkflowDefinition,
  requestedParallelism: number,
): MultiAgentSchedulingRequest => {
  const candidates = definition.steps.filter((step) => step.kind === "agent" && step.access === "read")
  const candidateIDs = new Set(candidates.map((step) => step.id))
  const dependencies = new Map(definition.steps.map((step) => [step.id, step.depends_on]))
  const candidateAncestors = (taskID: string) => {
    const pending = [...(dependencies.get(taskID) ?? [])]
    const visited = new Set<string>()
    const result = new Set<string>()
    while (pending.length > 0) {
      const dependency = pending.pop()!
      if (visited.has(dependency)) continue
      visited.add(dependency)
      if (candidateIDs.has(dependency)) result.add(dependency)
      pending.push(...(dependencies.get(dependency) ?? []))
    }
    return [...result].toSorted()
  }
  return {
    requestedParallelism,
    tasks: candidates.map((step) => ({
      id: step.id,
      kind: step.kind,
      access: step.access,
      // Project dependencies through non-agent barriers so a chain such as
      // read -> command -> read is not incorrectly treated as parallel.
      dependsOn: candidateAncestors(step.id),
    })),
  }
}
