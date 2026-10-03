import { EOL } from "node:os"
import { resolve } from "node:path"
import type { Argv } from "yargs"
import {
  CustomAgentProfileError,
  customAgentRuntimeAdmission,
  customAgentRuntimeAdmissionEvidence,
  customAgentsStatus,
  discoverCustomAgentProfiles,
  loadCustomAgentProfile,
  publicProfile,
} from "@arforge-ai/core/custom-agent-profile"
import { cmd } from "./cmd"

type Action = "status" | "list" | "validate"

interface CustomAgentsArgs {
  readonly action?: Action
  readonly profile?: string
  readonly workspace?: string
  readonly json: boolean
}

/**
 * Stable JSON matching the migration-era Python ``sort_keys=True`` output.
 * Keeping this local avoids pulling a serializer with side effects into this
 * report-only command.
 */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(", ")}]`
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}: ${stableJson(item)}`)
      .join(", ")}}`
  return JSON.stringify(value) ?? "null"
}

const printError = (message: string, exitCode = 2) => {
  process.stderr.write(`${message}${EOL}`)
  process.exitCode = exitCode
}

const runtimeText = (profile: Parameters<typeof customAgentRuntimeAdmission>[0], workspace: string): string => {
  const admission = customAgentRuntimeAdmission(profile, workspace)
  const evidence = customAgentRuntimeAdmissionEvidence(admission)
  if (!evidence.valid) return "运行时：不可执行：准入证据不一致"
  const status =
    admission.status === "admitted"
      ? "可准入（TS durable child）"
      : admission.status === "opt_in_required"
        ? "未启用：需要显式开启 ARFORGE_ENABLE_CUSTOM_AGENTS=1"
        : admission.status === "workspace_untrusted"
          ? "未启用：需要先信任当前工作区"
          : admission.status === "unsupported_tools"
            ? `不可执行：缺少 TS 工具 owner（${admission.unsupported_tools.join(", ") || "未知"}）`
            : "不可执行：与现有 Agent 角色冲突"
  const checked = Object.values(evidence.checks).filter(Boolean).length
  const decision = evidence.decision === "admitted" ? "准入" : "阻断"
  const digest = evidence.descriptor_digest ? ` · descriptor ${evidence.descriptor_digest.slice(0, 12)}…` : ""
  return `运行时：${status} · 证据：${decision}（${checked}/4 项检查通过${digest}）`
}

/** TypeScript/Core owner for the data-only custom-agent inspection surface. */
export const CustomAgentsCommand = cmd<{}, CustomAgentsArgs>({
  command: "custom-agents [action] [profile]",
  describe: "查看和校验项目级自定义代理 profile（只读，不执行代理）",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        type: "string",
        choices: ["status", "list", "validate"] as const,
        default: "status" as const,
        describe: "操作；省略时为 status",
      })
      .positional("profile", {
        type: "string",
        describe: "validate 时可选的 .arforge/agents/*.json 路径",
      })
      .option("workspace", {
        type: "string",
        describe: "工作区目录，默认为当前目录",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      }),
  handler(args) {
    const action = args.action ?? "status"
    const workspace = resolve(args.workspace ?? process.cwd())

    if ((action === "status" || action === "list") && args.profile) {
      printError(`${action} 操作不接受 profile 路径。`)
      return
    }

    try {
      if (action === "status") {
        const payload = customAgentsStatus(workspace)
        if (args.json) process.stdout.write(stableJson(payload) + EOL)
        else {
          process.stdout.write(`项目自定义代理（只读）${EOL}`)
          process.stdout.write(`目录：${payload.directory}${EOL}`)
          process.stdout.write(`工作区信任：${payload.workspace_trusted ? "是" : "否"}${EOL}`)
          process.stdout.write(`运行时启用：${payload.enabled ? "是" : "否"}${EOL}`)
          process.stdout.write(`启用条件：${payload.activation}${EOL}`)
        }
        return
      }

      if (action === "list") {
        const discovered = discoverCustomAgentProfiles(workspace)
        const payload = {
          profiles: discovered.profiles.map(publicProfile),
          errors: discovered.errors,
        }
        if (args.json) process.stdout.write(stableJson(payload) + EOL)
        else {
          process.stdout.write(`项目自定义代理：${payload.profiles.length} 项${EOL}`)
          for (const [index, profile] of payload.profiles.entries()) {
            process.stdout.write(`- ${profile.role}：${profile.description}${EOL}`)
            process.stdout.write(`  ${runtimeText(discovered.profiles[index]!, workspace)}${EOL}`)
          }
          for (const item of payload.errors) process.stderr.write(`${item.path}：${item.error}${EOL}`)
          if (payload.profiles.length === 0 && payload.errors.length === 0)
            process.stdout.write("未找到 .arforge/agents 中的项目代理 profile。" + EOL)
        }
        return
      }

      if (!args.profile) {
        const discovered = discoverCustomAgentProfiles(workspace)
        const payload = {
          valid: discovered.errors.length === 0,
          profiles: discovered.profiles.map(publicProfile),
          errors: discovered.errors,
        }
        if (args.json) process.stdout.write(stableJson(payload) + EOL)
        else if (payload.valid) {
          process.stdout.write(`已校验 ${payload.profiles.length} 个项目自定义代理 profile。${EOL}`)
          for (const [index, profile] of payload.profiles.entries())
            process.stdout.write(`- ${profile.role}：${runtimeText(discovered.profiles[index]!, workspace)}${EOL}`)
        }
        else for (const item of payload.errors) process.stderr.write(`${item.path}：${item.error}${EOL}`)
        if (!payload.valid) process.exitCode = 2
        return
      }

      const profile = loadCustomAgentProfile(args.profile, workspace)
      const payload = { valid: true, profile: publicProfile(profile), errors: [] as const }
      if (args.json) process.stdout.write(stableJson(payload) + EOL)
      else {
        process.stdout.write(`已校验项目自定义代理 profile：${payload.profile.role}${EOL}`)
        process.stdout.write(`${runtimeText(profile, workspace)}${EOL}`)
      }
    } catch (error) {
      printError(error instanceof CustomAgentProfileError ? error.message : String(error))
    }
  },
})
