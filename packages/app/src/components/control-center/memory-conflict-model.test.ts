import { describe, expect, test } from "bun:test"
import { conflictDisposition } from "./memory-conflict-model"

describe("conflictDisposition", () => {
  const decision = {
    chosenMemoryID: "memory-west",
    retiredMemoryID: "memory-east",
  }

  test("describes the active resolved decision", () => {
    expect(conflictDisposition({ ...decision, status: "resolved" }, "memory-west")).toBe("chosen")
    expect(conflictDisposition({ ...decision, status: "resolved" }, "memory-east")).toBe("retired")
  })

  test("does not present historical disposition as current after undo", () => {
    expect(conflictDisposition({ ...decision, status: "undone" }, "memory-west")).toBeUndefined()
    expect(conflictDisposition({ ...decision, status: "undone" }, "memory-east")).toBeUndefined()
  })
})
