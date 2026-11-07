import {
  createEffect,
  createMemo,
  ErrorBoundary,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@arforge-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useFile } from "@/context/file"
import type { FileState } from "@/context/file/types"
import { previewRegistry } from "./registry"
import { FilePreviewActions } from "./file-preview-actions"
import { PreviewLoading } from "./preview-loading"
import { MediaPreviewFrame } from "./media-preview-frame"
import { WorkbenchActionTooltip } from "./workbench-action-tooltip"
import "./markdown-split.css"
import "./workbench-review.css"
import "./file-preview-polish.css"

const MarkdownPreview = lazy(() => import("./markdown-preview").then((module) => ({ default: module.MarkdownPreview })))
const HtmlPreview = lazy(() => import("./html-preview").then((module) => ({ default: module.HtmlPreview })))
const PdfPreview = lazy(() => import("./pdf-preview").then((module) => ({ default: module.PdfPreview })))
const OfficePreview = lazy(() => import("./office-preview").then((module) => ({ default: module.OfficePreview })))
const VideoPreview = lazy(() => import("./video-preview").then((module) => ({ default: module.VideoPreview })))

export function FilePreview(props: {
  path: string
  /** Identity owned by the source boundary; never derived from a file version. */
  sourceKey?: string
  version: string | number | undefined
  state?: FileState
  onRetry: () => Promise<void>
  render: (source: string) => JSX.Element
}) {
  const language = useLanguage()
  const file = useFile()
  const labels = createMemo(() =>
    language.locale().startsWith("zh")
      ? {
          source: "\u6e90\u7801\u53ea\u8bfb",
          sourceTab: "\u6e90\u7801",
          previewTab: "\u9884\u89c8",
          splitTab: "\u5206\u5c4f",
          split: "\u6e90\u7801\u4e0e\u9884\u89c8\u53ea\u8bfb",
          mode: "\u6587\u4ef6\u663e\u793a\u6a21\u5f0f",
          preview: "\u53ea\u8bfb\u9884\u89c8",
          unavailable: "\u6682\u4e0d\u652f\u6301\u9884\u89c8",
          unsupported:
            "\u6b64\u683c\u5f0f\u7684\u9884\u89c8\u5668\u5c1a\u672a\u63a5\u5165\uff0c\u539f\u6587\u4ef6\u672a\u6539\u52a8\u3002\u53ef\u4f7f\u7528\u7cfb\u7edf\u9ed8\u8ba4\u5e94\u7528\u6253\u5f00\u3002",
          failed: "\u6587\u4ef6\u9884\u89c8\u5931\u8d25",
          retry: "\u91cd\u8bd5",
          refresh: "\u5237\u65b0\u9884\u89c8",
          empty: "\u672a\u8bfb\u53d6\u5230\u6587\u4ef6\u5185\u5bb9\uff0c\u8bf7\u91cd\u8bd5\u3002",
        }
      : {
          source: "Read-only source",
          preview: "Read-only preview",
          unavailable: "Preview unavailable",
          sourceTab: "Source",
          previewTab: "Preview",
          mode: "File display mode",
          splitTab: "Split",
          split: "Read-only source and preview",
          unsupported:
            "A preview adapter for this format is not connected yet. The original file is unchanged. You can open it with its default application.",
          failed: "File preview failed",
          retry: "Retry",
          refresh: "Refresh preview",
          empty: "No file content was returned. Please retry.",
        },
  )
  const descriptor = createMemo(() => previewRegistry.resolve(props.path, props.state?.content))
  const richPreview = () =>
    (descriptor().kind === "markdown" || descriptor().kind === "html") && descriptor().capabilities.preview
  const mediaKind = () => {
    const kind = descriptor().kind
    return kind === "image" || kind === "audio" || kind === "video" ? kind : undefined
  }
  const [status, setStatus] = createStore({
    retrying: false,
    error: "",
    mediaError: undefined as
      | { path: string; version: string | number | undefined; content: string | undefined }
      | undefined,
  })
  let root: HTMLElement | undefined
  const mediaFailure = () => {
    const failed = status.mediaError
    return failed &&
      failed.path === props.path &&
      failed.version === props.version &&
      failed.content === props.state?.content?.content
      ? labels().failed
      : ""
  }
  onMount(() => {
    // Native image/source decode errors do not bubble. Keep failure handling
    // inside this preview and bind it to the exact file snapshot that failed.
    const failed = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !root?.contains(target)) return
      const kind = descriptor().kind
      if (
        !(kind === "image" && target instanceof HTMLImageElement) &&
        !(
          kind === "audio" &&
          (target instanceof HTMLAudioElement ||
            (target instanceof HTMLSourceElement && target.parentElement instanceof HTMLAudioElement))
        )
      )
        return
      setStatus("mediaError", { path: props.path, version: props.version, content: props.state?.content?.content })
    }
    root?.addEventListener("error", failed, true)
    onCleanup(() => root?.removeEventListener("error", failed, true))
  })
  const mode = () => (file.ready() ? file.previewMode(props.path) : "source")
  let request = 0
  createEffect(
    on(
      () => props.path,
      () => {
        request++
        setStatus({ retrying: false, error: "", mediaError: undefined })
      },
    ),
  )
  onCleanup(() => request++)

  const retry = async (reset?: () => void) => {
    if (status.retrying || props.state?.loading) return
    const current = ++request
    setStatus({ retrying: true, error: "", mediaError: undefined })
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
    <Suspense fallback={<PreviewLoading kind={descriptor().kind} label={`${language.t("common.loading")}...`} />}>
      <Show
        when={descriptor().kind === "html"}
        fallback={<MarkdownPreview text={props.state?.content?.content ?? ""} />}
      >
        <HtmlPreview path={props.path} text={props.state?.content?.content ?? ""} />
      </Show>
    </Suspense>
  )
  const buttonClass = "workbench-preview-button"
  const failure = (message: string, reset?: () => void) => (
    <div
      data-component="file-preview-error"
      role="alert"
      class="flex flex-col items-start gap-3 px-6 py-4 text-text-weak"
    >
      <p class="font-medium text-text-strong">{labels().failed}</p>
      <p data-slot="file-preview-error-path">{props.path}</p>
      <p class="max-w-full whitespace-pre-wrap break-words">{message}</p>
      <button type="button" class={buttonClass} disabled={busy()} onClick={() => void retry(reset)}>
        {labels().retry}
      </button>
    </div>
  )

  return (
    <section
      ref={root}
      data-component="file-preview"
      data-preview-kind={descriptor().kind}
      data-preview-layout={richPreview() ? mode() : undefined}
      aria-busy={busy()}
      class="min-w-0"
    >
      <div data-slot="file-preview-chrome">
        <div data-slot="file-preview-pathbar">
          <span data-slot="file-preview-path" title={props.path}>
            {props.path}
          </span>
          <span
            data-slot="file-preview-mode"
            title={richPreview() && mode() !== "source" ? labels()[mode()] : labels()[descriptor().mode]}
          >
            {richPreview() && mode() !== "source" ? labels()[mode()] : labels()[descriptor().mode]}
          </span>
        </div>
        <header data-slot="file-preview-toolbar" role="group" aria-label={labels().mode}>
          <Show when={richPreview()}>
            <div data-slot="file-preview-modes" role="group" aria-label={labels().mode}>
              <button
                type="button"
                class={buttonClass}
                disabled={!file.ready()}
                aria-pressed={mode() === "source"}
                onClick={() => file.setPreviewMode(props.path, "source")}
              >
                {labels().sourceTab}
              </button>
              <button
                type="button"
                class={buttonClass}
                disabled={!file.ready()}
                aria-pressed={mode() === "preview"}
                onClick={() => file.setPreviewMode(props.path, "preview")}
              >
                {labels().previewTab}
              </button>
              <button
                type="button"
                class={buttonClass}
                disabled={!file.ready()}
                aria-pressed={mode() === "split"}
                onClick={() => file.setPreviewMode(props.path, "split")}
              >
                {labels().splitTab}
              </button>
            </div>
          </Show>
          <WorkbenchActionTooltip label={labels().refresh} class="workbench-preview-refresh-hint">
            <button
              type="button"
              class={`${buttonClass} workbench-preview-icon-button`}
              disabled={busy()}
              onClick={() => void retry()}
              aria-label={busy() ? language.t("common.loading") : labels().refresh}
            >
              <Icon name="reset" size="small" />
            </button>
          </WorkbenchActionTooltip>
          <FilePreviewActions
            path={props.path}
            content={props.state?.content}
            disabled={busy() || !!props.state?.error}
          />
        </header>
      </div>
      <Show
        when={JSON.stringify([
          props.sourceKey,
          props.path,
          descriptor().kind,
          props.sourceKey && (descriptor().kind === "office" || descriptor().kind === "pdf") ? null : props.version,
        ])}
        keyed
      >
        {(_version) => (
          <ErrorBoundary
            fallback={(error, reset) => failure(error instanceof Error ? error.message : labels().failed, reset)}
          >
            <Switch>
              <Match when={status.error || props.state?.error || mediaFailure()}>
                {failure(status.error || props.state?.error || mediaFailure() || labels().failed)}
              </Match>
              <Match when={props.state?.loaded && props.state?.content}>
                <Show
                  when={descriptor().renderer === "existing"}
                  fallback={
                    <div data-component="file-preview-unsupported" role="status" class="px-6 py-4 text-text-weak">
                      {labels().unsupported}
                    </div>
                  }
                >
                  <Switch fallback={props.render(props.state?.content?.content ?? "")}>
                    <Match when={mediaKind()}>
                      {(kind) => (
                        <MediaPreviewFrame
                          path={props.path}
                          version={props.version}
                          snapshot={props.state?.content}
                          kind={kind()}
                          mimeType={props.state?.content?.mimeType}
                        >
                          <Show when={kind() === "video"} fallback={props.render(props.state?.content?.content ?? "")}>
                            <Suspense
                              fallback={<PreviewLoading kind="video" label={`${language.t("common.loading")}...`} />}
                            >
                              <VideoPreview path={props.path} content={props.state!.content!} />
                            </Suspense>
                          </Show>
                        </MediaPreviewFrame>
                      )}
                    </Match>
                    <Match when={descriptor().kind === "office"}>
                      <Suspense
                        fallback={
                          <PreviewLoading kind={descriptor().kind} label={`${language.t("common.loading")}...`} />
                        }
                      >
                        <OfficePreview path={props.path} sourceKey={props.sourceKey} content={props.state!.content!} />
                      </Suspense>
                    </Match>
                    <Match when={descriptor().kind === "pdf"}>
                      <Suspense
                        fallback={
                          <PreviewLoading kind={descriptor().kind} label={`${language.t("common.loading")}...`} />
                        }
                      >
                        <PdfPreview path={props.path} sourceKey={props.sourceKey} content={props.state!.content!} />
                      </Suspense>
                    </Match>
                    <Match when={richPreview() && mode() === "split"}>
                      <div
                        data-component={descriptor().kind === "html" ? "html-split-preview" : "markdown-split-preview"}
                      >
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
                <PreviewLoading kind={descriptor().kind} label={`${language.t("common.loading")}...`} />
              </Match>
              <Match when={props.state?.loaded}>{failure(labels().empty)}</Match>
            </Switch>
          </ErrorBoundary>
        )}
      </Show>
    </section>
  )
}
