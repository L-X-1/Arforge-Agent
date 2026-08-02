import { describe, expect, test } from "bun:test"

describe("TooltipV2 typography", () => {
  test("keeps compact label sizing while giving wrapped copy readable leading", async () => {
    const css = await Bun.file(new URL("./tooltip-v2.css", import.meta.url)).text()
    const start = css.indexOf('[data-component="tooltip-v2"] {')
    const closedState = css.indexOf("&[data-closed]", start)
    const block = css.slice(start, closedState)

    expect(start).not.toBe(-1)
    expect(closedState).not.toBe(-1)
    expect(block).toContain("font-size: 11px")
    expect(block).toContain("line-height: 14px")
    expect(block).toContain("font-weight: 530")
    expect(block).toContain("letter-spacing: 0.05px")
    expect(block).not.toContain("line-height: 12px")
  })
})
