import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand, AgentsCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@arforge-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { CapabilitiesCommand } from "./cli/cmd/capabilities"
import { QualityCommand } from "./cli/cmd/quality"
import { RepoScaleCommand } from "./cli/cmd/repo-scale"
import { RunHistoryCommand } from "./cli/cmd/run-history"
import { GoalCommand } from "./cli/cmd/goal"
import { TaskCommand } from "./cli/cmd/task"
import { PromptQueueCommand } from "./cli/cmd/prompt-queue"
import { WorkflowCommand } from "./cli/cmd/workflow"
import { SkillManagerCommand } from "./cli/cmd/skill-manager"
import { CustomAgentsCommand } from "./cli/cmd/custom-agents"
import { PluginManagerCommand } from "./cli/cmd/plugin-manager"
import { DoctorCommand } from "./cli/cmd/doctor"
import { PrivacyCommand } from "./cli/cmd/privacy"
import { LogsPruneCommand, SecretsScanCommand } from "./cli/cmd/private-maintenance"
import { ToolsCommand } from "./cli/cmd/tools"
import { ClearDataCommand } from "./cli/cmd/clear-data"
import { SubagentControlCommand } from "./cli/cmd/subagent-control"
import { BridgeCommand } from "./cli/cmd/bridge"
import { ConfigCommand } from "./cli/cmd/debug/config"
import { CliPathCommand } from "./cli/cmd/cli-path"
import { MemoryCommand } from "./cli/cmd/memory"
import { LearningCommand } from "./cli/cmd/learning"
import { FeedbackCommand } from "./cli/cmd/feedback"
import { AgentMetricsCommand } from "./cli/cmd/agent-metrics"
import { MultimodalDiagnoseCommand } from "./cli/cmd/multimodal-diagnose"
import { FeaturesCommand } from "./cli/cmd/features"
import { PermissionsCommand } from "./cli/cmd/permissions"
import { SandboxStatusCommand } from "./cli/cmd/sandbox-status"
import { WorkspaceCommand } from "./cli/cmd/workspace"
import { SettlementStatusCommand } from "./cli/cmd/settlement-status"
import { SettlementRecoveryCommand } from "./cli/cmd/settlement-recovery"

/**
 * Normalize the Python-era print spellings into the single TS `run` handler.
 * This is argv surgery only: execution, permissions, event ordering and
 * session ownership remain in RunCommand.  Keeping the rewrite before yargs
 * also lets `-p/--prompt` retain its historical meaning for print mode while
 * `run --password/-p` remains available for normal remote attach calls.
 */
function normalizePrintInvocation(argv: readonly string[]): string[] {
  const printCommand = argv[0] === "print"
  const printFlag = argv.findIndex((value) => value === "--print" || value.startsWith("--print="))
  if (!printCommand && printFlag < 0) return [...argv]

  const normalized = [...argv]
  if (printFlag >= 0) normalized.splice(printFlag, 1)
  if (printFlag >= 0 && normalized[0] !== "run" && normalized[0] !== "print") normalized.unshift("run")

  for (let index = 0; index < normalized.length; index += 1) {
    const value = normalized[index]
    if (value === "--quiet") {
      normalized[index] = "--final-message-only"
      continue
    }
    const promptInline = ["--prompt", "-p", "-c"].includes(value)
    const promptEquals = value.startsWith("--prompt=")
    if (promptEquals) {
      normalized[index] = value.slice("--prompt=".length)
      continue
    }
    if (promptInline && index + 1 < normalized.length) {
      normalized.splice(index, 1, normalized[index + 1])
      normalized.splice(index + 1, 1)
    }
  }

  if (!normalized.includes("--print-mode")) normalized.push("--print-mode")
  return normalized
}

/**
 * Move the behavior-complete subset of the Python `workflows` spelling to
 * the existing typed `workflow` owner.  This is argv compatibility only: the
 * generated HTTP/SDK operations, graph state, permissions, and settlement
 * remain owned by the TypeScript command.  The historical `run` spelling is
 * now mapped to the same report-capable `workflow run` action; it never starts
 * a second graph journal or bypasses the typed operations API.
 */
