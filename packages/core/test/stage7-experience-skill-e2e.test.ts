import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as SkillContract from "@arforge-ai/schema/skill-v1"
import { eq } from "drizzle-orm"
import { basename, isAbsolute, join } from "node:path"
import { realpath } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import * as EvidenceV2 from "@arforge-ai/core/evidence"
import { ExperienceStoreV1 } from "@arforge-ai/core/experience-store"
import { ExperienceEvidenceTable } from "@arforge-ai/core/experience-store/sql"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { Project } from "@arforge-ai/core/project"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as RuntimeEvaluation from "@arforge-ai/core/runtime/evaluation"
import { createDefaultVerifierRegistry, freezeVerifierInput } from "@arforge-ai/core/runtime/verifier"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SkillStoreV1 } from "@arforge-ai/core/skill-store"
import {
  SkillAuditTable, SkillCanaryObservationTable, SkillDeploymentTable, SkillEvaluationTable, SkillVersionTable,
} from "@arforge-ai/core/skill-store/sql"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { DateTime, Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const identity = {
  tenantID: "ten_stage7_lifecycle",
  userID: "usr_stage7_lifecycle",
  actor: "user:usr_stage7_lifecycle",
}

const directory = AbsolutePath.make("C:/workspaces/stage7-lifecycle")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory, project: { id: Project.ID.global, directory } }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    DurableAction.node,
    DurableRun.node,
    RuntimeEvaluation.node,
    ActionGateway.node,
    LearningV2.node,
    ExperienceStoreV1.node,
    SkillStoreV1.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [Location.node, current],
  ],
)
const it = testEffect(layer)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: 60_000,
  maxCostMicros: 100_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

interface VerifiedFact {
  readonly runID: AgentRuntime.RunID
  readonly actionID: AgentRuntime.ActionID
  readonly evaluationID: AgentRuntime.EvaluationID
  readonly evidence: AgentRuntime.Evidence
}

