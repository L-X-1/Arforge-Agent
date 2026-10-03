export * as SkillLifecycleV1 from "./skill-lifecycle"

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as SkillContract from "@arforge-ai/schema/skill-v1"
import { ensureNoPermissionExpansion } from "./skill-v1"
import { canonicalHash } from "./util/canonical-hash"

export interface ResourceOutcome {
  readonly success: boolean
  readonly steps: number
  readonly tokens: number
  readonly costMinor: number
  readonly newFailures: number
  readonly newSecretFindings: number
  readonly newEgressAttempts: number
}

export interface EvaluationObservation {
  readonly caseID: string
  readonly baseline: ResourceOutcome
  readonly candidate: ResourceOutcome
  readonly evidenceIDs: ReadonlyArray<string>
}

export interface SkillEvaluationReport {
  readonly candidateDigest: string
  readonly baselineDigest: string
  readonly sampleSize: number
  readonly utilityDelta: number
  readonly regressionCases: ReadonlyArray<string>
  readonly newFailureCount: number
  readonly newSecretFindings: number
  readonly newEgressAttempts: number
  readonly checks: {
    readonly noPermissionExpansion: boolean
    readonly noNewSecret: boolean
    readonly noNewEgress: boolean
    readonly noRegression: boolean
    readonly utilityNonRegression: boolean
  }
  readonly passed: boolean
  readonly evidenceIDs: ReadonlyArray<string>
}

export interface IsolatedEvaluationContext {
  readonly workspace: string
  readonly candidate: SkillContract.Skill
  readonly candidatePath: string
}

export type IsolatedEvaluationRunner = (
  context: IsolatedEvaluationContext,
) => Promise<ReadonlyArray<EvaluationObservation>>

export class SkillLifecycleError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "SkillLifecycleError"
  }
}

const finiteNonNegative = (value: number, name: string) => {
  if (!Number.isFinite(value) || value < 0) throw new SkillLifecycleError(`${name} must be finite and non-negative`)
  return value
}

const validateOutcome = (value: ResourceOutcome) => {
  finiteNonNegative(value.steps, "steps")
  finiteNonNegative(value.tokens, "tokens")
  finiteNonNegative(value.costMinor, "costMinor")
  finiteNonNegative(value.newFailures, "newFailures")
  finiteNonNegative(value.newSecretFindings, "newSecretFindings")
  finiteNonNegative(value.newEgressAttempts, "newEgressAttempts")
}

export function evaluateSkill(input: {
  readonly baselineSkill: SkillContract.Skill
  readonly candidateSkill: SkillContract.Skill
  readonly observations: ReadonlyArray<EvaluationObservation>
}): SkillEvaluationReport {
  if (input.candidateSkill.status !== "candidate")
    throw new SkillLifecycleError("only candidate skills may enter evaluation")
  if (input.observations.length === 0) throw new SkillLifecycleError("evaluation requires observations")
  try {
    ensureNoPermissionExpansion(input.baselineSkill, input.candidateSkill)
  } catch {
    return {
      candidateDigest: input.candidateSkill.digest,
      baselineDigest: input.baselineSkill.digest,
      sampleSize: input.observations.length,
      utilityDelta: 0,
      regressionCases: [],
      newFailureCount: 0,
      newSecretFindings: 0,
      newEgressAttempts: 0,
      checks: {
        noPermissionExpansion: false,
        noNewSecret: true,
        noNewEgress: true,
        noRegression: true,
        utilityNonRegression: true,
      },
      passed: false,
      evidenceIDs: [...new Set(input.observations.flatMap((observation) => observation.evidenceIDs))],
    }
  }
  const caseIDs = new Set<string>()
  const regressionCases: string[] = []
  let baselineSuccess = 0
  let candidateSuccess = 0
  let newFailureCount = 0
  let newSecretFindings = 0
  let newEgressAttempts = 0
  const evidenceIDs = new Set<string>()
  for (const observation of input.observations) {
    const caseID = observation.caseID.trim()
    if (!caseID || caseIDs.has(caseID))
      throw new SkillLifecycleError(`evaluation case is missing or duplicated: ${caseID}`)
    caseIDs.add(caseID)
    validateOutcome(observation.baseline)
    validateOutcome(observation.candidate)
    if (observation.baseline.success) baselineSuccess++
    if (observation.candidate.success) candidateSuccess++
    if (observation.baseline.success && !observation.candidate.success) regressionCases.push(caseID)
    newFailureCount += observation.candidate.newFailures
    newSecretFindings += observation.candidate.newSecretFindings
    newEgressAttempts += observation.candidate.newEgressAttempts
    for (const evidenceID of observation.evidenceIDs) {
      if (evidenceID.startsWith("evd_")) evidenceIDs.add(evidenceID)
    }
  }
  const utilityDelta = (candidateSuccess - baselineSuccess) / input.observations.length
  const checks = {
    noPermissionExpansion: true,
    noNewSecret: newSecretFindings === 0,
    noNewEgress: newEgressAttempts === 0,
    noRegression: regressionCases.length === 0,
    utilityNonRegression: utilityDelta >= 0,
  }
  return {
    candidateDigest: input.candidateSkill.digest,
    baselineDigest: input.baselineSkill.digest,
    sampleSize: input.observations.length,
    utilityDelta,
    regressionCases,
    newFailureCount,
    newSecretFindings,
    newEgressAttempts,
    checks,
    passed: Object.values(checks).every(Boolean),
    evidenceIDs: [...evidenceIDs].sort(),
  }
}

