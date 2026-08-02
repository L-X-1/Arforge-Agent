import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { createEffect, onCleanup, onMount, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { sidebarPrimaryActionLabelIsTruncated } from "./sidebar-primary-action-overflow"

function createSidebarPrimaryActionOverflow(value: Accessor<string>) {
  let root: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  const [state, setState] = createStore({ truncated: false })

  const label = () => root?.querySelector<HTMLElement>("[data-sidebar-primary-action-label]")
  const measure = () => {
    const next = sidebarPrimaryActionLabelIsTruncated(label())
    if (next === state.truncated) return
    setState("truncated", next)
  }

  createEffect(() => {
    value()
    queueMicrotask(measure)
  })

  onMount(() => {
    measure()
    window.addEventListener("resize", measure)

    if (typeof ResizeObserver === "undefined") return
    observer = new ResizeObserver(measure)
    if (root) observer.observe(root)
    const current = label()
    if (current) observer.observe(current)
  })

  onCleanup(() => {
    observer?.disconnect()
    window.removeEventListener("resize", measure)
  })

  return {
    ref: (element: HTMLDivElement) => {
      root = element
    },
    truncated: () => state.truncated,
  }
}

export function SidebarPrimaryActionTooltip(props: ParentProps<{ value: string }>) {
  const overflow = createSidebarPrimaryActionOverflow(() => props.value)

  return (
    <div ref={overflow.ref} data-sidebar-primary-action-tooltip>
      <TooltipV2
        value={props.value}
        inactive={!overflow.truncated()}
        placement="right"
        flip
        slide
        overflowPadding={12}
        gutter={8}
        class="w-full"
        contentStyle={{
          "max-width": "min(320px, calc(100vw - 24px))",
          "white-space": "normal",
          "text-wrap": "pretty",
          "overflow-wrap": "anywhere",
          "text-align": "start",
        }}
      >
        {props.children}
      </TooltipV2>
    </div>
  )
}