function normalizeWorkflowInvocation(argv: readonly string[]): string[] {
  if (argv[0] !== "workflows") return [...argv]
  const rest = [...argv.slice(1)]
  const requested = rest[0] && !rest[0].startsWith("-") ? rest[0].toLowerCase() : "list"
  const supported = new Set([
    "list",
    "validate",
    "run",
    "runs",
    "status",
    "events",
    "pause",
    "resume",
    "cancel",
    "retry",
    "approve",
    "reject",
  ])
  if (!supported.has(requested)) return [...argv]
  const action = requested === "status" ? "get" : requested
  if (action !== "approve" && action !== "reject")
    return ["workflow", action, ...(requested === "list" && rest[0]?.startsWith("-") ? rest : rest.slice(1))]

  const positional = rest.slice(1)
  const optionIndex = positional.findIndex((value) => value.startsWith("-"))
  const commentEnd = optionIndex < 0 ? positional.length : optionIndex
  const comment = positional.slice(2, commentEnd).join(" ").trim()
  const normalized = ["workflow", action, ...positional.slice(0, 2)]
  if (comment && !positional.slice(commentEnd).includes("--comment")) normalized.push("--comment", comment)
  normalized.push(...positional.slice(commentEnd))
  return normalized
}

/**
 * Route the read-only Python-era `db-current` spelling into the existing
 * TypeScript database command.  Only argv is normalized here; migration
 * ledger reads and the explicit multiagent fail-closed boundary remain in
 * `DbCommand`/Core.  Invalid targets are left untouched so the legacy guard
 * can provide the normal migration message instead of silently reading main.
 */
function normalizeDatabaseInvocation(argv: readonly string[]): string[] {
  if (argv[0] !== "db-current") return [...argv]
  const rest = [...argv.slice(1)]
  const target = rest[0] && !rest[0].startsWith("-") ? rest[0] : undefined
  if (target && !["main", "multiagent"].includes(target)) return [...argv]
  const targetIndex = target ? rest.indexOf(target) : -1
  const normalized = ["db", "current"]
  if (target) normalized.push(target)
  normalized.push(...(targetIndex >= 0 ? [...rest.slice(0, targetIndex), ...rest.slice(targetIndex + 1)] : rest))
  return normalized
}

const args = normalizeDatabaseInvocation(normalizeWorkflowInvocation(normalizePrintInvocation(hideBin(process.argv))))

// The app runtime normally applies SQLite migrations while constructing its
// global Database node.  `db current` is a diagnostic and must not inherit
// that writer; its Core read-only layer is selected before AppRuntime loads.
if (args[0] === "db" && args[1] === "current") process.env.ARFORGE_DB_READ_ONLY = "1"

/**
 * Python-era command names that do not yet have a behavior-complete
 * TypeScript owner. Keep them explicit at the front door instead of letting
 * yargs silently report an opaque "unknown command" or, worse, routing them
 * through the legacy Python parser. The map is a migration guard, not a
 * second command registry; each entry points users at the nearest canonical
 * TS surface while the full parity contract is still being built.
 */
