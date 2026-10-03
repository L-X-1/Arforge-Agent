import { describe, expect, test } from "bun:test"
import { evaluateSloWindow } from "@arforge-ai/core/runtime/slo"

const passingWindow = {
  startAt: 1_700_000_000_000,
  endAt: 1_700_000_360_000,
  api: { totalRequests: 10_000, goodRequests: 9_995, p95LatencyMs: 420 },
  tenantIsolation: { probeCount: 38, crossScopeViolations: 0, policyBypasses: 0 },
  backupRestore: { attempts: 1, successful: 1, mismatchCount: 0, temporaryDatabaseCleanup: true },
  migrationIntegrity: {
    attempts: 1,
    successful: 1,
    rowCountMismatch: 0,
    rlsChecksPassed: true,
    schemaRevision: "20260814091000",
  },
} as const

describe("SLO evaluation", () => {
  test("returns SHIP only when every required SLO has complete passing evidence", () => {
    const report = evaluateSloWindow(passingWindow)

    expect(report.releaseGate).toEqual({ decision: "SHIP", reasons: [] })
    expect(report.slos.every((result) => result.status === "pass" && result.evidenceComplete)).toBe(true)
    expect(report.alerts.filter((alert) => alert.status === "active")).toHaveLength(0)
  })

  test("missing evidence is unknown and blocks the release", () => {
    const report = evaluateSloWindow({ startAt: 1, endAt: 2 })

    expect(report.releaseGate.decision).toBe("DO_NOT_SHIP")
    expect(report.slos.every((result) => result.status === "unknown")).toBe(true)
    expect(report.alerts.filter((alert) => alert.severity === "page" && alert.status === "active")).toHaveLength(2)
  })

  test("tenant isolation, backup mismatch, and RLS failures page immediately", () => {
    const report = evaluateSloWindow({
      ...passingWindow,
      tenantIsolation: { probeCount: 38, crossScopeViolations: 1, policyBypasses: 0 },
      backupRestore: { attempts: 1, successful: 1, mismatchCount: 1, temporaryDatabaseCleanup: true },
      migrationIntegrity: { ...passingWindow.migrationIntegrity, rlsChecksPassed: false },
    })

    expect(report.releaseGate.decision).toBe("DO_NOT_SHIP")
    expect(report.alerts.filter((alert) => alert.status === "active").map((alert) => alert.id)).toEqual([
      "critical.tenant-isolation",
      "critical.migration-or-backup",
    ])
  })

  test("invalid windows and rate/budget anomalies never pass silently", () => {
    const report = evaluateSloWindow({ ...passingWindow, startAt: 2, endAt: 1, rateOrBudgetUnexpected: true })

    expect(report.releaseGate.decision).toBe("DO_NOT_SHIP")
    expect(report.alerts.find((alert) => alert.id === "warning.rate-or-budget")).toMatchObject({
      status: "active",
      severity: "ticket",
    })
    expect(report.slos.every((result) => result.status === "unknown")).toBe(true)
  })
})
