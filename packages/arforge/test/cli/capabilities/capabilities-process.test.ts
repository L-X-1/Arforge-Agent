import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("arforge capabilities test Python compatibility (TS Core route owner)", () => {
  cliIt.concurrent(
    "previews deterministic routes without executing handlers or producing side effects",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn([
          "capabilities",
          "test",
          "plan",
          "architecture",
          "and",
          "design",
          "--limit",
          "1",
          "--json",
        ])
        arforge.expectExit(result, 0, "capabilities test")
        const report = JSON.parse(result.stdout)
        expect(report).toMatchObject({
          workspace: home,
          input: "plan architecture and design",
          route_reason: "keyword",
          execution_mode: "route-preview",
          side_effects: "none",
          executed: 0,
          succeeded: 0,
          failed: 0,
          matched: 1,
          capabilities_used: ["planning"],
        })
        expect(report.items[0]).toMatchObject({ name: "planning", status: "matched-not-executed" })
        expect(result.stderr).toBe("")
        const metricsExists = yield* Effect.promise(() => Bun.file(`${home}/agent_metrics.jsonl`).exists())
        expect(metricsExists).toBe(false)
      }),
    30_000,
  )

  cliIt.concurrent(
    "fails closed for missing input and the unfinished execute mode",
    ({ arforge }) =>
      Effect.gen(function* () {
        const missing = yield* arforge.spawn(["capabilities", "test"])
        arforge.expectExit(missing, 1, "capabilities test missing input")
        expect(missing.stdout).toBe("")
        expect(missing.stderr).toContain("capabilities test")

        const execute = yield* arforge.spawn(["capabilities", "test", "plan", "a", "feature", "--execute"])
        arforge.expectExit(execute, 2, "capabilities test execute")
        expect(execute.stdout).toBe("")
        expect(execute.stderr).toContain("只提供无副作用路由预览")
      }),
    30_000,
  )

  cliIt.concurrent(
    "exposes a read-only typed execution contract audit",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const reportResult = yield* arforge.spawn(["capabilities", "evaluate", "--workspace", home, "--json"])
        arforge.expectExit(reportResult, 0, "capabilities evaluate")
        const report = JSON.parse(reportResult.stdout) as {
          workspace: string
          execution_mode: string
          side_effects: string
          catalog_count: number
          enabled_count: number
          ready_count: number
          not_ready_count: number
          handlers_executed: number
          model_invoked: boolean
          items: Array<{ status: string; missing_requirements: string[] }>
        }
        expect(report).toMatchObject({
          workspace: home,
          execution_mode: "read-only-capability-contract-audit",
          side_effects: "none",
          catalog_count: 18,
          enabled_count: 18,
          ready_count: 0,
          not_ready_count: 18,
          handlers_executed: 0,
          model_invoked: false,
        })
        expect(report.items).toHaveLength(18)
        expect(report.items.every((item) => item.status === "not_ready")).toBe(true)
        expect(report.items[0]?.missing_requirements).toContain("typed_input_schema")
        expect(reportResult.stderr).toBe("")

        const human = yield* arforge.spawn(["capabilities", "evaluate", "--workspace", home])
        arforge.expectExit(human, 0, "capabilities evaluate human")
        expect(human.stdout).toContain("只读")
        expect(human.stdout).toContain("保持 fail-closed")
        expect(human.stdout).toContain("未调用 handler")
      }),
    30_000,
  )

  cliIt.concurrent(
    "exposes the typed system overview and its fused cost contract",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const reportResult = yield* arforge.spawn(["capabilities", "overview", "--workspace", home, "--json"])
        arforge.expectExit(reportResult, 0, "capabilities overview")
        const report = JSON.parse(reportResult.stdout) as {
          workspace: string
          schema_version: number
          sections: Array<{
            id: string
            title: string
            data: { execution_mode?: string; status?: string; side_effects?: string }
          }>
        }
        expect(report).toMatchObject({ workspace: home, schema_version: 1 })
        const cost = report.sections.find((section) => section.id === "cost-optimization")
        expect(cost).toMatchObject({
          title: "Cost optimization contract",
          data: {
            execution_mode: "read-only-cost-optimization-contract-audit",
            status: "not_ready",
            side_effects: "none",
          },
        })
        expect(reportResult.stderr).toBe("")

        const human = yield* arforge.spawn(["capabilities", "overview", "--workspace", home])
        arforge.expectExit(human, 0, "capabilities overview human")
        expect(human.stdout).toContain("能力系统概览（只读）")
        expect(human.stdout).toContain("Cost optimization contract")
      }),
    30_000,
  )
})
