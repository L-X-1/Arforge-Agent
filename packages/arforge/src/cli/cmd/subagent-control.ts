import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["children", "steer", "followup", "wait", "cancel", "status"] as const
type Action = (typeof actions)[number]
const statusOperations = ["steer", "followup", "wait", "cancel"] as const
type StatusOperation = (typeof statusOperations)[number]

type ControlResult = Awaited<ReturnType<ReturnType<typeof createOperationsApi>["subagentControl"]["steer"]>>
type ChildrenResult = Awaited<ReturnType<ReturnType<typeof createOperationsApi>["subagentControl"]["children"]>>

const requireText = (value: string | undefined, option: string) => {
  if (!value?.trim()) return fail(`${option} 不能为空。`)
  return Effect.succeed(value.trim())
}

const requireRequestID = (value: string | undefined) => {
  if (!value?.trim()) return fail("控制操作需要 --request-id；重试同一请求时请复用它。")
  if (!/^cpr_[A-Za-z0-9._:-]+$/.test(value.trim())) return fail("--request-id 必须以 cpr_ 开头。")
  return Effect.succeed(value.trim())
}

const formatResult = (action: Action, result: ControlResult) => {
  const timedOut = result.timedOut ? " · 超时，子任务仍未决" : ""
  const claim = result.claim ? ` · claim=${result.claim}` : ""
  const admission = result.admission ? ` · message=${result.admission.messageID}` : ""
  return `${action} ${result.parentRunID} → ${result.childRunID}：${result.status}${timedOut}${claim}${admission}`
}

const formatChildren = (result: ChildrenResult) => {
  const header = `children ${result.parentRunID}：${result.children.length} 个直接子任务`
  if (result.children.length === 0) return header
  return [
    header,
    ...result.children.map(
      (child) =>
        `- ${child.childRunID} · ${child.status} · depth=${child.depth} · objective=${child.objectiveDigest.slice(0, 12)}…`,
    ),
  ].join("\n")
}

/**
 * Parent-scoped delegated-child control through the same generated HTTP
 * contract used by the desktop and SDK. Raw leases never appear in CLI
 * arguments; the in-process server resolves the current parent lease.
 */
export const SubagentControlCommand = effectCmd({
  command: "subagent-control <action> <parent-run-id> [child-run-id]",
  describe: "以父级权限安全控制 delegated child（children/steer/followup/wait/cancel/status）",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "控制操作", choices: actions, demandOption: true })
      .positional("parent-run-id", { describe: "父 SessionRun ID", type: "string", demandOption: true })
      .positional("child-run-id", { describe: "子 SessionRun ID（children 可省略）", type: "string" })
      .option("request-id", {
        describe: "幂等请求 ID（cpr_...）；重试同一请求必须复用",
        type: "string",
      })
      .option("prompt", { describe: "steer/followup 的提示词", type: "string" })
      .option("reason", { describe: "cancel 的原因（仅写入摘要 digest）", type: "string" })
      .option("operation", {
        describe: "status 要查询的原控制操作",
        choices: statusOperations,
        type: "string",
      })
      .option("timeout-ms", { describe: "wait/cancel 最长等待毫秒数（0–60000）", type: "number" })
      .option("recursive", { describe: "cancel 同时取消后代", type: "boolean", default: false })
      .option("workspace", { describe: "父会话所属工作区，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.subagentControl")(function* (args) {
    const action = args.action as Action
    const parentRunID = args.parentRunId
    const childRunID = args.childRunId
    const api = createOperationsApi(resolve(args.workspace ?? process.cwd()))
    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) => new CliError({ message: `子代理控制失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })

    if (action === "children") {
      const result = yield* invoke(() =>
        api.subagentControl.children({
          parentRunID,
        }),
      )
      if (args.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + EOL)
        return
      }
      process.stdout.write(formatChildren(result) + EOL)
      return
    }
    if (!childRunID) return yield* fail("该操作需要提供 child-run-id；只有 children 可以省略。")
    const requestID = yield* requireRequestID(args.requestId)
    if (
      args.timeoutMs !== undefined &&
      (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 0 || args.timeoutMs > 60_000)
    )
      return yield* fail("--timeout-ms 必须是 0 到 60000 之间的整数。")

    let result: ControlResult
    if (action === "steer" || action === "followup") {
      const prompt = yield* requireText(args.prompt, "--prompt")
      result =
        action === "steer"
          ? yield* invoke(() =>
              api.subagentControl.steer({ parentRunID, childRunID, requestID, prompt: { text: prompt } }),
            )
          : yield* invoke(() =>
              api.subagentControl.followup({ parentRunID, childRunID, requestID, prompt: { text: prompt } }),
            )
    } else if (action === "wait") {
      result = yield* invoke(() =>
        api.subagentControl.wait({
          parentRunID,
          childRunID,
          requestID,
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        }),
      )
    } else if (action === "cancel") {
      const reason = yield* requireText(args.reason, "--reason")
      result = yield* invoke(() =>
        api.subagentControl.cancel({
          parentRunID,
          childRunID,
          requestID,
          reason,
          ...(args.recursive ? { recursive: true } : {}),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        }),
      )
    } else {
      if (!statusOperations.includes(args.operation as StatusOperation))
        return yield* fail("status 需要 --operation steer|followup|wait|cancel。")
      result = yield* invoke(() =>
        api.subagentControl.status({
          parentRunID,
          childRunID,
          operation: args.operation as StatusOperation,
          requestID,
        }),
      )
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    process.stdout.write(formatResult(action, result) + EOL)
  }),
})
