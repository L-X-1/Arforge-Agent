import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { sessionRevealDelta, sessionScrollDelta } from "./session-scroll"

const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8")
const styles = readFileSync(new URL("./sidebar-items.css", import.meta.url), "utf8")

describe("active session reveal geometry", () => {
  test("does not move a row already inside the safe inset", () => {
    expect(
      sessionRevealDelta({
        containerTop: 100,
        containerBottom: 500,
        targetTop: 108,
        targetBottom: 140,
        inset: 8,
      }),
    ).toBe(0)
  })

  test("moves upward only by the amount clipped above the safe inset", () => {
    expect(
      sessionRevealDelta({
        containerTop: 100,
        containerBottom: 500,
        targetTop: 92,
        targetBottom: 124,
        inset: 8,
      }),
    ).toBe(-16)
  })

  test("moves downward only by the amount clipped below the safe inset", () => {
    expect(
      sessionRevealDelta({
        containerTop: 100,
        containerBottom: 500,
        targetTop: 480,
        targetBottom: 516,
        inset: 8,
      }),
    ).toBe(24)
  })

  test("does not move a row exactly touching either safe boundary", () => {
    expect(
      sessionRevealDelta({
        containerTop: 100,
        containerBottom: 500,
        targetTop: 108,
        targetBottom: 492,
        inset: 8,
      }),
    ).toBe(0)
  })
})

describe("active session scroll bounds", () => {
  test("preserves the requested movement when it fits inside the scroll range", () => {
    expect(
      sessionScrollDelta({
        scrollTop: 100,
        requestedDelta: 24,
        scrollHeight: 600,
        clientHeight: 300,
      }),
    ).toBe(24)
  })

  test("clamps movement at the top and bottom boundaries", () => {
    expect(
      sessionScrollDelta({
        scrollTop: 4,
        requestedDelta: -12,
        scrollHeight: 600,
        clientHeight: 300,
      }),
    ).toBe(-4)
    expect(
      sessionScrollDelta({
        scrollTop: 296,
        requestedDelta: 20,
        scrollHeight: 600,
        clientHeight: 300,
      }),
    ).toBe(4)
  })

  test("reports no actual movement at a reached boundary", () => {
    expect(
      sessionScrollDelta({
        scrollTop: 300,
        requestedDelta: 20,
        scrollHeight: 600,
        clientHeight: 300,
      }),
    ).toBe(0)
  })
})

describe("active session reveal integration contract", () => {
  test("scrolls each sidebar container directly without changing focus", () => {
    expect(layout).toContain("scrollContainerRefs")
    expect(layout).toContain("container.scrollBy({")
    expect(layout).not.toContain('element.scrollIntoView({ block: "nearest", behavior: "smooth" })')
    expect(layout).not.toContain(".focus(")
  })

  test("uses smooth motion unless reduced motion is requested", () => {
    expect(layout).toContain('matchMedia("(prefers-reduced-motion: reduce)")')
    expect(layout).toContain('behavior: reducedMotion ? "auto" : "smooth"')
    expect(layout).toContain("if (!reducedMotion) revealSessionAfterScroll(container, element)")
  })

  test("retries after the routed session becomes available without competing scrolls", () => {
    expect(layout).toContain("sessionStore.session.some((session) => session.id === id)")
    expect(layout).toContain("scrollSessionKeys.get(container) === sessionKey")
    expect(layout).toContain("cancelSessionReveal(container)")
  })

  test("confirms only an active row after real container scrolling settles", () => {
    expect(layout).toContain('container.addEventListener("scrollend", finish)')
    expect(layout).toContain('container.addEventListener("scroll", onScroll, { passive: true })')
    expect(layout).toContain('element.querySelector<HTMLElement>("[data-sidebar-session-row].active")')
    expect(layout).toContain('element.setAttribute("data-session-auto-reveal", "")')
    expect(layout).toContain("if (scrollDelta === 0) continue")
  })

  test("uses one composited neutral material pulse without transform or accent color", () => {
    expect(styles).toContain("@keyframes sidebar-session-auto-reveal")
    expect(styles).toContain("4.55%")
    expect(styles).toContain("animation: sidebar-session-auto-reveal 220ms ease-out")
    expect(styles).not.toContain("[data-session-auto-reveal] {\n  transform:")
  })

  test("removes the confirmation animation for reduced motion and forced colors", () => {
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)")
    expect(styles).toContain("@media (forced-colors: active)")
    expect(styles.match(/\[data-sidebar-session-item\]\[data-session-auto-reveal\]/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
