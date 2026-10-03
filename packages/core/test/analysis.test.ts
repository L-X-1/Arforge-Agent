import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { AnalysisRuns } from "@arforge-ai/core/analysis/runs"
import { AnalysisQuality } from "@arforge-ai/core/analysis/quality"
import { CapabilityAnalysis } from "@arforge-ai/core/analysis/capabilities"
import { auditCostOptimizationContract } from "@arforge-ai/core/analysis/cost-optimization"
import { auditFeaturePolicyContract, FEATURE_POLICY_REQUIREMENTS } from "@arforge-ai/core/analysis/feature-policy"
import { composeLearningRecall } from "@arforge-ai/core/analysis/learning-recall"
import { composeLearningDream } from "@arforge-ai/core/analysis/learning-dream"
import { auditFileStateContract } from "@arforge-ai/core/analysis/file-state"
import { MemoryDigestAnalysis } from "@arforge-ai/core/analysis/memory-digest"
import { MemoryConflictAnalysis, type ConflictMemory } from "@arforge-ai/core/analysis/memory-conflict"
import { MemoryMetricsAnalysis, MemoryWriteStatsAnalysis } from "@arforge-ai/core/analysis/memory-metrics"
import { MemoryRecoveryAnalysis } from "@arforge-ai/core/analysis/memory-recovery"
import { MemoryFeedbackAnalysis, MEMORY_FEEDBACK_REQUIREMENTS } from "@arforge-ai/core/analysis/memory-feedback"
import { auditPermissionPolicyContract, PERMISSION_POLICY_REQUIREMENTS } from "@arforge-ai/core/analysis/permission-policy"
import {
  agentMetricsHistory,
  agentMetricsReport,
  clearAgentMetricsHistory,
  readAgentMetricsHistory,
} from "@arforge-ai/core/analysis/agent-metrics"

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
          {
            event: "tool",
            tool: "write_file",
            args: { filename: "a.py", content: "sk-0123456789abcdefghijklmnopqrstuv" },
          },
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

describe("CapabilityAnalysis", () => {
  test("ranks keyword routes without executing capability handlers", () => {
    const report = CapabilityAnalysis.test("plan architecture and design for a CLI tool")
    expect(report).toMatchObject({
      schema_version: 1,
      route_reason: "keyword",
      execution_mode: "route-preview",
      side_effects: "none",
      executed: 0,
      succeeded: 0,
      failed: 0,
    })
    expect(report.capabilities_used[0]).toBe("planning")
    expect(report.items[0]).toMatchObject({
      name: "planning",
      score: 3,
      status: "matched-not-executed",
    })
    expect(report.not_executed).toBe(report.matched)
  })

  test("returns a stable empty route and respects the match limit", () => {
    const empty = CapabilityAnalysis.test("hello from a neutral chat")
    expect(empty).toMatchObject({ route_reason: "none", total: 0, matched: 0, not_executed: 0 })

    const limited = CapabilityAnalysis.test("search code and review security", { limit: 1 })
    expect(limited.items).toHaveLength(1)
    expect(limited.capabilities_used).toEqual([limited.items[0].name])
  })

  test("audits typed execution readiness without invoking handlers", () => {
    const report = CapabilityAnalysis.evaluate()
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-capability-contract-audit",
      side_effects: "none",
      catalog_count: 18,
      enabled_count: 18,
      ready_count: 0,
      not_ready_count: 18,
      disabled_count: 0,
      model_invoked: false,
      handlers_executed: 0,
      decision: "fail-closed",
    })
    expect(report.items).toHaveLength(18)
    expect(report.items[0]).toMatchObject({
      name: "safe_modify",
      status: "not_ready",
      declared_owner: null,
      declared_side_effects: "unknown",
    })
    expect(report.items[0]?.missing_requirements).toEqual(
      expect.arrayContaining([
        "typed_input_schema",
        "action_gateway_authorization",
        "cancellation",
        "evidence",
        "settlement",
      ]),
    )
    expect(report.caveat).toContain("不会调用 handler")
  })
})

describe("LearningRecallAnalysis", () => {
  test("composes canonical memory and learning read-only sources", () => {
    const report = composeLearningRecall(
      {
        status: "operational_baseline",
        sampleSize: 4,
        top1Rate: 0.75,
        meanReciprocalRank: 0.875,
        noResultRate: 0.25,
        caveat: "fixture",
      },
      {
        totalTurns: 6,
        patternCount: 3,
        successRate: 0.5,
        impact: {
          status: "insufficient_data",
          injectedCount: 1,
          baselineCount: 2,
          injectedSuccessRate: 1,
          baselineSuccessRate: 0.5,
          uplift: 0,
          caveat: "fixture",
        },
      },
    )
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-composition",
      top1_hit_rate: 0.75,
      pattern_count: 3,
      sample_size: 4,
      learning_turns: 6,
      learning_impact_status: "insufficient_data",
    })
    expect(report.caveat).toContain("不会运行 dream/consolidation")
  })
})

