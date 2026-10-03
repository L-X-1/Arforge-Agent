import { Show, children, createEffect, createMemo, createUniqueId, onCleanup, onMount, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { canRunBrowserCommand } from "./browser-workbench-controls"
import "./preview/workbench-review.css"
import { shouldAcceptBrowserPageState, toWorkbenchBrowserScope, type BrowserBounds, type BrowserPageCommand, type BrowserPageState } from "@/browser-workbench"

const copy = {
  files: "\u6587\u4ef6\u4e0e\u66f4\u6539", browser: "\u6d4f\u89c8\u5668", manual: "\u4eba\u5de5\u6d4f\u89c8", address: "\u7f51\u7ad9\u5730\u5740", open: "\u6253\u5f00",
  back: "\u540e\u9000", forward: "\u524d\u8fdb", reload: "\u5237\u65b0", stop: "\u505c\u6b62", close: "\u5173\u95ed\u9875\u9762",
  loading: "\u6b63\u5728\u52a0\u8f7d\u7f51\u9875", pending: "\u6b63\u5728\u6253\u5f00\u6d4f\u89c8\u5668", retry: "\u91cd\u8bd5",
  empty: "\u8f93\u5165\u5b8c\u6574\u7684 http:// \u6216 https:// \u7f51\u5740\u540e\u6253\u5f00\u3002",
  scope: "\u9875\u9762\u6309\u5f53\u524d\u4f1a\u8bdd\u9694\u79bb\uff0c\u4ec5\u4e34\u65f6\u4fdd\u7559\u3002\u6700\u591a\u4fdd\u7559 4 \u4e2a\u4f1a\u8bdd\u7f51\u9875\uff1b\u5173\u95ed\u9875\u9762\u4f1a\u6e05\u9664\u8be5\u9875\u4f1a\u8bdd\u3002\u4e0d\u5411 AI \u63d0\u4f9b\u9875\u9762\u5185\u5bb9\u3002",
  failure: "\u6d4f\u89c8\u5668\u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002", paused: "\u5e94\u7528\u5f39\u7a97\u663e\u793a\u671f\u95f4\uff0c\u7f51\u9875\u4f1a\u6682\u65f6\u9690\u85cf\u3002",
}
const button = "min-h-8 rounded px-2 text-12-medium text-text-base hover:bg-surface-raised-base disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2"
const overlays = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-component="dialog-overlay"]'

