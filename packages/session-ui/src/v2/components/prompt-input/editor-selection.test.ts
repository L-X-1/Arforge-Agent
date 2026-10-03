import { afterEach, describe, expect, test } from "bun:test"
import { capturePromptEditorSelection, restorePromptEditorSelection, promptInputIsComposing } from "./editor-selection"

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe("composer focus and IME", () => {
  test("retains a backwards text selection across a model control focus change", () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    editor.textContent = "draft selection"
    document.body.append(editor)
    const text = editor.firstChild!
    const selection = document.getSelection()!
    selection.setBaseAndExtent(text, 10, text, 3)
    const saved = capturePromptEditorSelection(editor)
    const button = document.createElement("button")
    document.body.append(button)
    button.focus()
    selection.removeAllRanges()
    expect(restorePromptEditorSelection(editor, saved)).toBe(true)
    expect(selection.anchorOffset).toBe(10)
    expect(selection.focusOffset).toBe(3)
    expect(editor.textContent).toBe("draft selection")
  })

  test("does not restore a selection into a changed draft or another session editor", () => {
    const editor = document.createElement("div")
    editor.textContent = "first"
    document.body.append(editor)
    document.getSelection()!.setBaseAndExtent(editor.firstChild!, 0, editor.firstChild!, 3)
    const saved = capturePromptEditorSelection(editor)
    const other = document.createElement("div")
    other.textContent = "first"
    document.body.append(other)
    expect(restorePromptEditorSelection(other, saved)).toBe(false)
    editor.textContent = "second"
    expect(restorePromptEditorSelection(editor, saved)).toBe(false)
  })

  test("protects modern composition, legacy 229 and the composition event interval", () => {
    expect(promptInputIsComposing({ isComposing: true, keyCode: 13 })).toBe(true)
    expect(promptInputIsComposing({ isComposing: false, keyCode: 229 })).toBe(true)
    expect(promptInputIsComposing({ isComposing: false, keyCode: 13 }, true)).toBe(true)
    expect(promptInputIsComposing({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})
