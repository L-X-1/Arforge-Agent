import { createEffect, createUniqueId, ErrorBoundary, onCleanup, onMount, Show, Suspense, type Accessor, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { Icon } from "@arforge-ai/ui/v2/icon"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import type { SessionSettingsValue } from "./session-settings-navigation"
import { canRestoreSessionDetailFocus, createSessionDetailRegistry, sessionDetailInsets } from "./session-detail-drawer-state"
import "./session-detail-drawer.css"

export type SessionDetailRequest = {
  scope: string
  current: () => boolean
  sourceCurrent: () => boolean
  onClose: () => void
  sessionID: string
  title: string
  directory: string
  serverLabel: string
  value: SessionSettingsValue
  content: (value: Accessor<SessionSettingsValue>) => JSX.Element
  fullSettings: () => void
  origin?: HTMLElement
}

type DetailEntry = { id: number; host: number; request: SessionDetailRequest }
const [state, setState] = createStore<{ entry?: DetailEntry }>({})
const registry = createSessionDetailRegistry<SessionDetailRequest>((entry) => setState("entry", reconcile(entry)))
export const presentSessionDetail = (request: SessionDetailRequest) => registry.present(request)
export const invalidateSessionDetails = () => registry.invalidate()
export const closeSessionDetails = () => {
  if (state.entry) registry.close(state.entry.id)
}

export function SessionDetailDrawerHost() {
  const language = useLanguage()
  const dialog = useDialog()
  const settings = useSettings()
  const titleID = createUniqueId()
  const host = registry.register()
  const copy = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const entry = () => state.entry?.host === host.host ? state.entry : undefined
  let closeButton: HTMLButtonElement | undefined
  const [geometry, setGeometry] = createStore({ top: 0, bottom: 0 })
  let measureFrame: number | undefined
  const measure = () => {
    const viewport = window.visualViewport
    const header = document.querySelector<HTMLElement>('header[data-slot="titlebar-v2"]')
    const rect = header?.getBoundingClientRect()
    setGeometry(sessionDetailInsets({ layoutHeight: window.innerHeight,
      viewportTop: viewport?.offsetTop ?? 0, viewportHeight: viewport?.height ?? window.innerHeight,
      bottomPreference: window.matchMedia("(max-width: 767px)").matches && settings.general.mobileTitlebarPosition() === "bottom",
      header: rect && { top: rect.top, bottom: rect.bottom, height: rect.height },
    }))
  }
  const scheduleMeasure = () => {
    if (measureFrame !== undefined) return
    measureFrame = requestAnimationFrame(() => { measureFrame = undefined; measure() })
  }
  const close = (expected: DetailEntry, restore = true) => {
    const previousFocus = document.activeElement
    const shouldRestore = restore && expected.request.current()
    if (!registry.close(expected.id)) return
    if (shouldRestore && expected.request.origin?.isConnected)
      requestAnimationFrame(() => {
        if (!state.entry && !dialog.active && expected.request.sourceCurrent() && canRestoreSessionDetailFocus(previousFocus))
          expected.request.origin?.focus({ preventScroll: true })
      })
  }
  createEffect(() => {
    if (!entry()) return
    registry.invalidate()
  })
  createEffect(() => {
    const expected = entry()
    if (!expected) return
    scheduleMeasure()
    const previousFocus = document.activeElement
    const frame = requestAnimationFrame(() => {
      if (entry()?.id === expected.id && !dialog.active && expected.request.current() && canRestoreSessionDetailFocus(previousFocus))
        closeButton?.focus({ preventScroll: true })
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  onCleanup(host.dispose)
  createEffect(() => {
    settings.general.mobileTitlebarPosition()
    if (typeof window !== "undefined") scheduleMeasure()
  })
  onMount(() => {
    let observed: HTMLElement | null = null
    const resize = new ResizeObserver(scheduleMeasure)
    const changes = new MutationObserver(scheduleMeasure)
    let discovery: MutationObserver | undefined
    const connect = () => {
      const header = document.querySelector<HTMLElement>('header[data-slot="titlebar-v2"]')
      if (!header || header === observed) return
      observed = header
      resize.disconnect()
      changes.disconnect()
      resize.observe(header)
      changes.observe(header, { attributes: true, attributeFilter: ["class", "style", "data-slot"] })
      discovery?.disconnect()
      scheduleMeasure()
    }
    connect()
    if (!observed) {
      discovery = new MutationObserver(connect)
      discovery.observe(document.body, { childList: true, subtree: true })
    }
    const viewport = () => { connect(); scheduleMeasure() }
    window.addEventListener("resize", viewport)
    window.visualViewport?.addEventListener("resize", viewport)
    window.visualViewport?.addEventListener("scroll", viewport)
    const escape = (event: KeyboardEvent) => {
      const expected = entry()
      if (!expected || dialog.active || event.key !== "Escape" || event.isComposing || event.keyCode === 229) return
      if (!(event.target instanceof Element) || !event.target.closest('[data-component="session-detail-drawer"]')) return
      event.preventDefault()
      event.stopPropagation()
      close(expected)
    }
    document.addEventListener("keydown", escape)
    onCleanup(() => {
      document.removeEventListener("keydown", escape)
      window.removeEventListener("resize", viewport)
      window.visualViewport?.removeEventListener("resize", viewport)
      window.visualViewport?.removeEventListener("scroll", viewport)
      resize.disconnect()
      changes.disconnect()
      discovery?.disconnect()
      if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
    })
  })
  return <Show when={entry()} keyed>{(opened) => <Portal>
    <aside data-component="session-detail-drawer" role="dialog" aria-modal="false" aria-labelledby={titleID}
      style={{ top: `${geometry.top}px`, bottom: `${geometry.bottom}px` }}
      data-session-id={opened.request.sessionID}>
      <header class="session-detail-drawer-header">
        <div class="session-detail-drawer-heading">
          <h2 id={titleID}>{opened.request.title}</h2>
          <p title={`${opened.request.serverLabel} · ${opened.request.directory} · ${opened.request.sessionID}`}>
            {opened.request.serverLabel} · {opened.request.sessionID}
          </p>
        </div>
        <IconButtonV2 ref={closeButton} type="button" variant="ghost-muted" icon={<Icon name="outline-xmark" />}
          aria-label={copy("关闭会话详情", "Close session details")} onClick={() => close(opened)} />
      </header>
      <div class="session-detail-drawer-content">
        <ErrorBoundary fallback={(error) => <div class="session-detail-drawer-error" role="alert">
          <p>{copy("这次详情读取未完成", "Could not load these details")}</p>
          <p>{error instanceof Error ? error.message : String(error)}</p>
        </div>}>
          <Suspense fallback={<p class="session-detail-drawer-loading" role="status">{copy("正在读取当前会话…", "Loading this conversation…")}</p>}>
            <TabsV2 value={opened.request.value} variant="settings" class="session-detail-drawer-tabs">
              <TabsV2.List class="sr-only" aria-label={opened.request.title}>
                <TabsV2.Trigger value={opened.request.value} tabIndex={-1}>{opened.request.title}</TabsV2.Trigger>
              </TabsV2.List>
              {opened.request.content(() => opened.request.value)}
            </TabsV2>
          </Suspense>
        </ErrorBoundary>
      </div>
      <footer class="session-detail-drawer-footer">
        <ButtonV2 type="button" variant="ghost-muted" onClick={() => {
          if (!opened.request.current()) return
          // Keep the detail content and its drafts mounted beneath the full dialog.
          opened.request.fullSettings()
        }}>
          {copy("在完整会话设置中打开", "Open full session settings")}
          <Icon name="outline-square-arrow" />
        </ButtonV2>
      </footer>
    </aside>
  </Portal>}</Show>
}
