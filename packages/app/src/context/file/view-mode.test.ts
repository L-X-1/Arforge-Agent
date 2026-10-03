import { describe, expect, test } from "bun:test"
import { normalizeFilePreviewMode } from "./types"

describe("persisted file preview modes", () => {
  test.each(["source", "preview", "split"] as const)("restores the explicit %s mode", (mode) => {
    expect(normalizeFilePreviewMode(mode)).toBe(mode)
  })

  test.each([undefined, null, "", "edit", "execute", "PREVIEW", 1, true, {}, []].map((value) => ({ value })))(
    "uses read-only source for an absent or invalid stored mode: %j",
    ({ value }) => {
      expect(normalizeFilePreviewMode(value)).toBe("source")
    },
  )
})