const verifiedFact = Effect.fn("Stage7E2E.verifiedFact")(function* (input: {
  readonly suffix: string
  readonly candidateArtifactDigest: string
  readonly environmentDigest?: string
  readonly safetyIncident?: boolean
}) {
  const runs = yield* DurableRun.Service
  const actions = yield* DurableAction.Service
  const gateway = yield* ActionGateway.Service
  const evaluations = yield* RuntimeEvaluation.Service
  const sessionID = SessionSchema.ID.make(`ses_stage7_${input.suffix}`)
  const runID = AgentRuntime.RunID.make(`run_stage7_${input.suffix}`)
  const created = yield* runs.create({
    id: runID,
    sessionID,
    initiator: "user",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: `stage7 verified fixture ${input.suffix}`,
    budget,
    traceID: `trace-stage7-${input.suffix}`,
    visibility: "audit",
  })
  yield* runs.transition({ runID: created.run.id, to: "preflight", reason: "fixture preflight" })
  yield* runs.transition({ runID: created.run.id, to: "queued", reason: "fixture queued" })
  yield* runs.transition({ runID: created.run.id, to: "running", reason: "fixture running" })

  const context = {
    sessionID,
    assistantMessageID: SessionMessage.ID.make(`msg_stage7_${input.suffix}`),
    toolCallID: `call-stage7-${input.suffix}`,
  }
  const actionID = ActionGateway.stableActionID(context)
  yield* gateway.execute(
    {
      ...context,
      actionID,
      runID,
      agent: AgentV2.ID.make("build"),
      name: "shell",
      resources: [`fixture:${input.suffix}`],
      semantics: AgentRuntime.EffectSemantics.make({
        riskTier: "L0",
        authority: "automatic",
        idempotency: "idempotent",
        retryability: "safe",
        reversibility: "not_applicable",
        filesystemScope: [],
        networkScope: [],
        secretScope: [],
        externalServices: [],
        expectedArtifacts: [],
        successCriteria: ["fixture succeeds"],
      }),
      reasonSummary: "produce independently verifiable fixture output",
      inputDigest: canonicalHash({ suffix: input.suffix })!,
    },
    { execute: () => Effect.succeed({ exitCode: 0 }) },
  )
  const action = yield* actions.load(actionID)
  if (!action.observation) return yield* Effect.die(new Error("settled fixture Action has no Observation"))
  const observation = action.observation
  yield* runs.transition({ runID, to: "verifying", reason: "independent verifier running" })

  const registry = createDefaultVerifierRegistry()
  const verification = yield* Effect.promise(() =>
    registry.verify(
      freezeVerifierInput({
        frozenIntent: {
          actionKind: "shell",
          actionVersion: "1",
          intentDigest: canonicalHash({ actionID, suffix: input.suffix })!,
          payload: { commandClass: "deterministic-fixture", suffix: input.suffix },
        },
        observation: {
          status: observation.status,
          observationDigest: canonicalHash(observation)!,
          summary: observation.summary,
          values: { exitCode: 0 },
        },
        artifactRefs: [
          {
            kind: "fixture",
            ref: `fixture://${input.suffix}`,
            digest: input.candidateArtifactDigest,
          },
        ],
        runID,
        actionID,
        observationID: observation.id,
      }),
    ),
  )
  expect(verification.evaluation.passed).toBe(true)
  expect(verification.evidence.observationIDs).toEqual([observation.id])

  const now = Date.now()
  const evaluationID = AgentRuntime.EvaluationID.make(`eva_stage7_${input.suffix}`)
  yield* evaluations.create({
    id: evaluationID,
    runID,
    suiteID: "stage7-verifier-e2e",
    suiteRevision: 1,
    caseID: input.suffix,
    caseRevision: 1,
    baselineArtifactDigest: "0".repeat(64),
    candidateArtifactDigest: input.candidateArtifactDigest,
    environmentDigest: input.environmentDigest ?? "1".repeat(64),
    toolchainDigest: "2".repeat(64),
    sampleSize: 1,
    score: 1,
    successDelta: 1,
    costDelta: 0,
    latencyDelta: 0,
    passed: true,
    metrics: {
      assertions: verification.evaluation.total,
      safety_incidents: input.safetyIncident ? 1 : 0,
      new_secret_findings: 0,
      new_egress_attempts: 0,
    },
    evidenceIDs: [verification.evidence.id],
    approvalStatus: "approved",
    reviewerID: identity.userID,
    createdAt: now,
    evaluatedAt: now,
  })
  yield* runs.transition({ runID, to: "completed", reason: "independent verification passed" })
  return {
    runID,
    actionID,
    evaluationID,
    evidence: verification.evidence,
  } satisfies VerifiedFact
})

const replayObservations = (candidateDigest: string) => {
  const dataset = {
    id: "stage7-experience-replay",
    revision: "1",
    source: "recorded" as const,
    caseIDs: ["release-a", "release-b", "release-c"],
  }
  const cases = dataset.caseIDs.map((caseID) => ({
    caseID,
    success: true,
    steps: 2,
    tokens: 20,
    costMinor: 1,
    newFailures: 0,
  }))
  return [
    {
      dataset,
      variant: "without_experience" as const,
      cases: cases.map((item, index) => ({ ...item, success: index !== 0, steps: 3 })),
    },
    { dataset, variant: "candidate_experience" as const, experienceDigest: candidateDigest, cases },
    { dataset, variant: "active_experience" as const, experienceDigest: "f".repeat(64), cases },
  ]
}

const skillInput = (
  version: string,
  sourceExperienceIDs: ReadonlyArray<AgentRuntime.ExperienceID>,
  instructions: string,
) => ({
  identity,
  skillID: "skill.release-verification",
  version,
  purpose: "Run bounded release verification from reusable Experience",
  triggers: ["release verification"],
  allowedTools: [],
  allowedCapabilities: [],
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: { type: "object", required: ["passed"] },
  instructions,
  sourceExperienceIDs,
  testCases: [
    { id: "release-check-a", input: { target: "a" }, expected: { passed: true } },
    { id: "release-check-b", input: { target: "b" }, expected: { passed: true } },
  ],
  policyVersion: "skill-policy-v1",
})

