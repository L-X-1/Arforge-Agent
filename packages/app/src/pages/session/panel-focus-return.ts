import { createEffect, onCleanup } from "solid-js"

type FocusCycle = {
  source: unknown
  scope: string
  path: string
  opener?: HTMLElement
  region?: HTMLElement
  workspace?: HTMLElement
  movedOutside: boolean
}

type PanelFocusInput = {
  opened: () => boolean
  /** Authoritative state when this component's own memos have already been disposed. */
  readOpened?: () => boolean
  source: () => unknown
  scope: () => string
  region: () => HTMLElement | undefined
}

type ScheduleFocus = (callback: () => void) => () => void

/** Keep a close/unmount handoff alive for one frame, never across a source or focus change. */
export function createPanelFocusReturn(input: PanelFocusInput, schedule?: ScheduleFocus) {
  if (typeof document === "undefined") return
  const doc = document
  const win = doc.defaultView
  if (!win) return
  const enqueue: ScheduleFocus =
    schedule ??
    ((callback) => {
      const frame = win.requestAnimationFrame(callback)
      return () => win.cancelAnimationFrame(frame)
    })
  let cycle: FocusCycle | undefined
  let opened = false
  let disposed = false
  let cancelFrame: (() => void) | undefined
  let pending = false

  const neutral = (element: Element | null) => !element || element === doc.body || element === doc.documentElement
  const region = () => {
    const next = input.region()
    if (cycle && next) {
      cycle.region = next
      cycle.workspace ??= next.closest<HTMLElement>("#workspace-main") ?? undefined
    }
    return next ?? cycle?.region
  }
  const current = (target: FocusCycle) => {
    try {
      return input.source() === target.source && input.scope() === target.scope && win.location.pathname === target.path
    } catch {
      return false
    }
  }
  const available = (element: HTMLElement | undefined): element is HTMLElement => {
    if (!element?.isConnected || element.ownerDocument !== doc || neutral(element)) return false
    if (
      element.closest('[hidden], [inert], [aria-hidden="true"]') ||
      element.matches(':disabled, [aria-disabled="true"]')
    )
      return false
    const style = win.getComputedStyle(element)
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0
  }
  const stop = () => {
    doc.removeEventListener("focusin", focusChanged, true)
    doc.removeEventListener("pointerdown", pointerChanged, true)
    win.removeEventListener("blur", blurred)
  }
  const cancel = () => {
    cancelFrame?.()
    cancelFrame = undefined
    pending = false
    if (disposed) stop()
  }
  const focusChanged = (event: FocusEvent) => {
    if (!cycle) return
    if (region()?.contains(event.target as Node)) {
      if (opened) cycle.movedOutside = false
      return
    }
    // The browser falling back to body on removal is neutral; a real focus move is not.
    if (neutral(event.target as Element)) return
    if (pending) cancel()
    else if (opened) cycle.movedOutside = true
  }
  const pointerChanged = (event: PointerEvent) => {
    if (!cycle || region()?.contains(event.target as Node)) return
    if (pending) cancel()
    else if (opened) cycle.movedOutside = true
  }
  const blurred = () => {
    if (pending) cancel()
    else if (cycle) cycle.movedOutside = true
  }
  const restore = () => {
    const target = cycle
    const container = region()
    if (!target || pending || target.movedOutside || !current(target)) return
    if (!neutral(doc.activeElement) && !container?.contains(doc.activeElement)) return
    pending = true
    cancelFrame = enqueue(() => {
      pending = false
      cancelFrame = undefined
      try {
        if (cycle !== target || !current(target) || (input.readOpened?.() ?? input.opened()) || target.movedOutside)
          return
        if (!neutral(doc.activeElement) && !target.region?.contains(doc.activeElement)) return
        const candidates = [
          target.opener,
          ...Array.from(
            target.workspace?.querySelectorAll<HTMLElement>(
              '[data-slot="prompt-input-editor"][contenteditable="true"], [data-component="prompt-input"][contenteditable="true"]',
            ) ?? [],
          ),
        ]
        for (const candidate of candidates) {
          if (!available(candidate) || target.region?.contains(candidate)) continue
          candidate.focus({ preventScroll: true })
          if (doc.activeElement === candidate) break
        }
      } finally {
        if (disposed) stop()
      }
    })
  }
  const sync = (next = input.opened()) => {
    // Track the accessors even before an opening; a source change invalidates the entire cycle.
    input.source()
    input.scope()
    if (cycle && !current(cycle)) {
      cancel()
      cycle = undefined
      opened = next
      return
    }
    if (next && !opened) {
      cancel()
      const active = doc.activeElement
      cycle = {
        source: input.source(),
        scope: input.scope(),
        path: win.location.pathname,
        opener:
          active instanceof HTMLElement && !neutral(active) && !input.region()?.contains(active) ? active : undefined,
        movedOutside: false,
      }
    }
    region()
    if (!next && opened) restore()
    opened = next
  }

  doc.addEventListener("focusin", focusChanged, true)
  doc.addEventListener("pointerdown", pointerChanged, true)
  win.addEventListener("blur", blurred)
  // Capture before child PTY/editor mount effects can move focus into the panel.
  sync()
  createEffect(() => sync())
  onCleanup(() => {
    // A still-open panel being disposed is navigation/remount, not a collapse.
    if (!(input.readOpened?.() ?? input.opened())) sync(false)
    else cancel()
    disposed = true
    if (!pending) stop()
  })
}
