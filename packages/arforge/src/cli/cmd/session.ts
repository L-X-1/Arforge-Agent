import type { Argv } from "yargs"
import { Cause, Context, Effect, Layer } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { SessionStore } from "@arforge-ai/core/session/store"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { makeRuntime } from "@/effect/run-service"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "@arforge-ai/core/util/which"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.ARFORGE_GIT_BASH_PATH) {
    const less = path.join(Flag.ARFORGE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .command(SessionRecoveryCommand)
      .command(SessionCancelPendingCommand)
      .command(SessionAbandonRequestCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc.remove(sessionID).pipe(
      Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)),
      Effect.catchTag("Session.TeamOwnedError", () =>
        fail(`Session ${args.sessionID} still owns a durable team; shut down its members and delete the team first`),
      ),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

const cancellationExplanation = (
  code: DurableRun.PendingCancellationBlocker | "foreign-session" | "stale-revision" | null,
) => {
  switch (code) {
    case null:
      return "尚未启动，可明确取消运行记录；原输入和历史会保留。"
    case "foreign-session":
      return "运行不属于指定会话，未进行修改。"
    case "stale-revision":
      return "任务已发生变化，请重新执行 session recovery 查看后再决定。"
    case "child-run":
      return "这是子任务，请通过父任务处理，不能单独按未启动根任务取消。"
    case "lease-held":
      return "另一个执行仍持有有效租约，请正常停止该执行或等待租约到期。"
    case "not-pending":
      return "任务已不处于未启动等待阶段，不能使用 cancel-pending。"
    case "execution-started":
      return "任务已有执行记录，须处理实际执行结果，不能当作未启动任务取消。"
    case "dependent-work":
      return "已有请求、检查点、子任务或计费记录，需要先恢复或核对结果。"
    default:
      return "无法识别恢复状态，请保留原记录并核对。"
  }
}

const recoveryFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  if (error instanceof CliError) return Effect.fail(error)
  if (error instanceof DurableRun.PendingCancellationError) return fail(cancellationExplanation(error.code))
  if (error instanceof DurableRun.RequestAbandonmentError) return fail(requestAbandonmentExplanation(error.code))
  if (error instanceof DurableRun.NotFoundError || NotFoundError.isInstance(error))
    return fail("会话或运行记录不存在，未进行修改。")
  if (error instanceof DurableRun.CorruptHistoryError)
    return fail("运行历史校验失败；请保留数据进行修复，不要删除会话来绕过问题。")
  return fail("无法安全读取或处理该任务，未确认取消成功。请检查当前 profile、工作目录和访问权限。")
}

const requestAbandonmentExplanation = (code: DurableRun.RequestAbandonmentError["code"] | null) => {
  switch (code) {
    case null:
      return "请求可能已经执行或产生费用。可明确放弃等待且不重发；原请求、未知结果和计费记录保留。"
    case "confirmation-required":
      return "必须显式提供 --acknowledge-unknown-outcome，确认旧请求可能已执行或产生费用；本操作不会重发、撤销远端效果或退费。"
    case "request-unverified":
    case "request-mismatch":
      return "原请求记录无法核验或与所选身份不匹配；请重新执行 session recovery，未确认放弃成功。"
    case "owned-job":
      return "此运行由持久任务管理，请从原任务处理，不能绕过它的预算与恢复记录。"
    case "not-paused":
      return "运行尚未停止或已进入终态，请先正常停止，再重新查看 recovery。"
    default:
      return cancellationExplanation(code)
  }
}

// CLI composition only: both operations delegate to the original stores.
// Do not build AppRuntime/LocationServiceMap for maintenance: they also start
// execution recovery, plugin and other location services unrelated to reading
// or explicitly cancelling this one inspected task. No second state owner.
class RecoveryServices extends Context.Service<
  RecoveryServices,
  {
    readonly sessions: SessionStore.Interface
    readonly runs: DurableRun.Interface
  }
>()("Cli.session.RecoveryServices") {}

const recoveryRuntime = makeRuntime(
  RecoveryServices,
  AppNodeBuilderV1.build(
    LayerNode.make({
      service: RecoveryServices,
      layer: Layer.effect(
        RecoveryServices,
        Effect.gen(function* () {
          return { sessions: yield* SessionStore.Service, runs: yield* DurableRun.Service }
        }),
      ),
      deps: [SessionStore.node, DurableRun.globalNode],
    }),
  ),
)

const withRecoverySession = <A>(
  rawID: string,
  action: (runs: DurableRun.Interface, sessionID: SessionSchema.ID) => Effect.Effect<A, unknown>,
) =>
  recoveryRuntime.runPromise(({ sessions, runs }) =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make(rawID)
      if (!(yield* sessions.get(sessionID))) return yield* fail("会话或运行记录不存在，未进行修改。")
      return yield* action(runs, sessionID)
    }).pipe(Effect.scoped, Effect.catchCause(recoveryFailure)),
  )

