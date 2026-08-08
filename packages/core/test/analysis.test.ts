import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { AnalysisRuns } from "@arforge-ai/core/analysis/runs"
import { AnalysisQuality } from "@arforge-ai/core/analysis/quality"

function tempHome(): string {
  const home = join(tmpdir(), `arforge-analysis-test-${randomUUID().replace(/-/g, "")}`)
  mkdirSync(join(home, "runs"), { recursive: true })
  return home
}

function writeRun(home: string, runId: string, payload: Record<string, unknown>): void {
  writeFileSync(join(home, "runs", `${runId}.json`), JSON.stringify(payload), "utf8")
}

describe("AnalysisRuns", () => {
  test("lists persisted runs and builds summaries", () => {
    const home = tempHome()
    writeRun(home, "run-001", {
      run_id: "run-001",
      created: "2026-08-08 10:00:00",
      entries: [{ path: "/workspace/a.py", original: "x" }],
    })
    writeFileSync(
      join(home, "runs", "run-001.trace.json"),
      JSON.stringify({
        run_id: "run-001",
        created: "2026-08-08 10:00:00",
        trace: [
          { event: "command", command: "pytest", success: true, returncode: 0 },
          { event: "tool", tool: "read_file", args: { filename: "a.py" } },
        ],
        answer: "done",
      }),
      "utf8",
    )
    writeRun(home, "run-002", { run_id: "run-002", created: "2026-08-08 11:00:00", entries: [] })

    const summaries = AnalysisRuns.listRunReports(20, home)
    expect(summaries.map((item) => item.run_id)).toEqual(["run-002", "run-001"])
    const first = summaries[1]
    expect(first).toMatchObject({
      run_id: "run-001",
      has_transaction: true,
      has_trace: true,
      changed_files: 1,
      trace_events: 2,
      answer_preview: "done",
    })

    const report = AnalysisRuns.buildRunReport("run-001", home)
    expect(report.commands_run).toEqual([{ command: "pytest", success: true, returncode: 0 }])
    expect(report.changed_files).toEqual(["/workspace/a.py"])
    expect(report.trace_truncated).toBe(false)
  })

  test("exports a bounded portable trace with secret redaction", () => {
    const home = tempHome()
    writeFileSync(
      join(home, "runs", "run-trace.trace.json"),
      JSON.stringify({
        run_id: "run-trace",
        created: "2026-08-08 10:00:00",
        trace: [
          { event: "command", command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' http://x" },
          { event: "tool", tool: "write_file", args: { filename: "a.py", content: "sk-0123456789abcdefghijklmnopqrstuv" } },
        ],
        observability: { token: "super-secret-value" },
      }),
      "utf8",
    )
    const exported = AnalysisRuns.exportRunTrace("run-trace", home)
    expect(exported.format).toBe("json")
    expect(exported.content).toContain("arforge.run.trace")
    expect(exported.content).not.toContain("abcdefghijklmnopqrstuvwxyz123456")
    expect(exported.content).not.toContain("sk-0123456789abcdefghijklmnopqrstuv")
    expect(exported.content).not.toContain("super-secret-value")
    expect(exported.content).toContain("[REDACTED_SECRET]")
  })

  test("rejects unsafe run identifiers", () => {
    expect(() => AnalysisRuns.validatedRunId("../etc/passwd")).toThrow()
    expect(() => AnalysisRuns.validatedRunId("bad..id")).toThrow()
    expect(AnalysisRuns.validatedRunId("run-001")).toBe("run-001")
  })
})

describe("AnalysisQuality", () => {
  test("passes clean changed files", () => {
    const home = tempHome()
    writeFileSync(join(home, "lib.py"), "def f():\n    return 1\n", "utf8")
    const report = AnalysisQuality.assessQualityChange(["lib.py"], { root: home })
    expect(report.passed).toBe(true)
    expect(report.score).toBe(100)
    expect(report.files_checked).toBe(1)
  })

  test("flags trailing whitespace and tab indentation as errors", () => {
    const home = tempHome()
    writeFileSync(join(home, "bad.py"), "def f():  \n\treturn 1\n", "utf8")
    const report = AnalysisQuality.assessQualityChange(["bad.py"], { root: home })
    expect(report.passed).toBe(false)
    const codes = report.issues.map((issue) => issue.code)
    expect(codes).toContain("trailing-whitespace")
    expect(codes).toContain("tab-indent")
    expect(report.score).toBe(50)
  })

  test("parses unified diff stats and flags large diffs", () => {
    const patch = [
      "diff --git a/a.py b/a.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/a.py",
      "@@ -0,0 +1,3 @@",
      "+line1",
      "+line2",
      "+line3",
      "diff --git a/b.py b/b.py",
      "--- a/b.py",
      "+++ b/b.py",
      "@@ -1,1 +1,2 @@",
      "-old",
      "+new",
    ].join("\n")
    const stats = AnalysisQuality.parseUnifiedDiffStats(patch)
    expect(stats).toMatchObject({ files_changed: 2, additions: 4, deletions: 1, hunks: 2, new_files: 1 })

    const huge = `${"+" + "x".repeat(40)}\n`.repeat(501)
    const home = tempHome()
    writeFileSync(join(home, "a.py"), "x\n", "utf8")
    const report = AnalysisQuality.assessQualityChange(["a.py"], { root: home, patchText: huge })
    expect(report.issues.map((issue) => issue.code)).toContain("large-diff")
  })

  test("warns on generated files and public-surface changes without docs", () => {
    const home = tempHome()
    mkdirSync(join(home, "dist"), { recursive: true })
    mkdirSync(join(home, "arforge"), { recursive: true })
    writeFileSync(join(home, "dist", "bundle.js"), "// built\n", "utf8")
    writeFileSync(join(home, "arforge", "cli.py"), "print('x')\n", "utf8")
    const report = AnalysisQuality.assessQualityChange(["dist/bundle.js", "arforge/cli.py"], { root: home })
    const codes = report.issues.map((issue) => issue.code)
    expect(codes).toContain("generated-file")
    expect(codes).toContain("docs-sync")
  })

  test("formats the quality report deterministically", () => {
    const home = tempHome()
    writeFileSync(join(home, "bad.py"), "x  \n", "utf8")
    const report = AnalysisQuality.assessQualityChange(["bad.py"], { root: home })
    const formatted = AnalysisQuality.formatQualityReport(report)
    expect(formatted).toContain("G12 quality gate: REVIEW")
    expect(formatted).toContain("[error] trailing-whitespace")
  })
})
