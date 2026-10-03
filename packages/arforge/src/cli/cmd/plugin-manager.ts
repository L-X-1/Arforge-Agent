import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["list", "enable", "disable", "inspect", "apply", "install", "update", "remove", "restore"] as const

const canonicalPluginRoot = (value: string) => {
  const resolved = resolve(value)
  const segments = resolved.split(/[\\/]+/).filter(Boolean)
  const tail = segments.slice(-2).map((item) => item.toLowerCase())
  if (tail.length !== 2 || tail[0] !== ".arforge" || tail[1] !== "plugins") return undefined
  return resolve(resolved, "..", "..")
}

/**
 * The Python command accepted a plugin-root positional argument.  The
 * TypeScript server deliberately scopes plugin state to a workspace, so only
 * the equivalent `<workspace>/.arforge/plugins` shape can be translated
 * safely.  Arbitrary roots are rejected before any API call instead of being
 * silently treated as the current workspace.
 */
const resolveLegacyRoot = (value: string | undefined, workspace: string | undefined) => {
  if (!value) return Effect.succeed(workspace)
  if (workspace) return fail("旧 plugins root 与 --workspace 不能同时使用；请只指定一个工作区。", 2)
  const translated = canonicalPluginRoot(value)
  if (!translated)
    return fail(
      "旧 plugins root 只支持 <workspace>/.arforge/plugins；请改用 plugin-manager --workspace <workspace>。",
      2,
    )
  return Effect.succeed(translated)
}

export const PluginManagerCommand = effectCmd({
  // `plugins` is the historical Python spelling.  Install/update are kept as
  // action aliases for the old CLI, while all state and authorization remain
  // in the same typed server/Core plugin-control owner.
  command: "plugin-manager [action] [target] [extra]",
  aliases: ["plugins"],
  describe: "管理本地声明式插件的检查、启停、安装与恢复",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "插件操作；省略时为 list", choices: actions, default: "list" })
      .positional("target", { describe: "插件名、来源、检查令牌或恢复 ID", type: "string" })
      .positional("extra", { describe: "旧 plugins 的安装名称或插件根目录", type: "string" })
      .option("name", { describe: "从检查结果中选择的插件名", type: "string" })
      .option("replace", { describe: "替换已安装的同名插件", type: "boolean", default: false })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.pluginManager")(function* (args) {
    const action = args.action ?? "list"
    const legacyExtra = args.extra?.trim() || undefined
    const rootCandidate = action === "list" ? args.target?.trim() || undefined :
      action === "enable" || action === "disable" ? legacyExtra : undefined
    const translatedWorkspace = yield* resolveLegacyRoot(rootCandidate, args.workspace?.trim())
    const workspace = resolve(translatedWorkspace ?? process.cwd())
    const api = createOperationsApi(workspace)
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
    if (action === "list") {
      if (args.extra?.trim()) return yield* fail("list 操作不接受额外位置参数。", 2)
      result = (yield* invoke(() => api.agentCapabilities.pluginList())).data
    } else if (action === "enable" || action === "disable") {
      if (!args.target?.trim()) return yield* fail(`${action} 操作需要 [target]。`)
      if (args.name || args.replace) return yield* fail(`${action} 操作不接受 --name/--replace。`, 2)
      const name = yield* target()
      result = (
        yield* invoke(() =>
          api.agentCapabilities.pluginSetEnabled({ name, enabled: action === "enable" }),
        )
      ).data
    } else if (action === "inspect") {
      if (legacyExtra || args.name || args.replace) return yield* fail("inspect 操作不接受额外参数。", 2)
      const source = yield* target()
      result = (yield* invoke(() => api.agentCapabilities.pluginInspect({ source }))).data
    } else if (action === "apply" || action === "install" || action === "update") {
      if (rootCandidate) return yield* fail(`${action} 操作不接受插件根目录。`, 2)
      if (action === "apply" && legacyExtra) return yield* fail("apply 操作不接受额外位置参数。", 2)
      if ((action === "install" || action === "update") && args.name && legacyExtra)
        return yield* fail(`${action} 操作不能同时使用位置名称和 --name。`, 2)
      const token = yield* target()
      result = (
        yield* invoke(() =>
          api.agentCapabilities.pluginApply({
            token,
            name: args.name ?? ((action === "install" || action === "update") ? legacyExtra : undefined),
            replace: action === "update" || args.replace,
          }),
        )
      ).data
    } else if (action === "remove") {
      if (legacyExtra || args.name || args.replace) return yield* fail("remove 操作不接受额外参数。", 2)
      const name = yield* target()
      result = (yield* invoke(() => api.agentCapabilities.pluginRemove({ name }))).data
    } else {
      if (legacyExtra || args.name || args.replace) return yield* fail("restore 操作不接受额外参数。", 2)
      const recoveryID = yield* target()
      result = (yield* invoke(() => api.agentCapabilities.pluginRestore({ recoveryID }))).data
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (action === "list" || action === "enable" || action === "disable") {
      const page = result as Awaited<ReturnType<typeof api.agentCapabilities.pluginList>>["data"]
      process.stdout.write(`Arforge 本地插件：${page.count} 项${EOL}`)
      for (const plugin of page.items) {
        process.stdout.write(
          `- ${plugin.name} ${plugin.version} · ${plugin.enabled ? "enabled" : "disabled"} · ${plugin.managed ? "managed" : "external"} · ${plugin.tools.length} tools${EOL}`,
        )
      }
      return
    }
    if (action === "inspect") {
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