describe("LearningDreamAnalysis", () => {
  test("projects deterministic insights without running consolidation", () => {
    const report = composeLearningDream(
      {
        totalTurns: 12,
        failedTurns: 5,
        successRate: 5 / 12,
        patternCount: 3,
        patterns: [
          { type: "failure", description: "state machine\nregressed", frequency: 3, confidence: 0.8 },
          { type: "preference", description: "concise responses", frequency: 1, confidence: 0.3 },
        ],
      },
      0,
    )

    expect(report).toMatchObject({
      executionMode: "read-only-core-projection",
      sideEffects: "none",
      consolidation: { status: "not_run", patternsFound: 0, savedNew: 0, updatedExisting: 0 },
      dream: {
        totalTurns: 12,
        totalFailures: 5,
        totalPatterns: 3,
        timestamp: "1970-01-01T00:00:00.000Z",
      },
    })
    expect(report.dream.insights[0]).toContain("Success rate is low (42%)")
    expect(report.dream.insights.some((item) => item.includes("Top failure: state machine regressed"))).toBe(true)
    expect(report.dream.suggestions.some((item) => item.includes("No fix strategies"))).toBe(true)
    expect(report.consolidation.reason).toContain("does not run consolidation")
  })

  test("keeps empty status stable and does not invent a pattern", () => {
    const report = composeLearningDream(
      { totalTurns: 0, failedTurns: 0, successRate: 0, patternCount: 0, patterns: [] },
      1_000,
    )
    expect(report.dream).toMatchObject({
      totalTurns: 0,
      totalFailures: 0,
      totalPatterns: 0,
      insights: [],
      timestamp: "1970-01-01T00:00:01.000Z",
    })
    expect(report.dream.suggestions).toEqual([
      "No fix strategies are visible yet; collect verified outcomes before proposing one.",
      "No user preferences are visible yet; more explicit feedback may help.",
    ])
  })
})

describe("FileStateAnalysis", () => {
  test("reports the missing cross-process owner without touching state", () => {
    const report = auditFileStateContract()
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-file-state-contract-audit",
      side_effects: "none",
      status: "not_ready",
      ready: false,
      model_invoked: false,
      writes: 0,
      legacy_source: "python-file-state-tracker",
      decision: "fail-closed",
    })
    expect(report.missing_requirements).toHaveLength(10)
    expect(report.missing_requirements).toContain("observation_journal")
    expect(report.missing_requirements).toContain("restart_recovery")
    expect(report.available_primitives).toEqual({
      fileMutationFingerprint: "available-but-not-observation-ledger",
      analysisRuns: "available-but-not-file-observation-ledger",
      pythonTracker: "process-local-compatibility-only",
    })
  })
})

describe("CostOptimizationAnalysis", () => {
  test("reports missing priced durable ledger without reading legacy state", () => {
    const report = auditCostOptimizationContract()
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-cost-optimization-contract-audit",
      side_effects: "none",
      status: "not_ready",
      ready: false,
      model_invoked: false,
      writes: 0,
      legacy_source: "python-cost-optimization",
      decision: "fail-closed",
    })
    expect(report.missing_requirements).toHaveLength(10)
    expect(report.missing_requirements).toContain("provider_pricing_version")
    expect(report.missing_requirements).toContain("token_usage_reconciliation")
    expect(report.available_primitives).toEqual({
      sessionStats: "available-but-not-cost-ledger",
      fileMutationFingerprint: "available-but-not-read-cost-ledger",
      agentMetrics: "available-but-not-cost-ledger",
    })
  })
})

describe("FeaturePolicyAnalysis", () => {
  test("reports the missing transactional feature-policy owner without reading legacy state", () => {
    const report = auditFeaturePolicyContract()
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-feature-policy-contract-audit",
      side_effects: "none",
      status: "not_ready",
      ready: false,
      model_invoked: false,
      writes: 0,
      legacy_source: "python-feature-flags",
      decision: "fail-closed",
    })
    expect(report.missing_requirements).toEqual([...FEATURE_POLICY_REQUIREMENTS])
    expect(report.missing_requirements).toContain("transactional_update")
    expect(report.available_primitives).toEqual({
      nativePolicy: "available-read-only",
      deepInsightsSection: "available-read-only",
      pythonRegistry: "not-read",
    })
  })
})

