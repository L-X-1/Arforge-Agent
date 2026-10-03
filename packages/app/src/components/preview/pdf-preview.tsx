import { createEffect, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { AnnotationMode, getDocument, PDFWorker, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist"
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { useLanguage } from "@/context/language"
import { decodePdfBytes, pdfCanvasScale, type PreviewBytes } from "./document-preview-model"
import { pdfAssetFactory } from "./pdf-assets"
import { findPdfPages } from "./pdf-search"
import "./pdf-preview.css"

export function PdfPreview(props: { path: string; content: PreviewBytes }) {
  const language = useLanguage()
  const t = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const [state, setState] = createStore({
    document: undefined as PDFDocumentProxy | undefined,
    page: 1, pages: 0, zoom: 0, width: 600, attempt: 0,
    loading: true, rendering: false, error: "", text: "",
    query: "", searching: false, matches: [] as number[], match: 0, searchError: "", searchAttempt: 0,
  })
  let viewport!: HTMLDivElement
  let surface!: HTMLDivElement
  const errorMessage = (error: unknown) => {
    if (error instanceof Error && error.message === "document-too-large") {
      return t("PDF \u9884\u89c8\u9650\u5236\u4e3a 25 MiB\uff0c\u8bf7\u4f7f\u7528\u672c\u5730\u9605\u8bfb\u5668\u6253\u5f00\u5927\u6587\u4ef6\u3002", "PDF preview is limited to 25 MiB. Use a local reader for larger files.")
    }
    if (error instanceof Error && error.name === "PasswordException") {
      return t("\u6b64 PDF \u9700\u8981\u5bc6\u7801\uff0c\u8bf7\u4f7f\u7528\u672c\u5730\u9605\u8bfb\u5668\u89e3\u9501\u3002", "This PDF requires a password. Unlock it with a local reader.")
    }
    return t("\u65e0\u6cd5\u9884\u89c8\u6b64 PDF\uff0c\u6587\u4ef6\u53ef\u80fd\u5df2\u635f\u574f\u6216\u8d85\u51fa\u652f\u6301\u8303\u56f4\u3002\u53ef\u91cd\u8bd5\u6216\u5237\u65b0\u6587\u4ef6\u3002",
      "This PDF could not be previewed. It may be damaged or unsupported. Retry or refresh the file.")
  }

  onMount(() => {
    const resize = new ResizeObserver(() => {
      const width = Math.max(160, Math.floor(viewport.clientWidth - 32))
      if (width !== state.width) setState("width", width)
    })
    resize.observe(viewport)
    onCleanup(() => resize.disconnect())
  })

  createEffect(on(() => [props.path, props.content, state.attempt] as const, () => {
    let alive = true
    let task: PDFDocumentLoadingTask | undefined
    let worker: PDFWorker | undefined
    let port: Worker | undefined
    const controller = new AbortController()
    setState({ document: undefined, pages: 0, page: 1, loading: true, error: "", text: "" })
    const timeout = setTimeout(() => {
      if (!alive) return
      setState({ loading: false, error: t("PDF \u52a0\u8f7d\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5\u3002", "PDF loading timed out. Please retry.") })
      alive = false
      controller.abort()
      void task?.destroy().catch(() => undefined)
      worker?.destroy()
      port?.terminate()
    }, 20_000)
    void (async () => {
      try {
        const data = decodePdfBytes(props.content)
        port = new Worker(new URL(workerURL, window.location.href), { type: "module" })
        worker = PDFWorker.create({ port })
        task = getDocument({
          data, worker, useWorkerFetch: false, BinaryDataFactory: pdfAssetFactory(controller.signal),
          enableXfa: false, stopAtErrors: true, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 64_000_000,
        })
        const document = await task.promise
        if (!alive) return
        setState({ document, pages: document.numPages, loading: false })
      } catch (error) {
        if (alive) setState({ loading: false, error: errorMessage(error) })
      } finally {
        clearTimeout(timeout)
      }
    })()
    onCleanup(() => {
      alive = false
      clearTimeout(timeout)
      controller.abort()
      void task?.destroy().catch(() => undefined)
      worker?.destroy()
      port?.terminate()
    })
  }))

  createEffect(on(() => [state.document, state.page, state.zoom, state.width] as const, ([document, pageNumber, zoom, width]) => {
    if (!document) { surface.replaceChildren(); return }
    let alive = true
    let page: PDFPageProxy | undefined
    let render: RenderTask | undefined
    const canvas = window.document.createElement("canvas")
    canvas.setAttribute("role", "img")
    canvas.setAttribute("aria-label", props.path + " - " + pageNumber)
    setState({ rendering: true, error: "", text: "" })
    surface.replaceChildren()
    void (async () => {
      try {
        page = await document.getPage(pageNumber)
        if (!alive) return
        const original = page.getViewport({ scale: 1 })
        const { scale, outputScale } = pdfCanvasScale(original.width, original.height, zoom || width / original.width, window.devicePixelRatio || 1)
        const view = page.getViewport({ scale })
        canvas.width = Math.max(1, Math.floor(view.width * outputScale))
        canvas.height = Math.max(1, Math.floor(view.height * outputScale))
        canvas.style.width = view.width + "px"
        canvas.style.height = view.height + "px"
        render = page.render({
          canvas, viewport: view, transform: [outputScale, 0, 0, outputScale, 0, 0],
          annotationMode: AnnotationMode.DISABLE,
        })
        await render.promise
        if (!alive) return
        surface.replaceChildren(canvas)
        const text = await page.getTextContent()
        if (!alive) return
        setState("text", text.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").slice(0, 200_000))
      } catch (error) {
        if (alive) setState("error", errorMessage(error))
      } finally {
        if (alive) setState("rendering", false)
        page?.cleanup()
      }
    })()
    onCleanup(() => {
      alive = false
      render?.cancel()
      canvas.remove()
    })
  }))

  createEffect(on(() => [state.document, state.query, state.searchAttempt] as const, ([document, query]) => {
    let alive = true
    setState({ matches: [], match: 0, searchError: "", searching: !!document && !!query.trim() })
    const timer = setTimeout(() => {
      if (!document || !query.trim()) return
      void findPdfPages({
        pages: document.numPages, query, current: () => alive,
        read: async (number) => {
          const page = await document.getPage(number)
          const text = await page.getTextContent()
          return text.items.map((item) => "str" in item ? item.str : "").join(" ")
        },
      }).then((matches) => {
        if (!alive || !matches) return
        setState({ matches, searching: false })
        if (matches.length) setState("page", matches[0]!)
      }).catch((error) => {
        if (alive) setState({ searching: false, searchError: errorMessage(error) })
      })
    }, 200)
    onCleanup(() => { alive = false; clearTimeout(timer) })
  }))
  const nextMatch = (direction: number) => {
    if (!state.matches.length) return
    const index = (state.match + direction + state.matches.length) % state.matches.length
    setState({ match: index, page: state.matches[index]! })
  }
  const busy = () => state.loading || state.rendering
  return (
    <section data-component="pdf-file-preview" aria-busy={busy()}>
      <p data-slot="pdf-preview-notice">{t("\u672c\u5730\u53ea\u8bfb PDF \u9884\u89c8\u3002\u4e0d\u6267\u884c\u6587\u6863\u811a\u672c\u3001\u8868\u5355\u6216\u5916\u90e8\u94fe\u63a5\uff0c\u4e0d\u4fee\u6539\u539f\u6587\u4ef6\u3002",
        "Local read-only PDF preview. Document scripts, forms and external links are not executed. The original file is unchanged.")}</p>
      <div data-slot="pdf-preview-controls" role="group" aria-label={t("PDF \u9884\u89c8\u63a7\u5236", "PDF preview controls")}>
        <button type="button" disabled={!state.document || state.page <= 1} onClick={() => setState("page", state.page - 1)}>{t("\u4e0a\u4e00\u9875", "Previous page")}</button>
        <label>{t("\u9875\u7801", "Page")} <input type="number" aria-label={t("\u9875\u7801", "Page")} min={1} max={state.pages || 1} value={state.page} disabled={!state.document}
          onChange={(event) => {
            const page = event.currentTarget.valueAsNumber
            if (Number.isInteger(page) && page >= 1 && page <= state.pages) setState("page", page)
            else event.currentTarget.value = String(state.page)
          }} /></label>
        <span data-slot="pdf-page-count">/ {state.pages}</span>
        <button type="button" disabled={!state.document || state.page >= state.pages} onClick={() => setState("page", state.page + 1)}>{t("\u4e0b\u4e00\u9875", "Next page")}</button>
        <label>{t("\u7f29\u653e", "Zoom")} <select aria-label={t("\u7f29\u653e", "Zoom")} value={state.zoom} disabled={!state.document} onChange={(event) => setState("zoom", Number(event.currentTarget.value))}>
          <option value={0}>{t("\u9002\u5e94\u5bbd\u5ea6", "Fit width")}</option>
          <option value={0.5}>50%</option><option value={0.75}>75%</option><option value={1}>100%</option>
          <option value={1.5}>150%</option><option value={2}>200%</option><option value={3}>300%</option>
        </select></label>
      </div>
      <div data-slot="pdf-search" role="search">
        <input type="search" aria-label={t("在 PDF 中查找", "Find in PDF")} placeholder={t("查找文档文字", "Find document text")}
          value={state.query} disabled={!state.document} onInput={(event) => setState("query", event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1) } }} />
        <button type="button" disabled={!state.matches.length} onClick={() => nextMatch(-1)}>{t("上一结果页", "Previous matching page")}</button>
        <button type="button" disabled={!state.matches.length} onClick={() => nextMatch(1)}>{t("下一结果页", "Next matching page")}</button>
        <Show when={state.query.trim()}><p role="status">{state.searching ? t("正在查找…", "Searching...") : state.searchError ? "" : state.matches.length ? `${state.match + 1} / ${state.matches.length} ${t("个匹配页面", "matching pages")}` : t("没有匹配的文字；扫描图片可能没有文本层。", "No matching text. Scanned pages may have no text layer.")}</p></Show>
        <Show when={state.searchError}><p role="alert">{state.searchError} <button type="button" onClick={() => setState("searchAttempt", state.searchAttempt + 1)}>{t("重试查找", "Retry search")}</button></p></Show>
      </div>
      <Show when={busy()}><p role="status">{t("\u6b63\u5728\u6e32\u67d3 PDF...", "Rendering PDF...")}</p></Show>
      <Show when={state.error}><div role="alert" data-component="pdf-preview-error">
        <p>{state.error}</p>
        <button type="button" onClick={() => setState("attempt", state.attempt + 1)}>{t("\u91cd\u8bd5 PDF \u9884\u89c8", "Retry PDF preview")}</button>
      </div></Show>
      <div ref={viewport} data-slot="pdf-preview-viewport" data-scrollable tabIndex={0} role="region" aria-label={t("PDF \u9875\u9762", "PDF page")}>
        <div ref={surface} data-slot="pdf-preview-surface" />
      </div>
      <Show when={state.document && !busy() && !state.error}><details data-slot="pdf-page-text">
        <summary>{t("\u5f53\u524d\u9875\u6587\u5b57", "Current page text")}</summary>
        <pre>{state.text || t("\u6b64\u9875\u6ca1\u6709\u53ef\u63d0\u53d6\u7684\u6587\u5b57\uff08\u4f8b\u5982\u626b\u63cf\u56fe\u7247\uff09\u3002", "This page has no extractable text (for example, a scanned image).")}</pre>
      </details></Show>
    </section>
  )
}
