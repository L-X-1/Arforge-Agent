import { createEffect, createMemo, ErrorBoundary, lazy, Match, on, onCleanup, Show, Suspense, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useFile } from "@/context/file"
import type { FileState } from "@/context/file/types"
import { previewRegistry } from "./registry"
import { FilePreviewActions } from "./file-preview-actions"
import "./markdown-split.css"
import "./workbench-review.css"

const MarkdownPreview = lazy(() => import("./markdown-preview").then((module) => ({ default: module.MarkdownPreview })))
const HtmlPreview = lazy(() => import("./html-preview").then((module) => ({ default: module.HtmlPreview })))
const PdfPreview = lazy(() => import("./pdf-preview").then((module) => ({ default: module.PdfPreview })))
const OfficePreview = lazy(() => import("./office-preview").then((module) => ({ default: module.OfficePreview })))
const VideoPreview = lazy(() => import("./video-preview").then((module) => ({ default: module.VideoPreview })))

export function FilePreview(props: {
  path: string
  version: string | number | undefined
  state?: FileState
  onRetry: () => Promise<void>
  render: (source: string) => JSX.Element
}) {
  const language = useLanguage()
  const file = useFile()
  const labels = createMemo(() => language.locale().startsWith("zh") ? {
    source: "\u6e90\u7801\u53ea\u8bfb",
    sourceTab: "\u6e90\u7801",
    previewTab: "\u9884\u89c8",
    splitTab: "\u5206\u5c4f",
    split: "\u6e90\u7801\u4e0e\u9884\u89c8\u53ea\u8bfb",
    mode: "\u6587\u4ef6\u663e\u793a\u6a21\u5f0f",
    preview: "\u53ea\u8bfb\u9884\u89c8",
    unavailable: "\u6682\u4e0d\u652f\u6301\u9884\u89c8",
    unsupported: "\u6b64\u683c\u5f0f\u7684\u9884\u89c8\u5668\u5c1a\u672a\u63a5\u5165\uff0c\u539f\u6587\u4ef6\u672a\u6539\u52a8\u3002\u53ef\u4f7f\u7528\u7cfb\u7edf\u9ed8\u8ba4\u5e94\u7528\u6253\u5f00\u3002",
    failed: "\u6587\u4ef6\u9884\u89c8\u5931\u8d25",
    retry: "\u91cd\u8bd5",
    refresh: "\u5237\u65b0\u9884\u89c8",
    empty: "\u672a\u8bfb\u53d6\u5230\u6587\u4ef6\u5185\u5bb9\uff0c\u8bf7\u91cd\u8bd5\u3002",
  } : {
    source: "Read-only source", preview: "Read-only preview", unavailable: "Preview unavailable",
    sourceTab: "Source", previewTab: "Preview", mode: "File display mode",
    splitTab: "Split", split: "Read-only source and preview",
    unsupported: "A preview adapter for this format is not connected yet. The original file is unchanged. You can open it with its default application.",
    failed: "File preview failed", retry: "Retry", refresh: "Refresh preview", empty: "No file content was returned. Please retry.",
  })
  const descriptor = createMemo(() => previewRegistry.resolve(props.path, props.state?.content))
  const richPreview = () => (descriptor().kind === "markdown" || descriptor().kind === "html") && descriptor().capabilities.preview
  const [status, setStatus] = createStore({ retrying: false, error: "" })
  const mode = () => file.ready() ? file.previewMode(props.path) : "source"
  let request = 0
  createEffect(on(() => props.path, () => {
    request++
    setStatus({ retrying: false, error: "" })
  }))
  onCleanup(() => request++)

  const retry = async (reset?: () => void) => {
    if (status.retrying || props.state?.loading) return
    const current = ++request
    setStatus({ retrying: true, error: "" })
    try {
      await props.onRetry()
      if (current === request) reset?.()
    } catch (error) {
      if (current === request) setStatus("error", error instanceof Error ? error.message : labels().failed)
    } finally {
      if (current === request) setStatus("retrying", false)
    }
  }
  const busy = () => status.retrying || !!props.state?.loading
  const renderRichPreview = () => (
    <Suspense fallback={<div role="status" class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
      <Show when={descriptor().kind === "html"} fallback={<MarkdownPreview text={props.state?.content?.content ?? ""} />}>
        <HtmlPreview path={props.path} text={props.state?.content?.content ?? ""} />
      </Show>
    </Suspense>
  )
  const buttonClass = "shrink-0 rounded-md border border-border-weak-base px-3 py-1 text-text-strong hover:bg-surface-base-hover focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
  const failure = (message: string, reset?: () => void) => (
    <div data-component="file-preview-error" role="alert" class="flex flex-col items-start gap-3 px-6 py-4 text-text-weak">
      <p class="font-medium text-text-strong">{labels().failed}</p>
      <p class="max-w-full whitespace-pre-wrap break-words">{message}</p>
      <button type="button" class={buttonClass} disabled={busy()} onClick={() => void retry(reset)}>{labels().retry}</button>
    </div>
  )

  return (
    <section data-component="file-preview" data-preview-kind={descriptor().kind} aria-busy={busy()} class="min-w-0">
      <header class="flex min-w-0 flex-wrap items-center gap-2 border-b border-border-weak-base px-4 py-2 text-12 text-text-weak">
        <span class="min-w-0 flex-1 truncate" title={props.path}>{props.path}</span>
        <span>{richPreview() && mode() !== "source" ? labels()[mode()] : labels()[descriptor().mode]}</span>
        <Show when={richPreview()}>
          <div role="group" aria-label={labels().mode} class="flex gap-1">
            <button type="button" class={buttonClass} disabled={!file.ready()} aria-pressed={mode() === "source"} onClick={() => file.setPreviewMode(props.path, "source")}>{labels().sourceTab}</button>
            <button type="button" class={buttonClass} disabled={!file.ready()} aria-pressed={mode() === "preview"} onClick={() => file.setPreviewMode(props.path, "preview")}>{labels().previewTab}</button>
            <button type="button" class={buttonClass} disabled={!file.ready()} aria-pressed={mode() === "split"} onClick={() => file.setPreviewMode(props.path, "split")}>{labels().splitTab}</button>
          </div>
        </Show>
        <button type="button" class={buttonClass} disabled={busy()} onClick={() => void retry()}>{labels().refresh}</button>
      </header>
      <FilePreviewActions path={props.path} content={props.state?.content} disabled={busy() || !!props.state?.error} />
      <Show when={`${props.path}\u0000${props.version}`} keyed>
        {(_version) => (
          <ErrorBoundary fallback={(error, reset) => failure(error instanceof Error ? error.message : labels().failed, reset)}>
            <Switch>
              <Match when={status.error || props.state?.error}>
                {failure(status.error || props.state?.error || labels().failed)}
              </Match>
              <Match when={props.state?.loaded && props.state?.content}>
                <Show when={descriptor().renderer === "existing"} fallback={
                  <div data-component="file-preview-unsupported" role="status" class="px-6 py-4 text-text-weak">
                    {labels().unsupported}
                  </div>
                }>
                  <Switch fallback={props.render(props.state?.content?.content ?? "")}>
                    <Match when={descriptor().kind === "video"}>
                      <Suspense fallback={<div role="status">{language.t("common.loading")}...</div>}>
                        <VideoPreview path={props.path} content={props.state!.content!} />
                      </Suspense>
                    </Match>
                    <Match when={descriptor().kind === "office"}>
                      <Suspense fallback={<div role="status" class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
                        <OfficePreview path={props.path} content={props.state!.content!} />
                      </Suspense>
                    </Match>
                    <Match when={descriptor().kind === "pdf"}>
                      <Suspense fallback={<div role="status" class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
                        <PdfPreview path={props.path} content={props.state!.content!} />
                      </Suspense>
                    </Match>
                    <Match when={richPreview() && mode() === "split"}>
                      <div data-component={descriptor().kind === "html" ? "html-split-preview" : "markdown-split-preview"}>
                        <section>
                          <h2>{labels().sourceTab}</h2>
                          <div data-preview-pane="source" role="region" aria-label={labels().source} tabIndex={0}>
                            {props.render(props.state?.content?.content ?? "")}
                          </div>
                        </section>
                        <section>
                          <h2>{labels().previewTab}</h2>
                          <div data-preview-pane="preview" role="region" aria-label={labels().preview} tabIndex={0}>
                            {renderRichPreview()}
                          </div>
                        </section>
                      </div>
                    </Match>
                    <Match when={richPreview() && mode() === "preview"}>{renderRichPreview()}</Match>
                  </Switch>
                </Show>
              </Match>
              <Match when={busy()}>
                <div role="status" class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
              </Match>
              <Match when={props.state?.loaded}>{failure(labels().empty)}</Match>
            </Switch>
          </ErrorBoundary>
        )}
      </Show>
    </section>
  )
}
