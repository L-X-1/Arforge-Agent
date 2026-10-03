import {
  agentMetricsHistory,
  agentMetricsReport,
  clearAgentMetricsHistory,
  readAgentMetricsHistory,
} from "@arforge-ai/core/analysis/agent-metrics"
import { Global } from "@arforge-ai/core/global"
import { Effect } from "effect"
import { EOL } from "node:os"
import { CliError, effectCmd, fail } from "../effect-cmd"

const actions = ["report", "history", "record"] as const

function boundedLimit(value: number | undefined): Effect.Effect<number, CliError> {
  const limit = value ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return fail("--limit 必须是 1 到 500 之间的整数。")
  }
  return Effect.succeed(limit)
}

function metricText(value: unknown): string {
  if (value === null || value === undefined) return "n/a"
  return typeof value === "number" ? value.toFixed(4) : String(value)
}

function renderReport(payload: ReturnType<typeof agentMetricsReport>): string {
  const lines: string[] = ["", "Agent Quality Metrics"]
  const metricNames = [
    "success_rate",
    "avg_tool_calls",
    "invalid_action_rate",
    "first_attempt_success_rate",
    "recovery_success_rate",
    "verification_coverage",
    "verification_pass_rate",
    "patch_regression_rate",
  ] as const
  for (const name of metricNames) {
    lines.push(`${name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}: ${metricText(payload.metrics[name]?.value)}`)
  }
  lines.push("", "Release Gates")
  lines.push(`Formal dogfood: ${payload.gates.formal_dogfood}`)
  lines.push(`Longitudinal: ${payload.gates.longitudinal_dogfood}`)
  lines.push("", "Data Sources")
  for (const [name, info] of Object.entries(payload.sources)) {
    const status = String(info.status ?? "unknown")
    const detail = info.rows !== undefined ? ` rows=${String(info.rows)}` : ""
    lines.push(`${name}: ${status}${detail}`)
  }
  return lines.join(EOL) + EOL
}

function renderHistory(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return `没有指标历史快照。${EOL}`
  const lines = [`指标历史快照：${rows.length} 条`]
  for (const row of rows) {
    const metrics = typeof row.metrics === "object" && row.metrics !== null ? (row.metrics as Record<string, unknown>) : {}
    lines.push(
      `- ${String(row.ts ?? "unknown")} · success=${metricText(metrics.success_rate)} · recovery=${metricText(metrics.recovery_success_rate)} · regression=${metricText(metrics.patch_regression_rate)}`,
    )
  }
  return lines.join(EOL) + EOL
}

/**
 * TypeScript/Core owner for the historical Python ``agent-metrics`` command.
 * Report and history use the same profile-local telemetry files; no session
 * database or second Python metrics store is opened.
 */
export const AgentMetricsCommand = effectCmd({
  command: "agent-metrics [action]",
  describe: "查看 Agent 质量指标、门禁和本地遥测历史",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "操作；省略时为 report",
        choices: actions,
        default: "report",
      })
      .option("json", {
        describe: "输出机器可读 JSON",
        type: "boolean",
        default: false,
      })
      .option("limit", {
        describe: "history/record 返回的最近快照数量（1-500）",
        type: "number",
        default: 50,
      })
      .option("clear", {
        describe: "删除本地 agent_metrics.jsonl 历史快照",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.agentMetrics")(function* (args) {
    const action = args.action ?? "report"
    const limit = yield* boundedLimit(args.limit)
    if (args.clear) {
      if (action !== "report") return yield* fail("--clear 只能与 agent-metrics report 一起使用。")
      const cleared = clearAgentMetricsHistory(Global.Path.data)
      if (args.json) {
        process.stdout.write(JSON.stringify({ cleared_rows: cleared }) + EOL)
      } else {
        process.stdout.write(`已清理 ${cleared} 条 Agent 指标历史快照。${EOL}`)
      }
      return
    }

    if (action === "report") {
      const payload = agentMetricsReport(Global.Path.data)
      if (args.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + EOL)
      } else {
        process.stdout.write(renderReport(payload))
      }
      return
    }

    const rows = action === "record" ? agentMetricsHistory(limit, Global.Path.data) : readAgentMetricsHistory(limit, Global.Path.data)
    if (args.json) {
      process.stdout.write(JSON.stringify({ items: rows, count: rows.length }) + EOL)
    } else {
      process.stdout.write(renderHistory(rows))
    }
  }),
})
