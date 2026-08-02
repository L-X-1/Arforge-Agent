import { Global } from "@arforge-ai/core/global"
import { EOL } from "node:os"
import path from "node:path"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { pruneLogs, scanSensitiveFiles } from "./private-operations"

interface LogsPruneArgs {
  readonly days?: number
  readonly apply: boolean
  readonly json: boolean
}

interface SecretsScanArgs {
  readonly directory?: string
  readonly "max-files": number
  readonly json: boolean
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`
}

export const LogsPruneCommand = cmd<{}, LogsPruneArgs>({
  command: "logs-prune [days]",
  describe: "预览或应用私人日志保留策略",
  builder: (yargs: Argv) =>
    yargs
      .positional("days", {
        type: "number",
        describe: "保留最近多少天的日志",
        default: 30,
      })
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "实际删除；省略时只预览",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      }),
  async handler(args) {
    const result = await pruneLogs(Global.Path.log, args.days ?? 30, { apply: args.apply })
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    process.stdout.write(
      `${result.apply ? "已删除" : "预览"}：${result.files} 个过期日志，${formatBytes(result.bytes)}${EOL}`,
    )
    process.stdout.write(`日志目录：${result.root}${EOL}`)
    process.stdout.write(`截止时间：${result.cutoff}${EOL}`)
    if (!result.apply && result.files > 0) {
      process.stdout.write(`确认后执行：arforge logs-prune ${result.retentionDays} --apply${EOL}`)
    }
  },
})

export const SecretsScanCommand = cmd<{}, SecretsScanArgs>({
  command: "secrets-scan [directory]",
  describe: "扫描本地文件中的凭据模式，绝不输出凭据值",
  builder: (yargs: Argv) =>
    yargs
      .positional("directory", {
        type: "string",
        describe: "扫描目录；默认扫描 Arforge 私人数据目录",
      })
      .option("max-files", {
        type: "number",
        default: 50_000,
        describe: "最多扫描的文本文件数",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      }),
  async handler(args) {
    const root = path.resolve(args.directory ?? Global.Path.data)
    const result = await scanSensitiveFiles(root, { maxFiles: args["max-files"] })
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
    } else {
      process.stdout.write(
        `凭据扫描：${result.filesScanned} 个文本文件，${result.findings.length} 个命中文件，跳过 ${result.filesSkipped} 个文件${EOL}`,
      )
      for (const finding of result.findings) {
        const categories = Object.entries(finding.categories)
          .map(([category, count]) => `${category}=${count}`)
          .join(", ")
        process.stdout.write(`- ${finding.path}: ${categories}${EOL}`)
      }
      if (result.truncated) process.stdout.write("警告：已达到文件上限，结果不完整。" + EOL)
    }
    if (result.findings.length > 0 || result.truncated) process.exitCode = 1
  },
})
