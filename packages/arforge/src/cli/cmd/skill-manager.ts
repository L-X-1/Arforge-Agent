import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["list", "enable", "disable", "refresh"] as const

export const SkillManagerCommand = effectCmd({
  command: "skill <action> [skill-id]",
  describe: "统一查看运行时技能并管理本地技能启停",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "技能操作", choices: actions, demandOption: true })
      .positional("skill-id", { describe: "技能 ID", type: "string" })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.skillManager")(function* (args) {
    const api = createOperationsApi(resolve(args.workspace ?? process.cwd()))
    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new CliError({ message: `技能操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })

    let result: Awaited<ReturnType<typeof api.agentCapabilities.skillList>>["data"]
    if (args.action === "list") {
      result = (yield* invoke(() => api.agentCapabilities.skillList())).data
    } else if (args.action === "refresh") {
      result = (yield* invoke(() => api.agentCapabilities.skillRefresh())).data
    } else {
      if (!args.skillId?.trim()) return yield* fail(`${args.action} 操作需要 [skill-id]。`)
      result = (
        yield* invoke(() =>
          api.agentCapabilities.skillSetEnabled({
            skillID: args.skillId!.trim(),
            enabled: args.action === "enable",
          }),
        )
      ).data.skills
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    process.stdout.write(`Arforge 管理技能：${result.count} 项，启用 ${result.enabled_count} 项${EOL}`)
    for (const skill of result.items) {
      process.stdout.write(
        `- ${skill.id} · ${skill.enabled && skill.problems.length === 0 ? "enabled" : "disabled"} · ${skill.source} · ${skill.description}${EOL}`,
      )
    }
  }),
})
