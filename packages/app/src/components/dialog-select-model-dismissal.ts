export type FrameScheduler = (callback: FrameRequestCallback) => number

/**
 * Run menu follow-up work after the controlled close state has propagated.
 *
 * Kobalte may keep closed presence content mounted, so disconnection is not a
 * valid completion signal. The desktop close CSS is synchronous; two frames
 * provide a bounded hand-off for focus and controlled-state updates.
 */
export const afterModelMenuClose = (
  callback: () => void,
  schedule: FrameScheduler = requestAnimationFrame,
) => {
  schedule(() => schedule(callback))
}

export const modelPickerComposing = (event: Pick<KeyboardEvent, "isComposing" | "keyCode">, composing = false) =>
  composing || event.isComposing || event.keyCode === 229

/** Consume the entire dismissal gesture, including the click after unmount. */
export function consumeModelOutsidePress(event: PointerEvent, target: Window = window) {
  event.preventDefault()
  event.stopImmediatePropagation()
  let timer: ReturnType<typeof setTimeout>
  const cleanup = () => {
    clearTimeout(timer)
    target.removeEventListener("pointerdown", cleanup, true)
    target.removeEventListener("pointerup", consume, true)
    target.removeEventListener("mouseup", consume, true)
    target.removeEventListener("click", consume, true)
    target.removeEventListener("contextmenu", consume, true)
  }
  const consume = (next: Event) => {
    next.preventDefault()
    next.stopImmediatePropagation()
    if (next.type === "click" || next.type === "contextmenu") cleanup()
  }
  target.addEventListener("pointerdown", cleanup, true)
  target.addEventListener("pointerup", consume, true)
  target.addEventListener("mouseup", consume, true)
  target.addEventListener("click", consume, true)
  target.addEventListener("contextmenu", consume, true)
  timer = setTimeout(cleanup, 1000)
  return cleanup
}

export function captureModelComposerSelection(doc: Document = document) {
  const selection = doc.getSelection()
  const anchor = selection?.anchorNode
  const focus = selection?.focusNode
  const element = anchor instanceof Element ? anchor : anchor?.parentElement
  const editor = element?.closest<HTMLElement>("[contenteditable='true'], [contenteditable='']")
  if (!selection || !anchor || !focus || !editor || !editor.contains(focus)) return
  const anchorOffset = selection.anchorOffset
  const focusOffset = selection.focusOffset
  return () => {
    if (!editor.isConnected || !anchor.isConnected || !focus.isConnected) return false
    editor.focus({ preventScroll: true })
    doc.getSelection()?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
    return true
  }
}

export function focusModelPickerOrigin(origin?: HTMLElement, doc: Document = document) {
  if (origin?.isConnected) {
    origin.focus({ preventScroll: true })
    return
  }
  const fallback = doc.querySelector<HTMLElement>("main [contenteditable='true'], main [role='textbox'], main")
  if (!fallback) return
  const temporary = !fallback.hasAttribute("tabindex") && fallback.tagName === "MAIN"
  if (temporary) fallback.tabIndex = -1
  fallback.focus({ preventScroll: true })
  if (temporary) fallback.addEventListener("blur", () => fallback.removeAttribute("tabindex"), { once: true })
}
