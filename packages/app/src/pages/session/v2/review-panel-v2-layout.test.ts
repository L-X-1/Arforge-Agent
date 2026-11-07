import { describe, expect, test } from "bun:test"
import { reviewPanelDiffStyle } from "./review-panel-v2-layout"

describe("review layout uses the actual preview container", () => {
  test("a large window does not force a narrow preview into split mode", () => {
    for (const width of [0, 216, 440, 619, NaN]) {
      expect(reviewPanelDiffStyle({ width, preference: null, controlled: "split" })).toBe("unified")
    }
    for (const width of [620, 760, 1280]) {
      expect(reviewPanelDiffStyle({ width, preference: null, controlled: "unified" })).toBe("split")
    }
  })
  test("saved and same-source explicit choices survive resizing", () => {
    expect(reviewPanelDiffStyle({ width: 440, preference: "split", controlled: "unified" })).toBe("split")
    expect(reviewPanelDiffStyle({ width: 1280, preference: "unified", controlled: "split" })).toBe("unified")
    expect(reviewPanelDiffStyle({ width: 440, preference: null, choice: "split", controlled: "unified" })).toBe("split")
    expect(reviewPanelDiffStyle({ width: 1280, preference: null, choice: "unified", controlled: "split" })).toBe(
      "unified",
    )
  })
  test("keeps the legacy controlled contract when no preference API is supplied", () => {
    expect(reviewPanelDiffStyle({ width: 440, preference: undefined, controlled: "split" })).toBe("split")
    expect(reviewPanelDiffStyle({ width: 1280, preference: undefined, controlled: "unified" })).toBe("unified")
  })
})
