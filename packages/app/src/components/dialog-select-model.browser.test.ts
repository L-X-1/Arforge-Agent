import { afterEach, describe, expect, test } from "bun:test"
import { captureModelComposerSelection, consumeModelOutsidePress, focusModelPickerOrigin, modelPickerComposing } from "./dialog-select-model-dismissal"
import { handleModelPickerSearchKeydown } from "./dialog-select-model-keyboard"

afterEach(() => { document.body.replaceChildren() })

describe("model picker DOM interactions", () => {
  test("provider button Space keeps native activation and does not enter search", () => {
    const input = document.createElement("input")
    const group = document.createElement("button")
    const label = document.createElement("span")
    group.append(label)
    document.body.append(input, group)
    let query = ""
    let handled = true
    group.addEventListener("keydown", (event) => {
      handled = handleModelPickerSearchKeydown(input, event, query, (value) => query = value)
    })
    group.focus()
    for (const target of [group, label]) {
      const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      expect(handled).toBe(false)
      expect(event.defaultPrevented).toBe(false)
      expect(query).toBe("")
      expect(document.activeElement).toBe(group)
    }
  })
  test("typing on a provider button still starts search", () => {
    const input = document.createElement("input")
    const group = document.createElement("button")
    document.body.append(input, group)
    let query = ""
    let handled = false
    group.addEventListener("keydown", (event) => {
      handled = handleModelPickerSearchKeydown(input, event, query, (value) => query = value)
    })
    group.focus()
    const event = new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true })
    group.dispatchEvent(event)
    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(query).toBe("g")
    expect(document.activeElement).toBe(input)
  })
  test("Space inside the search input remains text input", () => {
    const input = document.createElement("input")
    document.body.append(input)
    let changed = false
    let handled = true
    input.addEventListener("keydown", (event) => {
      handled = handleModelPickerSearchKeydown(input, event, "", () => changed = true)
    })
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    expect(handled).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(changed).toBe(false)
  })
  test("outside dismissal consumes the subsequent send click and allows the next deliberate click", () => {
    const send = document.createElement("button")
    document.body.append(send)
    let sends = 0
    let closes = 0
    send.addEventListener("click", () => sends++)
    window.addEventListener("pointerdown", (event) => { consumeModelOutsidePress(event); closes++ }, { capture: true, once: true })
    send.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))
    send.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }))
    send.click()
    expect(closes).toBe(1)
    expect(sends).toBe(0)
    send.click()
    expect(sends).toBe(1)
  })
  test("IME Enter and Escape are guarded, including the legacy 229 composition key", () => {
    expect(modelPickerComposing(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }))).toBe(true)
    expect(modelPickerComposing(new KeyboardEvent("keydown", { key: "Escape" }), true)).toBe(true)
    expect(modelPickerComposing({ isComposing: false, keyCode: 229 })).toBe(true)
    expect(modelPickerComposing(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false)
  })
  test("Escape restores the model trigger and a vanished trigger uses the current page", () => {
    const origin = document.createElement("button")
    const page = document.createElement("main")
    document.body.append(origin, page)
    focusModelPickerOrigin(origin)
    expect(document.activeElement).toBe(origin)
    origin.remove()
    focusModelPickerOrigin(origin)
    expect(document.activeElement).toBe(page)
  })
  test("restores the existing composer selection without replacing draft text", () => {
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    editor.textContent = "keep this draft and attachment references"
    document.body.append(editor)
    const text = editor.firstChild!
    document.getSelection()!.setBaseAndExtent(text, 5, text, 9)
    const restore = captureModelComposerSelection()
    document.getSelection()!.removeAllRanges()
    expect(restore?.()).toBe(true)
    expect(document.getSelection()!.toString()).toBe("this")
    expect(editor.textContent).toBe("keep this draft and attachment references")
    editor.remove()
    expect(restore?.()).toBe(false)
  })
})
