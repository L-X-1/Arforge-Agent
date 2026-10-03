import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { composeLearningRecall, type LearningRecallReport } from "@arforge-ai/core/analysis/learning-recall"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["status", "record", "undo", "sync-dogfood", "recall", "dream"] as const

const csv = (value?: string) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? []

const parseBoundedInteger = (name: string, value: number | undefined, minimum: number, maximum: number) => {
  if (value === undefined) return Effect.succeed(undefined)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    return fail(`--${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  }
  return Effect.succeed(value)
}

const parseBoundedText = (name: string, value: unknown, maximum: number, required = false) => {
  if (typeof value !== "string") {
    return required ? `${name} 必须是非空文本。` : `${name} 必须是文本。`
  }
  const trimmed = value.trim()
  if (required && !trimmed) return `${name} 必须是非空文本。`
  if (trimmed.length > maximum) return `${name} 最多 ${maximum} 个字符。`
  return undefined
}

const clip = (value: string, maximum = 120) => {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim()
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized
}

type Candidate = {
  readonly task: string
  readonly success: boolean
  readonly timestamp: string
  readonly steps?: number
  readonly toolCalls?: ReadonlyArray<string>
  readonly error?: string
}

type LearningOutcome = {
  readonly id: string
  readonly userInput: string
  readonly success: boolean
  readonly errorType: string
  readonly errorMessage: string
  readonly fixStrategy: string
  readonly regression: boolean
}

type LearningStatus = {
  readonly totalTurns: number
  readonly successfulTurns: number
  readonly failedTurns: number
  readonly successRate: number
  readonly patternCount: number
  readonly fixCount: number
  readonly regressionCount: number
  readonly correctionCount: number
  readonly injectionCount: number
  readonly averageInjectedContextSize: number
  readonly topTags: ReadonlyArray<{ readonly value: string; readonly count: number }>
  readonly recent: ReadonlyArray<LearningOutcome>
  readonly patterns: ReadonlyArray<{
    readonly id: string
    readonly type: string
    readonly description: string
    readonly frequency: number
    readonly confidence: number
    readonly tags: ReadonlyArray<string>
  }>
  readonly impact: {
    readonly status: string
    readonly injectedCount: number
    readonly baselineCount: number
    readonly injectedSuccessRate: number
    readonly baselineSuccessRate: number
    readonly uplift: number
    readonly caveat: string
  }
}

/**
 * TypeScript/Core owner for the behavior-complete Learning product surface.
 * The command deliberately uses the generated HTTP/SDK contract shared by
 * Browser/Desktop; it never opens the legacy Python learning database.
 */
export const LearningCommand = effectCmd({
  command: "learning [action] [value..]",
  describe: "查看并维护工作区学习结果（与 Core/Server 共享）",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "操作；省略时为 status", choices: actions, default: "status" })
      .positional("value", { describe: "操作对应的结果 ID、用户输入或 JSON", type: "string", array: true })
      .option("workspace", {
        describe: "工作区目录，默认为当前目录；请求会绑定到该目录",
        type: "string",
      })
      .option("user-input", { describe: "record 的用户输入（也可使用位置参数）", type: "string" })
      .option("success", {
        describe: "record 结果是否成功；必须显式指定 true 或 false",
        type: "boolean",
        default: undefined,
      })
      .option("intent", { describe: "record 意图分类", type: "string" })
      .option("route", { describe: "record 路由名称", type: "string" })
      .option("tools", { describe: "record 使用的工具，逗号分隔", type: "string" })
      .option("error-type", { describe: "失败分类", type: "string" })
      .option("error-message", { describe: "失败摘要", type: "string" })
      .option("user-feedback", { describe: "用户反馈摘要", type: "string" })
      .option("fix-strategy", { describe: "修复策略摘要", type: "string" })
      .option("regression", { describe: "是否为回归问题", type: "boolean", default: false })
      .option("token-count", { describe: "token 数量", type: "number" })
      .option("response-time-ms", { describe: "响应耗时（毫秒）", type: "number" })
      .option("tags", { describe: "标签，逗号分隔（最多 32 个）", type: "string" })
      .option("importance", { describe: "重要性（0-5）", type: "number" })
      .option("injected-context-size", { describe: "注入上下文字符数", type: "number" })
      .option("candidates", { describe: "sync-dogfood 的 JSON 数组或 {candidates:[]} JSON", type: "string" })
      .option("stdin", { describe: "从 stdin 读取 sync-dogfood JSON", type: "boolean", default: false })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.learning")(function* (args) {
    const action = args.action ?? "status"
    const values = args.value ?? []
    const workspace = resolve(args.workspace ?? process.cwd())
    const api = createOperationsApi(workspace)
    const at = { location: { directory: workspace } }

    const invoke = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) =>
          new CliError({ message: `学习操作失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
      })

    const tokenCount = yield* parseBoundedInteger("token-count", args.tokenCount, 0, 1_000_000_000)
    const responseTimeMs = yield* parseBoundedInteger("response-time-ms", args.responseTimeMs, 0, 86_400_000)
    const importance = yield* parseBoundedInteger("importance", args.importance, 0, 5)
    const injectedContextSize = yield* parseBoundedInteger(
      "injected-context-size",
      args.injectedContextSize,
      0,
      1_000_000,
    )
    const tools = csv(args.tools)
    const tags = csv(args.tags)
    if (tools.length > 100) return yield* fail("--tools 最多包含 100 个工具名。")
    if (tags.length > 32) return yield* fail("--tags 最多包含 32 个标签。")

    let result: unknown
    switch (action) {
      case "dream": {
        if (values.length > 0) return yield* fail("learning dream 不接受额外参数。")
        if (
          args.userInput !== undefined ||
          args.success !== undefined ||
          args.intent !== undefined ||
          args.route !== undefined ||
          args.tools !== undefined ||
          args.errorType !== undefined ||
          args.errorMessage !== undefined ||
          args.userFeedback !== undefined ||
          args.fixStrategy !== undefined ||
          args.regression ||
          args.tokenCount !== undefined ||
          args.responseTimeMs !== undefined ||
          args.tags !== undefined ||
          args.importance !== undefined ||
          args.injectedContextSize !== undefined ||
          args.candidates !== undefined ||
          args.stdin
        )
          return yield* fail("learning dream 只接受 --workspace 和 --json；它不会自动整理或写入学习模式。")
        result = yield* invoke(() => api.learning.dream(at))
        break
      }
      case "status":
        if (values.length > 0) return yield* fail("learning status 不接受额外参数。")
        result = yield* invoke(() => api.learning.status(at))
        break
      case "recall": {
        if (values.length > 0) return yield* fail("learning recall 不接受额外参数；它只读取当前工作区的召回质量。")
        if (
          args.userInput !== undefined ||
          args.success !== undefined ||
          args.intent !== undefined ||
          args.route !== undefined ||
          args.tools !== undefined ||
          args.errorType !== undefined ||
          args.errorMessage !== undefined ||
          args.userFeedback !== undefined ||
          args.fixStrategy !== undefined ||
          args.regression ||
          args.tokenCount !== undefined ||
          args.responseTimeMs !== undefined ||
          args.tags !== undefined ||
          args.importance !== undefined ||
          args.injectedContextSize !== undefined ||
          args.candidates !== undefined ||
          args.stdin
        )
          return yield* fail("learning recall 只接受 --workspace 和 --json；需要写入请使用 learning record。")
        const memory = yield* invoke(() => api.memories.recallQuality(at))
        const learning = yield* invoke(() => api.learning.status(at))
        result = composeLearningRecall(memory, learning)
        break
      }
      case "record": {
        if (args.userInput !== undefined && values.length > 0)
          return yield* fail("record 请在位置参数和 --user-input 中选择一个。")
        const userInput = (args.userInput ?? values.join(" ")).trim()
        const userInputError = parseBoundedText("用户输入", userInput, 500, true)
        if (userInputError) return yield* fail(userInputError)
        if (args.success === undefined) return yield* fail("learning record 必须显式指定 --success true 或 --success false。")
        const textFields = [
          ["--intent", args.intent, 100],
          ["--route", args.route, 100],
          ["--error-type", args.errorType, 100],
          ["--error-message", args.errorMessage, 500],
          ["--user-feedback", args.userFeedback, 500],
          ["--fix-strategy", args.fixStrategy, 500],
        ] as const
        for (const [name, value, maximum] of textFields) {
          const error = value === undefined ? undefined : parseBoundedText(name, value, maximum)
          if (error) return yield* fail(error)
        }
        result = yield* invoke(() =>
          api.learning.record({
            ...at,
            userInput,
            success: args.success!,
            intent: args.intent?.trim() || undefined,
            route: args.route?.trim() || undefined,
            tools: tools.length > 0 ? tools : undefined,
            errorType: args.errorType?.trim() || undefined,
            errorMessage: args.errorMessage?.trim() || undefined,
            userFeedback: args.userFeedback?.trim() || undefined,
            fixStrategy: args.fixStrategy?.trim() || undefined,
            regression: args.regression,
            tokenCount,
            responseTimeMs,
            tags: tags.length > 0 ? tags : undefined,
            importance,
            injectedContextSize,
          }),
        )
        break
      }
      case "undo": {
        if (values.length !== 1 || !values[0]?.trim()) return yield* fail("learning undo 需要一个结果 ID。")
        const outcomeID = values[0].trim()
        if (!outcomeID.startsWith("lout_")) return yield* fail("learning undo 的结果 ID 必须以 lout_ 开头。")
        result = yield* invoke(() => api.learning.undo({ ...at, outcomeID }))
        break
      }
      case "sync-dogfood": {
        if (values.length > 0) return yield* fail("sync-dogfood 请使用 --candidates 或 --stdin，不接受位置参数。")
        if (args.candidates !== undefined && args.stdin) return yield* fail("sync-dogfood 只能选择 --candidates 或 --stdin。")
        const raw = args.stdin
          ? yield* Effect.tryPromise({
              try: () => Bun.stdin.text(),
              catch: () => new CliError({ message: "无法读取 sync-dogfood stdin。", exitCode: 1 }),
            })
          : args.candidates
        if (!raw?.trim()) return yield* fail("sync-dogfood 需要 --candidates JSON 或 --stdin。")

        let decoded: unknown
        try {
          decoded = JSON.parse(raw)
        } catch {
          return yield* fail("sync-dogfood 输入不是合法 JSON。")
        }
        const entries = Array.isArray(decoded)
          ? decoded
          : typeof decoded === "object" && decoded !== null && "candidates" in decoded && Array.isArray(decoded.candidates)
            ? decoded.candidates
            : undefined
        if (!entries) return yield* fail("sync-dogfood JSON 必须是候选数组或 {candidates:[]}。")
        if (entries.length > 1_000) return yield* fail("sync-dogfood 最多同步 1000 个候选。")

        const candidates: Candidate[] = []
        for (const [index, entry] of entries.entries()) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry))
            return yield* fail(`sync-dogfood 候选 #${index + 1} 必须是对象。`)
          const candidate = entry as Record<string, unknown>
          const task = typeof candidate.task === "string" ? candidate.task.trim() : ""
          const timestamp = typeof candidate.timestamp === "string" ? candidate.timestamp.trim() : ""
          const taskError = parseBoundedText(`候选 #${index + 1} task`, task, 500, true)
          if (taskError) return yield* fail(taskError)
          const timestampError = parseBoundedText(`候选 #${index + 1} timestamp`, timestamp, 100, true)
          if (timestampError) return yield* fail(timestampError)
          if (typeof candidate.success !== "boolean") return yield* fail(`候选 #${index + 1} success 必须是布尔值。`)
          const steps = candidate.steps
          if (steps !== undefined && (typeof steps !== "number" || !Number.isInteger(steps) || steps < 0 || steps > 1_000_000))
            return yield* fail(`候选 #${index + 1} steps 必须是 0 到 1000000 之间的整数。`)
          const toolCalls = candidate.toolCalls
          if (
            toolCalls !== undefined &&
            (!Array.isArray(toolCalls) ||
              toolCalls.length > 100 ||
              toolCalls.some((tool) => typeof tool !== "string" || tool.trim().length === 0 || tool.trim().length > 100))
          )
            return yield* fail(`候选 #${index + 1} toolCalls 必须是不超过 100 项的非空短文本数组。`)
          const error = candidate.error
          if (error !== undefined && (typeof error !== "string" || error.trim().length > 500))
            return yield* fail(`候选 #${index + 1} error 最多 500 个字符且必须是文本。`)
          candidates.push({
            task,
            success: candidate.success,
            timestamp,
            steps: steps as number | undefined,
            toolCalls: toolCalls ? (toolCalls as string[]).map((tool) => tool.trim()) : undefined,
            error: typeof error === "string" ? error.trim() || undefined : undefined,
          })
        }
        result = yield* invoke(() => api.learning.syncDogfood({ ...at, candidates }))
        break
      }
      default:
        return yield* fail(
          `learning ${action} 仍在迁移：当前 TS CLI 已支持 status/recall/record/undo/sync-dogfood/dream。`,
          2,
        )
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }

    if (action === "status") {
      const status = result as LearningStatus
      process.stdout.write(
        `学习状态：${status.totalTurns} 次 · 成功 ${status.successfulTurns} · 失败 ${status.failedTurns} · 成功率 ${(status.successRate * 100).toFixed(1)}%${EOL}`,
      )
      process.stdout.write(
        `模式 ${status.patternCount} · 修复 ${status.fixCount} · 回归 ${status.regressionCount} · 纠正 ${status.correctionCount} · 注入 ${status.injectionCount}${EOL}`,
      )
      process.stdout.write(
        `注入影响：${status.impact.status} · 注入 ${status.impact.injectedCount} · 基线 ${status.impact.baselineCount} · uplift ${(status.impact.uplift * 100).toFixed(1)}%${EOL}`,
      )
      for (const pattern of status.patterns.slice(0, 10)) {
        process.stdout.write(
          `- 模式 ${pattern.type} · ${clip(pattern.description)} · x${pattern.frequency} · 置信度 ${(pattern.confidence * 100).toFixed(1)}%${EOL}`,
        )
      }
      return
    }
    if (action === "record") {
      const outcome = result as LearningOutcome
      process.stdout.write(
        `已记录学习结果：${outcome.id} · ${outcome.success ? "成功" : "失败"} · ${clip(outcome.userInput)}${EOL}`,
      )
      return
    }
    if (action === "recall") {
      const recall = result as LearningRecallReport
      process.stdout.write(
        `学习召回质量：Top-1 ${(recall.top1_hit_rate * 100).toFixed(2)}% · MRR ${recall.mean_reciprocal_rank.toFixed(4)} · 样本 ${recall.sample_size}${EOL}`,
      )
      process.stdout.write(
        `学习模式：${recall.pattern_count} · 学习回合：${recall.learning_turns} · 成功率 ${(recall.learning_success_rate * 100).toFixed(2)}%${EOL}`,
      )
      process.stdout.write(`说明：${recall.caveat}${EOL}`)
      return
    }
    if (action === "dream") {
      const payload = result as {
        readonly consolidation: { readonly status: string; readonly reason: string }
        readonly dream: {
          readonly totalTurns: number
          readonly totalFailures: number
          readonly totalPatterns: number
          readonly insights: ReadonlyArray<string>
          readonly suggestions: ReadonlyArray<string>
        }
      }
      process.stdout.write(
        `学习反思（只读）：${payload.dream.totalTurns} 次 · 失败 ${payload.dream.totalFailures} · 模式 ${payload.dream.totalPatterns}${EOL}`,
      )
      process.stdout.write(`模式整理：未执行（${payload.consolidation.reason}）${EOL}`)
      for (const [title, entries] of [
        ["洞察", payload.dream.insights],
        ["建议", payload.dream.suggestions],
      ] as const) {
        if (!entries.length) continue
        process.stdout.write(`${title}：${EOL}`)
        for (const entry of entries) process.stdout.write(`- ${clip(entry)}${EOL}`)
      }
      return
    }
    if (action === "undo") {
      const undone = result as { readonly outcomeID: string; readonly deleted: boolean; readonly linkedPatterns: ReadonlyArray<{ readonly patternID: string; readonly action: string }> }
      process.stdout.write(`${undone.deleted ? "已撤销" : "未找到"}学习结果：${undone.outcomeID}${EOL}`)
      for (const pattern of undone.linkedPatterns) process.stdout.write(`- 关联模式 ${pattern.patternID}：${pattern.action}${EOL}`)
      return
    }
    const sync = result as { readonly seen: number; readonly imported: number; readonly skipped: number; readonly failedCandidates: number }
    process.stdout.write(
      `dogfood 学习同步：看到 ${sync.seen} · 导入 ${sync.imported} · 跳过 ${sync.skipped} · 失败 ${sync.failedCandidates}${EOL}`,
    )
  }),
})
