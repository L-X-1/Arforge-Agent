export function promptInputIsComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">, composing = false) {
  return composing || event.isComposing || event.keyCode === 229
}

export type PromptEditorSelection = {
  editor: HTMLElement
  anchor: Node
  anchorOffset: number
  focus: Node
  focusOffset: number
  text: string
}

/** Retain both ends and selection direction while a model/menu takes focus. */
export function capturePromptEditorSelection(editor: HTMLElement | undefined): PromptEditorSelection | undefined {
  const selection = editor?.ownerDocument.getSelection()
  if (!editor || !selection?.anchorNode || !selection.focusNode) return
  if (!editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return
  return {
    editor,
    anchor: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focus: selection.focusNode,
    focusOffset: selection.focusOffset,
    text: editor.textContent ?? "",
  }
}

export function restorePromptEditorSelection(editor: HTMLElement | undefined, saved: PromptEditorSelection | undefined) {
  if (!editor || !saved || saved.editor !== editor || saved.text !== editor.textContent) return false
  if (!editor.contains(saved.anchor) || !editor.contains(saved.focus)) return false
  const selection = editor.ownerDocument.getSelection()
  if (!selection) return false
  selection.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset)
  return true
}