const promoteSkill = Effect.fn("Stage7E2E.promoteSkill")(function* (
  candidate: SkillStoreV1.SkillCandidateProjection,
  suffix: string,
) {
  const experience = yield* ExperienceStoreV1.Service
  const skills = yield* SkillStoreV1.Service
  const { db } = yield* Database.Service
  // This layer owns an isolated in-memory SQLite database; snapshot every Skill table.
  const skillSnapshot = () => Effect.all([
    db.select().from(SkillVersionTable).all(),
    db.select().from(SkillEvaluationTable).all(),
    db.select().from(SkillAuditTable).all(),
    db.select().from(SkillCanaryObservationTable).all(),
    db.select().from(SkillDeploymentTable).all(),
  ])
  const evaluation = yield* skills.recordEvaluation({
    identity,
    candidateID: candidate.candidateID,
    expectedRevision: candidate.revision,
    observations: candidate.skill.testIDs.map((caseID) => ({
      caseID,
      baseline: {
        success: false,
        steps: 3,
        tokens: 30,
        costMinor: 2,
        newFailures: 0,
        newSecretFindings: 0,
        newEgressAttempts: 0,
      },
      candidate: {
        success: true,
        steps: 2,
        tokens: 20,
        costMinor: 1,
        newFailures: 0,
        newSecretFindings: 0,
        newEgressAttempts: 0,
      },
      evidenceIDs: candidate.sourceEvidenceIDs.map(String),
    })),
  })
  expect(evaluation.report.passed).toBe(true)
  const evaluatedDetail = yield* skills.getCandidateDetail(identity, candidate.candidateID)
  expect(evaluatedDetail.evaluation?.candidateDigest).toBe(candidate.skill.digest)
  expect(evaluatedDetail.evaluation?.sampleSize).toBe(candidate.skill.testIDs.length)
  expect(evaluatedDetail.canary).toEqual({
    observationCount: 0,
    successCount: 0,
    safetyIncidentCount: 0,
    successRate: 0,
    minimumObservations: SkillStoreV1.Policy.minimumCanaryObservations,
    minimumSuccessRate: SkillStoreV1.Policy.minimumCanarySuccessRate,
    promotionReady: false,
  })
  if (suffix === "v1") {
    const originalRow = yield* db.select().from(SkillVersionTable).where(eq(SkillVersionTable.id, candidate.candidateID)).get()
    const originalEvaluation = yield* db.select().from(SkillEvaluationTable).where(eq(SkillEvaluationTable.candidate_id, candidate.candidateID)).get()
    if (!originalRow || !originalEvaluation) return yield* Effect.die(new Error("Skill policy fixture is missing"))
    const { recordDigest, createdAt, updatedAt, ...material } = evaluation.candidate
    const encodedMaterial = { ...material, skill: Schema.encodeUnknownSync(SkillContract.Skill)(evaluation.candidate.skill) }
    expect(canonicalHash(encodedMaterial)).toBe(recordDigest)
    // Explicit historical/corruption fixtures, not normal producer or execution proof.
    const fixtures = [
      { label: "legacy passed report with new failures", report: { ...evaluation.report, newFailureCount: 2 }, canonical: true, error: "current safety policy" },
      { label: "legacy success regression hidden by flags", report: { ...evaluation.report, regressionCases: ["release-check-a"] }, canonical: true, error: "current safety policy" },
      { label: "failed safety check with passed flag", report: { ...evaluation.report, checks: { ...evaluation.report.checks, noNewSecret: false } }, canonical: true, error: "current safety policy" },
      { label: "nonzero safety counters hidden by flags", report: { ...evaluation.report, newSecretFindings: 1, newEgressAttempts: 1 }, canonical: true, error: "current safety policy" },
      { label: "tampered content with unchanged digest pointers", report: { ...evaluation.report, utilityDelta: 123 }, canonical: false, error: "integrity verification" },
      { label: "canonical report for a different candidate", report: { ...evaluation.report, candidateDigest: "f".repeat(64) }, canonical: true, error: "integrity verification" },
      { label: "canonical report for a different baseline", report: { ...evaluation.report, baselineDigest: "e".repeat(64) }, canonical: true, error: "integrity verification" },
    ]
    for (const fixture of fixtures) {
      const reportDigest = fixture.canonical ? canonicalHash(fixture.report)! : originalEvaluation.report_digest
      yield* db.update(SkillEvaluationTable).set({ report: fixture.report, report_digest: reportDigest }).where(eq(SkillEvaluationTable.id, originalEvaluation.id)).run()
      yield* db.update(SkillVersionTable).set({
        evaluation_digest: reportDigest,
        record_digest: canonicalHash({ ...encodedMaterial, evaluationDigest: reportDigest })!,
      }).where(eq(SkillVersionTable.id, originalRow.id)).run()
      const before = yield* skillSnapshot()
      const rejected = yield* skills.startCanary({
        identity, candidateID: candidate.candidateID, expectedRevision: evaluation.candidate.revision,
        trafficPercent: 100, reason: `reject ${fixture.label}`,
      }).pipe(Effect.match({
        onSuccess: () => ({ rejected: false, tag: "success", reason: "" }),
        onFailure: (error) => ({ rejected: true, tag: error._tag, reason: error._tag === "SkillStore.Error" ? error.reason : "" }),
      }))
      expect(rejected.rejected).toBe(true)
      expect(rejected.tag).toBe("SkillStore.Error")
      expect(rejected.reason).toContain(fixture.error)
      expect(yield* skillSnapshot()).toEqual(before)
    }
    // Only test setup restores the exact original rows; the Product rejection writes nothing.
    yield* db.update(SkillEvaluationTable).set(originalEvaluation).where(eq(SkillEvaluationTable.id, originalEvaluation.id)).run()
    yield* db.update(SkillVersionTable).set(originalRow).where(eq(SkillVersionTable.id, originalRow.id)).run()
  }
  const auditBefore = yield* skills.verifyAudit(identity, candidate.candidateID)
  let current = yield* skills.startCanary({
    identity,
    candidateID: candidate.candidateID,
    expectedRevision: evaluation.candidate.revision,
    trafficPercent: 100,
    reason: `approve bounded canary ${suffix}`,
  })
  const afterStart = yield* skillSnapshot()
  const canaryReplay = yield* skills.startCanary({
    identity, candidateID: candidate.candidateID, expectedRevision: evaluation.candidate.revision,
    trafficPercent: 100, reason: `approve bounded canary ${suffix}`,
  })
  expect(canaryReplay).toEqual(current)
  expect(yield* skillSnapshot()).toEqual(afterStart)
  const auditAfter = yield* skills.verifyAudit(identity, candidate.candidateID)
  expect(auditAfter.valid).toBe(true)
  expect(auditAfter.events).toBe(auditBefore.events + 1)
  const canaryDigest = current.canaryDigest
  if (!canaryDigest) return yield* Effect.die(new Error("started Skill canary has no immutable binding"))
  for (let index = 0; index < 3; index++) {
    const fact = yield* verifiedFact({
      suffix: `${suffix}_canary_${index}`,
      candidateArtifactDigest: candidate.skill.digest,
      environmentDigest: canaryDigest,
    })
    yield* experience.recordVerifiedEvidence({ identity, ...fact, evidence: [fact.evidence] })
    const observation = yield* skills.recordCanaryObservation({
      identity,
      candidateID: candidate.candidateID,
      expectedRevision: current.revision,
      idempotencyKey: `${suffix}-canary-${index}`,
      cohortKey: `${suffix}-cohort-${index}`,
      runID: fact.runID,
      evaluationID: fact.evaluationID,
      evidenceIDs: [fact.evidence.id],
      success: true,
      safetyIncident: false,
    })
    current = observation.candidate
    if (index === 0) {
      const replay = yield* skills.recordCanaryObservation({
        identity,
        candidateID: candidate.candidateID,
        expectedRevision: current.revision - 1,
        idempotencyKey: `${suffix}-canary-${index}`,
        cohortKey: `${suffix}-cohort-${index}`,
        runID: fact.runID,
        evaluationID: fact.evaluationID,
        evidenceIDs: [fact.evidence.id],
        success: true,
        safetyIncident: false,
      })
      expect(replay.replayed).toBe(true)
      expect(replay.candidate.revision).toBe(current.revision)
    }
  }
  const canaryDetail = yield* skills.getCandidateDetail(identity, candidate.candidateID)
  expect(canaryDetail.canary.observationCount).toBe(3)
  expect(canaryDetail.canary.successCount).toBe(3)
  expect(canaryDetail.canary.safetyIncidentCount).toBe(0)
  expect(canaryDetail.canary.successRate).toBe(1)
  expect(canaryDetail.canary.promotionReady).toBe(true)
  const expectedRevision = current.revision
  const reason = `promote verified canary ${suffix}`
  const promoted = yield* skills.promote({
    identity,
    candidateID: candidate.candidateID,
    expectedRevision,
    reason,
  })
  const replay = yield* skills.promote({
    identity,
    candidateID: candidate.candidateID,
    expectedRevision,
    reason,
  })
  expect(replay.receiptDigest).toBe(promoted.receiptDigest)
  return { ...promoted, expectedRevision, reason }
})

