import { Effect } from "effect"
import { CATEGORY_LABELS, MemoryDigestAnalysis, type MemoryDigestItem } from "@arforge-ai/core/analysis/memory-digest"
import { MemoryConflictAnalysis } from "@arforge-ai/core/analysis/memory-conflict"
import { MemoryMetricsAnalysis, MemoryWriteStatsAnalysis } from "@arforge-ai/core/analysis/memory-metrics"
import { MemoryRecoveryAnalysis } from "@arforge-ai/core/analysis/memory-recovery"
import { MemoryFeedbackAnalysis } from "@arforge-ai/core/analysis/memory-feedback"
import { mkdirSync, writeFileSync } from "node:fs"
import { EOL, homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = [
  "status",
  "list",
  "search",
  "get",
  "create",
  "update",
  "facets",
  "recall-quality",
  // These names stay parseable so an old script receives a deterministic
  // migration message instead of yargs' opaque unknown-value error.
  "metrics",
  "conflict",
  "write-stats",
  "recovery",
  "feedback",
  "digest",
] as const

const sources = [
  "user",
  "user-corrected",
  "imported",
  "auto",
  "model",
  "quarantined",
  "quarantined:auto",
  "quarantined:model",
] as const
const scopes = ["workspace", "global"] as const

const csv = (value?: string) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? []

const parseFeedbackIDs = (value: unknown): { ids?: number[]; error?: string } => {
  if (value === undefined) return { ids: [] }
  if (typeof value !== "string") return { error: "反馈记忆 ID 必须是逗号分隔的正整数。" }
  const parts = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (parts.length === 0) return { error: "反馈记忆 ID 必须是逗号分隔的正整数。" }
  const ids: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { error: "反馈记忆 ID 必须是逗号分隔的正整数。" }
    const parsed = Number(part)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return { error: "反馈记忆 ID 必须是逗号分隔的正整数。" }
    ids.push(parsed)
  }
  return { ids: [...new Set(ids)].sort((left, right) => left - right) }
}

const location = (directory: string) => ({ directory })

const defaultDigestPath = () =>
  join(process.env.ARFORGE_HOME?.trim() || join(homedir(), ".arforge"), "memory-digest.md")

const dateTimeText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString()
  if (
    typeof value === "object" &&
    value !== null &&
    "epochMillis" in value &&
    typeof value.epochMillis === "number" &&
    Number.isFinite(value.epochMillis)
  )
    return new Date(value.epochMillis).toISOString()
  return String(value ?? "")
}

const toDigestItem = (item: {
  readonly id: string
  readonly content: string
  readonly type: string
  readonly tags: ReadonlyArray<string>
  readonly importance: number
  readonly source: string
  readonly projectID?: string
  readonly workspacePath?: string
  readonly time: { readonly created: unknown }
}): MemoryDigestItem => ({
  id: item.id,
  content: item.content,
  type: item.type,
  tags: item.tags,
  importance: item.importance,
  source: item.source,
  createdAt: dateTimeText(item.time.created),
  projectID: item.projectID,
  workspacePath: item.workspacePath,
})

const knownDigestCategory = (category: string): boolean =>
  Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category.trim().toLowerCase())

