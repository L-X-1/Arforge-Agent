import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { AdmissionEvidence } from "@arforge-ai/core/runtime"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import { DateTime } from "effect"

const parentRunID = AgentRuntime.RunID.make("run_parent_admission")
const idempotencyKey = "custom-agent-admission-1"
const childRunID = childRunIDFor(parentRunID, idempotencyKey)!

const admission: AgentRuntime.CustomAgentAdmissionEvidence = {
  schema_version: 1,
  kind: "custom-agent-admission",
  role: "CustomAgent.Reviewer",
  profile_path: "C:/workspace/.arforge/agents/reviewer.json",
  status: "admitted",
  decision: "admitted",
  reason: "profile is ready for the existing in-process durable child path",
  ready: true,
  descriptor_digest: "a".repeat(64),
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
}

const input = (overrides: Partial<AdmissionEvidence.PlanInput> = {}): AdmissionEvidence.PlanInput => ({
  identity: {
    tenantID: "ten_admission",
    userID: "usr_admission",
    actor: "user:usr_admission",
  },
  parentRunID,
  childRunID,
  idempotencyKey,
  admission,
  evidenceRefs: [AgentRuntime.EvidenceID.make("evd_support_1")],
  ...overrides,
})

describe("admission evidence boundary", () => {
  test("creates one deterministic, payload-free write plan", () => {
    const first = AdmissionEvidence.plan(input())
    const second = AdmissionEvidence.plan(input())

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      schemaVersion: 1,
      writerOwner: "experience-store",
      settlementBoundary: "child-result-and-budget-settlement",
      parentRunID,
      childRunID,
    })
    expect(first.idempotencyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.admissionDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(String(first.evidenceID)).toMatch(/^evd_admission_[a-f0-9]{64}$/)
    expect(first.evidenceRefs).toEqual([AgentRuntime.EvidenceID.make("evd_support_1")])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.identity)).toBe(true)
    expect(Object.isFrozen(first.evidenceRefs)).toBe(true)
    expect(first).not.toHaveProperty("profile_path")
    expect(first).not.toHaveProperty("system_prompt")
  })

  test("changes the immutable digest when owner or admission identity changes", () => {
    const first = AdmissionEvidence.plan(input())
    const otherOwner = AdmissionEvidence.plan(
      input({ identity: { tenantID: "ten_other", userID: "usr_other", actor: "user:usr_other" } }),
    )
    const otherKey = AdmissionEvidence.plan(input({ idempotencyKey: "custom-agent-admission-2", childRunID: childRunIDFor(parentRunID, "custom-agent-admission-2")! }))

    expect(otherOwner.evidenceID).not.toBe(first.evidenceID)
    expect(otherOwner.admissionDigest).not.toBe(first.admissionDigest)
    expect(otherKey.evidenceID).not.toBe(first.evidenceID)
    expect(otherKey.idempotencyDigest).not.toBe(first.idempotencyDigest)
  })

  test("fails closed for blocked receipts, duplicate references, and child identity drift", () => {
    expect(() =>
      AdmissionEvidence.plan(
        input({
          admission: {
            ...admission,
            ready: false,
            valid: false,
            decision: "blocked",
            violations: ["workspace is not trusted"],
          },
        }),
      ),
    ).toThrow(AdmissionEvidence.AdmissionEvidenceBoundaryError)

    const duplicateID = AgentRuntime.EvidenceID.make("evd_duplicate")
    expect(() => AdmissionEvidence.plan(input({ evidenceRefs: [duplicateID, duplicateID] }))).toThrow(
      "evidence references must be unique",
    )
    expect(() =>
      AdmissionEvidence.plan(input({ childRunID: AgentRuntime.RunID.make("run_wrong_child") })),
    ).toThrow("childRunID does not match")
    expect(() => AdmissionEvidence.plan(input({ identity: { tenantID: "", userID: "usr_admission", actor: "user:x" } }))).toThrow(
      "tenantID",
    )
  })

  test("materializes only a successful Action Observation into payload-free Evidence", () => {
    const actionID = AgentRuntime.ActionID.make("act_admission_observed")
    const observation = AgentRuntime.Observation.make({
      id: AgentRuntime.ObservationID.make("obs_admission_observed"),
      actionID,
      status: "succeeded",
      summary: "admission action completed",
      artifactIDs: [],
      observedAt: DateTime.makeUnsafe("2026-09-02T00:00:00.000Z"),
    })
    const plan = AdmissionEvidence.plan(input())
    const materialized = AdmissionEvidence.materialize({ plan, actionID, observation })

    expect(materialized.evidence).toMatchObject({
      id: plan.evidenceID,
      source: "runtime:custom-agent-admission",
      trust: "trusted",
      instructionAllowed: false,
      observationIDs: [observation.id],
      runID: childRunID,
      actionID,
      verificationStatus: "verified",
    })
    expect(materialized.evidence).not.toHaveProperty("profile_path")
    expect(materialized.evidence).not.toHaveProperty("system_prompt")
    expect(materialized.recordDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(materialized)).toBe(true)

    expect(() =>
      AdmissionEvidence.materialize({
        plan,
        actionID: AgentRuntime.ActionID.make("act_other"),
        observation,
      }),
    ).toThrow("does not belong")
    expect(() =>
      AdmissionEvidence.materialize({
        plan,
        actionID,
        observation: { ...observation, status: "failed" },
      }),
    ).toThrow("successful Action Observation")
    expect(() =>
      AdmissionEvidence.materialize({
        plan: { ...plan, evidenceID: AgentRuntime.EvidenceID.make("evd_forged_plan") },
        actionID,
        observation,
      }),
    ).toThrow("plan ID does not match")
  })
})
