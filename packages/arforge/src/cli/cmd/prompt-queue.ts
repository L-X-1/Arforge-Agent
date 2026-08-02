import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["list", "add", "update", "remove", "drain"] as const

export const PromptQueueCommand = effectCmd({
  command: "prompt-queue <action> <session-id> [message-id]",
  describe: "管理桌面端与 CLI 共用的持久化提示队列",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "队列操作", choices: actions, demandOption: true })
      .positional("session-id", { describe: "会话 ID", type: "string", demandOption: true })
      .positional("message-id", { describe: "队列消息 ID", type: "string" })
      .option("text", { describe: "新增或替换后的提示文本", type: "string" })
      .option("agent", { describe: "仅对该提示生效的代理", type: "string" })
      .option("provider", { describe: "模型提供商 ID", type: "string" })
      .option("model", { describe: "模型 ID；与 --provider 一起使用", type: "string" })
      .option("variant", { describe: "模型变体", type: "string" })
      .option("admitted-seq", { describe: "可选并发令牌；省略时自动读取", type: "number" })
      .option("workspace", { describe: "会话所属工作区，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.promptQueue")(function* (args) {
    const action = args.action
    const sessionID = args.sessionId
    const messageID = args.messageId
    const api = createOperationsApi(resolve(args.workspace ?? process.cwd()))
    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new CliError({ message: `提示队列操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })
    const requireMessageID = () => {
      if (!messageID) return fail(`${action} 操作需要 [message-id]。`)
      return Effect.succeed(messageID)
    }
    const route =
      args.agent || args.provider || args.model
        ? {
            agent: args.agent,
            model:
              args.provider && args.model
                ? { providerID: args.provider, id: args.model, variant: args.variant }
                : undefined,
          }
        : undefined
    if ((args.provider && !args.model) || (!args.provider && args.model)) {
      return yield* fail("--provider 与 --model 必须同时提供。")
    }

    let result: unknown
    if (action === "list") {
      result = yield* invoke(() => api.sessions.promptQueueList({ sessionID }))
    } else if (action === "add") {
      if (!args.text?.trim()) return yield* fail("add 操作需要 --text。")
      result = yield* invoke(() =>
        api.sessions.prompt({
          sessionID,
          prompt: { text: args.text!, route },
          delivery: "queue",
          resume: false,
        }),
      )
    } else if (action === "drain") {
      yield* invoke(() => api.sessions.wait({ sessionID }))
      result = yield* invoke(() => api.sessions.promptQueueList({ sessionID }))
    } else {
      const id = yield* requireMessageID()
      const queued = yield* invoke(() => api.sessions.promptQueueList({ sessionID }))
      const current = queued.find((item) => item.id === id)
      if (!current) return yield* fail(`未找到仍在队列中的提示：${id}`)
      const expectedAdmittedSeq = args.admittedSeq ?? current.admittedSeq
      if (action === "remove") {
        yield* invoke(() =>
          api.sessions.promptQueueRemove({ sessionID, messageID: id, expectedAdmittedSeq }),
        )
        result = { removed: id }
      } else {
        if (!args.text?.trim()) return yield* fail("update 操作需要 --text。")
        result = yield* invoke(() =>
          api.sessions.promptQueueUpdate({
            sessionID,
            messageID: id,
            expectedAdmittedSeq,
            prompt: { ...current.prompt, text: args.text!, route: route ?? current.prompt.route },
          }),
        )
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (action === "list" || action === "drain") {
      const items = result as Awaited<ReturnType<typeof api.sessions.promptQueueList>>
      process.stdout.write(`Arforge 提示队列：${items.length} 项${EOL}`)
      for (const item of items) {
        const preview = item.prompt.text.replace(/\s+/g, " ").trim()
        process.stdout.write(`- ${item.id} · #${item.admittedSeq} · ${preview}${EOL}`)
      }
      if (items.length === 0) process.stdout.write(`队列为空。${EOL}`)
      return
    }
    const item = result as { id?: string; admittedSeq?: number; removed?: string }
    if (item.removed) process.stdout.write(`已移除提示：${item.removed}${EOL}`)
    else if (item.id) process.stdout.write(`${item.id} · #${item.admittedSeq ?? "-"}${EOL}`)
    else process.stdout.write(`提示队列操作已完成。${EOL}`)
  }),
})