export const SessionRecoveryCommand = cmd({
  command: "recovery <sessionID>",
  describe: "只读查看未完成任务及恢复阻塞原因（不执行模型或工具）",
  builder: (yargs) =>
    yargs
      .positional("sessionID", { type: "string", demandOption: true, describe: "session list 显示的会话标识" })
      .option("json", { type: "boolean", default: false, describe: "输出机器可读 JSON" })
      .fail((_message, error) => {
        if (error) throw error
        throw new CliError({
          message:
            "参数不完整或不正确。用法：arforge session recovery <sessionID> [--json]；可先用 session list 查看会话标识。",
          exitCode: 2,
        })
      }),
  async handler(args) {
    // Select the existing read-only database layer before this lazy runtime
    // is built. Do this at the handler boundary, so global argv flags cannot
    // bypass the inspection contract. Explicit cancellation keeps normal DB mode.
    process.env.ARFORGE_DB_READ_ONLY = "1"
    const items = await withRecoverySession(args.sessionID, (runs, sessionID) => runs.sessionRecovery(sessionID))
    if (args.json) {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, sessionID: args.sessionID, items }) + EOL)
      return
    }
    if (items.length === 0) {
      process.stdout.write("当前会话没有未完成的持久任务。" + EOL)
      return
    }
    for (const item of items) {
      process.stdout.write(`${item.runID}  状态=${item.status}  revision=${item.revision}${EOL}`)
      process.stdout.write(
        `  ${item.admissionRecorded ? "已有恢复约束记录。" : "历史任务缺少恢复约束，不会自动推断授权后执行。"}${cancellationExplanation(item.cancellationBlocker)}${EOL}`,
      )
      if (item.cancellationBlocker === null)
        process.stdout.write(
          `  确认取消此运行记录：arforge session cancel-pending ${item.sessionID} ${item.runID} --revision ${item.revision}${EOL}`,
        )
      if (item.request) {
        process.stdout.write(
          `  旧请求结果未知。${requestAbandonmentExplanation(item.request.abandonmentBlocker)}${EOL}`,
        )
        if (item.request.abandonmentBlocker === null)
          process.stdout.write(
            `  确认放弃且不重发：arforge session abandon-request ${item.sessionID} ${item.runID} --revision ${item.revision} --request-event ${item.request.eventID} --request-digest ${item.request.digest} --acknowledge-unknown-outcome${EOL}`,
          )
      }
    }
    process.stdout.write("这里只查看记录，不会自动取消、重发请求或删除输入。" + EOL)
  },
})

