import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { decodePreviewBytes, type PreviewBytes } from "./document-preview-model"

export function VideoPreview(props: { path: string; content: PreviewBytes }) {
  const language = useLanguage()
  const t = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const [state, setState] = createStore({ url: "", error: "" })
  createEffect(() => {
    let url: string | undefined
    try {
      const extension = props.path.split(".").at(-1)?.toLowerCase()
      const mime = extension === "webm" ? "video/webm" : extension === "ogv" ? "video/ogg" : "video/mp4"
      url = URL.createObjectURL(new Blob([decodePreviewBytes(props.content)], { type: mime }))
      setState({ url, error: "" })
    } catch (error) { setState({ url: "", error: String(error) }) }
    onCleanup(() => { if (url) URL.revokeObjectURL(url) })
  })
  return <section data-component="video-file-preview">
    <Show when={state.url}>
      <video controls preload="metadata" src={state.url} aria-label={props.path}
        onError={() => setState("error", t("当前浏览器无法播放此视频，可下载后使用本地播放器打开。", "This browser cannot play this video. Download it and open it in a local player."))} />
    </Show>
    <Show when={state.error}><p role="alert">{state.error}</p></Show>
  </section>
}
