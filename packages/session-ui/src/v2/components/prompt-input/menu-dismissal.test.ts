import { afterEach, describe, expect, test } from "bun:test"
import { consumePromptMenuOutsidePress } from "./menu-dismissal"

afterEach(() => document.body.replaceChildren())

describe("composer menu outside dismissal", () => {
  test("consumes the whole dismissal gesture without sending, then allows the next click", () => {
    const send = document.createElement("button")
    document.body.append(send)
    let submissions = 0
    send.addEventListener("click", () => submissions++)
    const cleanup = consumePromptMenuOutsidePress(new PointerEvent("pointerdown", { cancelable: true }))
    try {
      for (const name of ["pointerup", "mouseup", "click"]) {
        const event = new MouseEvent(name, { bubbles: true, cancelable: true })
        send.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
      }
      expect(submissions).toBe(0)
      send.click()
      expect(submissions).toBe(1)
    } finally { cleanup() }
  })

  test("a new press releases an unfinished gesture and cleanup never swallows keyboard activation", () => {
    const send = document.createElement("button")
    document.body.append(send)
    let submissions = 0
    send.addEventListener("click", () => submissions++)
    const cleanup = consumePromptMenuOutsidePress(new PointerEvent("pointerdown", { cancelable: true }))
    try {
      send.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      send.click()
      expect(submissions).toBe(1)
      cleanup()
      send.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }))
      expect(submissions).toBe(2)
    } finally { cleanup() }
  })
})
