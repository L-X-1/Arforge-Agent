import { describe, expect, test } from "bun:test"
import { resizeHandleKeyboardSize } from "./resize-handle-keyboard"

describe("keyboard panel resizing", () => {
  const defaults = { size: 240, min: 180, max: 340 }
  test("horizontal start and end handles resize in the pointer direction", () => {
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "horizontal", key: "ArrowRight" })).toBe(248)
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "horizontal", edge: "start", key: "ArrowRight" })).toBe(232)
  })
  test("vertical top handles grow upwards", () => {
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "vertical", key: "ArrowUp" })).toBe(248)
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "vertical", edge: "end", key: "ArrowDown" })).toBe(248)
  })
  test("respects bounds, coarse steps, and unrelated keys", () => {
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "horizontal", key: "ArrowRight", shiftKey: true })).toBe(272)
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "horizontal", key: "ArrowRight", size: 338 })).toBe(340)
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "horizontal", key: "Home" })).toBe(180)
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "horizontal", key: "End" })).toBe(340)
    expect(resizeHandleKeyboardSize({ ...defaults, direction: "horizontal", key: "ArrowDown" })).toBeUndefined()
  })
})
