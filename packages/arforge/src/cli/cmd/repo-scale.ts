import { RepoScale } from "@arforge-ai/core/analysis/repo-scale"
import { Effect } from "effect"
import { statSync } from "node:fs"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { effectCmd, fail } from "../effect-cmd"

function isDirectoryTarget(workspace: string, value: string): boolean {
  try {
    return statSync(resolve(workspace, value)).isDirectory()
  } catch {
    return false
  }
}

function looksLikeLegacyPath(workspace: string, value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return false
  if (normalized === "." || normalized === ".." || isDirectoryTarget(workspace, normalized)) return true
  // A path-shaped value should not silently become a search query when the
  // target is missing; the scanner will return its normal bounded empty report.
  return normalized.includes("/") || normalized.includes("\\") || /^[A-Za-z]:$/.test(normalized)
}

export const RepoScaleCommand = effectCmd({
  command: "repo-scale [target]",
  describe: "扫描大型仓库并执行有界本地搜索",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("target", {
        describe: "搜索词；也接受 Python 旧入口的扫描路径",
        type: "string",
      })
      .option("query", {
        describe: "Python 旧入口兼容的搜索词（与位置扫描路径一起使用）",
        type: "string",
      })
      .option("workspace", {
        describe: "工作区目录，默认为当前目录",
        type: "string",
      })
      .option("path", {
        describe: "工作区内要扫描的相对目录",
        type: "string",
        default: ".",
      })
      .option("max-files", {
        describe: "本次扫描的最大代码文件数",
        type: "number",
      })
      .option("limit", {
        describe: "最大文件与搜索结果条数",
        type: "number",
        default: 20,
      })
      .option("json", {
        describe: "输出机器可读 JSON",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.repoScale")(function* (args) {
    const workspace = resolve(args.workspace ?? process.cwd())
    const target = args.target?.trim()
    const explicitQuery = args.query?.trim()
    const explicitPath = args.path !== undefined && args.path !== "."

    // Python historically used `repo-scale <path> --query <text>`.  Keep that
    // argv shape in the same handler while preserving the canonical TS form
    // `repo-scale [query] --path <relative-dir>`.
    if (target && explicitQuery !== undefined && explicitPath) {
      return yield* fail("位置扫描路径、--query 与 --path 不能同时使用；请只保留一种路径写法。")
    }

    let scanPath = args.path ?? "."
    let query = explicitQuery ?? target ?? ""
    if (target && explicitQuery !== undefined) {
      scanPath = target
    } else if (target && !explicitPath && looksLikeLegacyPath(workspace, target)) {
      scanPath = target
      query = ""
    }

    const maxFiles = args.maxFiles ?? 5_000
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) {
      return yield* fail("--max-files 必须是 1 到 100000 之间的整数。")
    }
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      return yield* fail("--limit 必须是 1 到 100 之间的整数。")
    }

    const root = scanPath === "." ? workspace : resolve(workspace, scanPath)
    const result = RepoScale.buildRepoScaleReport(root, {
      query,
      maxFiles,
      limit: args.limit,
    })

    if (args.json) {
      process.stdout.write(JSON.stringify({ workspace, ...result }, null, 2) + EOL)
      return
    }

    process.stdout.write(`Arforge 仓库规模：${result.scan.total} 个已索引代码文件${EOL}`)
    process.stdout.write(`根目录：${result.root}${EOL}`)
    process.stdout.write(`扫描：${result.scan.scan_time_ms} ms · 全量${result.scan.truncated ? " · 已达到预算上限" : ""}${EOL}`)
    if (result.search.query) {
      process.stdout.write(
        `搜索 “${result.search.query}”：${result.search.total} 个文件命中，检查 ${result.search.searched_files} 个文件${EOL}`,
      )
      for (const item of result.search.items) {
        process.stdout.write(`- ${item.path}:${item.line}（${item.score}） ${item.preview}${EOL}`)
      }
    }
    for (const recommendation of result.recommendations) {
      process.stdout.write(`建议：${recommendation}${EOL}`)
    }
  }),
})
