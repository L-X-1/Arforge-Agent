import { describe, expect, test } from "bun:test"
import {
  assertDiagnosticReadOnlyExecutionBoundary,
  assertSettlementReadOnlyExecutionBoundary,
  assertWorkspaceReadOnlyExecutionBoundary,
  diagnosticReadOnlyExecutionBoundary,
  settlementReadOnlyExecutionBoundary,
  workspaceReadOnlyExecutionBoundary,
} from "../../src/runtime/execution-boundary"

describe("ExecutionBoundary", () => {
  test("builds the same non-authorizing common boundary for workspace and settlement", () => {
    const workspace = workspaceReadOnlyExecutionBoundary()
    const settlement = settlementReadOnlyExecutionBoundary()

    expect(workspace).toEqual({
      mode: "read-only",
      writes: false,
      creates_profile_state: false,
      repairs_recovery: false,
      provider_execution_allowed: false,
    })
    expect(settlement).toEqual({
      mode: "read-only",
      writes: false,
      creates_settlement_state: false,
      repairs_recovery: false,
      provider_execution_allowed: false,
    })
    expect(Object.keys(workspace).filter((key) => key !== "creates_profile_state")).toEqual(
      Object.keys(settlement).filter((key) => key !== "creates_settlement_state"),
    )
  })

  test("returns independent cards so one caller cannot mutate another projection", () => {
    const first = workspaceReadOnlyExecutionBoundary()
    const second = workspaceReadOnlyExecutionBoundary()
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })

  test("builds and validates the combined diagnostics boundary", () => {
    const boundary = diagnosticReadOnlyExecutionBoundary()
    expect(boundary).toEqual({
      mode: "read-only",
      writes: false,
      repairs_recovery: false,
      provider_execution_allowed: false,
      creates_profile_state: false,
      creates_settlement_state: false,
    })
    expect(() => assertDiagnosticReadOnlyExecutionBoundary(boundary)).not.toThrow()
    expect(() => assertDiagnosticReadOnlyExecutionBoundary({ ...boundary, creates_profile_state: true })).toThrow(
      "profile or settlement state",
    )
  })

  test("accepts exact boundary cards and rejects an attempted write authorization", () => {
    expect(() => assertWorkspaceReadOnlyExecutionBoundary(workspaceReadOnlyExecutionBoundary())).not.toThrow()
    expect(() => assertSettlementReadOnlyExecutionBoundary(settlementReadOnlyExecutionBoundary())).not.toThrow()
    expect(() =>
      assertWorkspaceReadOnlyExecutionBoundary({
        ...workspaceReadOnlyExecutionBoundary(),
        writes: true,
      }),
    ).toThrow("read-only")
    expect(() =>
      assertSettlementReadOnlyExecutionBoundary({
        ...settlementReadOnlyExecutionBoundary(),
        provider_execution_allowed: true,
      }),
    ).toThrow("read-only")
  })

  test("rejects missing state-specific protections and unknown values", () => {
    expect(() =>
      assertWorkspaceReadOnlyExecutionBoundary({
        mode: "read-only",
        writes: false,
        repairs_recovery: false,
        provider_execution_allowed: false,
      }),
    ).toThrow("profile state")
    expect(() => assertSettlementReadOnlyExecutionBoundary(undefined)).toThrow("read-only")
    expect(() =>
      assertSettlementReadOnlyExecutionBoundary({
        ...settlementReadOnlyExecutionBoundary(),
        creates_settlement_state: true,
      }),
    ).toThrow("settlement state")
    expect(() =>
      assertWorkspaceReadOnlyExecutionBoundary({
        ...workspaceReadOnlyExecutionBoundary(),
        unknown: false,
      }),
    ).toThrow("fields drifted")
    expect(() =>
      assertSettlementReadOnlyExecutionBoundary({
        ...settlementReadOnlyExecutionBoundary(),
        unknown: false,
      }),
    ).toThrow("fields drifted")
    expect(() =>
      assertDiagnosticReadOnlyExecutionBoundary({
        ...diagnosticReadOnlyExecutionBoundary(),
        unknown: false,
      }),
    ).toThrow("fields drifted")
  })
})
