import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { FeaturePolicyAnalysis } from "@arforge-ai/core/analysis/feature-policy"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["list", "set", "clear", "refresh"] as const

type FeatureItem = {
  readonly flag_id: string
  readonly default: boolean
  readonly description: string
  readonly enabled: boolean
  readonly source: string
  readonly environment_variable: string
}

type FeaturePolicy = {
  readonly schema_version: number
  readonly source: string
  readonly items: ReadonlyArray<FeatureItem>
}

type DeepInsightsResponse = {
  readonly data?: {
    readonly sections?: ReadonlyArray<{
      readonly id: string
      readonly data: unknown
    }>
  }
}

const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => new CliError({ message: `功能列表读取失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
  })

function featurePolicy(response: unknown): FeaturePolicy | undefined {
  if (typeof response !== "object" || response === null) return undefined
  const data = (response as DeepInsightsResponse).data
  const section = data?.sections?.find((item) => item.id === "features")
  if (typeof section?.data !== "object" || section.data === null) return undefined
  const policy = section.data as Partial<FeaturePolicy>
  if (!Array.isArray(policy.items)) return undefined
  const items = policy.items
  if (
    !items.every((item): item is FeatureItem => {
      if (typeof item !== "object" || item === null) return false
      const value = item as Partial<FeatureItem>
      return (
        typeof value.flag_id === "string" &&
        typeof value.default === "boolean" &&
        typeof value.description === "string" &&
        typeof value.enabled === "boolean" &&
        typeof value.source === "string" &&
        typeof value.environment_variable === "string"
      )
    })
  )
    return undefined
  return {
    schema_version: typeof policy.schema_version === "number" ? policy.schema_version : 1,
    source: typeof policy.source === "string" ? policy.source : "typescript-core",
    items,
  }
}

function render(policy: FeaturePolicy): string {
  const lines = ["Feature policy", `来源：${policy.source} · ${policy.items.length} 项`]
  for (const item of policy.items) {
    lines.push(`- ${item.flag_id} · ${item.enabled ? "enabled" : "disabled"} · ${item.source}`)
    lines.push(`  ${item.description}`)
  }
  return lines.join(EOL) + EOL
}

/**
 * TypeScript/Core owner for the read-only part of the historical Python
 * `features` command.  The old local JSON registry is deliberately not read.
 * Mutations remain explicit exit-2 gaps until a typed, transactional feature
 * policy writer exists, so Python compatibility cannot create a second state
 * owner or silently change runtime behavior.
 */
export const FeaturesCommand = effectCmd({
  command: "features [action] [value..]",
  describe: "查看 TypeScript/Core 功能策略（旧写入动作明确保持迁移保护）",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "操作；省略时为 list", choices: actions, default: "list" })
      .positional("value", { describe: "set/clear 的旧参数（写入动作当前不执行）", type: "string", array: true })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false })
      .option("contract-audit", {
        describe: "只读显示 features 的 TS/Core 合同缺口，不读取或写入旧策略",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.features")(function* (args) {
    const action = args.action ?? "list"
    const values = args.value ?? []
    if (args.contractAudit) {
      if (action !== "list") return yield* fail("features --contract-audit 仅适用于 `features`/`features list`。")
      if (values.length > 0) return yield* fail("features --contract-audit 只接受 --workspace、--json 和自身开关。")
      const workspace = resolve(args.workspace ?? process.cwd())
      const report = { workspace, ...FeaturePolicyAnalysis.audit() }
      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + EOL)
        return
      }
      process.stdout.write(`功能策略合同审计（只读）${EOL}`)
      process.stdout.write(`工作区：${workspace}${EOL}`)
      process.stdout.write(`状态：${report.status} · ready=${report.ready} · side-effects=${report.side_effects}${EOL}`)
      process.stdout.write(`缺口：${report.missing_requirements.join(", ")}${EOL}`)
      process.stdout.write(`说明：${report.caveat}${EOL}`)
      return
    }
    if (action === "list") {
      if (values.length > 0) return yield* fail("features list 不接受额外参数。")
      const workspace = resolve(args.workspace ?? process.cwd())
      const response = yield* invoke(() =>
        createOperationsApi(workspace).agentCapabilities.deepInsights({ location: { directory: workspace } }),
      )
      const policy = featurePolicy(response)
      if (!policy) return yield* fail("TypeScript/Core 未返回有效的 features 策略。")
      if (args.json) {
        process.stdout.write(JSON.stringify(policy, null, 2) + EOL)
        return
      }
      process.stdout.write(render(policy))
      return
    }

    if (action === "set") {
      if (values.length !== 2 || !["on", "off"].includes(values[1].toLowerCase()))
        return yield* fail("用法：features set <flag> <on|off>。")
    } else if (action === "clear") {
      if (values.length !== 1) return yield* fail("用法：features clear <flag>。")
    } else if (action === "refresh") {
      if (values.length !== 0) return yield* fail("用法：features refresh。")
    }

    return yield* fail(
      `features ${action} 尚无 TypeScript/Core 事务式写入 owner；为避免恢复 Python feature_flags.json 第二状态源，该动作已 fail-closed。当前可用：features list。`,
      2,
    )
  }),
})