const LEGACY_CLI_COMMANDS: Readonly<Record<string, string>> = {
  ssh: "the audited SSH parity surface is still being migrated",
  update: "use `arforge upgrade` for the current TypeScript upgrade owner",
  "db-migrate": "use the `arforge db` command owner; legacy leaf parity is still being migrated",
  "db-stamp": "use the `arforge db` command owner; legacy leaf parity is still being migrated",
  "db-sql": "use the `arforge db` command owner; legacy leaf parity is still being migrated",
  "db-downgrade": "use the `arforge db` command owner; legacy leaf parity is still being migrated",
  "db-backup": "use the `arforge db` command owner; legacy leaf parity is still being migrated",
  "db-verify": "use the `arforge db` command owner; legacy leaf parity is still being migrated",
  "db-restore": "use the `arforge db` command owner; legacy leaf parity is still being migrated",
  "profile-backup": "profile backup parity is still being migrated",
  "profile-verify": "profile backup parity is still being migrated",
  "profile-restore": "profile backup parity is still being migrated",
  code: "use `arforge run` for the canonical TypeScript session runner",
  goals: "use `arforge goal` for the canonical TypeScript goal owner",
  eval: "evaluation parity is an internal plan surface and is not a public CLI command yet",
  "eval-ablation": "evaluation parity is an internal plan surface and is not a public CLI command yet",
  "capability-eval": "capability evaluation parity is still being migrated",
  "stack-acceptance": "acceptance parity is an internal plan surface and is not a public CLI command yet",
  "project-acceptance": "acceptance parity is an internal plan surface and is not a public CLI command yet",
  custom: "custom command parity is still being migrated",
  "output-style": "output-style parity is still being migrated",
  keybindings: "keybinding parity is still being migrated",
  server: "use `arforge serve` for the canonical TypeScript server owner",
  daemon: "daemon parity is still being migrated",
  workflows: "use `arforge workflow` for the canonical TypeScript workflow owner",
  "cost-optimization":
    "成本优化依赖跨进程的文件观察账本；当前没有完整 TypeScript/Core owner，已 fail-closed，请使用 `arforge stats` 查看已有统计",
  "file-state": "文件状态依赖当前 Agent run 的观察账本；当前没有完整跨进程 TypeScript/Core owner，已 fail-closed",
  "patch-batch": "patch-batch parity is still being migrated",
  "accessibility-audit": "accessibility audit parity is still being migrated",
  "governance-audit": "governance audit parity is still being migrated",
  "installer-audit": "installer audit is outside the current product CLI scope",
  "signing-audit": "signing audit is outside the current product CLI scope",
  "staging-audit": "staging audit is outside the current product CLI scope",
  "upgrade-audit": "upgrade audit parity is still being migrated",
  "ship-audit": "ship audit is outside the current product CLI scope",
  "release-audit-bundle": "release audit is outside the current product CLI scope",
  "release-remediation-plan": "release remediation is outside the current product CLI scope",
  "evidence-template": "evidence-template parity is still being migrated",
  "ship-gate": "ship gates are outside the current product CLI scope",
  "self-correct-dogfood": "self-correction dogfood parity is still being migrated",
}

const LEGACY_CLI_FLAGS: Readonly<Record<string, string>> = {
  "--input-format": "stream-json input parity is still being migrated; use `arforge run` with a message",
  "--output-format": "stream-json output parity is still being migrated; use `arforge run --format json`",
  "--final-message-only": "final-only output parity is still being migrated; use the default `run` output",
}

function legacyCommandGuard(argv: readonly string[]) {
  const command = argv[0]
  if (!command) return
  const guidance =
    LEGACY_CLI_COMMANDS[command] ??
    LEGACY_CLI_FLAGS[command] ??
    (command.startsWith("--print=") ? LEGACY_CLI_FLAGS["--print"] : undefined)
  if (!guidance) return
  process.stderr.write(`命令 "${command}" 是 Python 历史命令，尚未完成 TypeScript 等价合同；${guidance}。` + EOL)
  process.exit(2)
}

legacyCommandGuard(args)

