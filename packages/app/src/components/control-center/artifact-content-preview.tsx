import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import type { OperationsApi } from "@/utils/server"
import { ARTIFACT_TEXT_PREVIEW_BYTES, artifactContentMime, artifactDownloadName, artifactTextPreview, readArtifactContent, type ArtifactOwner, type ArtifactReference } from "./artifact-content"

export function ArtifactContentPreview(props: {
  api: () => OperationsApi
  reference: ArtifactReference
  owner?: ArtifactOwner
  scopeKey: string
  ready: boolean
  onRead?: () => void
}) {
  const language = useLanguage()
  const text = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const [state, setState] = createStore({ busy: false, error: "", bytes: undefined as Uint8Array | undefined, image: "" })
  const identity = createMemo(() => props.scopeKey + "\u0000" + JSON.stringify([props.reference, props.owner]))
  const mime = () => artifactContentMime(props.reference)
  const preview = createMemo(() => state.bytes ? artifactTextPreview(state.bytes, mime()) : undefined)
  const owned = () => !!props.owner && props.reference.owner.scope === props.owner.scope && props.reference.owner.id === props.owner.id
  let generation = 0, disposed = false
  let controller: AbortController | undefined
  const urls = new Set<string>()
  const clearURLs = () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear() }
  const reset = () => {
    generation++
    controller?.abort()
    clearURLs()
    setState({ busy: false, error: "", bytes: undefined, image: "" })
  }
  createEffect(on(() => [props.api(), identity(), props.ready] as const, reset))
  onCleanup(() => { disposed = true; generation++; controller?.abort(); clearURLs() })
  const objectURL = (bytes: Uint8Array) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime() }))
    urls.add(url)
    return url
  }
  const read = async (download: boolean) => {
    const owner = props.owner
    if (state.busy || !props.ready || !owner || !owned()) return
    reset()
    const request = generation, origin = identity(), api = props.api(), reference = props.reference
    const signal = (controller = new AbortController()).signal
    const current = () => !disposed && request === generation && origin === identity() && api === props.api() && props.ready && !signal.aborted
    setState("busy", true)
    try {
      const bytes = await readArtifactContent({ readers: api.artifacts, reference, owner, signal })
      if (!current()) return
      if (download) {
        const link = document.createElement("a")
        link.href = objectURL(bytes)
        link.download = artifactDownloadName(reference)
        link.click()
      } else {
        setState("bytes", bytes)
        if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime())) setState("image", objectURL(bytes))
      }
      props.onRead?.()
    } catch (error) { if (current()) setState("error", error instanceof Error ? error.message : String(error)) }
    finally { if (current()) setState("busy", false) }
  }
  return <section data-testid="artifact-content" aria-label={text("产物内容", "Artifact content")} aria-busy={state.busy}>
    <p>{props.reference.mime} · {props.reference.sizeBytes.toLocaleString()} {text("字节", "bytes")}</p>
    <div class="flex flex-wrap gap-2">
      <ButtonV2 variant="outline" size="small" disabled={!props.ready || !owned() || state.busy} onClick={() => void read(false)} data-testid="artifact-content-preview">{text("预览产物", "Preview artifact")}</ButtonV2>
      <ButtonV2 variant="outline" size="small" disabled={!props.ready || !owned() || state.busy} onClick={() => void read(true)} data-testid="artifact-content-download">{text("下载产物", "Download artifact")}</ButtonV2>
      <Show when={state.busy}><ButtonV2 variant="ghost" size="small" onClick={reset} data-testid="artifact-content-cancel">{text("取消读取", "Cancel read")}</ButtonV2></Show>
      <Show when={state.bytes}><ButtonV2 variant="ghost" size="small" onClick={reset}>{text("关闭预览", "Close preview")}</ButtonV2></Show>
    </div>
    <Show when={!owned()}><p role="status">{text("此产物不属于当前选择的来源。", "This artifact does not belong to the selected source.")}</p></Show>
    <Show when={state.error}><p role="alert" class="whitespace-pre-wrap break-words">{state.error}</p></Show>
    <Show when={state.bytes}><p role="status">{text("已核对完整内容摘要与大小。", "Full content digest and size verified.")}</p></Show>
    <Show when={preview() !== undefined}>
      <Show when={(state.bytes?.byteLength ?? 0) > ARTIFACT_TEXT_PREVIEW_BYTES}><p>{text("只显示前256 KiB；下载保留完整内容。", "Showing the first 256 KiB; download retains all content.")}</p></Show>
      <pre data-testid="artifact-content-text" class="max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words">{preview()}</pre>
    </Show>
    <Show when={state.image}><img src={state.image} alt={props.reference.label ?? props.reference.kind} class="max-h-96 max-w-full object-contain" /></Show>
    <Show when={state.bytes && preview() === undefined && !state.image}><p>{text("已读取二进制内容，可下载核对后的完整快照。", "Binary content loaded. Download the verified full snapshot.")}</p></Show>
  </section>
}
