import { Effect } from "effect"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { createOperationsApi, operationsErrorMessage } from "../operations-api"

const actions = ["summary", "list", "submit", "delete"] as const
const categories = ["bug", "feature", "experience", "other"] as const
type Category = (typeof categories)[number]

const isCategory = (value: string): value is Category =>
  (categories as readonly string[]).includes(value)

const normalizeCategory = (value: unknown, field = "category") => {
  if (typeof value !== "string" || !isCategory(value.trim().toLowerCase())) {
    return `${field} 必须是 bug、feature、experience 或 other。`
  }
  return undefined
}

const categoryValue = (value: unknown): Category | undefined => {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  return isCategory(normalized) ? normalized : undefined
}

const parseRating = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    return { error: "rating 必须是 1 到 5 之间的整数。" as const }
  }
  return { value: parsed }
}

const validateMessage = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return "message 必须是非空文本。"
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    return "message 不得包含控制字符。"
  if (value.trim().length > 2_000) return "message 最多 2000 个字符。"
  return undefined
}

const validateSessionID = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128)
    return "--session-id 必须是 1 到 128 个字符的非空文本。"
  return undefined
}

const invoke = <A>(operation: () => Promise<A>, label: string): Effect.Effect<A, CliError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => new CliError({ message: `${label}失败：${operationsErrorMessage(error)}`, exitCode: 1 }),
  })

/**
 * TypeScript/Core owner for the explicit local product-feedback surface.
 *
 * The command deliberately calls the generated HTTP/SDK contract used by the
 * Desktop app. It never opens the historical Python feedback.db, so a Python
 * invocation and a direct TS invocation share the same workspace-scoped
 * records, redaction behavior, and Learning linkage.
 */