describe("PermissionPolicyAnalysis", () => {
  test("reports the missing transactional permission-policy owner without reading legacy state", () => {
    const report = auditPermissionPolicyContract()
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-permission-policy-contract-audit",
      side_effects: "none",
      status: "not_ready",
      ready: false,
      model_invoked: false,
      writes: 0,
      legacy_source: "python-permission-profile",
      decision: "fail-closed",
    })
    expect(report.missing_requirements).toEqual([...PERMISSION_POLICY_REQUIREMENTS])
    expect(report.missing_requirements).toContain("optimistic_revision")
    expect(report.available_primitives).toEqual({
      savedRuleList: "available-read-only",
      savedRuleStore: "available-but-legacy-write-not-equivalent",
      sessionAuthorizer: "available-session-scoped",
      pythonProfile: "not-read",
    })
  })
})

describe("MemoryDigestAnalysis", () => {
  const items = [
    {
      id: "mem_identity_old",
      content: "用户使用中文",
      type: "identity",
      tags: ["language"],
      importance: 3,
      source: "user",
      createdAt: "2026-01-01T00:00:00Z",
      workspacePath: "C:/workspace",
    },
    {
      id: "mem_identity_new",
      content: "用户偏好短答复",
      type: "identity",
      tags: [],
      importance: 3,
      source: "user",
      createdAt: "2026-02-01T00:00:00Z",
    },
    {
      id: "mem_unknown",
      content: "未分类知识",
      type: "vendor-extension",
      tags: ["knowledge", "compat"],
      importance: 1,
      source: "imported",
      createdAt: "2026-03-01T00:00:00Z",
    },
  ] as const

  test("groups with legacy aliases, deterministic ordering, and bounded report metadata", () => {
    const report = MemoryDigestAnalysis.report(items, {
      generatedAt: "2026-09-01T00:00:00Z",
      sourceLimit: 3,
    })
    expect(report).toMatchObject({
      schema_version: 1,
      generated_at: "2026-09-01T00:00:00Z",
      total: 3,
      category_count: 2,
      truncated: true,
    })
    expect(report.categories.map((category) => category.category)).toEqual(["identity", "knowledge"])
    expect(report.categories[0]?.items.map((item) => item.content)).toEqual(["用户偏好短答复", "用户使用中文"])
    expect(report.categories[1]?.items[0]?.tags).toBe("knowledge,compat")
  })

  test("filters known categories and leaves unknown filters empty", () => {
    expect(MemoryDigestAnalysis.group(items, "identity")).toHaveLength(1)
    expect(MemoryDigestAnalysis.group(items, "missing")).toEqual([])
    const markdown = MemoryDigestAnalysis.render(MemoryDigestAnalysis.group(items, "identity"), "2026-09-01T00:00:00Z")
    expect(markdown).toContain("用户身份信息")
    expect(markdown).toContain("用户偏好短答复")
    expect(markdown).not.toContain("未分类知识")
  })
})

describe("MemoryConflictAnalysis", () => {
  test("keeps claim extraction and benchmark results deterministic", () => {
    expect(MemoryConflictAnalysis.deriveClaim({ content: "服务器端口是 8080", tags: [] })).toEqual({
      key: "服务器端口",
      value: "8080",
      basis: "deterministic-pattern-v1",
    })
    expect(MemoryConflictAnalysis.deriveClaim({ content: "默认模型是 gpt-4", tags: ["fact-key:model"] })).toEqual({
      key: "model",
      value: "默认模型是 gpt-4",
      basis: "explicit-tag",
    })
    const benchmark = MemoryConflictAnalysis.runBenchmark()
    expect(benchmark).toMatchObject({
      detection_rate: 1,
      false_positive_rate: 0,
      precision: 1,
      recall: 1,
      truncated: false,
    })
    expect(benchmark.case_results.every((result) => result.verdict === "tp" || result.verdict === "tn")).toBe(true)
  })

  test("shares the Core 500-candidate truncation and scope boundary", () => {
    const memories: ConflictMemory[] = Array.from({ length: 33 }, (_, index) => ({
      id: `mem_${String(index + 1).padStart(3, "0")}`,
      content: `服务器端口是 ${index + 1}`,
      tags: [],
      scope: "global",
    }))
    const detected = MemoryConflictAnalysis.detect(memories)
    expect(detected.items).toHaveLength(500)
    expect(detected.truncated).toBe(true)
    expect(
      MemoryConflictAnalysis.detect([
        { ...memories[0], scope: "workspace", project_id: "p1", workspace_path: "/work" },
        { ...memories[1], scope: "global" },
      ]).items,
    ).toHaveLength(0)
  })
})

