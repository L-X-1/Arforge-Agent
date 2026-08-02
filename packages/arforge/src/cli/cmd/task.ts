import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["list", "create", "get", "update", "claim", "release", "complete", "cancel", "delete", "clear"] as const
const statuses = ["pending", "in_progress", "completed", "cancelled"] as const
const csv = (value?: string) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? []

export const TaskCommand = effectCmd({
  command: "task <action> <session-id> [task-id]",
  describe: "管理会话任务图、依赖与领取状态",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "任务操作", choices: actions, demandOption: true })
      .positional("session-id", { describe: "会话 ID", type: "string", demandOption: true })
      .positional("task-id", { describe: "任务 ID", type: "string" })
      .option("title", { describe: "任务标题", type: "string" })
      .option("description", { describe: "任务描述", type: "string" })
      .option("active-form", { describe: "进行中显示文本", type: "string" })
      .option("owner", { describe: "任务所有者，领取和释放时必需", type: "string" })
      .option("status", { describe: "列表状态过滤", choices: statuses })
      .option("search", { describe: "列表关键词过滤", type: "string" })
      .option("blocked-by", { describe: "依赖任务 ID，逗号分隔", type: "string" })
      .option("blocks", { describe: "被本任务阻塞的任务 ID，逗号分隔", type: "string" })
      .option("metadata", { describe: "字符串值 JSON 对象", type: "string" })
      .option("revision", { describe: "可选乐观锁版本；省略时自动读取最新版本", type: "number" })
      .option("terminal-only", { describe: "clear 仅清理已结束任务", type: "boolean", default: true })
      .option("workspace", { describe: "会话所属工作区，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.task")(function* (args) {
    const action = args.action
    const sessionID = args.sessionId
    const taskID = args.taskId
    const api = createOperationsApi(resolve(args.workspace ?? process.cwd()))
    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new CliError({ message: `任务操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })
    const requireTaskID = () => {
      if (!taskID) return fail(`${action} 操作需要 [task-id]。`)
      return Effect.succeed(taskID)
    }
    const revisionFor = (id: string) =>
      args.revision !== undefined
        ? Effect.succeed(args.revision)
        : invoke(() => api.tasks.get({ sessionID, taskID: id })).pipe(Effect.map((task) => task.revision))
    const metadata = () => {
      if (args.metadata === undefined) return Effect.succeed(undefined)
      return Effect.try({
        try: () => JSON.parse(args.metadata!) as Record<string, string>,
        catch: () => new CliError({ message: "--metadata 必须是有效 JSON 对象。", exitCode: 1 }),
      }).pipe(
        Effect.filterOrFail(
          (value) =>
            value !== null &&
            !Array.isArray(value) &&
            Object.values(value).every((item) => typeof item === "string"),
          () => new CliError({ message: "--metadata 的所有值都必须是字符串。", exitCode: 1 }),
        ),
      )
    }

    let result: unknown
    if (action === "list") {
      result = yield* invoke(() =>
        api.tasks.list({ sessionID, status: args.status, owner: args.owner, search: args.search }),
      )
    } else if (action === "create") {
      if (!args.title?.trim()) return yield* fail("create 操作需要 --title。")
      const parsedMetadata = yield* metadata()
      result = yield* invoke(() =>
        api.tasks.create({
          sessionID,
          title: args.title!.trim(),
          description: args.description,
          activeForm: args.activeForm,
          metadata: parsedMetadata,
          blockedBy: args.blockedBy === undefined ? undefined : csv(args.blockedBy),
        }),
      )
    } else if (action === "clear") {
      result = yield* invoke(() => api.tasks.clear({ sessionID, terminalOnly: args.terminalOnly }))
    } else {
      const id = yield* requireTaskID()
      if (action === "get") {
        result = yield* invoke(() => api.tasks.get({ sessionID, taskID: id }))
      } else {
        const expectedRevision = yield* revisionFor(id)
        if (action === "update") {
          if (
            args.title === undefined &&
            args.description === undefined &&
            args.activeForm === undefined &&
            args.metadata === undefined &&
            args.blocks === undefined &&
            args.blockedBy === undefined
          ) {
            return yield* fail("update 至少需要一个可修改选项。")
          }
          const parsedMetadata = yield* metadata()
          result = yield* invoke(() =>
            api.tasks.update({
              sessionID,
              taskID: id,
              expectedRevision,
              title: args.title,
              description: args.description,
              activeForm: args.activeForm,
              metadata: parsedMetadata,
              blocks: args.blocks === undefined ? undefined : csv(args.blocks),
              blockedBy: args.blockedBy === undefined ? undefined : csv(args.blockedBy),
            }),
          )
        }
        if (action === "claim" || action === "release") {
          if (!args.owner?.trim()) return yield* fail(`${action} 操作需要 --owner。`)
          result =
            action === "claim"
              ? yield* invoke(() =>
                  api.tasks.claim({ sessionID, taskID: id, expectedRevision, owner: args.owner!.trim() }),
                )
              : yield* invoke(() =>
                  api.tasks.release({ sessionID, taskID: id, expectedRevision, owner: args.owner!.trim() }),
                )
        }
        if (action === "complete")
          result = yield* invoke(() => api.tasks.complete({ sessionID, taskID: id, expectedRevision }))
        if (action === "cancel")
          result = yield* invoke(() => api.tasks.cancel({ sessionID, taskID: id, expectedRevision }))
        if (action === "delete") {
          yield* invoke(() => api.tasks.delete({ sessionID, taskID: id, expectedRevision }))
          result = { deleted: id }
        }
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (action === "list") {
      const page = result as Awaited<ReturnType<typeof api.tasks.list>>
      process.stdout.write(`Arforge 任务：${page.total} 项${EOL}`)
      for (const item of page.items) {
        process.stdout.write(
          `- ${item.id} · ${item.status} · r${item.revision} · 阻塞 ${item.unresolvedBlockers} · ${item.title}${EOL}`,
        )
      }
      if (page.total === 0) process.stdout.write(`尚无任务。${EOL}`)
      return
    }
    const item = result as { id?: string; status?: string; revision?: number; title?: string; deleted?: string }
    if (item.deleted) process.stdout.write(`已删除任务：${item.deleted}${EOL}`)
    else if (item.id)
      process.stdout.write(
        `${item.id} · ${item.status ?? "已更新"} · r${item.revision ?? "-"}${item.title ? ` · ${item.title}` : ""}${EOL}`,
      )
    else process.stdout.write(`任务操作已完成。${EOL}`)
  }),
})
