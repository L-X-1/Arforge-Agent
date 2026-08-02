import { observeElementOffset, type Virtualizer } from "@tanstack/solid-virtual"

export function observeElementOffsetReconnectAware<TScrollElement extends Element, TItemElement extends Element>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  callback: (offset: number, isScrolling: boolean) => void,
  createObserver?: (callback: MutationCallback, targetWindow: Window) => MutationObserver,
) {
  let active = true
  const deliver = (offset: number, isScrolling: boolean) => {
    if (!active) return
    callback(offset, isScrolling)
  }
  const cleanupOffset = observeElementOffset(instance, deliver)
  const element = instance.scrollElement
  const targetWindow = instance.targetWindow
  const root = element?.closest("main") ?? element?.ownerDocument.documentElement
  if (!element || !targetWindow || !root)
    return () => {
      active = false
      cleanupOffset?.()
    }

  let frame: number | undefined
  const clearCheck = () => {
    if (frame === undefined) return
    targetWindow.cancelAnimationFrame(frame)
    frame = undefined
  }
  const startCheck = () => {
    clearCheck()
    const deadline = targetWindow.performance.now() + instance.options.isScrollingResetDelay
    let framesAfterDeadline = 0
    const check = (time: number) => {
      frame = undefined
      if (element.isConnected) {
        const offset = instance.options.horizontal
          ? element.scrollLeft * (instance.options.isRtl ? -1 : 1)
          : element.scrollTop
        if (instance.scrollOffset === null || Math.abs(offset - instance.scrollOffset) > 1) deliver(offset, false)
      }
      if (time >= deadline) framesAfterDeadline += 1
      if (framesAfterDeadline >= 2) return
      frame = targetWindow.requestAnimationFrame(check)
    }
    frame = targetWindow.requestAnimationFrame(check)
  }
  const observer = (createObserver ??
    ((handler, win) => new (win as Window & typeof globalThis).MutationObserver(handler)))((records) => {
    if (!active) return
    records.forEach((record) => {
      if (record.target === element || element.contains(record.target)) return
      if (mutationNodesContainElement(record.removedNodes, element)) {
        clearCheck()
      }
      // Some DOM implementations coalesce a synchronous remove/reinsert and
      // only expose the insertion record. The added ancestor is sufficient
      // proof that this scroll element has re-entered the observed tree.
      if (!element.isConnected || !mutationNodesContainElement(record.addedNodes, element)) return
      startCheck()
    })
  }, targetWindow)
  // Session routes are replaced below persistent main. The document element is
  // the fallback for isolated hosts because test/document shells may replace body.
  observer.observe(root, { childList: true, subtree: true })

  return () => {
    active = false
    observer.disconnect()
    clearCheck()
    cleanupOffset?.()
  }
}

export function mutationNodesContainElement(nodes: Iterable<Node>, element: Element) {
  return [...nodes].some((node) => node === element || node.contains(element))
}
