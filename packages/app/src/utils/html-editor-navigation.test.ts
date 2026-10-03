import { describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { EditorView } from "codemirror"
import { mapHtmlElements } from "@/components/preview/html-element-model"
import { htmlEditorRange, jumpToHtmlEditor } from "./html-editor-navigation"

if (typeof document === "undefined") GlobalRegistrator.register()

describe("HTML editor source navigation", () => {
  test("maps CRLF and lone-CR source offsets to CodeMirror's LF buffer", () => {
    const source = '\r\n<p>Before</p>\r<h1>\u4e2d\u6587 \ud83d\ude80</h1>'
    const element = mapHtmlElements(source, "a".repeat(32)).elements.find((item) => item.tag === "h1")!
    const editor = source.replace(/\r\n?/g, "\n")
    const range = htmlEditorRange(source, editor, element)!
    expect(editor.slice(range.from, range.to)).toBe('<h1>\u4e2d\u6587 \ud83d\ude80</h1>')
    expect(htmlEditorRange(source, source, element)).toEqual({ from: element.start, to: element.end })
  })

  test("rejects changed buffers and invalid ranges rather than guessing positions", () => {
    expect(htmlEditorRange("<p>Old</p>", "<p>New</p>", { start: 0, end: 10 })).toBeUndefined()
    for (const range of [{ start: -1, end: 2 }, { start: 1, end: 100 }, { start: 2, end: 2 }, { start: 0.5, end: 2 }]) {
      expect(htmlEditorRange("<p>x</p>", "<p>x</p>", range)).toBeUndefined()
    }
  })

  test("selects a real CodeMirror range without changing the editor document", async () => {
    const source = '<p>Before</p>\n<h1 id="target">Select me</h1>'
    const element = mapHtmlElements(source, "a".repeat(32)).elements.find((item) => item.tag === "h1")!
    const panel = document.createElement("div")
    panel.setAttribute("role", "tabpanel")
    const container = document.createElement("div")
    panel.append(container)
    document.body.append(panel)
    const view = new EditorView({ doc: source, parent: panel })
    Object.defineProperty(view.dom, "getClientRects", { value: () => [new DOMRect(0, 0, 600, 300)] })
    try {
      expect(await jumpToHtmlEditor({ container, source, element, current: () => true })).toBe("jumped")
      expect(view.state.selection.main.from).toBe(element.start)
      expect(view.state.selection.main.to).toBe(element.end)
      expect(view.state.doc.toString()).toBe(source)
    } finally { view.destroy(); panel.remove() }
  })

  test("does not use an editor in another tab or a superseded selection", async () => {
    const source = "<h1>Target</h1>"
    const element = mapHtmlElements(source, "a".repeat(32)).elements[0]!
    const panel = document.createElement("div")
    panel.setAttribute("role", "tabpanel")
    const another = document.createElement("div")
    another.setAttribute("role", "tabpanel")
    const container = document.createElement("div")
    panel.append(container)
    document.body.append(panel, another)
    const view = new EditorView({ doc: source, parent: another })
    Object.defineProperty(view.dom, "getClientRects", { value: () => [new DOMRect(0, 0, 600, 300)] })
    try {
      expect(await jumpToHtmlEditor({ container, source, element, current: () => true })).toBe("unavailable")
      expect(await jumpToHtmlEditor({ container, source, element, current: () => false })).toBe("stale")
      expect(view.state.selection.main.from).toBe(0)
      expect(view.state.selection.main.to).toBe(0)
    } finally { view.destroy(); panel.remove(); another.remove() }
  })
})
