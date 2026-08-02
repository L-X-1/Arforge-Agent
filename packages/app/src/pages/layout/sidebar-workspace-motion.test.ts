import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const css = readFileSync(new URL("./sidebar-items.css", import.meta.url), "utf8")

describe("sidebar workspace disclosure motion", () => {
  test("uses a slower ease-out reveal and a faster ease-in collapse", () => {
    expect(css).toContain("sidebar-workspace-content-open 220ms cubic-bezier(0.22, 1, 0.36, 1)")
    expect(css).toContain("sidebar-workspace-content-close 180ms cubic-bezier(0.4, 0, 1, 1)")
  })

  test("preserves spatial continuity without translation or scale", () => {
    const open = css.match(/@keyframes sidebar-workspace-content-open \{([\s\S]*?)\n\}/)?.[1] ?? ""
    const close = css.match(/@keyframes sidebar-workspace-content-close \{([\s\S]*?)\n\}/)?.[1] ?? ""

    expect(open).toContain("height: var(--kb-collapsible-content-height)")
    expect(open).toContain("clip-path: inset(0 0 100% 0)")
    expect(close).toContain("height: var(--kb-collapsible-content-height)")
    expect(close).toContain("clip-path: inset(0 0 100% 0)")
    expect(`${open}${close}`).not.toContain("transform:")
  })

  test("switches workspace disclosure motion off for reduced motion", () => {
    const reducedMotion = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? ""

    expect(reducedMotion).toContain("[data-sidebar-workspace-content][data-expanded]")
    expect(reducedMotion).toContain("[data-sidebar-workspace-content][data-closed]")
    expect(reducedMotion).toContain("animation: none")
  })
})
