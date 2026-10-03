import { afterEach, describe, expect, test } from "bun:test"
import type { ModelSelectionBinding } from "@/components/dialog-select-model"
import { captureModelComposerFocus, captureModelEntry, resolveModelBinding, type BoundModelSelection } from "./model-binding"

const key = { providerID: "provider", modelID: "model" }
const model = () => ({ current: () => undefined }) as unknown as BoundModelSelection
const binding = (scope: () => string, select: ModelSelectionBinding["select"] = async () => undefined): ModelSelectionBinding => ({
  key: () => key, scope, ready: () => true, unavailable: () => undefined, select,
})

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe("composer model entry binding", () => {
  test("resolves the independent binding without falling back to local selection", () => {
    const local = model()
    const localBinding = binding(() => "local")
    const ownBinding = binding(() => "draft")
    const draft = Object.assign(model(), { binding: ownBinding })
    expect(resolveModelBinding(draft, local, localBinding)).toBe(ownBinding)
    expect(resolveModelBinding(local, local, localBinding)).toBe(localBinding)
    expect(resolveModelBinding(model(), local, localBinding)).toBeUndefined()
  })

  test("passes the exact model and binding through without invoking a setter", () => {
    const selected = model()
    const selectedBinding = binding(() => "draft")
    const entry = captureModelEntry({ model: () => selected, binding: () => selectedBinding })
    expect(entry.model).toBe(selected)
    expect(entry.binding).toBe(selectedBinding)
    expect(entry.current()).toBe(true)
  })

  test("rejects focus or opening after a draft, server or workspace scope changes", () => {
    for (const next of ["server-a/workspace-a/draft-b", "server-b/workspace-a/draft-a", "server-a/workspace-b/draft-a"]) {
      let scope = "server-a/workspace-a/draft-a"
      const selected = model()
      const selectedBinding = binding(() => scope)
      const entry = captureModelEntry({ model: () => selected, binding: () => selectedBinding })
      scope = next
      expect(entry.current()).toBe(false)
    }
  })

  test("rejects replaced model and binding identities even when scope strings match", () => {
    let selected = model()
    let selectedBinding = binding(() => "draft")
    const first = captureModelEntry({ model: () => selected, binding: () => selectedBinding })
    selected = model()
    expect(first.current()).toBe(false)
    const second = captureModelEntry({ model: () => selected, binding: () => selectedBinding })
    selectedBinding = binding(() => "draft")
    expect(second.current()).toBe(false)
  })

  test("preserves an unavailable explicit key and reason instead of substituting local state", () => {
    const selected = model()
    const selectedBinding = { ...binding(() => "draft"), unavailable: () => "removed" as const }
    const entry = captureModelEntry({ model: () => selected, binding: () => selectedBinding })
    expect(entry.binding?.key()).toEqual(key)
    expect(entry.binding?.unavailable()).toBe("removed")
    expect(entry.model.current()).toBeUndefined()
  })

  test("keeps the actual selection promise pending until the component's binding commits", async () => {
    let resolve!: () => void
    let committed = false
    const gate = new Promise<void>((done) => { resolve = done })
    const selected = model()
    const selectedBinding = binding(() => "draft", async () => { await gate; committed = true })
    const entry = captureModelEntry({ model: () => selected, binding: () => selectedBinding })
    let acknowledged = false
    const pending = Promise.resolve(entry.binding!.select(key, "draft")).then(() => { acknowledged = true })
    await Promise.resolve()
    expect(committed).toBe(false)
    expect(acknowledged).toBe(false)
    resolve()
    await pending
    expect(committed).toBe(true)
    expect(acknowledged).toBe(true)
  })

  test("does not swallow a scope or confirmation failure from the picker binding", async () => {
    const selected = model()
    const error = new Error("scope-changed")
    const selectedBinding = binding(() => "draft", async () => { throw error })
    const entry = captureModelEntry({ model: () => selected, binding: () => selectedBinding })
    await expect(entry.binding!.select(key, "draft")).rejects.toBe(error)
  })
})

function editor() {
  const element = document.createElement("div")
  element.contentEditable = "true"
  element.tabIndex = 0
  element.textContent = "draft selection"
  document.body.append(element)
  return element
}

describe("model dialog composer focus", () => {
  test("restores both endpoints of a backwards selection without modifying the draft", () => {
    const input = editor()
    const selection = document.getSelection()!
    selection.setBaseAndExtent(input.firstChild!, 10, input.firstChild!, 3)
    const restore = captureModelComposerFocus(input, () => true)
    const button = document.createElement("button")
    document.body.append(button)
    button.focus()
    selection.removeAllRanges()
    expect(restore()).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(selection.anchorNode).toBe(input.firstChild)
    expect(selection.anchorOffset).toBe(10)
    expect(selection.focusOffset).toBe(3)
    expect(input.textContent).toBe("draft selection")
  })

  test("does not focus the previous editor after a scope change", () => {
    const input = editor()
    let current = true
    const restore = captureModelComposerFocus(input, () => current)
    const other = editor()
    other.focus()
    current = false
    expect(restore()).toBe(false)
    expect(document.activeElement).toBe(other)
  })

  test("does not restore a stale selection after draft contents changed", () => {
    const input = editor()
    document.getSelection()!.setBaseAndExtent(input.firstChild!, 10, input.firstChild!, 3)
    const restore = captureModelComposerFocus(input, () => true)
    input.textContent = "new draft"
    expect(restore()).toBe(false)
    expect(input.textContent).toBe("new draft")
  })

  test("does not restore into an unmounted editor", () => {
    const input = editor()
    const restore = captureModelComposerFocus(input, () => true)
    input.remove()
    expect(restore()).toBe(false)
  })

  test("does not steal focus from a replacement provider or management dialog", () => {
    const input = editor()
    const restore = captureModelComposerFocus(input, () => true)
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    const control = document.createElement("input")
    dialog.append(control)
    document.body.append(dialog)
    control.focus()
    expect(restore()).toBe(false)
    expect(document.activeElement).toBe(control)
  })

  test("uses the existing controller restore only when no DOM selection was captured", () => {
    const input = editor()
    document.getSelection()?.removeAllRanges()
    let restored = 0
    const restore = captureModelComposerFocus(input, () => true, () => { restored++ })
    expect(restore()).toBe(true)
    expect(restored).toBe(1)
  })
})
