import { describe, expect, it } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect } from "effect"
import { resolve } from "node:path"
import { GOLDEN_CASES, replayDeterministic } from "../../src/runtime/golden"
import { comparePythonTypeScriptRun, type PythonMigrationSnapshot, type TypeScriptMigrationSnapshot } from "../../src/runtime/migration"

const pythonExecutable = Bun.which("python") ?? Bun.which("python3")

const goldenCase = GOLDEN_CASES["formal-pricing-01"]!

const python: PythonMigrationSnapshot = {
  caseID: goldenCase.caseID,
  category: goldenCase.legacyCategory,
  fixtureDigest: goldenCase.fixtureDigest,
  passed: true,
  score: 1,
  platform: "linux",
  toolSurfaceRevision: "python-tools-v1",
  tokenEstimatorID: "python-legacy-estimator-v1",
  providerAdapterID: "legacy-deepseek-adapter-v1",
}

const typescript: TypeScriptMigrationSnapshot = {
  caseID: goldenCase.caseID,
  suiteID: goldenCase.suiteID,
  suiteRevision: goldenCase.suiteRevision,
  caseRevision: goldenCase.caseRevision,
  fixtureDigest: goldenCase.fixtureDigest,
  passed: true,
  score: 1,
  platform: "win32",
  toolSurfaceRevision: "runtime-tools-v2",
  tokenEstimatorID: "runtime-billing-estimator-v1",
  providerAdapterID: "offline-recorded-provider-v1",
}

describe("RuntimeMigration", () => {
  it("passes equivalent results while preserving explainable runtime differences", () => {
    const comparison = comparePythonTypeScriptRun({ goldenCase, python, typescript })
    expect(comparison.equivalent).toBe(true)
    expect(comparison.status).toBe("equivalent-with-explanations")
    expect(comparison.blockingDifferences).toHaveLength(0)
    expect(comparison.explanations.map((difference) => difference.kind)).toEqual([
      "platform",
      "tool-surface",
      "token-estimator",
      "provider-adapter",
    ])
  })

  it("blocks a fixture or outcome mismatch", () => {
    const comparison = comparePythonTypeScriptRun({
      goldenCase,
      python: { ...python, fixtureDigest: "python-fixture-digest" },
      typescript: { ...typescript, passed: false },
    })
    expect(comparison.equivalent).toBe(false)
    expect(comparison.status).toBe("incompatible")
    expect(comparison.blockingDifferences.map((difference) => difference.kind)).toEqual(["manifest", "result"])
  })

  it("rejects a case identity drift even when the result passes", () => {
    const comparison = comparePythonTypeScriptRun({
      goldenCase,
      python: { ...python, caseID: "formal-pricing-02" },
      typescript,
    })
    expect(comparison.equivalent).toBe(false)
    expect(comparison.blockingDifferences[0]?.field).toBe("python.caseID")
  })

  it("compares the real Python and TS capability-eval runs without a second result writer", async () => {
    expect(pythonExecutable).not.toBeNull()
    if (pythonExecutable === null) return
    const script = `
from arforge.core.capability_eval import report_to_dict, run_capability_eval
import json
print(json.dumps(report_to_dict(run_capability_eval()), ensure_ascii=False))
`
    const pythonResult = Bun.spawnSync([pythonExecutable, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(pythonResult.exitCode).toBe(0)
    const report = JSON.parse(new TextDecoder().decode(pythonResult.stdout)) as {
      readonly passed: number
      readonly total: number
      readonly cases: ReadonlyArray<{
        readonly task_id: string
        readonly category: string
        readonly success: boolean
      }>
    }
    expect(report.total).toBe(26)
    expect(report.passed).toBe(26)

    const comparisons = []
    for (const legacyCase of report.cases) {
      const goldenCase = GOLDEN_CASES[legacyCase.task_id]!
      const tsResult = await Effect.runPromise(
        replayDeterministic({
          kind: "deterministic-tool-fixture",
          goldenCase,
          runID: AgentRuntime.RunID.make(`run_migration_${legacyCase.task_id}`),
          traceID: `migration_trace_${legacyCase.task_id}`,
          sessionID: `migration_session_${legacyCase.task_id}`,
          toolCallID: `migration_tool_${legacyCase.task_id}`,
          baselineArtifactDigest: "a".repeat(64),
          candidateArtifactDigest: "b".repeat(64),
          environmentDigest: "c".repeat(64),
          toolchainDigest: "d".repeat(64),
          evidenceIDs: [AgentRuntime.EvidenceID.make(`evd_migration_${legacyCase.task_id}`)],
          baselinePassed: false,
          actual: { passed: legacyCase.success, modelInvoked: false },
          checks: [{ command: `run_capability_eval task=${legacyCase.task_id}`, exitCode: 0, output: "PASS" }],
        }),
      )
      const pythonSnapshot: PythonMigrationSnapshot = {
        caseID: legacyCase.task_id,
        category: legacyCase.category,
        fixtureDigest: goldenCase.fixtureDigest,
        passed: legacyCase.success,
        score: legacyCase.success ? 1 : 0,
        platform: "win32",
        toolSurfaceRevision: "python-capability-tools-v1",
        tokenEstimatorID: "python-zero-token-estimator-v1",
        providerAdapterID: "local-capability-adapter-v1",
      }
      const typescriptSnapshot: TypeScriptMigrationSnapshot = {
        caseID: tsResult.evaluation.caseID,
        suiteID: tsResult.evaluation.suiteID,
        suiteRevision: tsResult.evaluation.suiteRevision,
        caseRevision: tsResult.evaluation.caseRevision,
        fixtureDigest: tsResult.fixtureDigest,
        passed: tsResult.passed,
        score: tsResult.score,
        platform: "win32",
        toolSurfaceRevision: "runtime-tools-v2",
        tokenEstimatorID: "runtime-zero-token-estimator-v1",
        providerAdapterID: "offline-capability-replay-v1",
      }
      comparisons.push(comparePythonTypeScriptRun({ goldenCase, python: pythonSnapshot, typescript: typescriptSnapshot }))
    }
    expect(comparisons).toHaveLength(26)
    expect(comparisons.every((comparison) => comparison.equivalent)).toBe(true)
    expect(comparisons.every((comparison) => comparison.status === "equivalent-with-explanations")).toBe(true)
  }, 30_000)
})
