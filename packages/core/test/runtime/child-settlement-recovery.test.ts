import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
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
import * as AdmissionEvidence from "@arforge-ai/core/runtime/admission-evidence"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import * as ChildSettlementAudit from "@arforge-ai/core/runtime/child-settlement-audit"
import { assertRecoveryOutboxReceipt, recoveryOutboxReceipt } from "@arforge-ai/core/runtime/child-settlement-recovery"
import * as ChildSettlementRecovery from "@arforge-ai/core/runtime/child-settlement-recovery"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun, childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import * as RuntimeEvaluation from "@arforge-ai/core/runtime/evaluation"
import * as SettlementOutbox from "@arforge-ai/core/runtime/settlement-outbox"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { DateTime, Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const identity = {
  tenantID: "ten_settlement_recovery",
  userID: "usr_settlement_recovery",
  actor: "user:usr_settlement_recovery",
}
const project = Project.ID.global
const location = AbsolutePath.make("C:/workspaces/settlement-recovery")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory: location, project: { id: project, directory: location } }),
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
    ChildSettlementAudit.node,
    ChildSettlementRecovery.node,
    SettlementOutbox.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [Location.node, current],
  ],
)
const it = testEffect(layer)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 2,
  maxDurationMs: 60_000,
  maxCostMicros: 100_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const admission = (descriptorDigest: string): AgentRuntime.CustomAgentAdmissionEvidence => ({
  schema_version: 1,
  kind: "custom-agent-admission",
  role: "CustomAgent.Recovery",
  profile_path: "profiles/recovery.json",
  status: "admitted",
  decision: "admitted",
  reason: "recovery fixture admission",
  ready: true,
  descriptor_digest: descriptorDigest,
  checks: {
    status_consistent: true,
    descriptor_digest_consistent: true,
    tool_projection_consistent: true,
    payload_free: true,
  },
  declared_tool_count: 1,
  canonical_tool_count: 1,
  unsupported_tool_count: 0,
  valid: true,
  violations: [],
})

const running = (runs: DurableRun.Interface, runID: AgentRuntime.RunID) =>
  Effect.gen(function* () {
    yield* runs.transition({ runID, to: "preflight", reason: "recovery fixture preflight" })
    yield* runs.transition({ runID, to: "queued", reason: "recovery fixture queued" })
    yield* runs.transition({ runID, to: "running", reason: "recovery fixture running" })
  })