describe("MemoryMetricsAnalysis", () => {
  test("composes typed read-only sources and keeps legacy benchmark gaps explicit", () => {
    const report = MemoryMetricsAnalysis.compose({
      status: {
        total: 3,
        important: 2,
        workspace: 2,
        global: 1,
        quarantined: 0,
        pendingConflicts: 1,
      },
      recallQuality: {
        status: "operational_baseline",
        sampleSize: 3,
        top1Rate: 0.6667,
        meanReciprocalRank: 0.8333,
        noResultRate: 0,
        caveat: "fixture",
      },
      conflicts: {
        count: 2,
        items: [],
        detectorVersion: "deterministic-v1",
      },
      visible: {
        count: 2,
        total: 3,
        items: [{ source: "user" }, { source: "auto" }],
      },
    })
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-core-memory-metrics",
      side_effects: "none",
      status: { total: 3, pending_conflicts: 1 },
      recall_quality: { sample_size: 3, top1_rate: 0.6667 },
      persisted_conflicts: { count: 2, returned: 0, truncated: true },
      source_coverage: {
        status: "not_comparable",
        visible_total: 3,
        inspected: 2,
        truncated: true,
        by_source: [
          { source: "auto", count: 1 },
          { source: "user", count: 1 },
        ],
      },
      golden_eval: { status: "not_comparable" },
      history: { status: "not_read" },
    })
    expect(report.caveat).toContain("不会写入数据库")
  })

  test("composes write-stats database projection without legacy decision log access", () => {
    const report = MemoryWriteStatsAnalysis.compose({
      status: {
        total: 3,
        important: 2,
        workspace: 2,
        global: 1,
        quarantined: 1,
        pendingConflicts: 0,
      },
      visible: {
        total: 3,
        items: [
          { source: "user", type: "preference", scope: "workspace" },
          { source: "auto", type: "fact", scope: "workspace" },
        ],
      },
    })
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-core-memory-write-stats",
      side_effects: "none",
      database: {
        total: 3,
        quarantined: 1,
        inspected: 2,
        visible_total: 3,
        truncated: true,
        by_source: [
          { source: "auto", count: 1 },
          { source: "user", count: 1 },
        ],
        by_type: [
          { type: "fact", count: 1 },
          { type: "preference", count: 1 },
        ],
        by_scope: [{ scope: "workspace", count: 2 }],
      },
      decision_log: { status: "not_read", file: "memory_writes.jsonl" },
      clear: { status: "unsupported" },
    })
    expect(report.caveat).toContain("eligible/reason/saved")
  })
})

describe("MemoryRecoveryAnalysis", () => {
  test("aggregates valid and corrupt recovery rows without mutating the log", () => {
    const home = tempHome()
    const recoveryPath = join(home, "recovery_outcomes.jsonl")
    const original = [
      JSON.stringify({ ts: "2026-08-26T10:00:00Z", recovery_state: "verified_checkpoint", verified: true }),
      JSON.stringify({ ts: "2026-08-28T10:00:00Z", recovery_state: "rebuild_pending_stale", verified: false }),
      JSON.stringify({ ts: "2026-09-01T08:00:00Z", recovery_state: "rebuild_pending_missing", verified: false }),
      JSON.stringify({ ts: "2026-09-01T09:00:00Z", recovery_state: "transcript_rebuild_pending", verified: false }),
      "not-json",
    ].join("\n")
    writeFileSync(recoveryPath, original, "utf8")

    const report = MemoryRecoveryAnalysis.report(home, new Date("2026-09-01T12:00:00Z"))
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-core-memory-recovery",
      side_effects: "none",
      source: { status: "read", rows: 4, corrupt_rows: 1 },
      events_total: 4,
      verified_count: 1,
      restore_success_rate: 0.25,
      pending_rebuild_rate: 0.75,
      states: {
        verified_checkpoint: { count: 1, ratio: 0.25 },
        rebuild_pending_stale: { count: 1, ratio: 0.25 },
      },
      corrupt_rows: 1,
      clear: { status: "unsupported" },
    })
    expect(report.daily_trend).toHaveLength(7)
    expect(report.daily_trend[0]).toEqual({ date: "2026-08-26", verified: 1, total: 1, rate: 1 })
    expect(report.daily_trend[6]).toEqual({ date: "2026-09-01", verified: 0, total: 2, rate: 0 })
    expect(readFileSync(recoveryPath, "utf8")).toBe(original)
  })
})

