import { createEffect, createMemo, For, on, onCleanup, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import OfficeArchiveWorker from "./office-archive.worker?worker"
import { decodePreviewBytes, type PreviewBytes } from "./document-preview-model"
import { officeFormat } from "./office-format"
import { parseOfficeDocument, officeColumn, type OfficeDocument, type OfficeBlock } from "./office-document"
import type { OfficeParts } from "./office-archive"
import "./office-preview.css"

export function OfficePreview(props: { path: string; content: PreviewBytes & { mimeType?: string } }) {
  const language = useLanguage()
  const t = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const [state, setState] = createStore({ document: undefined as OfficeDocument | undefined, page: 0, loading: true, error: "", attempt: 0, zoom: 1 })
  const page = createMemo(() => state.document?.pages[state.page])
  let viewport!: HTMLDivElement
  const failure = (error: unknown) => error instanceof Error && /limit|too-large/.test(error.message)
    ? t("\u6587\u6863\u8d85\u51fa\u5b89\u5168\u9884\u89c8\u9650\u5236\uff08\u539f\u6587\u4ef6 25 MiB\uff0c\u89e3\u538b\u5185\u5bb9 32 MiB\uff09\u3002", "Document exceeds safe preview limits (25 MiB input, 32 MiB extracted content).")
    : t("\u65e0\u6cd5\u9884\u89c8\u6b64 Office \u6587\u4ef6\uff0c\u5b83\u53ef\u80fd\u5df2\u635f\u574f\u3001\u52a0\u5bc6\u3001\u542b\u5b8f\u6216\u4f7f\u7528\u4e0d\u652f\u6301\u7684\u7ed3\u6784\u3002", "Cannot preview this Office file. It may be damaged, encrypted, macro-enabled or use unsupported structures.")
  createEffect(on(() => [props.path, props.content, state.attempt] as const, () => {
    let alive = true
    let worker: Worker | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    setState({ document: undefined, page: 0, loading: true, error: "" })
    const stop = () => { if (timeout) clearTimeout(timeout); worker?.terminate() }
    try {
      const format = officeFormat(props.path, props.content.mimeType)
      if (!format) throw new Error("office-unsupported-format")
      const bytes = decodePreviewBytes(props.content)
      worker = new OfficeArchiveWorker()
      timeout = setTimeout(() => {
        if (!alive) return
        alive = false
        stop()
        setState({ loading: false, error: t("\u6587\u6863\u89e3\u6790\u8d85\u65f6\uff0c\u8bf7\u4f7f\u7528\u672c\u5730 Office \u5e94\u7528\u6253\u5f00\u3002", "Document parsing timed out. Open it in a local Office application.") })
      }, 15_000)
      worker.onmessage = (event: MessageEvent<{ files?: OfficeParts; error?: string }>) => {
        if (!alive) return
        stop()
        try {
          if (event.data.error || !event.data.files) throw new Error(event.data.error || "office-invalid-archive")
          setState({ document: parseOfficeDocument(event.data.files, format), loading: false })
        } catch (error) { setState({ loading: false, error: failure(error) }) }
      }
      worker.onerror = (event) => {
        event.preventDefault()
        if (!alive) return
        stop()
        setState({ loading: false, error: failure(new Error("office-worker")) })
      }
      worker.postMessage(bytes, [bytes.buffer])
    } catch (error) {
      stop()
      setState({ loading: false, error: failure(error) })
    }
    onCleanup(() => { alive = false; stop() })
  }))
  createEffect(on(() => state.page, () => { if (viewport) viewport.scrollTop = 0 }))
  const Block = (props: { block: OfficeBlock }) => (
    <Switch>
      <Match when={props.block.kind === "paragraph" && props.block}>{(block) => {
        const value = () => block() as Extract<OfficeBlock, { kind: "paragraph" }>
        return <p classList={{ "office-heading": value().heading }}><For each={value().runs}>{(run) =>
          <span style={{ "font-weight": run.bold ? "700" : undefined, "font-style": run.italic ? "italic" : undefined }}>{run.text}</span>
        }</For></p>
      }}</Match>
      <Match when={props.block.kind === "image" && props.block}>{(block) =>
        <img src={(block() as Extract<OfficeBlock, { kind: "image" }>).source} alt={t("\u6587\u6863\u5185\u5d4c\u56fe\u7247", "Embedded document image")} loading="lazy" />
      }</Match>
      <Match when={props.block.kind === "table" && props.block}>{(block) => {
        const value = () => block() as Extract<OfficeBlock, { kind: "table" }>
        return <div class="office-table-scroll" data-scrollable tabIndex={0} role="region" aria-label={t("\u8868\u683c", "Table")}>
          <table>
            <Show when={value().sheet}><thead><tr><th aria-label={t("\u884c", "Row")} /><For each={Array.from({ length: value().columns }, (_, index) => officeColumn(index))}>{(column) => <th scope="col">{column}</th>}</For></tr></thead></Show>
            <tbody><For each={value().rows}>{(row, index) => <tr><Show when={value().sheet}><th scope="row">{index() + 1}</th></Show><For each={row}>{(cell) => <td>{cell}</td>}</For></tr>}</For></tbody>
          </table>
        </div>
      }}</Match>
    </Switch>
  )
  return (
    <section data-component="office-file-preview" data-office-format={state.document?.format} aria-busy={state.loading}>
      <p class="office-notice">{t("\u672c\u5730\u53ea\u8bfb\u5185\u5bb9\u9884\u89c8\uff0c\u4e0d\u4e0a\u4f20\u6587\u4ef6\u3002\u4e0d\u6267\u884c\u5b8f\u3001\u516c\u5f0f\u3001\u5916\u94fe\u6216\u5916\u90e8\u8d44\u6e90\u3002",
        "Local read-only content preview; no uploads. Macros, formulas, links and external resources are not executed.")}</p>
      <p class="office-notice">{t("\u5185\u5bb9\u4f1a\u91cd\u65b0\u6392\u7248\uff0c\u4e0d\u8fd8\u539f\u590d\u6742\u7248\u5f0f\u3001\u9875\u7709\u9875\u811a\u3001\u56fe\u8868\u3001\u6570\u5b57\u683c\u5f0f\u6216\u52a8\u753b\u3002\u4ec5\u663e\u793a\u5185\u5d4c PNG/JPEG \u56fe\u7247\u3002",
        "Content is reflowed, not a page-perfect reproduction. Complex layouts, headers/footers, charts, number formatting and animations are not reproduced. Only embedded PNG/JPEG images are shown.")}</p>
      <Show when={state.document?.format === "xlsx"}><p class="office-notice">{t("\u6bcf\u4e2a\u5de5\u4f5c\u8868\u6700\u591a\u663e\u793a\u524d 200 \u884c\u300150 \u5217\uff1b\u516c\u5f0f\u4ec5\u663e\u793a\u4fdd\u5b58\u7684\u7ed3\u679c\uff0c\u65e0\u7ed3\u679c\u65f6\u663e\u793a\u516c\u5f0f\u6587\u672c\u3002", "Up to the first 200 rows and 50 columns per sheet. Formulas show saved results, or formula text when no result is saved.")}</p></Show>
      <Show when={state.document?.limited}><p role="status" class="office-notice">{t("\u90e8\u5206\u5185\u5bb9\u56e0\u9884\u89c8\u9650\u5236\u5df2\u7701\u7565\uff0c\u8bf7\u7528\u672c\u5730 Office \u67e5\u770b\u5b8c\u6574\u6587\u4ef6\u3002", "Some content was omitted due to preview limits. Use a local Office application for the complete document.")}</p></Show>
      <Show when={state.loading}><p role="status" class="office-notice">{t("\u6b63\u5728\u89e3\u6790 Office \u6587\u6863...", "Reading Office document...")}</p></Show>
      <Show when={state.error}><div data-component="office-preview-error" role="alert" class="office-notice">
        <p>{state.error}</p><button type="button" onClick={() => setState("attempt", state.attempt + 1)}>{t("\u91cd\u8bd5 Office \u9884\u89c8", "Retry Office preview")}</button>
      </div></Show>
      <Show when={state.document}>
        <div class="office-controls" role="group" aria-label={t("Office \u9884\u89c8\u63a7\u5236", "Office preview controls")}>
          <span>{state.document?.format.toUpperCase()}</span>
          <label>{t("缩放", "Zoom")} <select aria-label={t("文档缩放", "Document zoom")} value={state.zoom} onChange={(event) => setState("zoom", Number(event.currentTarget.value))}>
            <For each={[0.5, 0.75, 1, 1.25, 1.5, 2]}>{(zoom) => <option value={zoom}>{Math.round(zoom * 100)}%</option>}</For>
          </select></label>
          <Show when={state.document?.format !== "docx"}>
            <button type="button" disabled={state.page <= 0} onClick={() => setState("page", state.page - 1)}>{t("\u4e0a\u4e00\u9879", "Previous item")}</button>
            <select aria-label={state.document?.format === "xlsx" ? t("\u5de5\u4f5c\u8868", "Worksheet") : t("\u5e7b\u706f\u7247", "Slide")} value={state.page} onChange={(event) => setState("page", Number(event.currentTarget.value))}>
              <For each={state.document?.pages}>{(item, index) => <option value={index()}>{item.label}</option>}</For>
            </select>
            <span>{state.page + 1} / {state.document?.pages.length}</span>
            <button type="button" disabled={state.page >= (state.document?.pages.length ?? 1) - 1} onClick={() => setState("page", state.page + 1)}>{t("\u4e0b\u4e00\u9879", "Next item")}</button>
          </Show>
        </div>
      </Show>
      <Show when={state.document?.format === "pptx"}>
        <nav data-slot="office-slide-outline" aria-label={t("幻灯片内容导航", "Slide content navigation")}>
          <For each={state.document?.pages}>{(item, index) => <button type="button" aria-current={state.page === index() ? "page" : undefined} onClick={() => setState("page", index())}>
            <span>{index() + 1}. {item.label}</span>
            <small>{item.blocks.flatMap((block) => block.kind === "paragraph" ? block.runs.map((run) => run.text) : []).join(" ").slice(0, 160)}</small>
          </button>}</For>
        </nav>
      </Show>
      <div ref={viewport} data-slot="office-preview-viewport" data-scrollable tabIndex={0} role="region" aria-label={t("Office \u6587\u6863\u5185\u5bb9", "Office document content")}>
        <Show when={page()} keyed>{(item) => <article class="office-paper" style={{ zoom: String(state.zoom) }}><For each={item.blocks}>{(block) => <Block block={block} />}</For></article>}</Show>
      </div>
    </section>
  )
}
