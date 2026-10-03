import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { PermissionPolicyAnalysis } from "@arforge-ai/core/analysis/permission-policy"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["list", "add", "revoke"] as const

type SavedPermission = {
  readonly id: string
  readonly projectID: string
  readonly action: string
  readonly resource: string
}

const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => new CliError({ message: `权限规则读取失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
  })

const isSavedPermission = (value: unknown): value is SavedPermission => {
  if (typeof value !== "object" || value === null) return false
  const item = value as Partial<SavedPermission>
  return (
    typeof item.id === "string" &&
    typeof item.projectID === "string" &&
    typeof item.action === "string" &&
    typeof item.resource === "string"
  )
}

function parsePermissions(value: unknown): ReadonlyArray<SavedPermission> | undefined {
  if (!Array.isArray(value) || !value.every(isSavedPermission)) return undefined
  return value
}

function render(items: ReadonlyArray<SavedPermission>): string {
  const lines = ["Permission rules", `来源：TypeScript/Core · ${items.length} 条`]
  if (items.length === 0) {
    lines.push("（没有已保存规则）")
    return lines.join(EOL) + EOL
  }
  for (const item of items) lines.push(`- ${item.id} · ${item.action} · ${item.resource} · project=${item.projectID}`)
  return lines.join(EOL) + EOL
}

/**
 * TypeScript/Core owner for the read-only part of the historical Python
 * `permissions` command. Saved rules are read through the same typed
 * permission endpoint used by the product; the Python permission profile is
 * never opened. Adding/removing rules remains closed until its transaction,
 * authorization, audit and rollback contract is complete.
 */
export const PermissionsCommand = effectCmd({
  command: "permissions [action] [value..]",
  describe: "查看 TypeScript/Core 已保存权限规则（旧写入动作明确保持迁移保护）",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "操作；省略时为 list", choices: actions, default: "list" })
      .positional("value", { describe: "add/revoke 的旧参数（写入动作当前不执行）", type: "string", array: true })
      .option("workspace", { describe: "工作区目录，默认为当前目录", type: "string" })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false })
      .option("contract-audit", {
        describe: "只读显示 permissions 的 TS/Core 合同缺口，不读取或写入旧策略",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.permissions")(function* (args) {
    const action = args.action ?? "list"
    const values = args.value ?? []
    if (args.contractAudit) {
      if (action !== "list") return yield* fail("permissions --contract-audit 仅适用于 `permissions`/`permissions list`。")
      if (values.length > 0) return yield* fail("permissions --contract-audit 只接受 --workspace、--json 和自身开关。")
      const workspace = resolve(args.workspace ?? process.cwd())
      const report = { workspace, ...PermissionPolicyAnalysis.audit() }
      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + EOL)
        return
      }
      process.stdout.write(`权限策略合同审计（只读）${EOL}`)
      process.stdout.write(`工作区：${workspace}${EOL}`)
      process.stdout.write(`状态：${report.status} · ready=${report.ready} · side-effects=${report.side_effects}${EOL}`)
      process.stdout.write(`缺口：${report.missing_requirements.join(", ")}${EOL}`)
      process.stdout.write(`说明：${report.caveat}${EOL}`)
      return
    }
    if (action === "list") {
      if (values.length > 0) return yield* fail("permissions list 不接受额外参数。")
      const workspace = resolve(args.workspace ?? process.cwd())
      const result = yield* invoke(() => createOperationsApi(workspace).permissions.listSaved())
      const items = parsePermissions(result)
      if (!items) return yield* fail("TypeScript/Core 未返回有效的已保存权限规则。")
      const payload = { schema_version: 1, count: items.length, items }
      if (args.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + EOL)
        return
      }
      process.stdout.write(render(items))
      return
    }

    if (action === "add") {
      if (values.length < 3 || values.length > 4)
        return yield* fail("用法：permissions add <subject> <category> <decision> [scope]。")
    } else if (action === "revoke") {
      if (values.length !== 1) return yield* fail("用法：permissions revoke <rule-id>。")
    }

    return yield* fail(
      `permissions ${action} 尚无 TypeScript/Core 事务式写入 owner；为避免恢复 Python 权限配置第二状态源，该动作已 fail-closed。当前可用：permissions list。`,
      2,
    )
  }),
})
