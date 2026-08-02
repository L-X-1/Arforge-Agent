import { AgentPython } from "@arforge-ai/core/agent-python"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { Effect, Schema } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { effectCmd, fail } from "../effect-cmd"

const productRoot = resolve(import.meta.dir, "../../../../..")
const decodeReport = Schema.decodeUnknownEffect(AgentCapability.RepoScaleReport)

export const RepoScaleCommand = effectCmd({
  command: "repo-scale [query]",
  describe: "扫描大型仓库并执行有界本地搜索",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("query", {
        describe: "可选的本地搜索词",
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
        default: 5_000,
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
    if (!Number.isInteger(args.maxFiles) || args.maxFiles < 1 || args.maxFiles > 100_000) {
      return yield* fail("--max-files 必须是 1 到 100000 之间的整数。")
    }
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      return yield* fail("--limit 必须是 1 到 100 之间的整数。")
    }

    const workspace = resolve(args.workspace ?? process.cwd())
    const result = yield* Effect.gen(function* () {
      const bridge = yield* AgentPython.Service
      return yield* bridge
        .call("repo.scale", {
          path: args.path,
          max_files: args.maxFiles,
          limit: args.limit,
          ...(args.query === undefined ? {} : { query: args.query }),
        })
        .pipe(Effect.flatMap(decodeReport))
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
        fail(error instanceof Error ? `仓库扫描失败：${error.message}` : "仓库扫描失败。"),
      ),
    )

    if (args.json) {
      process.stdout.write(JSON.stringify({ workspace, ...result }, null, 2) + EOL)
      return
    }

    process.stdout.write(`Arforge 仓库规模：${result.scan.total} 个已索引代码文件${EOL}`)
    process.stdout.write(`根目录：${result.root}${EOL}`)
    process.stdout.write(
      `扫描：${result.scan.scan_time_ms} ms · ${result.scan.incremental ? "增量" : "全量"} · ` +
        `新增 ${result.scan.added} / 变更 ${result.scan.changed} / 未变 ${result.scan.unchanged}` +
        `${result.scan.truncated ? " · 已达到预算上限" : ""}${EOL}`,
    )
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
