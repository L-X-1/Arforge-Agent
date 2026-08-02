import { describe, expect, test } from "bun:test"

const closedBlock = (css: string, selector: string) => {
  const start = css.indexOf(selector)
  if (start === -1) return ""
  return css.slice(start, css.indexOf("}", start) + 1)
}

describe("menu dismissal CSS", () => {
  test("closed MenuV2 portals cannot retain the Electron pointer lock", async () => {
    const css = await Bun.file(new URL("./menu-v2.css", import.meta.url)).text()
    const block = closedBlock(css, "&[data-closed]")

    expect(block).toContain("animation: none")
    expect(block).toContain("pointer-events: none")
    expect(block).toContain("visibility: hidden")
    expect(css).toContain("&[data-expanded]")
    expect(css).toContain("animation: menu-v2-in")
  })

  test("closed legacy dropdown portals close synchronously", async () => {
    const css = await Bun.file(new URL("../../components/dropdown-menu.css", import.meta.url)).text()
    const block = closedBlock(css, "&[data-closed]")

    expect(block).toContain("animation: none")
    expect(block).toContain("pointer-events: none")
    expect(block).toContain("visibility: hidden")
    expect(css).toContain("animation: dropdown-menu-open")
  })
})
