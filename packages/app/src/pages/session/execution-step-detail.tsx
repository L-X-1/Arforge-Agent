import { createEffect, createMemo, Index, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { executionStepText, type ExecutionTraceStep } from "./execution-trace-model"
import { executionContentPreview } from "./execution-content-preview"

export function ExecutionStepDetail(props: {
  step: ExecutionTraceStep
  chinese: boolean
  focusTool?: string
  directory?: string
}) {
  const [state, setState] = createStore({ expanded: {} as Record<string, boolean>, copying: false, copied: false, error: "" })
  const identity = createMemo(() => props.step.id)
  const t = (zh: string, en: string) => props.chinese ? zh : en
  let generation = 0
  let title: HTMLHeadingElement | undefined
  createEffect(on(identity, () => { generation++; setState({ expanded: {}, copied: false, copying: false, error: "" }) }))
  createEffect(() => {
    if (props.focusTool !== props.step.id) return
    const frame = requestAnimationFrame(() => {
      if (title?.isConnected) title.focus()
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  onCleanup(() => generation++)
  const sections = createMemo(() => props.step.sections?.length ? props.step.sections : [{ kind: "detail" as const, source: props.step.id, content: executionStepText(props.step) }])
  const copy = async () => {
    const current = generation
    setState({ copying: true, error: "", copied: false })
    try {
      await navigator.clipboard.writeText(executionStepText(props.step))
      if (generation === current) setState("copied", true)
    } catch (error) {
      if (generation === current) setState("error", error instanceof Error ? error.message : String(error))
    } finally { if (generation === current) setState("copying", false) }
  }
  const heading = (kind: "input" | "output" | "error" | "detail") => ({
    input: t("输入", "Input"), output: t("输出", "Output"), error: t("错误", "Error"), detail: t("详情", "Details"),
  })[kind]
  const tool = () => props.step.tools?.length === 1 ? props.step.tools[0] : undefined
  const workdir = () => {
    const selected = tool()
    if (props.step.kind !== "command" || !selected) return
    const input = selected.state.input.workdir
    if (typeof input === "string" && input) return { path: input, source: "tool-input" }
    if (input === undefined && props.directory) return { path: props.directory, source: "execution-source" }
  }
  return <section class="execution-detail-pane" aria-label={t("执行步骤详情", "Execution step details")}
    data-execution-tool={tool()?.callID} data-execution-message={tool()?.messageID}>
    <header><h3 ref={title} tabIndex={-1}>{props.step.title || t("步骤详情", "Step details")}</h3>
      <button type="button" disabled={state.copying} onClick={() => void copy()}>{state.copied ? t("已复制", "Copied") : t("复制完整内容", "Copy full content")}</button>
    </header>
    <Show when={workdir()}>{(value) => (
      <p class="execution-detail-preview" data-component="execution-working-directory" data-workdir-source={value().source}>
        {value().source === "tool-input" ? t("请求的工作目录", "Requested working directory") : t("工作目录", "Working directory")}
        {" · "}<code>{value().path}</code>
      </p>
    )}</Show>
    <Show when={props.step.preview}><p class="execution-detail-preview">{props.step.preview}</p></Show>
    <Show when={state.error}><p role="alert">{state.error}</p></Show>
    <Index each={sections()}>{(section, index) => {
      const key = () => section().source + ":" + section().kind + ":" + index
      const expanded = () => state.expanded[key()]
      const preview = createMemo(() => executionContentPreview(section().content, !!expanded()))
      return <section>
        <h4>{heading(section().kind)} <span title={section().source}>{section().source}</span></h4>
        <pre tabIndex={0} aria-label={heading(section().kind)}>{preview().text}</pre>
        <Show when={preview().collapsible}>
          <div class="execution-detail-disclosure">
            <span role="status">1–{preview().shownLines} / {preview().totalLines} {t("行", "lines")}</span>
            <button type="button" aria-expanded={!!expanded()} onClick={() => setState("expanded", key(), !expanded())}>
              {expanded() ? t("收起长内容", "Collapse long content") : t("显示完整内容", "Show full content")}
            </button>
          </div>
        </Show>
      </section>
    }}</Index>
  </section>
}
