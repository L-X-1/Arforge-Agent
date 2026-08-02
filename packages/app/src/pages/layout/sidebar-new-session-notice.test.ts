import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  firstSidebarNewSessionTarget,
  mergeSidebarNewSessionIDs,
  sidebarNewSessionScrollTop,
  sidebarNewSessionTargetReached,
  sidebarNewSessionVisualCount,
  visibleSidebarNewSessionIDs,
} from "./sidebar-new-session-notice"

const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8")
const noticeStyles = readFileSync(new URL("./sidebar-panel.css", import.meta.url), "utf8")
const itemStyles = readFileSync(new URL("./sidebar-items.css", import.meta.url), "utf8")

describe("sidebar new-session notice geometry", () => {
  test("aligns the new session to the safe inset and clamps both scroll edges", () => {
    expect(
      sidebarNewSessionScrollTop({
        scrollTop: 240,
        containerTop: 100,
        targetTop: -40,
        scrollHeight: 900,
        clientHeight: 300,
      }),
    ).toBe(92)
    expect(
      sidebarNewSessionScrollTop({
        scrollTop: 20,
        containerTop: 100,
        targetTop: 40,
        scrollHeight: 900,
        clientHeight: 300,
      }),
    ).toBe(0)
    expect(
      sidebarNewSessionScrollTop({
        scrollTop: 580,
        containerTop: 100,
        targetTop: 280,
        scrollHeight: 900,
        clientHeight: 300,
      }),
    ).toBe(600)
  })

  test("deduplicates consecutive arrivals while retaining their first-seen order", () => {
    expect(mergeSidebarNewSessionIDs(["first", "second"], ["second", "third", "first", "fourth"])).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ])
  })

  test("caps only the visual count after 99", () => {
    expect(sidebarNewSessionVisualCount(1)).toBe(1)
    expect(sidebarNewSessionVisualCount(99)).toBe(99)
    expect(sidebarNewSessionVisualCount(100)).toBe("99+")
    expect(sidebarNewSessionVisualCount(999)).toBe("99+")
  })

  test("resolves the topmost pending target from the current list order", () => {
    const container = document.createElement("div")
    const first = document.createElement("div")
    const firstRow = document.createElement("a")
    const second = document.createElement("div")
    const secondRow = document.createElement("a")
    first.dataset.sessionId = "first"
    firstRow.dataset.sidebarSessionRow = ""
    second.dataset.sessionId = "second"
    secondRow.dataset.sidebarSessionRow = ""
    first.append(firstRow)
    second.append(secondRow)
    container.append(first, second)

    expect(firstSidebarNewSessionTarget(container, ["second", "first"])).toBe(firstRow)
  })

  test("removes only pending sessions that are fully visible", () => {
    const container = document.createElement("div")
    const rows = ["above", "visible", "partial"].map((id) => {
      const item = document.createElement("div")
      const row = document.createElement("a")
      item.dataset.sessionId = id
      row.dataset.sidebarSessionRow = ""
      item.append(row)
      container.append(item)
      return row
    })
    container.getBoundingClientRect = () => new DOMRect(0, 100, 200, 160)
    rows[0].getBoundingClientRect = () => new DOMRect(0, 40, 200, 40)
    rows[1].getBoundingClientRect = () => new DOMRect(0, 108, 200, 40)
    rows[2].getBoundingClientRect = () => new DOMRect(0, 240, 200, 40)

    expect(visibleSidebarNewSessionIDs(container, ["above", "visible", "partial"])).toEqual(["visible"])
  })

  test("dismisses only after the complete target reaches the viewport", () => {
    expect(
      sidebarNewSessionTargetReached({
        containerTop: 100,
        containerBottom: 300,
        targetTop: 60,
        targetBottom: 100,
      }),
    ).toBe(false)
    expect(
      sidebarNewSessionTargetReached({
        containerTop: 100,
        containerBottom: 300,
        targetTop: 80,
        targetBottom: 120,
      }),
    ).toBe(false)
    expect(
      sidebarNewSessionTargetReached({
        containerTop: 100,
        containerBottom: 300,
        targetTop: 108,
        targetBottom: 148,
      }),
    ).toBe(true)
  })
})

