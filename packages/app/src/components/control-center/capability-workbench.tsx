import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"
import { useLanguage, type Locale } from "@/context/language"

type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}

const copy = {
  en: {
    diagnostics: "Diagnostics workbench",
    diagnosticsHelp: "Explicit read-only checks. No model call, file mutation, or release approval is performed.",
    multimodal: "Multimodal",
    file: "Image or document path",
    extracted: "Extracted error text (optional)",
    run: "Run diagnosis",
    repo: "Repo Scale",
    repoQuery: "Optional search query",
    scan: "Scan repository",
    quality: "Quality",
    files: "Changed files (one per line)",
    patch: "Patch text (optional)",
    assess: "Assess quality",
    running: "Running…",
    memoryLearning: "Memory and Learning governance",
    createMemory: "Create Memory",
    content: "Memory content",
    tags: "Tags (comma-separated)",
    importance: "Importance (0–5)",
    create: "Create",
    status: "Status",
    total: "Total",
    important: "Important",
    quarantined: "Quarantined",
    preview: "Preview governance",
    apply: "Confirm and quarantine candidates…",
    restore: "Restore source",
    learning: "Learning",
    turns: "Turns",
    successRate: "Success rate",
    patterns: "Patterns",
    undo: "Undo…",
    feedback: "Feedback governance",
    average: "Average rating",
    delete: "Delete…",
    refresh: "Refresh",
    noData: "No data.",
    warningApply: "Apply the previewed governance action? Candidates will be quarantined and remain reversible.",
    warningRestore: "Restore this Memory to its original source?",
    warningUndo:
      "Undo this Learning outcome? Linked patterns will be decremented or deleted when their frequency reaches zero.",
    warningFeedback:
      "Delete this feedback? If it created a Learning outcome, the linked outcome and pattern contribution are also undone.",
    localOnly: "Stored locally",
  },
  zh: {
    diagnostics: "诊断工作台",
    diagnosticsHelp: "仅在明确点击后执行只读检查；不会调用模型、修改文件或生成发布批准。",
    multimodal: "Multimodal",
    file: "图片或文档路径",
    extracted: "已提取的错误文本（可选）",
    run: "运行诊断",
    repo: "Repo Scale",
    repoQuery: "搜索关键词（可选）",
    scan: "扫描仓库",
    quality: "Quality",
    files: "变更文件（每行一个）",
    patch: "Patch 文本（可选）",
    assess: "评估质量",
    running: "正在运行…",
    memoryLearning: "Memory 与 Learning 治理",
    createMemory: "新建 Memory",
    content: "记忆内容",
    tags: "标签（逗号分隔）",
    importance: "重要性（0–5）",
    create: "创建",
    status: "状态",
    total: "总数",
    important: "重要",
    quarantined: "已隔离",
    preview: "预览治理",
    apply: "确认并隔离候选项…",
    restore: "恢复来源",
    learning: "Learning",
    turns: "记录数",
    successRate: "成功率",
    patterns: "模式",
    undo: "撤销…",
    feedback: "Feedback 治理",
    average: "平均评分",
    delete: "删除…",
    refresh: "刷新",
    noData: "暂无数据。",
    warningApply: "应用已预览的治理操作？候选项会被隔离，但仍可恢复。",
    warningRestore: "将这条 Memory 恢复到治理前的原始来源？",
    warningUndo: "撤销这条 Learning 记录？关联模式会递减，频次降为零时会一并删除。",
    warningFeedback: "删除这条 Feedback？若它创建了 Learning 记录，关联记录及模式贡献也会撤销。",
    localOnly: "仅存储在本机",
  },
  zht: {
    diagnostics: "診斷工作台",
    diagnosticsHelp: "僅在明確點擊後執行唯讀檢查；不會呼叫模型、修改檔案或產生發佈批准。",
    multimodal: "Multimodal",
    file: "圖片或文件路徑",
    extracted: "已擷取的錯誤文字（可選）",
    run: "執行診斷",
    repo: "Repo Scale",
    repoQuery: "搜尋關鍵字（可選）",
    scan: "掃描儲存庫",
    quality: "Quality",
    files: "變更檔案（每行一個）",
    patch: "Patch 文字（可選）",
    assess: "評估品質",
    running: "正在執行…",
    memoryLearning: "Memory 與 Learning 治理",
    createMemory: "新增 Memory",
    content: "記憶內容",
    tags: "標籤（逗號分隔）",
    importance: "重要性（0–5）",
    create: "建立",
    status: "狀態",
    total: "總數",
    important: "重要",
    quarantined: "已隔離",
    preview: "預覽治理",
    apply: "確認並隔離候選項…",
    restore: "恢復來源",
    learning: "Learning",
    turns: "記錄數",
    successRate: "成功率",
    patterns: "模式",
    undo: "撤銷…",
    feedback: "Feedback 治理",
    average: "平均評分",
    delete: "刪除…",
    refresh: "重新整理",
    noData: "暫無資料。",
    warningApply: "套用已預覽的治理操作？候選項會被隔離，但仍可恢復。",
    warningRestore: "將這條 Memory 恢復到治理前的原始來源？",
    warningUndo: "撤銷這條 Learning 記錄？關聯模式會遞減，頻次降為零時會一併刪除。",
    warningFeedback: "刪除這條 Feedback？若它建立了 Learning 記錄，關聯記錄及模式貢獻也會撤銷。",
    localOnly: "僅儲存在本機",
  },
} as const

