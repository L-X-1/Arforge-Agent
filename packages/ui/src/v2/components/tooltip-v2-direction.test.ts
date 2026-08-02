import { describe, expect, test } from "bun:test"

describe("TooltipV2 text direction", () => {
  test("lets each tooltip infer its content direction from the first strong character", async () => {
    const source = await Bun.file(new URL("./tooltip-v2.tsx", import.meta.url)).text()
    const contentStart = source.indexOf("<KobalteTooltip.Content")
    const contentEnd = source.indexOf(">\n              {local.value}", contentStart)
    const openingTag = source.slice(contentStart, contentEnd)

    expect(contentStart).not.toBe(-1)
    expect(contentEnd).not.toBe(-1)
    expect(openingTag).toContain('dir="auto"')
    expect(openingTag).not.toContain('dir="ltr"')
    expect(openingTag).not.toContain('dir="rtl"')
  })
})