describe("sidebar new-session notice integration contract", () => {
  test("is an accessible overlay with a 44px hit target and no focus theft", () => {
    const buttonStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button {"),
      noticeStyles.indexOf("[data-sidebar-new-session-pill]"),
    )

    expect(layout).toContain("data-sidebar-new-session-notice")
    expect(layout).toContain('role="status"')
    expect(layout).toContain('aria-live="polite"')
    expect(layout).toContain('aria-atomic="true"')
    expect(layout).toMatch(/data-sidebar-new-session-notice[\s\S]*?<button\s+type="button"/)
    expect(buttonStyles).toContain("height: 44px")
    expect(buttonStyles).toContain("min-width: 44px")
    expect(layout).not.toContain("newSessionNotice.target.focus(")
  })

  test("keeps the live status outside the visual aria-hidden boundary", () => {
    const componentStart = layout.indexOf("const NewSessionNotice")
    const statusIndex = layout.indexOf('role="status"', componentStart)
    const visualIndex = layout.indexOf("data-sidebar-new-session-notice", componentStart)
    const visualBoundary = layout.slice(visualIndex, layout.indexOf(">", visualIndex))

    expect(statusIndex).toBeGreaterThan(componentStart)
    expect(visualIndex).toBeGreaterThan(componentStart)
    expect(statusIndex).toBeLessThan(visualIndex)
    expect(visualBoundary).toContain("aria-hidden={!newSessionNotice.visible}")
  })

  test("uses immediate touch activation without disabling pinch zoom", () => {
    const buttonStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button {"),
      noticeStyles.indexOf("[data-sidebar-new-session-pill]"),
    )

    expect(buttonStyles).toContain("touch-action: manipulation")
    expect(buttonStyles).not.toContain("touch-action: none")
  })

  test("prevents accidental text selection only on the touch control", () => {
    const noticeStylesBeforeButton = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] {"),
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button {"),
    )
    const buttonStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button {"),
      noticeStyles.indexOf("[data-sidebar-new-session-pill]"),
    )

    expect(buttonStyles).toContain("user-select: none")
    expect(buttonStyles).toContain("-webkit-user-select: none")
    expect(noticeStylesBeforeButton).not.toContain("user-select:")
  })

  test("suppresses only the button's non-actionable iOS touch callout", () => {
    const noticeStylesBeforeButton = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] {"),
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button {"),
    )
    const buttonStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button {"),
      noticeStyles.indexOf("[data-sidebar-new-session-pill]"),
    )

    expect(buttonStyles).toContain("-webkit-touch-callout: none")
    expect(buttonStyles).toContain("touch-action: manipulation")
    expect(noticeStylesBeforeButton).not.toContain("-webkit-touch-callout:")
  })

  test("inherits the application typeface without resetting label metrics", () => {
    const buttonStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button {"),
      noticeStyles.indexOf("[data-sidebar-new-session-pill]"),
    )

    expect(buttonStyles).toContain("font-family: inherit")
    expect(buttonStyles).not.toMatch(/(?:^|\n)\s*font:\s/)
  })

  test("removes native button chrome without removing semantic focus treatment", () => {
    const buttonStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button {"),
      noticeStyles.indexOf("[data-sidebar-new-session-pill]"),
    )
    const focusStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button:focus-visible"),
      noticeStyles.indexOf("@media (hover: hover) and (pointer: fine)"),
    )

    expect(buttonStyles).toMatch(/(?:^|\n)\s*-webkit-appearance: none/)
    expect(buttonStyles).toMatch(/(?:^|\n)\s*appearance: none/)
    expect(focusStyles).toContain("outline: 2px solid var(--v2-border-border-focus)")
  })

  test("uses a readable opaque material before progressively enhancing backdrop blur", () => {
    const pillStart = noticeStyles.indexOf("[data-sidebar-new-session-pill] {")
    const labelsStart = noticeStyles.indexOf("[data-sidebar-new-session-labels]", pillStart)
    const pillMaterial = noticeStyles.slice(pillStart, labelsStart)
    const supportsStart = pillMaterial.indexOf("@supports")
    const basePillStyles = pillMaterial.slice(0, supportsStart)

    expect(basePillStyles).toContain("background-color: color-mix(in srgb, var(--background-base) 96%, transparent)")
    expect(basePillStyles).not.toContain("backdrop-filter:")
    expect(pillMaterial).toContain("@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))")
    expect(pillMaterial).toContain("background-color: color-mix(in srgb, var(--background-base) 88%, transparent)")
    expect(pillMaterial).toContain("backdrop-filter: blur(18px) saturate(1.08)")
    expect(pillMaterial).toContain("-webkit-backdrop-filter: blur(18px) saturate(1.08)")
  })

  test("clips the capsule material inside its hairline without clipping content", () => {
    const pillStart = noticeStyles.indexOf("[data-sidebar-new-session-pill] {")
    const supportsStart = noticeStyles.indexOf("@supports", pillStart)
    const basePillStyles = noticeStyles.slice(pillStart, supportsStart)

    expect(basePillStyles).toContain("border: 0.5px solid var(--arforge-hairline)")
    expect(basePillStyles).toContain("background-clip: padding-box")
    expect(basePillStyles).not.toContain("overflow: hidden")
    expect(basePillStyles).not.toContain("clip-path:")
  })

  test("includes the hairline inside the approved 28px capsule geometry", () => {
    const pillStart = noticeStyles.indexOf("[data-sidebar-new-session-pill] {")
    const supportsStart = noticeStyles.indexOf("@supports", pillStart)
    const basePillStyles = noticeStyles.slice(pillStart, supportsStart)

    expect(basePillStyles).toContain("height: 28px")
    expect(basePillStyles).toContain("border: 0.5px solid var(--arforge-hairline)")
    expect(basePillStyles).toContain("box-sizing: border-box")
    expect(basePillStyles).not.toContain("box-sizing: content-box")
  })

  test("uses smooth scrolling while respecting reduced motion", () => {
    expect(layout).toContain('matchMedia("(prefers-reduced-motion: reduce)")')
    expect(readFileSync(new URL("./sidebar-new-session-notice.ts", import.meta.url), "utf8")).toContain(
      'reducedMotion ? "auto" : "smooth"',
    )
    expect(noticeStyles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*data-sidebar-new-session-notice/)
  })

  test("fades the notice without translating or scaling it", () => {
    const noticeMotionStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] {"),
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button"),
    )

    expect(noticeMotionStyles).toContain("transform: translateX(-50%)")
    expect(noticeMotionStyles).toContain("transition: opacity 140ms ease-out")
    expect(noticeMotionStyles).not.toContain("translate3d")
    expect(noticeMotionStyles).not.toContain("scale(")
    expect(noticeMotionStyles).not.toMatch(/transition:[\s\S]*transform/)
  })

  test("uses a restrained direct-press scale without changing layout", () => {
    const pillMotionStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-pill] {"),
      noticeStyles.indexOf("[data-sidebar-new-session-labels]"),
    )
    const pressedStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button:active"),
      noticeStyles.indexOf("@media (max-width: 767px)"),
    )

    expect(pillMotionStyles).toContain("transform 120ms ease-out")
    expect(pillMotionStyles).toContain("transform-origin: center")
    expect(pillMotionStyles).not.toContain("transform-origin: top")
    expect(pillMotionStyles).not.toContain("transform-origin: left")
    expect(pressedStyles).toContain("transform: scale(0.98)")
    expect(pressedStyles).not.toContain("scale(0.97)")
  })

  test("limits hover material to fine pointers while preserving keyboard focus", () => {
    const hoverStyles = noticeStyles.slice(
      noticeStyles.indexOf("@media (hover: hover) and (pointer: fine)"),
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button:active"),
    )
    const focusStyles = noticeStyles.slice(
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button:focus-visible"),
      noticeStyles.indexOf("@media (hover: hover) and (pointer: fine)"),
    )

    expect(noticeStyles).not.toContain("button:is(:hover, :focus-visible)")
    expect(hoverStyles).toContain("[data-sidebar-new-session-notice] button:hover")
    expect(hoverStyles).not.toContain(":focus-visible")
    expect(focusStyles).toContain("background-color:")
    expect(focusStyles).toContain("outline: 2px solid var(--v2-border-border-focus)")
  })

  test("crossfades aggregated counts without changing geometry", () => {
    expect(layout).toContain('language.t("sidebar.session.newAvailableCount", { count })')
    expect(layout).toContain("sidebarNewSessionVisualCount(count)")
    expect(layout).toContain("aria-label={label()}")
    expect(layout).toContain("mergeSidebarNewSessionIDs")
    expect(layout).toContain("firstSidebarNewSessionTarget")
    expect(layout).toContain("visibleSidebarNewSessionIDs")
    expect(layout).toContain("data-sidebar-new-session-labels")
    expect(noticeStyles).toMatch(/\[data-sidebar-new-session-label\]\s*\{[\s\S]*font-variant-numeric: tabular-nums/)
    expect(noticeStyles).toContain("@keyframes sidebar-new-session-count-in")
    expect(noticeStyles).toContain("@keyframes sidebar-new-session-count-out")
    const countAnimations = noticeStyles.slice(
      noticeStyles.indexOf("@keyframes sidebar-new-session-count-in"),
      noticeStyles.indexOf("[data-sidebar-new-session-notice] button:focus-visible"),
    )
    expect(countAnimations).not.toContain("transform:")
    expect(noticeStyles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*data-sidebar-new-session-label/)
  })

  test("confirms the reached row only after scrolling settles", () => {
    expect(layout).toContain('container.addEventListener("scrollend", finish)')
    expect(layout).toContain('item.setAttribute("data-session-new-arrival", "")')
    expect(layout).toContain('event.animationName !== "sidebar-session-new-arrival"')
    expect(itemStyles).toContain("@keyframes sidebar-session-new-arrival")
    expect(itemStyles).toContain("animation: sidebar-session-new-arrival 220ms ease-out")
  })

  test("uses only a neutral opacity layer and disables it for accessibility modes", () => {
    expect(itemStyles).toMatch(
      /\[data-sidebar-session-item\]\[data-session-new-arrival\][\s\S]*background-color: color-mix\(in srgb, var\(--v2-background-bg-layer-02\) 16%, transparent\)/,
    )
    expect(itemStyles).not.toContain("[data-session-new-arrival] {\n  transform:")
    expect(itemStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*data-session-new-arrival[\s\S]*animation: none/,
    )
    expect(itemStyles).toMatch(/@media \(forced-colors: active\)[\s\S]*data-session-new-arrival[\s\S]*animation: none/)
  })
})
