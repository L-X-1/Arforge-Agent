import { EOL } from "node:os"
import { resolve } from "node:path"
import type { Argv } from "yargs"
import { SandboxPolicy, type Network, type Profile } from "@arforge-ai/core/sandbox/policy"
import { SandboxRunner } from "@/sandbox/runner"
import { cmd } from "./cmd"

interface SandboxStatusArgs {
  readonly workspace?: string
  readonly cwd?: string
  readonly profile: Profile
  readonly network: Network
  readonly json: boolean
}

type SandboxStatusReport = {
  readonly schema_version: 1
  readonly runtime: "typescript"
  readonly host_platform: NodeJS.Platform
  readonly workspace: string
  readonly cwd: string
  readonly policy: {
    readonly profile: Profile
    readonly network: Network
    readonly approved_roots: ReadonlyArray<string>
  }
  readonly backend: SandboxRunner.Backend["kind"]
  readonly enforcement: SandboxRunner.Report["enforcement"]
  readonly capabilities: SandboxRunner.Report["capabilities"]
  readonly reason: string
  readonly native_boundary?: SandboxRunner.Report["nativeBoundary"]
  readonly caveat: string
}

const enforcementLabel: Record<SandboxRunner.Report["enforcement"], string> = {
  full: "完整（主机报告可执行边界）",
  partial: "部分（仍需依赖网关/权限/审计）",
  unavailable: "不可用（自动执行应保持拒绝）",
}

const capabilityLabel: Record<string, string> = {
  processBoundary: "进程边界",
  fileSystem: "文件系统边界",
  network: "网络边界",
  processTree: "进程树",
}

function buildReport(args: SandboxStatusArgs): SandboxStatusReport {
  const workspace = resolve(args.workspace ?? process.cwd())
  const cwd = resolve(args.cwd ?? process.cwd())
  const profile = args.profile ?? SandboxPolicy.DefaultProfile
  const network = args.network ?? "inherit"
  const report = SandboxRunner.statusReport({ workspace, cwd, profile, network })

  return {
    schema_version: 1,
    runtime: "typescript",
    host_platform: process.platform,
    workspace,
    cwd,
    policy: {
      profile: report.profile,
      network: report.network,
      approved_roots: report.roots,
    },
    backend: report.backend,
    enforcement: report.enforcement,
    capabilities: report.capabilities,
    reason: report.reason,
    ...(report.nativeBoundary ? { native_boundary: report.nativeBoundary } : {}),
    caveat:
      "本命令只读取策略与主机能力探测结果，不准备或执行子进程；这不是 Linux/macOS/Windows full sandbox 验收，也不替代权限、ActionGateway、审计与事务检查。",
  }
}

function render(report: SandboxStatusReport): string {
  const lines = [
    "运行时沙箱状态（只读）",
    `运行时：${report.runtime}/Core`,
    `主机：${report.host_platform}`,
    `工作区：${report.workspace}`,
    `当前目录：${report.cwd}`,
    `策略：${report.policy.profile} · 网络 ${report.policy.network}`,
    `后端：${report.backend}`,
    `强制级别：${enforcementLabel[report.enforcement]}`,
    "批准根目录：",
    ...report.policy.approved_roots.map((root) => `- ${root}`),
    "能力维度：",
    ...Object.entries(report.capabilities).map(([key, value]) => `- ${capabilityLabel[key] ?? key}：${value}`),
    `原因：${report.reason}`,
    `说明：${report.caveat}`,
  ]
  return lines.join(EOL) + EOL
}

/**
 * TypeScript/Core owner for the historical Python `sandbox-status` command.
 * It is deliberately a report-only surface: no child command is prepared or
 * run, and an unavailable backend remains visible instead of being treated as
 * a successful sandbox.
 */
export const SandboxStatusCommand = cmd<{}, SandboxStatusArgs>({
  command: "sandbox-status",
  describe: "查看运行时沙箱策略与主机能力（只读，不执行任务）",
  builder: (yargs: Argv) =>
    yargs
      .option("workspace", {
        type: "string",
        describe: "批准的工作区根目录，默认为当前目录",
      })
      .option("cwd", {
        type: "string",
        describe: "待执行命令的当前目录，默认为当前目录",
      })
      .option("profile", {
        type: "string",
        choices: ["read-only", "workspace-write", "unrestricted"] as const,
        default: SandboxPolicy.DefaultProfile as Profile,
        describe: "要查看的沙箱策略档位",
      })
      .option("network", {
        type: "string",
        choices: ["none", "inherit"] as const,
        default: "inherit" as const,
        describe: "要查看的网络策略",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      }),
  async handler(args) {
    const report = buildReport(args)
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }
    process.stdout.write(render(report))
  },
})
