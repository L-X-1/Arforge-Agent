import { splitProps, type JSX } from "solid-js"
import { resizeHandleKeyboardSize } from "./resize-handle-keyboard"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  /** Called while dragging when size crosses `collapseThreshold`. */
  onCollapseChange?: (collapsed: boolean) => void
  collapseThreshold?: number
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "onCollapseChange",
    "collapseThreshold",
    "class",
    "classList",
  ])

  const handleKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    const handler = rest.onKeyDown
    if (Array.isArray(handler)) handler[0](handler[1], event)
    else if (typeof handler === "function") handler(event)
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const size = resizeHandleKeyboardSize({
      key: event.key,
      direction: local.direction,
      edge: local.edge,
      size: local.size,
      min: local.min,
      max: local.max,
      shiftKey: event.shiftKey,
    })
    if (size === undefined) return
    event.preventDefault()
    local.onResize(size)
  }

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    if (e.detail > 1) return
    e.preventDefault()
    const target = e.currentTarget as HTMLDivElement
    target.setPointerCapture(e.pointerId)
    const edge = local.edge ?? (local.direction === "vertical" ? "start" : "end")
    const start = local.direction === "horizontal" ? e.clientX : e.clientY
    const startSize = local.size
    const min = local.min
    const max = local.max
    const threshold = local.collapseThreshold ?? 0
    const onResize = local.onResize
    const onCollapse = local.onCollapse
    const onCollapseChange = local.onCollapseChange
    let current = startSize
    let collapsed = false

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== e.pointerId) return
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const delta =
        local.direction === "vertical"
          ? edge === "end"
            ? pos - start
            : start - pos
          : edge === "start"
            ? start - pos
            : pos - start
      current = startSize + delta
      const nextCollapsed = threshold > 0 && current < threshold
      if (nextCollapsed !== collapsed) {
        collapsed = nextCollapsed
        onCollapseChange?.(collapsed)
      }
      onResize(Math.min(max, Math.max(min, current)))
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== e.pointerId) return
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      document.removeEventListener("pointermove", onPointerMove)
      document.removeEventListener("pointerup", onPointerUp)
      document.removeEventListener("pointercancel", onPointerUp)

      if (collapsed) {
        onCollapse?.()
        return
      }
      onCollapseChange?.(false)
    }

    document.addEventListener("pointermove", onPointerMove)
    document.addEventListener("pointerup", onPointerUp)
    document.addEventListener("pointercancel", onPointerUp)
  }

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? (local.direction === "vertical" ? "start" : "end")}
      role="separator"
      tabIndex={rest.tabIndex ?? 0}
      aria-valuemin={local.min}
      aria-valuemax={local.max}
      aria-valuenow={local.size}
      aria-label={rest["aria-label"] ?? "Resize panel"}
      aria-orientation={local.direction === "horizontal" ? "vertical" : "horizontal"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  )
}
