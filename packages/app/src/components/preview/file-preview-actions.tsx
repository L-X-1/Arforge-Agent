import { createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useOpenInApp } from "@/components/session/open-in-app"
import type { PreviewBytes } from "./document-preview-model"
import { previewDownloadBytes, previewDownloadName, previewLocalPath } from "./preview-export"

export function FilePreviewActions(props: { path: string; content?: PreviewBytes; disabled?: boolean }) {
  const sdk = useSDK()
  const language = useLanguage()
  const t = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const nativePath = createMemo(() => previewLocalPath(sdk().directory, props.path))
  const external = useOpenInApp({ directory: () => nativePath() ?? "" })
  const [state, setState] = createStore({ error: "" })
  const urls = new Set<string>()
  onCleanup(() => urls.forEach((url) => URL.revokeObjectURL(url)))
  const download = () => {
    if (!props.content || props.disabled) return
    setState("error", "")
    try {
      const bytes = previewDownloadBytes(props.content)
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }))
      urls.add(url)
      const link = document.createElement("a")
      link.href = url
      link.download = previewDownloadName(props.path)
      link.click()
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url) }, 1000)
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div data-slot="workbench-file-actions">
      <button type="button" disabled={props.disabled || !props.content} onClick={download}>
        {t("下载当前文件快照", "Download file snapshot")}
      </button>
      <Show when={external.canOpen() && nativePath()}>
        <button type="button" disabled={props.disabled || external.opening()} onClick={() => external.openDir("finder")}>
          {t("在外部应用打开", "Open externally")}
        </button>
      </Show>
      <Show when={state.error}><p role="alert">{state.error}</p></Show>
    </div>
  )
}
