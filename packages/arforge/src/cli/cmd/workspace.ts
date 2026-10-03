import { EOL } from "node:os"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import type { Argv } from "yargs"
import { Cause, Effect, Exit, Layer } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { makeWorkspaceRootProductionOwner } from "@arforge-ai/core/workspace-root-owner"
import { inspectWorkspaceRootProductionOwner } from "@arforge-ai/core/workspace-root-production-evidence"
import { workspaceReadOnlyExecutionBoundary } from "@arforge-ai/core/runtime/execution-boundary"
import { workspaceRootMutationContract, workspaceRootsReport } from "@arforge-ai/core/workspace-roots"
import { WorkspaceRootWriterError } from "@arforge-ai/core/workspace-root-writer"
import { executeWorkspaceRootControl } from "../../workspace-root-control-gateway"
import { cmd } from "./cmd"

type Action = "list" | "trust" | "add" | "remove"

interface WorkspaceArgs {
  readonly action?: Action
  readonly directory?: string
  readonly workspace?: string
  readonly json: boolean
  readonly "contract-audit": boolean
}

const usage =
  "当前可用：workspace list；trust/add/remove 已有只读准入规划，但仍需 TypeScript/Core 事务式写入 owner、授权与回滚合同。"

const printError = (message: string) => {
  process.stderr.write(`${message}${EOL}`)
  process.exitCode = 2
}

/**
 * TypeScript/Core owner for the read-only historical Python `workspace list`
 * surface. Trust and root mutations deliberately remain fail-closed until
 * their ActionGateway, durable receipt and rollback contract is complete;
 * `--contract-audit` exposes the same read-only admission contract to users.
 */
