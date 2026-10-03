import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { usePrompt } from "@/context/prompt"
import { createHtmlSelectionReference } from "@/utils/html-selection-reference"
import { jumpToHtmlEditor } from "@/utils/html-editor-navigation"
import { buildHtmlElementDocument } from "./html-element-document"
import { decodeHtmlElementMessage, htmlElementExcerpt, type HtmlSourceElement } from "./html-element-model"
import { HTML_PREVIEW_DEBOUNCE_MS } from "./html-preview-policy"
import "./html-element-preview.css"

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
const random = () => hex(crypto.getRandomValues(new Uint8Array(16)))

export function HtmlElementPreview(props: { path: string; text: string; resourceBase?: string; live?: boolean; onExit: () => void }) {
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServerSDK()
  const prompt = usePrompt()
  const t = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const [state, setState] = createStore({
    document: "", error: "", pending: true, ready: false, limited: false,
    elements: [] as readonly HtmlSourceElement[], selected: undefined as HtmlSourceElement | undefined, sourceOpened: false,
  })
  let frame: HTMLIFrameElement | undefined
  let container: HTMLDivElement | undefined
  const [actions, setActions] = createStore({ jumping: false, notice: "", error: "" })
  let sourceArea: HTMLTextAreaElement | undefined
  let generation = 0
  let identity: { path: string; source: string; frameID: string; revision: string; scope: string; directory: string } | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(on(() => [props.path, props.text, props.resourceBase, sdk().directory, server().scope] as const, ([path, source, resourceBase, directory, scope]) => {
    const request = ++generation
    setActions({ jumping: false, notice: "", error: "" })
    identity = undefined
    if (readyTimer) clearTimeout(readyTimer)
    setState({ document: "", error: "", pending: true, ready: false, elements: [], selected: undefined, sourceOpened: false, limited: false })
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const revision = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))))
          if (request !== generation) return
          const frameID = crypto.randomUUID()
          const result = buildHtmlElementDocument({ source, path, resourceBase, frameID, revision, nonce: random(), marker: random() })
          if (request !== generation) return
          identity = { source, path, frameID, revision, scope, directory }
          setState({ ...result, pending: false })
          readyTimer = setTimeout(() => {
            if (request === generation && !state.ready) setState("error", t("\u5143\u7d20\u9009\u62e9\u6865\u63a5\u672a\u5c31\u7eea\uff0c\u53ef\u9000\u51fa\u540e\u91cd\u8bd5\u3002", "The element selection bridge did not become ready. Exit selection and retry."))
          }, 5000)
        } catch (error) {
          if (request === generation) setState({ pending: false, error: error instanceof Error ? error.message : "HTML selection unavailable" })
        }
      })()
    }, props.live ? HTML_PREVIEW_DEBOUNCE_MS : 0)
    onCleanup(() => clearTimeout(timer))
  }))

  const current = () => identity && identity.path === props.path && identity.source === props.text && identity.scope === server().scope && identity.directory === sdk().directory ? identity : undefined
  const receive = (event: MessageEvent<unknown>) => {
    const session = current()
    if (!session || !frame?.contentWindow) return
    const message = decodeHtmlElementMessage({ data: event.data, origin: event.origin, sourceMatches: event.source === frame.contentWindow }, { ...session, elements: state.elements })
    if (!message) return
    if (message.kind === "ready") {
      if (readyTimer) clearTimeout(readyTimer)
      setState({ ready: true, error: "" })
    } else if (message.kind === "cancel") props.onExit()
    else if (message.kind === "select") setState({ selected: message.element, sourceOpened: false })
  }
  window.addEventListener("message", receive)
  onCleanup(() => {
    generation++
    identity = undefined
    if (readyTimer) clearTimeout(readyTimer)
    window.removeEventListener("message", receive)
  })

  const choose = (id: string) => {
    const session = current()
    if (!session || !state.ready || !state.elements.some((element) => element.id === id)) return
    frame?.contentWindow?.postMessage({ type: "arforge.html-element-focus", frameID: session.frameID, revision: session.revision, id }, "*")
  }
  const excerpt = () => state.selected && current() ? htmlElementExcerpt(props.text, state.selected) : undefined
  const locate = () => {
    if (!current() || !state.selected) return
    setState("sourceOpened", true)
    queueMicrotask(() => {
      sourceArea?.focus({ preventScroll: true })
      sourceArea?.setSelectionRange(0, sourceArea.value.length)
    })
  }

  const reference = () => {
    const session = current()
    const element = state.selected
    if (!session || !element || !prompt.ready()) return
    try {
      const target = prompt.capture()
      const item = createHtmlSelectionReference({
        path: session.path, directory: session.directory, serverScope: session.scope,
        revision: session.revision, source: session.source, element, live: !!props.live,
        label: props.live ? t("HTML \u7f16\u8f91\u5feb\u7167", "HTML editor snapshot") : t("HTML \u6e90\u7801\u5feb\u7167", "HTML source snapshot"),
      })
      target.context.add(item)
      setActions({ error: "", notice: t("\u5df2\u52a0\u5165\u5f53\u524d\u4f1a\u8bdd\u5f15\u7528\uff0c\u5c1a\u672a\u53d1\u9001\u3002\u5feb\u7167\u4e0d\u4f1a\u968f\u540e\u7eed\u7f16\u8f91\u81ea\u52a8\u66f4\u65b0\u3002", "Snapshot added to the current conversation, not sent. Later edits do not change this captured reference.") })
    } catch (error) {
      setActions({ notice: "", error: error instanceof Error ? error.message : "Could not add the selection reference." })
    }
  }

  const jump = async () => {
    const session = current()
    const element = state.selected
    if (!props.live || !session || !element || !container || actions.jumping) return
    const request = generation
    setActions({ jumping: true, error: "", notice: "" })
    try {
      const result = await jumpToHtmlEditor({ container, source: session.source, element, current: () => current() === session && state.selected === element })
      if (request !== generation) return
      if (result === "jumped") setActions("notice", t("\u5df2\u5728\u5f53\u524d\u7f16\u8f91\u5668\u4e2d\u9009\u4e2d\u6e90\u7801\uff0c\u672a\u4fee\u6539\u5185\u5bb9\u3002", "Source selected in the current editor. No content was changed."))
      else setActions("error", result === "stale" ? t("\u7f16\u8f91\u5185\u5bb9\u6216\u9009\u533a\u5df2\u66f4\u65b0\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9\u5143\u7d20\u3002", "The buffer or selection changed. Select the element again.") : t("\u672a\u627e\u5230\u552f\u4e00\u5339\u914d\u7684\u5f53\u524d\u7f16\u8f91\u5668\u3002\u8bf7\u5148\u6253\u5f00\u7f16\u8f91\u5e76\u5f00\u542f\u5b9e\u65f6\u9884\u89c8\u3002", "No unique matching editor is open in this file tab. Open Edit file and enable live preview first."))
    } catch (error) {
      if (request === generation) setActions("error", error instanceof Error ? error.message : "Editor navigation unavailable.")
    } finally {
      if (request === generation) setActions("jumping", false)
    }
  }

  return (
    <div ref={container} data-component="html-element-preview" aria-busy={state.pending || (!state.ready && !state.error)}>
      <p role="note">{t("\u70b9\u51fb\u5143\u7d20\u6216\u4f7f\u7528\u4e0b\u62c9\u5217\u8868\u9009\u62e9\uff1b\u9884\u89c8\u5185\u652f\u6301\u4e0a/\u4e0b\u65b9\u5411\u952e\uff0cEsc \u9000\u51fa\u3002\u4ec5\u5b9a\u4f4d\u5f53\u524d\u6e90\u7801\u5feb\u7167\uff0c\u4e0d\u4fee\u6539\u6587\u4ef6\u3002", "Click an element or use the list; inside the preview use Up/Down and Escape. Locations refer to the current source snapshot. No file is modified.")}</p>
      <div data-slot="html-element-toolbar">
        <label>
          <span>{t("\u5143\u7d20", "Element")}</span>
          <select aria-label={t("HTML \u5143\u7d20", "HTML element")} value={state.selected?.id ?? ""} disabled={!state.ready} onChange={(event) => choose(event.currentTarget.value)}>
            <option value="" disabled>{t("\u9009\u62e9\u4e00\u4e2a\u5143\u7d20", "Choose an element")}</option>
            <For each={state.elements}>{(element) => <option value={element.id}>{element.label}</option>}</For>
          </select>
        </label>
        <button type="button" disabled={!state.selected || !current()} onClick={locate}>{t("\u5b9a\u4f4d\u6e90\u7801", "Locate source")}</button>
        <button type="button" disabled={!props.live || !state.selected || !current() || actions.jumping} onClick={() => void jump()}>{t("\u8df3\u8f6c\u7f16\u8f91\u5668", "Jump to editor")}</button>
        <button type="button" disabled={!state.selected || !current() || !prompt.ready()} onClick={reference}>{t("\u5f15\u7528\u5230 AI", "Reference in AI")}</button>
      </div>
      <Show when={!props.live}><p role="note">{t("\u7f16\u8f91\u5668\u8df3\u8f6c\u9700\u8981\u5148\u6253\u5f00\u7f16\u8f91\u6587\u4ef6\uff0c\u5e76\u5f00\u542f\u5b9e\u65f6\u9884\u89c8\u3002", "To jump to the editor, first open Edit file and enable live preview.")}</p></Show>
      <Show when={actions.notice}><p role="status">{actions.notice}</p></Show>
      <Show when={actions.error}><p role="alert">{actions.error}</p></Show>
      <Show when={state.pending}><p role="status">{t("\u6b63\u5728\u5efa\u7acb\u6e90\u7801\u6620\u5c04...", "Mapping source elements...")}</p></Show>
      <Show when={state.error}><p role="alert">{state.error}</p></Show>
      <Show when={state.limited}><p role="note">{t("\u4ec5\u663e\u793a\u524d 1500 \u4e2a\u53ef\u6620\u5c04\u5143\u7d20\u3002", "Only the first 1,500 mappable elements are listed.")}</p></Show>
      <Show when={state.ready && state.elements.length === 0}><p role="status">{t("\u6ca1\u6709\u53ef\u5b89\u5168\u6620\u5c04\u7684\u5143\u7d20\u3002", "There are no safely mapped elements.")}</p></Show>
      <Show when={state.selected}>{(selected) => <p data-slot="html-element-location" role="status"><code>{props.path}:{selected().line}:{selected().column}</code> <span>{selected().tag} / {t("\u7b2c", "lines")} {selected().line}-{selected().endLine}</span></p>}</Show>
      <Show when={state.sourceOpened && excerpt()}>{(content) => (
        <div data-slot="html-element-source">
          <textarea ref={sourceArea} aria-label={t("\u9009\u4e2d\u5143\u7d20\u7684 HTML \u6e90\u7801", "Selected HTML source")} readOnly spellcheck={false} value={content().text} />
          <Show when={content().truncated}><p role="note">{t("\u7247\u6bb5\u8fc7\u957f\uff0c\u4ec5\u663e\u793a\u524d 12,000 \u5b57\u7b26\u3002\u884c\u53f7\u4ecd\u5bf9\u5e94\u5b8c\u6574\u5143\u7d20\u3002", "Excerpt limited to 12,000 characters. Line numbers still describe the full element.")}</p></Show>
        </div>
      )}</Show>
      <Show when={state.document}>
        <iframe ref={frame} title={`${props.path} - HTML element selection`} sandbox="allow-scripts" referrerpolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
          srcdoc={state.document} />
      </Show>
    </div>
  )
}
