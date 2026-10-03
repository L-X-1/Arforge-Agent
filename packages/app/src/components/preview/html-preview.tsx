import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import type { PreviewResource } from "@arforge-ai/schema/preview-resource"
import type { PreviewResourceApi } from "@/utils/preview-resource-api"
import { buildHtmlPreview } from "./html-preview-document"
import { HTML_PREVIEW_DEBOUNCE_MS } from "./html-preview-policy"
import "./html-preview.css"
import { HtmlElementPreview } from "./html-element-preview"

export function HtmlPreview(props: { path: string; text: string; live?: boolean }) {
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServerSDK()
  const t = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const [state, setState] = createStore({ document: "", error: "", pending: true, selecting: false })
  const [resources, setResources] = createStore({ grant: undefined as PreviewResource.Grant | undefined, loading: false, error: "" })
  let current: { api: PreviewResourceApi; directory: string; grant: PreviewResource.Grant } | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let alive = true
  const release = () => {
    generation++
    if (expiry) clearTimeout(expiry)
    expiry = undefined
    const previous = current
    current = undefined
    if (alive) setResources({ grant: undefined, loading: false })
    if (previous) void previous.api.close({ directory: previous.directory, id: previous.grant.id }).catch(() => {
      if (alive && !current) setResources("error", t("\u64a4\u9500\u8bf7\u6c42\u672a\u5b8c\u6210\uff0c\u6388\u6743\u5c06\u5728\u5230\u671f\u540e\u5931\u6548\u3002", "Revocation could not be confirmed; the grant will expire automatically."))
    })
  }
  const enable = async () => {
    if (resources.loading) return
    const request = ++generation
    const api = server().operationsApi.previewResources
    const directory = sdk().directory
    setResources({ loading: true, error: "" })
    try {
      const grant = await api.open({ directory, path: props.path })
      if (!alive || request !== generation) {
        void api.close({ directory, id: grant.id }).catch(() => undefined)
        return
      }
      current = { api, directory, grant }
      setResources("grant", grant)
      expiry = setTimeout(() => {
        release()
        if (alive) setResources("error", t("\u672c\u5730\u8d44\u6e90\u6388\u6743\u5df2\u5230\u671f\uff0c\u53ef\u91cd\u65b0\u52a0\u8f7d\u3002", "Local resource access expired. You can enable it again."))
      }, Math.max(0, grant.expiresAt - Date.now()))
    } catch (error) {
      if (alive && request === generation) setResources("error", error instanceof Error ? error.message : "Local resources unavailable")
    } finally {
      if (alive && request === generation) setResources("loading", false)
    }
  }
  createEffect(on(() => JSON.stringify([props.path, sdk().directory, server().scope]), release, { defer: true }))
  onCleanup(() => { alive = false; release() })

  createEffect(on(() => [props.path, props.text, resources.grant?.baseURL] as const, ([path, text, base]) => {
    setState({ pending: true, error: "" })
    const timer = setTimeout(() => {
      try {
        setState({ document: buildHtmlPreview(text, path, base), pending: false, error: "" })
      } catch (error) {
        setState({ document: "", pending: false, error: error instanceof Error ? error.message : String(error) })
      }
    }, props.live ? HTML_PREVIEW_DEBOUNCE_MS : 0)
    onCleanup(() => clearTimeout(timer))
  }))

  return (
    <section data-component="html-file-preview" aria-busy={state.pending}>
      <p data-slot="html-preview-notice">
        {resources.grant
          ? t("\u5df2\u6388\u6743\u5f53\u524d HTML \u76ee\u5f55\u5185\u7684 CSS \u548c\u4f4d\u56fe\u3002\u811a\u672c\u3001\u8df3\u8f6c\u548c\u5916\u90e8\u8d44\u6e90\u4ecd\u7981\u7528\u3002", "CSS and raster images inside this HTML directory are authorized. Scripts, navigation and external resources remain disabled.")
          : t("\u5b89\u5168 HTML/CSS \u9884\u89c8\uff1a\u811a\u672c\u3001\u94fe\u63a5\u8df3\u8f6c\u548c\u5916\u90e8/\u672c\u5730\u8d44\u6e90\u5747\u5df2\u7981\u7528\u3002", "Safe HTML/CSS preview: scripts, navigation and external/local resources are disabled.")}
        <Show when={props.live}> {t("\u9884\u89c8\u8349\u7a3f\u4e0d\u4f1a\u81ea\u52a8\u4fdd\u5b58\u6587\u4ef6\u3002", "Previewing a draft does not save the file.")}</Show>
      </p>
      <div data-slot="html-resource-controls">
        <button type="button" aria-pressed={state.selecting} disabled={state.pending || !!state.error} onClick={() => setState("selecting", !state.selecting)}>
          {state.selecting ? t("\u9000\u51fa\u5143\u7d20\u9009\u62e9", "Exit element selection") : t("\u9009\u62e9\u5143\u7d20", "Select elements")}
        </button>
        <button type="button" disabled={resources.loading || !server().operationsApi.previewResources.available} onClick={() => resources.grant ? release() : void enable()}>
          {resources.loading ? t("\u6b63\u5728\u6388\u6743...", "Authorizing...") : resources.grant ? t("\u7981\u7528\u672c\u5730\u8d44\u6e90", "Disable local resources") : t("\u52a0\u8f7d\u672c\u5730\u8d44\u6e90", "Load local resources")}
        </button>
        <Show when={!server().operationsApi.previewResources.available}><span>{t("\u4ec5\u652f\u6301\u672c\u673a HTTP \u670d\u52a1\u8fde\u63a5\u3002", "Requires a local HTTP server connection.")}</span></Show>
      </div>
      <Show when={resources.error}><p role="alert">{resources.error}</p></Show>
      <Show when={state.pending}><p role="status">{t("\u6b63\u5728\u66f4\u65b0\u9884\u89c8...", "Updating preview...")}</p></Show>
      <Show when={state.error}><p role="alert">{state.error}</p></Show>
      <Show when={state.document}>
        <Show when={state.selecting} fallback={
        <iframe
          title={`${props.path} - HTML preview`}
          sandbox=""
          referrerpolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
          srcdoc={state.document}
        />
        }>
          <HtmlElementPreview path={props.path} text={props.text} resourceBase={resources.grant?.baseURL} live={props.live} onExit={() => setState("selecting", false)} />
        </Show>
      </Show>
    </section>
  )
}
