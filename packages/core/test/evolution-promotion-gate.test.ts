import { describe, expect, test } from "bun:test"
import {
  PromotionGate,
  PromotionGateError,
  canaryReportFor,
  promotionPolicySnapshot,
  type PromotionGateFacts,
} from "@arforge-ai/core/evolution/promotion-gate"
import type { EvolutionPolicy } from "@arforge-ai/core/evolution/runtime"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"

const policy: EvolutionPolicy = {
  min_auto_proposal_frequency: 3,
  min_auto_proposal_confidence: 0.7,
  min_canary_observations: 5,
  min_control_observations: 5,
  min_canary_success_rate: 0.7,
  min_success_rate_delta: -0.02,
  default_traffic_percent: 10,
  auto_rollback_min_observations: 5,
  auto_rollback_success_rate: 0.4,
  max_active_candidates: 5,
}

const candidateDigest = "a".repeat(64)
const baselineDigest = "b".repeat(64)
const rollbackDigest = "c".repeat(64)
const rollbackPlanDigest = "d".repeat(64)
const sourceProvenanceDigest = "e".repeat(64)

const report = () => {
  const core = {
    schema_version: 1 as const,
    candidate_id: "ev-promotion-gate",
    candidate_digest: candidateDigest,
    created_at: "2026-08-13T00:00:00.000Z",
    isolation: "temporary_directory" as const,
    workspace_retained: false as const,
    gate_passed: true,
    budget: {
      max_attempts: 1,
      attempts_used: 1,
      max_duration_ms: 120_000,
      duration_ms_used: 0,
      max_cost_micros: 0,
      cost_micros_used: 0,
      passed: true,
    },
    cases: [
      "manifest-integrity",
      "constitution-boundary",
      "evolution-level-boundary",
      "context-trust-boundary",
      "permission-boundary",
      "secret-boundary",
      "egress-boundary",
      "active-target-conflict",
      "budget-boundary",
    ].map((caseID) => ({
      case_id: caseID,
      category: caseID.replace("-boundary", ""),
      passed: true,
      score: 1,
      baseline_score: 1,
      detail: "verified",
      required: true,
    })),
  }
  const reportDigest = canonicalHash(core)!
  return { ...core, evaluation_id: `eva_${reportDigest.slice(0, 32)}`, report_digest: reportDigest }
}

const observations = () =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `ob-${String(index).padStart(2, "0")}`,
    candidateDigest,
    cohort: index < 5 ? ("candidate" as const) : ("control" as const),
    success: true,
    score: 1,
    safetyIncident: false,
    evidenceRef: `exposure:ex-${String(index).padStart(32, "0")}`,
    recordHash: String(index + 1)
      .repeat(64)
      .slice(0, 64),
  }))

const completeFacts = (): PromotionGateFacts => {
  const evaluationReport = report()
  const canary = canaryReportFor({
    candidateID: "ev-promotion-gate",
    candidateDigest,
    observations: observations(),
    policy,
  })
  return {
    actor: "user:usr_promotion",
    candidateID: "ev-promotion-gate",
    candidateDigest,
    artifactVerified: true,
    sourceProvenanceVerified: true,
    manifest: {
      artifact_digest: candidateDigest,
      source_experience_ids: ["exp_verified"],
      source_evidence_ids: ["evd_verified"],
      source_evaluation_ids: ["eva_source_verified"],
      source_provenance_digest: sourceProvenanceDigest,
      capability_boundary: { permission_requests: [], secret_refs: [], network_egress: [] },
      rollback_artifact: {
        artifact_id: "art_rollback",
        digest: rollbackDigest,
        plan_digest: rollbackPlanDigest,
        operation: "deactivate_strategy_overlay",
      },
    },
    evaluation: {
      id: evaluationReport.evaluation_id,
      baseline: baselineDigest,
      candidate: candidateDigest,
      sampleSize: evaluationReport.cases.length,
      successDelta: 0,
      costDelta: 0,
      latencyDelta: 0,
      passed: true,
      evidenceIDs: ["evd_verified"],
    },
    evaluationReport,
    evaluationStorageVerified: true,
    approval: {
      actor: "user:usr_promotion",
      candidate_digest: candidateDigest,
      evaluation_id: evaluationReport.evaluation_id,
      report_digest: evaluationReport.report_digest,
      policy_version: "arforge-risk/1",
    },
    canaryReport: canary,
    rollbackArtifactVerified: true,
    policy,
  }
}

describe("PromotionGate", () => {
  test("binds every Step 7.11 prerequisite into one deterministic receipt", () => {
    const first = PromotionGate.assert(completeFacts())
    const second = PromotionGate.assert(completeFacts())
    expect(first).toEqual(second)
    expect(first.gate_passed).toBe(true)
    expect(first.checks).toEqual({
      immutable_artifact_digest: true,
      source_experience_evidence: true,
      baseline_candidate_evaluation: true,
      safety_pass: true,
      permission_pass: true,
      secret_pass: true,
      egress_pass: true,
      budget_pass: true,
      human_actor_approval: true,
      canary_cohort_observations: true,
      no_unacceptable_regression: true,
      rollback_artifact_plan: true,
      current_policy_version: true,
    })
    expect(first.canary.observation_ids).toHaveLength(10)
    expect(first.policy).toEqual(promotionPolicySnapshot(policy))
    expect(first.gate_digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test("fails closed when any required evidence class is absent or stale", () => {
    const mutations: ReadonlyArray<(facts: PromotionGateFacts) => PromotionGateFacts> = [
      (facts) => ({ ...facts, artifactVerified: false }),
      (facts) => ({ ...facts, sourceProvenanceVerified: false }),
      (facts) => ({ ...facts, manifest: { ...facts.manifest, source_experience_ids: [] } }),
      (facts) => ({ ...facts, evaluationStorageVerified: false }),
      (facts) => ({
        ...facts,
        evaluationReport: {
          ...facts.evaluationReport,
          cases: facts.evaluationReport.cases.map((item) =>
            item.case_id === "permission-boundary" ? { ...item, passed: false } : item,
          ),
        },
      }),
      (facts) => ({
        ...facts,
        evaluationReport: {
          ...facts.evaluationReport,
          budget: { ...facts.evaluationReport.budget, passed: false },
        },
      }),
      (facts) => ({ ...facts, actor: "system:self-approver" }),
      (facts) => ({
        ...facts,
        canaryReport: { ...facts.canaryReport, candidate_observations: 0, gate_passed: false },
      }),
      (facts) => ({ ...facts, rollbackArtifactVerified: false }),
      (facts) => ({
        ...facts,
        canaryReport: { ...facts.canaryReport, policy_digest: "f".repeat(64) },
      }),
    ]
    for (const mutate of mutations)
      expect(() => PromotionGate.assert(mutate(completeFacts()))).toThrow(PromotionGateError)
  })

  test("rejects a forged or replayed receipt that is not current", () => {
    const facts = completeFacts()
    const receipt = PromotionGate.assert(facts)
    expect(PromotionGate.assertPresented(facts, receipt)).toEqual(receipt)
    expect(() =>
      PromotionGate.assertPresented(facts, {
        ...receipt,
        source_evidence_ids: ["evd_attacker"],
      }),
    ).toThrow(PromotionGateError)
    expect(() =>
      PromotionGate.assertPresented({ ...facts, policy: { ...policy, min_canary_success_rate: 0.9 } }, receipt),
    ).toThrow(PromotionGateError)
  })
})
