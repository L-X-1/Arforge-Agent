import { Effect } from "effect"
import { Global } from "@arforge-ai/core/global"
import { mkdir, writeFile } from "node:fs/promises"
import { EOL } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = [
  "list",
  "validate",
  "preview",
  "run",
  "runs",
  "events",
  "get",
  "start",
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
  "retry",
] as const

type OperationsApi = ReturnType<typeof createOperationsApi>
type WorkflowRun = Awaited<ReturnType<OperationsApi["agentCapabilities"]["workflowRunGet"]>>["data"]

type WorkflowReport = {
  name: string
  source_path: string
  success: boolean
  dry_run: boolean
  steps: Array<{ id: string; title: string; status: string; output: string; error: string }>
  report_path?: string
  graph_run_id?: string
  graph_status?: string
}

const terminalRunStatuses = new Set(["completed", "failed", "cancelled", "interrupted"])

function reportStep(step: {
  id: string
  title: string
  status: string
  output?: string
  error?: string
  depends_on?: ReadonlyArray<string>
}) {
  return {
    id: step.id,
    title: step.title,
    status: step.status,
    output: step.output || (step.depends_on ? `depends_on: ${step.depends_on.join(", ") || "none"}` : ""),
    error: step.error ?? "",
  }
}

function previewReport(
  preview: Awaited<ReturnType<OperationsApi["agentCapabilities"]["workflowPreview"]>>["data"],
): WorkflowReport {
  return {
    name: preview.name,
    source_path: preview.source_path,
    success: preview.success,
    dry_run: true,
    steps: preview.steps.map((step) => reportStep({ ...step, status: "planned" })),
  }
}

function runReport(run: WorkflowRun): WorkflowReport {
  return {
    name: run.name,
    source_path: run.source_path,
    success: run.status === "completed",
    dry_run: false,
    steps: run.nodes.map((node) => reportStep({ ...node, id: node.node_id })),
    graph_run_id: run.run_id,
    graph_status: run.status,
  }
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
}

function validateReportPath(workspace: string, requested?: string): void {
  if (!requested?.trim()) return
  const target = resolve(workspace, requested.trim())
  if (!isWithin(workspace, target)) {
    throw new Error("--report 必须位于当前工作区内；默认报告写入 Arforge profile data。")
  }
}

function reportTarget(name: string, workspace: string, requested?: string): string {
  if (!requested?.trim()) return resolve(Global.Path.data, "workflows", "runs", `${name}.json`)
  validateReportPath(workspace, requested)
  return resolve(workspace, requested.trim())
}

async function persistReport(report: WorkflowReport, workspace: string, requested?: string): Promise<string> {
  const target = reportTarget(report.name, workspace, requested)
  await mkdir(dirname(target), { recursive: true })
  // Keep the on-disk report shape identical to the legacy report writer. The
  // durable graph identifiers are command-result metadata and belong only in
  // the stdout/JSON response, not in the portable report artifact.
  const { graph_run_id: _graphRunID, graph_status: _graphStatus, report_path: _reportPath, ...reportBody } = report
  await writeFile(target, `${JSON.stringify(reportBody, null, 2)}${EOL}`, "utf8")
  return target
}

