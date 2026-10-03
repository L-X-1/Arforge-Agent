import { describe, expect, test } from "bun:test"
import { makeRecoveryDiagnostics } from "../../src/session/recovery-diagnostics"

describe("recovery diagnostics", () => {
  test("logs immediately and periodically without extending suppression on each scan", () => {
    const diagnostics = makeRecoveryDiagnostics()
    expect(diagnostics.shouldLog("child", "same", 0)).toBe(true)
    for (let now = 2_000; now < 60_000; now += 2_000) expect(diagnostics.shouldLog("child", "same", now)).toBe(false)
    expect(diagnostics.shouldLog("child", "same", 60_000)).toBe(true)
  })

  test("new error or durable revision is immediately visible", () => {
    const diagnostics = makeRecoveryDiagnostics()
    expect(diagnostics.shouldLog("child", "revision1:error1", 0)).toBe(true)
    expect(diagnostics.shouldLog("child", "revision1:error2", 1)).toBe(true)
    expect(diagnostics.shouldLog("child", "revision2:error2", 2)).toBe(true)
    expect(diagnostics.shouldLog("child", "revision2:error2", 3)).toBe(false)
  })

  test("successful recovery clears suppression for a subsequent failure", () => {
    const diagnostics = makeRecoveryDiagnostics()
    diagnostics.shouldLog("child", "same", 0)
    diagnostics.clear("child")
    expect(diagnostics.shouldLog("child", "same", 1)).toBe(true)
  })

  test("children and scan-level errors do not suppress each other", () => {
    const diagnostics = makeRecoveryDiagnostics()
    for (const key of ["child1", "child2", "scan"]) expect(diagnostics.shouldLog(key, "same", 0)).toBe(true)
    for (const key of ["child1", "child2", "scan"]) expect(diagnostics.shouldLog(key, "same", 1)).toBe(false)
  })

  test("evicts old diagnostics at the fixed capacity", () => {
    const diagnostics = makeRecoveryDiagnostics()
    for (let id = 0; id < 1_025; id++) diagnostics.shouldLog(String(id), "same", 0)
    expect(diagnostics.shouldLog("1024", "same", 1)).toBe(false)
    expect(diagnostics.shouldLog("0", "same", 1)).toBe(true)
  })

  test("clock rollback cannot suppress a warning indefinitely", () => {
    const diagnostics = makeRecoveryDiagnostics()
    diagnostics.shouldLog("child", "same", 60_000)
    expect(diagnostics.shouldLog("child", "same", 0)).toBe(true)
  })
})
