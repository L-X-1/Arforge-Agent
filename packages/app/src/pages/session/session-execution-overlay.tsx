import { onCleanup, onMount, type ParentProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { canRestoreSessionDetailFocus } from "@/components/session/session-detail-drawer-state"
import "./session-execution-overlay.css"

export function SessionExecutionOverlay(props: ParentProps<{
  narrow: boolean
  origin?: HTMLElement
  current: () => boolean
  onClose: () => void
}>) {
  const language = useLanguage()
  let root: HTMLDivElement | undefined
  let focusFrame: number | undefined
  onMount(() => {
    const previous = document.activeElement
    focusFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => {
        if (!props.narrow || !props.current()) return
        if (document.activeElement !== props.origin && !canRestoreSessionDetailFocus(previous)) return
        const close = root?.querySelector<HTMLElement>('.execution-dock__header-actions [aria-controls="execution-trace-content"]')
        ;(close ?? root)?.focus({ preventScroll: true })
      })
    })
  })
  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    const previous = document.activeElement
    const origin = props.origin
    if (!origin?.isConnected || (previous !== document.body && !root?.contains(previous))) return
    requestAnimationFrame(() => {
      // Reading the reactive session owner during cleanup can re-enter route disposal.
      if (props.current() && origin.isConnected && canRestoreSessionDetailFocus(previous)) origin.focus({ preventScroll: true })
    })
  })
  const keyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
      return
    }
    if (event.key !== "Tab" || !props.narrow || !root) return
    const controls = [...root.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])')]
      .filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest("[inert]"))
    const target = event.shiftKey ? controls.at(-1) : controls[0]
    const boundary = event.shiftKey ? controls[0] : controls.at(-1)
    if (document.activeElement !== root && document.activeElement !== boundary) return
    event.preventDefault()
    ;(target ?? root).focus()
  }
  return <div ref={root} data-component="session-execution-overlay" data-narrow={props.narrow ? "" : undefined}
    role={props.narrow ? "dialog" : undefined} aria-modal={props.narrow ? "true" : undefined}
    aria-label={props.narrow ? language.locale().startsWith("zh") ? "执行详情" : "Execution details" : undefined}
    tabIndex={-1} onKeyDown={keyDown}>
    {props.children}
  </div>
}
