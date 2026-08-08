/**
 * Independent verifier core logic (executor/verifier separation).
 *
 * The executor produces a result; the verifier independently checks it by
 * running explicit verification commands (tests, type checks, linters,
 * grep-based assertions) and producing a structured pass/fail report that is
 * fed back to the model as evidence. `summarize` and `report` are pure so
 * they are unit-testable without a shell.
 */

export interface VerificationCheckInput {
  readonly command: string
  readonly exitCode: number | null
  readonly output: string
}

export interface VerificationCheck {
  readonly command: string
  readonly ok: boolean
  readonly exitCode: number | null
  readonly outputTail: string
}

export interface VerificationSummary {
  readonly passed: boolean
  readonly total: number
  readonly passedCount: number
  readonly failedChecks: ReadonlyArray<string>
}

const MAX_TAIL = 600

export function runChecks(checks: ReadonlyArray<VerificationCheckInput>): ReadonlyArray<VerificationCheck> {
  return checks.map((check) => ({
    command: check.command,
    ok: check.exitCode === 0,
    exitCode: check.exitCode,
    outputTail: check.output.slice(-MAX_TAIL),
  }))
}

export function summarize(checks: ReadonlyArray<VerificationCheck>): VerificationSummary {
  const passedCount = checks.filter((check) => check.ok).length
  return {
    passed: checks.length > 0 && passedCount === checks.length,
    total: checks.length,
    passedCount,
    failedChecks: checks.filter((check) => !check.ok).map((check) => check.command),
  }
}

export function verificationReport(summary: VerificationSummary): string {
  const lines = [
    "## 验证报告（独立 Verifier）",
    `通过 ${summary.passedCount}/${summary.total}`,
  ]
  if (summary.passed) {
    lines.push("结论：PASSED — 全部验证项通过。")
  } else {
    lines.push("结论：FAILED — 以下验证项未通过：")
    for (const command of summary.failedChecks) lines.push(`- \`${command}\``)
    lines.push("在继续任务之前，必须修复验证失败项或说明其不适用。")
  }
  return lines.join("\n")
}