const printMemory = (item: {
  id: string
  content: string
  type: string
  tags: ReadonlyArray<string>
  importance: number
  source: string
  scope: string
  version: number
}) =>
  `${item.id} · ${item.type} · ${item.scope}/${item.source} · 重要性 ${item.importance} · v${item.version} · ${item.content}${
    item.tags.length > 0 ? ` · #${item.tags.join(" #")}` : ""
  }`

const parseBoundedNumber = (name: string, value: number | undefined, minimum: number, maximum: number) => {
  if (value === undefined) return Effect.succeed(undefined)
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    return fail(`--${name} 必须是 ${minimum} 到 ${maximum} 之间的数字。`)
  }
  return Effect.succeed(value)
}

/**
 * TypeScript owner for the behavior-complete portion of the historical
 * `memory` CLI.  It calls the same generated HTTP/SDK contract used by
 * Browser/Desktop; it does not open a second database or Python memory store.
 */
export const MemoryCommand = effectCmd({
  command: "memory [action] [value..]",
  describe: "查看、搜索和显式维护工作区记忆（与 Core/Server 共享）",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "操作；省略时为 status", choices: actions, default: "status" })
      .positional("value", { describe: "操作对应的记忆 ID、查询或内容", type: "string", array: true })
      .option("workspace", {
        describe: "工作区目录，默认为当前目录；请求会绑定到该目录",
        type: "string",
      })
      .option("query", { describe: "列表过滤或 semantic 搜索文本", type: "string" })
      .option("type", { describe: "记忆类型过滤或写入值", type: "string" })
      .option("tag", { describe: "标签过滤", type: "string" })
      .option("source", { describe: "来源过滤或写入值", choices: sources })
      .option("minimum-importance", { describe: "最低重要性（0-5）", type: "number" })
      .option("include-global", {
        describe: "是否包含受治理的全局记忆（可用 --no-include-global 关闭）",
        type: "boolean",
        default: true,
      })
      .option("limit", { describe: "list/search 最大条数", type: "number", default: 100 })
      .option("top-k", { describe: "search 返回数量（1-20）", type: "number" })
      .option("index-limit", { describe: "search 索引扫描上限（1-1000）", type: "number" })
      .option("content", { describe: "create/update 的记忆内容", type: "string" })
      .option("tags", { describe: "create/update 标签，逗号分隔（最多 32 个）", type: "string" })
      .option("importance", { describe: "create/update 重要性（0-5）", type: "number" })
      .option("scope", { describe: "create 作用域", choices: scopes })
      .option("related-to", { describe: "create 关联记忆 ID", type: "string" })
      .option("strength", { describe: "create/update 强度（0-1）", type: "number" })
      .option("review-level", { describe: "create/update 复核等级（0-5）", type: "number" })
      .option("retrieval-uid", { describe: "历史 recall feedback 的检索事件 ID（迁移期只校验）", type: "string" })
      .option("useful", { describe: "历史 recall feedback 的有用记忆 ID（逗号分隔，迁移期只校验）", type: "string" })
      .option("irrelevant", {
        describe: "历史 recall feedback 的无关记忆 ID（逗号分隔，迁移期只校验）",
        type: "string",
      })
      .option("contract-audit", {
        describe: "只读显示 memory feedback 的 TS/Core 合同缺口，不读取或写入反馈",
        type: "boolean",
        default: false,
      })
      .option("category", { describe: "digest 类别过滤（如 identity、workflow）", type: "string" })
      .option("path", { describe: "digest Markdown 输出路径；显式指定才写入该路径", type: "string" })
      .option("digest-limit", {
        describe: "digest 最多读取的工作区记忆数（1-500）",
        type: "number",
        default: 500,
      })
      .option("conflict-limit", {
        describe: "conflict 最多读取的已持久化候选数（read-only，1-500）",
        type: "number",
        default: 200,
      })
      .option("clear", {
        describe: "清理历史写入/恢复统计（迁移期保持关闭）",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory")(function* (args) {
    const action = args.action ?? "status"
    const values = args.value ?? []
    const workspace = resolve(args.workspace ?? process.cwd())

    if (args.contractAudit) {
      if (action !== "feedback") return yield* fail("--contract-audit 仅适用于 `memory feedback`。")
      if (
        values.length > 0 ||
        args.query !== undefined ||
        args.type !== undefined ||
        args.tag !== undefined ||
        args.source !== undefined ||
        args.minimumImportance !== undefined ||
        args.includeGlobal === false ||
        args.limit !== 100 ||
        args.topK !== undefined ||
        args.indexLimit !== undefined ||
        args.content !== undefined ||
        args.tags !== undefined ||
        args.importance !== undefined ||
        args.scope !== undefined ||
        args.relatedTo !== undefined ||
        args.strength !== undefined ||
        args.reviewLevel !== undefined ||
        args.retrievalUid !== undefined ||
        args.useful !== undefined ||
        args.irrelevant !== undefined ||
        args.category !== undefined ||
        args.path !== undefined ||
        args.digestLimit !== 500 ||
        args.conflictLimit !== 200 ||
        args.clear
      )
        return yield* fail("memory feedback --contract-audit 只接受 --workspace、--json 和自身开关。")
      const report = { workspace, ...MemoryFeedbackAnalysis.audit() }
      if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + EOL)
        return
      }
      process.stdout.write(`Memory feedback 合同审计（只读）${EOL}`)
      process.stdout.write(`工作区：${workspace}${EOL}`)
      process.stdout.write(`状态：${report.status} · 决策：${report.decision} · 写入：${report.writes}${EOL}`)
      process.stdout.write(`缺口：${report.missing_requirements.join(", ")}${EOL}`)
      process.stdout.write(`说明：${report.caveat}${EOL}`)
      return
    }

    const api = createOperationsApi(workspace)
    const at = { location: location(workspace) }

    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) => new CliError({ message: `记忆操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })

    const includeGlobal = args.includeGlobal ? "true" : "false"
    const limit = yield* parseBoundedNumber("limit", args.limit, 1, 500)
    const minimumImportance = yield* parseBoundedNumber("minimum-importance", args.minimumImportance, 0, 5)
    const topK = yield* parseBoundedNumber("top-k", args.topK, 1, 20)
    const indexLimit = yield* parseBoundedNumber("index-limit", args.indexLimit, 1, 1_000)
    const importance = yield* parseBoundedNumber("importance", args.importance, 0, 5)
    const strength = yield* parseBoundedNumber("strength", args.strength, 0, 1)
    const reviewLevel = yield* parseBoundedNumber("review-level", args.reviewLevel, 0, 5)
    const tags = csv(args.tags)
    if (tags.length > 32) return yield* fail("--tags 最多包含 32 个标签。")
    if (args.clear && action !== "write-stats" && action !== "recovery")
      return yield* fail("--clear 只适用于 memory write-stats/recovery；当前历史清理操作仍在迁移。")

    let result: unknown
    switch (action) {
      case "status":
        if (values.length > 0) return yield* fail("memory status 不接受额外参数。")
        result = yield* invoke(() => api.memories.status(at))
        break
      case "list":
        if (values.length > 0) return yield* fail("memory list 使用 --query 等选项，不接受额外参数。")
        result = yield* invoke(() =>
          api.memories.list({
            ...at,
            query: args.query,
            type: args.type,
            tag: args.tag,
            source: args.source,
            minimumImportance,
            includeGlobal,
            limit,
          }),
        )
        break
      case "search": {
        if (args.query !== undefined && values.length > 0)
          return yield* fail("search 请在位置参数和 --query 中选择一个。")
        const query = (args.query ?? values.join(" ")).trim()
        if (!query) return yield* fail("memory search 需要查询文本。")
        result = yield* invoke(() =>
          api.memories.semantic({
            ...at,
            query,
            topK,
            indexLimit,
            includeGlobal,
          }),
        )
        break
      }
      case "get": {
        if (values.length !== 1 || !values[0]?.trim()) return yield* fail("memory get 需要一个记忆 ID。")
        result = yield* invoke(() => api.memories.get({ ...at, memoryID: values[0] }))
        break
      }
      case "facets":
        if (values.length > 0) return yield* fail("memory facets 不接受额外参数。")
        result = yield* invoke(() => api.memories.facets({ ...at, includeGlobal }))
        break
      case "recall-quality":
        if (values.length > 0) return yield* fail("memory recall-quality 不接受额外参数。")
        result = yield* invoke(() => api.memories.recallQuality(at))
        break
      case "metrics": {
        if (values.length > 0) return yield* fail("memory metrics 不接受位置参数；它只读取当前工作区的 Core 指标。")
        if (
          args.query !== undefined ||
          args.type !== undefined ||
          args.tag !== undefined ||
          args.source !== undefined ||
          args.minimumImportance !== undefined ||
          args.topK !== undefined ||
          args.indexLimit !== undefined ||
          args.content !== undefined ||
          args.tags !== undefined ||
          args.importance !== undefined ||
          args.scope !== undefined ||
          args.relatedTo !== undefined ||
          args.strength !== undefined ||
          args.reviewLevel !== undefined ||
          args.category !== undefined ||
          args.path !== undefined ||
          args.digestLimit !== 500 ||
          args.conflictLimit !== 200 ||
          args.limit !== 100
        )
          return yield* fail("memory metrics 只接受 --workspace 和 --json；旧 golden eval/history 尚未开放。")
        const [status, recallQuality, persisted, visible] = yield* Effect.all(
          [
            invoke(() => api.memories.status(at)),
            invoke(() => api.memories.recallQuality(at)),
            invoke(() => api.memories.conflictList({ ...at, includeClosed: "true", limit: 500 })),
            invoke(() => api.memories.list({ ...at, includeGlobal, limit: 500 })),
          ],
          { concurrency: 4 },
        )
        const report = {
          generated_at: new Date().toISOString(),
          ...MemoryMetricsAnalysis.compose({
            status,
            recallQuality,
            conflicts: persisted,
            visible,
          }),
        }
        if (args.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + EOL)
          return
        }
        process.stdout.write(`记忆指标（只读）${EOL}`)
        process.stdout.write(
          `总量 ${report.status.total} · 工作区 ${report.status.workspace} · 全局 ${report.status.global} · 重要 ${report.status.important} · 待处理冲突 ${report.status.pending_conflicts}${EOL}`,
        )
        process.stdout.write(
          `召回质量：${report.recall_quality.status} · 样本 ${report.recall_quality.sample_size} · Top-1 ${(report.recall_quality.top1_rate * 100).toFixed(2)}% · MRR ${report.recall_quality.mean_reciprocal_rank.toFixed(4)}${EOL}`,
        )
        process.stdout.write(
          `已持久化冲突：${report.persisted_conflicts.count} 条 · 返回 ${report.persisted_conflicts.returned} · detector ${report.persisted_conflicts.detector_version}${EOL}`,
        )
        process.stdout.write(
          `来源统计：${report.source_coverage.inspected}/${report.source_coverage.visible_total} 条 · ${report.source_coverage.status}（不等同 provenance 覆盖率）${EOL}`,
        )
        process.stdout.write(
          `Golden eval：${report.golden_eval.status}；history：${report.history.status}。不会写入 benchmark history 或调用模型。${EOL}`,
        )
        process.stdout.write(`说明：${report.caveat}${EOL}`)
        return
      }
      case "write-stats": {
        if (args.clear)
          return yield* fail(
            "memory write-stats --clear 仍在迁移：TS/Core 尚未接管旧 memory_writes.jsonl producer，当前不会删除历史文件。",
            2,
          )
        if (values.length > 0) return yield* fail("memory write-stats 不接受位置参数；它只读取 Core 数据库投影。")
        if (
          args.query !== undefined ||
          args.type !== undefined ||
          args.tag !== undefined ||
          args.source !== undefined ||
          args.minimumImportance !== undefined ||
          args.topK !== undefined ||
          args.indexLimit !== undefined ||
          args.content !== undefined ||
          args.tags !== undefined ||
          args.importance !== undefined ||
          args.scope !== undefined ||
          args.relatedTo !== undefined ||
          args.strength !== undefined ||
          args.reviewLevel !== undefined ||
          args.category !== undefined ||
          args.path !== undefined ||
          args.digestLimit !== 500 ||
          args.conflictLimit !== 200 ||
          args.limit !== 100 ||
          args.includeGlobal === false
        )
          return yield* fail("memory write-stats 只接受 --workspace、--json；旧事件日志字段尚未开放。")
        const [status, visible] = yield* Effect.all(
          [
            invoke(() => api.memories.status(at)),
            invoke(() => api.memories.list({ ...at, includeGlobal: "true", limit: 500 })),
          ],
          { concurrency: 2 },
        )
        const report = MemoryWriteStatsAnalysis.compose({ status, visible })
        if (args.json) {
          process.stdout.write(JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2) + EOL)
          return
        }
        process.stdout.write(`记忆写入统计（只读）${EOL}`)
        process.stdout.write(
          `Core 数据库：${report.database.total} 条 · 工作区 ${report.database.workspace} · 全局 ${report.database.global} · 重要 ${report.database.important} · 隔离 ${report.database.quarantined} · 待处理冲突 ${report.database.pending_conflicts}${EOL}`,
        )
        process.stdout.write(
          `来源/类型/作用域：${report.database.inspected}/${report.database.visible_total} 条已检查${report.database.truncated ? "（已达到读取上限）" : ""}${EOL}`,
        )
        process.stdout.write(
          `旧决策日志：${report.decision_log.status}；清理：${report.clear.status}。不会读取或删除 ${report.decision_log.file}。${EOL}`,
        )
        process.stdout.write(`说明：${report.caveat}${EOL}`)
        return
      }
      case "recovery": {
        if (args.clear)
          return yield* fail(
            "memory recovery --clear 仍在迁移：TS/Core 尚未接管恢复日志 producer，当前不会删除历史文件。",
            2,
          )
        if (values.length > 0) return yield* fail("memory recovery 不接受位置参数；它只读取 profile-local 恢复日志。")
        if (
          args.query !== undefined ||
          args.type !== undefined ||
          args.tag !== undefined ||
          args.source !== undefined ||
          args.minimumImportance !== undefined ||
          args.topK !== undefined ||
          args.indexLimit !== undefined ||
          args.content !== undefined ||
          args.tags !== undefined ||
          args.importance !== undefined ||
          args.scope !== undefined ||
          args.relatedTo !== undefined ||
          args.strength !== undefined ||
          args.reviewLevel !== undefined ||
          args.category !== undefined ||
          args.path !== undefined ||
          args.digestLimit !== 500 ||
          args.conflictLimit !== 200 ||
          args.limit !== 100 ||
          args.includeGlobal === false
        )
          return yield* fail("memory recovery 只接受 --workspace、--json；旧 producer/清理尚未开放。")
        const report = MemoryRecoveryAnalysis.report()
        if (args.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + EOL)
          return
        }
        process.stdout.write(`记忆恢复统计（只读）${EOL}`)
        process.stdout.write(
          `事件 ${report.events_total} · 已验证 ${report.verified_count} · 恢复成功率 ${(report.restore_success_rate * 100).toFixed(2)}% · 待重建率 ${(report.pending_rebuild_rate * 100).toFixed(2)}%${EOL}`,
        )
        process.stdout.write(
          `来源：${report.source.status}（有效 ${report.source.rows}，损坏 ${report.source.corrupt_rows}）· 清理：${report.clear.status}${EOL}`,
        )
        process.stdout.write(`说明：${report.caveat}${EOL}`)
        return
      }
      case "feedback": {
        if (args.retrievalUid !== undefined && values.length > 0)
          return yield* fail("memory feedback 请在位置参数和 --retrieval-uid 中选择一个。")
        if (values.length > 1) return yield* fail("memory feedback 最多接受一个 retrieval UID。")
        const retrievalUID = (args.retrievalUid ?? values[0])?.trim()
        if (!retrievalUID) return yield* fail("memory feedback 需要一个 retrieval UID。")
        const useful = parseFeedbackIDs(args.useful)
        if (useful.error) return yield* fail(useful.error)
        const irrelevant = parseFeedbackIDs(args.irrelevant)
        if (irrelevant.error) return yield* fail(irrelevant.error)
        const usefulIDs = useful.ids ?? []
        const irrelevantIDs = irrelevant.ids ?? []
        if (usefulIDs.length === 0 && irrelevantIDs.length === 0)
          return yield* fail("memory feedback 至少需要 --useful 或 --irrelevant。")
        if (usefulIDs.some((id) => irrelevantIDs.includes(id)))
          return yield* fail("同一记忆不能同时标记为 useful 和 irrelevant。")
        const report = MemoryFeedbackAnalysis.audit()
        return yield* fail(
          `memory feedback 仍在迁移：当前 TS/Core 缺少 durable retrieval event、returned-set 校验、工作区/身份绑定和事务更新（${report.missing_requirements.join(", ")}）；不会写入 recall feedback，也不会回退旧 Python 数据库。`,
          2,
        )
      }
      case "digest": {
        if (values.length > 0) return yield* fail("memory digest 不接受位置参数；请使用 --category、--path 或 --json。")
        if (
          args.query !== undefined ||
          args.type !== undefined ||
          args.tag !== undefined ||
          args.source !== undefined ||
          args.minimumImportance !== undefined ||
          args.topK !== undefined ||
          args.indexLimit !== undefined ||
          args.content !== undefined ||
          args.tags !== undefined ||
          args.importance !== undefined ||
          args.scope !== undefined ||
          args.relatedTo !== undefined ||
          args.strength !== undefined ||
          args.reviewLevel !== undefined ||
          args.limit !== 100
        )
          return yield* fail(
            "memory digest 只接受 --workspace、--category、--path、--digest-limit、--no-include-global 和 --json。",
          )
        const digestLimit = yield* parseBoundedNumber("digest-limit", args.digestLimit, 1, 500)
        const page = yield* invoke(() =>
          api.memories.list({
            ...at,
            includeGlobal,
            limit: digestLimit,
          }),
        )
        const generatedAt = new Date().toISOString()
        const items = page.items.map(toDigestItem)
        const groups = MemoryDigestAnalysis.group(items, args.category)
        const report = MemoryDigestAnalysis.report(items, {
          categoryFilter: args.category,
          generatedAt,
          sourceLimit: digestLimit,
        })
        const document = MemoryDigestAnalysis.render(groups, generatedAt)
        const categoryWarning =
          args.category && !knownDigestCategory(args.category)
            ? `未知类别 ${JSON.stringify(args.category.trim())}，已返回空类别；可用类别：${Object.keys(CATEGORY_LABELS).join(", ")}${EOL}`
            : ""

        const writeDocument = (target: string) =>
          Effect.try({
            try: () => {
              const absolute = resolve(target)
              mkdirSync(dirname(absolute), { recursive: true })
              writeFileSync(absolute, document, "utf8")
              return absolute
            },
            catch: (error) =>
              new CliError({
                message: `记忆档案写入失败：${error instanceof Error ? error.message : String(error)}`,
                exitCode: 1,
              }),
          })

        if (args.path !== undefined) {
          if (!args.path.trim()) return yield* fail("--path 必须是非空文件路径。")
          const target = yield* writeDocument(args.path)
          if (args.json) {
            // Preserve the historical --path --json contract: automation gets
            // the resolved output path, while the report remains available
            // from the read-only JSON form without --path.
            process.stdout.write(JSON.stringify({ path: target }, null, 2) + EOL)
          } else {
            process.stdout.write(`记忆档案已写入：${target}${EOL}`)
            if (report.truncated) process.stdout.write(`提示：读取已达到 ${digestLimit} 条上限，档案可能不完整。${EOL}`)
            if (categoryWarning) process.stderr.write(categoryWarning)
          }
          return
        }
        if (args.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + EOL)
          return
        }
        process.stdout.write(`Memory Digest${EOL}${document}${EOL}`)
        const target = yield* writeDocument(defaultDigestPath())
        process.stdout.write(`已同步写入档案文件：${target}${EOL}`)
        if (report.truncated) process.stdout.write(`提示：读取已达到 ${digestLimit} 条上限，档案可能不完整。${EOL}`)
        if (categoryWarning) process.stderr.write(categoryWarning)
        return
      }
      case "conflict": {
        if (values.length > 0) return yield* fail("memory conflict 不接受位置参数；它只读取基准评测和已持久化冲突。")
        if (
          args.query !== undefined ||
          args.type !== undefined ||
          args.tag !== undefined ||
          args.source !== undefined ||
          args.minimumImportance !== undefined ||
          args.topK !== undefined ||
          args.indexLimit !== undefined ||
          args.content !== undefined ||
          args.tags !== undefined ||
          args.importance !== undefined ||
          args.scope !== undefined ||
          args.relatedTo !== undefined ||
          args.strength !== undefined ||
          args.reviewLevel !== undefined ||
          args.category !== undefined ||
          args.path !== undefined ||
          args.digestLimit !== 500 ||
          args.limit !== 100
        )
          return yield* fail("memory conflict 只接受 --workspace、--conflict-limit 和 --json。")
        const conflictLimit = yield* parseBoundedNumber("conflict-limit", args.conflictLimit, 1, 500)
        const persisted = yield* invoke(() =>
          api.memories.conflictList({
            ...at,
            includeClosed: "true",
            limit: conflictLimit,
          }),
        )
        const benchmark = MemoryConflictAnalysis.runBenchmark()
        const report = {
          schema_version: 1,
          execution_mode: "read-only-core-conflict-report" as const,
          benchmark,
          persisted,
          relation_coverage: {
            status: "not_comparable" as const,
            persisted_pairs: persisted.count,
            caveat:
              "Core conflictList 只读取当前工作区已持久化候选；不会在此命令中执行 conflictScan，也不会写入 benchmark 历史或推测人工关系覆盖率。",
          },
        }
        if (args.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + EOL)
          return
        }
        process.stdout.write(`Memory Conflict（只读）${EOL}`)
        process.stdout.write(
          `基准检测：检出率 ${(benchmark.detection_rate * 100).toFixed(2)}% · 误报率 ${(benchmark.false_positive_rate * 100).toFixed(2)}% · 精确率 ${(benchmark.precision * 100).toFixed(2)}%${EOL}`,
        )
        process.stdout.write(
          `已持久化候选：${persisted.count} 条 · detector ${persisted.detectorVersion} · 不会自动扫描或写入${EOL}`,
        )
        for (const item of persisted.items) {
          process.stdout.write(
            `- ${item.conflict.id} · ${item.conflict.conflictKey} · ${item.conflict.status} · ${item.left.id} ↔ ${item.right.id}${EOL}`,
          )
        }
        if (persisted.items.length === 0) process.stdout.write(`当前工作区没有已持久化冲突候选。${EOL}`)
        process.stdout.write(`说明：${report.relation_coverage.caveat}${EOL}`)
        return
      }
      case "create": {
        if (args.content !== undefined && values.length > 0)
          return yield* fail("create 请在位置参数和 --content 中选择一个。")
        const content = (args.content ?? values.join(" ")).trim()
        if (!content) return yield* fail("memory create 需要非空内容。")
        result = yield* invoke(() =>
          api.memories.create({
            ...at,
            content,
            type: args.type,
            tags: tags.length > 0 ? tags : undefined,
            importance,
            source: args.source,
            scope: args.scope,
            relatedTo: args.relatedTo,
            strength,
            reviewLevel,
          }),
        )
        break
      }
      case "update": {
        if (values.length < 1 || !values[0]?.trim()) return yield* fail("memory update 需要一个记忆 ID。")
        if (args.content !== undefined && values.length > 1)
          return yield* fail("update 请在位置参数和 --content 中选择内容来源。")
        const content = args.content ?? (values.length > 1 ? values.slice(1).join(" ") : undefined)
        if (
          content === undefined &&
          args.type === undefined &&
          args.tags === undefined &&
          args.source === undefined &&
          importance === undefined &&
          strength === undefined &&
          reviewLevel === undefined
        ) {
          return yield* fail(
            "memory update 至少需要 --content、--type、--tags、--source、--importance、--strength 或 --review-level。",
          )
        }
        result = yield* invoke(() =>
          api.memories.update({
            ...at,
            memoryID: values[0],
            content: content?.trim() || undefined,
            type: args.type,
            tags: args.tags === undefined ? undefined : tags,
            source: args.source,
            importance,
            strength,
            reviewLevel,
          }),
        )
        break
      }
      default:
        return yield* fail(
          `memory ${action} 仍在迁移：当前 TS CLI 已支持 status/list/search/get/create/update/facets/recall-quality/metrics/write-stats/recovery/digest/conflict；该历史操作尚未开放。`,
          2,
        )
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }

    if (action === "status") {
      const status = result as {
        total: number
        important: number
        workspace: number
        global: number
        quarantined: number
        pendingConflicts: number
        recent: ReadonlyArray<Parameters<typeof printMemory>[0]>
      }
      process.stdout.write(`记忆状态：${status.total} 条（工作区 ${status.workspace}，全局 ${status.global}）${EOL}`)
      process.stdout.write(
        `重要 ${status.important} · 隔离 ${status.quarantined} · 待处理冲突 ${status.pendingConflicts}${EOL}`,
      )
      for (const item of status.recent) process.stdout.write(`- ${printMemory(item)}${EOL}`)
      if (status.recent.length === 0) process.stdout.write(`尚无记忆。${EOL}`)
      return
    }
    if (action === "list") {
      const page = result as { total: number; items: ReadonlyArray<Parameters<typeof printMemory>[0]> }
      process.stdout.write(`记忆列表：${page.total} 条${EOL}`)
      for (const item of page.items) process.stdout.write(`- ${printMemory(item)}${EOL}`)
      if (page.items.length === 0) process.stdout.write(`没有匹配的记忆。${EOL}`)
      return
    }
    if (action === "search") {
      const search = result as {
        algorithm: string
        localOnly: boolean
        embeddingEgress?: "none" | "denied" | "sent" | "unknown"
        embeddingFallback?: "remote-not-authorized" | "remote-failed"
        count: number
        items: ReadonlyArray<{
          memory: Parameters<typeof printMemory>[0]
          score: number
          matchedTerms: ReadonlyArray<string>
        }>
      }
      process.stdout.write(
        `记忆搜索：${search.count} 条 · ${search.algorithm} · 本地 ${search.localOnly ? "是" : "否"} · 外发 ${search.embeddingEgress ?? "unknown"}${search.embeddingFallback ? ` · fallback ${search.embeddingFallback}` : ""}${EOL}`,
      )
      for (const item of search.items)
        process.stdout.write(
          `- ${item.score.toFixed(4)} · ${item.matchedTerms.join(", ")} · ${printMemory(item.memory)}${EOL}`,
        )
      if (search.items.length === 0) process.stdout.write(`没有匹配的记忆。${EOL}`)
      return
    }
    if (action === "facets") {
      const facets = result as Record<string, ReadonlyArray<{ value: string; count: number }>>
      for (const [name, entries] of Object.entries(facets)) {
        process.stdout.write(`${name}：${EOL}`)
        for (const entry of entries) process.stdout.write(`- ${entry.value}: ${entry.count}${EOL}`)
      }
      return
    }
    if (action === "recall-quality") {
      const quality = result as {
        status: string
        sampleSize: number
        top1Rate: number
        meanReciprocalRank: number
        noResultRate: number
        caveat: string
      }
      process.stdout.write(`召回质量：${quality.status} · 样本 ${quality.sampleSize}${EOL}`)
      process.stdout.write(
        `Top-1 ${(quality.top1Rate * 100).toFixed(2)}% · MRR ${quality.meanReciprocalRank.toFixed(4)} · 空结果 ${(quality.noResultRate * 100).toFixed(2)}%${EOL}`,
      )
      process.stdout.write(`说明：${quality.caveat}${EOL}`)
      return
    }
    const item = result as Parameters<typeof printMemory>[0]
    process.stdout.write(`${action === "create" ? "已创建" : "已更新"}记忆：${printMemory(item)}${EOL}`)
  }),
})
