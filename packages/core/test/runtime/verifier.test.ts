import { describe, expect, it } from "bun:test"
import { runChecks, summarize, verificationReport } from "@arforge-ai/core/runtime/verifier"

describe("RuntimeVerifier", () => {
  it("marks checks ok when exit code is zero", () => {
    const checks = runChecks([
      { command: "npm test", exitCode: 0, output: "all green" },
      { command: "npm run lint", exitCode: 1, output: "lint error here" },
    ])
    expect(checks[0].ok).toBe(true)
    expect(checks[1].ok).toBe(false)
    expect(checks[1].outputTail).toBe("lint error here")
  })

  it("summarizes pass/fail and lists failed commands", () => {
    const checks = runChecks([
      { command: "a", exitCode: 0, output: "" },
      { command: "b", exitCode: 2, output: "boom" },
    ])
    const summary = summarize(checks)
    expect(summary.passed).toBe(false)
    expect(summary.total).toBe(2)
    expect(summary.passedCount).toBe(1)
    expect(summary.failedChecks).toEqual(["b"])
  })

  it("passes only when there are checks and all of them pass", () => {
    expect(summarize([]).passed).toBe(false)
    expect(summarize([{ command: "a", ok: true, exitCode: 0, outputTail: "" }]).passed).toBe(true)
  })

  it("renders a report for the model", () => {
    const report = verificationReport({ passed: false, total: 2, passedCount: 1, failedChecks: ["b"] })
    expect(report).toContain("FAILED")
    expect(report).toContain("`b`")
    const passed = verificationReport({ passed: true, total: 2, passedCount: 2, failedChecks: [] })
    expect(passed).toContain("PASSED")
  })

  it("truncates long outputs", () => {
    const checks = runChecks([{ command: "a", exitCode: 1, output: "x".repeat(2000) }])
    expect(checks[0].outputTail.length).toBeLessThanOrEqual(600)
  })
})