export async function runIsolatedEvaluation(input: {
  readonly candidate: SkillContract.Skill
  readonly candidatePath: string
  readonly baselineSkill: SkillContract.Skill
  readonly runner: IsolatedEvaluationRunner
}): Promise<SkillEvaluationReport> {
  if (!existsSync(input.candidatePath)) throw new SkillLifecycleError("candidate artifact path does not exist")
  const workspace = join(
    tmpdir(),
    `arforge-skill-eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(workspace, { recursive: true })
  try {
    writeFileSync(join(workspace, "candidate-digest"), input.candidate.digest, { encoding: "utf8", flag: "wx" })
    const observations = await input.runner({
      workspace,
      candidate: input.candidate,
      candidatePath: input.candidatePath,
    })
    return evaluateSkill({ baselineSkill: input.baselineSkill, candidateSkill: input.candidate, observations })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

export interface CanaryObservation {
  readonly cohortKey: string
  readonly success: boolean
  readonly safetyIncident: boolean
  readonly evidenceIDs: ReadonlyArray<string>
}

export interface CanaryAudit {
  readonly action: "canary_started" | "observation_recorded" | "promoted" | "rolled_back"
  readonly candidateDigest: string
  readonly reason: string
  readonly evidenceIDs: ReadonlyArray<string>
}

export interface CanaryState {
  readonly candidateDigest: string
  readonly status: "canary" | "active" | "rolled_back"
  readonly cohortDigest: string
  readonly trafficPercent: number
  readonly observations: ReadonlyArray<CanaryObservation>
  readonly rollbackVersion?: string
  readonly audit: ReadonlyArray<CanaryAudit>
}

const cohortBucket = (candidateDigest: string, cohortKey: string) => {
  const digest = canonicalHash({ candidateDigest, cohortKey })
  if (!digest) throw new SkillLifecycleError("cohort assignment is not canonicalizable")
  return { digest, bucket: Number.parseInt(digest.slice(0, 8), 16) % 100 }
}

export const assignCohort = (candidateDigest: string, cohortKey: string, trafficPercent: number): boolean => {
  if (!/^[a-f0-9]{64}$/i.test(candidateDigest)) throw new SkillLifecycleError("candidate digest is invalid")
  if (!Number.isInteger(trafficPercent) || trafficPercent < 1 || trafficPercent > 100)
    throw new SkillLifecycleError("trafficPercent must be an integer in [1, 100]")
  return cohortBucket(candidateDigest, cohortKey).bucket < trafficPercent
}

/** @deprecated Test/reference helper only. Production lifecycle state is owned by SkillStoreV1 in the database. */
export class SkillCanaryController {
  private readonly states = new Map<string, CanaryState>()

  start(input: {
    readonly candidate: SkillContract.Skill
    readonly evaluation: SkillEvaluationReport
    readonly cohortKey: string
    readonly trafficPercent: number
  }): CanaryState {
    if (input.candidate.status !== "candidate") throw new SkillLifecycleError("only candidate skills may start canary")
    if (!input.evaluation.passed) throw new SkillLifecycleError("failed skill evaluation cannot start canary")
    if (input.evaluation.candidateDigest !== input.candidate.digest)
      throw new SkillLifecycleError("evaluation digest does not match candidate")
    assignCohort(input.candidate.digest, input.cohortKey, input.trafficPercent)
    const cohort = cohortBucket(input.candidate.digest, input.cohortKey)
    const state: CanaryState = {
      candidateDigest: input.candidate.digest,
      status: "canary",
      cohortDigest: cohort.digest,
      trafficPercent: input.trafficPercent,
      observations: [],
      audit: [
        {
          action: "canary_started",
          candidateDigest: input.candidate.digest,
          reason: "offline evaluation passed",
          evidenceIDs: input.evaluation.evidenceIDs,
        },
      ],
    }
    this.states.set(input.candidate.digest, state)
    return state
  }

  observe(candidateDigest: string, observation: CanaryObservation): CanaryState {
    const current = this.require(candidateDigest)
    if (current.status !== "canary") throw new SkillLifecycleError("observations are accepted only during canary")
    const cohort = cohortBucket(candidateDigest, observation.cohortKey)
    if (
      cohort.digest !== current.cohortDigest ||
      !assignCohort(candidateDigest, observation.cohortKey, current.trafficPercent)
    )
      throw new SkillLifecycleError("observation cohort is outside the assigned canary")
    const next: CanaryState = {
      ...current,
      observations: [...current.observations, observation],
      audit: [
        ...current.audit,
        {
          action: "observation_recorded",
          candidateDigest,
          reason: observation.safetyIncident ? "safety incident observed" : "canary observation recorded",
          evidenceIDs: observation.evidenceIDs.filter((id) => id.startsWith("evd_")),
        },
      ],
    }
    this.states.set(candidateDigest, next)
    return next
  }

  promote(
    candidateDigest: string,
    input: { readonly minimumObservations: number; readonly minimumSuccessRate: number },
  ): CanaryState {
    const current = this.require(candidateDigest)
    if (current.status !== "canary") throw new SkillLifecycleError("only canary skills may be promoted")
    if (!Number.isInteger(input.minimumObservations) || input.minimumObservations < 1)
      throw new SkillLifecycleError("minimumObservations must be a positive integer")
    if (input.minimumSuccessRate < 0 || input.minimumSuccessRate > 1)
      throw new SkillLifecycleError("minimumSuccessRate must be in [0, 1]")
    const successes = current.observations.filter((observation) => observation.success).length
    const safetyIncidents = current.observations.filter((observation) => observation.safetyIncident).length
    if (
      current.observations.length < input.minimumObservations ||
      safetyIncidents > 0 ||
      successes / current.observations.length < input.minimumSuccessRate
    )
      throw new SkillLifecycleError("canary promotion gate failed")
    const next: CanaryState = {
      ...current,
      status: "active",
      audit: [
        ...current.audit,
        {
          action: "promoted",
          candidateDigest,
          reason: "canary gate passed",
          evidenceIDs: current.observations.flatMap((item) => item.evidenceIDs),
        },
      ],
    }
    this.states.set(candidateDigest, next)
    return next
  }

  rollback(
    candidateDigest: string,
    input: { readonly rollbackVersion: string; readonly reason: string; readonly evidenceIDs: ReadonlyArray<string> },
  ): CanaryState {
    const current = this.require(candidateDigest)
    if (current.status !== "active" && current.status !== "canary")
      throw new SkillLifecycleError("only active/canary skills may roll back")
    if (!input.rollbackVersion.trim() || !input.reason.trim())
      throw new SkillLifecycleError("rollback version and reason are required")
    const next: CanaryState = {
      ...current,
      status: "rolled_back",
      rollbackVersion: input.rollbackVersion.trim(),
      audit: [
        ...current.audit,
        {
          action: "rolled_back",
          candidateDigest,
          reason: input.reason.trim().slice(0, 500),
          evidenceIDs: input.evidenceIDs.filter((id) => id.startsWith("evd_")),
        },
      ],
    }
    this.states.set(candidateDigest, next)
    return next
  }

  get(candidateDigest: string): CanaryState | undefined {
    return this.states.get(candidateDigest)
  }

  private require(candidateDigest: string): CanaryState {
    const state = this.states.get(candidateDigest)
    if (!state) throw new SkillLifecycleError("candidate has no canary state")
    return state
  }
}