async function waitForWorkflow(api: OperationsApi, initial: WorkflowRun): Promise<WorkflowRun> {
  let current = initial
  const deadline = Date.now() + 5 * 60_000
  while (!terminalRunStatuses.has(current.status) && !["paused", "waiting_approval"].includes(current.status)) {
    if (Date.now() >= deadline) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    current = (await api.agentCapabilities.workflowRunGet({ runID: current.run_id })).data
  }
  return current
}

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
      .option("max-parallel", {
        describe: "并行请求上限（1-8；无批准收益证据时实际为 1）",
        type: "number",
        default: 4,
      })
      .option("execute", {
        describe: "执行工作流；省略时只生成确定性预览报告",
        type: "boolean",
        default: false,
      })
      .option("report", {
        describe: "报告 JSON 输出路径（相对路径必须位于工作区内）",
        type: "string",
      })
      .option("comment", { describe: "审批说明", type: "string" })
      .option("include-descendants", { describe: "重试节点的后继分支", type: "boolean", default: true })
      .option("after", { describe: "事件游标（从该序号之后读取）", type: "number", default: 0 })
      .option("limit", { describe: "事件读取上限（1-1000）", type: "number", default: 1000 })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.workflow")(function* (args) {
    const workspace = resolve(args.workspace ?? process.cwd())
    const api = createOperationsApi(workspace)
    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) => new CliError({ message: `工作流操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })
    const target = () => {
      if (!args.target?.trim()) return fail(`${args.action} 操作需要 [target]。`)
      return Effect.succeed(args.target.trim())
    }

    if (args.action !== "run" && (args.execute || args.report)) {
      return yield* fail("--execute/--report 只能用于 workflow run。")
    }

    let result: unknown
    let commandExitCode = 0
    let commandFailureMessage = ""
    if (args.action === "list") {
      result = (yield* invoke(() => api.agentCapabilities.workflowList())).data
    } else if (args.action === "runs") {
      result = (yield* invoke(() => api.agentCapabilities.workflowRunList({ sessionID: args.session, limit: 100 })))
        .data
    } else if (args.action === "validate") {
      const path = yield* target()
      const preview = (yield* invoke(() => api.agentCapabilities.workflowPreview({ path }))).data
      result = {
        valid: preview.success,
        name: preview.name,
        schema_version: preview.schema_version,
        steps: preview.steps.length,
        edges: preview.edges.length,
      }
    } else if (args.action === "preview") {
      const path = yield* target()
      result = (yield* invoke(() => api.agentCapabilities.workflowPreview({ path }))).data
    } else if (args.action === "run") {
      const path = yield* target()
      if (!Number.isInteger(args.maxParallel) || args.maxParallel < 1 || args.maxParallel > 8) {
        return yield* fail("--max-parallel 必须是 1 到 8 的整数。")
      }
      try {
        // Validate the report destination before preview loading or durable
        // run admission. An invalid destination must never leave a run behind.
        validateReportPath(workspace, args.report)
      } catch (error) {
        return yield* fail(error instanceof Error ? error.message : String(error), 2)
      }
      const report = args.execute
        ? runReport(
            yield* invoke(async () => {
              const started = (
                await api.agentCapabilities.workflowStart({
                  path,
                  sessionID: args.session,
                  permissionMode: args.permissionMode,
                  maxParallel: args.maxParallel,
                })
              ).data
              return waitForWorkflow(api, started)
            }),
          )
        : previewReport((yield* invoke(() => api.agentCapabilities.workflowPreview({ path }))).data)
      const reportPath = yield* invoke(() => persistReport(report, workspace, args.report))
      result = { ...report, report_path: reportPath }
      if (report.graph_status && !terminalRunStatuses.has(report.graph_status)) {
        commandExitCode = report.graph_status === "paused" || report.graph_status === "waiting_approval" ? 3 : 1
        commandFailureMessage =
          report.graph_status === "paused" || report.graph_status === "waiting_approval"
            ? `工作流已暂停并等待人工处理；报告已写入 ${reportPath}`
            : `工作流未在等待窗口内结束（当前状态：${report.graph_status}）；报告已写入 ${reportPath}`
      } else if (report.graph_status && report.graph_status !== "completed") {
        commandExitCode = 1
        commandFailureMessage = `工作流执行失败（状态：${report.graph_status}）；报告已写入 ${reportPath}`
      }
    } else if (args.action === "events") {
      const runID = yield* target()
      if (!Number.isInteger(args.after) || args.after < 0 || args.after > 10_000_000) {
        return yield* fail("--after 必须是 0 到 10000000 的整数。")
      }
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000) {
        return yield* fail("--limit 必须是 1 到 1000 的整数。")
      }
      result = (yield* invoke(() =>
        api.agentCapabilities.workflowRunEvents({ runID, after: args.after, limit: args.limit }),
      )).data
    } else if (args.action === "start") {
      const path = yield* target()
      if (!Number.isInteger(args.maxParallel) || args.maxParallel < 1 || args.maxParallel > 8) {
        return yield* fail("--max-parallel 必须是 1 到 8 的整数。")
      }
      result = (yield* invoke(() =>
        api.agentCapabilities.workflowStart({
          path,
          sessionID: args.session,
          permissionMode: args.permissionMode,
          maxParallel: args.maxParallel,
        }),
      )).data
    } else {
      const runID = yield* target()
      if (args.action === "get") {
        result = (yield* invoke(() => api.agentCapabilities.workflowRunGet({ runID }))).data
      } else if (["pause", "resume", "cancel"].includes(args.action)) {
        result = (yield* invoke(() =>
          api.agentCapabilities.workflowControl({
            runID,
            action: args.action as "pause" | "resume" | "cancel",
          }),
        )).data
      } else {
        if (!args.nodeId?.trim()) return yield* fail(`${args.action} 操作需要 [node-id]。`)
        if (args.action === "approve" || args.action === "reject") {
          result = (yield* invoke(() =>
            api.agentCapabilities.workflowApprove({
              runID,
              nodeID: args.nodeId!.trim(),
              approved: args.action === "approve",
              comment: args.comment,
            }),
          )).data
        } else {
          result = (yield* invoke(() =>
            api.agentCapabilities.workflowRetry({
              runID,
              nodeID: args.nodeId!.trim(),
              includeDescendants: args.includeDescendants,
            }),
          )).data
        }
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      if (commandExitCode !== 0) return yield* fail(commandFailureMessage, commandExitCode)
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
    if (args.action === "validate") {
      const validation = result as {
        valid: boolean
        name: string
        schema_version: number
        steps: number
        edges: number
      }
      process.stdout.write(
        validation.valid
          ? `Workflow '${validation.name}' 有效 · ${validation.steps} 节点 · ${validation.edges} 条边${EOL}`
          : `Workflow '${validation.name}' 无效${EOL}`,
      )
      return
    }
    if (args.action === "preview") {
      const preview = result as Awaited<ReturnType<typeof api.agentCapabilities.workflowPreview>>["data"]
      process.stdout.write(`${preview.name} · 只读预览 · ${preview.steps.length} 节点${EOL}`)
      for (const step of preview.steps) process.stdout.write(`- ${step.id} · ${step.status} · ${step.output}${EOL}`)
      return
    }
    if (args.action === "run") {
      const report = result as WorkflowReport & { report_path: string }
      const state = report.dry_run ? "planned" : (report.graph_status ?? (report.success ? "completed" : "failed"))
      process.stdout.write(`Workflow ${state}: ${report.name}${EOL}`)
      for (const step of report.steps) process.stdout.write(`  ${step.status}: ${step.id} - ${step.title}${EOL}`)
      process.stdout.write(`Report: ${report.report_path}${EOL}`)
      if (commandExitCode !== 0) return yield* fail(commandFailureMessage, commandExitCode)
      return
    }
    if (args.action === "events") {
      const events = result as Awaited<ReturnType<typeof api.agentCapabilities.workflowRunEvents>>["data"]
      process.stdout.write(`${events.run_id} · 事件 ${events.count} 条${EOL}`)
      for (const event of events.items) {
        const node = event.node_id ? ` [${event.node_id}]` : ""
        process.stdout.write(`  ${String(event.sequence).padStart(4, " ")} ${event.type}${node}${EOL}`)
      }
      if (events.next_after > 0) process.stdout.write(`下一游标：${events.next_after}${EOL}`)
      return
    }
    const run = result as Awaited<ReturnType<typeof api.agentCapabilities.workflowRunGet>>["data"]
    process.stdout.write(`${run.run_id} · ${run.status} · ${run.progress.percent}% · ${run.name}${EOL}`)
    if (run.scheduling) {
      const action =
        run.scheduling.action === "multi"
          ? "多执行已启用"
          : run.scheduling.action === "candidate"
            ? "可拆分候选（未自动启用）"
            : "单执行"
      process.stdout.write(
        `调度：${action} · 请求上限 ${run.scheduling.requested_max_parallel} · 实际 ${run.scheduling.effective_max_parallel}${EOL}`,
      )
      if (run.scheduling.failed_checks.length > 0) {
        process.stdout.write(`未通过门禁：${run.scheduling.failed_checks.join("；")}${EOL}`)
      }
    }
  }),
})
