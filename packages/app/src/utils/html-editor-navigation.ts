import type { HtmlSourceElement } from "@/components/preview/html-element-model"

const normalize = (value: string) => value.replace(/\r\n?/g, "\n")

export function htmlEditorRange(source: string, editorText: string, element: Pick<HtmlSourceElement, "start" | "end">) {
  if (!Number.isSafeInteger(element.start) || !Number.isSafeInteger(element.end) || element.start < 0 || element.end <= element.start || element.end > source.length) return
  if (source === editorText) return { from: element.start, to: element.end }
  if (normalize(source) !== editorText) return
  return { from: normalize(source.slice(0, element.start)).length, to: normalize(source.slice(0, element.end)).length }
}

export async function jumpToHtmlEditor(input: { container: HTMLElement; source: string; element: HtmlSourceElement; current: () => boolean }) {
  const boundary = input.container.closest('[role="tabpanel"]')
  if (!boundary) return "unavailable" as const
  const { EditorView } = await import("codemirror")
  if (!input.current() || !input.container.isConnected) return "stale" as const
  let parent = input.container.parentElement
  while (parent && boundary.contains(parent)) {
    const editors = Array.from(parent.querySelectorAll<HTMLElement>(".cm-editor")).filter((node) =>
      node.closest('[role="tabpanel"]') === boundary && node.getClientRects().length > 0,
    )
    if (editors.length > 1) return "ambiguous" as const
    if (editors.length === 1) {
      const view = EditorView.findFromDOM(editors[0]!)
      if (!view) return "unavailable" as const
      const range = htmlEditorRange(input.source, view.state.doc.toString(), input.element)
      if (!range || !input.current()) return "stale" as const
      view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: "center" }) })
      view.focus()
      return "jumped" as const
    }
    if (parent === boundary) break
    parent = parent.parentElement
  }
  return "unavailable" as const
}
