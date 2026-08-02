export type SidebarScrollAnchorRow = {
  id: string
  top: number
  bottom: number
}

export type SidebarScrollAnchor = {
  id: string
  offset: number
}

export function visibleSidebarScrollAnchors(
  containerTop: number,
  containerBottom: number,
  rows: SidebarScrollAnchorRow[],
): SidebarScrollAnchor[] {
  return rows
    .filter((row) => row.bottom > containerTop && row.top < containerBottom)
    .sort((a, b) => a.top - b.top)
    .map((row) => ({
      id: row.id,
      offset: row.top - containerTop,
    }))
}

export function anchoredSidebarScrollTop(input: {
  scrollTop: number
  capturedOffset: number
  currentOffset: number
  scrollHeight: number
  clientHeight: number
}) {
  const maximum = Math.max(0, input.scrollHeight - input.clientHeight)
  return Math.min(maximum, Math.max(0, input.scrollTop + input.currentOffset - input.capturedOffset))
}

export function newSidebarSessionIDsBeforeAnchor(previousIDs: string[], currentIDs: string[], anchorID: string) {
  const anchorIndex = currentIDs.indexOf(anchorID)
  if (anchorIndex <= 0) return []

  const previous = new Set(previousIDs)
  return currentIDs.slice(0, anchorIndex).filter((id) => !previous.has(id))
}

type CapturedAnchor = SidebarScrollAnchor & {
  element: HTMLElement
}

export type SidebarNewSessionAbove = {
  container: HTMLDivElement
  target: HTMLElement
  id: string
  ids: string[]
  count: number
}

type SidebarScrollAnchorControllerOptions = {
  enabled?: () => boolean
  onScrollTopChange?: (scrollTop: number) => void
  onNewSessionsAbove?: (notice: SidebarNewSessionAbove) => void
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (frame: number) => void
  now?: () => number
}

const sessionRows = (container: HTMLDivElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-sidebar-session-row]")].flatMap((element) => {
    const id = element.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId
    return id ? [{ id, element }] : []
  })

export function createSidebarScrollAnchorController(options: SidebarScrollAnchorControllerOptions = {}) {
  const containers = new Set<HTMLDivElement>()
  const cleanups = new WeakMap<HTMLDivElement, () => void>()
  const requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame ?? ((frame) => window.cancelAnimationFrame(frame))
  const now = options.now ?? (() => performance.now())
  let suppressedUntil = 0
  let generation = 0

  const cancel = (container: HTMLDivElement) => {
    const cleanup = cleanups.get(container)
    if (cleanup) cleanup()
  }

  const suppress = (duration = 320) => {
    generation += 1
    suppressedUntil = Math.max(suppressedUntil, now() + duration)
    for (const container of containers) cancel(container)
  }

  const preserve = () => {
    if (options.enabled && !options.enabled()) return
    if (now() < suppressedUntil) return

    for (const container of containers) {
      if (
        cleanups.has(container) ||
        container.hasAttribute("data-sidebar-scroll-restoring") ||
        container.hasAttribute("data-sidebar-scroll-anchoring")
      ) {
        continue
      }

      const containerRect = container.getBoundingClientRect()
      if (containerRect.height <= 0) continue
      const rows = sessionRows(container).map(({ id, element }) => {
        const rowRect = element.getBoundingClientRect()
        return { id, element, top: rowRect.top, bottom: rowRect.bottom }
      })
      const capturedRowIDs = rows.map((row) => row.id)
      const visible = visibleSidebarScrollAnchors(containerRect.top, containerRect.bottom, rows)
      if (visible.length === 0) continue
      const elements = new Map(rows.map((row) => [row.id, row.element]))
      const captured: CapturedAnchor[] = visible.flatMap((anchor) => {
        const element = elements.get(anchor.id)
        return element ? [{ ...anchor, element }] : []
      })
      if (captured.length === 0) continue

      const capturedGeneration = generation
      let frame = 0
      let disposed = false
      const cleanup = () => {
        if (disposed) return
        disposed = true
        cancelFrame(frame)
        container.removeAttribute("data-sidebar-scroll-anchoring")
        if (cleanups.get(container) === cleanup) cleanups.delete(container)
      }

      container.setAttribute("data-sidebar-scroll-anchoring", "")
      cleanups.set(container, cleanup)
      frame = requestFrame(() => {
        if (disposed) return
        if (capturedGeneration !== generation || now() < suppressedUntil) {
          cleanup()
          return
        }

        const currentRows = sessionRows(container)
        const anchor = captured
          .map((candidate) => {
            if (container.contains(candidate.element)) return { candidate, element: candidate.element }
            const replacement = currentRows.find((row) => row.id === candidate.id)?.element
            return replacement ? { candidate, element: replacement } : undefined
          })
          .find((candidate) => candidate !== undefined)
        if (!anchor) {
          cleanup()
          return
        }

        const nextContainerRect = container.getBoundingClientRect()
        const anchorRect = anchor.element.getBoundingClientRect()
        if (nextContainerRect.height <= 0 || anchorRect.height <= 0) {
          cleanup()
          return
        }
        const currentOffset = anchorRect.top - nextContainerRect.top
        const nextScrollTop = anchoredSidebarScrollTop({
          scrollTop: container.scrollTop,
          capturedOffset: anchor.candidate.offset,
          currentOffset,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
        })
        if (nextScrollTop !== container.scrollTop) {
          container.scrollTop = nextScrollTop
          options.onScrollTopChange?.(nextScrollTop)
        }

        const newSessionIDs = newSidebarSessionIDsBeforeAnchor(
          capturedRowIDs,
          currentRows.map((row) => row.id),
          anchor.candidate.id,
        )
        const firstNewSession = newSessionIDs.length
          ? currentRows.find((row) => row.id === newSessionIDs[0])
          : undefined
        if (firstNewSession) {
          const targetRect = firstNewSession.element.getBoundingClientRect()
          if (targetRect.bottom <= nextContainerRect.top) {
            options.onNewSessionsAbove?.({
              container,
              target: firstNewSession.element,
              id: firstNewSession.id,
              ids: newSessionIDs,
              count: newSessionIDs.length,
            })
          }
        }
        frame = requestFrame(cleanup)
      })
    }
  }

  const register = (container: HTMLDivElement) => {
    containers.add(container)
    return () => {
      cancel(container)
      containers.delete(container)
    }
  }

  const dispose = () => {
    generation += 1
    for (const container of containers) cancel(container)
    containers.clear()
  }

  return {
    preserve,
    suppress,
    register,
    dispose,
  }
}
