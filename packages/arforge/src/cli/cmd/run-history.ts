import { AnalysisRuns } from "@arforge-ai/core/analysis/runs"
import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { effectCmd, fail } from "../effect-cmd"

export const RunHistoryCommand = effectCmd({
  command: "run-history [run-id]",
  // `replay` is the historical Python spelling for this read-only report
  // surface. Both names call the same Core AnalysisRuns owner; no replay
  // cache, trace journal, or second command implementation is introduced.
  aliases: ["replay"],
  describe: "查看持久化的运行记录（与 Core 共享）",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("run-id", {
        describe: "可选的运行 ID，省略时列出最近记录",
        type: "string",
      })
      .option("workspace", {
        describe: "工作区目录，默认为当前目录",
        type: "string",
      })
      .option("limit", {
        describe: "列表最大条数",
        type: "number",
        default: 20,
      })
      .option("json", {
        describe: "输出机器可读 JSON",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.runHistory")(function* (args) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      return yield* fail("--limit 必须是 1 到 100 之间的整数")
    }
    const workspace = resolve(args.workspace ?? process.cwd())
    const home = process.env.ARFORGE_HOME

    const result = yield* Effect.try({
      try: () => {
        if (args.runId) {
          try {
            return {
              schema_version: 1,
              found: true,
              run_id: args.runId,
              report: AnalysisRuns.buildRunReport(args.runId, home),
            }
          } catch {
            return {
              schema_version: 1,
              found: false,
              run_id: args.runId,
              report: null,
            }
          }
        }
        const items = AnalysisRuns.listRunReports(args.limit, home)
        return {
          schema_version: 1,
          count: items.length,
          items,
        }
      },
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => fail(`运行记录读取失败：${error instanceof Error ? error.message : String(error)}`)),
    )

    if (args.json) {
      process.stdout.write(JSON.stringify({ workspace, ...result }, null, 2) + EOL)
      return
    }

    if (args.runId && result.found) {
      const report = (result as { report: ReturnType<typeof AnalysisRuns.buildRunReport> }).report
      process.stdout.write(`运行 ${report.run_id}（${report.created}）${EOL}`)
      process.stdout.write(
        `  变更文件：${report.changed_files.length}，trace 事件：${report.trace_events}，消息：${report.messages_count}${EOL}`,
      )
      if (report.commands_run.length > 0) {
        process.stdout.write(`  命令：${report.commands_run.map((cmd) => cmd.command).join("；")}${EOL}`)
      }
      if (report.answer) {
        process.stdout.write(`  答案：${report.answer.slice(0, 240)}${EOL}`)
      }
      return
    }
    if (args.runId) {
      process.stdout.write(`运行记录未找到：${args.runId}${EOL}`)
      return
    }

    const summaries = (result as { items: ReturnType<typeof AnalysisRuns.listRunReports> }).items
    process.stdout.write(`运行记录（最近 ${summaries.length} 条）${EOL}`)
    for (const item of summaries) {
      process.stdout.write(
        `- ${item.run_id}（${item.created}）变更 ${item.changed_files} 文件，trace ${item.trace_events} 事件${EOL}`,
      )
    }
  }),
})
