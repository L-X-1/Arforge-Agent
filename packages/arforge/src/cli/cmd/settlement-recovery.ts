import { EOL } from "node:os"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import type { Argv } from "yargs"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import * as ChildSettlementRecovery from "@arforge-ai/core/runtime/child-settlement-recovery"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { CliError } from "../effect-cmd"
import { cmd } from "./cmd"

type RecoveryStatus = "prepared" | "recovery-required"

interface SettlementRecoveryArgs {
  readonly directory?: string
  readonly status?: RecoveryStatus
  readonly limit: number
  readonly confirm?: string
  readonly json: boolean
}

type SettlementRecoveryProjection = Omit<ChildSettlementRecovery.SettlementRecoverySweepReport, "identity"> & {
  readonly runtime: "typescript"
  readonly owner: "core-child-settlement-recovery"
  readonly execution_boundary: Readonly<{
    readonly mode: "metadata-only-recovery"
    readonly writes: true
    readonly provider_execution_allowed: false
    readonly external_retry: false
  }>
}

const confirmation = "recover_settlements"

const project = (report: ChildSettlementRecovery.SettlementRecoverySweepReport): SettlementRecoveryProjection => ({
  runtime: "typescript",
  owner: "core-child-settlement-recovery",
  schemaVersion: report.schemaVersion,
  ...(report.status === undefined ? { status: undefined } : { status: report.status }),
  limit: report.limit,
  scanned: report.scanned,
  committed: report.committed,
  pending: report.pending,
  recoveryRequired: report.recoveryRequired,
  failed: report.failed,
  hasMore: report.hasMore,
  items: report.items,
  deterministic: report.deterministic,
  providerExecutionAllowed: report.providerExecutionAllowed,
  execution_boundary: {
    mode: "metadata-only-recovery",
    writes: true,
    provider_execution_allowed: false,
    external_retry: false,
  },
})

const render = (report: SettlementRecoveryProjection): string => {
  const lines = [
    "子任务结算恢复扫描（已确认）",
    "运行时：TypeScript/Core · owner=core-child-settlement-recovery",
    `状态过滤：${report.status ?? "prepared + recovery-required"} · 上限=${report.limit}`,
    `结果：扫描 ${report.scanned} · 已提交 ${report.committed} · 待处理 ${report.pending} · 需人工复核 ${report.recoveryRequired} · 失败 ${report.failed}${report.hasMore ? " · 仍有下一页" : ""}`,
    "执行边界：仅重放确定性的 owner 写入 · 不携带 payload · Provider=禁止 · 外部重试=禁止",
  ]
  for (const item of report.items) {
    lines.push(
      `- ${item.intentID} · ${item.parentRunID} → ${item.childRunID} · ${item.sourceStatus} → ${item.afterStatus ?? "unknown"} · ${item.outcome}`,
    )
    lines.push(`  ${item.reason}`)
    if (item.attempted.length > 0) lines.push(`  尝试：${item.attempted.join(", ")}`)
    if (item.repaired.length > 0) lines.push(`  修复：${item.repaired.join(", ")}`)
  }
  return lines.join(EOL) + EOL
}

/**
 * Formal CLI projection for the Core bounded recovery sweep.  The command is
 * deliberately confirmation-gated; without the exact literal it performs no
 * database read or write.  It shares the LocationServiceMap/Core owner with
 * HTTP and Desktop instead of maintaining a CLI state machine.
 */
export const SettlementRecoveryCommand = cmd<{}, SettlementRecoveryArgs>({
  command: "settlement-recovery",
  aliases: ["settlement-recover"],
  describe: "按租户扫描并恢复待处理的子任务结算（需显式确认）",
  builder: (yargs: Argv) =>
    yargs
      .option("directory", {
        type: "string",
        describe: "工作区目录；默认为当前目录",
      })
      .option("status", {
        type: "string",
        choices: ["prepared", "recovery-required"] as const,
        describe: "只处理一种 recovery-outbox 状态",
      })
      .option("limit", {
        type: "number",
        default: 100,
        describe: "本次最多处理的 receipt 数（1-1000）",
      })
      .option("confirm", {
        type: "string",
        describe: `允许写入的精确确认值：${confirmation}`,
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      }),
  async handler(args) {
    if (args.confirm !== confirmation) {
      const message = `结算恢复不会默认执行写入；如需处理当前租户的 recovery-outbox，请重新运行并明确提供 --confirm ${confirmation}。`
      if (args.json)
        process.stdout.write(
          JSON.stringify(
            {
              schemaVersion: 1,
              runtime: "typescript",
              owner: "core-child-settlement-recovery",
              confirmationRequired: true,
              writes: false,
              providerExecutionAllowed: false,
              reason: message,
            },
            null,
            2,
          ) + EOL,
        )
      else process.stderr.write(message + EOL)
      process.exitCode = 2
      return
    }

    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 1_000) {
      throw new CliError({ message: "--limit 必须是 1 到 1000 之间的整数。", exitCode: 2 })
    }

    const directory = resolve(args.directory ?? process.cwd())
    try {
      if (!statSync(directory).isDirectory()) throw new Error("not a directory")
    } catch {
      throw new CliError({ message: `工作区目录不存在或不可用：${directory}`, exitCode: 2 })
    }

    const { AppRuntime } = await import("../../effect/app-runtime")
    const identity = {
      ...Database.DefaultLocalPrincipal,
      actor: "cli:settlement-recovery",
    } as const
    const result = await AppRuntime.runPromiseExit(
      LocationServiceMap.Service.use((locations) => {
        const locationLayer = locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))
        if (!locationLayer) return Effect.fail(new Error("workspace location services are unavailable"))
        const operation = Effect.gen(function* () {
          const recovery = yield* ChildSettlementRecovery.Service
          return yield* recovery.recoverPending({
            identity,
            ...(args.status === undefined ? {} : { status: args.status }),
            limit: args.limit,
          })
        }).pipe(Effect.provideService(Database.CurrentPrincipal, identity))
        return Effect.provide(operation, Layer.unwrap(Effect.succeed(locationLayer)))
      }),
    )
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause)
      throw new CliError({
        message: `结算恢复未完成：${error instanceof Error ? error.message : String(error)}。未回退到 Python writer。`,
        exitCode: 1,
      })
    }

    const report = project(result.value)
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + EOL)
    else process.stdout.write(render(report))
  },
})
