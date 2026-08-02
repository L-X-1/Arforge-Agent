import { describe, expect, test } from "bun:test"
import { afterModelMenuClose, type FrameScheduler } from "./dialog-select-model-dismissal"

describe("model menu dismissal", () => {
  test("runs follow-up work after two frames without waiting for DOM disconnection", () => {
    const queue: FrameRequestCallback[] = []
    const schedule: FrameScheduler = (callback) => {
      queue.push(callback)
      return queue.length
    }
    let selected = false

    afterModelMenuClose(() => {
      selected = true
    }, schedule)

    expect(selected).toBe(false)
    queue.shift()?.(0)
    expect(selected).toBe(false)
    queue.shift()?.(0)
    expect(selected).toBe(true)
    expect(queue).toHaveLength(0)
  })
})
