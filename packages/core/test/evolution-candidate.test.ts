import { describe, expect } from "bun:test"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionID } from "@arforge-ai/schema/session-id"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Database } from "@arforge-ai/core/database/database"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Authorizer } from "@arforge-ai/core/authorizer"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as RuntimeEvaluation from "@arforge-ai/core/runtime/evaluation"
import { EventV2 } from "@arforge-ai/core/event"
import { DurableEvolutionV1 } from "@arforge-ai/core/evolution/durable"
import { EvolutionCandidateV1, EvolutionV2 } from "@arforge-ai/core/evolution"
import * as EvolutionExposureV1 from "@arforge-ai/core/evolution/exposure"
import { ExperienceStoreV1 } from "@arforge-ai/core/experience-store"
import { ExperienceRecordTable } from "@arforge-ai/core/experience-store/sql"
import { GovernedEvolutionV1 } from "@arforge-ai/core/evolution/governed"
import {
  EvolutionArtifactTable,
  EvolutionAuditTable,
  EvolutionEvaluationTable,
  EvolutionProposalTable,
} from "@arforge-ai/core/evolution/sql"
import { EvaluationResultTable } from "@arforge-ai/core/runtime/sql"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { testEffect } from "./lib/effect"

const identity = { tenantID: "ten_candidate", userID: "usr_candidate", actor: "user:usr_candidate" }

const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const secretLayer = Layer.succeed(
  SecretProvider.Service,
  SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(19), "candidate-evolution-test"),
)
const directory = AbsolutePath.make("C:/workspaces/evolution-candidate")
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
    Authorizer.node,
    ActionGateway.node,
    ControlClaimIndex.node,
    DurableEvolutionV1.node,
    GovernedEvolutionV1.node,
    EvolutionExposureV1.node,
    LearningV2.node,
    ExperienceStoreV1.node,
    EvolutionCandidateV1.node,
    EvolutionV2.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [PermissionV2.node, permissionLayer],
    [SecretProvider.node, secretLayer],
    [Location.node, current],
  ],
)
const it = testEffect(layer)

const runWithApproval = <A, R>(
  events: EventV2.Interface,
  authorizer: Authorizer.Interface,
  action: Effect.Effect<A, unknown, R>,
) =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<AgentRuntime.ControlRequest>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === AgentRuntime.ControlEvent.Asked.type
        ? Deferred.succeed(asked, Schema.decodeUnknownSync(AgentRuntime.ControlRequest)(event.data)).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* action.pipe(Effect.forkScoped)
    const signal = yield* Effect.race(
      Deferred.await(asked).pipe(Effect.map((request) => ({ _tag: "Approval" as const, request }))),
      Fiber.await(fiber).pipe(Effect.map((exit) => ({ _tag: "Settled" as const, exit }))),
    )
    if (signal._tag === "Settled") {
      if (Exit.isFailure(signal.exit)) return yield* Effect.failCause(signal.exit.cause)
      return signal.exit.value
    }
    yield* authorizer.reply({ requestID: signal.request.id, reply: "once" })
    return yield* Fiber.join(fiber)
  })

