import type { ModelSelection } from "@/context/local"
import type { ModelSelectionBinding } from "@/components/dialog-select-model"

export type BoundModelSelection = ModelSelection & { binding?: ModelSelectionBinding }

export function resolveModelBinding(
  model: BoundModelSelection,
  localModel: ModelSelection,
  localBinding: ModelSelectionBinding,
) {
  return model.binding ?? (model === localModel ? localBinding : undefined)
}

/** Snapshot the opener; a mounted dialog must never silently retarget another draft. */
export function captureModelEntry(input: {
  model: () => BoundModelSelection
  binding: () => ModelSelectionBinding | undefined
}) {
  const model = input.model()
  const binding = input.binding()
  const scope = binding?.scope()
  return {
    model,
    binding,
    current: () => input.model() === model && input.binding() === binding && binding?.scope() === scope,
  }
}

/** Called after dialog teardown; keep both selection endpoints and their direction. */
export function captureModelComposerFocus(
  editor: HTMLElement | null,
  current: () => boolean,
  fallback?: () => void,
) {
  const document = editor?.ownerDocument
  const selection = document?.getSelection()
  const text = editor?.textContent
  const saved = editor && selection?.anchorNode && selection.focusNode
    && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)
    ? {
      anchor: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focus: selection.focusNode,
      focusOffset: selection.focusOffset,
    }
    : undefined

  return () => {
    if (!current() || !editor?.isConnected || editor.textContent !== text) return false
    // Provider/manage actions can replace the model dialog with another dialog.
    // Do not steal focus from that new surface when the old dialog tears down.
    const active = document?.activeElement
    if (active?.closest('[role="dialog"], [role="alertdialog"]') && !editor.contains(active)) return false
    editor.focus({ preventScroll: true })
    if (saved && editor.contains(saved.anchor) && editor.contains(saved.focus)) {
      document?.getSelection()?.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset)
    } else if (!saved) {
      fallback?.()
    }
    return true
  }
}
