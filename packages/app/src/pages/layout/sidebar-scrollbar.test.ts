import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  createSidebarScrollbarController,
  sidebarScrollEdges,
  SIDEBAR_SCROLLBAR_SCROLL_IDLE_MS,
} from "./sidebar-scrollbar"

const css = readFileSync(new URL("./sidebar-scrollbar.css", import.meta.url), "utf8")

describe("sidebar overlay scrollbar", () => {
  test("uses a transparent native lane and fades the thumb without changing geometry", () => {
    expect(css).toContain("--sidebar-scrollbar-visual-width: 3px")
    expect(css).toContain("background-color: transparent")
    expect(css).toContain("transition: background-color 160ms ease-out")
  })

  test("reserves one stable trailing gutter for fine-pointer desktop layouts", () => {
    const baseScrollbar =
      [...css.matchAll(/\[data-sidebar-scrollbar\] \{(?<declarations>[\s\S]*?)\n\}/g)].find((rule) =>
        rule.groups?.declarations.includes("overflow-y: auto"),
      )?.groups?.declarations ?? ""
    const stateRules = [
      ...css.matchAll(
        /\[data-sidebar-scrollbar\]:is\(:hover, :focus-within, \[data-sidebar-scrollbar-scrolling\]\)[^{]*\{(?<declarations>[\s\S]*?)\n\}/g,
      ),
    ]

    expect(baseScrollbar).toContain("scrollbar-gutter: stable")
    expect(baseScrollbar).not.toContain("both-edges")
    expect(css.match(/scrollbar-gutter:\s*stable/g)).toHaveLength(1)
    expect(stateRules.every((rule) => !rule.groups?.declarations.includes("scrollbar-gutter"))).toBe(true)
  })

  test("releases the stable gutter for hoverless and coarse-pointer inputs", () => {
    const touchStyles = css.slice(
      css.indexOf("@media (hover: none), (pointer: coarse)"),
      css.indexOf("@media (forced-colors: active)"),
    )
    const touchScrollbar =
      touchStyles.match(/\[data-sidebar-scrollbar\] \{(?<declarations>[\s\S]*?)\n  \}/)?.groups?.declarations ?? ""

    expect(touchStyles).toContain("@media (hover: none), (pointer: coarse)")
    expect(touchScrollbar).toContain("scrollbar-gutter: auto")
    expect(touchScrollbar).not.toContain("stable")
    expect(css.match(/scrollbar-gutter:\s*auto/g)).toHaveLength(1)
    expect(touchScrollbar).not.toMatch(/(?:margin|padding|inset-inline|translate|transform)\s*:/)
  })

  test("centers a three pixel visual thumb inside the native ten pixel lane without layout compensation", () => {
    const baseScrollbar =
      [...css.matchAll(/\[data-sidebar-scrollbar\] \{(?<declarations>[\s\S]*?)\n\}/g)].find((rule) =>
        rule.groups?.declarations.includes("overflow-y: auto"),
      )?.groups?.declarations ?? ""
    const scrollbar =
      css.match(/\[data-sidebar-scrollbar\]::-webkit-scrollbar \{(?<declarations>[\s\S]*?)\n\}/)?.groups
        ?.declarations ?? ""
    const thumb =
      css.match(/\[data-sidebar-scrollbar\]::-webkit-scrollbar-thumb \{(?<declarations>[\s\S]*?)\n\}/)?.groups
        ?.declarations ?? ""
    const gutterWidth = Number(css.match(/--sidebar-scrollbar-gutter-width:\s*(?<value>[\d.]+)px/)?.groups?.value)
    const visualWidth = Number(css.match(/--sidebar-scrollbar-visual-width:\s*(?<value>[\d.]+)px/)?.groups?.value)
    const visualInset = Number(css.match(/--sidebar-scrollbar-visual-inset:\s*(?<value>[\d.]+)px/)?.groups?.value)

    expect(css).toContain("--sidebar-scrollbar-gutter-width: 10px")
    expect(css).toContain("--sidebar-scrollbar-visual-width: 3px")
    expect(css).toContain("--sidebar-scrollbar-visual-inset: 3.5px")
    expect(scrollbar).toContain("width: var(--sidebar-scrollbar-gutter-width)")
    expect(thumb).toContain("border-inline: var(--sidebar-scrollbar-visual-inset) solid transparent")
    expect(thumb).toContain("background-clip: padding-box")
    expect(baseScrollbar).toContain("scrollbar-width: thin")
    expect(baseScrollbar).not.toMatch(/(?:margin|padding|inset-inline|translate|transform)\s*:/)
    expect(gutterWidth - visualInset * 2).toBe(visualWidth)
  })

  test("keeps the track and corner transparent while only the thin thumb becomes visible", () => {
    const baseScrollbar =
      [...css.matchAll(/\[data-sidebar-scrollbar\] \{(?<declarations>[\s\S]*?)\n\}/g)].find((rule) =>
        rule.groups?.declarations.includes("overflow-y: auto"),
      )?.groups?.declarations ?? ""
    const trackRule =
      css.match(
        /\[data-sidebar-scrollbar\]::-[\w-]*scrollbar-track,\n\[data-sidebar-scrollbar\]::-[\w-]*scrollbar-corner \{(?<declarations>[\s\S]*?)\n\}/,
      )?.groups?.declarations ?? ""
    const interactiveScrollbar =
      css.match(
        /\[data-sidebar-scrollbar\]:is\(:hover, :focus-within, \[data-sidebar-scrollbar-scrolling\]\) \{(?<declarations>[\s\S]*?)\n\}/,
      )?.groups?.declarations ?? ""
    const normalStyles = css.slice(0, css.indexOf("@media (forced-colors: active)"))
    const interactiveRules = [
      ...normalStyles.matchAll(
        /\[data-sidebar-scrollbar\]:is\(:hover, :focus-within, \[data-sidebar-scrollbar-scrolling\]\)(?<target>[^{]*)\{(?<declarations>[\s\S]*?)\n\}/g,
      ),
    ]
    const forcedColors = css.slice(
      css.indexOf("@media (forced-colors: active)"),
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
    )

    expect(baseScrollbar).toContain("scrollbar-color: transparent transparent")
    expect(trackRule.trim()).toBe("background: transparent;")
    expect(interactiveScrollbar).toMatch(/scrollbar-color:[^;]+ transparent;/)
    expect(interactiveRules).toHaveLength(2)
    expect(interactiveRules.some((rule) => rule.groups?.target.includes("scrollbar-thumb"))).toBe(true)
    expect(interactiveRules.every((rule) => !/scrollbar-(?:track|corner)/.test(rule.groups?.target ?? ""))).toBe(true)
    expect(forcedColors).toContain("scrollbar-color: CanvasText transparent !important")
    expect(forcedColors).toContain(
      "[data-sidebar-scrollbar]:is(:hover, :focus-within, [data-sidebar-scrollbar-scrolling])::-webkit-scrollbar-thumb",
    )
    expect(forcedColors).toContain("background-color: CanvasText !important")
  })

  test("uses one semantic fifty-two percent thumb color for hover, focus, and scrolling", () => {
    const normalStyles = css.slice(0, css.indexOf("@media (forced-colors: active)"))
    const colorRules = [
      ...normalStyles.matchAll(
        /(?<selector>\[data-sidebar-scrollbar\]:is\([^{}]+\)[^{]*)\{(?<declarations>[\s\S]*?)\n\}/g,
      ),
    ].filter((rule) => rule.groups?.declarations.includes("color-mix"))
    const expectedStateSelector =
      "[data-sidebar-scrollbar]:is(:hover, :focus-within, [data-sidebar-scrollbar-scrolling])"
    const expectedColor = "color-mix(in srgb, var(--v2-icon-icon-muted) 52%, transparent)"

    expect(colorRules.map((rule) => rule.groups?.selector.trim())).toEqual([
      expectedStateSelector,
      `${expectedStateSelector}::-webkit-scrollbar-thumb`,
    ])
    expect(colorRules).toHaveLength(2)
    expect(colorRules.every((rule) => rule.groups?.declarations.includes(expectedColor))).toBe(true)
    expect(normalStyles.match(/var\(--v2-icon-icon-muted\) 52%, transparent/g)).toHaveLength(2)
    const stateSpecificColorRules = [
      ...normalStyles.matchAll(
        /(?<selector>\[data-sidebar-scrollbar\](?::hover|:focus-within|\[data-sidebar-scrollbar-scrolling\])[^{]*)\{(?<declarations>[\s\S]*?)\n\}/g,
      ),
    ].filter((rule) => rule.groups?.declarations.includes("color-mix"))

    expect(stateSpecificColorRules).toHaveLength(0)
  })

  test("releases pointer-created desktop focus after hover leaves", () => {
    const desktopStyles = css.slice(
      css.indexOf("@media (hover: hover) and (pointer: fine)"),
      css.indexOf("@media (hover: none), (pointer: coarse)"),
    )
    const ordinaryFocusSelector =
      "[data-sidebar-scrollbar]:focus-within:not(:hover):not(:focus-visible):not(:has(:focus-visible)):not([data-sidebar-scrollbar-scrolling])"
    const normalizedDesktopStyles = desktopStyles
      .replace(/\s+/g, " ")
      .replace(/:not\( /g, ":not(")
      .replace(/ \)/g, ")")

    expect(desktopStyles).toContain("@media (hover: hover) and (pointer: fine)")
    expect(normalizedDesktopStyles).toContain(`${ordinaryFocusSelector} { scrollbar-color: transparent transparent; }`)
    expect(normalizedDesktopStyles).toContain(
      `${ordinaryFocusSelector}::-webkit-scrollbar-thumb { background-color: transparent; }`,
    )
    expect(normalizedDesktopStyles.split(ordinaryFocusSelector)).toHaveLength(3)
    expect(ordinaryFocusSelector).toContain(":not(:hover)")
    expect(ordinaryFocusSelector).toContain(":not(:focus-visible)")
    expect(ordinaryFocusSelector).toContain(":not(:has(:focus-visible))")
    expect(ordinaryFocusSelector).toContain(":not([data-sidebar-scrollbar-scrolling])")
  })

  test("neutralizes hover-only reveal on touch while preserving keyboard focus and scrolling", () => {
    const touchStyles = css.slice(
      css.indexOf("@media (hover: none), (pointer: coarse)"),
      css.indexOf("@media (forced-colors: active)"),
    )
    const hoverOnlySelector =
      "[data-sidebar-scrollbar]:hover:not(:focus-within):not([data-sidebar-scrollbar-scrolling])"
    const normalizedTouchStyles = touchStyles
      .replace(/\s+/g, " ")
      .replace(/:not\( /g, ":not(")
      .replace(/ \)/g, ")")

    expect(touchStyles).toContain("@media (hover: none), (pointer: coarse)")
    expect(normalizedTouchStyles).toContain(`${hoverOnlySelector} { scrollbar-color: transparent transparent; }`)
    expect(normalizedTouchStyles).toContain(
      `${hoverOnlySelector}::-webkit-scrollbar-thumb { background-color: transparent; }`,
    )
    expect(normalizedTouchStyles.split(hoverOnlySelector)).toHaveLength(3)
    expect(touchStyles).not.toContain("color-mix")
  })

  test("suppresses ordinary touch focus without hiding focus-visible or active scrolling", () => {
    const touchStyles = css.slice(
      css.indexOf("@media (hover: none), (pointer: coarse)"),
      css.indexOf("@media (forced-colors: active)"),
    )
    const ordinaryFocusSelector =
      "[data-sidebar-scrollbar]:focus-within:not(:focus-visible):not(:has(:focus-visible)):not([data-sidebar-scrollbar-scrolling])"
    const normalizedTouchStyles = touchStyles
      .replace(/\s+/g, " ")
      .replace(/:not\( /g, ":not(")
      .replace(/ \)/g, ")")

    expect(normalizedTouchStyles).toContain(`${ordinaryFocusSelector} { scrollbar-color: transparent transparent; }`)
    expect(normalizedTouchStyles).toContain(
      `${ordinaryFocusSelector}::-webkit-scrollbar-thumb { background-color: transparent; }`,
    )
    expect(normalizedTouchStyles.split(ordinaryFocusSelector)).toHaveLength(3)
    expect(ordinaryFocusSelector).toContain(":not(:focus-visible)")
    expect(ordinaryFocusSelector).toContain(":not(:has(:focus-visible))")
    expect(ordinaryFocusSelector).toContain(":not([data-sidebar-scrollbar-scrolling])")
  })

  test("keeps the thumb as one twenty-eight pixel minimum pill in every state", () => {
    const normalStyles = css.slice(0, css.indexOf("@media (forced-colors: active)"))
    const thumbRules = [
      ...normalStyles.matchAll(
        /(?<selector>\[data-sidebar-scrollbar\][^{]*scrollbar-thumb)\s*\{(?<declarations>[\s\S]*?)\n\}/g,
      ),
    ]
    const baseThumb = thumbRules.find(
      (rule) => rule.groups?.selector.trim() === "[data-sidebar-scrollbar]::-webkit-scrollbar-thumb",
    )?.groups?.declarations
    const stateThumb = thumbRules.find((rule) => rule.groups?.selector.includes(":is("))?.groups?.declarations

    expect(baseThumb).toContain("min-height: 28px")
    expect(baseThumb).toContain("border-radius: 999px")
    expect(baseThumb).not.toMatch(/(?:transform|scale|translate)\s*:/)
    expect(stateThumb).not.toMatch(/(?:min-height|height|border-radius|transform|scale|translate)\s*:/)
    expect(css.match(/min-height:/g)).toHaveLength(1)
    expect(css.match(/border-radius:/g)).toHaveLength(1)
    expect(css.match(/min-height:\s*28px/g)).toHaveLength(1)
    expect(css.match(/border-radius:\s*999px/g)).toHaveLength(1)
  })

  test("fades hover and focus exits immediately using only the thumb background color", () => {
    const normalStyles = css.slice(0, css.indexOf("@media (forced-colors: active)"))
    const thumbRules = [
      ...normalStyles.matchAll(
        /(?<selector>\[data-sidebar-scrollbar\][^{]*scrollbar-thumb)\s*\{(?<declarations>[\s\S]*?)\n\}/g,
      ),
    ]
    const baseThumb = thumbRules.find(
      (rule) => rule.groups?.selector.trim() === "[data-sidebar-scrollbar]::-webkit-scrollbar-thumb",
    )?.groups?.declarations
    const stateThumb = thumbRules.find((rule) => rule.groups?.selector.includes(":is("))?.groups?.declarations
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))

    expect(baseThumb?.match(/transition:\s*(?<value>[^;]+);/)?.groups?.value.trim()).toBe(
      "background-color 160ms ease-out",
    )
    expect(baseThumb).not.toMatch(/(?:transition-delay|animation|opacity|transform|translate|scale|filter)\s*:/)
    expect(stateThumb).not.toContain("transition")
    expect(normalStyles).not.toContain("transition-delay")
    expect(normalStyles).not.toContain("data-sidebar-scrollbar-hover")
    expect(normalStyles).not.toContain("data-sidebar-scrollbar-focused")
    expect(css).not.toMatch(/transition:\s*(?:all|opacity|width|height|transform|translate|scale|filter)/)
    expect(reducedMotion).toContain("[data-sidebar-scrollbar]::-webkit-scrollbar-thumb")
    expect(reducedMotion).toContain("transition: none")
  })

  test("stays visible for pointer hover, keyboard focus, and active scrolling", () => {
    expect(css).toContain(":hover")
    expect(css).toContain(":focus-within")
    expect(css).toContain("[data-sidebar-scrollbar-scrolling]")
  })

  test("keeps a forced-colors fallback and removes fading under reduced motion", () => {
    expect(css).toContain("@media (forced-colors: active)")
    expect(css).toContain("scrollbar-color: CanvasText transparent")
    const reducedMotion = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? ""
    expect(reducedMotion).toContain("transition: none")
  })

  test("uses a restrained twelve pixel mask only in directions with more content", () => {
    expect(css).toContain("#000 12px")
    expect(css).toContain("#000 calc(100% - 12px)")
    expect(css).toContain("[data-sidebar-scroll-above]")
    expect(css).toContain("[data-sidebar-scroll-below]")
    expect(css).toContain("--sidebar-scroll-edge-top-alpha: 0.78")
    expect(css).toContain("--sidebar-scroll-edge-bottom-alpha: 0.78")
  })

  test("removes content fading in forced colors", () => {
    const forcedColors = css.match(/@media \(forced-colors: active\) \{([\s\S]*?)\n\}/)?.[1] ?? ""
    expect(forcedColors).toContain("-webkit-mask-image: none")
    expect(forcedColors).toContain("mask-image: none")
  })

  test("keeps the scrolling thumb visible for exactly eight hundred milliseconds after the latest event", () => {
    const attributes = new Set<string>()
    const delays: number[] = []
    const callbacks: Array<() => void> = []
    const cancelled: number[] = []
    const controller = createSidebarScrollbarController({
      schedule: (callback, delay) => {
        callbacks.push(callback)
        delays.push(delay)
        return callbacks.length
      },
      cancel: (handle) => cancelled.push(handle as number),
    })
    const element = {
      setAttribute: (name: string) => attributes.add(name),
      removeAttribute: (name: string) => attributes.delete(name),
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 50,
    }

    expect(SIDEBAR_SCROLLBAR_SCROLL_IDLE_MS).toBe(800)
    controller.showScrolling(element)
    controller.showScrolling(element)
    expect(delays).toEqual([800, 800])
    expect(cancelled).toEqual([1])
    expect(attributes.has("data-sidebar-scrollbar-scrolling")).toBe(true)

    callbacks[0]?.()
    expect(attributes.has("data-sidebar-scrollbar-scrolling")).toBe(true)
    callbacks[1]?.()
    expect(attributes.has("data-sidebar-scrollbar-scrolling")).toBe(false)
  })

  test("shows on scroll and hides after the short idle interval", () => {
    const attributes = new Set<string>()
    let callback: (() => void) | undefined
    let delay = 0
    const controller = createSidebarScrollbarController({
      schedule: (next, nextDelay) => {
        callback = next
        delay = nextDelay
        return 1
      },
      cancel: () => undefined,
    })
    const element = {
      setAttribute: (name: string) => {
        attributes.add(name)
      },
      removeAttribute: (name: string) => {
        attributes.delete(name)
      },
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 50,
    }

    controller.showScrolling(element)
    expect(attributes.has("data-sidebar-scrollbar-scrolling")).toBe(true)
    expect(delay).toBe(SIDEBAR_SCROLLBAR_SCROLL_IDLE_MS)

    callback?.()
    expect(attributes.has("data-sidebar-scrollbar-scrolling")).toBe(false)
  })

  test("restarts the idle interval without allowing an older timer to hide the thumb", () => {
    const attributes = new Set<string>()
    const callbacks: Array<() => void> = []
    const cancelled: number[] = []
    const controller = createSidebarScrollbarController({
      schedule: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
      cancel: (handle) => cancelled.push(handle as number),
    })
    const element = {
      setAttribute: (name: string) => {
        attributes.add(name)
      },
      removeAttribute: (name: string) => {
        attributes.delete(name)
      },
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 50,
    }

    controller.showScrolling(element)
    controller.showScrolling(element)
    expect(cancelled).toEqual([1])

    callbacks[0]?.()
    expect(attributes.has("data-sidebar-scrollbar-scrolling")).toBe(true)

    callbacks[1]?.()
    expect(attributes.has("data-sidebar-scrollbar-scrolling")).toBe(false)
  })

  test("updates directional attributes without adding an interactive overlay", () => {
    const attributes = new Set<string>()
    const element = {
      setAttribute: (name: string) => {
        attributes.add(name)
      },
      removeAttribute: (name: string) => {
        attributes.delete(name)
      },
      scrollTop: 80,
      scrollHeight: 500,
      clientHeight: 200,
    }
    const controller = createSidebarScrollbarController()

    controller.update(element)
    expect(attributes.has("data-sidebar-scroll-above")).toBe(true)
    expect(attributes.has("data-sidebar-scroll-below")).toBe(true)

    element.scrollTop = 300
    controller.update(element)
    expect(attributes.has("data-sidebar-scroll-above")).toBe(true)
    expect(attributes.has("data-sidebar-scroll-below")).toBe(false)
  })
})

describe("sidebar scroll edge geometry", () => {
  test("shows only the lower fade at the top", () => {
    expect(sidebarScrollEdges({ scrollTop: 0, scrollHeight: 500, clientHeight: 200 })).toEqual({
      above: false,
      below: true,
    })
  })

  test("shows both fades between edges", () => {
    expect(sidebarScrollEdges({ scrollTop: 120, scrollHeight: 500, clientHeight: 200 })).toEqual({
      above: true,
      below: true,
    })
  })

  test("shows only the upper fade at the bottom", () => {
    expect(sidebarScrollEdges({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 })).toEqual({
      above: true,
      below: false,
    })
  })

  test("shows no fade when content does not overflow", () => {
    expect(sidebarScrollEdges({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 })).toEqual({
      above: false,
      below: false,
    })
  })

  test("ignores fractional scroll noise at either edge", () => {
    expect(sidebarScrollEdges({ scrollTop: 0.5, scrollHeight: 500, clientHeight: 200 }).above).toBe(false)
    expect(sidebarScrollEdges({ scrollTop: 299.5, scrollHeight: 500, clientHeight: 200 }).below).toBe(false)
  })
})