describe("Stage 7 durable Experience and Skill lifecycle", () => {
  it.effect(
    "closes verified Run provenance, independent Skill tests, canary, promotion, rollback, audit, and tenant gates",
    () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        return yield* database.runAsPrincipal(
          identity,
          Effect.gen(function* () {
            const experience = yield* ExperienceStoreV1.Service
            const skills = yield* SkillStoreV1.Service
            const facts: VerifiedFact[] = []
            let candidate: ExperienceStoreV1.CandidateProjection | undefined
            for (let index = 0; index < 3; index++) {
              const fact = yield* verifiedFact({
                suffix: `experience_${index}`,
                candidateArtifactDigest: "a".repeat(64),
              })
              facts.push(fact)
              candidate = yield* experience.recordVerifiedSupport({
                identity,
                ...fact,
                evidence: [fact.evidence],
                problemSignature: "release verification is incomplete",
                applicableScope: "workspace release workflow",
                conditions: ["release requested", "verification required"],
                attemptedStrategy: "run deterministic release verification",
                summary: `verified release support ${index}`,
                policyVersion: "experience-policy-v1",
              })
            }
            if (!candidate) return yield* Effect.die(new Error("Experience candidate was not created"))
            expect(candidate.supportCount).toBe(3)
            expect(candidate.status).toBe("candidate")

            const knownEvidenceID = facts[0]!.evidence.id
            const missingEvidenceID = AgentRuntime.EvidenceID.make("evd_stage7_missing")
            const resolved = yield* experience.resolveEvidenceIDs(identity, [knownEvidenceID, missingEvidenceID])
            expect(resolved.present).toEqual([knownEvidenceID])
            expect(resolved.missing).toEqual([missingEvidenceID])
            expect(resolved.valid).toBe(false)
            const foreign = yield* experience.resolveEvidenceIDs(
              { ...identity, tenantID: "ten_stage7_other" },
              [knownEvidenceID],
            )
            expect(foreign.present).toEqual([])
            expect(foreign.missing).toEqual([knownEvidenceID])
            expect(foreign.valid).toBe(false)

            const exactSupport = yield* experience.recordVerifiedSupport({
              identity,
              ...facts[0]!,
              evidence: [facts[0]!.evidence],
              problemSignature: "release verification is incomplete",
              applicableScope: "workspace release workflow",
              conditions: ["release requested", "verification required"],
              attemptedStrategy: "run deterministic release verification",
              summary: "verified release support 0",
              policyVersion: "experience-policy-v1",
            })
            expect(exactSupport.revision).toBe(candidate.revision)
            const drift = yield* experience
              .recordVerifiedSupport({
                identity,
                ...facts[0]!,
                evidence: [facts[0]!.evidence],
                problemSignature: "release verification is incomplete",
                applicableScope: "workspace release workflow",
                conditions: ["changed condition"],
                attemptedStrategy: "run deterministic release verification",
                summary: "verified release support 0",
                policyVersion: "experience-policy-v1",
              })
              .pipe(Effect.flip)
            expect(drift._tag).toBe("ExperienceStore.Conflict")

            const evaluated = yield* experience.recordEvaluation({
              identity,
              candidateID: candidate.candidateID,
              expectedRevision: candidate.revision,
              observations: replayObservations(candidate.digest),
            })
            const promotedExperience = yield* experience.review({
              identity,
              candidateID: evaluated.candidateID,
              expectedRevision: evaluated.revision,
              decision: "approve",
              reason: "three distinct verified Runs and offline replay passed",
            })
            expect(promotedExperience.candidate.status).toBe("active")
            expect(promotedExperience.experiences).toHaveLength(3)
            expect(promotedExperience.experiences.every((item) => item.reusable)).toBe(true)
            expect((yield* experience.verifyAudit(identity, candidate.candidateID)).valid).toBe(true)

            const sourceExperienceIDs = promotedExperience.experiences.map((item) => item.id)
            const listedSources = yield* experience.listSources(identity)
            expect(listedSources.map((item) => item.experienceID).toSorted()).toEqual(sourceExperienceIDs.toSorted())
            expect(listedSources.every((item) => item.candidateID === candidate.candidateID)).toBe(true)
            expect(
              listedSources.every((item) => item.evidenceCount > 0 && /^[a-f0-9]{64}$/.test(item.recordDigest)),
            ).toBe(true)
            const firstCandidate = yield* skills.createCandidate(
              skillInput(
                "1.0.0",
                sourceExperienceIDs,
                "# Release verification\n\nEvaluate the bounded release checks and report the result.",
              ),
            )
            expect(firstCandidate.skill.status).toBe("candidate")
            expect(firstCandidate.skill.sourceExperienceIDs).toEqual(sourceExperienceIDs.toSorted())
            const firstActive = yield* promoteSkill(firstCandidate, "v1")
            expect(firstActive.candidate.skill.status).toBe("active")

            const expansion = yield* skills
              .createCandidate({
                ...skillInput(
                  "1.0.1",
                  sourceExperienceIDs,
                  "# Expanded release verification\n\nAttempt a forbidden permission expansion.",
                ),
                allowedTools: ["shell"],
              })
              .pipe(Effect.flip)
            if (expansion._tag !== "SkillStore.Error") throw new Error("expected permission expansion rejection")
            expect(expansion.reason).toContain("expands tools or capabilities")

            const secondCandidate = yield* skills.createCandidate(
              skillInput(
                "1.1.0",
                sourceExperienceIDs,
                "# Release verification\n\nEvaluate bounded release checks with the revised deterministic order.",
              ),
            )
            expect(secondCandidate.baselineCandidateID).toBe(firstCandidate.candidateID)
            const secondActive = yield* promoteSkill(secondCandidate, "v2")
            expect(secondActive.deployment.previousCandidateID).toBe(firstCandidate.candidateID)

            const rollbackReason = "canary follow-up detected a deterministic product regression"
            const rolledBack = yield* skills.rollback({
              identity,
              candidateID: secondCandidate.candidateID,
              expectedRevision: secondActive.candidate.revision,
              reason: rollbackReason,
            })
            expect(rolledBack.rolledBack.skill.status).toBe("retired")
            expect(rolledBack.restored.skill.status).toBe("active")
            expect(rolledBack.restored.candidateID).toBe(firstCandidate.candidateID)
            expect(rolledBack.deployment.activeCandidateID).toBe(firstCandidate.candidateID)
            const rollbackReplay = yield* skills.rollback({
              identity,
              candidateID: secondCandidate.candidateID,
              expectedRevision: secondActive.candidate.revision,
              reason: rollbackReason,
            })
            expect(rollbackReplay.receiptDigest).toBe(rolledBack.receiptDigest)
            const rollbackDrift = yield* skills
              .rollback({
                identity,
                candidateID: secondCandidate.candidateID,
                expectedRevision: secondActive.candidate.revision,
                reason: "different rollback request",
              })
              .pipe(Effect.flip)
            expect(rollbackDrift._tag).toBe("SkillStore.Conflict")
            expect((yield* skills.verifyAudit(identity, secondCandidate.candidateID)).valid).toBe(true)

            const other = {
              tenantID: "ten_stage7_other",
              userID: "usr_stage7_other",
              actor: "user:usr_stage7_other",
            }
            expect(yield* skills.listCandidates(other)).toEqual([])
            expect(yield* experience.listCandidates(other)).toEqual([])
            expect(yield* experience.listSources(other)).toEqual([])
            const hidden = yield* skills.getCandidate(other, firstCandidate.candidateID).pipe(Effect.flip)
            expect(hidden._tag).toBe("SkillStore.NotFound")
          }),
        )
      }),
  )

  it.effect("keeps owner-scoped EvidenceID existence after a SQLite owner restart", Effect.promise(async () => {
    const temporary = await tmpdir()
    const ownedRoot = await realpath(temporary.path)
    const databasePath = join(ownedRoot, "evidence-resolver.sqlite")
    const evidence = EvidenceV2.create({
      evidenceID: AgentRuntime.EvidenceID.make("evd_stage7_restart"),
      sourceID: "verifier:stage7-restart",
      contentDigest: "sha256:" + "c".repeat(64),
      extractionMethod: "verifier-registry",
      extractionVersion: "stage7",
      runID: AgentRuntime.RunID.make("run_stage7_restart"),
      actionID: AgentRuntime.ActionID.make("act_stage7_restart"),
      observationIDs: [AgentRuntime.ObservationID.make("obs_stage7_restart")],
      trust: "verified",
      instructionAllowed: false,
      sensitivity: "internal",
      verificationStatus: "verified",
      summary: "Restart resolver fixture",
    })
    const record = Schema.encodeUnknownSync(AgentRuntime.Evidence)(evidence)
    const recordDigest = canonicalHash(record)
    if (!recordDigest) throw new Error("restart Evidence fixture is not canonicalizable")
    const corruptEvidenceID = AgentRuntime.EvidenceID.make("evd_stage7_corrupt")
    try {
      const input = { identity, record, recordDigest, corruptEvidenceID }
      const first = await restartEvidenceOwner(databasePath, "seed", input)
      const firstRead = first.read
      expect(firstRead.valid).toBe(true)
      expect(firstRead.present).toEqual([evidence.id])
      const firstFacts = first.facts
      expect(firstFacts.resolution).toEqual(firstRead)
      expect(firstFacts.recordDigests).toEqual([{ evidenceID: evidence.id, recordDigest }])

      // Each call awaits natural exit before the next process opens the same file.
      const second = await restartEvidenceOwner(databasePath, "read", input)
      expect(second.pid).not.toBe(first.pid)
      const secondRead = second.read
      expect(secondRead).toEqual(firstRead)
      const secondFacts = second.facts
      expect(secondFacts).toEqual(firstFacts)
      const foreignRead = second.foreign
      expect(foreignRead.valid).toBe(false)
      expect(foreignRead.present).toEqual([])
      expect(foreignRead.missing).toEqual([evidence.id])
      expect(second.corruptionTag).toBe("ExperienceStore.Error")
    } finally {
      // Verify this exact resolved owned root before the existing native helper deletes it.
      expect(isAbsolute(ownedRoot)).toBe(true)
      expect(basename(ownedRoot)).toMatch(/^arforge-core-test-[A-Za-z0-9]+$/)
      expect(await realpath(temporary.path)).toBe(ownedRoot)
      await temporary[Symbol.asyncDispose]()
    }
    expect(existsSync(ownedRoot)).toBe(false)
  }))
})

async function restartEvidenceOwner(
  databasePath: string,
  mode: "seed" | "read",
  input: { identity: typeof identity; record: unknown; recordDigest: string; corruptEvidenceID: AgentRuntime.EvidenceID },
): Promise<{
  pid: number
  read: EvidenceV2.ReferenceResolution
  facts: EvidenceV2.ReferenceResolutionFacts
  foreign: EvidenceV2.ReferenceResolution
  corruptionTag: string
}> {
  const worker = Bun.spawn([
    process.execPath, fileURLToPath(new URL("./fixture/stage7-experience-restart-worker.ts", import.meta.url)),
    databasePath, mode,
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  worker.stdin.write(JSON.stringify(input))
  worker.stdin.end()
  const [code, output, error] = await Promise.all([
    worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(error).toBe("")
  const result = JSON.parse(output.trim())
  expect(result.pid).toBe(worker.pid)
  expect(result.pid).not.toBe(process.pid)
  return result
}
