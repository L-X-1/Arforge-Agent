import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["list", "enable", "disable", "inspect", "apply", "remove", "restore"] as const

export const PluginManagerCommand = effectCmd({
  command: "plugin-manager <action> [target]",
  describe: "管理本地声明式插件的检查、启停、安装与恢复",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "插件操作", choices: actions, demandOption: true })
      .positional("target", { describe: "插件名、来源、检查令牌或恢复 ID", type: "string" })
      .option("name", { describe: "从检查结果中选择的插件名", type: "string" })
      .option("replace", { describe: "替换已安装的同名插件", type: "boolean", default: false })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.pluginManager")(function* (args) {
    const api = createOperationsApi(resolve(args.workspace ?? process.cwd()))
    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new CliError({ message: `插件操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })
    const target = () => {
      if (!args.target?.trim()) return fail(`${args.action} 操作需要 [target]。`)
      return Effect.succeed(args.target.trim())
    }

    let result: unknown
    if (args.action === "list") {
      result = (yield* invoke(() => api.agentCapabilities.pluginList())).data
    } else if (args.action === "enable" || args.action === "disable") {
      const name = yield* target()
      result = (
        yield* invoke(() =>
          api.agentCapabilities.pluginSetEnabled({ name, enabled: args.action === "enable" }),
        )
      ).data
    } else if (args.action === "inspect") {
      const source = yield* target()
      result = (yield* invoke(() => api.agentCapabilities.pluginInspect({ source }))).data
    } else if (args.action === "apply") {
      const token = yield* target()
      result = (
        yield* invoke(() =>
          api.agentCapabilities.pluginApply({ token, name: args.name, replace: args.replace }),
        )
      ).data
    } else if (args.action === "remove") {
      const name = yield* target()
      result = (yield* invoke(() => api.agentCapabilities.pluginRemove({ name }))).data
    } else {
      const recoveryID = yield* target()
      result = (yield* invoke(() => api.agentCapabilities.pluginRestore({ recoveryID }))).data
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (args.action === "list" || args.action === "enable" || args.action === "disable") {
      const page = result as Awaited<ReturnType<typeof api.agentCapabilities.pluginList>>["data"]
      process.stdout.write(`Arforge 本地插件：${page.count} 项${EOL}`)
      for (const plugin of page.items) {
        process.stdout.write(
          `- ${plugin.name} ${plugin.version} · ${plugin.enabled ? "enabled" : "disabled"} · ${plugin.managed ? "managed" : "external"} · ${plugin.tools.length} tools${EOL}`,
        )
      }
      return
    }
    if (args.action === "inspect") {
      const inspection = result as Awaited<ReturnType<typeof api.agentCapabilities.pluginInspect>>["data"]
      process.stdout.write(`检查令牌：${inspection.token}（${inspection.expires_in_seconds} 秒内有效）${EOL}`)
      for (const candidate of inspection.candidates) {
        process.stdout.write(`- ${candidate.name} ${candidate.version} · sha256 ${candidate.sha256}${EOL}`)
      }
      return
    }
    process.stdout.write(`插件事务已完成。${EOL}`)
  }),
})