export const SessionCancelPendingCommand = cmd({
  command: "cancel-pending <sessionID> <runID>",
  describe: "明确取消刚查看过的未启动运行记录；不撤回原输入",
  builder: (yargs) =>
    yargs
      .positional("sessionID", { type: "string", demandOption: true, describe: "原任务所属的会话标识" })
      .positional("runID", { type: "string", demandOption: true, describe: "session recovery 显示的运行标识" })
      .option("revision", { type: "number", demandOption: true, describe: "session recovery 显示的原任务 revision" })
      .option("json", { type: "boolean", default: false, describe: "输出机器可读 JSON" })
      .fail((_message, error) => {
        if (error) throw error
        throw new CliError({
          message:
            "参数不完整或不正确。用法：arforge session cancel-pending <sessionID> <runID> --revision <整数> [--json]；必须使用 session recovery 刚显示的标识和 revision。",
          exitCode: 2,
        })
      }),
  async handler(args) {
    if (!Number.isSafeInteger(args.revision) || args.revision < 0)
      throw new CliError({ message: "--revision 必须是 recovery 显示的非负整数。" })
    if (!args.runID.startsWith("run_")) throw new CliError({ message: "runID 必须是 recovery 显示的 run_ 运行标识。" })
    const result = await withRecoverySession(args.sessionID, (runs, sessionID) =>
      runs.cancelPendingSession({
        sessionID,
        runID: AgentRuntime.RunID.make(args.runID),
        expectedSequence: args.revision,
      }),
    )
    if (args.json) {
      process.stdout.write(
        JSON.stringify({
          schemaVersion: 1,
          sessionID: args.sessionID,
          runID: result.run.id,
          status: result.run.status,
          revision: result.lastSequence,
          inputPreserved: true,
          historyPreserved: true,
        }) + EOL,
      )
      return
    }
    process.stdout.write(
      `已取消未启动运行记录 ${result.run.id}。会话历史和原输入均已保留；本操作没有启动新的执行。之后继续此会话时，保留的输入仍会进入执行。${EOL}`,
    )
  },
})

export const SessionAbandonRequestCommand = cmd({
  command: "abandon-request <sessionID> <runID>",
  describe: "明确放弃已停止的未知请求；保留原结果与费用记录，不重发",
  builder: (yargs) =>
    yargs
      .positional("sessionID", { type: "string", demandOption: true, describe: "原请求所属会话" })
      .positional("runID", { type: "string", demandOption: true, describe: "session recovery 显示的运行标识" })
      .option("revision", { type: "number", demandOption: true, describe: "session recovery 显示的 revision" })
      .option("request-event", { type: "string", demandOption: true, describe: "session recovery 显示的请求事件标识" })
      .option("request-digest", { type: "string", demandOption: true, describe: "session recovery 显示的请求摘要" })
      .option("acknowledge-unknown-outcome", {
        type: "boolean",
        default: false,
        describe: "确认旧请求可能已执行或产生费用；不重发、不撤销、不退费",
      })
      .option("json", { type: "boolean", default: false, describe: "输出机器可读 JSON" })
      .fail((_message, error) => {
        if (error) throw error
        throw new CliError({
          message:
            "参数不完整；先执行 arforge session recovery <sessionID>，使用刚显示的 abandon-request 命令并明确确认未知结果。",
          exitCode: 2,
        })
      }),
  async handler(args) {
    if (!args.acknowledgeUnknownOutcome)
      throw new CliError({ message: requestAbandonmentExplanation("confirmation-required") })
    if (!Number.isSafeInteger(args.revision) || args.revision < 0)
      throw new CliError({ message: "--revision 必须是 recovery 显示的非负整数。" })
    if (
      !args.runID.startsWith("run_") ||
      !args.requestEvent.startsWith("evt_") ||
      !/^[0-9a-f]{64}$/.test(args.requestDigest)
    )
      throw new CliError({ message: "运行标识、请求事件或摘要不正确；请使用 session recovery 刚显示的值。" })
    const result = await withRecoverySession(args.sessionID, (runs, sessionID) =>
      runs.abandonSessionRequest({
        sessionID,
        runID: AgentRuntime.RunID.make(args.runID),
        expectedSequence: args.revision,
        requestEventID: args.requestEvent,
        requestDigest: args.requestDigest,
        acknowledgeUnknownOutcome: true,
      }),
    )
    if (args.json) {
      process.stdout.write(
        JSON.stringify({
          schemaVersion: 1,
          sessionID: args.sessionID,
          runID: result.run.id,
          status: result.run.status,
          revision: result.lastSequence,
          outcome: "unknown",
          requestReplayed: false,
          inputPreserved: true,
          historyPreserved: true,
          budgetPreserved: true,
        }) + EOL,
      )
      return
    }
    process.stdout.write(
      `已放弃等待 ${result.run.id}，没有重发旧请求。远端结果和费用仍可能未知，原记录已保留；可以明确提交新问题。无新输入的继续不会重发旧任务。${EOL}`,
    )
  },
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