export const FeedbackCommand = effectCmd({
  command: "feedback [action] [value..]",
  describe: "提交、查看和删除工作区产品反馈（与 Core/Server 共享）",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "操作；省略时为 summary", choices: actions, default: "summary" })
      .positional("value", { describe: "操作对应的类别、反馈 ID 或提交内容", type: "string", array: true })
      .option("workspace", {
        describe: "工作区目录，默认为当前目录；反馈只在该目录范围内可见",
        type: "string",
      })
      .option("category", { describe: "反馈类别：bug、feature、experience、other", choices: categories })
      .option("rating", { describe: "评分（1-5）", type: "number" })
      .option("message", { describe: "反馈内容（最多 2000 个字符）", type: "string" })
      .option("session-id", { describe: "可选的工作区会话 ID", type: "string" })
      .option("feedback-id", { describe: "delete 的反馈 ID（也可用位置参数）", type: "string" })
      .option("limit", { describe: "list 返回条数（1-100）", type: "number", default: 50 })
      .option("json", { describe: "输出机器可读 JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.feedback")(function* (args) {
    const action = args.action ?? "summary"
    const values = args.value ?? []
    const workspace = resolve(args.workspace ?? process.cwd())
    const api = createOperationsApi(workspace)

    if (action === "summary") {
      if (values.length > 0) return yield* fail("feedback summary 不接受额外参数。")
      if (args.category !== undefined || args.rating !== undefined || args.message !== undefined || args.sessionId !== undefined || args.feedbackId !== undefined)
        return yield* fail("feedback summary 只需要 --workspace 和 --json 等输出选项。")
    }

    let result: unknown
    switch (action) {
      case "summary":
        result = yield* invoke(() => api.feedback.summary({ location: { directory: workspace } }), "反馈摘要")
        break
      case "list": {
        if (values.length > 1) return yield* fail("feedback list 最多接受一个类别位置参数。")
        if (values.length > 0 && args.category !== undefined) return yield* fail("list 请在位置参数和 --category 中选择一个。")
        const categoryInput = args.category ?? values[0]
        const categoryError = categoryInput === undefined ? undefined : normalizeCategory(categoryInput)
        if (categoryError) return yield* fail(categoryError)
        if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)
          return yield* fail("--limit 必须是 1 到 100 之间的整数。")
        if (args.rating !== undefined || args.message !== undefined || args.sessionId !== undefined || args.feedbackId !== undefined)
          return yield* fail("feedback list 只接受类别、--limit、--workspace 和 --json。")
        result = yield* invoke(
          () =>
            api.feedback.list({
              location: { directory: workspace },
              limit: args.limit,
              category: categoryInput === undefined ? undefined : categoryValue(categoryInput),
            }),
          "反馈列表",
        )
        break
      }
      case "submit": {
        if (values.length > 0 && (args.category !== undefined || args.rating !== undefined || args.message !== undefined))
          return yield* fail("submit 请在位置参数（类别 评分 内容）和 --category/--rating/--message 中选择一组。")
        if (args.feedbackId !== undefined) return yield* fail("feedback submit 不接受 --feedback-id。")
        if (values.length > 0 && values.length < 3) return yield* fail("feedback submit 需要类别、评分和反馈内容。")
        const categoryInput = args.category ?? values[0]
        const ratingInput = args.rating ?? values[1]
        const messageInput = args.message ?? (values.length >= 3 ? values.slice(2).join(" ") : undefined)
        const categoryError = normalizeCategory(categoryInput)
        if (categoryError) return yield* fail(categoryError)
        const rating = parseRating(ratingInput)
        if (rating.error) return yield* fail(rating.error)
        const messageError = validateMessage(messageInput)
        if (messageError) return yield* fail(messageError)
        const sessionError = validateSessionID(args.sessionId)
        if (sessionError) return yield* fail(sessionError)
        result = yield* invoke(
          () =>
            api.feedback.submit({
              location: { directory: workspace },
              category: categoryValue(categoryInput)!,
              rating: rating.value!,
              message: messageInput!.trim(),
              sessionID: args.sessionId?.trim() || undefined,
            }),
          "提交反馈",
        )
        break
      }
      case "delete": {
        if (args.feedbackId !== undefined && values.length > 0) return yield* fail("delete 请在位置参数和 --feedback-id 中选择一个。")
        const feedbackID = (args.feedbackId ?? values[0])?.trim()
        if (values.length > 1 || !feedbackID) return yield* fail("feedback delete 需要一个反馈 ID。")
        if (!feedbackID.startsWith("fdb_"))
          return yield* fail("反馈 ID 必须以 fdb_ 开头；旧 Python UUID 记录不属于共享 TS/Core 数据库。")
        if (args.category !== undefined || args.rating !== undefined || args.message !== undefined || args.sessionId !== undefined || args.limit !== 50)
          return yield* fail("feedback delete 只接受反馈 ID、--workspace 和 --json。")
        result = yield* invoke(
          () => api.feedback.delete({ location: { directory: workspace }, feedbackID }),
          "删除反馈",
        )
        break
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      return
    }

    if (action === "summary") {
      const summary = result as {
        readonly total: number
        readonly averageRating?: number
        readonly byCategory: ReadonlyArray<{ readonly category: Category; readonly count: number }>
      }
      process.stdout.write(
        `反馈摘要：${summary.total} 条 · 平均评分 ${summary.averageRating === undefined ? "暂无" : summary.averageRating.toFixed(2)}${EOL}`,
      )
      for (const item of summary.byCategory) process.stdout.write(`- ${item.category}: ${item.count}${EOL}`)
      if (summary.total === 0) process.stdout.write(`尚无反馈。${EOL}`)
      return
    }
    if (action === "list") {
      const page = result as {
        readonly total: number
        readonly count: number
        readonly items: ReadonlyArray<{ readonly id: string; readonly category: Category; readonly rating: number; readonly message: string }>
      }
      process.stdout.write(`反馈列表：${page.total} 条（返回 ${page.count} 条）${EOL}`)
      for (const item of page.items) process.stdout.write(`- ${item.id} · [${item.category}] ${item.rating}/5 · ${item.message}${EOL}`)
      if (page.items.length === 0) process.stdout.write(`没有匹配的反馈。${EOL}`)
      return
    }
    if (action === "submit") {
      const feedback = (result as { readonly feedback: { readonly id: string; readonly category: Category; readonly rating: number; readonly message: string } }).feedback
      process.stdout.write(`已保存反馈：${feedback.id} · [${feedback.category}] ${feedback.rating}/5 · ${feedback.message}${EOL}`)
      return
    }
    const deleted = result as { readonly feedbackID: string; readonly deleted: boolean; readonly status: "deleted" | "not_found" }
    process.stdout.write(`${deleted.deleted ? "已删除" : "未找到"}反馈：${deleted.feedbackID}${EOL}`)
  }),
})
