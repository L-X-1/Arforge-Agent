import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createCandidate } from "@arforge-ai/core/skill-v1"
import {
  SkillCanaryController,
  SkillLifecycleError,
  assignCohort,
  evaluateSkill,
  runIsolatedEvaluation,
} from "@arforge-ai/core/skill-lifecycle"

const skill = (skillID: string, allowedTools: string[] = ["read"]) =>
  createCandidate({
    skillID,
    version: "1.0.0",
    purpose: "release checks",
    triggers: ["release"],
    allowedTools,
    allowedCapabilities: [],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    instructionRefs: [{ path: "SKILL.md", digest: "a".repeat(64) }],
    sourceExperienceIDs: ["exp_lifecycle"],
    testIDs: ["st_release"],
    evaluationID: "eva_lifecycle",
    policyVersion: "skill-policy-v1",
    now: 1_725_000_000_000,
  })

const observations = [
  {
    caseID: "case-a",
    baseline: {
      success: true,
      steps: 4,
      tokens: 100,
      costMinor: 10,
      newFailures: 0,
      newSecretFindings: 0,
      newEgressAttempts: 0,
    },
    candidate: {
      success: true,
      steps: 3,
      tokens: 80,
      costMinor: 8,
      newFailures: 0,
      newSecretFindings: 0,
      newEgressAttempts: 0,
    },
    evidenceIDs: ["evd_lifecycle_a"],
  },
  {
    caseID: "case-b",
    baseline: {
      success: true,
      steps: 4,
      tokens: 100,
      costMinor: 10,
      newFailures: 0,
      newSecretFindings: 0,
      newEgressAttempts: 0,
    },
    candidate: {
      success: true,
      steps: 3,
      tokens: 80,
      costMinor: 8,
      newFailures: 0,
      newSecretFindings: 0,
      newEgressAttempts: 0,
    },
    evidenceIDs: ["evd_lifecycle_b"],
  },
] as const

describe("SkillLifecycle", () => {
  test("evaluates in an isolated workspace and removes the workspace afterward", async () => {
    const root = join(process.env.TEMP ?? process.cwd(), `arforge-lifecycle-${randomUUID()}`)
    const candidatePath = join(root, "candidate")
    mkdirSync(candidatePath, { recursive: true })
    let observedWorkspace = ""
    try {
      const baseline = skill("release-baseline")
      const candidate = skill("release-candidate")
      const report = await runIsolatedEvaluation({
        baselineSkill: baseline,
        candidate,
        candidatePath,
        runner: async (context) => {
          observedWorkspace = context.workspace
          return observations
        },
      })
      expect(report.passed).toBe(true)
      expect(report.utilityDelta).toBe(0)
      expect(report.checks.noPermissionExpansion).toBe(true)
      expect(observedWorkspace).not.toBe("")
      expect(existsSync(observedWorkspace)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects permission expansion, regression, and new secret/egress findings", () => {
    const baseline = skill("release-baseline")
    const expanded = skill("release-expanded", ["read", "shell"])
    const permissionReport = evaluateSkill({ baselineSkill: baseline, candidateSkill: expanded, observations })
    expect(permissionReport.passed).toBe(false)
    expect(permissionReport.checks.noPermissionExpansion).toBe(false)

    const unsafeReport = evaluateSkill({
      baselineSkill: baseline,
      candidateSkill: skill("release-unsafe"),
      observations: [
        {
          ...observations[0],
          candidate: { ...observations[0].candidate, success: false, newSecretFindings: 1, newEgressAttempts: 1 },
        },
      ],
    })
    expect(unsafeReport.passed).toBe(false)
    expect(unsafeReport.regressionCases).toEqual(["case-a"])
    expect(unsafeReport.checks.noNewSecret).toBe(false)
    expect(unsafeReport.checks.noNewEgress).toBe(false)
  })

  test("assigns deterministic cohorts and promotes then immediately rolls back without deleting evidence", () => {
    const baseline = skill("release-baseline")
    const candidate = skill("release-canary")
    const report = evaluateSkill({ baselineSkill: baseline, candidateSkill: candidate, observations })
    const controller = new SkillCanaryController()
    const started = controller.start({ candidate, evaluation: report, cohortKey: "tenant-user-1", trafficPercent: 100 })
    expect(started.status).toBe("canary")
    expect(assignCohort(candidate.digest, "tenant-user-1", 100)).toBe(true)

    controller.observe(candidate.digest, {
      cohortKey: "tenant-user-1",
      success: true,
      safetyIncident: false,
      evidenceIDs: ["evd_canary_1"],
    })
    controller.observe(candidate.digest, {
      cohortKey: "tenant-user-1",
      success: true,
      safetyIncident: false,
      evidenceIDs: ["evd_canary_2"],
    })
    const active = controller.promote(candidate.digest, { minimumObservations: 2, minimumSuccessRate: 1 })
    expect(active.status).toBe("active")
    const rolledBack = controller.rollback(candidate.digest, {
      rollbackVersion: "0.9.0",
      reason: "manual safety rollback",
      evidenceIDs: ["evd_rollback"],
    })
    expect(rolledBack.status).toBe("rolled_back")
    expect(rolledBack.observations).toHaveLength(2)
    expect(rolledBack.audit.map((entry) => entry.action)).toEqual([
      "canary_started",
      "observation_recorded",
      "observation_recorded",
      "promoted",
      "rolled_back",
    ])
    expect(rolledBack.audit.at(-1)?.evidenceIDs).toEqual(["evd_rollback"])
  })

  test("blocks canary promotion after a safety incident", () => {
    const candidate = skill("release-safety")
    const report = evaluateSkill({ baselineSkill: skill("release-baseline"), candidateSkill: candidate, observations })
    const controller = new SkillCanaryController()
    controller.start({ candidate, evaluation: report, cohortKey: "cohort", trafficPercent: 100 })
    controller.observe(candidate.digest, {
      cohortKey: "cohort",
      success: true,
      safetyIncident: true,
      evidenceIDs: ["evd_safety"],
    })
    expect(() => controller.promote(candidate.digest, { minimumObservations: 1, minimumSuccessRate: 0 })).toThrow(
      SkillLifecycleError,
    )
  })
})
