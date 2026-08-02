import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = [
  "list",
  "create",
  "get",
  "run",
  "pause",
  "resume",
  "complete",
  "block",
  "cancel",
  "replace",
  "delete",
  "reorder",
] as const

const csv = (value?: string) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? []

export const GoalCommand = effectCmd({
  command: "goal <action> <session-id> [goal-id]",
  describe: "管理会话目标及其持久化执行状态",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "目标操作", choices: actions, demandOption: true })
      .positional("session-id", { describe: "会话 ID", type: "string", demandOption: true })
      .positional("goal-id", { describe: "目标 ID", type: "string" })
      .option("objective", { describe: "创建或替换后的目标内容", type: "string" })
      .option("queue", { describe: "创建为排队目标", type: "boolean", default: false })
      .option("history", { describe: "列表包含已结束目标", type: "boolean", default: true })
      .option("error", { describe: "阻塞原因", type: "string" })
      .option("order", { describe: "排队目标 ID，按期望顺序以逗号分隔", type: "string" })
      .option("revision", { describe: "可选乐观锁版本；省略时自动读取最新版本", type: "number" })
      .option("workspace", { describe: "会话所属工作区，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.goal")(function* (args) {
    const action = args.action
    const sessionID = args.sessionId
    const goalID = args.goalId
    const api = createOperationsApi(resolve(args.workspace ?? process.cwd()))

    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new CliError({ message: `目标操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })

    const requireGoalID = () => {
      if (!goalID) return fail(`${action} 操作需要 [goal-id]。`)
      return Effect.succeed(goalID)
    }

    const revisionFor = (id: string) =>
      args.revision !== undefined
        ? Effect.succeed(args.revision)
        : invoke(() => api.goals.get({ sessionID, goalID: id })).pipe(Effect.map((goal) => goal.revision))

    let result: unknown
    switch (action) {
      case "list":
        result = yield* invoke(() => api.goals.list({ sessionID, history: args.history ? "true" : "false" }))
        break
      case "create":
        if (!args.objective?.trim()) return yield* fail("create 操作需要 --objective。")
        result = yield* invoke(() =>
          api.goals.create({ sessionID, objective: args.objective!.trim(), queue: args.queue }),
        )
        break
      case "get": {
        const id = yield* requireGoalID()
        result = yield* invoke(() => api.goals.get({ sessionID, goalID: id }))
        break
      }
      case "reorder": {
        const order = csv(args.order)
        if (order.length === 0) return yield* fail("reorder 操作需要 --order goal_1,goal_2。")
        const page = yield* invoke(() => api.goals.list({ sessionID, history: "false" }))
        const byID = new Map(page.queued.map((goal) => [goal.id, goal]))
        if (order.length !== page.queued.length || order.some((id) => !byID.has(id))) {
          return yield* fail("--order 必须且只能包含当前全部排队目标 ID。")
        }
        result = yield* invoke(() =>
          api.goals.reorder({
            sessionID,
            goals: order.map((id) => ({ id, revision: byID.get(id)!.revision })),
          }),
        )
        break
      }
      default: {
        const id = yield* requireGoalID()
        const expectedRevision = yield* revisionFor(id)
        if (action === "run") result = yield* invoke(() => api.goals.run({ sessionID, goalID: id, expectedRevision }))
        if (action === "pause")
          result = yield* invoke(() => api.goals.pause({ sessionID, goalID: id, expectedRevision }))
        if (action === "resume")
          result = yield* invoke(() => api.goals.resume({ sessionID, goalID: id, expectedRevision }))
        if (action === "complete")
          result = yield* invoke(() => api.goals.complete({ sessionID, goalID: id, expectedRevision }))
        if (action === "cancel")
          result = yield* invoke(() => api.goals.cancel({ sessionID, goalID: id, expectedRevision }))
        if (action === "delete") {
          yield* invoke(() => api.goals.deleteQueued({ sessionID, goalID: id, expectedRevision }))
          result = { deleted: id }
        }
        if (action === "block") {
          if (!args.error?.trim()) return yield* fail("block 操作需要 --error。")
          result = yield* invoke(() =>
            api.goals.block({ sessionID, goalID: id, expectedRevision, error: args.error!.trim() }),
          )
        }
        if (action === "replace") {
          if (!args.objective?.trim()) return yield* fail("replace 操作需要 --objective。")
          result = yield* invoke(() =>
            api.goals.replace({
              sessionID,
              goalID: id,
              expectedRevision,
              objective: args.objective!.trim(),
            }),
          )
        }
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (action === "list") {
      const page = result as Awaited<ReturnType<typeof api.goals.list>>
      const items = [page.active, ...page.queued, ...page.history].filter((item) => item !== undefined)
      process.stdout.write(`Arforge 目标：${items.length} 项${EOL}`)
      for (const item of items) {
        process.stdout.write(`- ${item!.id} · ${item!.status} · r${item!.revision} · ${item!.objective}${EOL}`)
      }
      if (items.length === 0) process.stdout.write(`尚无目标。${EOL}`)
      return
    }
    const item = result as { id?: string; status?: string; revision?: number; objective?: string; deleted?: string }
    if (item.deleted) process.stdout.write(`已删除排队目标：${item.deleted}${EOL}`)
    else if (item.id)
      process.stdout.write(
        `${item.id} · ${item.status ?? "已更新"} · r${item.revision ?? "-"}${item.objective ? ` · ${item.objective}` : ""}${EOL}`,
      )
    else process.stdout.write(`目标操作已完成。${EOL}`)
  }),
})
