import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = [
  "list",
  "preview",
  "runs",
  "get",
  "start",
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
  "retry",
] as const

export const WorkflowCommand = effectCmd({
  command: "workflow <action> [target] [node-id]",
  describe: "管理验证后的工作流定义与持久化图运行",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "工作流操作", choices: actions, demandOption: true })
      .positional("target", { describe: "定义路径或运行 ID", type: "string" })
      .positional("node-id", { describe: "审批或重试的节点 ID", type: "string" })
      .option("session", { describe: "按会话过滤运行，或为新运行指定会话", type: "string" })
      .option("permission-mode", {
        describe: "代理节点权限模式",
        choices: ["plan", "acceptEdits", "fullAccess"] as const,
        default: "acceptEdits" as const,
      })
      .option("max-parallel", { describe: "最大并行节点数（1-8）", type: "number", default: 4 })
      .option("comment", { describe: "审批说明", type: "string" })
      .option("include-descendants", { describe: "重试节点的后继分支", type: "boolean", default: true })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.workflow")(function* (args) {
    const workspace = resolve(args.workspace ?? process.cwd())
    const api = createOperationsApi(workspace)
    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new CliError({ message: `工作流操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })
    const target = () => {
      if (!args.target?.trim()) return fail(`${args.action} 操作需要 [target]。`)
      return Effect.succeed(args.target.trim())
    }

    let result: unknown
    if (args.action === "list") {
      result = (yield* invoke(() => api.agentCapabilities.workflowList())).data
    } else if (args.action === "runs") {
      result = (
        yield* invoke(() =>
          api.agentCapabilities.workflowRunList({ sessionID: args.session, limit: 100 }),
        )
      ).data
    } else if (args.action === "preview") {
      const path = yield* target()
      result = (yield* invoke(() => api.agentCapabilities.workflowPreview({ path }))).data
    } else if (args.action === "start") {
      const path = yield* target()
      if (!Number.isInteger(args.maxParallel) || args.maxParallel < 1 || args.maxParallel > 8) {
        return yield* fail("--max-parallel 必须是 1 到 8 的整数。")
      }
      result = (
        yield* invoke(() =>
          api.agentCapabilities.workflowStart({
            path,
            sessionID: args.session,
            permissionMode: args.permissionMode,
            maxParallel: args.maxParallel,
          }),
        )
      ).data
    } else {
      const runID = yield* target()
      if (args.action === "get") {
        result = (yield* invoke(() => api.agentCapabilities.workflowRunGet({ runID }))).data
      } else if (["pause", "resume", "cancel"].includes(args.action)) {
        result = (
          yield* invoke(() =>
            api.agentCapabilities.workflowControl({
              runID,
              action: args.action as "pause" | "resume" | "cancel",
            }),
          )
        ).data
      } else {
        if (!args.nodeId?.trim()) return yield* fail(`${args.action} 操作需要 [node-id]。`)
        if (args.action === "approve" || args.action === "reject") {
          result = (
            yield* invoke(() =>
              api.agentCapabilities.workflowApprove({
                runID,
                nodeID: args.nodeId!.trim(),
                approved: args.action === "approve",
                comment: args.comment,
              }),
            )
          ).data
        } else {
          result = (
            yield* invoke(() =>
              api.agentCapabilities.workflowRetry({
                runID,
                nodeID: args.nodeId!.trim(),
                includeDescendants: args.includeDescendants,
              }),
            )
          ).data
        }
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }
    if (args.action === "list") {
      const page = result as Awaited<ReturnType<typeof api.agentCapabilities.workflowList>>["data"]
      process.stdout.write(`Arforge 工作流定义：${page.count} 项${EOL}`)
      for (const item of page.items) {
        process.stdout.write(
          `- ${item.path} · ${item.valid ? `${item.nodes ?? 0} 节点 / ${item.edges ?? 0} 边` : `无效：${item.error}`}${EOL}`,
        )
      }
      return
    }
    if (args.action === "runs") {
      const page = result as Awaited<ReturnType<typeof api.agentCapabilities.workflowRunList>>["data"]
      process.stdout.write(`Arforge 工作流运行：${page.count} 项${EOL}`)
      for (const run of page.items) {
        process.stdout.write(`- ${run.run_id} · ${run.status} · ${run.progress.percent}% · ${run.name}${EOL}`)
      }
      return
    }
    if (args.action === "preview") {
      const preview = result as Awaited<ReturnType<typeof api.agentCapabilities.workflowPreview>>["data"]
      process.stdout.write(`${preview.name} · 只读预览 · ${preview.steps.length} 节点${EOL}`)
      for (const step of preview.steps) process.stdout.write(`- ${step.id} · ${step.status} · ${step.output}${EOL}`)
      return
    }
    const run = result as Awaited<ReturnType<typeof api.agentCapabilities.workflowRunGet>>["data"]
    process.stdout.write(`${run.run_id} · ${run.status} · ${run.progress.percent}% · ${run.name}${EOL}`)
  }),
})