export const WorkspaceCommand = cmd<{}, WorkspaceArgs>({
  command: "workspace [action] [directory]",
  describe: "查看已授权工作区根目录（写入动作保持迁移保护）",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        type: "string",
        choices: ["list", "trust", "add", "remove"] as const,
        default: "list" as const,
        describe: "操作；省略时为 list",
      })
      .positional("directory", {
        type: "string",
        describe: "trust/add/remove 的目标目录（写入动作当前不执行）",
      })
      .option("workspace", {
        type: "string",
        describe: "主工作区目录，默认为当前目录",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      })
      .option("contract-audit", {
        type: "boolean",
        default: false,
        describe: "只读显示 trust/add/remove 的 TS/Core 写入合同缺口",
      }),
  async handler(args) {
    const action = args.action ?? "list"
    const primary = resolve(args.workspace ?? process.cwd())

    if (args["contract-audit"]) {
      if (action !== "list" || args.directory) {
        printError("workspace --contract-audit 仅适用于 `workspace`/`workspace list`，不接受目录参数。")
        return
      }
      const owner = makeWorkspaceRootProductionOwner({ primary })
      const report = {
        workspace: primary,
        execution_boundary: workspaceReadOnlyExecutionBoundary(),
        production_owner_evidence: inspectWorkspaceRootProductionOwner(owner),
        owner_binding: {
          owner: owner.owner,
          profile_directory: owner.profileDirectory,
          enabled: owner.enabled,
        },
        writer_preflight: owner.preflight(),
        ...workspaceRootMutationContract(),
      }
      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + EOL)
        return
      }
      process.stdout.write(`工作区根目录写入合同审计（只读）${EOL}`)
      process.stdout.write(`工作区：${primary}${EOL}`)
      process.stdout.write(
        `writer 预检：${report.writer_preflight.status} · ready=${report.writer_preflight.ready} · blocking=${report.writer_preflight.blocking_reasons.length}${EOL}`,
      )
      for (const check of report.writer_preflight.checks) {
        process.stdout.write(
          `- writer.${check.id}：${check.status} · ${check.observation}${check.reason ? ` · reason=${check.reason}` : ""}${EOL}`,
        )
      }
      process.stdout.write(`状态：${report.status} · ready=${report.ready} · side-effects=${report.side_effects}${EOL}`)
      process.stdout.write(
        `执行边界：${report.execution_boundary.mode} · writes=0 · 不创建或修复 profile 状态 · Provider=禁止${EOL}`,
      )
      process.stdout.write(
        `运行时不变量：${report.runtime_invariant.owner} · keys=${report.runtime_invariant.keys.join(", ")} · 仅检查不授权${EOL}`,
      )
      process.stdout.write(
        `生产启用决策：${report.enable_gate.decision} · blocking=${report.enable_gate.blocking_gate_ids.length}${EOL}`,
      )
      process.stdout.write(
        `生产 owner 证据：${report.production_owner_evidence.binding_status} · seams=${report.production_owner_evidence.required_seams.length - report.production_owner_evidence.missing_seams.length}/${report.production_owner_evidence.required_seams.length} · 仅检查不授权${EOL}`,
      )
      if (report.production_owner_evidence.missing_seams.length > 0)
        process.stdout.write(`- 缺失 seam：${report.production_owner_evidence.missing_seams.join(", ")}${EOL}`)
      for (const gate of report.enable_gate.gates) {
        process.stdout.write(`- ${gate.id}：${gate.status} · ${gate.blocker}${EOL}`)
      }
      process.stdout.write(`缺口：${report.missing_requirements.join(", ")}${EOL}`)
      process.stdout.write(`说明：${report.caveat}${EOL}`)
      return
    }

    try {
      if (!statSync(primary).isDirectory()) throw new Error("not a directory")
    } catch {
      printError("workspace must be an existing directory")
      return
    }

    if (action === "list") {
      if (args.directory) {
        printError("workspace list 不接受目录位置参数。")
        return
      }
      const report = workspaceRootsReport(primary)
      if (args.json) {
        // The report's insertion order is already the Python compatibility
        // order (`sort_keys=True`): primary/roots and path/primary/trusted.
        process.stdout.write(JSON.stringify(report) + EOL)
        return
      }
      process.stdout.write(`授权工作区：${report.roots.length} 个${EOL}`)
      for (const root of report.roots) {
        process.stdout.write(
          `- ${root.path}${root.primary ? "（主工作区）" : ""}${root.trusted ? " · 已信任" : ""}${EOL}`,
        )
      }
      return
    }

    if (!args.directory) {
      printError(`workspace ${action} 需要一个已存在的目标目录。${usage}`)
      return
    }

    const owner = makeWorkspaceRootProductionOwner({ primary })
    if (!owner.enabled) {
      printError(
        `workspace ${action} 已绑定唯一 ${owner.owner}，但当前 writer=disabled；` +
          `blocking=${owner.gate.blocking_gate_ids.join(",")}。为避免恢复 Python workspace 状态第二来源，该动作已 fail-closed；未回退到 Python writer。` +
          `请先运行 arforge workspace --contract-audit --workspace ${primary} 查看缺口。${usage}`,
      )
      return
    }

    // The branch is intentionally unreachable while the aggregate Core gate
    // is blocked. Once the gate is satisfied, the same adapter is used by all
    // CLI/API/Desktop callers and the ActionGateway performs fresh L3 human
    // authorization before the writer can touch either state file.
    const { AppRuntime } = await import("../../effect/app-runtime")
    const result = await AppRuntime.runPromiseExit(
      LocationServiceMap.Service.use((locations) => {
        const locationLayer = locations.get(Location.Ref.make({ directory: AbsolutePath.make(primary) }))
        if (!locationLayer) return Effect.fail(new Error("workspace location services are unavailable"))
        return Effect.provide(
          ActionGateway.Service.use((gateway) =>
            executeWorkspaceRootControl({
              owner,
              gateway,
              principal: ControlPrincipal.LOCAL_PRINCIPAL,
              requestID: AgentRuntime.ControlPlaneRequestID.create(),
              action,
              target: resolve(args.directory!),
            }),
          ),
          Layer.unwrap(Effect.succeed(locationLayer)),
        )
      }),
    )
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause)
      const reason = failure instanceof WorkspaceRootWriterError ? failure.reason : "authorization_or_persistence"
      printError(`workspace ${action} 未完成：${reason}。未报告为成功，也未回退到 Python writer。`)
      return
    }
    if (args.json) {
      process.stdout.write(JSON.stringify({ workspace: primary, action, result: result.value }) + EOL)
      return
    }
    process.stdout.write(`workspace ${action} 已完成：${result.value.status}。${EOL}`)
  },
})
