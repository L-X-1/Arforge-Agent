import { createEffect, createMemo, createUniqueId, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { historyDestination, historyExcerpt, historyWindow, type HistoryEntry } from "./history-rail-model"
import { createHistoryPreviewTimers } from "./history-rail-preview"
import "./history-rail.css"

export function HistoryRail(props: {
  entries: readonly HistoryEntry[]
  activeID?: string
  scope?: unknown
  locale: string
  reply: (id: string) => string
  replying?: (id: string) => boolean
  onSelect: (id: string) => void | boolean | Promise<void | boolean>
  hasOlder?: boolean
  loading?: boolean
  onLoadOlder?: () => Promise<void>
}) {
  const previewID = createUniqueId()
  const buttons = new Map<string, HTMLButtonElement>()
  const [state, setState] = createStore({
    previewID: undefined as string | undefined,
    focusID: undefined as string | undefined,
    windowStart: undefined as number | undefined,
    top: 0,
    left: 0,
    capacity: 28,
    fetching: false,
    jumping: false,
    error: false,
    jumpError: false,
  })
  let rail: HTMLElement | undefined
  let card: HTMLDivElement | undefined
  let touch = false
  let returningFocus = false
  let focusFrame: number | undefined
  let disposed = false
  let generation = 0
  const chinese = () => props.locale.startsWith("zh")
  const label = (zh: string, en: string) => chinese() ? zh : en
  const entryByID = createMemo(() => new Map(props.entries.map((entry) => [entry.id, entry])))
  const activeIndex = createMemo(() => {
    const index = props.entries.findIndex((entry) => entry.id === props.activeID)
    return index < 0 ? Math.max(0, props.entries.length - 1) : index
  })
  const range = createMemo(() => {
    if (state.windowStart === undefined) return historyWindow(props.entries.length, activeIndex(), state.capacity)
    const start = Math.max(0, Math.min(state.windowStart, props.entries.length - state.capacity))
    return { start, end: Math.min(props.entries.length, start + state.capacity) }
  })
  const visible = createMemo(() => props.entries.slice(range().start, range().end))
  const focusID = createMemo(() => {
    if (visible().some((entry) => entry.id === state.focusID)) return state.focusID
    return visible().find((entry) => entry.id === props.activeID)?.id ?? visible()[0]?.id
  })
  const preview = createMemo(() => state.previewID ? entryByID().get(state.previewID) : undefined)
  // Read only the requested reply so streamed deltas do not scan every history turn.
  const reply = createMemo(() => preview() ? historyExcerpt(props.reply(preview()!.id), 1200) : "")
  const timers = createHistoryPreviewTimers(() => setState("previewID", undefined))
  const hide = () => timers.close()
  const restoreEntry = () => {
    const button = buttons.get(state.previewID ?? state.focusID ?? "")
    hide()
    returningFocus = true
    button?.focus({ preventScroll: true })
    returningFocus = false
  }
  const position = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect()
    const viewport = window.visualViewport
    const originX = viewport?.offsetLeft ?? 0
    const originY = viewport?.offsetTop ?? 0
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight
    const cardWidth = Math.min(380, width - 32)
    setState({
      left: Math.max(originX + 8, Math.min(rect.right + 12, originX + width - cardWidth - 16)),
      top: Math.max(originY + 8, Math.min(rect.top - 24, originY + height - (card?.offsetHeight ?? 300) - 8)),
    })
  }
  const show = (entry: HistoryEntry, button: HTMLButtonElement, immediate = false, persistent = false) => {
    const request = generation
    const reveal = () => {
      if (disposed || request !== generation || !button.isConnected || !entryByID().has(entry.id)) return
      setState({ previewID: entry.id, jumpError: false })
      position(button)
    }
    if (immediate) timers.open(reveal, persistent)
    else if (state.previewID === entry.id) timers.keepOpen()
    else timers.hover(reveal)
  }
  const focus = (index: number) => {
    const entry = props.entries[index]
    if (!entry) return
    setState({ windowStart: historyWindow(props.entries.length, index, state.capacity).start, focusID: entry.id })
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      buttons.get(entry.id)?.focus({ preventScroll: true })
    })
  }
  const keyDown = (event: KeyboardEvent, entry: HistoryEntry) => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      restoreEntry()
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const next = historyDestination(event.key, props.entries.indexOf(entry), props.entries.length, state.capacity)
    if (next === undefined) return
    event.preventDefault()
    focus(next)
  }
  const select = async (id: string) => {
    if (state.jumping || !entryByID().has(id)) return
    const request = generation
    timers.keepOpen()
    setState({ jumping: true, jumpError: false })
    try {
      const result = await props.onSelect(id)
      if (disposed || generation !== request) return
      if (result === false) {
        setState("jumpError", true)
        return
      }
      const restore = !!card?.contains(document.activeElement)
      setState({ focusID: id, windowStart: undefined })
      hide()
      if (restore) {
        returningFocus = true
        buttons.get(id)?.focus({ preventScroll: true })
        returningFocus = false
      }
    } catch {
      if (!disposed && generation === request) setState("jumpError", true)
    } finally {
      if (!disposed && generation === request) setState("jumping", false)
    }
  }
  const loadOlder = async () => {
    if (state.fetching || props.loading || !props.onLoadOlder) return
    const request = generation
    hide()
    setState({ fetching: true, error: false })
    try {
      await props.onLoadOlder()
      if (!disposed && generation === request) setState("windowStart", 0)
    } catch {
      if (!disposed && generation === request) setState("error", true)
    } finally {
      if (!disposed && generation === request) setState("fetching", false)
    }
  }
  createEffect(on(() => props.scope, () => {
    generation++
    hide()
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    setState({ focusID: undefined, windowStart: undefined, fetching: false, jumping: false, error: false, jumpError: false })
  }, { defer: true }))
  createEffect(() => {
    if (state.previewID && !entryByID().has(state.previewID)) hide()
  })
  onMount(() => {
    const coarse = window.matchMedia("(pointer: coarse)")
    const resize = () => {
      const available = Math.max(44, (rail?.clientHeight ?? 500) - 140)
      setState("capacity", Math.max(1, Math.min(28, Math.floor(available / (coarse.matches ? 44 : 14)))))
      const button = buttons.get(state.previewID ?? "")
      if (button) position(button)
    }
    const observer = new ResizeObserver(resize)
    if (rail) observer.observe(rail)
    resize()
    window.addEventListener("resize", resize)
    window.visualViewport?.addEventListener("resize", resize)
    coarse.addEventListener("change", resize)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", resize)
      window.visualViewport?.removeEventListener("resize", resize)
      coarse.removeEventListener("change", resize)
    })
  })
  createEffect(() => {
    if (!state.previewID) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && (rail?.contains(event.target) || card?.contains(event.target))) return
      hide()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopPropagation()
      restoreEntry()
    }
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("keydown", escape, true)
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("keydown", escape, true)
    })
  })
  onCleanup(() => {
    disposed = true
    generation++
    timers.dispose()
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    buttons.clear()
  })

  return (
    <Show when={props.entries.length > 0 || props.hasOlder}>
      <nav
        ref={rail}
        data-component="session-history-rail"
        aria-label={label("当前会话历史提问", "Prompts in this conversation")}
        aria-busy={props.loading || state.fetching || undefined}
        onPointerLeave={() => timers.leave()}
      >
        <Show when={props.hasOlder && props.onLoadOlder}>
          <button type="button" class="history-rail-action" data-history-load-older
            disabled={props.loading || state.fetching}
            aria-label={label("加载更早的提问", "Load earlier prompts")}
            onClick={() => void loadOlder()}
          >{props.loading || state.fetching ? "\u2026" : "+"}</button>
        </Show>
        <Show when={range().start > 0}>
          <button type="button" class="history-rail-action"
            aria-label={label("上一组提问", "Previous prompts")}
            onClick={() => focus(Math.max(0, range().start - 1))}
          >{"\u2039"}</button>
        </Show>
        <div class="history-rail-marks">
          <For each={visible()}>
            {(entry) => {
              onCleanup(() => buttons.delete(entry.id))
              return (
                <button
                  ref={(element) => buttons.set(entry.id, element)}
                  type="button" class="history-rail-mark"
                  data-history-message-id={entry.id}
                  aria-label={label("提问：", "Prompt: ") + historyExcerpt(entry.text, 120)}
                  aria-current={props.entries[activeIndex()]?.id === entry.id ? "location" : undefined}
                  aria-haspopup="dialog"
                  aria-expanded={preview()?.id === entry.id}
                  aria-controls={preview()?.id === entry.id ? previewID : undefined}
                  tabIndex={focusID() === entry.id ? 0 : -1}
                  onPointerDown={(event) => { touch = event.pointerType !== "mouse" }}
                  onPointerEnter={(event) => {
                    if (event.pointerType === "mouse") show(entry, event.currentTarget)
                  }}
                  onFocus={(event) => {
                    setState("focusID", entry.id)
                    if (!touch && !returningFocus) show(entry, event.currentTarget, true)
                  }}
                  onBlur={(event) => {
                    if (event.relatedTarget instanceof Node && card?.contains(event.relatedTarget)) return
                    timers.leave()
                  }}
                  onKeyDown={(event) => {
                    touch = false
                    keyDown(event, entry)
                  }}
                  onClick={(event) => {
                    if (touch && event.detail !== 0) {
                      show(entry, event.currentTarget, true, true)
                      return
                    }
                    void select(entry.id)
                  }}
                ><span aria-hidden="true" /></button>
              )
            }}
          </For>
        </div>
        <Show when={range().end < props.entries.length}>
          <button type="button" class="history-rail-action"
            aria-label={label("下一组提问", "Next prompts")}
            onClick={() => focus(range().end)}
          >{"\u203a"}</button>
        </Show>
        <Show when={state.error}>
          <span class="history-rail-error" role="alert">{label("历史提问加载失败，请重试", "Could not load earlier prompts. Please retry.")}</span>
        </Show>
      </nav>
      <Show when={preview()}>
        {(entry) => (
          <Portal>
            <div ref={card} id={previewID} role="dialog" aria-modal="false"
              aria-label={label("历史提问预览", "Prompt preview")}
              data-component="history-rail-preview"
              style={{ top: state.top + "px", left: state.left + "px" }}
              onPointerEnter={() => timers.keepOpen()}
              onPointerLeave={() => timers.leave()}
              onFocusIn={() => timers.keepOpen()}
              onFocusOut={(event) => {
                if (event.relatedTarget instanceof Node && (card?.contains(event.relatedTarget) || rail?.contains(event.relatedTarget))) return
                timers.leave()
              }}
            >
              <div class="history-rail-preview-title">{historyExcerpt(entry().text, 1000)}</div>
              <div class="history-rail-preview-reply">{reply() || label("暂无回复", "No reply yet")}</div>
              <Show when={props.replying?.(entry().id)}>
                <div class="history-rail-preview-hint" role="status">{label("正在回复", "Replying")}</div>
              </Show>
              <Show when={state.jumpError}>
                <div role="alert">{label("未能定位这次提问，请重试", "Could not locate this prompt. Please retry.")}</div>
              </Show>
              <div class="history-rail-preview-actions">
                <button type="button" disabled={state.jumping} data-history-jump onClick={() => void select(entry().id)}>
                  {state.jumping ? label("正在定位", "Locating") : label("跳转到这次提问", "Jump to prompt")}
                </button>
                <button type="button" data-history-close onClick={restoreEntry}>{label("关闭", "Close")}</button>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </Show>
  )
}
