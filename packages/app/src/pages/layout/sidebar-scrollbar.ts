export const SIDEBAR_SCROLLBAR_SCROLL_IDLE_MS = 800
export const SIDEBAR_SCROLL_EDGE_THRESHOLD = 1

type SidebarScrollbarElement = Pick<HTMLElement, "setAttribute" | "removeAttribute"> &
  Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">

export function sidebarScrollEdges(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  threshold?: number
}) {
  const threshold = input.threshold ?? SIDEBAR_SCROLL_EDGE_THRESHOLD
  const maximum = Math.max(0, input.scrollHeight - input.clientHeight)
  return {
    above: maximum > threshold && input.scrollTop > threshold,
    below: maximum > threshold && maximum - input.scrollTop > threshold,
  }
}

type SidebarScrollbarControllerOptions = {
  scrollIdleMs?: number
  schedule?: (callback: () => void, delay: number) => unknown
  cancel?: (handle: unknown) => void
}

export function createSidebarScrollbarController(options: SidebarScrollbarControllerOptions = {}) {
  const scrollIdleMs = options.scrollIdleMs ?? SIDEBAR_SCROLLBAR_SCROLL_IDLE_MS
  const schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay))
  const cancel =
    options.cancel ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>))
  const timers = new Map<SidebarScrollbarElement, unknown>()
  const observations = new Map<HTMLElement, () => void>()

  const update = (element: SidebarScrollbarElement) => {
    const edges = sidebarScrollEdges(element)
    if (edges.above) element.setAttribute("data-sidebar-scroll-above", "")
    else element.removeAttribute("data-sidebar-scroll-above")
    if (edges.below) element.setAttribute("data-sidebar-scroll-below", "")
    else element.removeAttribute("data-sidebar-scroll-below")
    return edges
  }

  const showScrolling = (element: SidebarScrollbarElement) => {
    update(element)
    const previous = timers.get(element)
    if (previous !== undefined) cancel(previous)

    element.setAttribute("data-sidebar-scrollbar-scrolling", "")
    const timer = schedule(() => {
      if (timers.get(element) !== timer) return
      timers.delete(element)
      element.removeAttribute("data-sidebar-scrollbar-scrolling")
    }, scrollIdleMs)
    timers.set(element, timer)
  }

  const observe = (element: HTMLElement) => {
    if (observations.has(element)) return

    const view = element.ownerDocument.defaultView
    let frame: number | undefined
    const refresh = () => {
      if (frame !== undefined) return
      frame = view?.requestAnimationFrame(() => {
        frame = undefined
        update(element)
      })
      if (frame === undefined) update(element)
    }
    const resize = view?.ResizeObserver ? new view.ResizeObserver(refresh) : undefined
    const mutation = view?.MutationObserver
      ? new view.MutationObserver(refresh)
      : typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(refresh)
    resize?.observe(element)
    mutation?.observe(element, {
      attributes: true,
      attributeFilter: ["data-closed", "data-expanded", "style"],
      characterData: true,
      childList: true,
      subtree: true,
    })
    element.addEventListener("animationend", refresh)
    element.addEventListener("transitionend", refresh)
    update(element)

    observations.set(element, () => {
      if (frame !== undefined) view?.cancelAnimationFrame(frame)
      resize?.disconnect()
      mutation?.disconnect()
      element.removeEventListener("animationend", refresh)
      element.removeEventListener("transitionend", refresh)
      element.removeAttribute("data-sidebar-scroll-above")
      element.removeAttribute("data-sidebar-scroll-below")
    })
  }

  const unobserve = (element: HTMLElement) => {
    const cleanup = observations.get(element)
    if (!cleanup) return
    cleanup()
    observations.delete(element)
  }

  const dispose = () => {
    for (const [element, timer] of timers) {
      cancel(timer)
      element.removeAttribute("data-sidebar-scrollbar-scrolling")
    }
    timers.clear()
    for (const element of [...observations.keys()]) unobserve(element)
  }

  return { showScrolling, update, observe, unobserve, dispose }
}
