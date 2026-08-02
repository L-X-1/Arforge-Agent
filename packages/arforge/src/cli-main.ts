import yargs from "yargs"
import { hideBin } from "yargs/helpers"
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
import { PluginManagerCommand } from "./cli/cmd/plugin-manager"
import { DoctorCommand } from "./cli/cmd/doctor"
import { LogsPruneCommand, SecretsScanCommand } from "./cli/cmd/private-maintenance"
import { ToolsCommand } from "./cli/cmd/tools"
import { ClearDataCommand } from "./cli/cmd/clear-data"

const args = hideBin(process.argv)

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
  .command(ConsoleCommand)
  .command(described(ProvidersCommand, "管理 AI 提供商和凭据"))
  .command(described(AgentCommand, "管理代理"))
  .command(AgentsCommand)
  .command(ToolsCommand)
  .command(DoctorCommand)
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
  .command(PromptQueueCommand)
  .command(WorkflowCommand)
  .command(SkillManagerCommand)
  .command(PluginManagerCommand)
  .command(described(StatsCommand, "显示令牌用量和费用统计"))
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
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