export function WorkbenchBrowserPanel(props: { scope?: string; blocked?: boolean; children: JSX.Element }) {
  const platform = usePlatform()
  const api = platform.browserWorkbench
  const scopeKey = createMemo(() => props.scope ? toWorkbenchBrowserScope(props.scope) : undefined)
  const content = children(() => props.children)
  const addressID = "workbench-browser-address-" + createUniqueId()
  const [state, setState] = createStore<{
    mode: "files" | "browser"; opening: boolean; busy: boolean; address: string; error: string; page?: BrowserPageState
    layoutAttempt: number; closeFailed: boolean; lastCommand?: BrowserPageCommand
  }>({ mode: "files", opening: false, busy: false, address: "", error: "", layoutAttempt: 0, closeFailed: false })
  let generation = 0
  let commandSequence = 0
  let disposed = false
  let viewport: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined

  const hide = (page: Pick<BrowserPageState, "scope" | "pageID"> | undefined) => {
    if (page) void api?.layout(page.scope, page.pageID, null).catch(() => undefined)
  }
  const failure = (error: unknown) => error instanceof Error ? error.message : copy.failure

  createEffect(() => {
    scopeKey()
    untrack(() => {
      generation++
      commandSequence++
      hide(state.page)
      setState({ mode: "files", opening: false, busy: false, address: "", error: "", page: undefined, closeFailed: false, lastCommand: undefined })
    })
  })

  onMount(() => {
    const unsubscribe = api?.subscribe((next) => {
      if (disposed || !shouldAcceptBrowserPageState(state.page, next, scopeKey())) return
      setState("page", next)
      if (document.activeElement !== input) setState("address", next.url)
    })
    onCleanup(() => { disposed = true; generation++; hide(state.page); unsubscribe?.() })
  })

  const openBrowser = async () => {
    const scope = scopeKey()
    if (!api || !scope || state.opening) return
    if (state.page) {
      setState("mode", "browser")
      queueMicrotask(() => input?.focus())
      return
    }
    const current = generation
    setState({ mode: "browser", opening: true, error: "" })
    try {
      const page = await api.open(scope)
      if (disposed || current !== generation) { hide(page); return }
      setState({ page, address: page.url })
      queueMicrotask(() => input?.focus())
    } catch (error) {
      if (!disposed && current === generation) setState("error", failure(error))
    } finally {
      if (!disposed && current === generation) setState("opening", false)
    }
  }

  const command = async (action: BrowserPageCommand) => {
    const page = state.page
    if (!api || !page || !canRunBrowserCommand(state.busy, action)) return
    const current = generation
    const sequence = ++commandSequence
    const id = page.pageID
    setState({ busy: true, error: "", closeFailed: false, lastCommand: action })
    try {
      const next = await api.command(page.scope, id, action)
      if (disposed || current !== generation || sequence !== commandSequence || state.page?.pageID !== id) return
      if (shouldAcceptBrowserPageState(state.page, next, scopeKey())) {
        setState("page", next)
        if (document.activeElement !== input) setState("address", next.url)
      }
    } catch (error) {
      if (!disposed && current === generation && sequence === commandSequence) setState("error", failure(error))
    } finally {
      if (!disposed && current === generation && sequence === commandSequence) setState("busy", false)
    }
  }

  const close = async () => {
    const page = state.page
    if (!api || !page || state.busy) return
    const current = generation
    hide(page)
    setState({ busy: true, closeFailed: false, error: "" })
    try {
      await api.close(page.scope, page.pageID)
      if (!disposed && current === generation) setState({ mode: "files", page: undefined, address: "", error: "" })
    } catch (error) {
      if (!disposed && current === generation) setState({ error: failure(error), closeFailed: true, layoutAttempt: state.layoutAttempt + 1 })
    } finally {
      if (!disposed && current === generation) setState("busy", false)
    }
  }

  createEffect(() => {
    state.layoutAttempt
    const page = state.page
    const scope = page?.scope
    const pageID = page?.pageID
    const visible = state.mode === "browser" && scopeKey() === scope && !props.blocked
    platform.webviewZoom?.()
    if (!api || !scope || !pageID) return
    if (!visible) { hide(page); return }
    let frame: number | undefined
    let last = ""
    let stopped = false
    const send = (bounds: BrowserBounds | null) => {
      const key = JSON.stringify(bounds)
      if (key === last) return
      last = key
      void api.layout(scope, pageID, bounds).catch((error) => {
        if (!stopped && state.page?.pageID === pageID) {
          setState("error", failure(error))
        }
      })
    }
    const update = () => {
      frame = undefined
      if (stopped || !viewport || !viewport.isConnected || document.visibilityState === "hidden") { send(null); return }
      const covered = [...document.querySelectorAll<HTMLElement>(overlays)].some((element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
      )
      const rect = viewport.getBoundingClientRect()
      if (covered || rect.width < 2 || rect.height < 2) { send(null); return }
      // Native views sit above DOM. Do not place one over a host overlay or a
      // clipped/off-screen panel, even when its stored rectangle is non-empty.
      const points = [[rect.left + 1, rect.top + 1], [rect.right - 1, rect.top + 1],
        [rect.left + 1, rect.bottom - 1], [rect.right - 1, rect.bottom - 1], [rect.left + rect.width / 2, rect.top + rect.height / 2]]
      if (points.some(([x, y]) => !viewport!.contains(document.elementFromPoint(x!, y!)))) { send(null); return }
      send({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update) }
    const remeasure = () => { last = ""; schedule() }
    const resize = new ResizeObserver(() => { send(null); schedule() })
    if (viewport) resize.observe(viewport)
    const mutation = new MutationObserver(schedule)
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-state"] })
    window.addEventListener("resize", remeasure)
    window.addEventListener("focus", remeasure)
    document.addEventListener("visibilitychange", remeasure)
    document.addEventListener("scroll", schedule, true)
    schedule()
    onCleanup(() => {
      stopped = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
      window.removeEventListener("resize", remeasure)
      window.removeEventListener("focus", remeasure)
      document.removeEventListener("visibilitychange", remeasure)
      document.removeEventListener("scroll", schedule, true)
      hide({ scope, pageID })
    })
  })

  return (
    <Show when={api && scopeKey()} fallback={content()}>
      <div data-component="workbench-browser-panel" class="flex size-full min-h-0 min-w-0 flex-col">
        <div class="flex shrink-0 items-center gap-1 border-b border-border-weak-base px-2 py-1" role="group" aria-label={copy.browser}>
          <button type="button" class={button} aria-pressed={state.mode === "files"} onClick={() => setState("mode", "files")}>{copy.files}</button>
          <button type="button" class={button} aria-pressed={state.mode === "browser"} disabled={state.opening} onClick={() => void openBrowser()}>{copy.browser}</button>
          <Show when={state.mode === "browser"}><span class="ml-auto text-12-regular text-text-weak">{copy.manual}</span></Show>
        </div>
        <div class="min-h-0 flex-1" classList={{ hidden: state.mode !== "files" }} inert={state.mode !== "files" || undefined}>{content()}</div>
        <Show when={state.mode === "browser"}>
          <section class="flex min-h-0 flex-1 flex-col overflow-hidden" aria-label={copy.browser}>
            <form class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-weak-base p-2" onSubmit={(event) => { event.preventDefault(); void command({ action: "navigate", url: state.address }) }}>
              <label for={addressID} class="w-full text-12-medium text-text-weak">{copy.address}</label>
              <input ref={input} id={addressID} type="url" required maxlength={8192} autocomplete="off" spellcheck={false} placeholder="https://example.com"
                class="h-9 min-w-0 flex-1 rounded border border-border-weak-base bg-transparent px-2 text-13-regular text-text-base focus-visible:outline-2"
                value={state.address} disabled={!state.page || state.opening} onInput={(event) => setState("address", event.currentTarget.value)} />
              <button type="submit" class={button} disabled={!state.page || state.busy || !state.address.trim()}>{copy.open}</button>
              <div class="flex w-full flex-wrap gap-1">
                <button type="button" class={button} disabled={!state.page?.canGoBack || state.busy} onClick={() => void command({ action: "back" })}>{copy.back}</button>
                <button type="button" class={button} disabled={!state.page?.canGoForward || state.busy} onClick={() => void command({ action: "forward" })}>{copy.forward}</button>
                <button type="button" class={button} disabled={!state.page || state.busy} onClick={() => void command({ action: "reload" })}>{copy.reload}</button>
                <button type="button" class={button} disabled={!state.page || (!state.page.loading && !state.busy)} onClick={() => void command({ action: "stop" })}>{copy.stop}</button>
                <button type="button" class={button} disabled={!state.page || state.busy} onClick={() => void close()}>{copy.close}</button>
                <Show when={state.page?.loading}><span role="status" class="self-center text-12-regular text-text-weak">{copy.loading}</span></Show>
              </div>
            </form>
            <p class="m-0 shrink-0 px-3 py-2 text-12-regular text-text-weak">{copy.scope}</p>
            <Show when={state.error || state.page?.notice}>
              <div role="alert" class="shrink-0 px-3 py-2 text-12-regular text-text-base">
                {state.error || state.page?.notice}
                <button type="button" class={button} disabled={state.opening || state.busy} onClick={() => {
                  setState("layoutAttempt", state.layoutAttempt + 1)
                  if (state.closeFailed) void close()
                  else if (state.page) void command(state.lastCommand ?? { action: "reload" })
                  else void openBrowser()
                }}>{copy.retry}</button>
              </div>
            </Show>
            <div ref={viewport} data-browser-viewport class="relative min-h-0 flex-1 overflow-hidden bg-background-base">
              <p class="p-4 text-13-regular text-text-weak">{state.opening ? copy.pending : props.blocked ? copy.paused : copy.empty}</p>
            </div>
          </section>
        </Show>
      </div>
    </Show>
  )
}
