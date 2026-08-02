import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { sidebarPrimaryActionLabelIsTruncated } from "./sidebar-primary-action-overflow"
import { sidebarScrollEdges, SIDEBAR_SCROLL_EDGE_THRESHOLD } from "./sidebar-scrollbar"

const panelStyles = readFileSync(new URL("./sidebar-panel.css", import.meta.url), "utf8")
const scrollbarStyles = readFileSync(new URL("./sidebar-scrollbar.css", import.meta.url), "utf8")
const layoutSource = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8")
const tooltipSource = readFileSync(new URL("./sidebar-primary-action-tooltip.tsx", import.meta.url), "utf8")
const sharedTooltipSource = readFileSync(
  new URL("../../../../ui/src/v2/components/tooltip-v2.tsx", import.meta.url),
  "utf8",
)
const materialStyles = readFileSync(new URL("../../../../ui/src/styles/arforge-materials.css", import.meta.url), "utf8")

describe("sidebar primary action motion", () => {
  test("keeps the primary creation action between the project header and the scrolling list", () => {
    const dockSelector = "[data-sidebar-primary-action-dock] {"
    const dockStart = panelStyles.indexOf(dockSelector)
    const dockEnd = panelStyles.indexOf("}", dockStart)
    const dockStyles = panelStyles.slice(dockStart, dockEnd + 1)
    const firstDock = layoutSource.indexOf("<div data-sidebar-primary-action-dock>")
    const firstList = layoutSource.indexOf("<LocalWorkspace", firstDock)
    const secondDock = layoutSource.indexOf("<div data-sidebar-primary-action-dock>", firstDock + 1)
    const secondList = layoutSource.indexOf("data-sidebar-workspace-scroll", secondDock)

    expect(layoutSource.match(/<div data-sidebar-primary-action-dock>/g)).toHaveLength(2)
    expect(firstDock).toBeGreaterThan(layoutSource.indexOf("data-sidebar-project-header"))
    expect(firstDock).toBeLessThan(firstList)
    expect(secondDock).toBeGreaterThan(firstDock)
    expect(secondDock).toBeLessThan(secondList)
    expect(dockStart).not.toBe(-1)
    expect(dockStyles).toContain("flex: 0 0 auto")
    expect(dockStyles).toContain("width: 100%")
    expect(dockStyles).toContain("padding-block: 8px")
    expect(dockStyles).toContain("position: relative")
    expect(dockStyles).not.toContain("position: sticky")
    expect(dockStyles).not.toContain("position: fixed")
    expect(dockStyles).not.toContain("position: absolute")
    expect(dockStyles).not.toContain("z-index")
  })

  test("keeps eight pixels of symmetric space above and below both primary actions", () => {
    const dockRules = [...panelStyles.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/g)].filter(
      (rule) =>
        rule.groups?.selectors.includes("[data-sidebar-primary-action-dock]") &&
        !rule.groups.selectors.includes("::after"),
    )
    const dockSpacingRules = dockRules.filter((rule) => rule.groups?.declarations.includes("padding"))

    expect(layoutSource.match(/<div data-sidebar-primary-action-dock>/g)).toHaveLength(2)
    expect(dockSpacingRules).toHaveLength(1)
    expect(dockSpacingRules[0]?.groups?.declarations).toContain("padding-block: 8px")
    expect(dockSpacingRules[0]?.groups?.declarations).not.toMatch(
      /padding(?:-block)?-(?:start|end)|padding-(?:top|bottom)|padding\s*:/,
    )
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action-dock\][^{]*(?:data-collapsed|aria-busy|data-pending)[^{]*\{[^}]*padding/,
    )
  })

  test("reveals the dock boundary only after the adjacent list leaves its top edge", () => {
    const dividerSelector = "[data-sidebar-primary-action-dock]::after {"
    const dividerStart = panelStyles.indexOf(dividerSelector)
    const dividerEnd = panelStyles.indexOf("}", dividerStart)
    const dividerStyles = panelStyles.slice(dividerStart, dividerEnd + 1)
    const scrolledSelector = "[data-sidebar-primary-action-dock]:has(+ * [data-sidebar-scroll-above])::after {"
    const scrolledStart = panelStyles.indexOf(scrolledSelector)
    const scrolledEnd = panelStyles.indexOf("}", scrolledStart)
    const scrolledStyles = panelStyles.slice(scrolledStart, scrolledEnd + 1)

    expect(dividerStart).not.toBe(-1)
    expect(dividerStyles).toContain("height: 0.5px")
    expect(dividerStyles).toContain("background: var(--arforge-hairline)")
    expect(dividerStyles).toContain("opacity: 0")
    expect(dividerStyles).toContain("transition: opacity 160ms ease-out")
    expect(scrolledStart).not.toBe(-1)
    expect(scrolledStyles).toContain("opacity: 1")
    expect(scrollbarStyles).toContain("[data-sidebar-scrollbar][data-sidebar-scroll-above] {")
    expect(scrollbarStyles).toContain("--sidebar-scroll-edge-top-alpha: 0.78")
    expect(scrollbarStyles).toContain("#000 12px")

    const forcedColorsStyles = panelStyles.slice(
      panelStyles.indexOf("@media (forced-colors: active)"),
      panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"),
    )
    const reducedMotionStyles = panelStyles.slice(panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(forcedColorsStyles).toMatch(/\[data-sidebar-primary-action-dock\]::after \{[\s\S]*background: CanvasText/)
    expect(reducedMotionStyles).toContain("[data-sidebar-primary-action-dock]::after")
  })

  test("insets the dock boundary twelve pixels from the logical start and four from the end", () => {
    const dividerSelector = "[data-sidebar-primary-action-dock]::after {"
    const dividerStart = panelStyles.indexOf(dividerSelector)
    const dividerEnd = panelStyles.indexOf("}", dividerStart)
    const dividerStyles = panelStyles.slice(dividerStart, dividerEnd + 1)

    expect(dividerStart).not.toBe(-1)
    expect(dividerStyles).toContain("inset-inline-start: 12px")
    expect(dividerStyles).toContain("inset-inline-end: 4px")
    expect(dividerStyles).toContain("bottom: 0")
    expect(dividerStyles).not.toMatch(/(?:^|\s)(?:left|right)\s*:/)
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action-dock\][^{]*::after[^{]*\{[^}]*(?:inset-inline|left|right)[^}]*(?:data-collapsed|aria-busy|data-pending)/,
    )
  })

  test("pins the dock boundary exactly to the list edge without vertical offsets", () => {
    const dividerRules = [...panelStyles.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/g)].filter((rule) =>
      rule.groups?.selectors.includes("[data-sidebar-primary-action-dock]::after"),
    )
    const verticalPositionRules = dividerRules.filter((rule) =>
      /(?:bottom|top|inset-block|margin|transform|translate)\s*:/.test(rule.groups?.declarations ?? ""),
    )

    expect(verticalPositionRules).toHaveLength(1)
    expect(verticalPositionRules[0]?.groups?.declarations).toContain("bottom: 0")
    expect(verticalPositionRules[0]?.groups?.declarations).not.toMatch(
      /(?:top|inset-block|margin|transform|translate)\s*:/,
    )
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action-dock\][^{]*::after[^{]*\{[^}]*(?:bottom|top|inset-block|margin|transform|translate)\s*:[^}]*(?:data-collapsed|aria-busy|data-pending)/,
    )
  })

  test("keeps the dock boundary at one half CSS pixel without scale simulation", () => {
    const dividerRules = [...panelStyles.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/g)].filter((rule) =>
      rule.groups?.selectors.includes("[data-sidebar-primary-action-dock]::after"),
    )
    const thicknessRules = dividerRules.filter((rule) =>
      /(?:height|block-size|border(?:-block)?|transform|scale)\s*:/.test(rule.groups?.declarations ?? ""),
    )

    expect(thicknessRules).toHaveLength(1)
    expect(thicknessRules[0]?.groups?.declarations).toContain("height: 0.5px")
    expect(thicknessRules[0]?.groups?.declarations).not.toMatch(/(?:block-size|border(?:-block)?|transform|scale)\s*:/)
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action-dock\][^{]*::after[^{]*\{[^}]*(?:height|block-size|border(?:-block)?|transform|scale)\s*:[^}]*(?:data-collapsed|aria-busy|data-pending)/,
    )
  })

  test("sources the dock boundary color from the theme-aware semantic hairline token", () => {
    const dividerRules = [...panelStyles.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/g)].filter((rule) =>
      rule.groups?.selectors.includes("[data-sidebar-primary-action-dock]::after"),
    )
    const colorRules = dividerRules.filter((rule) =>
      /(?:background(?:-color)?|color)\s*:/.test(rule.groups?.declarations ?? ""),
    )
    const semanticRule = colorRules.find((rule) =>
      rule.groups?.declarations.includes("background: var(--arforge-hairline)"),
    )
    const forcedColorsRule = colorRules.find((rule) => rule.groups?.declarations.includes("background: CanvasText"))
    const lightTheme = materialStyles.match(/:root\s*\{(?<declarations>[^}]*)\}/)
    const darkTheme = materialStyles.match(/:root\[data-color-scheme="dark"\]\s*\{(?<declarations>[^}]*)\}/)

    expect(colorRules).toHaveLength(2)
    expect(semanticRule?.groups?.selectors.trim()).toBe("[data-sidebar-primary-action-dock]::after")
    expect(semanticRule?.groups?.declarations).not.toMatch(/(?:color-mix|rgba?\(|hsla?\(|#[0-9a-f]{3,8})/i)
    expect(forcedColorsRule?.groups?.declarations).toContain("background: CanvasText")
    expect(lightTheme?.groups?.declarations).toMatch(
      /--arforge-hairline:\s*color-mix\(in srgb,\s*var\(--text-strong\)\s+12%,\s*transparent\)/,
    )
    expect(darkTheme?.groups?.declarations).toMatch(
      /--arforge-hairline:\s*color-mix\(in srgb,\s*white\s+12%,\s*transparent\)/,
    )
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action-dock\][^{]*::after[^{]*\{[^}]*(?:background(?:-color)?|color)\s*:[^}]*(?:data-collapsed|aria-busy|data-pending)/,
    )
  })

  test("fades the dock boundary over 160ms without delay, movement, or scaling", () => {
    const dividerSelector = "[data-sidebar-primary-action-dock]::after {"
    const dividerStart = panelStyles.indexOf(dividerSelector)
    const dividerEnd = panelStyles.indexOf("}", dividerStart)
    const dividerStyles = panelStyles.slice(dividerStart, dividerEnd + 1)
    const reducedMotionStyles = panelStyles.slice(panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"))

    expect(dividerStart).not.toBe(-1)
    expect(dividerStyles).toContain("transition: opacity 160ms ease-out")
    expect(dividerStyles).not.toMatch(
      /(?:transition-delay|animation|transform|translate|scale|filter|backdrop-filter)\s*:/,
    )
    expect(dividerStyles).not.toContain("transition: all")
    expect(reducedMotionStyles).toMatch(/\[data-sidebar-primary-action-dock\]::after,[\s\S]*\{\s*transition: none;/)
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action-dock\][^{]*::after[^{]*\{[^}]*(?:transition|animation|transform|translate|scale|filter|backdrop-filter)\s*:[^}]*(?:data-collapsed|aria-busy|data-pending)/,
    )
  })

  test("reuses the shared one-pixel scroll threshold for the dock boundary", () => {
    const scrolledSelector = "[data-sidebar-primary-action-dock]:has(+ * [data-sidebar-scroll-above])::after {"
    const atThreshold = sidebarScrollEdges({
      scrollTop: SIDEBAR_SCROLL_EDGE_THRESHOLD,
      scrollHeight: 500,
      clientHeight: 200,
    })
    const beyondThreshold = sidebarScrollEdges({
      scrollTop: SIDEBAR_SCROLL_EDGE_THRESHOLD + 0.01,
      scrollHeight: 500,
      clientHeight: 200,
    })

    expect(SIDEBAR_SCROLL_EDGE_THRESHOLD).toBe(1)
    expect(atThreshold.above).toBe(false)
    expect(beyondThreshold.above).toBe(true)
    expect(panelStyles).toContain(scrolledSelector)
    expect(panelStyles.match(/data-sidebar-scroll-above/g)).toHaveLength(1)
    expect(layoutSource).not.toContain("data-sidebar-primary-action-scroll-threshold")
    expect(layoutSource).not.toContain("data-sidebar-primary-action-scrolled")
  })

  test("keeps the shared top-edge fade at twelve pixels beneath the dock", () => {
    const scrollbarRules = [...scrollbarStyles.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/g)]
    const gradientMaskRules = scrollbarRules.filter(
      (rule) =>
        rule.groups?.selectors.trim() === "[data-sidebar-scrollbar]" &&
        rule.groups.declarations.includes("linear-gradient"),
    )
    const maskDeclarations = gradientMaskRules[0]?.groups?.declarations ?? ""

    expect(gradientMaskRules).toHaveLength(1)
    expect(maskDeclarations.match(/#000 12px/g)).toHaveLength(2)
    expect(maskDeclarations.match(/#000 calc\(100% - 12px\)/g)).toHaveLength(2)
    expect(maskDeclarations).not.toMatch(/(?:filter|backdrop-filter|transform|translate|scale)\s*:/)
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action-dock\][^{]*\{[^}]*(?:mask(?:-image)?|-webkit-mask(?:-image)?|filter|backdrop-filter)\s*:/,
    )
  })

  test("keeps the shared top-edge fade at seventy-eight percent beneath the dock", () => {
    const topAlphaAssignments = [
      ...scrollbarStyles.matchAll(/--sidebar-scroll-edge-top-alpha:\s*(?<value>[^;]+);/g),
    ].map((match) => match.groups?.value.trim())

    expect(topAlphaAssignments).toEqual(["1", "0.78"])
    expect(scrollbarStyles).toContain(
      "[data-sidebar-scrollbar][data-sidebar-scroll-above] {\n  --sidebar-scroll-edge-top-alpha: 0.78;\n}",
    )
    expect(panelStyles).not.toContain("--sidebar-scroll-edge-top-alpha")
    expect(layoutSource).not.toContain("sidebar-scroll-edge-top-alpha")
  })

  test("matches the independent bottom-edge fade to the same seventy-eight percent strength", () => {
    const topAlphaAssignments = [
      ...scrollbarStyles.matchAll(/--sidebar-scroll-edge-top-alpha:\s*(?<value>[^;]+);/g),
    ].map((match) => match.groups?.value.trim())
    const bottomAlphaAssignments = [
      ...scrollbarStyles.matchAll(/--sidebar-scroll-edge-bottom-alpha:\s*(?<value>[^;]+);/g),
    ].map((match) => match.groups?.value.trim())

    expect(bottomAlphaAssignments).toEqual(["1", "0.78"])
    expect(bottomAlphaAssignments).toEqual(topAlphaAssignments)
    expect(scrollbarStyles).toContain(
      "[data-sidebar-scrollbar][data-sidebar-scroll-below] {\n  --sidebar-scroll-edge-bottom-alpha: 0.78;\n}",
    )
    expect(panelStyles).not.toContain("--sidebar-scroll-edge-bottom-alpha")
    expect(layoutSource).not.toContain("sidebar-scroll-edge-bottom-alpha")
  })

  test("uses one 160ms ease-out transition for both directional edge fades", () => {
    const scrollbarRules = [...scrollbarStyles.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/g)]
    const transitionRule = scrollbarRules.find(
      (rule) =>
        rule.groups?.selectors.trim() === "[data-sidebar-scrollbar]" &&
        rule.groups.declarations.includes("--sidebar-scroll-edge-top-alpha 160ms ease-out"),
    )
    const transitionDeclarations = transitionRule?.groups?.declarations ?? ""
    const directionalRules = scrollbarRules.filter((rule) =>
      /data-sidebar-scroll-(?:above|below)/.test(rule.groups?.selectors ?? ""),
    )
    const reducedMotion = scrollbarStyles.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? ""

    expect(transitionDeclarations.match(/--sidebar-scroll-edge-(?:top|bottom)-alpha 160ms ease-out/g)).toHaveLength(2)
    expect(transitionDeclarations).not.toMatch(
      /(?:transition-delay|animation|transform|translate|scale|filter|backdrop-filter)\s*:/,
    )
    expect(directionalRules).toHaveLength(2)
    expect(directionalRules.every((rule) => !rule.groups?.declarations.includes("transition"))).toBe(true)
    expect(reducedMotion).toContain("[data-sidebar-scrollbar]")
    expect(reducedMotion).toContain("transition: none")
  })

  test("keeps nested scroll edge state isolated with non-inheriting registered properties", () => {
    const registeredEdges = ["top", "bottom"].map((edge) => {
      const registration = scrollbarStyles.match(
        new RegExp(`@property --sidebar-scroll-edge-${edge}-alpha \\{([\\s\\S]*?)\\}`),
      )?.[1]

      return registration?.trim()
    })

    expect(registeredEdges).toHaveLength(2)
    expect(registeredEdges.every(Boolean)).toBe(true)
    for (const registration of registeredEdges) {
      expect(registration).toContain('syntax: "<number>"')
      expect(registration).toContain("inherits: false")
      expect(registration).toContain("initial-value: 1")
      expect(registration).not.toContain("inherits: true")
    }
  })

  test("keeps the primary action geometry stable while the project header collapses", () => {
    const dockStart = panelStyles.indexOf("[data-sidebar-primary-action-dock] {")
    const dockEnd = panelStyles.indexOf("}", dockStart)
    const dockStyles = panelStyles.slice(dockStart, dockEnd + 1)
    const actionStart = panelStyles.indexOf('[data-component="button"][data-sidebar-primary-action] {')
    const actionEnd = panelStyles.indexOf("}", actionStart)
    const actionStyles = panelStyles.slice(actionStart, actionEnd + 1)
    const collapsedDockSelector =
      /\[data-sidebar-project-header\]\[data-collapsed="true"\][^{]*(?:\+|~)[^{]*\[data-sidebar-primary-action-dock\]/
    const collapsedLabelSelector =
      /\[data-sidebar-project-header\]\[data-collapsed="true"\][^{]*\[data-sidebar-primary-action-label\]/

    expect(panelStyles).not.toMatch(collapsedDockSelector)
    expect(panelStyles).not.toMatch(collapsedLabelSelector)
    expect(dockStyles).toContain("flex: 0 0 auto")
    expect(dockStyles).toContain("padding-block: 8px")
    expect(dockStyles).not.toContain("transform")
    expect(dockStyles).not.toContain("margin")
    expect(actionStyles).toContain("height: 40px")
    expect(actionStyles).not.toContain("opacity")
    expect(actionStyles).not.toContain("display: none")
    expect(layoutSource.match(/data-sidebar-primary-action-label/g)).toHaveLength(2)
  })

  test("keeps the full-width hit target while insetting only the visible material by four pixels", () => {
    const actionSelector = '[data-component="button"][data-sidebar-primary-action] {'
    const actionStart = panelStyles.indexOf(actionSelector)
    const actionEnd = panelStyles.indexOf("}", actionStart)
    const actionStyles = panelStyles.slice(actionStart, actionEnd + 1)
    const materialSelector = '[data-component="button"][data-sidebar-primary-action]::before {'
    const materialStart = panelStyles.indexOf(materialSelector)
    const materialEnd = panelStyles.indexOf("}", materialStart)
    const materialStyles = panelStyles.slice(materialStart, materialEnd + 1)
    const touchStyles = panelStyles.slice(
      panelStyles.indexOf("@media (max-width: 767px), (pointer: coarse)"),
      panelStyles.indexOf("@media (forced-colors: active)"),
    )

    expect(actionStart).not.toBe(-1)
    expect(actionStyles).toContain("position: relative")
    expect(actionStyles).toContain("width: 100%")
    expect(actionStyles).toContain("height: 40px")
    expect(actionStyles).toContain("padding: 0 12px")
    expect(actionStyles).toContain("background-color: transparent")
    expect(actionStyles).not.toContain("margin")
    expect(actionStyles).not.toContain("transform")
    expect(materialStart).not.toBe(-1)
    expect(materialStyles).toContain("position: absolute")
    expect(materialStyles).toContain("inset: 0 4px")
    expect(materialStyles).toContain("background-color: transparent")
    expect(materialStyles).toContain('content: ""')
    expect(materialStyles).toContain("pointer-events: none")
    expect(materialStyles).toContain("transition: background-color 160ms ease-out")
    expect(materialStyles).not.toContain("transform")
    expect(materialStyles).not.toContain("margin")
    expect(touchStyles).toMatch(/\[data-component="button"\]\[data-sidebar-primary-action\] \{[\s\S]*height: 44px/)
    expect(panelStyles).toMatch(
      /\[data-component="button"\]\[data-variant="ghost"\]\[data-sidebar-primary-action\]:hover:not\(:disabled\),[\s\S]*:focus-visible:not\(:disabled\),[\s\S]*:active:not\(:disabled\)[\s\S]*background-color: transparent/,
    )
    expect(panelStyles).toContain(
      '[data-component="button"][data-sidebar-primary-action]:focus-visible:not(:disabled)::before {',
    )
    expect(panelStyles).toContain(
      '[data-component="button"][data-sidebar-primary-action]:active:not(:disabled)::before {',
    )
  })

  test("aligns both primary action icons to the project title's twelve-pixel grid", () => {
    const headerSelector = "[data-sidebar-project-header] {"
    const headerStart = panelStyles.indexOf(headerSelector)
    const headerEnd = panelStyles.indexOf("}", headerStart)
    const headerStyles = panelStyles.slice(headerStart, headerEnd + 1)
    const actionSelector = '[data-component="button"][data-sidebar-primary-action] {'
    const actionStart = panelStyles.indexOf(actionSelector)
    const actionEnd = panelStyles.indexOf("}", actionStart)
    const actionStyles = panelStyles.slice(actionStart, actionEnd + 1)
    const materialSelector = '[data-component="button"][data-sidebar-primary-action]::before {'
    const materialStart = panelStyles.indexOf(materialSelector)
    const materialEnd = panelStyles.indexOf("}", materialStart)
    const materialStyles = panelStyles.slice(materialStart, materialEnd + 1)

    expect(headerStart).not.toBe(-1)
    expect(headerStyles).toContain("padding: 0 4px 0 12px")
    expect(actionStart).not.toBe(-1)
    expect(actionStyles).toContain("padding: 0 12px")
    expect(actionStyles).toContain("gap: 8px")
    expect(materialStyles).toContain("inset: 0 4px")
    expect(layoutSource.match(/data-sidebar-primary-action(?:\s|$)/g)).toHaveLength(2)
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action\][^{]*(?:aria-busy|data-pending|data-collapsed)[^{]*\{[^}]*padding/,
    )
  })

  test("keeps an eight-pixel rhythm between each primary action icon and label in every state", () => {
    const primaryActionRules = [
      ...panelStyles.matchAll(
        /\[data-component="button"\]\[data-sidebar-primary-action\][^{]*\{(?<declarations>[^}]*)\}/g,
      ),
    ]
    const gapRules = primaryActionRules.filter((rule) => rule.groups?.declarations.includes("gap:"))
    const sessionActionStart = layoutSource.indexOf(
      "<Button",
      layoutSource.indexOf("<div data-sidebar-primary-action-dock>"),
    )
    const sessionActionEnd = layoutSource.indexOf("</Button>", sessionActionStart)
    const sessionAction = layoutSource.slice(sessionActionStart, sessionActionEnd)
    const workspaceActionStart = layoutSource.indexOf("<Button", layoutSource.indexOf("workspaceCreationAnnouncement("))
    const workspaceActionEnd = layoutSource.indexOf("</Button>", workspaceActionStart)
    const workspaceAction = layoutSource.slice(workspaceActionStart, workspaceActionEnd)

    expect(gapRules).toHaveLength(1)
    expect(gapRules[0]?.groups?.declarations).toContain("gap: 8px")
    expect(sessionAction.indexOf('<IconV2 name="edit" size="small" />')).toBeGreaterThan(-1)
    expect(sessionAction.indexOf("data-sidebar-primary-action-label")).toBeGreaterThan(
      sessionAction.indexOf('<IconV2 name="edit" size="small" />'),
    )
    expect(workspaceAction.indexOf("data-sidebar-primary-action-icon-slot")).toBeGreaterThan(-1)
    expect(workspaceAction.indexOf("data-sidebar-primary-action-label")).toBeGreaterThan(
      workspaceAction.indexOf("data-sidebar-primary-action-icon-slot"),
    )
  })

  test("mathematically centers each primary action icon lane and label without optical offsets", () => {
    const actionSelector = '[data-component="button"][data-sidebar-primary-action] {'
    const actionStart = panelStyles.indexOf(actionSelector)
    const actionEnd = panelStyles.indexOf("}", actionStart)
    const actionStyles = panelStyles.slice(actionStart, actionEnd + 1)
    const labelSelector = '[data-component="button"][data-sidebar-primary-action] [data-sidebar-primary-action-label]'
    const labelStart = panelStyles.indexOf(`${labelSelector} {`)
    const labelEnd = panelStyles.indexOf("}", labelStart)
    const labelStyles = panelStyles.slice(labelStart, labelEnd + 1)
    const iconSlotStart = panelStyles.indexOf("[data-sidebar-primary-action-icon-slot] {")
    const iconSlotEnd = panelStyles.indexOf("}", iconSlotStart)
    const iconSlotStyles = panelStyles.slice(iconSlotStart, iconSlotEnd + 1)
    const touchStyles = panelStyles.slice(
      panelStyles.indexOf("@media (max-width: 767px), (pointer: coarse)"),
      panelStyles.indexOf("@media (forced-colors: active)"),
    )
    const verticalOffsetProperty = /(?:transform|translate|margin(?:-block)?|top|bottom|align-self)\s*:/

    expect(actionStart).not.toBe(-1)
    expect(actionStyles).toContain("height: 40px")
    expect(actionStyles).toContain("align-items: center")
    expect(actionStyles).not.toMatch(verticalOffsetProperty)
    expect(labelStart).not.toBe(-1)
    expect(labelStyles).not.toMatch(verticalOffsetProperty)
    expect(iconSlotStart).not.toBe(-1)
    expect(iconSlotStyles).toContain("width: 18px")
    expect(iconSlotStyles).toContain("height: 18px")
    expect(iconSlotStyles).toContain("place-items: center")
    expect(iconSlotStyles).not.toMatch(verticalOffsetProperty)
    expect(touchStyles).toMatch(/\[data-component="button"\]\[data-sidebar-primary-action\] \{[\s\S]*height: 44px/)
    expect(panelStyles).not.toMatch(
      /\[data-sidebar-primary-action(?:-icon-slot|-icon|-spinner|-label)?\][^{]*(?:aria-busy|data-pending|data-collapsed)[^{]*\{[^}]*(?:transform|translate|margin(?:-block)?|top|bottom|align-self)\s*:/,
    )
  })

  test("keeps both creation actions from implicitly submitting future ancestor forms", () => {
    const primaryActionMarkers = [...layoutSource.matchAll(/\n\s+data-sidebar-primary-action(?:\s|$)/g)]

    expect(primaryActionMarkers).toHaveLength(2)
    for (const marker of primaryActionMarkers) {
      const actionStart = layoutSource.lastIndexOf("<Button", marker.index)
      const actionEndOffset = layoutSource.slice(actionStart).search(/\n\s*>/)
      const actionEnd = actionStart + actionEndOffset
      const openingTag = layoutSource.slice(actionStart, actionEnd)

      expect(actionEndOffset).toBeGreaterThan(-1)
      expect(openingTag).toContain('type="button"')
    }
  })

  test("keeps localized labels on one stable line without shrinking the icon slot", () => {
    expect(layoutSource.match(/data-sidebar-primary-action-label/g)).toHaveLength(2)
    expect(layoutSource).toContain('<span data-sidebar-primary-action-label>{language.t("command.session.new")}</span>')
    expect(layoutSource).toContain('<span data-sidebar-primary-action-label>{language.t("workspace.new")}</span>')

    const labelSelector = '[data-component="button"][data-sidebar-primary-action] [data-sidebar-primary-action-label]'
    const labelStyles = panelStyles.slice(
      panelStyles.indexOf(`${labelSelector} {`),
      panelStyles.indexOf("}", panelStyles.indexOf(`${labelSelector} {`)) + 1,
    )

    expect(labelStyles).toContain("flex: 1 1 auto")
    expect(labelStyles).toContain("min-width: 0")
    expect(labelStyles).toContain("overflow: hidden")
    expect(labelStyles).toContain("text-align: start")
    expect(labelStyles).toContain("text-overflow: ellipsis")
    expect(labelStyles).toContain("white-space: nowrap")
  })

  test("shows the full label tooltip only when the rendered text is actually truncated", () => {
    expect(sidebarPrimaryActionLabelIsTruncated(undefined)).toBe(false)
    expect(sidebarPrimaryActionLabelIsTruncated({ scrollWidth: 160, clientWidth: 160 })).toBe(false)
    expect(sidebarPrimaryActionLabelIsTruncated({ scrollWidth: 161, clientWidth: 160 })).toBe(true)

    expect(layoutSource.match(/<SidebarPrimaryActionTooltip/g)).toHaveLength(2)
    expect(layoutSource).toContain('<SidebarPrimaryActionTooltip value={language.t("command.session.new")}>')
    expect(layoutSource).toContain('<SidebarPrimaryActionTooltip value={language.t("workspace.new")}>')
    expect(tooltipSource).toContain("inactive={!overflow.truncated()}")
    expect(tooltipSource).toContain('placement="right"')
    expect(tooltipSource).not.toContain("title=")

    const wrapperStyles = panelStyles.slice(
      panelStyles.indexOf("[data-sidebar-primary-action-tooltip] {"),
      panelStyles.indexOf("}", panelStyles.indexOf("[data-sidebar-primary-action-tooltip] {")) + 1,
    )
    expect(wrapperStyles).toContain("width: 100%")
  })

  test("gives the arrowless sidebar tooltip an 8px gap without widening the shared default", () => {
    expect(tooltipSource).toContain("gutter={8}")
    expect(tooltipSource).not.toContain("gutter={4}")
    expect(tooltipSource).not.toContain("gutter={6}")
    expect(tooltipSource).not.toContain("gutter={10}")
    expect(sharedTooltipSource).toContain("gutter={4}")
    expect(sharedTooltipSource).not.toContain("gutter={8}")
  })

  test("prefers the right side, then flips and slides within the viewport inset", () => {
    expect(tooltipSource).toContain('placement="right"')
    expect(tooltipSource).toMatch(/\n\s+flip\s*\n/)
    expect(tooltipSource).toMatch(/\n\s+slide\s*\n/)
    expect(tooltipSource).toContain("overflowPadding={12}")
    expect(tooltipSource).not.toContain("flip={false}")
    expect(tooltipSource).not.toContain("slide={false}")
    expect(tooltipSource).not.toContain("overflowPadding={8}")
  })

  test("keeps long tooltip copy inside iOS-style viewport insets without line clamping", () => {
    expect(tooltipSource).toContain('"max-width": "min(320px, calc(100vw - 24px))"')
    expect(tooltipSource).toContain('"white-space": "normal"')
    expect(tooltipSource).toContain('"text-wrap": "pretty"')
    expect(tooltipSource).toContain('"overflow-wrap": "anywhere"')
    expect(tooltipSource).toContain('"text-align": "start"')
    expect(tooltipSource).not.toContain("calc(100vw - 16px)")
    expect(tooltipSource).not.toContain("hyphens")
    expect(tooltipSource).not.toContain('"text-wrap": "balance"')
    expect(tooltipSource).not.toContain('"text-align": "left"')
    expect(tooltipSource).not.toContain('"text-align": "center"')
    expect(tooltipSource).not.toContain('"text-align": "justify"')
    expect(tooltipSource).not.toContain("line-clamp")
    expect(tooltipSource).not.toContain("max-height")
  })

  test("inherits the shared 400ms open delay and immediate close timing", () => {
    expect(tooltipSource).not.toContain("openDelay=")
    expect(tooltipSource).not.toContain("closeDelay=")
    expect(sharedTooltipSource).toContain("export const TOOLTIP_V2_TIMING = {")
    expect(sharedTooltipSource).toContain("openDelay: 400")
    expect(sharedTooltipSource).toContain("closeDelay: 0")
    expect(sharedTooltipSource).toContain("openDelay={TOOLTIP_V2_TIMING.openDelay}")
    expect(sharedTooltipSource).toContain("closeDelay={TOOLTIP_V2_TIMING.closeDelay}")
  })

  test("opens immediately for keyboard focus while preserving the pointer-hover delay", () => {
    const focusStart = sharedTooltipSource.indexOf("const openTooltipOnFocus = () => {")
    const focusEnd = sharedTooltipSource.indexOf("\n  }", focusStart)
    const focusHandler = sharedTooltipSource.slice(focusStart, focusEnd)
    const triggerStart = sharedTooltipSource.indexOf("<KobalteTooltip.Trigger")
    const triggerEnd = sharedTooltipSource.indexOf("</KobalteTooltip.Trigger>", triggerStart)
    const trigger = sharedTooltipSource.slice(triggerStart, triggerEnd)

    expect(focusStart).not.toBe(-1)
    expect(focusEnd).not.toBe(-1)
    expect(focusHandler).toContain("if (state.block || state.expand) return")
    expect(focusHandler).toContain('setState("open", true)')
    expect(focusHandler).not.toContain("setTimeout")
    expect(focusHandler).not.toContain("requestAnimationFrame")
    expect(trigger).toContain("onFocusCapture={openTooltipOnFocus}")
    expect(sharedTooltipSource).toContain("openDelay: 400")
    expect(sharedTooltipSource).toContain("openDelay={TOOLTIP_V2_TIMING.openDelay}")
  })

  test("keeps a clicked tooltip hidden until pointer or focus genuinely exits", () => {
    const releaseStart = sharedTooltipSource.indexOf("const releaseTooltipSuppression =")
    const focusReleaseStart = sharedTooltipSource.indexOf("const releaseTooltipSuppressionAfterFocusExit =")
    const focusReleaseEnd = sharedTooltipSource.indexOf("\n  }", focusReleaseStart)
    const focusRelease = sharedTooltipSource.slice(focusReleaseStart, focusReleaseEnd)
    const leaveStart = sharedTooltipSource.indexOf("const leave = () => {")
    const leaveEnd = sharedTooltipSource.indexOf("\n  }", leaveStart)
    const leaveHandler = sharedTooltipSource.slice(leaveStart, leaveEnd)
    const triggerStart = sharedTooltipSource.indexOf("<KobalteTooltip.Trigger")
    const triggerEnd = sharedTooltipSource.indexOf("</KobalteTooltip.Trigger>", triggerStart)
    const trigger = sharedTooltipSource.slice(triggerStart, triggerEnd)

    expect(releaseStart).not.toBe(-1)
    expect(focusReleaseStart).not.toBe(-1)
    expect(focusRelease).toContain("if (inside()) return")
    expect(focusRelease).toContain("releaseTooltipSuppression()")
    expect(leaveHandler).toContain("releaseTooltipSuppression()")
    expect(leaveHandler).not.toContain("setTimeout")
    expect(trigger).toContain("onPointerLeave={leave}")
    expect(trigger).toContain("onFocusOut={() => requestAnimationFrame(releaseTooltipSuppressionAfterFocusExit)}")
    expect(sharedTooltipSource).not.toContain("setTimeout(() => releaseTooltipSuppression")
  })

  test("eases material changes without animating unrelated properties", () => {
    const materialSelector = '[data-component="button"][data-sidebar-primary-action]::before {'
    const materialStyles = panelStyles.slice(
      panelStyles.indexOf(materialSelector),
      panelStyles.indexOf("}", panelStyles.indexOf(materialSelector)) + 1,
    )

    expect(materialStyles).toContain("transition: background-color 160ms ease-out")
    expect(materialStyles).not.toContain("transition: all")
  })

  test("uses immediate touch activation without disabling panning or pinch zoom", () => {
    const primaryActionStyles = panelStyles.slice(
      panelStyles.indexOf('[data-component="button"][data-sidebar-primary-action] {'),
      panelStyles.indexOf('[data-component="button"][data-sidebar-primary-action] [data-slot="icon-svg"]'),
    )

    expect(primaryActionStyles).toContain("touch-action: manipulation")
    expect(primaryActionStyles).not.toContain("touch-action: none")
  })

  test("suppresses touch tooltips without delaying activation or hiding the full accessible name", () => {
    const triggerStart = sharedTooltipSource.indexOf("<KobalteTooltip.Trigger")
    const triggerEnd = sharedTooltipSource.indexOf("</KobalteTooltip.Trigger>", triggerStart)
    const trigger = sharedTooltipSource.slice(triggerStart, triggerEnd)

    expect(triggerStart).not.toBe(-1)
    expect(triggerEnd).not.toBe(-1)
    expect(trigger).toContain("onPointerDownCapture={suppressTooltipOnActivation}")
    expect(trigger).not.toContain("preventDefault")
    expect(trigger).not.toContain("onTouchStart")
    expect(trigger).not.toContain("onContextMenu")
    expect(layoutSource).not.toMatch(/data-sidebar-primary-action-label[^>]*aria-hidden/)
    expect(layoutSource).toContain('<span data-sidebar-primary-action-label>{language.t("command.session.new")}</span>')
    expect(layoutSource).toContain('<span data-sidebar-primary-action-label>{language.t("workspace.new")}</span>')
  })

  test("keeps keyboard focus visible with a geometry-stable inset ring", () => {
    const focusStyles = panelStyles.slice(
      panelStyles.indexOf('[data-component="button"][data-sidebar-primary-action]:focus-visible:not(:disabled) {'),
      panelStyles.indexOf('[data-component="button"][data-sidebar-primary-action]:active:not(:disabled) {'),
    )

    expect(focusStyles).toContain("outline: 2px solid var(--v2-border-border-focus)")
    expect(focusStyles).toContain("outline-offset: -2px")

    const forcedColorsStyles = panelStyles.slice(
      panelStyles.indexOf("@media (forced-colors: active)"),
      panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"),
    )
    expect(forcedColorsStyles).toMatch(
      /\[data-component="button"\]\[data-sidebar-primary-action\]:focus-visible:not\(:disabled\)[\s\S]*outline-color: Highlight/,
    )
    expect(forcedColorsStyles).toMatch(
      /\[data-component="button"\]\[data-sidebar-primary-action\]:focus-visible:active:not\(:disabled\)[\s\S]*outline-color: HighlightText/,
    )
  })

  test("keeps the focus ring while the busy action rejects activation", () => {
    const actionStart = layoutSource.indexOf("<Button", layoutSource.indexOf("workspaceCreationAnnouncement("))
    const actionEnd = layoutSource.indexOf("</Button>", actionStart)
    const action = layoutSource.slice(actionStart, actionEnd)

    expect(action).toContain("aria-disabled={creatingWorkspace()}")
    expect(action).not.toMatch(/\n\s+disabled=\{creatingWorkspace\(\)\}/)
    expect(action).toContain("if (creatingWorkspace()) return")

    const busyFocusSelector =
      '[data-component="button"][data-sidebar-primary-action]:focus-visible[aria-busy="true"][aria-disabled="true"]'
    const busyFocusStyles = panelStyles.slice(
      panelStyles.indexOf(`${busyFocusSelector} {`),
      panelStyles.indexOf("}", panelStyles.indexOf(`${busyFocusSelector} {`)) + 1,
    )
    expect(busyFocusStyles).toContain("outline: 2px solid var(--v2-border-border-focus)")
    expect(busyFocusStyles).toContain("outline-offset: -2px")

    const forcedColorsStyles = panelStyles.slice(
      panelStyles.indexOf("@media (forced-colors: active)"),
      panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"),
    )
    expect(forcedColorsStyles).toMatch(
      /\[data-component="button"\]\[data-sidebar-primary-action\]:focus-visible\[aria-busy="true"\]\[aria-disabled="true"\][\s\S]*outline-color: Highlight/,
    )
  })

  test("uses system colors for forced-color press feedback", () => {
    const forcedColorsStyles = panelStyles.slice(
      panelStyles.indexOf("@media (forced-colors: active)"),
      panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"),
    )
    const pressedSelector = '[data-component="button"][data-sidebar-primary-action]:active:not(:disabled)'
    const pressedStyles = forcedColorsStyles.slice(
      forcedColorsStyles.indexOf(`${pressedSelector} {`),
      forcedColorsStyles.indexOf("}", forcedColorsStyles.indexOf(`${pressedSelector} {`)) + 1,
    )
    const pressedMaterialSelector = `${pressedSelector}::before`
    const pressedMaterialStyles = forcedColorsStyles.slice(
      forcedColorsStyles.indexOf(`${pressedMaterialSelector} {`),
      forcedColorsStyles.indexOf("}", forcedColorsStyles.indexOf(`${pressedMaterialSelector} {`)) + 1,
    )

    expect(pressedStyles).toContain(pressedSelector)
    expect(pressedStyles).toContain("color: HighlightText")
    expect(pressedMaterialStyles).toContain(pressedMaterialSelector)
    expect(pressedMaterialStyles).toContain("background: Highlight")
    expect(forcedColorsStyles).toContain(`${pressedSelector} [data-slot="icon-svg"],`)
    expect(forcedColorsStyles).toMatch(
      /\[data-component="button"\]\[data-sidebar-primary-action\]:active:not\(:disabled\) > svg \{[\s\S]*?color: HighlightText/,
    )
  })

  test("crossfades the plus and spinner inside one fixed icon slot", () => {
    const actionStart = layoutSource.indexOf("<Button", layoutSource.indexOf("workspaceCreationAnnouncement("))
    const actionEnd = layoutSource.indexOf("</Button>", actionStart)
    const action = layoutSource.slice(actionStart, actionEnd)

    expect(action).not.toContain('icon={creatingWorkspace() ? undefined : "plus-small"}')
    expect(action).toContain("data-sidebar-primary-action-icon-slot")
    expect(action).toContain("data-pending={creatingWorkspace()}")
    expect(action).toContain("<span data-sidebar-primary-action-icon>")
    expect(action).toContain('<Icon name="plus-small" size="small" />')
    expect(action).toContain("<span data-sidebar-primary-action-spinner>")
    expect(action).not.toContain("<Show when={creatingWorkspace()}>")

    const crossfadeStyles = panelStyles.slice(
      panelStyles.indexOf("[data-sidebar-primary-action-icon-slot] {"),
      panelStyles.indexOf(
        '[data-component="button"][data-sidebar-primary-action][aria-busy="true"][aria-disabled="true"]',
      ),
    )
    expect(crossfadeStyles).toContain("display: grid")
    expect(crossfadeStyles).toContain("width: 18px")
    expect(crossfadeStyles).toContain("height: 18px")
    expect(crossfadeStyles).toContain("grid-area: 1 / 1")
    expect(crossfadeStyles).toContain("transition: opacity 140ms ease-out")
    expect(crossfadeStyles).not.toContain("transform:")
    expect(crossfadeStyles).toMatch(
      /\[data-sidebar-primary-action-icon-slot\]\[data-pending="true"\] \[data-sidebar-primary-action-icon\][\s\S]*opacity: 0/,
    )
    expect(crossfadeStyles).toMatch(
      /\[data-sidebar-primary-action-icon-slot\]\[data-pending="true"\] \[data-sidebar-primary-action-spinner\][\s\S]*opacity: 1/,
    )
    expect(crossfadeStyles).toMatch(
      /\[data-sidebar-primary-action-icon-slot\]:not\(\[data-pending="true"\]\)[\s\S]*rect[\s\S]*animation: none !important/,
    )

    const reducedMotionStyles = panelStyles.slice(panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(reducedMotionStyles).toMatch(
      /\[data-sidebar-primary-action-icon\],[\s\S]*\[data-sidebar-primary-action-spinner\][\s\S]*transition: none/,
    )
  })

  test("keeps workspace creation feedback in the existing icon slot", () => {
    expect(layoutSource).toContain("aria-busy={creatingWorkspace()}")
    expect(layoutSource).toContain("aria-disabled={creatingWorkspace()}")
    expect(layoutSource).not.toMatch(/\n\s+disabled=\{creatingWorkspace\(\)\}/)
    expect(layoutSource).toContain("data-sidebar-primary-action-spinner")

    const spinnerStyles = panelStyles.slice(
      panelStyles.indexOf("[data-sidebar-primary-action-spinner] {"),
      panelStyles.indexOf('[data-component="button"][data-sidebar-primary-action]:focus-visible'),
    )
    expect(spinnerStyles).toContain("width: 18px")
    expect(spinnerStyles).toContain("height: 18px")
    expect(spinnerStyles).toMatch(/\[data-component="spinner"\][\s\S]*width: 12px/)
    expect(spinnerStyles).toMatch(/\[data-component="spinner"\][\s\S]*height: 12px/)
    expect(spinnerStyles).toMatch(/\[data-component="spinner"\][\s\S]*color: var\(--icon-base\)/)

    const forcedColorsStyles = panelStyles.slice(
      panelStyles.indexOf("@media (forced-colors: active)"),
      panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"),
    )
    expect(forcedColorsStyles).toMatch(
      /\[data-sidebar-primary-action-spinner\] \[data-component="spinner"\][\s\S]*color: CanvasText/,
    )

    const reducedMotionStyles = panelStyles.slice(panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(reducedMotionStyles).toMatch(
      /\[data-sidebar-primary-action-spinner\] \[data-component="spinner"\] rect[\s\S]*animation: none !important/,
    )
  })

  test("announces workspace creation politely without changing the visual action", () => {
    const announcement = '{workspaceCreationAnnouncement(creatingWorkspace(), language.t("workspace.creating"))}'
    const announcementIndex = layoutSource.indexOf(announcement)
    const statusIndex = layoutSource.lastIndexOf(
      '<span class="sr-only" role="status" aria-live="polite" aria-atomic="true">',
      announcementIndex,
    )
    const buttonIndex = layoutSource.indexOf("<Button", announcementIndex)
    const actionEnd = layoutSource.indexOf('<div class="relative flex-1 min-h-0">', buttonIndex)
    const action = layoutSource.slice(statusIndex, actionEnd)

    expect(announcementIndex).toBeGreaterThan(-1)
    expect(statusIndex).toBeGreaterThan(-1)
    expect(statusIndex).toBeLessThan(buttonIndex)
    expect(action).toContain(announcement)
    expect(action).toContain('{language.t("workspace.new")}')
  })

  test("uses a neutral pointer only for the aria-disabled busy action", () => {
    const busySelector =
      '[data-component="button"][data-sidebar-primary-action][aria-busy="true"][aria-disabled="true"]'
    const busyStyles = panelStyles.slice(
      panelStyles.indexOf(`${busySelector} {`),
      panelStyles.indexOf("}", panelStyles.indexOf(`${busySelector} {`)) + 1,
    )

    expect(busyStyles).toContain(busySelector)
    expect(busyStyles).toContain("cursor: default")
    expect(busyStyles).not.toContain("cursor: not-allowed")
    expect(busyStyles).not.toContain("cursor: progress")
  })

  test("switches material immediately when reduced motion is requested", () => {
    const reducedMotionStyles = panelStyles.slice(panelStyles.indexOf("@media (prefers-reduced-motion: reduce)"))

    expect(reducedMotionStyles).toMatch(
      /\[data-component="button"\]\[data-sidebar-primary-action\]::before,[\s\S]*transition: none/,
    )
  })

  test("limits hover material to fine pointers while preserving focus and press feedback", () => {
    const finePointerStyles = panelStyles.slice(
      panelStyles.indexOf("@media (hover: hover) and (pointer: fine)"),
      panelStyles.indexOf("[data-sidebar-new-session-notice] button:active"),
    )
    const nonHoverMediaIndex = panelStyles.indexOf("@media (hover: none), (pointer: coarse)")

    expect(finePointerStyles).toContain(
      '[data-component="button"][data-sidebar-primary-action]:hover:not(:active):not(:disabled)::before',
    )
    expect(panelStyles).toMatch(
      /@media \(hover: none\), \(pointer: coarse\)[\s\S]*\[data-component="button"\]\[data-sidebar-primary-action\]:hover:not\(:focus-visible\):not\(:active\):not\(:disabled\)::before[\s\S]*background-color: transparent/,
    )
    expect(panelStyles).not.toContain(":is(:hover, :focus-visible)")
    expect(nonHoverMediaIndex).toBeGreaterThan(panelStyles.indexOf("[data-sidebar-new-session-notice] button:active"))
  })
})
