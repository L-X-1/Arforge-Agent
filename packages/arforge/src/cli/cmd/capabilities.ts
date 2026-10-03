import { CapabilityAnalysis } from "@arforge-ai/core/analysis/capabilities"
import { CAPABILITY_CATALOG, nativeHealth } from "@arforge-ai/core/capability-catalog"
import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const MAX_TEST_INPUT = 4_000

const parseLimit = (value: number | undefined) => {
  if (value === undefined) return Effect.succeed(5)
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    return fail("--limit 必须是 1 到 20 之间的整数。")
  }
  return Effect.succeed(value)
}

export const CapabilitiesCommand = effectCmd({
  command: "capabilities [target] [input..]",
  describe: "查看能力目录，或安全预览输入会匹配的能力（route-preview）",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("target", {
        describe: "工作区目录；使用 test 做路由预览，或 evaluate 审计 typed 执行合同",
        type: "string",
      })
      .positional("input", {
        describe: "capabilities test 的输入文本",
        type: "string",
        array: true,
      })
      .option("workspace", {
        describe: "capabilities test 报告中的工作区，默认为当前目录",
        type: "string",
      })
      .option("json", {
        describe: "输出机器可读 JSON",
        type: "boolean",
        default: false,
      })
      .option("all", {
        describe: "显示能力说明、类别和优先级",
        type: "boolean",
        default: false,
      })
      .option("limit", {
        describe: "test 最多显示的匹配能力数（1-20）",
        type: "number",
      })
      .option("execute", {
        describe: "执行匹配 handler（当前 TS owner 仅支持无副作用预览）",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.capabilities")(function* (args) {
    const target = args.target?.trim()
    const input = (args.input ?? []).join(" ").trim()

    if (target?.toLowerCase() === "evaluate") {
      if (input) return yield* fail("capabilities evaluate 不接受输入文本；它只审计目录中的 typed 执行合同。")
      if (args.execute) {
        return yield* fail(
          "capabilities evaluate 只检查合同声明，不执行 handler；完整 typed 合同和运行时证据完成前保持 fail-closed。",
          2,
        )
      }
      if (args.limit !== undefined || args.all)
        return yield* fail("capabilities evaluate 只接受 --workspace 和 --json；报告会覆盖全部能力。")
      const workspace = resolve(args.workspace ?? process.cwd())
      const report = { workspace, ...CapabilityAnalysis.evaluate() }
      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + EOL)
        return
      }
      process.stdout.write(`能力执行合同评估（只读）${EOL}`)
      process.stdout.write(`工作区：${workspace}${EOL}`)
      process.stdout.write(
        `目录 ${report.catalog_count} 项 · 已启用 ${report.enabled_count} · 可执行 ${report.ready_count} · 保持 fail-closed ${report.not_ready_count}${EOL}`,
      )
      process.stdout.write(`执行模式：只检查声明；未调用 handler、模型、shell、文件或数据库${EOL}`)
      for (const item of report.items) {
        const detail =
          item.status === "ready"
            ? `owner=${item.declared_owner ?? "unknown"} · side-effects=${item.declared_side_effects}`
            : item.status === "disabled"
              ? "已禁用"
              : `缺少：${item.missing_requirements.join(", ")}`
        process.stdout.write(`- ${item.name}：${item.status} · ${detail}${EOL}`)
      }
      process.stdout.write(`说明：${report.caveat}${EOL}`)
      return
    }

    if (target?.toLowerCase() === "overview") {
      if (input) return yield* fail("capabilities overview 不接受额外输入；它只读取系统概览。")
      if (args.limit !== undefined || args.execute)
        return yield* fail("capabilities overview 只接受 --workspace、--all 和 --json。")
      const workspace = resolve(args.workspace ?? process.cwd())
      const result = yield* Effect.tryPromise({
        try: () => createOperationsApi(workspace).agentCapabilities.systemOverview({ location: { directory: workspace } }),
        catch: (error) => new CliError({ message: `读取能力系统概览失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })
      const report = { workspace, ...result.data }
      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + EOL)
        return
      }
      process.stdout.write(`能力系统概览（只读）${EOL}`)
      process.stdout.write(`工作区：${workspace}${EOL}`)
      for (const section of report.sections) {
        process.stdout.write(`- ${section.title}${EOL}`)
        if (args.all) process.stdout.write(`${JSON.stringify(section.data, null, 2)}${EOL}`)
      }
      return
    }

    if (target?.toLowerCase() === "test") {
      if (!input) return yield* fail("Usage: arforge capabilities test <input>", 1)
      if (input.length > MAX_TEST_INPUT) return yield* fail(`capabilities test 输入最多 ${MAX_TEST_INPUT} 个字符。`)
      if (args.all) return yield* fail("capabilities test 不支持 --all；它只显示确定性路由预览。")
      if (args.execute) {
        return yield* fail(
          "capabilities test 当前只提供无副作用路由预览；所有 capability handler 的 TS/Core 执行合同完成后才会开放 --execute。",
          2,
        )
      }
      const limit = yield* parseLimit(args.limit)
      const workspace = resolve(args.workspace ?? process.cwd())
      const report = { workspace, ...CapabilityAnalysis.test(input, { limit }) }
      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + EOL)
        return
      }

      process.stdout.write(`输入：${report.input}${EOL}`)
      process.stdout.write(`匹配能力：${report.capabilities_used.join(", ") || "无"}${EOL}`)
      process.stdout.write(`执行模式：路由预览（无副作用；未执行 handler）${EOL}`)
      process.stdout.write(`已执行：${report.executed}；匹配：${report.matched}${EOL}`)
      for (const item of report.items) {
        process.stdout.write(
          `- ${item.name} [${item.kind}, P${item.priority}, score=${item.score}] · 关键词：${item.matched_keywords.join(", ")}${EOL}`,
        )
      }
      return
    }

    if (args.input && args.input.length > 0) {
      return yield* fail("capabilities 目录模式只接受一个工作区；需要测试输入时使用 `capabilities test <input>`。")
    }
    if (args.limit !== undefined || args.execute) {
      return yield* fail("--limit/--execute 仅适用于 `capabilities test <input>`。")
    }
    if (target && args.workspace) return yield* fail("工作区位置参数与 --workspace 不能同时使用。")
    const workspace = resolve(args.workspace ?? target ?? process.cwd())
    const health = nativeHealth()
    const capabilities = {
      count: CAPABILITY_CATALOG.length,
      items: CAPABILITY_CATALOG,
    }
    const result = { workspace, health, capabilities }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }

    const enabled = result.capabilities.items.filter((item) => item.enabled)
    process.stdout.write(
      `${result.health.brand} ${result.health.version} · 原生 TS 运行时 · ${enabled.length}/${result.capabilities.count} 项能力已启用${EOL}`,
    )
    process.stdout.write(`工作区：${result.workspace}${EOL}`)
    for (const item of enabled) {
      process.stdout.write(
        args.all
          ? `- ${item.name} [${item.kind}, P${item.priority}] — ${item.description}${EOL}`
          : `- ${item.name}${EOL}`,
      )
    }
  }),
})
