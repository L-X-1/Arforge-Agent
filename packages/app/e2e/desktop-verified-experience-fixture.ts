import { AgentV2 } from "@arforge-ai/core/agent"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { ExperienceStoreV1 } from "@arforge-ai/core/experience-store"
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
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect, Layer } from "effect"

const identity = {
  tenantID: "ten_local",
  userID: "usr_local",
  actor: "user:usr_local",
}

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

const replayObservations = (candidateDigest: string) => {
  const dataset = {
    id: "desktop-experience-replay",
    revision: "1",
    source: "recorded" as const,
    caseIDs: ["desktop-a", "desktop-b", "desktop-c"],
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

export async function seedDesktopVerifiedExperience(input: { databasePath: string; workspace: string }) {
  const directory = AbsolutePath.make(input.workspace)
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
    ]),
    [
      [Database.node, Database.layerFromPath(input.databasePath)],
      [Location.node, current],
    ],
  )

  const program = Effect.gen(function* () {
    const runs = yield* DurableRun.Service
    const actions = yield* DurableAction.Service
    const gateway = yield* ActionGateway.Service
    const evaluations = yield* RuntimeEvaluation.Service
    const experiences = yield* ExperienceStoreV1.Service
    let candidate: ExperienceStoreV1.CandidateProjection | undefined

    for (let index = 0; index < 3; index++) {
      const suffix = `desktop_source_${index}`
      const sessionID = SessionSchema.ID.make(`ses_${suffix}`)
      const runID = AgentRuntime.RunID.make(`run_${suffix}`)
      const created = yield* runs.create({
        id: runID,
        sessionID,
        initiator: "user",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: `desktop verified Experience fixture ${index}`,
        budget,
        traceID: `trace-${suffix}`,
        visibility: "audit",
      })
      yield* runs.transition({ runID: created.run.id, to: "preflight", reason: "fixture preflight" })
      yield* runs.transition({ runID: created.run.id, to: "queued", reason: "fixture queued" })
      yield* runs.transition({ runID: created.run.id, to: "running", reason: "fixture running" })

      const context = {
        sessionID,
        assistantMessageID: SessionMessage.ID.make(`msg_${suffix}`),
        toolCallID: `call-${suffix}`,
      }
      const actionID = ActionGateway.stableActionID(context)
      yield* gateway.execute(
        {
          ...context,
          actionID,
          runID,
          agent: AgentV2.ID.make("build"),
          name: "shell",
          resources: [`fixture:${suffix}`],
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
          inputDigest: canonicalHash({ suffix })!,
        },
        { execute: () => Effect.succeed({ exitCode: 0 }) },
      )
      const action = yield* actions.load(actionID)
      if (!action.observation) return yield* Effect.die(new Error("settled fixture Action has no Observation"))
      const observation = action.observation
      yield* runs.transition({ runID, to: "verifying", reason: "independent verifier running" })

      const verification = yield* Effect.promise(() =>
        createDefaultVerifierRegistry().verify(
          freezeVerifierInput({
            frozenIntent: {
              actionKind: "shell",
              actionVersion: "1",
              intentDigest: canonicalHash({ actionID, suffix })!,
              payload: { commandClass: "deterministic-fixture", suffix },
            },
            observation: {
              status: observation.status,
              observationDigest: canonicalHash(observation)!,
              summary: observation.summary,
              values: { exitCode: 0 },
            },
            artifactRefs: [{ kind: "fixture", ref: `fixture://${suffix}`, digest: "a".repeat(64) }],
            runID,
            actionID,
            observationID: observation.id,
          }),
        ),
      )
      if (!verification.evaluation.passed) return yield* Effect.die(new Error("fixture verifier did not pass"))

      const now = Date.now()
      const evaluationID = AgentRuntime.EvaluationID.make(`eva_${suffix}`)
      yield* evaluations.create({
        id: evaluationID,
        runID,
        suiteID: "desktop-verifier-e2e",
        suiteRevision: 1,
        caseID: suffix,
        caseRevision: 1,
        baselineArtifactDigest: "0".repeat(64),
        candidateArtifactDigest: "a".repeat(64),
        environmentDigest: "1".repeat(64),
        toolchainDigest: "2".repeat(64),
        sampleSize: 1,
        score: 1,
        successDelta: 1,
        costDelta: 0,
        latencyDelta: 0,
        passed: true,
        metrics: {
          assertions: verification.evaluation.total,
          safety_incidents: 0,
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

      candidate = yield* experiences.recordVerifiedSupport({
        identity,
        runID,
        actionID,
        evaluationID,
        evidence: [verification.evidence],
        problemSignature: "desktop evidence review needs reusable verification guidance",
        applicableScope: "desktop Skill lifecycle acceptance",
        conditions: ["a bounded review is requested", "verified evidence is available"],
        attemptedStrategy: "review deterministic evidence before a controlled transition",
        summary: `Verified desktop review guidance ${index + 1}`,
        policyVersion: "experience-policy-v1",
      })
    }

    if (!candidate) return yield* Effect.die(new Error("fixture Experience candidate was not created"))
    const evaluated = yield* experiences.recordEvaluation({
      identity,
      candidateID: candidate.candidateID,
      expectedRevision: candidate.revision,
      observations: replayObservations(candidate.digest),
    })
    const promoted = yield* experiences.review({
      identity,
      candidateID: evaluated.candidateID,
      expectedRevision: evaluated.revision,
      decision: "approve",
      reason: "desktop fixture has three verified Runs and passed offline replay",
    })
    if (promoted.experiences.length !== 3)
      return yield* Effect.die(new Error("fixture did not produce three reusable Experience records"))
    return promoted.experiences.map((item) => String(item.id))
  })

  return Effect.runPromise(program.pipe(Effect.provide(layer)))
}
