import { describe, expect, test } from "bun:test"

const keyframes = (css: string, name: string) => {
  const start = css.indexOf(`@keyframes ${name}`)
  if (start === -1) return ""
  const next = css.indexOf("@keyframes", start + 1)
  const media = css.indexOf("@media", start + 1)
  const end = [next, media, css.length].filter((index) => index !== -1).sort((a, b) => a - b)[0]
  return css.slice(start, end)
}

describe("TooltipV2 motion", () => {
  test("uses a restrained iOS-style micro-scale with a faster exit", async () => {
    const css = await Bun.file(new URL("./tooltip-v2.css", import.meta.url)).text()
    const enter = keyframes(css, "tooltipV2In")
    const exit = keyframes(css, "tooltipV2Out")

    expect(css).toContain("animation: tooltipV2In 120ms ease-out")
    expect(css).toContain("animation: tooltipV2Out 80ms ease-in forwards")
    expect(enter).toContain("transform: scale(0.98)")
    expect(exit).toContain("transform: scale(0.98)")
    expect(enter).not.toContain("scale(0.96)")
    expect(exit).not.toContain("scale(0.96)")
  })

  test("removes both transforms and fades when reduced motion is requested", async () => {
    const css = await Bun.file(new URL("./tooltip-v2.css", import.meta.url)).text()
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))

    expect(reducedMotion).toContain('[data-component="tooltip-v2"]')
    expect(reducedMotion).toContain('[data-component="tooltip-v2"][data-closed]')
    expect(reducedMotion).toContain("animation: none")
  })
})
