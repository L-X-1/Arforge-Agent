type PageEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">

// A captured request belongs to one visible page lifetime. It must not become
// current again if the same document is restored from the back/forward cache.
export function createRequestLifetime(target?: PageEvents, onResume: () => void = () => {}) {
  let disposed = false
  let hidden = false
  let generation = 0
  const active = () => !disposed && !hidden
  const hide = () => {
    if (disposed) return
    hidden = true
    generation++
  }
  const show = () => {
    if (disposed || !hidden) return
    hidden = false
    generation++
    onResume()
  }
  target?.addEventListener("pagehide", hide)
  target?.addEventListener("pageshow", show)

  return {
    active,
    capture() {
      const captured = generation
      return () => active() && generation === captured
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      target?.removeEventListener("pagehide", hide)
      target?.removeEventListener("pageshow", show)
    },
  }
}
