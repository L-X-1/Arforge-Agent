import { AgentPython } from "@arforge-ai/core/agent-python"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { Effect, Schema } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { effectCmd, fail } from "../effect-cmd"

const productRoot = resolve(import.meta.dir, "../../../../..")
const decodeList = Schema.decodeUnknownEffect(AgentCapability.RunList)
const decodeReport = Schema.decodeUnknownEffect(AgentCapability.RunReportResult)

export const RunHistoryCommand = effectCmd({
  command: "run-history [run-id]",
  describe: "查看旧 Core 与新界面共用的持久化运行记录",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("run-id", {
        describe: "可选的运行 ID；省略时列出最近记录",
        type: "string",
      })
      .option("workspace", {
        describe: "工作区目录，默认为当前目录",
        type: "string",
      })
      .option("limit", {
        describe: "列表最大记录数",
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
      return yield* fail("--limit 必须是 1 到 100 之间的整数。")
    }

    const workspace = resolve(args.workspace ?? process.cwd())
    const result = yield* Effect.gen(function* () {
      const bridge = yield* AgentPython.Service
      if (args.runId) {
        return yield* bridge.call("run.report", { run_id: args.runId }).pipe(Effect.flatMap(decodeReport))
      }
      return yield* bridge.call("run.list", { limit: args.limit }).pipe(Effect.flatMap(decodeList))
    }).pipe(
      Effect.provide(
        AgentPython.layer({
          runtimeRoot: process.env.ARFORGE_AGENT_RUNTIME_ROOT || productRoot,
          workspace,
          pythonExecutable: process.env.ARFORGE_AGENT_PYTHON || undefined,
          home: process.env.ARFORGE_HOME || undefined,
        }),
      ),
      Effect.scoped,
      Effect.catch((error) =>
        fail(error instanceof Error ? `运行记录读取失败：${error.message}` : "运行记录读取失败。"),
      ),
    )

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }

    if ("items" in result) {
      process.stdout.write(`Arforge 运行记录：${result.count} 条${EOL}`)
      for (const item of result.items) {
        process.stdout.write(
          `- ${item.run_id} · ${item.created || "时间未知"} · 文件 ${item.changed_files} · ` +
            `事件 ${item.trace_events} · 消息 ${item.messages_count}${EOL}`,
        )
        if (item.answer_preview) process.stdout.write(`  ${item.answer_preview.replace(/\s+/g, " ").trim()}${EOL}`)
      }
      if (result.count === 0) process.stdout.write(`尚无持久化运行记录。${EOL}`)
      return
    }

    if (!result.found) {
      process.stdout.write(`未找到运行记录：${result.run_id || "最新记录"}${EOL}`)
      return
    }

    const report = result.report
    process.stdout.write(`Arforge 运行报告：${report.run_id}${EOL}`)
    process.stdout.write(`创建时间：${report.created || "未知"}${EOL}`)
    process.stdout.write(
      `文件 ${report.changed_files.length} · 命令 ${report.commands_run.length} · ` +
        `事件 ${report.trace_events} · 消息 ${report.messages_count}${report.trace_truncated ? " · 事件已截断" : ""}${EOL}`,
    )
    if (report.answer) process.stdout.write(`${report.answer}${EOL}`)
  }),
})
