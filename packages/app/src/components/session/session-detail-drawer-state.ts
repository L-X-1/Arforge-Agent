/** One window-local detail surface. An old close/read can never own a newer opening. */
export function createSessionDetailRegistry<T extends { scope: string; current: () => boolean; onClose?: () => void }>(
  publish: (entry: { id: number; host: number; request: T } | undefined) => void,
) {
  const hosts = new Set<number>()
  let sequence = 0
  let active: { id: number; host: number; request: T } | undefined
  return {
    register() {
      const host = ++sequence
      hosts.add(host)
      return { host, dispose() {
        hosts.delete(host)
        if (active?.host !== host) return
        const previous = active
        active = undefined
        publish(undefined)
        previous.request.onClose?.()
      } }
    },
    present(request: T) {
      const host = [...hosts].at(-1)
      if (host === undefined || !request.current()) return false
      const previous = active
      active = { id: ++sequence, host, request }
      publish(active)
      previous?.request.onClose?.()
      return true
    },
    close(id: number) {
      if (active?.id !== id) return false
      const previous = active
      active = undefined
      publish(undefined)
      previous.request.onClose?.()
      return true
    },
    invalidate() {
      if (!active || active.request.current()) return
      const previous = active
      active = undefined
      publish(undefined)
      previous.request.onClose?.()
    },
  }
}

export function sessionDetailInsets(input: {
  layoutHeight: number
  viewportTop: number
  viewportHeight: number
  bottomPreference: boolean
  header?: { top: number; bottom: number; height: number }
}) {
  const top = Math.max(0, input.viewportTop)
  const end = Math.min(input.layoutHeight, top + input.viewportHeight)
  const keyboard = Math.max(0, input.layoutHeight - end)
  const rect = input.header
  if (!rect || rect.height <= 0) return input.bottomPreference
    ? { top, bottom: keyboard + 44 }
    : { top: top + 44, bottom: keyboard }
  if (rect.bottom <= top || rect.top >= end) return { top, bottom: keyboard }
  const bottom = rect.top > top + input.viewportHeight / 2
  return bottom
    ? { top, bottom: Math.max(keyboard, input.layoutHeight - rect.top) }
    : { top: Math.max(top, rect.bottom), bottom: keyboard }
}

/** Closing must not reclaim focus after the user deliberately focuses another control. */
export function canRestoreSessionDetailFocus(previous: Element | null, doc: Document = document) {
  const active = doc.activeElement
  return !active || active === doc.body || active === doc.documentElement || active === previous
}
