import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createSidebarScrollMemory, sidebarScrollMemoryKey } from "./sidebar-scroll-memory"

const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8")
const workspace = readFileSync(new URL("./sidebar-workspace.tsx", import.meta.url), "utf8")

describe("sidebar project scroll memory", () => {
  test("keeps desktop and mobile positions independent for every project", () => {
    const memory = createSidebarScrollMemory()
    const desktopA = sidebarScrollMemoryKey("desktop", "project-a")
    const mobileA = sidebarScrollMemoryKey("mobile", "project-a")
    const desktopB = sidebarScrollMemoryKey("desktop", "project-b")

    memory.remember(desktopA, 120)
    memory.remember(mobileA, 48)
    memory.remember(desktopB, 220)

    expect(memory.restore(desktopA, 600, 300)).toBe(120)
    expect(memory.restore(mobileA, 600, 300)).toBe(48)
    expect(memory.restore(desktopB, 600, 300)).toBe(220)
  })

  test("starts unseen projects at the top and never stores a negative position", () => {
    const memory = createSidebarScrollMemory()
    const key = sidebarScrollMemoryKey("desktop", "project")

    expect(memory.restore(key, 600, 300)).toBe(0)
    memory.remember(key, -24)
    expect(memory.restore(key, 600, 300)).toBe(0)
  })

  test("clamps a remembered position when content becomes shorter", () => {
    const memory = createSidebarScrollMemory()
    const key = sidebarScrollMemoryKey("desktop", "project")

    memory.remember(key, 420)
    expect(memory.restore(key, 500, 240)).toBe(260)
  })
})

describe("sidebar scroll restoration integration contract", () => {
  test("uses runtime-only memory keyed by project and formal panel surface", () => {
    expect(layout).toContain('sidebarScrollMemoryKey(surface, pathKey(directory))')
    expect(layout).toContain("const surface: SidebarScrollSurface | undefined = panelProps.mobile")
    expect(layout).toContain('? "mobile"')
    expect(layout).toMatch(/panelProps\.merged === false\s*\?\s*undefined/)
    expect(layout).not.toContain('"sidebarScrollPosition"')
  })

  test("restores silently before allowing active-session positioning", () => {
    expect(layout).toContain('element.setAttribute("data-sidebar-scroll-restoring", "")')
    expect(layout).toContain("element.scrollTop = restored")
    expect(layout).toContain('container.hasAttribute("data-sidebar-scroll-restoring")')
    expect(layout).toContain("scrollSessionKeys.delete(element)")
    expect(layout).toContain("const key = activeScrollMemoryKey")
    expect(layout).toContain("activeScrollMemoryKey = next")
    expect(layout).toContain("scrollToSession(id, `${directory}:${id}`)")
  })

  test("does not reveal the scrollbar while a formal panel is being restored", () => {
    expect(layout).toContain('hasAttribute("data-sidebar-scroll-restoring")')
    expect(workspace).toContain('hasAttribute("data-sidebar-scroll-restoring")')
  })
})