type Copy = (typeof copy)["en"]
const useCopy = () => {
  const language = useLanguage()
  return () => copy[language.locale() as keyof typeof copy] ?? copy.en
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function Result(props: { value: unknown }) {
  return (
    <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-11-regular text-text-weak">
      {JSON.stringify(props.value, null, 2)}
    </pre>
  )
}

export function DiagnosticsWorkbench(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const c = useCopy()
  type Diagnosis = Awaited<ReturnType<OperationsApi["diagnostics"]["diagnose"]>>
  type Repo = Awaited<ReturnType<OperationsApi["agentCapabilities"]["repoScale"]>>["data"]
  type Quality = Awaited<ReturnType<OperationsApi["agentCapabilities"]["qualityAssess"]>>["data"]
  const [state, setState] = createStore({
    loading: "",
    error: "",
    filename: "",
    extractedText: "",
    repoQuery: "",
    qualityFiles: "",
    patchText: "",
    diagnosis: undefined as Diagnosis | undefined,
    repo: undefined as Repo | undefined,
    quality: undefined as Quality | undefined,
  })
  const run = async (kind: string, action: () => Promise<void>) => {
    if (!props.ready() || state.loading) return
    setState({ loading: kind, error: "" })
    try {
      await action()
    } catch (error) {
      setState("error", errorMessage(error))
    } finally {
      setState("loading", "")
    }
  }
  return (
    <section class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4" data-testid="diagnostics-workbench">
      <header>
        <h2 class="text-14-medium text-text-strong">{c().diagnostics}</h2>
        <p class="mt-1 text-12-regular text-text-weak">{c().diagnosticsHelp}</p>
      </header>
      <Show when={state.error}>
        <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
          {state.error}
        </div>
      </Show>
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{c().multimodal}</h3>
          <TextField label={c().file} value={state.filename} onChange={(value) => setState("filename", value)} />
          <textarea
            class="min-h-24 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
            aria-label={c().extracted}
            placeholder={c().extracted}
            value={state.extractedText}
            onInput={(event) => setState("extractedText", event.currentTarget.value)}
          />
          <Button
            size="small"
            variant="secondary"
            disabled={!state.filename.trim() || !!state.loading}
            onClick={() =>
              void run("diagnosis", async () => {
                setState(
                  "diagnosis",
                  await props.api().diagnostics.diagnose({
                    ...props.location(),
                    filename: state.filename.trim(),
                    ...(state.extractedText ? { extractedText: state.extractedText } : {}),
                    limit: 20,
                  }),
                )
              })
            }
          >
            {state.loading === "diagnosis" ? c().running : c().run}
          </Button>
          <Show when={state.diagnosis}>{(value) => <Result value={value()} />}</Show>
        </article>
        <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{c().repo}</h3>
          <TextField
            label={c().repoQuery}
            value={state.repoQuery}
            onChange={(value) => setState("repoQuery", value)}
          />
          <Button
            size="small"
            variant="secondary"
            disabled={!!state.loading}
            onClick={() =>
              void run("repo", async () => {
                const result = await props.api().agentCapabilities.repoScale({
                  ...props.location(),
                  ...(state.repoQuery.trim() ? { query: state.repoQuery.trim() } : {}),
                  maxFiles: 20_000,
                  limit: 30,
                })
                setState("repo", result.data)
              })
            }
          >
            {state.loading === "repo" ? c().running : c().scan}
          </Button>
          <Show when={state.repo}>{(value) => <Result value={value()} />}</Show>
        </article>
        <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{c().quality}</h3>
          <textarea
            class="min-h-20 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
            aria-label={c().files}
            placeholder={c().files}
            value={state.qualityFiles}
            onInput={(event) => setState("qualityFiles", event.currentTarget.value)}
          />
          <textarea
            class="min-h-24 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
            aria-label={c().patch}
            placeholder={c().patch}
            value={state.patchText}
            onInput={(event) => setState("patchText", event.currentTarget.value)}
          />
          <Button
            size="small"
            variant="secondary"
            disabled={!!state.loading}
            onClick={() =>
              void run("quality", async () => {
                const files = state.qualityFiles
                  .split(/\r?\n/)
                  .map((value) => value.trim())
                  .filter(Boolean)
                const result = await props.api().agentCapabilities.qualityAssess({
                  ...props.location(),
                  ...(files.length ? { files } : {}),
                  ...(state.patchText ? { patchText: state.patchText } : {}),
                })
                setState("quality", result.data)
              })
            }
          >
            {state.loading === "quality" ? c().running : c().assess}
          </Button>
          <Show when={state.quality}>{(value) => <Result value={value()} />}</Show>
        </article>
      </div>
    </section>
  )
}

export function MemoryLearningGovernance(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const c = useCopy()
  type MemoryStatus = Awaited<ReturnType<OperationsApi["memories"]["status"]>>
  type Governance = Awaited<ReturnType<OperationsApi["memories"]["governancePreview"]>>
  type Learning = Awaited<ReturnType<OperationsApi["learning"]["status"]>>
  type FeedbackPage = Awaited<ReturnType<OperationsApi["feedback"]["list"]>>
  type FeedbackSummary = Awaited<ReturnType<OperationsApi["feedback"]["summary"]>>
  const [state, setState] = createStore({
    loading: false,
    error: "",
    notice: "",
    content: "",
    tags: "",
    importance: 3,
    memory: undefined as MemoryStatus | undefined,
    governance: undefined as Governance | undefined,
    learning: undefined as Learning | undefined,
    feedback: undefined as FeedbackPage | undefined,
    feedbackSummary: undefined as FeedbackSummary | undefined,
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    setState({ loading: true, error: "" })
    try {
      const [memory, learning, feedback, feedbackSummary] = await Promise.all([
        props.api().memories.status(props.location()),
        props.api().learning.status(props.location()),
        props.api().feedback.list({ ...props.location(), limit: 50 }),
        props.api().feedback.summary(props.location()),
      ])
      setState({ memory, learning, feedback, feedbackSummary })
    } catch (error) {
      setState("error", errorMessage(error))
    } finally {
      setState("loading", false)
    }
  }
  const mutate = async (action: () => Promise<unknown>, notice: string) => {
    if (state.loading) return
    setState({ loading: true, error: "", notice: "" })
    try {
      await action()
      setState("notice", notice)
    } catch (error) {
      setState("error", errorMessage(error))
    } finally {
      setState("loading", false)
    }
    await refresh()
  }
  createEffect(on(() => props.ready(), (ready) => ready && void refresh()))
  const createMemory = () =>
    void mutate(async () => {
      await props.api().memories.create({
        ...props.location(),
        content: state.content.trim(),
        tags: state.tags
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        importance: state.importance,
        source: "user",
        scope: "workspace",
      })
      setState({ content: "", tags: "" })
    }, c().createMemory)
  const preview = async () => {
    setState({ loading: true, error: "" })
    try {
      setState("governance", await props.api().memories.governancePreview({ ...props.location(), sampleLimit: 100 }))
    } catch (error) {
      setState("error", errorMessage(error))
    } finally {
      setState("loading", false)
    }
  }
  const apply = () => {
    if (!state.governance || !window.confirm(c().warningApply)) return
    void mutate(() => props.api().memories.governanceApply(props.location()), c().apply)
  }
  const restore = (item: NonNullable<MemoryStatus>["recent"][number]) => {
    const source = item.source === "quarantined:model" ? "model" : item.source === "quarantined:auto" ? "auto" : undefined
    if (!source || !window.confirm(c().warningRestore)) return
    void mutate(
      () => props.api().memories.update({ ...props.location(), memoryID: item.id, source }),
      c().restore,
    )
  }
  const undo = (outcomeID: NonNullable<Learning>["recent"][number]["id"]) => {
    if (!window.confirm(c().warningUndo)) return
    void mutate(() => props.api().learning.undo({ ...props.location(), outcomeID }), c().undo)
  }
  const removeFeedback = (feedbackID: NonNullable<FeedbackPage>["items"][number]["id"]) => {
    if (!window.confirm(c().warningFeedback)) return
    void mutate(() => props.api().feedback.delete({ ...props.location(), feedbackID }), c().delete)
  }
  return (
    <section class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4" data-testid="memory-learning-governance">
      <header class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-14-medium text-text-strong">{c().memoryLearning}</h2>
          <p class="mt-1 text-11-regular text-text-weak">{c().localOnly}</p>
        </div>
        <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void refresh()}>
          {c().refresh}
        </Button>
      </header>
      <Show when={state.error}>
        <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
          {state.error}
        </div>
      </Show>
      <Show when={state.notice}>
        <div role="status" class="rounded-md border border-border-weak-base p-3 text-12-regular text-text-weak">
          {state.notice}
        </div>
      </Show>
      <div class="grid gap-3 md:grid-cols-3">
        <Metric label={c().total} value={state.memory?.total ?? "—"} />
        <Metric label={c().important} value={state.memory?.important ?? "—"} />
        <Metric label={c().quarantined} value={state.memory?.quarantined ?? "—"} />
      </div>
      <article class="grid gap-3 rounded-md border border-border-weak-base p-3 md:grid-cols-[1fr_220px_auto]">
        <textarea
          class="min-h-24 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
          aria-label={c().content}
          placeholder={c().content}
          value={state.content}
          onInput={(event) => setState("content", event.currentTarget.value)}
        />
        <div class="flex flex-col gap-3">
          <TextField label={c().tags} value={state.tags} onChange={(value) => setState("tags", value)} />
          <label class="text-11-regular text-text-weak">
            {c().importance}
            <input
              class="mt-1 h-9 w-full rounded-md border border-border-weak-base bg-background-base px-3"
              type="number"
              min="0"
              max="5"
              value={state.importance}
              onInput={(event) => setState("importance", Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <Button size="small" variant="secondary" disabled={state.loading || !state.content.trim()} onClick={createMemory}>
          {c().create}
        </Button>
      </article>
      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <div class="flex flex-wrap items-center gap-2">
          <Button size="small" variant="secondary" disabled={state.loading} onClick={() => void preview()}>
            {c().preview}
          </Button>
          <Show when={state.governance}>
            {(value) => (
              <>
                <span class="text-11-regular text-text-weak">
                  {value().candidateCount}/{value().scanned}
                </span>
                <Button
                  size="small"
                  variant="primary"
                  disabled={state.loading || value().candidateCount === 0}
                  onClick={apply}
                >
                  {c().apply}
                </Button>
              </>
            )}
          </Show>
        </div>
        <Show when={state.governance}>
          {(value) => (
            <div class="flex max-h-64 flex-col gap-2 overflow-auto">
              <For each={value().candidates}>
                {(item) => (
                  <div class="rounded-md bg-background-weak p-3 text-11-regular">
                    <div class="text-text-strong">{item.contentPreview}</div>
                    <div class="mt-1 text-text-weak">
                      {item.reason} · {item.source} · {item.id}
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
        <For each={state.memory?.recent.filter((item) => item.source.startsWith("quarantined")) ?? []}>
          {(item) => (
            <div class="flex items-center justify-between gap-3 rounded-md bg-background-weak p-3">
              <div class="min-w-0">
                <div class="truncate text-11-regular text-text-strong">{item.content}</div>
                <div class="text-10-regular text-text-weak">{item.source}</div>
              </div>
              <Button
                size="small"
                variant="ghost"
                disabled={item.source === "quarantined"}
                onClick={() => restore(item)}
              >
                {c().restore}
              </Button>
            </div>
          )}
        </For>
      </article>
      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <h3 class="text-13-medium text-text-strong">{c().learning}</h3>
        <div class="grid gap-3 md:grid-cols-3">
          <Metric label={c().turns} value={state.learning?.totalTurns ?? "—"} />
          <Metric
            label={c().successRate}
            value={state.learning ? `${Math.round(state.learning.successRate * 100)}%` : "—"}
          />
          <Metric label={c().patterns} value={state.learning?.patternCount ?? "—"} />
        </div>
        <Show when={state.learning?.impact.caveat}>
          {(value) => <p class="text-11-regular text-text-weak">{value()}</p>}
        </Show>
        <For each={state.learning?.recent ?? []}>
          {(item) => (
            <div class="flex items-start justify-between gap-3 rounded-md bg-background-weak p-3">
              <div class="min-w-0 text-11-regular">
                <div class="text-text-strong">{item.userInput}</div>
                <div class="mt-1 text-text-weak">
                  {item.success ? "success" : item.errorType || "failed"} · {item.route}
                </div>
              </div>
              <Button size="small" variant="ghost" onClick={() => undo(item.id)}>
                {c().undo}
              </Button>
            </div>
          )}
        </For>
      </article>
      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <h3 class="text-13-medium text-text-strong">{c().feedback}</h3>
        <div class="grid gap-3 md:grid-cols-2">
          <Metric label={c().total} value={state.feedbackSummary?.total ?? "—"} />
          <Metric label={c().average} value={state.feedbackSummary?.averageRating?.toFixed(1) ?? "—"} />
        </div>
        <For each={state.feedback?.items ?? []}>
          {(item) => (
            <div class="flex items-start justify-between gap-3 rounded-md bg-background-weak p-3">
              <div class="min-w-0 text-11-regular">
                <div class="text-text-strong">{item.message}</div>
                <div class="mt-1 text-text-weak">
                  {item.category} · {item.rating}/5
                </div>
              </div>
              <Button size="small" variant="ghost" onClick={() => removeFeedback(item.id)}>
                {c().delete}
              </Button>
            </div>
          )}
        </For>
      </article>
    </section>
  )
}

function Metric(props: { label: string; value: string | number }) {
  return (
    <div class="rounded-md bg-background-weak p-3">
      <div class="text-10-regular text-text-weak">{props.label}</div>
      <div class="mt-1 text-16-medium text-text-strong">{props.value}</div>
    </div>
  )
}

export const capabilityWorkbenchLocales: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "ar",
  "no",
  "br",
  "th",
  "bs",
  "tr",
]
