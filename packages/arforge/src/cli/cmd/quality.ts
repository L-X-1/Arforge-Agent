import { AnalysisQuality } from "@arforge-ai/core/analysis/quality"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { effectCmd, fail } from "../effect-cmd"

export const QualityCommand = effectCmd({
  command: "quality [files..]",
  describe: "运行 Arforge Agent 的只读交付质量门禁",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("files", {
        describe: "要检查的工作区相对文件",
        type: "string",
        array: true,
      })
      .option("workspace", {
        describe: "工作区目录，默认为当前目录",
        type: "string",
      })
      .option("patch-file", {
        describe: "可选的 unified diff 文件",
        type: "string",
      })
      .option("json", {
        describe: "输出机器可读 JSON",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.quality")(function* (args) {
    const workspace = resolve(args.workspace ?? process.cwd())
    const patchText = yield* Effect.tryPromise({
      try: async () => {
        if (!args.patchFile) return undefined
        const value = await readFile(resolve(workspace, args.patchFile), "utf8")
        if (value.length > 500_000) throw new Error("补丁超过 500,000 字符限制。")
        return value
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(Effect.catch((error) => fail(`无法读取补丁：${error.message}`)))

    const result = AnalysisQuality.assessQualityChange([...(args.files ?? [])], {
      patchText,
      root: workspace,
    })

    if (args.json) {
      process.stdout.write(JSON.stringify({ workspace, ...result }, null, 2) + EOL)
      return
    }

    const status = result.passed ? "通过" : "需要复核"
    process.stdout.write(`Arforge 交付质量：${status}（${result.score}/100）${EOL}`)
    process.stdout.write(`工作区：${workspace}${EOL}`)
    process.stdout.write(`${result.summary}${EOL}`)
    if (result.diff_stats) {
      process.stdout.write(
        `变更：${result.diff_stats.files_changed} 个文件，+${result.diff_stats.additions}/-${result.diff_stats.deletions}，${result.diff_stats.hunks} 个区块${EOL}`,
      )
    }
    for (const issue of result.issues) {
      const file = issue.file ? ` ${issue.file}` : ""
      process.stdout.write(`- [${issue.level}] ${issue.code}:${file} ${issue.message}${EOL}`)
    }
  }),
})