describe("MemoryFeedbackAnalysis", () => {
  test("keeps the unproven durable feedback producer fail-closed", () => {
    const report = MemoryFeedbackAnalysis.audit()
    expect(report).toMatchObject({
      schema_version: 1,
      execution_mode: "read-only-memory-feedback-contract-audit",
      side_effects: "none",
      status: "not_ready",
      ready: false,
      model_invoked: false,
      writes: 0,
      legacy_source: "python-memory-retrieval-event",
      decision: "fail-closed",
    })
    expect(report.missing_requirements).toEqual([...MEMORY_FEEDBACK_REQUIREMENTS])
    expect(report.caveat).toContain("跨进程")
    expect(report.caveat).toContain("不会写入 recall feedback")
  })
})

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function hashedOutcome(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    record_hash: createHash("sha256").update(canonicalJson(row), "utf8").digest("hex"),
  }
}

describe("AgentMetrics", () => {
  test("aggregates the legacy seven-metric report from profile-local sources", () => {
    const home = tempHome()
    const rows = [
      hashedOutcome({
        task: "t1",
        task_id: "t1",
        suite_id: "suite-a",
        success: false,
        verification_passed: false,
        verification: { ok: false },
        formal: true,
        real_model: true,
        isolated_workspace: true,
        schema_version: 2,
        duration_seconds: 30,
        tokens: 60_000,
        steps: 10,
        tool_calls: 10,
        failed_tool_calls: 1,
        modified_files: 1,
        run_id: "run-a",
        ts: "2026-01-01T00:00:00Z",
      }),
      hashedOutcome({
        task: "t1",
        task_id: "t1",
        suite_id: "suite-a",
        success: true,
        verification_passed: true,
        verification: { ok: true },
        formal: true,
        real_model: true,
        isolated_workspace: true,
        schema_version: 2,
        duration_seconds: 30,
        tokens: 60_000,
        steps: 10,
        tool_calls: 10,
        failed_tool_calls: 0,
        modified_files: 1,
        run_id: "run-a",
        ts: "2026-01-01T00:00:01Z",
      }),
      hashedOutcome({
        task: "t2",
        task_id: "t2",
        suite_id: "suite-a",
        success: true,
        verification_passed: true,
        verification: { ok: true },
        formal: true,
        real_model: true,
        isolated_workspace: true,
        schema_version: 2,
        duration_seconds: 30,
        tokens: 60_000,
        steps: 10,
        tool_calls: 5,
        failed_tool_calls: 0,
        modified_files: 1,
        run_id: "run-a",
        ts: "2026-01-01T00:00:02Z",
      }),
    ]
    writeFileSync(
      join(home, "dogfood.jsonl"),
      `not-json\n[]\n${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    )
    writeFileSync(join(home, "recovery_outcomes.jsonl"), JSON.stringify({ verified: true }) + "\n", "utf8")
    const report = agentMetricsReport(home)
    expect(report.metrics.success_rate).toMatchObject({ value: 0.6667, n: 3, source: "dogfood" })
    expect(report.metrics.avg_tool_calls).toMatchObject({ value: 8.33, n: 3 })
    expect(report.metrics.invalid_action_rate).toMatchObject({ value: 0.04, tool_calls: 25, failed: 1 })
    expect(report.metrics.first_attempt_success_rate).toMatchObject({ value: 0.5, n: 2 })
    expect(report.metrics.recovery_success_rate).toMatchObject({
      value: 1,
      detail: { context_restore: { value: 1, events: 1 } },
    })
    expect(report.metrics.verification_coverage).toMatchObject({ value: 1, wrote: 3, verified: 3 })
    expect(report.metrics.verification_pass_rate).toMatchObject({ value: 0.6667, n: 3 })
    expect(report.metrics.patch_regression_rate).toMatchObject({ value: 0, regressed: 0, total: 2 })
    expect(report.gates).toEqual({
      formal_dogfood: "insufficient_evidence",
      longitudinal_dogfood: "insufficient_evidence",
    })
  })

  test("records, reads and clears history without affecting the report", () => {
    const home = tempHome()
    const first = agentMetricsHistory(10, home)
    expect(first).toHaveLength(1)
    expect(readAgentMetricsHistory(10, home)).toHaveLength(1)
    expect(agentMetricsHistory(10, home)).toHaveLength(2)
    expect(clearAgentMetricsHistory(home)).toBe(2)
    expect(readAgentMetricsHistory(10, home)).toEqual([])
    expect(clearAgentMetricsHistory(home)).toBe(0)
  })
})
