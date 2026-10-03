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
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import * as AdmissionEvidence from "@arforge-ai/core/runtime/admission-evidence"
import { DurableRun, childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import * as RuntimeEvaluation from "@arforge-ai/core/runtime/evaluation"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const identity = {
  tenantID: "ten_admission_writer",
  userID: "usr_admission_writer",
  actor: "user:usr_admission_writer",
}
const project = Project.ID.global
const location = AbsolutePath.make("C:/workspaces/admission-writer")
const current = Layer.succeed(Location.Service, Location.Service.of({ directory: location, project: { id: project, directory: location } }))
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

const admittedEvidence = (descriptorDigest: string): AgentRuntime.CustomAgentAdmissionEvidence => ({
  schema_version: 1,
  kind: "custom-agent-admission",
  role: "CustomAgent.Reviewer",
  profile_path: "profiles/reviewer.json",
  status: "admitted",
  decision: "admitted",
  reason: "writer fixture admission",
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
    yield* runs.transition({ runID, to: "preflight", reason: "writer fixture preflight" })
    yield* runs.transition({ runID, to: "queued", reason: "writer fixture queued" })
    yield* runs.transition({ runID, to: "running", reason: "writer fixture running" })
  })

describe("admission Evidence writer", () => {
  it.effect("binds a real settled Action Observation and replays idempotently", () =>
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const experience = yield* ExperienceStoreV1.Service

      const parent = yield* runs.create({
        sessionID: SessionSchema.ID.create(),
        initiator: "user",
        authority: "automatic",
        riskTier: "L1",
        reasonSummary: "admission writer parent",
        budget,
        traceID: "admission-writer-parent",
        visibility: "audit",
        project,
        location,
      })
      yield* running(runs, parent.run.id)
      const descriptorDigest = "a".repeat(64)
      const idempotencyKey = "admission-writer-child"
      const child = yield* runs.createChild({
        parentRunID: parent.run.id,
        sessionID: SessionSchema.ID.create(),
        idempotencyKey,
        runtimeDescriptorDigest: descriptorDigest,
        runtimeAdmission: { evidence: admittedEvidence(descriptorDigest), evidenceRefs: [] },
        delegatedObjective: "record admission evidence",
        allowedCapabilities: [{ action: "shell", resources: ["fixture:admission-writer"], access: "read" }],
        project,
        location,
        expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "admission writer child",
        budget,
        traceID: "admission-writer-child",
        parentTraceID: "admission-writer-parent",
        visibility: "audit",
      })
      yield* running(runs, child.run.id)

      const context = {
        sessionID: child.run.sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        toolCallID: "call-admission-writer",
      }
      const actionID = ActionGateway.stableActionID(context)
      yield* gateway.execute(
        {
          ...context,
          actionID,
          runID: child.run.id,
          agent: AgentV2.ID.make("build"),
          name: "shell",
          resources: ["fixture:admission-writer"],
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
          reasonSummary: "persist the admission observation",
          inputDigest: canonicalHash({ idempotencyKey })!,
        },
        { execute: () => Effect.succeed({ exitCode: 0 }) },
      )
      const action = yield* actions.load(actionID)
      if (!action.observation) throw new Error("writer fixture Action has no Observation")

      const first = yield* experience.recordAdmissionEvidence({
        identity,
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey,
        admission: admittedEvidence(descriptorDigest),
        evidenceRefs: [],
        actionID,
      })
      const second = yield* experience.recordAdmissionEvidence({
        identity,
        parentRunID: parent.run.id,
        childRunID: child.run.id,
        idempotencyKey,
        admission: admittedEvidence(descriptorDigest),
        evidenceRefs: [],
        actionID,
      })
      expect(first.inserted).toBe(true)
      expect(second.inserted).toBe(false)
      expect(second).toMatchObject({ ...first, inserted: false })
      expect(first.runID).toBe(child.run.id)
      expect(first.actionID).toBe(actionID)
      expect(first.observationID).toBe(action.observation.id)
      expect(first.evidenceID).toBe(
        AdmissionEvidence.plan({
          identity,
          parentRunID: parent.run.id,
          childRunID: child.run.id,
          idempotencyKey,
          admission: admittedEvidence(descriptorDigest),
          evidenceRefs: [],
        }).evidenceID,
      )
      expect(first.recordDigest).toMatch(/^[a-f0-9]{64}$/)
      const resolved = yield* experience.resolveEvidenceIDs(identity, [first.evidenceID])
      expect(resolved.present).toEqual([first.evidenceID])
      expect(resolved.valid).toBe(true)
      const resolverFacts = yield* experience.resolveEvidenceFacts(identity, [first.evidenceID])
      expect(resolverFacts.resolution).toEqual(resolved)
      expect(resolverFacts.recordDigests).toEqual([{ evidenceID: first.evidenceID, recordDigest: first.recordDigest }])
      const audit = yield* experience.verifyAudit(identity, String(first.evidenceID))
      expect(audit.valid).toBe(true)
      expect(audit.events).toBe(1)
      expect(childRunIDFor(parent.run.id, idempotencyKey)).toBe(child.run.id)
    }),
  )

  it.effect("rejects a missing supporting reference before touching the Action writer", () =>
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const experience = yield* ExperienceStoreV1.Service
      const parent = yield* runs.create({
        sessionID: SessionSchema.ID.create(),
        initiator: "user",
        authority: "automatic",
        riskTier: "L1",
        reasonSummary: "admission writer negative parent",
        budget,
        traceID: "admission-writer-negative-parent",
        visibility: "audit",
        project,
        location,
      })
      yield* running(runs, parent.run.id)
      const descriptorDigest = "b".repeat(64)
      const idempotencyKey = "admission-writer-negative-child"
      const missingReference = AgentRuntime.EvidenceID.make("evd_admission_missing_support")
      const child = yield* runs.createChild({
        parentRunID: parent.run.id,
        sessionID: SessionSchema.ID.create(),
        idempotencyKey,
        runtimeDescriptorDigest: descriptorDigest,
        runtimeAdmission: { evidence: admittedEvidence(descriptorDigest), evidenceRefs: [missingReference] },
        delegatedObjective: "reject admission evidence",
        allowedCapabilities: [{ action: "shell", resources: ["fixture"], access: "read" }],
        project,
        location,
        expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "admission writer negative child",
        budget,
        traceID: "admission-writer-negative-child",
        parentTraceID: "admission-writer-negative-parent",
        visibility: "audit",
      })
      const failed = yield* experience
        .recordAdmissionEvidence({
          identity,
          parentRunID: parent.run.id,
          childRunID: child.run.id,
          idempotencyKey,
          admission: admittedEvidence(descriptorDigest),
          evidenceRefs: [missingReference],
          actionID: AgentRuntime.ActionID.make("act_missing_admission_action"),
        })
        .pipe(Effect.flip)
      expect(failed._tag).toBe("ExperienceStore.Error")
      expect(failed.reason).toContain("supporting references")
      const resolved = yield* experience.resolveEvidenceIDs(
        identity,
        [
          AdmissionEvidence.plan({
            identity,
            parentRunID: parent.run.id,
            childRunID: child.run.id,
            idempotencyKey,
            admission: admittedEvidence(descriptorDigest),
            evidenceRefs: [missingReference],
          }).evidenceID,
        ],
      )
      expect(resolved.present).toEqual([])
      expect(resolved.missing).toHaveLength(1)
    }),
  )
})
