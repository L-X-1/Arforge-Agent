import { describe, expect, test } from "bun:test"
import { EvolutionLevelViolation, EvolutionLevels } from "@arforge-ai/core/evolution/level"

describe("EvolutionLevels", () => {
  test("keeps L0 reports inert and L1 runtime tuning non-security-critical and reversible", () => {
    expect(EvolutionLevels.assert({ level: "L0", operation: "suggest" })).toMatchObject({
      level: "L0",
      operation: "suggest",
    })
    expect(EvolutionLevels.assert({ level: "L0", operation: "report" })).toMatchObject({ level: "L0" })
    expect(() =>
      EvolutionLevels.assert({
        level: "L0",
        operation: "adjust_runtime_parameter",
        target: "runtime.parameter.temperature",
        reversible: true,
        securityCritical: false,
      }),
    ).toThrow(EvolutionLevelViolation)

    expect(
      EvolutionLevels.assert({
        level: "L1",
        operation: "adjust_runtime_parameter",
        target: "runtime.parameter.retry_delay_ms",
        reversible: true,
        securityCritical: false,
      }),
    ).toMatchObject({ level: "L1", reversible: true, securityCritical: false })
    for (const claim of [
      {
        level: "L1" as const,
        operation: "adjust_runtime_parameter" as const,
        target: "permission.auto_allow",
        reversible: true,
        securityCritical: false,
      },
      {
        level: "L1" as const,
        operation: "adjust_runtime_parameter" as const,
        target: "runtime.parameter.retry_delay_ms",
        reversible: false,
        securityCritical: false,
      },
      {
        level: "L1" as const,
        operation: "adjust_runtime_parameter" as const,
        target: "runtime.parameter.retry_delay_ms",
        reversible: true,
        securityCritical: true,
      },
    ]) {
      expect(() => EvolutionLevels.assert(claim)).toThrow(EvolutionLevelViolation)
    }
  })

  test("bounds L2 artifacts, L3 isolation, and L4 controlled promotion", () => {
    expect(
      EvolutionLevels.assert({ level: "L2", operation: "create_candidate", candidateKind: "skill" }),
    ).toMatchObject({ level: "L2", candidateKind: "skill" })
    expect(
      EvolutionLevels.assert({
        level: "L2",
        operation: "offline_evaluate",
        candidateKind: "workflow",
        isolated: true,
      }),
    ).toMatchObject({ level: "L2", isolated: true })
    expect(() => EvolutionLevels.assert({ level: "L2", operation: "create_candidate", candidateKind: "code" })).toThrow(
      EvolutionLevelViolation,
    )
    expect(() =>
      EvolutionLevels.assert({
        level: "L2",
        operation: "offline_evaluate",
        candidateKind: "prompt",
        isolated: false,
      }),
    ).toThrow(EvolutionLevelViolation)

    expect(
      EvolutionLevels.assert({
        level: "L3",
        operation: "start_canary",
        candidateKind: "skill",
        isolated: true,
        reversible: true,
      }),
    ).toMatchObject({ level: "L3", isolated: true, reversible: true })
    expect(() =>
      EvolutionLevels.assert({
        level: "L3",
        operation: "start_canary",
        candidateKind: "skill",
        isolated: false,
        reversible: true,
      }),
    ).toThrow(EvolutionLevelViolation)

    expect(
      EvolutionLevels.assert({
        level: "L4",
        operation: "promote",
        candidateKind: "skill",
        humanApproved: true,
        controlled: true,
        rollbackReady: true,
      }),
    ).toMatchObject({ level: "L4", humanApproved: true })
    expect(
      EvolutionLevels.assert({
        level: "L4",
        operation: "promote",
        candidateKind: "prompt",
        policyApproved: true,
        controlled: true,
        rollbackReady: true,
      }),
    ).toMatchObject({ level: "L4", policyApproved: true })
    for (const claim of [
      {
        level: "L4" as const,
        operation: "promote" as const,
        candidateKind: "skill" as const,
        controlled: true,
        rollbackReady: true,
      },
      {
        level: "L4" as const,
        operation: "promote" as const,
        candidateKind: "skill" as const,
        humanApproved: true,
        controlled: false,
        rollbackReady: true,
      },
      {
        level: "L4" as const,
        operation: "promote" as const,
        candidateKind: "skill" as const,
        humanApproved: true,
        controlled: true,
        rollbackReady: false,
      },
    ]) {
      expect(() => EvolutionLevels.assert(claim)).toThrow(EvolutionLevelViolation)
    }
  })

  test("forbids L5 source modification and publishing and freezes the policy matrix", () => {
    expect(() => EvolutionLevels.assert({ level: "L5", operation: "modify_core_source" })).toThrow(
      /L5 autonomous core source modification and publishing are forbidden/,
    )
    expect(() => EvolutionLevels.assert({ level: "L5", operation: "publish_core" })).toThrow(EvolutionLevelViolation)
    expect(EvolutionLevels.forStatus("signal")).toBe("L0")
    expect(EvolutionLevels.forStatus("proposal")).toBe("L2")
    expect(EvolutionLevels.forStatus("canary")).toBe("L3")
    expect(EvolutionLevels.forStatus("promoted")).toBe("L4")
    expect(EvolutionLevels.forStatus("rolled_back")).toBe("L2")
    expect(Object.isFrozen(EvolutionLevels)).toBe(true)
    expect(Object.isFrozen(EvolutionLevels.MATRIX)).toBe(true)
    expect(Object.values(EvolutionLevels.MATRIX).every(Object.isFrozen)).toBe(true)
  })
})