function described<T extends { describe?: string | false }>(command: T, describe: string): T {
  return { ...command, describe }
}

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("arforge ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .locale("zh_CN")
  // Standalone executables cannot load yargs' locale JSON at runtime, so keep
  // the Chinese strings in the bundle as well.
  .updateStrings({
    "Commands:": "命令：",
    "Positionals:": "位置参数：",
    "Options:": "选项：",
    "Examples:": "示例：",
    boolean: "布尔",
    count: "计数",
    string: "字符串",
    number: "数字",
    array: "数组",
    required: "必需",
    default: "默认值",
    "default:": "默认值：",
    "choices:": "可选值：",
    "generated-value": "生成值",
    command: "命令",
  })
  .parserConfiguration({ "populate--": true })
  .scriptName("arforge")
  .wrap(100)
  .help("help", "显示帮助")
  .alias("help", "h")
  .version("version", "显示版本号", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "将日志输出到标准错误",
    type: "boolean",
  })
  .option("log-level", {
    describe: "日志级别",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "不加载外部插件",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.ARFORGE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.ARFORGE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.ARFORGE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.ARFORGE = "1"
    process.env.ARFORGE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "生成 Shell 自动补全脚本")
  .command(described(AcpCommand, "启动 ACP（代理客户端协议）服务器"))
  .command(described(McpCommand, "管理 MCP（模型上下文协议）服务器"))
  .command(described(TuiThreadCommand, "启动 Arforge 终端界面"))
  .command(described(AttachCommand, "连接正在运行的 Arforge 服务器"))
  .command(described(RunCommand, "使用消息运行 Arforge"))
  .command(GenerateCommand)
  .command(described(DebugCommand, "调试和故障排查工具"))
  .command(described(ConfigCommand, "显示已解析配置（只读）"))
  .command(CliPathCommand)
  .command(ConsoleCommand)
  .command(described(ProvidersCommand, "管理 AI 提供商和凭据"))
  .command(described(AgentCommand, "管理代理"))
  .command(AgentsCommand)
  .command(ToolsCommand)
  .command(DoctorCommand)
  .command(PrivacyCommand)
  .command(LogsPruneCommand)
  .command(SecretsScanCommand)
  .command(ClearDataCommand)
  .command(described(UpgradeCommand, "升级 Arforge"))
  .command(described(UninstallCommand, "卸载 Arforge 并清理相关文件"))
  .command(described(ServeCommand, "启动无界面的本地 Arforge 服务器"))
  .command(described(WebCommand, "启动 Arforge 服务器并打开网页界面"))
  .command(described(ModelsCommand, "列出可用模型"))
  .command(CapabilitiesCommand)
  .command(QualityCommand)
  .command(RepoScaleCommand)
  .command(RunHistoryCommand)
  .command(GoalCommand)
  .command(TaskCommand)
  .command(SubagentControlCommand)
  .command(PromptQueueCommand)
  .command(WorkflowCommand)
  .command(MemoryCommand)
  .command(LearningCommand)
  .command(FeedbackCommand)
  .command(AgentMetricsCommand)
  .command(MultimodalDiagnoseCommand)
  .command(FeaturesCommand)
  .command(PermissionsCommand)
  .command(SandboxStatusCommand)
  .command(SettlementStatusCommand)
  .command(SettlementRecoveryCommand)
  .command(SkillManagerCommand)
  .command(CustomAgentsCommand)
  .command(WorkspaceCommand)
  .command(PluginManagerCommand)
  .command(described(StatsCommand, "显示令牌用量和费用统计"))
  .command(described(BridgeCommand, "启动 TypeScript JSONL 机器客户端桥接"))
  .command(described(ExportCommand, "将会话数据导出为 JSON"))
  .command(described(ImportCommand, "从 JSON 文件或 URL 导入会话数据"))
  .command(described(SessionCommand, "管理会话"))
  .command(described(PluginCommand, "安装插件并更新配置"))
  .command(described(DbCommand, "数据库工具"))
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:") ||
      msg?.startsWith("未知参数") ||
      msg?.startsWith("非选项参数不足") ||
      msg?.startsWith("无效值")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

/**
 * The `$0 [project]` TUI command is intentionally the default when no
 * command is supplied, but yargs would otherwise treat every bare typo as a
 * project path and only report the generic no-TTY TUI error.  Reuse yargs'
 * registered handler table (rather than maintaining a second command list)
 * to reject a bare, non-existent token as an unknown command.  Existing
 * project-directory launches and all explicit command handlers retain their
 * original behavior.
 */
function guardUnknownBareCommand(argv: readonly string[]) {
  const token = argv[0]
  if (!token || token.startsWith("-") || token === "--") return
  const internals = (
    cli as unknown as {
      getInternalMethods?: () => {
        getCommandInstance?: () => {
          handlers?: Readonly<Record<string, unknown>>
          aliasMap?: Readonly<Record<string, string>>
        }
      }
    }
  ).getInternalMethods?.()
  const command = internals?.getCommandInstance?.()
  const handlers = command?.handlers ?? {}
  const aliases = command?.aliasMap ?? {}
  if (Object.prototype.hasOwnProperty.call(handlers, token) || Object.prototype.hasOwnProperty.call(aliases, token))
    return
  if (existsSync(resolve(process.cwd(), token))) return
  process.stderr.write(`未知命令：${token}。请运行 arforge --help 查看可用命令。` + EOL)
  process.exit(2)
}

guardUnknownBareCommand(args)

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("发生意外错误" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  // FormatError may have selected a more specific compatibility/usage code
  // (for example exit 2 for a known-but-not-yet-migrated historical leaf).
  // Preserve it instead of overwriting every typed CLI failure with 1.
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
