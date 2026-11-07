/** Keep a menu-dismiss gesture from activating the composer button underneath it. */
export function consumePromptMenuOutsidePress(event: PointerEvent, target: Window = window) {
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
