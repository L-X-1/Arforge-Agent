import { describe, expect, it } from "bun:test"
import {
  RecoveryContractRegistry,
  RecoveryPlanner,
  RecoveryPlannerError,
  createDefaultRecoveryContracts,
} from "@arforge-ai/core/runtime/recovery-planner"

describe("RecoveryPlanner", () => {
  it("replays only independently verified durable results", () => {
    const planner = new RecoveryPlanner(createDefaultRecoveryContracts())
    const result = planner.decide({
      actionKind: "share",
      actionVersion: "1",
      phase: "observed",
      leaseExpired: false,
      hasIntentDigest: true,
      observationStatus: "succeeded",
      verifierPassed: true,
      externalState: "known_success",
      modelSuggestion: "compensate",
    })
    expect(result).toMatchObject({
      kind: "replay_result",
      eligible: true,
      deterministic: true,
      modelSuggestion: "compensate",
    })
    expect(result.reason).toContain("independent verifier")
  })

  it("uses reconciliation before resumption when external state is unknown", () => {
    const planner = new RecoveryPlanner(createDefaultRecoveryContracts())
    const result = planner.decide({
      actionKind: "shell",
      actionVersion: "1",
      phase: "authorized",
      leaseExpired: true,
      hasIntentDigest: true,
      externalState: "unknown",
      modelSuggestion: "resume_safe_phase",
    })
    expect(result.kind).toBe("reconcile_external_state")
    expect(result.modelSuggestion).toBe("resume_safe_phase")
  })

  it("limits resume and compensation to contract-declared eligibility", () => {
    const planner = new RecoveryPlanner(createDefaultRecoveryContracts())
    expect(
      planner.decide({
        actionKind: "file",
        actionVersion: "1",
        phase: "authorized",
        leaseExpired: true,
        hasIntentDigest: true,
        externalState: "not_applicable",
      }).kind,
    ).toBe("resume_safe_phase")
    expect(
      planner.decide({
        actionKind: "worktree",
        actionVersion: "1",
        phase: "failed",
        leaseExpired: true,
        hasIntentDigest: true,
        externalState: "known_failure",
      }).kind,
    ).toBe("compensate")
    expect(
      planner.decide({
        actionKind: "share",
        actionVersion: "1",
        phase: "executing",
        leaseExpired: true,
        hasIntentDigest: true,
        externalState: "known_failure",
      }).kind,
    ).toBe("pause_for_manual")
  })

  it("fails closed for missing intent, active lease, terminal state, and unknown contracts", () => {
    const planner = new RecoveryPlanner(createDefaultRecoveryContracts())
    expect(
      planner.decide({
        actionKind: "file",
        actionVersion: "1",
        phase: "authorized",
        leaseExpired: true,
        hasIntentDigest: false,
        externalState: "not_applicable",
      }).kind,
    ).toBe("pause_for_manual")
    expect(
      planner.decide({
        actionKind: "file",
        actionVersion: "1",
        phase: "authorized",
        leaseExpired: false,
        hasIntentDigest: true,
        externalState: "not_applicable",
      }).kind,
    ).toBe("pause_for_manual")
    expect(
      planner.decide({
        actionKind: "file",
        actionVersion: "1",
        phase: "cancelled",
        leaseExpired: true,
        hasIntentDigest: true,
        externalState: "known_failure",
      }),
    ).toMatchObject({ kind: "fail_terminal", eligible: false })
    expect(() =>
      planner.decide({
        actionKind: "unknown",
        actionVersion: "1",
        phase: "executing",
        leaseExpired: true,
        hasIntentDigest: true,
        externalState: "unknown",
      }),
    ).toThrow(RecoveryPlannerError)
  })

  it("keeps registry contracts declarative and rejects duplicates", () => {
    const registry = new RecoveryContractRegistry()
    const contract = {
      actionKind: "test",
      actionVersion: "1",
      safeResumePhases: ["authorized"],
      canReplayResult: false,
      canReconcileExternalState: false,
      compensation: "unavailable" as const,
    }
    registry.register(contract)
    expect(() => registry.register(contract)).toThrow(/already registered/)
    expect(registry.list()[0]?.safeResumePhases).toEqual(["authorized"])
  })
})
