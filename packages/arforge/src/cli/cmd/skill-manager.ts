import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["list", "enable", "disable", "refresh", "route"] as const

export const SkillManagerCommand = effectCmd({
  // `skills` is the historical Python spelling. Both names intentionally
  // share this command definition and the same Core ManagedSkillRegistry;
  // there is no compatibility-only manifest/state owner.
  command: "skill [action] [skill-id] [request..]",
  aliases: ["skills"],
  describe: "统一查看运行时技能并管理本地技能启停",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "技能操作；省略时为 list", choices: actions, default: "list" })
      .positional("skill-id", { describe: "技能 ID", type: "string" })
      .positional("request", { describe: "route 的请求文本（可分多个词）", type: "string", array: true })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.skillManager")(function* (args) {
    const action = args.action ?? "list"
    const api = createOperationsApi(resolve(args.workspace ?? process.cwd()))
    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new CliError({ message: `技能操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })

    let result: unknown
    if (action === "route") {
      const request = [args.skillId, ...(args.request ?? [])].filter(Boolean).join(" ").trim()
      if (!request) return yield* fail("route 操作需要请求文本。")
      result = (yield* invoke(() => api.agentCapabilities.skillRoute({ request }))).data
    } else if (action === "list") {
      if (args.skillId || (args.request ?? []).length > 0) return yield* fail("list 操作不接受额外位置参数。")
      result = (yield* invoke(() => api.agentCapabilities.skillList())).data
    } else if (action === "refresh") {
      if (args.skillId || (args.request ?? []).length > 0) return yield* fail("refresh 操作不接受额外位置参数。")
      result = (yield* invoke(() => api.agentCapabilities.skillRefresh())).data
    } else {
      if (!args.skillId?.trim()) return yield* fail(`${action} 操作需要 [skill-id]。`)
      if ((args.request ?? []).length > 0) return yield* fail(`${action} 操作不接受额外位置参数。`)
      result = (
        yield* invoke(() =>
          api.agentCapabilities.skillSetEnabled({
            skillID: args.skillId!.trim(),
            enabled: action === "enable",
          }),
        )
      ).data.skills
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (action === "route") {
      const route = result as {
        mode: string
        selected: string[]
        phases: string[]
        reasons: Record<string, string>
        missing: string[]
        relationship: string
        capabilities?: string[]
      }
      process.stdout.write(`Arforge 技能路由（Skill Route）：${route.mode}${EOL}`)
      process.stdout.write(`关系：${route.relationship}${EOL}`)
      process.stdout.write(`已选择：${route.selected.join(", ") || "无（直接处理）"}${EOL}`)
      if (route.phases.length > 0) process.stdout.write(`阶段：${route.phases.join(", ")}${EOL}`)
      for (const skillID of route.selected) {
        const reason = route.reasons[skillID]
        if (reason) process.stdout.write(`- ${skillID} · ${reason}${EOL}`)
      }
      if (route.capabilities && route.capabilities.length > 0)
        process.stdout.write(`能力：${route.capabilities.join(", ")}${EOL}`)
      if (route.missing.length > 0) process.stdout.write(`不可用：${route.missing.join(", ")}${EOL}`)
      return
    }
    const skills = result as Awaited<ReturnType<typeof api.agentCapabilities.skillList>>["data"]
    process.stdout.write(`Arforge 管理技能：${skills.count} 项，启用 ${skills.enabled_count} 项${EOL}`)
    for (const skill of skills.items) {
      process.stdout.write(
        `- ${skill.id} · ${skill.enabled && skill.problems.length === 0 ? "enabled" : "disabled"} · ${skill.source} · ${skill.description}${EOL}`,
      )
    }
  }),
})
