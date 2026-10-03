import { createEffect, createMemo, Index, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { executionStepText, type ExecutionTraceStep } from "./execution-trace-model"

export function ExecutionStepDetail(props: { step: ExecutionTraceStep; chinese: boolean }) {
  const [state, setState] = createStore({ expanded: {} as Record<string, boolean>, copying: false, copied: false, error: "" })
  const identity = createMemo(() => props.step.id)
  const t = (zh: string, en: string) => props.chinese ? zh : en
  let generation = 0
  createEffect(on(identity, () => { generation++; setState({ expanded: {}, copied: false, copying: false, error: "" }) }))
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
  return <section class="execution-detail-pane" aria-label={t("执行步骤详情", "Execution step details")}>
    <header><h3>{props.step.title || t("步骤详情", "Step details")}</h3>
      <button type="button" disabled={state.copying} onClick={() => void copy()}>{state.copied ? t("已复制", "Copied") : t("复制完整内容", "Copy full content")}</button>
    </header>
    <Show when={state.error}><p role="alert">{state.error}</p></Show>
    <Index each={sections()}>{(section, index) => {
      const key = () => section().source + ":" + section().kind + ":" + index
      const expanded = () => state.expanded[key()]
      return <section>
        <h4>{heading(section().kind)} <span title={section().source}>{section().source}</span></h4>
        <pre tabIndex={0} aria-label={heading(section().kind)}>{expanded() ? section().content : section().content.slice(0, 12000)}</pre>
        <Show when={section().content.length > 12000}>
          <button type="button" aria-expanded={!!expanded()} onClick={() => setState("expanded", key(), !expanded())}>
            {expanded() ? t("收起长内容", "Collapse long content") : t("显示完整内容", "Show full content")} ({section().content.length.toLocaleString()})
          </button>
        </Show>
      </section>
    }}</Index>
  </section>
}
