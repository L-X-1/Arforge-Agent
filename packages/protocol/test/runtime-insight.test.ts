import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  ActionRecoveryRecord,
  ChildSettlementRecoverySweepRecord,
  ChildSettlementRecoverySweepRequest,
  DurableActionRecord,
  MutationReviewRequest,
  MutationRollbackRequest,
} from "../src/groups/runtime-insight"

const base = {
  actionID: "act_1",
  runID: null,
  sessionID: "ses_1",
  name: "write",
  status: "blocked",
  authority: "scoped_grant",
  riskTier: "L2",
  reasonSummary: "recovery required",
  resourceCount: 1,
  observationStatus: null,
  resultReplayable: false,
  outputDigest: null,
  outputByteLength: null,
  attemptsUsed: 1,
  maxAttempts: 3,
  durationMsUsed: 10,
  maxDurationMs: 1_000,
  costMicrosUsed: 0,
  maxCostMicros: 0,
  createdAt: 1,
  updatedAt: 2,
}

describe("runtime insight mutation recovery contract", () => {
  test("requires explicit bounded approval for a metadata-only settlement sweep", () => {
    const request = Schema.decodeUnknownSync(ChildSettlementRecoverySweepRequest)
    expect(request({ approval: "recover_settlements", limit: 25, status: "prepared" })).toEqual({
      approval: "recover_settlements",
      limit: 25,
      status: "prepared",
    })
    expect(() => request({ approval: "recover_settlements", limit: 0 })).toThrow()
    expect(() => request({ approval: "recover_settlement", limit: 25 })).toThrow()

    const decode = Schema.decodeUnknownSync(ChildSettlementRecoverySweepRecord)
    const record = decode({
      schemaVersion: 1,
      status: null,
      limit: 25,
      scanned: 1,
      committed: 1,
      pending: 0,
      recoveryRequired: 0,
      failed: 0,
      hasMore: false,
      items: [
        {
          intentID: "stl_" + "a".repeat(64),
          parentRunID: "run_parent",
          childRunID: "run_child",
          sourceStatus: "prepared",
          afterStatus: "committed",
          outcome: "committed",
          attempted: ["child-result"],
          repaired: ["child-result"],
          reason: "completed",
        },
      ],
      deterministic: true,
      providerExecutionAllowed: false,
      reason: "completed",
      access: {
        role: "owner",
        canReviewMutation: true,
        canRollbackMutation: true,
        canMaintainArtifacts: true,
        canRecordMcpEvidence: true,
      },
    })
    expect(record.items[0]?.outcome).toBe("committed")
    expect(JSON.stringify(record)).not.toContain("payload")
  })

  test("accepts a content-free recovery classification and its null legacy shape", () => {
    const decode = Schema.decodeUnknownSync(DurableActionRecord)
    expect(
      decode({
        ...base,
        mutationRecovery: {
          transactionID: "mut_1",
          phase: "prepared",
          decision: "inspect",
          automaticRetryAllowed: false,
          requiresReview: true,
          reason: "Inspect the recorded targets before retrying.",
        },
      }).mutationRecovery?.automaticRetryAllowed,
    ).toBe(false)
    const withCheckpoints = decode({
      ...base,
      mutationRecovery: {
        transactionID: "mut_1",
        phase: "postprocessing",
        decision: "inspect",
        automaticRetryAllowed: false,
        requiresReview: true,
        postProcessing: [
          { sequence: 0, stage: "formatter", status: "started", target: "src/index.ts" },
          { sequence: 1, stage: "formatter", status: "completed", target: "src/index.ts" },
        ],
        postProcessingRecovery: {
          status: "completed_unsettled",
          reason: "All recorded post-processing stages have completion facts, but settlement is pending.",
        },
        reason: "inspect targets",
      },
    })
    expect(withCheckpoints.mutationRecovery?.postProcessing?.[1]?.status).toBe("completed")
    expect(withCheckpoints.mutationRecovery?.postProcessingRecovery?.status).toBe("completed_unsettled")
    expect(decode({ ...base, mutationRecovery: null }).mutationRecovery).toBeNull()
  })

  test("accepts a read-only target inspection result without action commands", () => {
    const recovery = Schema.decodeUnknownSync(ActionRecoveryRecord)({
      actionID: "act_1",
      actionStatus: "blocked",
      state: "outcome_unknown",
      outcome: null,
      repair: { required: true, source: "action-gateway-recovery", reason: "inspect" },
      mutationRecovery: {
        transactionID: "mut_1",
        phase: "committed",
        decision: "inspect",
        automaticRetryAllowed: false,
        requiresReview: true,
        reason: "inspect targets",
      },
      inspection: {
        transactionID: "mut_1",
        phase: "committed",
        observationDigest: "a".repeat(64),
        decision: "postimage_matches",
        automaticRetryAllowed: false,
        rollbackAvailable: true,
        entries: [{ target: "src/index.ts", operation: "write", state: "postimage_matches" }],
        reason: "digest-only observation",
      },
      inspectionError: null,
      artifact: null,
      access: {
        role: "member",
        canReviewMutation: true,
        canRollbackMutation: false,
        canMaintainArtifacts: false,
        canRecordMcpEvidence: false,
      },
    })
    expect(recovery.inspection?.entries[0]?.state).toBe("postimage_matches")
    expect(JSON.stringify(recovery)).not.toContain("file-content")
  })

  test("requires an explicit bounded access projection for recovery clients", () => {
    const decode = Schema.decodeUnknownSync(ActionRecoveryRecord)
    expect(() =>
      decode({
        actionID: "act_1",
        actionStatus: "blocked",
        state: "outcome_unknown",
        outcome: null,
        repair: { required: true, source: "action-gateway-recovery", reason: "inspect" },
        mutationRecovery: null,
        inspection: null,
        inspectionError: null,
        artifact: null,
      }),
    ).toThrow()
  })

  test("keeps human review decisions narrow and evidence-labelled", () => {
    const decode = Schema.decodeUnknownSync(MutationReviewRequest)
    expect(
      decode({
        transactionID: "mut_1",
        expectedPhase: "committed",
        observationDigest: "a".repeat(64),
        decision: "settle_postimage",
        inspectedDecision: "postimage_matches",
      }).decision,
    ).toBe("settle_postimage")
    expect(() =>
      decode({
        transactionID: "mut_1",
        expectedPhase: "committed",
        observationDigest: "a".repeat(64),
        decision: "retry",
        inspectedDecision: "postimage_matches",
      }),
    ).toThrow()
  })

  test("requires explicit approval for artifact rollback", () => {
    const decode = Schema.decodeUnknownSync(MutationRollbackRequest)
    expect(
      decode({
        transactionID: "mut_1",
        expectedPhase: "rollback_required",
        observationDigest: "a".repeat(64),
        inspectedDecision: "postimage_matches",
        approval: "execute_rollback",
      }).approval,
    ).toBe("execute_rollback")
    expect(() =>
      decode({
        transactionID: "mut_1",
        expectedPhase: "committed",
        observationDigest: "a".repeat(64),
        inspectedDecision: "postimage_matches",
        approval: "execute_rollback",
      }),
    ).toThrow()
  })
})
