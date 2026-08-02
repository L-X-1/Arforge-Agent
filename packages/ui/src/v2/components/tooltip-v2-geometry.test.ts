import { describe, expect, test } from "bun:test"

describe("TooltipV2 geometry", () => {
  test("uses restrained floating-surface geometry with one semantic hairline", async () => {
    const css = await Bun.file(new URL("./tooltip-v2.css", import.meta.url)).text()
    const start = css.indexOf('[data-component="tooltip-v2"] {')
    const closedState = css.indexOf("&[data-closed]", start)
    const block = css.slice(start, closedState)

    expect(start).not.toBe(-1)
    expect(closedState).not.toBe(-1)
    expect(block).toContain("box-sizing: border-box")
    expect(block).toContain("padding: 5px 8px")
    expect(block).toContain("border: 0.5px solid var(--v2-border-border-muted)")
    expect(block).toContain("border-radius: 6px")
    expect(block).toContain("box-shadow: var(--v2-elevation-floating)")
    expect(block).not.toContain("padding: 5px 6px")
    expect(block).not.toContain("border-radius: 4px")
  })

  test("keeps the floating surface visually quiet without a pointing arrow", async () => {
    const source = await Bun.file(new URL("./tooltip-v2.tsx", import.meta.url)).text()
    const css = await Bun.file(new URL("./tooltip-v2.css", import.meta.url)).text()

    expect(source).not.toContain("<KobalteTooltip.Arrow")
    expect(source).not.toContain("TooltipArrow")
    expect(css).not.toContain('[data-component="tooltip-v2-arrow"]')
    expect(css).not.toMatch(/\[data-component="tooltip-v2"\](?:\s*|[\s\S]*?&)::(?:before|after)/)
    expect(css).not.toContain("clip-path: polygon")
  })

  test("uses a compact 4px default gap while allowing contextual overrides", async () => {
    const source = await Bun.file(new URL("./tooltip-v2.tsx", import.meta.url)).text()
    const rootStart = source.indexOf("<KobalteTooltip\n")
    const rootEnd = source.indexOf(">\n          <KobalteTooltip.Trigger", rootStart)
    const openingTag = source.slice(rootStart, rootEnd)

    expect(rootStart).not.toBe(-1)
    expect(rootEnd).not.toBe(-1)
    expect(openingTag).toContain("gutter={4}")
    expect(openingTag).not.toContain("gutter={6}")
    expect(openingTag).not.toContain("gutter={8}")
    expect(openingTag).not.toContain("gutter={10}")
    expect(openingTag.indexOf("gutter={4}")).toBeLessThan(openingTag.indexOf("{...others}"))
  })

  test("repositions immediately while limiting motion to the tooltip reveal", async () => {
    const css = await Bun.file(new URL("./tooltip-v2.css", import.meta.url)).text()
    const positionerStart = css.indexOf('[data-popper-positioner]:has([data-component="tooltip-v2"]) {')
    const positionerEnd = css.indexOf("}", positionerStart)
    const positionerBlock = css.slice(positionerStart, positionerEnd)

    expect(positionerStart).not.toBe(-1)
    expect(positionerEnd).not.toBe(-1)
    expect(positionerBlock).toContain("transition: none")
    expect(positionerBlock).not.toContain("animation:")
    expect(css).toContain("animation: tooltipV2In 120ms ease-out")
    expect(css).toContain("animation: tooltipV2Out 80ms ease-in forwards")
    expect(css).not.toMatch(/transform:\s*translate/)
    expect(css).not.toMatch(/(?:top|left):[^;]+;\s*transition/)
  })
})
