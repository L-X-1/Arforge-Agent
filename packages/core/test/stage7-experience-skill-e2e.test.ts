import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { join } from "node:path"
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

const reopenedExperienceLayer = (databasePath: string) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      DurableAction.globalNode,
      DurableRun.globalNode,
      RuntimeEvaluation.node,
      LearningV2.node,
      ExperienceStoreV1.node,
    ]),
    [
      [Database.node, Database.layerFromPath(databasePath)],
      [Location.node, current],
    ],
  )

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
  let current = yield* skills.startCanary({
    identity,
    candidateID: candidate.candidateID,
    expectedRevision: evaluation.candidate.revision,
    trafficPercent: 100,
    reason: `approve bounded canary ${suffix}`,
  })
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
    const databasePath = join(temporary.path, "evidence-resolver.sqlite")
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
      const seedLayer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
        [Database.node, Database.layerFromPath(databasePath)],
      ])
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* Database.Service
            yield* database.db
              .insert(ExperienceEvidenceTable)
              .values({
                tenant_id: identity.tenantID,
                owner_user_id: identity.userID,
                id: evidence.id,
                run_id: evidence.runID!,
                action_id: evidence.actionID!,
                observation_id: evidence.observationIDs![0]!,
                record_digest: recordDigest,
                record,
                time_created: 1_725_000_000_000,
                time_updated: 1_725_000_000_000,
              })
              .run()
              .pipe(Effect.orDie)
            yield* database.db
              .insert(ExperienceEvidenceTable)
              .values({
                tenant_id: identity.tenantID,
                owner_user_id: identity.userID,
                id: corruptEvidenceID,
                run_id: evidence.runID!,
                action_id: evidence.actionID!,
                observation_id: evidence.observationIDs![0]!,
                // The row deliberately points at a valid payload while its
                // digest and primary ID disagree. Resolution must fail closed
                // instead of treating this as an existing reference.
                record_digest: "0".repeat(64),
                record,
                time_created: 1_725_000_000_001,
                time_updated: 1_725_000_000_001,
              })
              .run()
              .pipe(Effect.orDie)
          }).pipe(Effect.provide(seedLayer)),
        ),
      )

      const firstRead = await yieldResolver(databasePath, identity, evidence.id)
      expect(firstRead.valid).toBe(true)
      expect(firstRead.present).toEqual([evidence.id])
      const firstFacts = await yieldResolverFacts(databasePath, identity, evidence.id)
      expect(firstFacts.resolution).toEqual(firstRead)
      expect(firstFacts.recordDigests).toEqual([{ evidenceID: evidence.id, recordDigest }])

      const secondRead = await yieldResolver(databasePath, identity, evidence.id)
      expect(secondRead).toEqual(firstRead)
      const secondFacts = await yieldResolverFacts(databasePath, identity, evidence.id)
      expect(secondFacts).toEqual(firstFacts)
      const foreignRead = await yieldResolver(databasePath, { ...identity, userID: "usr_stage7_other" }, evidence.id)
      expect(foreignRead.valid).toBe(false)
      expect(foreignRead.present).toEqual([])
      expect(foreignRead.missing).toEqual([evidence.id])

      const corruption = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const experience = yield* ExperienceStoreV1.Service
            return yield* experience.resolveEvidenceIDs(identity, [corruptEvidenceID]).pipe(Effect.flip)
          }).pipe(Effect.provide(reopenedExperienceLayer(databasePath))),
        ),
      )
      expect(corruption._tag).toBe("ExperienceStore.Error")
    } finally {
      await temporary[Symbol.asyncDispose]()
    }
  }))
})

function yieldResolver(
  databasePath: string,
  owner: typeof identity,
  evidenceID: AgentRuntime.EvidenceID,
): Promise<EvidenceV2.ReferenceResolution> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const experience = yield* ExperienceStoreV1.Service
        return yield* experience.resolveEvidenceIDs(owner, [evidenceID])
      }).pipe(Effect.provide(reopenedExperienceLayer(databasePath))),
    ),
  )
}

function yieldResolverFacts(
  databasePath: string,
  owner: typeof identity,
  evidenceID: AgentRuntime.EvidenceID,
): Promise<EvidenceV2.ReferenceResolutionFacts> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const experience = yield* ExperienceStoreV1.Service
        return yield* experience.resolveEvidenceFacts(owner, [evidenceID])
      }).pipe(Effect.provide(reopenedExperienceLayer(databasePath))),
    ),
  )
}
