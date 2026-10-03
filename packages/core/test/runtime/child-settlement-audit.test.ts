import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
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
import * as ChildSettlementAudit from "@arforge-ai/core/runtime/child-settlement-audit"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as RuntimeEvaluation from "@arforge-ai/core/runtime/evaluation"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const identity = {
  tenantID: "ten_settlement_audit",
  userID: "usr_settlement_audit",
  actor: "user:usr_settlement_audit",
}
const project = Project.ID.global
const location = AbsolutePath.make("C:/workspaces/settlement-audit")
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
    ChildSettlementAudit.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [Location.node, current],
  ],
)
const it = testEffect(layer)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 2,
  maxDurationMs: 10_000,
  maxCostMicros: 10_000,
  maxTokens: 100_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const running = (runtime: DurableRun.Interface, runID: AgentRuntime.RunID) =>
  Effect.gen(function* () {
    yield* runtime.transition({ runID, to: "preflight", reason: "settlement audit preflight" })
    yield* runtime.transition({ runID, to: "queued", reason: "settlement audit queued" })
    yield* runtime.transition({ runID, to: "running", reason: "settlement audit running" })
  })

const createParent = (runtime: DurableRun.Interface) =>
  runtime.create({
    sessionID: SessionSchema.ID.create(),
    initiator: "user",
    authority: "automatic",
    riskTier: "L1",
    reasonSummary: "settlement audit parent",
    budget,
    traceID: "trace-settlement-audit-parent",
    visibility: "audit",
    project,
    location,
  })

const createChild = (runtime: DurableRun.Interface, parentRunID: AgentRuntime.RunID, key: string, admission = false) =>
  runtime.createChild({
    parentRunID,
    sessionID: SessionSchema.ID.create(),
    idempotencyKey: key,
    ...(admission
      ? {
          runtimeDescriptorDigest: "c".repeat(64),
          runtimeAdmission: {
            evidence: {
              schema_version: 1 as const,
              kind: "custom-agent-admission" as const,
              role: "CustomAgent.Audit",
              profile_path: "profiles/audit.json",
              status: "admitted" as const,
              decision: "admitted" as const,
              reason: "audit fixture",
              ready: true,
              descriptor_digest: "c".repeat(64),
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
            },
            evidenceRefs: [AgentRuntime.EvidenceID.make("evd_settlement_audit_missing")],
          },
        }
      : {}),
    delegatedObjective: "inspect settlement audit",
    allowedCapabilities: [{ action: "read", resources: ["fixture"], access: "read" }],
    project,
    location,
    expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
    initiator: "agent",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "settlement audit child",
    budget,
    traceID: `trace-settlement-audit-${key}`,
    parentTraceID: "trace-settlement-audit-parent",
    visibility: "audit",
  })

describe("ChildSettlementAudit read-only seam", () => {
  it.effect(
    "reports complete legacy settlement and never authorizes provider execution",
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const audit = yield* ChildSettlementAudit.Service
      const parent = yield* createParent(runs)
      yield* running(runs, parent.run.id)
      const child = yield* createChild(runs, parent.run.id, "legacy-complete")
      yield* running(runs, child.run.id)
      yield* runs.transition({ runID: child.run.id, to: "completed", reason: "legacy audit complete" })
      yield* runs.recordChildResult({
        runID: child.run.id,
        result: {
          status: "completed",
          summary: "legacy child complete",
          artifactRefs: [],
          evidenceRefs: [],
          usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
        },
      })
      const report = yield* audit.inspect({ identity, parentRunID: parent.run.id, childRunID: child.run.id })
      expect(report.status).toBe("complete")
      expect(report.decision?.complete).toBe(true)
      expect(report.providerExecutionAllowed).toBe(false)
      expect(report.facts?.evidence).toEqual({ state: "not-required" })
    }),
    { timeout: 15_000 },
  )

  it.effect(
    "reports a missing admission Evidence row as repairable, never as complete",
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const audit = yield* ChildSettlementAudit.Service
      const parent = yield* createParent(runs)
      yield* running(runs, parent.run.id)
      const child = yield* createChild(runs, parent.run.id, "missing-evidence", true)
      yield* running(runs, child.run.id)
      yield* runs.transition({ runID: child.run.id, to: "completed", reason: "admission audit complete" })
      yield* runs.recordChildResult({
        runID: child.run.id,
        admissionEvidence: { evidenceID: child.run.child.runtimeAdmission!.evidenceRefs[0]!, recordDigest: "d".repeat(64) },
        result: {
          status: "completed",
          summary: "admission Evidence row is intentionally absent",
          artifactRefs: [],
          evidenceRefs: [child.run.child.runtimeAdmission!.evidenceRefs[0]!],
          usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
        },
      })
      const report = yield* audit.inspect({ identity, parentRunID: parent.run.id, childRunID: child.run.id })
      expect(report.status).toBe("repairable")
      expect(report.decision?.complete).toBe(false)
      expect(report.decision?.missing).toEqual(["admission-evidence"])
      expect(report.evidenceResolution?.missing).toEqual([child.run.child.runtimeAdmission!.evidenceRefs[0]!])
      expect(report.providerExecutionAllowed).toBe(false)
    }),
    { timeout: 15_000 },
  )

  it.effect(
    "does not infer or repair a child that has no persisted settlement intent",
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const audit = yield* ChildSettlementAudit.Service
      const parent = yield* createParent(runs)
      yield* running(runs, parent.run.id)
      const child = yield* createChild(runs, parent.run.id, "missing-intent")
      yield* running(runs, child.run.id)
      yield* runs.transition({ runID: child.run.id, to: "completed", reason: "no intent fixture" })
      const report = yield* audit.inspect({ identity, parentRunID: parent.run.id, childRunID: child.run.id })
      expect(report.status).toBe("missing-intent")
      expect(report.intentID).toBeUndefined()
      expect(report.decision).toBeUndefined()
      expect(report.providerExecutionAllowed).toBe(false)
    }),
    { timeout: 15_000 },
  )
})
