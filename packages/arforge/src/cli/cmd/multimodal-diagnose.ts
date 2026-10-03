import { MultimodalDiagnosis } from "@arforge-ai/schema/multimodal-diagnosis"
import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const modes = ["error", "frontend", "javascript"] as const

const boundedLimit = (value: number | undefined): Effect.Effect<number, CliError> => {
  const limit = value ?? 5
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail("--limit 必须是 1 到 50 之间的整数。")
  return Effect.succeed(limit)
}

const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => new CliError({ message: `多模态诊断失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
  })

function render(result: MultimodalDiagnosis.Result): string {
  const lines = [
    "Multimodal diagnosis",
    `文件：${result.path}`,
    `模式：${result.mode} · 本地 ${result.localOnly ? "是" : "否"} · 模型调用 ${result.modelCalls}`,
    `结果：${result.success ? "可用" : "需要人工处理"} · 文本 ${result.summary.textChars} 字符 · 信号 ${result.summary.signals} · 匹配 ${result.summary.matches}`,
    `来源：${result.source.type}${result.source.error ? ` · ${result.source.error}` : ""}`,
  ]
  if (result.signals.length > 0) {
    lines.push("信号：")
    for (const signal of result.signals.slice(0, 20))
      lines.push(`- ${signal.kind}: ${signal.value}${signal.line ? `:${signal.line}` : ""}`)
  }
  if (result.matches.length > 0) {
    lines.push("代码匹配：")
    for (const match of result.matches.slice(0, 50)) lines.push(`- ${match.file}:${match.line} · ${match.preview}`)
  }
  if (result.suggestions.length > 0) {
    lines.push("建议：")
    for (const suggestion of result.suggestions.slice(0, 20)) lines.push(`- ${suggestion}`)
  }
  for (const warning of result.warnings) lines.push(`警告：${warning}`)
  return lines.join(EOL) + EOL
}

/**
 * TypeScript/Core owner for the historical Python `multimodal-diagnose`
 * command.  The command delegates to the same generated diagnostics endpoint
 * used by Desktop and keeps the path, byte and result bounds in Core.
 */
export const MultimodalDiagnoseCommand = effectCmd({
  command: "multimodal-diagnose <file>",
  describe: "对错误文档、前端 HTML 或 JavaScript 做本地只读诊断",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "工作区内文件路径", type: "string", demandOption: true })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("text", { describe: "可选的提取文本覆盖值", type: "string" })
      .option("limit", { describe: "代码匹配上限（1-50）", type: "number", default: 5 })
      .option("mode", { describe: "诊断模式", choices: modes, default: "error" as const })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.multimodalDiagnose")(function* (args) {
    const workspace = resolve(args.workspace ?? process.cwd())
    const filename = String(args.file ?? "").trim()
    if (!filename) return yield* fail("multimodal-diagnose 需要一个工作区内文件路径。", 2)
    const limit = yield* boundedLimit(args.limit)
    if (args.text !== undefined && args.text.length > 500_000) return yield* fail("--text 最多 500000 个字符。")
    const api = createOperationsApi(workspace)
    const result = yield* invoke(() =>
      api.diagnostics.diagnose({
        location: { directory: workspace },
        filename,
        extractedText: args.text,
        limit,
        mode: args.mode,
      }),
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    process.stdout.write(render(result))
  }),
})