describe("ChildSettlementRecovery owner replay", () => {
  it.effect(
    "repairs an Evidence-present/result-missing crash in deterministic owner order",
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const events = yield* EventV2.Service
      const experience = yield* ExperienceStoreV1.Service
      const audit = yield* ChildSettlementAudit.Service
      const recovery = yield* ChildSettlementRecovery.Service

      const parent = yield* runs.create({
        sessionID: SessionSchema.ID.create(),
        initiator: "user",
        authority: "automatic",
        riskTier: "L1",
        reasonSummary: "recovery parent",
        budget,
        traceID: "settlement-recovery-parent",
        visibility: "audit",
        project,
        location,
      })
      yield* running(runs, parent.run.id)
      const descriptorDigest = "e".repeat(64)
      const idempotencyKey = "evidence-present-result-missing"
      const child = yield* runs.createChild({
        parentRunID: parent.run.id,
        sessionID: SessionSchema.ID.create(),
        idempotencyKey,
        runtimeDescriptorDigest: descriptorDigest,
        runtimeAdmission: { evidence: admission(descriptorDigest), evidenceRefs: [] },
        delegatedObjective: "recover a crashed settlement",
        allowedCapabilities: [{ action: "shell", resources: ["fixture:recovery"], access: "read" }],
        project,
        location,
        expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "recovery child",
        budget,
        traceID: "settlement-recovery-child",
        parentTraceID: "settlement-recovery-parent",
        visibility: "audit",
      })
      yield* running(runs, child.run.id)

      const context = {
        sessionID: child.run.sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        toolCallID: "call-settlement-recovery",
      }
      const actionID = ActionGateway.stableActionID(context)
      yield* gateway.execute(
        {
          ...context,
          actionID,
          runID: child.run.id,
          agent: AgentV2.ID.make("build"),
          name: "shell",
          resources: ["fixture:recovery"],
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
          reasonSummary: "persist a recovery observation",
          inputDigest: "f".repeat(64),
        },
        { execute: () => Effect.succeed({ exitCode: 0 }) },
      )
      const action = yield* actions.load(actionID)
      if (!action.observation) throw new Error("recovery fixture Action has no Observation")
      yield* runs.transition({ runID: child.run.id, to: "completed", reason: "terminal before crash" })

      const written = yield* experience.recordAdmissionEvidence({
        identity,
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey,
        admission: admission(descriptorDigest),
        evidenceRefs: [],
        actionID,
      })
      const resultInput = {
        status: "completed" as const,
        summary: "result intentionally absent at crash",
        artifactRefs: [] as ReadonlyArray<AgentRuntime.ArtifactID>,
        evidenceRefs: [written.evidenceID],
        usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
      }
      const now = yield* DateTime.now
      const intent = ChildSettlement.createIntent({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey,
        result: resultInput,
        admissionEvidence: {
          evidenceID: written.evidenceID,
          recordDigest: written.recordDigest,
          actionID,
          observationID: action.observation.id,
        },
        createdAtMs: DateTime.toEpochMillis(now),
      })
      const result = AgentRuntime.ChildRunResult.make({
        ...resultInput,
        resultDigest: intent.resultDigest,
        recordedAt: now,
      })
      const currentParent = yield* runs.load(parent.run.id)
      if (!("sessionID" in currentParent.run)) throw new Error("recovery fixture parent is not a SessionRun")
      yield* events.publish(
        AgentRuntime.Event.ChildRunSettlementIntentRecorded,
        {
          runID: parent.run.id,
          sessionID: currentParent.run.sessionID,
          childRunID: child.run.id,
          idempotencyKey,
          intentID: intent.intentID,
          idempotencyDigest: intent.idempotencyDigest,
          result,
          admissionEvidence: {
            evidenceID: written.evidenceID,
            recordDigest: written.recordDigest,
            actionID,
            observationID: action.observation.id,
          },
          intentAt: now,
        },
        { expectedSequence: currentParent.lastSequence },
      )

      const before = yield* audit.inspect({ identity, parentRunID: parent.run.id, childRunID: child.run.id })
      expect(before.status).toBe("repairable")
      expect(before.facts?.evidence.state).toBe("present")
      expect(before.decision?.next).toEqual(["child-result", "parent-budget"])
      const beforeOutbox = recoveryOutboxReceipt(before, 1_000)
      if (!beforeOutbox) throw new Error("recovery fixture did not produce an outbox receipt")
      assertRecoveryOutboxReceipt(beforeOutbox)
      expect(beforeOutbox.ownerStates).toEqual({ evidence: "present", childResult: "missing", parentBudget: "missing" })
      expect(JSON.stringify(beforeOutbox)).not.toContain("result intentionally absent")
      expect(() => assertRecoveryOutboxReceipt({ ...beforeOutbox, decisionDigest: "0".repeat(64) })).toThrow(
        /decision digest drifted/,
      )

      const repaired = yield* recovery.recover({ identity, parentRunID: parent.run.id, childRunID: child.run.id })
      expect(repaired.attempted).toEqual(["child-result", "parent-budget"])
      expect(repaired.repaired).toEqual(["child-result", "parent-budget"])
      expect(repaired.after.status).toBe("complete")
      expect(repaired.after.decision?.complete).toBe(true)
      expect(repaired.after.providerExecutionAllowed).toBe(false)
      expect(repaired.providerExecutionAllowed).toBe(false)
      const afterOutbox = recoveryOutboxReceipt(repaired.after, 2_000)
      if (!afterOutbox) throw new Error("completed recovery did not produce an outbox receipt")
      assertRecoveryOutboxReceipt(afterOutbox)
      const replayedAfterOutbox = recoveryOutboxReceipt(repaired.after, 3_000)
      if (!replayedAfterOutbox) throw new Error("completed recovery outbox replay disappeared")
      expect(afterOutbox.decisionDigest).toBe(replayedAfterOutbox.decisionDigest)
      expect(childRunIDFor(parent.run.id, idempotencyKey)).toBe(child.run.id)
    }),
    { timeout: 15_000 },
  )

  it.effect(
    "finalizes a prepared outbox after all durable owners committed before the acknowledgement boundary",
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const experience = yield* ExperienceStoreV1.Service
      const audit = yield* ChildSettlementAudit.Service
      const recovery = yield* ChildSettlementRecovery.Service
      const outbox = yield* SettlementOutbox.Service

      const parent = yield* runs.create({
        sessionID: SessionSchema.ID.create(),
        initiator: "user",
        authority: "automatic",
        riskTier: "L1",
        reasonSummary: "prepared receipt acknowledgement parent",
        budget,
        traceID: "settlement-ack-parent",
        visibility: "audit",
        project,
        location,
      })
      yield* running(runs, parent.run.id)
      const descriptorDigest = "b".repeat(64)
      const idempotencyKey = "prepared-receipt-ack"
      const child = yield* runs.createChild({
        parentRunID: parent.run.id,
        sessionID: SessionSchema.ID.create(),
        idempotencyKey,
        runtimeDescriptorDigest: descriptorDigest,
        runtimeAdmission: { evidence: admission(descriptorDigest), evidenceRefs: [] },
        delegatedObjective: "finalize an already durable settlement receipt",
        allowedCapabilities: [{ action: "shell", resources: ["fixture:ack"], access: "read" }],
        project,
        location,
        expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "prepared receipt acknowledgement child",
        budget,
        traceID: "settlement-ack-child",
        parentTraceID: "settlement-ack-parent",
        visibility: "audit",
      })
      yield* running(runs, child.run.id)

      const context = {
        sessionID: child.run.sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        toolCallID: "call-settlement-ack",
      }
      const actionID = ActionGateway.stableActionID(context)
      yield* gateway.execute(
        {
          ...context,
          actionID,
          runID: child.run.id,
          agent: AgentV2.ID.make("build"),
          name: "shell",
          resources: ["fixture:ack"],
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
          reasonSummary: "persist acknowledgement fixture observation",
          inputDigest: "c".repeat(64),
        },
        { execute: () => Effect.succeed({ exitCode: 0 }) },
      )
      const action = yield* actions.load(actionID)
      if (!action.observation) throw new Error("acknowledgement fixture Action has no Observation")
      yield* runs.transition({ runID: child.run.id, to: "completed", reason: "acknowledgement fixture terminal state" })

      const admissionPlan = AdmissionEvidence.plan({
        identity,
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey,
        admission: admission(descriptorDigest),
        evidenceRefs: [],
      })
      const materialized = AdmissionEvidence.materialize({
        plan: admissionPlan,
        actionID,
        observation: action.observation,
      })
      const resultInput = {
        status: "completed" as const,
        summary: "all owners committed before outbox acknowledgement",
        artifactRefs: [] as ReadonlyArray<AgentRuntime.ArtifactID>,
        evidenceRefs: [admissionPlan.evidenceID],
        usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
      }

      yield* Effect.provideService(
        runs.recordChildResult({
          runID: child.run.id,
          admissionEvidence: {
            evidenceID: materialized.evidence.id,
            recordDigest: materialized.recordDigest,
            actionID,
            observationID: action.observation.id,
          },
          result: resultInput,
        }),
        Database.CurrentPrincipal,
        { tenantID: identity.tenantID, userID: identity.userID },
      )
      yield* experience.recordAdmissionEvidence({
        identity,
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey,
        admission: admission(descriptorDigest),
        evidenceRefs: [],
        actionID,
      })

      const intent = yield* runs.readChildSettlementIntent({
        parentRunID: parent.run.id,
        childRunID: child.run.id,
      })
      if (!intent) throw new Error("acknowledgement fixture settlement intent is missing")
      const plan = ChildSettlement.planSettlementCommit(intent, {
        mode: "recovery-outbox",
        atomicDatabaseTransaction: false,
        durableRecoveryOutbox: true,
      })
      const prepared = yield* outbox.read({ identity, intentID: plan.intentID })
      if (!prepared) throw new Error("acknowledgement fixture outbox receipt is missing")
      expect(prepared.status).toBe("prepared")
      expect(prepared.ownerProgress).toBeUndefined()

      const before = yield* audit.inspect({ identity, parentRunID: parent.run.id, childRunID: child.run.id })
      expect(before.status).toBe("complete")
      const recoveryInput = { identity, parentRunID: parent.run.id, childRunID: child.run.id }
      const concurrent = yield* Effect.all([recovery.recover(recoveryInput), recovery.recover(recoveryInput)], {
        concurrency: 2,
      })
      const repaired = concurrent[0]
      expect(repaired.attempted).toEqual([])
      expect(repaired.repaired).toEqual([])
      expect(repaired.after.status).toBe("complete")
      expect(concurrent[1].attempted).toEqual([])
      expect(concurrent[1].repaired).toEqual([])
      const committed = yield* outbox.read({ identity, intentID: plan.intentID })
      if (!committed) throw new Error("acknowledgement fixture lost its outbox receipt")
      expect(committed.status).toBe("committed")
      expect(committed.ownerProgress?.completed).toEqual(["admission-evidence", "child-result", "parent-budget"])

      const replay = yield* recovery.recover({ identity, parentRunID: parent.run.id, childRunID: child.run.id })
      expect(replay.attempted).toEqual([])
      expect(replay.repaired).toEqual([])
      const replayed = yield* outbox.read({ identity, intentID: plan.intentID })
      if (!replayed) throw new Error("acknowledgement fixture lost its replayed outbox receipt")
      expect(replayed.receiptDigest).toBe(committed.receiptDigest)
    }),
    { timeout: 15_000 },
  )

  it.effect(
    "repairs a missing Evidence row after result and budget are already durable",
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const experience = yield* ExperienceStoreV1.Service
      const audit = yield* ChildSettlementAudit.Service
      const recovery = yield* ChildSettlementRecovery.Service

      const parent = yield* runs.create({
        sessionID: SessionSchema.ID.create(),
        initiator: "user",
        authority: "automatic",
        riskTier: "L1",
        reasonSummary: "reverse recovery parent",
        budget,
        traceID: "reverse-settlement-recovery-parent",
        visibility: "audit",
        project,
        location,
      })
      yield* running(runs, parent.run.id)
      const descriptorDigest = "a".repeat(64)
      const idempotencyKey = "evidence-missing-result-present"
      const child = yield* runs.createChild({
        parentRunID: parent.run.id,
        sessionID: SessionSchema.ID.create(),
        idempotencyKey,
        runtimeDescriptorDigest: descriptorDigest,
        runtimeAdmission: { evidence: admission(descriptorDigest), evidenceRefs: [] },
        delegatedObjective: "repair a missing admission record",
        allowedCapabilities: [{ action: "shell", resources: ["fixture:reverse-recovery"], access: "read" }],
        project,
        location,
        expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "reverse recovery child",
        budget,
        traceID: "reverse-settlement-recovery-child",
        parentTraceID: "reverse-settlement-recovery-parent",
        visibility: "audit",
      })
      yield* running(runs, child.run.id)

      const context = {
        sessionID: child.run.sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        toolCallID: "call-reverse-settlement-recovery",
      }
      const actionID = ActionGateway.stableActionID(context)
      yield* gateway.execute(
        {
          ...context,
          actionID,
          runID: child.run.id,
          agent: AgentV2.ID.make("build"),
          name: "shell",
          resources: ["fixture:reverse-recovery"],
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
          reasonSummary: "persist the reverse recovery observation",
          inputDigest: "b".repeat(64),
        },
        { execute: () => Effect.succeed({ exitCode: 0 }) },
      )
      const action = yield* actions.load(actionID)
      if (!action.observation) throw new Error("reverse recovery Action has no Observation")
      yield* runs.transition({ runID: child.run.id, to: "completed", reason: "result owner survives crash" })

      const plan = AdmissionEvidence.plan({
        identity,
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey,
        admission: admission(descriptorDigest),
        evidenceRefs: [],
      })
      const materialized = AdmissionEvidence.materialize({ plan, actionID, observation: action.observation })
      // Record the child result and parent budget with the immutable receipt,
      // but intentionally do not call ExperienceStore.recordAdmissionEvidence.
      yield* Effect.provideService(
        runs.recordChildResult({
          runID: child.run.id,
          admissionEvidence: {
            evidenceID: materialized.evidence.id,
            recordDigest: materialized.recordDigest,
            actionID,
            observationID: action.observation.id,
          },
          result: {
            status: "completed",
            summary: "result and budget survived the crash",
            artifactRefs: [],
            evidenceRefs: [materialized.evidence.id],
            usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
          },
        }),
        Database.CurrentPrincipal,
        { tenantID: identity.tenantID, userID: identity.userID },
      )

      const before = yield* audit.inspect({ identity, parentRunID: parent.run.id, childRunID: child.run.id })
      expect(before.status).toBe("repairable")
      expect(before.facts?.evidence.state).toBe("missing")
      expect(before.decision?.next).toEqual(["admission-evidence"])
      const beforeOutbox = recoveryOutboxReceipt(before, 4_000)
      if (!beforeOutbox) throw new Error("reverse recovery fixture did not produce an outbox receipt")
      assertRecoveryOutboxReceipt(beforeOutbox)
      expect(beforeOutbox.ownerStates).toEqual({ evidence: "missing", childResult: "present", parentBudget: "present" })
      const resolvedBefore = yield* experience.resolveEvidenceIDs(identity, [materialized.evidence.id])
      expect(resolvedBefore.present).toEqual([])

      const swept = yield* recovery.recoverPending({ identity, limit: 10 })
      expect(swept.scanned).toBe(1)
      expect(swept.committed).toBe(1)
      expect(swept.pending).toBe(0)
      expect(swept.recoveryRequired).toBe(0)
      expect(swept.failed).toBe(0)
      expect(swept.hasMore).toBe(false)
      expect(swept.providerExecutionAllowed).toBe(false)
      expect(swept.items[0]).toMatchObject({
        intentID: beforeOutbox.intentID,
        sourceStatus: "prepared",
        afterStatus: "committed",
        outcome: "committed",
        attempted: ["admission-evidence"],
        repaired: ["admission-evidence"],
      })
      const replaySweep = yield* recovery.recoverPending({ identity, limit: 10 })
      expect(replaySweep.scanned).toBe(0)
      expect(replaySweep.committed).toBe(0)
      expect(replaySweep.items).toEqual([])
      const invalidSweep = yield* recovery.recoverPending({ identity, limit: 0 }).pipe(Effect.exit)
      expect(invalidSweep._tag).toBe("Failure")
      const resolvedAfter = yield* experience.resolveEvidenceIDs(identity, [materialized.evidence.id])
      expect(resolvedAfter.present).toEqual([materialized.evidence.id])
    }),
    { timeout: 15_000 },
  )
})