describe("EvolutionCandidateV1", () => {
  it.live("uses DB projections, deterministic retries, CAS, and governed lifecycle mutations", () =>
    Effect.gen(function* () {
      const evolution = yield* EvolutionCandidateV1.Service
      const events = yield* EventV2.Service
      const authorizer = yield* Authorizer.Service
      const database = yield* Database.Service

      const createInput = {
        identity,
        requestID: "candidate-create-1",
        traceID: "candidate-create-trace",
        title: "Bounded retry advice",
        target: "learning.failure",
        instruction: "Diagnose the underlying cause before retrying.",
        rationale: "Repeated failures have verified evidence.",
        evidenceRefs: ["learning-pattern:failure-1"],
      }
      const created = yield* runWithApproval(events, authorizer, evolution.createCandidate(createInput))
      expect(created.candidate_id).toMatch(/^ev-[0-9a-f]{16}$/)
      expect(created.state.status).toBe("proposed")
      expect(created.state.revision).toBe(1)
      expect(created.created_by).toBe(identity.actor)
      expect(created.evolution_level).toBe("L2")
      expect(created.state.evolution_level).toBe("L2")
      Schema.decodeUnknownSync(AgentCapability.EvolutionCandidate)(created)
      const levelStatus = yield* evolution.status(identity)
      expect(levelStatus).toMatchObject({
        evolution_levels: {
          version: "1.0",
          levels: {
            L0: { executable: true },
            L4: { executable: true },
            L5: { executable: false },
          },
        },
      })
      Schema.decodeUnknownSync(AgentCapability.EvolutionStatus)(levelStatus)

      const repeated = yield* evolution.createCandidate({ ...createInput, requestID: "candidate-create-retry" })
      expect(repeated).toEqual(created)

      const evaluated = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: created.state.revision,
          action: "evaluate",
          reason: "evaluate immutable candidate artifact",
        }),
      )
      expect(evaluated.state.status).toBe("evaluated")
      expect(evaluated.state.revision).toBe(2)
      expect(evaluated.state.evolution_level).toBe("L2")
      expect(evaluated.evaluation?.gate_passed).toBe(true)
      expect(
        yield* evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: created.state.revision,
          action: "evaluate",
          reason: "evaluate immutable candidate artifact",
        }),
      ).toEqual(evaluated)

      const approved = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: evaluated.state.revision,
          action: "approve",
          reason: "human approval after isolated evaluation",
        }),
      )
      expect(approved.state.status).toBe("approved")
      expect(approved.state.evolution_level).toBe("L2")
      expect(
        yield* evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: evaluated.state.revision,
          action: "approve",
          reason: "human approval after isolated evaluation",
        }),
      ).toEqual(approved)

      const canary = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: approved.state.revision,
          action: "startCanary",
          reason: "start bounded canary",
          trafficPercent: 10,
        }),
      )
      expect(canary.state.status).toBe("canary")
      expect(canary.state.evolution_level).toBe("L3")
      expect(
        yield* evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: approved.state.revision,
          action: "startCanary",
          reason: "start bounded canary",
          trafficPercent: 10,
        }),
      ).toEqual(canary)

      const rolledBack = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: canary.state.revision,
          action: "rollback",
          reason: "rollback before promotion while observations are incomplete",
        }),
      )
      expect(rolledBack.state.status).toBe("rolled_back")
      expect(rolledBack.state.evolution_level).toBe("L2")
      expect(
        yield* evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: canary.state.revision,
          action: "rollback",
          reason: "rollback before promotion while observations are incomplete",
        }),
      ).toEqual(rolledBack)

      const status = yield* evolution.status(identity)
      expect(status).toMatchObject({ total: 1, active: 0 })
      expect((yield* database.db.select().from(EvolutionProposalTable).all()).length).toBe(1)
    }),
  )

  it.live("converges Core Learning evidence through bound automatic candidate runs only", () =>
    Effect.gen(function* () {
      const evolution = yield* EvolutionCandidateV1.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const automaticIdentity = {
        tenantID: "ten_learning",
        userID: "usr_learning",
        actor: "system:core-learning",
      }
      let approvalRequests = 0
      let automaticDecisions = 0
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === AgentRuntime.ControlEvent.Asked.type) approvalRequests += 1
          if (
            event.type === AgentRuntime.Event.ActionPolicyEvaluated.type &&
            typeof event.data === "object" &&
            event.data !== null &&
            "decision" in event.data &&
            typeof event.data.decision === "object" &&
            event.data.decision !== null &&
            "authority" in event.data.decision &&
            event.data.decision.authority === "automatic"
          )
            automaticDecisions += 1
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const eligible = {
        id: "failure-pattern-automatic-1",
        type: "failure",
        description: "Repeated retries hide the root cause.",
        frequency: 4,
        confidence: 0.9,
      }
      const result = yield* evolution.syncLearningPatterns(automaticIdentity, [
        eligible,
        { ...eligible, id: "low-confidence", confidence: 0.2 },
        { ...eligible, id: "invalid-frequency", frequency: 0 },
      ])
      expect(result).toMatchObject({ schema_version: 1, seen: 3, created: 1, existing: 0, skipped: 1, failed: 1 })
      expect(result.items[0]?.evaluation).toMatchObject({ status: "evaluated", gate_passed: true })
      expect(approvalRequests).toBe(0)
      expect(automaticDecisions).toBe(2)

      const candidateID = result.items[0]?.candidate_id ?? ""
      const candidate = yield* evolution.getCandidate(automaticIdentity, candidateID)
      expect(candidate).toMatchObject({
        created_by: "system:core-learning",
        state: { status: "evaluated", approval: null, deployment: null, rollback: null },
      })
      const repeated = yield* evolution.syncLearningPatterns(automaticIdentity, [
        { ...eligible, description: "Later mutable pattern text must not replace the immutable candidate artifact." },
      ])
      expect(repeated).toMatchObject({ seen: 1, created: 0, existing: 1, skipped: 0, failed: 0 })
      expect(repeated.items[0]?.evaluation).toMatchObject({ status: "already_evaluated", gate_passed: true })
      expect(repeated.items[0]?.candidate_id).toBe(candidateID)
      expect((yield* evolution.getCandidate(automaticIdentity, candidateID)).instruction).toContain(
        "Repeated retries hide the root cause.",
      )
      expect(approvalRequests).toBe(0)
      expect((yield* database.db.select().from(EvolutionProposalTable).all()).length).toBe(1)

      const forged = yield* evolution
        .syncLearningPatterns({ ...automaticIdentity, actor: "user:usr_learning" }, [eligible])
        .pipe(Effect.exit)
      expect(forged._tag).toBe("Failure")
    }),
  )

  it.live("routes the default EvolutionV2 facade into the request principal DB partition", () =>
    Effect.gen(function* () {
      const evolution = yield* EvolutionV2.Service
      const database = yield* Database.Service
      const principal = { tenantID: "ten_facade", userID: "usr_facade" }
      const result = yield* database.runAsPrincipal(
        principal,
        evolution.syncLearningPatterns([
          {
            id: "facade-pattern-1",
            type: "fix",
            description: "Apply the verified fix before repeating the same command.",
            frequency: 3,
            confidence: 0.8,
          },
        ]),
      )
      expect(result).toMatchObject({ seen: 1, created: 1, failed: 0 })
      expect(result.items[0]?.evaluation).toMatchObject({ status: "evaluated", gate_passed: true })
      const rows = yield* database.db.select().from(EvolutionProposalTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        tenant_id: principal.tenantID,
        owner_user_id: principal.userID,
        created_by: "system:core-learning",
        status: "sandbox_evaluation",
      })
    }),
  )

  it.live("promotes only after real candidate and control observations pass the canary gate", () =>
    Effect.gen(function* () {
      const evolution = yield* EvolutionCandidateV1.Service
      const exposures = yield* EvolutionExposureV1.Service
      const durable = yield* DurableEvolutionV1.Service
      const events = yield* EventV2.Service
      const authorizer = yield* Authorizer.Service
      const database = yield* Database.Service
      const runs = yield* DurableRun.Service
      const actions = yield* DurableAction.Service
      const gateway = yield* ActionGateway.Service
      const evaluations = yield* RuntimeEvaluation.Service
      const experienceStore = yield* ExperienceStoreV1.Service

      const sourceRunID = AgentRuntime.RunID.make("run_promotion_e2e_1")
      const sourceEvidenceID = AgentRuntime.EvidenceID.make("evd_promotion_e2e_1")
      const sourceEvaluationID = AgentRuntime.EvaluationID.make("eva_promotion_e2e_1")
      const sourceTime = 1_786_579_200_000
      const sourceEvaluation = yield* database.runAsPrincipal(
        identity,
        Effect.gen(function* () {
          yield* runs.create({
            id: sourceRunID,
            sessionID: SessionID.make("ses_promotion_e2e_1"),
            initiator: "user",
            authority: "automatic",
            riskTier: "L0",
            reasonSummary: "produce verifier-backed promotion source evidence",
            budget: AgentRuntime.Budget.make({
              maxAttempts: 1,
              maxDurationMs: 120_000,
              maxCostMicros: 1,
              maxTokens: 1_000_000,
              attemptsUsed: 0,
              durationMsUsed: 0,
              costMicrosUsed: 0,
              tokensUsed: 0,
            }),
            traceID: "trace-promotion-source",
            visibility: "audit",
          })
          yield* runs.transition({ runID: sourceRunID, to: "preflight", reason: "source preflight passed" })
          yield* runs.transition({ runID: sourceRunID, to: "queued", reason: "source action queued" })
          yield* runs.transition({ runID: sourceRunID, to: "running", reason: "source action started" })
          const context = {
            sessionID: SessionID.make("ses_promotion_e2e_1"),
            assistantMessageID: SessionMessage.ID.make("msg_promotion_source"),
            toolCallID: "call-promotion-source",
          }
          const actionID = ActionGateway.stableActionID(context)
          yield* gateway.execute(
            {
              ...context,
              actionID,
              runID: sourceRunID,
              agent: AgentV2.ID.make("build"),
              name: "shell",
              resources: ["fixture:promotion-source"],
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
                successCriteria: ["source fixture succeeds"],
              }),
              reasonSummary: "produce promotion source observation",
              inputDigest: canonicalHash({ sourceRunID, actionID })!,
            },
            { execute: () => Effect.succeed({ exitCode: 0 }) },
          )
          const action = yield* actions.load(actionID)
          if (!action.observation) return yield* Effect.die(new Error("promotion source action has no observation"))
          yield* runs.transition({ runID: sourceRunID, to: "verifying", reason: "independent verifier ran" })
          yield* runs.transition({ runID: sourceRunID, to: "completed", reason: "independent verifier passed" })
          return yield* evaluations.create({
            id: sourceEvaluationID,
            runID: sourceRunID,
            suiteID: "evolution-source",
            suiteRevision: 1,
            caseID: "promotion-source",
            caseRevision: 1,
            baselineArtifactDigest: "a".repeat(64),
            candidateArtifactDigest: "b".repeat(64),
            environmentDigest: "c".repeat(64),
            toolchainDigest: "d".repeat(64),
            sampleSize: 1,
            score: 1,
            successDelta: 1,
            costDelta: 0,
            latencyDelta: 0,
            passed: true,
            metrics: { verifier_passed: 1 },
            evidenceIDs: [sourceEvidenceID],
            createdAt: sourceTime,
            evaluatedAt: sourceTime,
          })
        }),
      )
      const sourceEvidence = AgentRuntime.Evidence.make({
        id: sourceEvidenceID,
        source: "verifier:promotion-source:1",
        sourceDigest: "e".repeat(64),
        contentDigest: "e".repeat(64),
        trust: "verified",
        instructionAllowed: false,
        summary: "Independent promotion source verifier passed",
        capturedAt: DateTime.makeUnsafe(sourceTime),
        extractionMethod: "verifier-registry",
        extractionVersion: "1",
        observationIDs: [AgentRuntime.ObservationID.make("obs_promotion_e2e_1")],
        runID: sourceRunID,
        actionID: AgentRuntime.ActionID.make("act_promotion_e2e_1"),
        sensitivity: "internal",
        verificationStatus: "verified",
      })
      const sourceExperience = AgentRuntime.ExperienceRecord.make({
        id: AgentRuntime.ExperienceID.make("exp_promotion_e2e_1"),
        runID: sourceRunID,
        outcome: "success",
        summary: "Verified promotion source outcome",
        evidenceIDs: [sourceEvidenceID],
        reusable: true,
        createdAt: DateTime.makeUnsafe(sourceTime),
      })
      const sourceActionID = AgentRuntime.ActionID.make(
        ActionGateway.stableActionID({
          sessionID: SessionID.make("ses_promotion_e2e_1"),
          assistantMessageID: SessionMessage.ID.make("msg_promotion_source"),
          toolCallID: "call-promotion-source",
        }),
      )
      const sourceAction = yield* actions.load(sourceActionID)
      if (!sourceAction.observation) return yield* Effect.die(new Error("promotion source action has no observation"))
      const boundSourceEvidence = AgentRuntime.Evidence.make({
        ...sourceEvidence,
        observationIDs: [sourceAction.observation.id],
        actionID: sourceActionID,
      })
      yield* experienceStore.recordVerifiedEvidence({
        identity,
        runID: sourceRunID,
        actionID: sourceActionID,
        evaluationID: sourceEvaluationID,
        evidence: [boundSourceEvidence],
      })
      yield* database.db
        .insert(ExperienceRecordTable)
        .values({
          tenant_id: identity.tenantID,
          owner_user_id: identity.userID,
          id: sourceExperience.id,
          candidate_id: "fixture-promotion-source",
          support_id: "fixture-promotion-source",
          run_id: sourceRunID,
          action_id: sourceActionID,
          evaluation_id: sourceEvaluationID,
          evidence_ids: [sourceEvidenceID],
          record_digest: canonicalHash(Schema.encodeUnknownSync(AgentRuntime.ExperienceRecord)(sourceExperience))!,
          record: Schema.encodeUnknownSync(AgentRuntime.ExperienceRecord)(sourceExperience),
          policy_version: "arforge-experience/1",
          promoted_by: identity.actor,
        })
        .run()
        .pipe(Effect.orDie)

      const created = yield* runWithApproval(
        events,
        authorizer,
        evolution.createCandidate({
          identity,
          requestID: "candidate-promotion-create",
          traceID: "candidate-promotion-create-trace",
          title: "Promotion evidence advice",
          target: "tool.advice",
          instruction: "Verify the tool result before reporting completion.",
          rationale: "Verified outcomes justify a bounded candidate/control experiment.",
          evidenceRefs: ["experience:promotion-e2e-1"],
          sourceExperienceIDs: ["exp_promotion_e2e_1"],
          sourceEvidenceIDs: ["evd_promotion_e2e_1"],
        }),
      )
      const evaluated = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: created.state.revision,
          action: "evaluate",
          reason: "run deterministic isolated evaluation",
        }),
      )
      const approved = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: evaluated.state.revision,
          action: "approve",
          reason: "human approves the evaluated candidate",
        }),
      )
      const canary = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: approved.state.revision,
          action: "startCanary",
          reason: "start a balanced evidence-producing canary",
          trafficPercent: 50,
        }),
      )

      const keys = { candidate: [] as string[], control: [] as string[] }
      for (let index = 0; (keys.candidate.length < 5 || keys.control.length < 5) && index < 10_000; index++) {
        const key = `promotion-cohort-${index}`
        const bucket =
          Number.parseInt(canonicalHash({ candidateID: created.candidate_id, cohortKey: key })!.slice(0, 8), 16) % 100
        keys[bucket < 50 ? "candidate" : "control"].push(key)
      }
      expect(keys.candidate.length).toBeGreaterThanOrEqual(5)
      expect(keys.control.length).toBeGreaterThanOrEqual(5)

      for (const cohort of ["candidate", "control"] as const) {
        for (const [index, cohortKey] of keys[cohort].slice(0, 5).entries()) {
          const prepared = yield* exposures.prepare({
            identity,
            userInput: `promotion observation ${cohort} ${index}`,
            cohortKey,
          })
          expect(prepared.exposureID).toBeDefined()
          expect(prepared.injectedCandidateIDs.includes(created.candidate_id)).toBe(cohort === "candidate")
          yield* exposures.recordOutcome({
            identity,
            exposureID: prepared.exposureID!,
            success: true,
            stopReason: "verified completion",
            assistantMessageID: `msg_promotion_${cohort}_${index}`,
          })
        }
      }

      const report = yield* evolution.canaryReport(identity, created.candidate_id)
      expect(report).toMatchObject({
        candidate_observations: 5,
        control_observations: 5,
        candidate_success_rate: 1,
        control_success_rate: 1,
        gate_passed: true,
      })
      const projection = yield* durable.getProposalByCandidate(identity, created.candidate_id)
      const gate = yield* durable.preparePromotionGate({
        identity,
        proposalID: projection.proposalID,
        actor: identity.actor,
      })
      const sourceBinding = projection.manifest.source_provenance_artifact as { digest: string }
      const sourceArtifact = (yield* database.db.select().from(EvolutionArtifactTable).all().pipe(Effect.orDie)).find(
        (item) => item.digest === sourceBinding.digest,
      )
      expect(sourceArtifact).toBeDefined()
      yield* database.db
        .update(EvolutionArtifactTable)
        .set({ content: "{}" })
        .where(eq(EvolutionArtifactTable.digest, sourceBinding.digest))
        .run()
        .pipe(Effect.orDie)
      expect(
        Exit.isFailure(
          yield* durable
            .preparePromotionGate({ identity, proposalID: projection.proposalID, actor: identity.actor })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* database.db
        .update(EvolutionArtifactTable)
        .set({ content: sourceArtifact!.content })
        .where(eq(EvolutionArtifactTable.digest, sourceBinding.digest))
        .run()
        .pipe(Effect.orDie)

      yield* database.db
        .update(EvaluationResultTable)
        .set({ passed: false })
        .where(eq(EvaluationResultTable.id, sourceEvaluationID))
        .run()
        .pipe(Effect.orDie)
      expect(
        Exit.isFailure(
          yield* durable
            .preparePromotionGate({ identity, proposalID: projection.proposalID, actor: identity.actor })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* database.db
        .update(EvaluationResultTable)
        .set({ passed: true })
        .where(eq(EvaluationResultTable.id, sourceEvaluationID))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* durable.preparePromotionGate({
          identity,
          proposalID: projection.proposalID,
          actor: identity.actor,
        }),
      ).toEqual(gate)
      const forged = yield* durable
        .transition({
          identity,
          proposalID: projection.proposalID,
          expectedRevision: projection.revision,
          from: "canary",
          to: "promoted",
          state: {
            ...projection.state,
            promotion_gate: { ...gate, source_evidence_ids: ["evd_attacker"] },
            deployment: { stage: "promoted", traffic_percent: 100 },
          },
          reason: "attempt forged promotion receipt",
          metadata: { promotionGateDigest: gate.gate_digest },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(forged)).toBe(true)
      expect(yield* durable.getProposal(identity, projection.proposalID)).toMatchObject({
        status: "canary",
        revision: projection.revision,
      })
      const promoted = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: canary.state.revision,
          action: "promote",
          reason: "human promotion after the candidate/control gate passed",
        }),
      )
      expect(promoted.state).toMatchObject({
        status: "promoted",
        evolution_level: "L4",
        deployment: { stage: "promoted", traffic_percent: 100 },
        promotion_gate: {
          gate_passed: true,
          source_experience_ids: ["exp_promotion_e2e_1"],
          source_evidence_ids: ["evd_promotion_e2e_1"],
          canary: { candidate_observations: 5, control_observations: 5 },
          policy: { version: "arforge-evolution-promotion/1" },
        },
      })
      expect(
        yield* evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: canary.state.revision,
          action: "promote",
          reason: "human promotion after the candidate/control gate passed",
        }),
      ).toEqual(promoted)
      for (let index = 0; index < 10; index++) {
        const prepared = yield* exposures.prepare({
          identity,
          userInput: `post-promotion observation ${index}`,
          cohortKey: `post-promotion-${index}`,
        })
        expect(prepared.injectedCandidateIDs).toContain(created.candidate_id)
        yield* exposures.recordOutcome({
          identity,
          exposureID: prepared.exposureID!,
          success: false,
          stopReason: "post-promotion observation for replay isolation",
          assistantMessageID: `msg_post_promotion_${index}`,
        })
      }
      expect((yield* evolution.canaryReport(identity, created.candidate_id)).gate_passed).toBe(false)
      const promotedProjection = yield* durable.getProposal(identity, projection.proposalID)
      expect(
        yield* durable.transition({
          identity,
          proposalID: projection.proposalID,
          expectedRevision: canary.state.revision,
          from: "canary",
          to: "promoted",
          state: { ...promotedProjection.state, revision: canary.state.revision },
          reason: "exact historical promotion replay",
          metadata: { promotionGateDigest: gate.gate_digest },
        }),
      ).toEqual(promotedProjection)
      expect(
        Exit.isFailure(
          yield* durable
            .transition({
              identity,
              proposalID: projection.proposalID,
              expectedRevision: canary.state.revision,
              from: "canary",
              to: "promoted",
              state: { ...promotedProjection.state, revision: canary.state.revision },
              reason: "forged historical promotion replay",
              metadata: { promotionGateDigest: "f".repeat(64) },
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const promotionAudit = (yield* database.db.select().from(EvolutionAuditTable).all()).find(
        (item) =>
          item.aggregate_id === projection.proposalID &&
          item.action === "proposal_status_changed" &&
          item.metadata.to === "promoted",
      )
      expect(promotionAudit?.metadata).toMatchObject({
        from: "canary",
        to: "promoted",
        promotionGateDigest: gate.gate_digest,
      })

      yield* database.db
        .update(EvolutionEvaluationTable)
        .set({ report: { schema_version: 1, tampered: true } })
        .run()
        .pipe(Effect.orDie)
      const tamperedEvaluation = yield* durable
        .preparePromotionGate({ identity, proposalID: projection.proposalID, actor: identity.actor })
        .pipe(Effect.exit)
      expect(Exit.isFailure(tamperedEvaluation)).toBe(true)
    }),
  )

  it.live("automatically rolls back only candidate-cohort safety incidents and replays exactly", () =>
    Effect.gen(function* () {
      const evolution = yield* EvolutionCandidateV1.Service
      const exposures = yield* EvolutionExposureV1.Service
      const governed = yield* GovernedEvolutionV1.Service
      const durable = yield* DurableEvolutionV1.Service
      const events = yield* EventV2.Service
      const authorizer = yield* Authorizer.Service

      const created = yield* runWithApproval(
        events,
        authorizer,
        evolution.createCandidate({
          identity,
          requestID: "candidate-safety-create",
          traceID: "candidate-safety-create-trace",
          title: "Safety rollback advice",
          target: "routing.advice",
          instruction: "Use the bounded route only while its safety evidence remains clean.",
          rationale: "A real safety observation must be able to reduce the deployment automatically.",
          evidenceRefs: ["experience:safety-rollback-e2e-1"],
        }),
      )
      const evaluated = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: created.state.revision,
          action: "evaluate",
          reason: "run deterministic isolated evaluation",
        }),
      )
      const approved = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: evaluated.state.revision,
          action: "approve",
          reason: "human approves the safety-bounded candidate",
        }),
      )
      const canary = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: approved.state.revision,
          action: "startCanary",
          reason: "start a split safety canary",
          trafficPercent: 50,
        }),
      )

      const cohortKeys: { candidate?: string; control?: string } = {}
      for (let index = 0; (!cohortKeys.candidate || !cohortKeys.control) && index < 10_000; index++) {
        const cohortKey = `safety-cohort-${index}`
        const bucket =
          Number.parseInt(canonicalHash({ candidateID: created.candidate_id, cohortKey })!.slice(0, 8), 16) % 100
        cohortKeys[bucket < 50 ? "candidate" : "control"] = cohortKey
      }
      expect(cohortKeys.candidate).toBeDefined()
      expect(cohortKeys.control).toBeDefined()

      const projection = yield* durable.getProposalByCandidate(identity, created.candidate_id)
      const forgedExposureID = `ex-${"0".repeat(32)}`
      const forgedReason = `automatic rollback after candidate-cohort safety incident (exposure:${forgedExposureID})`
      const forged = yield* governed
        .transitionAutomaticRollback({
          identity: { ...identity, actor: "system:evolution-monitor" },
          requestID: "candidate-safety-forged-rollback",
          traceID: "candidate-safety-forged-rollback-trace",
          proposalID: projection.proposalID,
          expectedRevision: projection.revision,
          from: "canary",
          to: "rolled_back",
          state: {
            ...projection.state,
            status: "rolled_back",
            evolution_level: "L2",
            revision: projection.revision,
            rollback: {
              actor: "system:evolution-monitor",
              reason: forgedReason,
              at: new Date(0).toISOString(),
              automatic: true,
              trigger: "safety_incident",
              source_exposure_id: forgedExposureID,
              from_status: "canary",
            },
          },
          reason: forgedReason,
          metadata: {
            candidateID: created.candidate_id,
            action: "automaticRollback",
            automatic: true,
            trigger: "safety_incident",
            exposureID: forgedExposureID,
          },
        })
        .pipe(Effect.exit)
      expect(forged._tag).toBe("Failure")
      expect((yield* evolution.getCandidate(identity, created.candidate_id)).state.status).toBe("canary")

      let approvalRequests = 0
      let automaticDecisions = 0
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === AgentRuntime.ControlEvent.Asked.type) approvalRequests += 1
          if (
            event.type === AgentRuntime.Event.ActionPolicyEvaluated.type &&
            typeof event.data === "object" &&
            event.data !== null &&
            "decision" in event.data &&
            typeof event.data.decision === "object" &&
            event.data.decision !== null &&
            "authority" in event.data.decision &&
            event.data.decision.authority === "automatic"
          )
            automaticDecisions += 1
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const controlExposure = yield* exposures.prepare({
        identity,
        userInput: "control cohort safety signal",
        cohortKey: cohortKeys.control!,
      })
      expect(controlExposure.injectedCandidateIDs).toEqual([])
      yield* evolution.recordOutcome({
        identity,
        exposureID: controlExposure.exposureID!,
        success: false,
        stopReason: "control path reported a safety incident",
        safetyIncident: true,
        assistantMessageID: "msg_safety_control",
      })
      expect((yield* evolution.getCandidate(identity, created.candidate_id)).state.status).toBe("canary")

      const candidateExposure = yield* exposures.prepare({
        identity,
        userInput: "candidate cohort safety signal",
        cohortKey: cohortKeys.candidate!,
      })
      expect(candidateExposure.injectedCandidateIDs).toEqual([created.candidate_id])
      const outcome = {
        identity,
        exposureID: candidateExposure.exposureID!,
        success: false,
        stopReason: "candidate path reported a safety incident",
        safetyIncident: true,
        assistantMessageID: "msg_safety_candidate",
      }
      expect(yield* evolution.recordOutcome(outcome)).toBe(1)
      const rolledBack = yield* evolution.getCandidate(identity, created.candidate_id)
      expect(rolledBack.state).toMatchObject({
        status: "rolled_back",
        evolution_level: "L2",
        revision: canary.state.revision + 1,
        rollback: {
          actor: "system:evolution-monitor",
          automatic: true,
          trigger: "safety_incident",
          source_exposure_id: candidateExposure.exposureID,
          from_status: "canary",
        },
      })
      expect(approvalRequests).toBe(0)
      expect(automaticDecisions).toBe(1)

      expect(yield* evolution.recordOutcome(outcome)).toBe(1)
      expect(yield* evolution.getCandidate(identity, created.candidate_id)).toEqual(rolledBack)
      expect(approvalRequests).toBe(0)
      expect(automaticDecisions).toBe(1)
    }),
  )

  it.live("automatically rolls back sustained unhealthy candidate observations at the policy threshold", () =>
    Effect.gen(function* () {
      const evolution = yield* EvolutionCandidateV1.Service
      const exposures = yield* EvolutionExposureV1.Service
      const events = yield* EventV2.Service
      const authorizer = yield* Authorizer.Service

      const created = yield* runWithApproval(
        events,
        authorizer,
        evolution.createCandidate({
          identity,
          requestID: "candidate-health-create",
          traceID: "candidate-health-create-trace",
          title: "Health rollback advice",
          target: "tool.advice",
          instruction: "Retain this tool advice only while real outcomes meet the health threshold.",
          rationale: "Sustained real failures must automatically reduce the deployment impact.",
          evidenceRefs: ["experience:health-rollback-e2e-1"],
        }),
      )
      const evaluated = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: created.state.revision,
          action: "evaluate",
          reason: "run deterministic isolated evaluation",
        }),
      )
      const approved = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: evaluated.state.revision,
          action: "approve",
          reason: "human approves the health-bounded candidate",
        }),
      )
      const canary = yield* runWithApproval(
        events,
        authorizer,
        evolution.transition({
          identity,
          candidateID: created.candidate_id,
          expectedRevision: approved.state.revision,
          action: "startCanary",
          reason: "start an all-candidate health canary",
          trafficPercent: 100,
        }),
      )

      let approvalRequests = 0
      let automaticDecisions = 0
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === AgentRuntime.ControlEvent.Asked.type) approvalRequests += 1
          if (
            event.type === AgentRuntime.Event.ActionPolicyEvaluated.type &&
            typeof event.data === "object" &&
            event.data !== null &&
            "decision" in event.data &&
            typeof event.data.decision === "object" &&
            event.data.decision !== null &&
            "authority" in event.data.decision &&
            event.data.decision.authority === "automatic"
          )
            automaticDecisions += 1
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      let finalExposureID = ""
      for (let index = 0; index < 5; index++) {
        const prepared = yield* exposures.prepare({
          identity,
          userInput: `unhealthy candidate observation ${index}`,
          cohortKey: `health-candidate-${index}`,
        })
        finalExposureID = prepared.exposureID!
        expect(prepared.injectedCandidateIDs).toEqual([created.candidate_id])
        yield* evolution.recordOutcome({
          identity,
          exposureID: prepared.exposureID!,
          success: false,
          stopReason: "candidate outcome failed",
          assistantMessageID: `msg_health_candidate_${index}`,
        })
        const current = yield* evolution.getCandidate(identity, created.candidate_id)
        expect(current.state.status).toBe(index < 4 ? "canary" : "rolled_back")
      }

      const rolledBack = yield* evolution.getCandidate(identity, created.candidate_id)
      expect(rolledBack.state).toMatchObject({
        status: "rolled_back",
        evolution_level: "L2",
        revision: canary.state.revision + 1,
        rollback: {
          actor: "system:evolution-monitor",
          automatic: true,
          trigger: "canary_health",
          source_exposure_id: finalExposureID,
          from_status: "canary",
        },
      })
      expect(approvalRequests).toBe(0)
      expect(automaticDecisions).toBe(1)
    }),
  )
})
