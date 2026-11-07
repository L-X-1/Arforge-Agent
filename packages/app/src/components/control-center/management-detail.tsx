import { createEffect, on, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import "./control-center.css"

type DetailOrigin = {
  element: HTMLButtonElement
  layout: HTMLElement
  scope: HTMLElement
  directory: string
  identity: unknown
}

/** Collapsing is presentation-only: the object, drafts and child handlers stay mounted. */
export function ManagementDetail(props: { identity: unknown; openRequest?: number; title: string; children: JSX.Element }) {
  const language = useLanguage()
  const [state, setState] = createStore({ open: true })
  let panel!: HTMLDetailsElement
  let summary!: HTMLElement
  let origin: DetailOrigin | undefined
  let frame: number | undefined
  let generation = 0
  let disposed = false

  const activeButton = () => {
    if (typeof document === "undefined") return undefined
    const active = document.activeElement
    return active instanceof HTMLElement
      ? active.closest<HTMLButtonElement>("button[data-management-detail-id]") ?? undefined
      : undefined
  }
  // Capture before insertion can hide the originating list through the container rule.
  const initialButton = activeButton()
  const directoryFor = (scope: HTMLElement) =>
    scope.querySelector(".arforge-control-center-path, [data-management-source]")?.getAttribute("title") ?? ""
  const visible = (element: HTMLElement) =>
    element.isConnected &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"

  const cancelFocus = () => {
    generation += 1
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }

  const captureOrigin = (identity: unknown, candidate?: HTMLButtonElement): DetailOrigin | undefined => {
    if (!panel?.isConnected || !candidate?.isConnected || candidate.disabled) return
    if (candidate.dataset.managementDetailId !== String(identity)) return
    const layout = panel.closest<HTMLElement>(".arforge-management-master-detail")
    if (!layout || candidate.closest(".arforge-management-master-detail") !== layout) return
    if (!candidate.closest(".arforge-management-master-content")) return
    const scope = layout.closest<HTMLElement>(".arforge-control-center-panel, .settings-v2-panel") ?? layout
    return { element: candidate, layout, scope, directory: directoryFor(scope), identity }
  }

  const current = (target: DetailOrigin, expectedGeneration: number) =>
    !disposed &&
    expectedGeneration === generation &&
    props.identity === target.identity &&
    panel.isConnected &&
    summary.isConnected &&
    target.element.isConnected &&
    !target.element.disabled &&
    target.layout.contains(panel) &&
    target.layout.contains(target.element) &&
    (target.layout.closest(".arforge-control-center-panel, .settings-v2-panel") ?? target.layout) === target.scope &&
    target.scope.isConnected &&
    directoryFor(target.scope) === target.directory &&
    target.element.dataset.managementDetailId === String(target.identity)

  const moveFocus = (direction: "open" | "close", target: DetailOrigin | undefined) => {
    if (!target || typeof requestAnimationFrame === "undefined") return
    const expectedGeneration = generation
    const document = panel.ownerDocument
    const scheduledActive = document.activeElement
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!current(target, expectedGeneration)) return
      const active = document.activeElement
      const neutral = active === document.body || active === document.documentElement
      if (direction === "open") {
        // This property comes from the same CSS container query that hides the list.
        const singlePane = getComputedStyle(target.layout)
          .getPropertyValue("--arforge-management-details-single-pane").trim() === "1"
        if (!singlePane || !state.open || !panel.open || !visible(summary)) return
        if (active === summary) return
        // A later form interaction wins over this pending focus request.
        if (active !== target.element && !neutral) return
        summary.focus({ preventScroll: true })
        return
      }
      if (state.open || panel.open || !visible(target.element)) return
      if (active !== summary && !panel.contains(active) &&
          !(neutral && scheduledActive instanceof Node && panel.contains(scheduledActive))) return
      target.element.focus({ preventScroll: true })
    })
  }

  createEffect(on(() => [props.identity, props.openRequest] as const, ([identity]) => {
    cancelFocus()
    const active = panel.ownerDocument.activeElement
    const neutral = active === panel.ownerDocument.body || active === panel.ownerDocument.documentElement
    const candidate = activeButton() ?? (neutral ? initialButton : undefined)
    origin = captureOrigin(identity, candidate)
    setState("open", true)
    moveFocus("open", origin)
  }))

  onCleanup(() => {
    disposed = true
    cancelFocus()
    origin = undefined
  })

  const toggleLabel = () => {
    if (language.locale() === "zh") return state.open ? "返回列表 / 收起详情" : "展开详情"
    if (language.locale() === "zht") return state.open ? "返回清單 / 收合詳細資料" : "展開詳細資料"
    return state.open ? "Back to list / collapse details" : "Expand details"
  }

  return (
    <details
      ref={panel}
      class="arforge-management-detail"
      open={state.open}
      onToggle={(event) => {
        const open = event.currentTarget.open
        if (open === state.open) return
        cancelFocus()
        setState("open", open)
        moveFocus(open ? "open" : "close", origin)
      }}
    >
      <summary ref={summary} class="arforge-management-detail-heading">
        <span>{props.title}</span>
        <span class="arforge-management-detail-toggle">{toggleLabel()}</span>
      </summary>
      <div class="arforge-management-detail-body">{props.children}</div>
    </details>
  )
}
