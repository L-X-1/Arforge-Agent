import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  PROJECT_PREVIEW_POINTER_CLOSE_DELAY_MS,
  PROJECT_PREVIEW_POINTER_OPEN_DELAY_MS,
} from "./sidebar-project-preview-timing"

const source = readFileSync(new URL("./sidebar-project.tsx", import.meta.url), "utf8")
const itemsSource = readFileSync(new URL("./sidebar-items.tsx", import.meta.url), "utf8")
const itemsCss = readFileSync(new URL("./sidebar-items.css", import.meta.url), "utf8")
const css = readFileSync(new URL("./sidebar-project.css", import.meta.url), "utf8")
const cssRules = [...css.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/g)]

const declarationsFor = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) return ""
  const end = css.indexOf("}", start)
  return css.slice(start, end + 1)
}

const itemDeclarationsFor = (selector: string) => {
  const start = itemsCss.indexOf(`${selector} {`)
  if (start === -1) return ""
  const end = itemsCss.indexOf("}", start)
  return itemsCss.slice(start, end + 1)
}

describe("project hover preview rhythm", () => {
  test("uses the approved pointer dwell and exit delays", () => {
    expect(PROJECT_PREVIEW_POINTER_OPEN_DELAY_MS).toBe(180)
    expect(PROJECT_PREVIEW_POINTER_CLOSE_DELAY_MS).toBe(120)
    expect(source).toContain("openDelay={PROJECT_PREVIEW_POINTER_OPEN_DELAY_MS}")
    expect(source).toContain("closeDelay={PROJECT_PREVIEW_POINTER_CLOSE_DELAY_MS}")
  })

  test("lets eligible keyboard focus bypass the pointer opening timer", () => {
    const focusHandler = source.slice(source.indexOf("onFocus={() => {"), source.indexOf("onClick={() => {"))

    expect(source).toContain("previewEligible: Accessor<boolean>")
    expect(source).toContain("previewEligible={() => overlay() || (preview() && !selected())}")
    expect(focusHandler).toContain("if (!props.previewEligible()) return")
    expect(focusHandler).toContain("props.onProjectFocus(props.project.worktree)")
    expect(focusHandler).not.toContain("if (!props.overlay()) return")
  })

  test("uses a project-scoped iOS motion curve with an immediate reduced-motion path", () => {
    const open = declarationsFor('[data-component="hover-card-content"].sidebar-project-preview-surface[data-expanded]')
    const close = declarationsFor('[data-component="hover-card-content"].sidebar-project-preview-surface[data-closed]')
    const motion = css.slice(
      css.indexOf('[data-component="hover-card-content"].sidebar-project-preview-surface[data-expanded]'),
      css.indexOf("@media (max-width: 767px)"),
    )
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))

    expect(source).toContain('class="sidebar-project-preview-surface"')
    expect(open).toContain("animation: sidebar-project-preview-open 160ms cubic-bezier(0.16, 1, 0.3, 1)")
    expect(close).toContain("animation: sidebar-project-preview-close 100ms cubic-bezier(0.4, 0, 1, 1)")
    expect(motion).toContain("@keyframes sidebar-project-preview-open")
    expect(motion).toContain("@keyframes sidebar-project-preview-close")
    expect(motion.match(/transform: scale\(0\.98\)/g)).toHaveLength(2)
    expect(motion).not.toContain("scale(0.96)")
    expect(reducedMotion).toContain('[data-component="hover-card-content"].sidebar-project-preview-surface')
    expect(reducedMotion).toContain("animation: none")
  })

  test("uses a twelve pixel project-only radius and semantic half-pixel hairline without spacing changes", () => {
    const surface = declarationsFor('[data-component="hover-card-content"].sidebar-project-preview-surface')

    expect(surface).toContain("border-radius: 12px")
    expect(surface).toContain("border: 0.5px solid var(--v2-border-border-muted)")
    expect(surface).not.toMatch(/(?:^|\n)\s*(?:margin|padding|transform)\s*:/)
    expect(surface).not.toMatch(/(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i)
  })

  test("preserves floating elevation and adds one semantic half-pixel top highlight", () => {
    const surface = declarationsFor('[data-component="hover-card-content"].sidebar-project-preview-surface')
    const elevation = surface.indexOf("var(--shadow-md)")
    const highlight = surface.indexOf("inset 0 0.5px 0 var(--v2-alpha-light-14)")

    expect(elevation).toBeGreaterThan(-1)
    expect(highlight).toBeGreaterThan(elevation)
    expect(surface.match(/inset 0 0\.5px 0/g)).toHaveLength(1)
    expect(surface).not.toMatch(/(?:^|\n)\s*(?:margin|padding|filter|backdrop-filter)\s*:/)
  })

  test("progressively enhances a near-solid surface and restores it for transparency or rendering fallbacks", () => {
    const selector = '[data-component="hover-card-content"].sidebar-project-preview-surface'
    const surface = declarationsFor(selector)
    const enhancementStart = css.indexOf("@supports (backdrop-filter: blur(1px))")
    const enhancement = css.slice(enhancementStart, css.indexOf(`${selector}[data-expanded]`, enhancementStart))
    const reducedTransparencyStart = css.indexOf("@media (prefers-reduced-transparency: reduce)")
    const reducedTransparency = css.slice(
      reducedTransparencyStart,
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
    )

    expect(surface).toContain(
      "background-color: color-mix(in srgb, var(--surface-raised-stronger-non-alpha) 96%, transparent)",
    )
    expect(enhancement).toContain(
      "background-color: color-mix(in srgb, var(--surface-raised-stronger-non-alpha) 88%, transparent)",
    )
    expect(enhancement).toContain("backdrop-filter: blur(18px) saturate(1.08)")
    expect(enhancement).toContain("-webkit-backdrop-filter: blur(18px) saturate(1.08)")
    expect(css).toContain(':root[data-transparency="reduced"]')
    expect(css).toContain(':root[data-rendering="software"]')
    expect(reducedTransparency).toContain(selector)
    expect(reducedTransparency).toContain("backdrop-filter: none")
    expect(reducedTransparency).toContain("-webkit-backdrop-filter: none")
    expect(reducedTransparency).toContain(
      "background-color: color-mix(in srgb, var(--surface-raised-stronger-non-alpha) 96%, transparent)",
    )
  })

  test("keeps right-start collision placement with eight pixel trigger and viewport gutters", () => {
    const start = source.lastIndexOf("<HoverCard")
    const hoverCard = source.slice(start, source.indexOf("trigger={tile()}", start) + "trigger={tile()}".length)

    expect(hoverCard).toContain('placement="right-start"')
    expect(hoverCard).toContain("gutter={8}")
    expect(hoverCard).toContain("overflowPadding={8}")
    expect(hoverCard).not.toMatch(/(?:sideOffset|alignOffset|margin|translate)/)
  })

  test("fits the available viewport and scrolls only the middle session region", () => {
    const start = source.lastIndexOf("<HoverCard")
    const hoverCard = source.slice(start, source.indexOf("trigger={tile()}", start) + "trigger={tile()}".length)
    const surface = declarationsFor('[data-component="hover-card-content"].sidebar-project-preview-surface')
    const panel = declarationsFor("[data-sidebar-project-preview]")
    const scrollRegion = declarationsFor("[data-sidebar-project-preview-scroll-region]")
    const footer = declarationsFor("[data-sidebar-project-preview-footer]")

    expect(hoverCard).toContain("fitViewport")
    expect(source).toContain("data-sidebar-project-preview-scroll-region")
    expect(surface).toContain("max-height: var(--kb-popper-content-available-height)")
    expect(panel).toContain("max-height: inherit")
    expect(panel).toContain("min-height: 0")
    expect(scrollRegion).toContain("flex: 1 1 auto")
    expect(scrollRegion).toContain("min-height: 0")
    expect(scrollRegion).toContain("overflow-y: auto")
    expect(scrollRegion).toContain("overscroll-behavior: contain")
    expect(scrollRegion).not.toContain("overflow-x: auto")
    expect(footer).toContain("flex: 0 0 auto")
  })

  test("keeps eight pixels of keyboard reveal space without changing visible padding", () => {
    const scrollRegion = declarationsFor("[data-sidebar-project-preview-scroll-region]")

    expect(scrollRegion).toContain("scroll-padding-block: 8px")
    expect(scrollRegion.match(/scroll-padding-block:/g)).toHaveLength(1)
    expect(scrollRegion).not.toMatch(/(?:^|\n)\s*padding-block(?:-start|-end)?\s*:/)
  })

  test("reveals independent twelve pixel directional edge cues only while more content exists", () => {
    const selector = "[data-sidebar-project-preview-scroll-region]"
    const scrollRegion = declarationsFor(selector)
    const above = declarationsFor(`${selector}[data-sidebar-scroll-above]`)
    const below = declarationsFor(`${selector}[data-sidebar-scroll-below]`)
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
    const forcedColors = css.slice(
      css.indexOf("@media (forced-colors: active)"),
      css.indexOf("@media (prefers-reduced-transparency: reduce)"),
    )

    expect(source).toContain('import { createSidebarScrollbarController } from "./sidebar-scrollbar"')
    expect(source).toContain("const previewScrollEdges = createSidebarScrollbarController()")
    expect(source).toContain("onCleanup(previewScrollEdges.dispose)")
    expect(source).toContain("ref={previewScrollEdges.observe}")
    expect(source).toContain("onScroll={(event) => previewScrollEdges.update(event.currentTarget)}")
    expect(scrollRegion).toContain("--sidebar-project-preview-edge-top-alpha: 1")
    expect(scrollRegion).toContain("--sidebar-project-preview-edge-bottom-alpha: 1")
    expect(scrollRegion).toContain("#000 12px")
    expect(scrollRegion).toContain("#000 calc(100% - 12px)")
    expect(scrollRegion).toContain("--sidebar-project-preview-edge-top-alpha 160ms ease-out")
    expect(scrollRegion).toContain("--sidebar-project-preview-edge-bottom-alpha 160ms ease-out")
    expect(above).toContain("--sidebar-project-preview-edge-top-alpha: 0.78")
    expect(below).toContain("--sidebar-project-preview-edge-bottom-alpha: 0.78")
    expect(css).toMatch(
      /@property --sidebar-project-preview-edge-top-alpha \{[\s\S]*?inherits: false;[\s\S]*?initial-value: 1;[\s\S]*?\}/,
    )
    expect(css).toMatch(
      /@property --sidebar-project-preview-edge-bottom-alpha \{[\s\S]*?inherits: false;[\s\S]*?initial-value: 1;[\s\S]*?\}/,
    )
    expect(reducedMotion).toContain(selector)
    expect(reducedMotion).toContain("transition: none")
    expect(forcedColors).toContain(selector)
    expect(forcedColors).toContain("-webkit-mask-image: none")
    expect(forcedColors).toContain("mask-image: none")
    expect(scrollRegion).not.toMatch(/(?:^|\n)\s*(?:translate|transform|filter|pointer-events|scroll-behavior)\s*:/)
  })

  test("reserves one trailing scrollbar gutter only for hover-capable fine pointers", () => {
    const selector = "[data-sidebar-project-preview-scroll-region]"
    const scrollRegion = declarationsFor(selector)
    const finePointerStart = css.indexOf("@media (hover: hover) and (pointer: fine)")
    const finePointer = css.slice(finePointerStart, css.indexOf("@media (max-width: 767px)", finePointerStart))

    expect(scrollRegion).toContain("scrollbar-gutter: auto")
    expect(finePointerStart).toBeGreaterThan(-1)
    expect(finePointer).toContain(selector)
    expect(finePointer).toContain("scrollbar-gutter: stable")
    expect(finePointer).not.toContain("both-edges")
    expect(finePointer).not.toMatch(/(?:margin|padding|transform|translate)\s*:/)
  })

  test("uses a six pixel semantic scrollbar with restrained interaction and forced-color states", () => {
    const selector = "[data-sidebar-project-preview-scroll-region]"
    const scrollRegion = declarationsFor(selector)
    const scrollbar = declarationsFor(`${selector}::-webkit-scrollbar`)
    const track = declarationsFor(`${selector}::-webkit-scrollbar-track,\n${selector}::-webkit-scrollbar-corner`)
    const thumb = declarationsFor(`${selector}::-webkit-scrollbar-thumb`)
    const interactive = declarationsFor(`${selector}:is(:hover, :focus-within)::-webkit-scrollbar-thumb`)
    const forcedColors = css.slice(
      css.indexOf("@media (forced-colors: active)"),
      css.indexOf("}", css.indexOf("@media (forced-colors: active)")) + 1,
    )

    expect(scrollRegion).toContain("scrollbar-width: thin")
    expect(scrollRegion).toContain(
      "scrollbar-color: color-mix(in srgb, var(--v2-icon-icon-muted) 36%, transparent) transparent",
    )
    expect(scrollbar).toContain("width: 6px")
    expect(track).toContain("background: transparent")
    expect(thumb).toContain("border-radius: 999px")
    expect(thumb).toContain("color-mix(in srgb, var(--v2-icon-icon-muted) 36%, transparent)")
    expect(interactive).toContain("color-mix(in srgb, var(--v2-icon-icon-muted) 52%, transparent)")
    expect(forcedColors).toContain(selector)
    expect(forcedColors).toContain("scrollbar-color: CanvasText transparent !important")
    expect(forcedColors).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|hsla?\(/i)
  })

  test("strengthens only the WebKit thumb while it is actively dragged", () => {
    const selector = "[data-sidebar-project-preview-scroll-region]"
    const activeThumbSelector = `${selector}::-webkit-scrollbar-thumb:active`
    const activeThumb = declarationsFor(activeThumbSelector)
    const forcedColorsStart = css.indexOf("@media (forced-colors: active)")
    const forcedColors = css.slice(forcedColorsStart, css.indexOf("@media (prefers-reduced-transparency: reduce)"))

    expect(activeThumb).toContain("background-color: color-mix(in srgb, var(--v2-icon-icon-muted) 68%, transparent)")
    expect(activeThumb).not.toMatch(/(?:width|height|min-height|border|margin|padding|transform|translate|opacity)\s*:/)
    expect(activeThumb).not.toContain("transition:")
    expect(css).not.toContain(`${selector}:active {`)
    expect(forcedColors).toContain(activeThumbSelector)
    expect(forcedColors).toContain("background-color: CanvasText !important")
  })

  test("centers a four pixel WebKit thumb inside the unchanged six pixel interaction lane", () => {
    const selector = "[data-sidebar-project-preview-scroll-region]"
    const scrollbar = declarationsFor(`${selector}::-webkit-scrollbar`)
    const thumb = declarationsFor(`${selector}::-webkit-scrollbar-thumb`)
    const forcedColorsStart = css.indexOf("@media (forced-colors: active)")
    const forcedColors = css.slice(forcedColorsStart, css.indexOf("@media (prefers-reduced-transparency: reduce)"))
    const gutterWidth = Number(scrollbar.match(/width:\s*(?<value>[\d.]+)px/)?.groups?.value)
    const visualInset = Number(thumb.match(/border-inline:\s*(?<value>[\d.]+)px/)?.groups?.value)

    expect(gutterWidth).toBe(6)
    expect(visualInset).toBe(1)
    expect(gutterWidth - visualInset * 2).toBe(4)
    expect(thumb).toContain("border-inline: 1px solid transparent")
    expect(thumb).toContain("background-clip: padding-box")
    expect(thumb).not.toMatch(/(?:margin|padding|transform|translate)\s*:/)
    expect(forcedColors).toContain("background-clip: border-box")
  })

  test("eases only the WebKit scrollbar thumb color and removes that motion when reduced", () => {
    const selector = "[data-sidebar-project-preview-scroll-region]"
    const scrollRegion = declarationsFor(selector)
    const thumb = declarationsFor(`${selector}::-webkit-scrollbar-thumb`)
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
    const reducedThumbStart = reducedMotion.indexOf(`${selector}::-webkit-scrollbar-thumb {`)
    const reducedThumb = reducedMotion.slice(reducedThumbStart, reducedMotion.indexOf("}", reducedThumbStart) + 1)

    expect(thumb).toContain("transition: background-color 160ms ease-out")
    expect(thumb).not.toMatch(/transition:[^;]*(?:opacity|width|height|border|transform|filter)/)
    expect(scrollRegion.match(/--sidebar-project-preview-edge-(?:top|bottom)-alpha 160ms ease-out/g)).toHaveLength(2)
    expect(scrollRegion).not.toMatch(/transition:[^;]*(?:opacity|width|height|border|transform|filter)/)
    expect(reducedThumb).toContain("transition: none")
  })

  test("keeps a 288 pixel ideal width and yields to the available viewport without horizontal scroll", () => {
    const panelStart = source.indexOf("<div data-sidebar-project-preview")
    const panelSource = source.slice(panelStart, source.indexOf(">", panelStart) + 1)
    const surface = declarationsFor('[data-component="hover-card-content"].sidebar-project-preview-surface')
    const body = declarationsFor(
      '[data-component="hover-card-content"].sidebar-project-preview-surface > [data-slot="hover-card-body"]',
    )
    const panel = declarationsFor("[data-sidebar-project-preview]")
    const scrollRegion = declarationsFor("[data-sidebar-project-preview-scroll-region]")

    expect(panelSource).not.toContain("w-72")
    expect(surface).toContain("min-width: 0")
    expect(surface).toContain("max-width: var(--kb-popper-content-available-width, 18rem)")
    expect(body).toContain("min-width: 0")
    expect(panel).toContain("width: min(18rem, var(--kb-popper-content-available-width, 18rem))")
    expect(panel).toContain("max-width: 100%")
    expect(panel).toContain("min-width: 0")
    expect(scrollRegion).toContain("overflow-x: hidden")
    expect(source).toContain("class={`min-w-0 grow truncate ${props.class}`}")
    expect(source).toContain('class="text-14-medium text-text-strong"')
  })

  test("uses one fixed forty-four pixel project title region", () => {
    const title = declarationsFor("[data-sidebar-project-preview-title]")

    expect(source).toContain("data-sidebar-project-preview")
    expect(source).toContain("data-sidebar-project-preview-title")
    expect(title).toContain("height: 44px")
    expect(title).toContain("flex: 0 0 44px")
    expect(title).not.toMatch(/(?:margin|padding)-(?:top|bottom)/)
  })

  test("reveals the full project title only when the rendered title is truncated", () => {
    const labelComponent = source.slice(
      source.indexOf("const ProjectPreviewTruncatedLabel"),
      source.indexOf("const ProjectPreviewPanel"),
    )
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )

    expect(labelComponent).toContain('kind: "title" | "workspace" | "section" | "empty"')
    expect(labelComponent).toContain("data-sidebar-project-preview-truncated-label")
    expect(labelComponent).toContain(
      'data-sidebar-project-preview-title-label={props.kind === "title" ? "" : undefined}',
    )
    expect(panel).toContain("<ProjectPreviewTruncatedLabel")
    expect(panel).toContain('kind="title"')
    expect(panel).toContain("value={displayName(props.project)}")
    expect(panel).toContain('class="text-14-medium text-text-strong"')
    expect(panel).not.toContain('class="text-14-medium text-text-strong truncate grow"')
    expect(declarationsFor("[data-sidebar-project-preview-title]")).toContain("height: 44px")
  })

  test("keeps eight pixels between the title and recent sessions label", () => {
    const label = declarationsFor("[data-sidebar-project-preview-section-label]")

    expect(source).toContain("data-sidebar-project-preview-section-label")
    expect(label).toContain("margin-top: 8px")
    expect(label).toContain("padding-bottom: 8px")
  })

  test("reveals the localized recent sessions label only when its single line is truncated", () => {
    const labelComponent = source.slice(
      source.indexOf("const ProjectPreviewTruncatedLabel"),
      source.indexOf("const ProjectPreviewViewAllButton"),
    )
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const section = panel.slice(
      panel.indexOf("data-sidebar-project-preview-section-label"),
      panel.indexOf('<div class="px-2 pb-2">'),
    )

    expect(labelComponent).toContain('kind: "title" | "workspace" | "section" | "empty"')
    expect(labelComponent).toContain(
      'data-sidebar-project-preview-section-label-text={props.kind === "section" ? "" : undefined}',
    )
    expect(section).toContain('class="px-4 flex min-w-0"')
    expect(section).toContain("<ProjectPreviewTruncatedLabel")
    expect(section).toContain('kind="section"')
    expect(section).toContain('value={props.language.t("sidebar.project.recentSessions")}')
    expect(section).toContain('class="text-12-medium text-text-weak"')
    expect(section).not.toContain("<Icon")
    expect(declarationsFor("[data-sidebar-project-preview-section-label]")).not.toMatch(/border|background|box-shadow/)
  })

  test("uses twelve pixels of whitespace between workspace groups without dividers", () => {
    const list = declarationsFor("[data-sidebar-project-preview-workspace-list]")

    expect(source).toContain("data-sidebar-project-preview-workspace-list")
    expect(source).toContain("data-sidebar-project-preview-workspace-group")
    expect(list).toContain("display: flex")
    expect(list).toContain("flex-direction: column")
    expect(list).toContain("gap: 12px")
    expect(list).not.toMatch(/border|background|box-shadow/)
    expect(css).not.toContain("[data-sidebar-project-preview-workspace-group]::")
  })

  test("keeps a quiet decorative branch glyph in a fixed workspace slot", () => {
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const slot = declarationsFor("[data-sidebar-project-preview-workspace-icon]")
    const icon = declarationsFor('[data-sidebar-project-preview-workspace-icon] [data-component="icon"]')

    expect(panel).toContain('data-sidebar-project-preview-workspace-icon aria-hidden="true"')
    expect(panel).toContain('<Icon name="branch" size="small" />')
    expect(panel).not.toContain('<Icon name="branch" size="small" class="text-icon-base" />')
    expect(slot).toContain("flex: 0 0 24px")
    expect(slot).toContain("width: 24px")
    expect(slot).toContain("height: 24px")
    expect(slot).toContain("color: var(--v2-icon-icon-muted)")
    expect(slot).not.toMatch(
      /(?:border|background|box-shadow|border-radius|transition|animation|transform|opacity)\s*:/,
    )
    expect(icon).toContain("width: 14px")
    expect(icon).toContain("height: 14px")
    expect(icon).toContain("color: var(--v2-icon-icon-muted)")
    expect(icon).not.toMatch(/(?:transition|animation|transform|opacity)\s*:/)
  })

  test("locks each workspace header to the dense row rhythm without a surface", () => {
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const header = declarationsFor("[data-sidebar-project-preview-workspace-header]")

    expect(panel).toContain("data-sidebar-project-preview-workspace-header")
    expect(header).toContain("display: flex")
    expect(header).toContain("align-items: center")
    expect(header).toContain("min-width: 0")
    expect(header).toContain("height: 28px")
    expect(header).toContain("padding-inline: 8px")
    expect(header).toContain("gap: 4px")
    expect(header).toContain("border: 0")
    expect(header).toContain("background: transparent")
    expect(header).toContain("box-shadow: none")
    expect(header).not.toMatch(/(?:margin|transform|transition|animation|opacity)\s*:/)
  })

  test("keeps workspace names at the calm fourteen pixel medium label hierarchy", () => {
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const label = declarationsFor("[data-sidebar-project-preview-workspace-label]")

    expect(panel).toContain('kind="workspace"')
    expect(panel).toContain('class="text-14-medium text-text-base"')
    expect(label).toContain("font-size: var(--font-size-base)")
    expect(label).toContain("font-weight: var(--font-weight-medium)")
    expect(label).toContain("line-height: var(--line-height-large)")
    expect(label).toContain("letter-spacing: var(--letter-spacing-normal)")
    expect(label).toContain("color: var(--v2-text-text-base)")
    expect(label).toContain("white-space: nowrap")
    expect(label).toContain("text-transform: none")
    expect(label).not.toMatch(/(?:^|\s)(?:transition|animation|transform|opacity|text-shadow)\s*:/)
  })

  test("keeps four pixels between a workspace heading and its first session", () => {
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const group = declarationsFor("[data-sidebar-project-preview-workspace-group]")

    expect(panel).toContain("<div data-sidebar-project-preview-workspace-group>")
    expect(group).toContain("display: flex")
    expect(group).toContain("flex-direction: column")
    expect(group).toContain("gap: 4px")
    expect(group).not.toMatch(/(?:padding|margin|border|background|box-shadow)\s*:/)
    expect(group).not.toMatch(/(?:transition|animation|transform|opacity)\s*:/)
  })

  test("aligns workspace session titles with the workspace name while preserving the status lane", () => {
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const workspacePath = panel.slice(panel.indexOf("<For each={previewWorkspaces()}>"))
    const directPath = panel.slice(
      panel.indexOf('data-sidebar-project-preview-session-list class="flex flex-col gap-2"'),
      panel.indexOf("<For each={previewWorkspaces()}>"),
    )
    const item = itemsSource.slice(
      itemsSource.indexOf("const SessionRow"),
      itemsSource.indexOf("export const SessionItem"),
    )

    expect(workspacePath).toContain("baseIndent={12}")
    expect(directPath).not.toContain("baseIndent=")
    expect(itemsSource).toContain('"padding-left": `${(props.baseIndent ?? 8) + (props.level ?? 0) * 16}px`')
    expect(item).toContain("data-sidebar-session-status-lane")
    expect(item).toContain('class="flex items-center gap-2 min-w-0 w-full text-left focus:outline-none"')
    expect(item).toContain("data-sidebar-session-title")
  })

  test("keeps the preview session status lane empty and undecorated until a semantic state is present", () => {
    const item = itemsSource.slice(
      itemsSource.indexOf("const SessionRow"),
      itemsSource.indexOf("export const SessionItem"),
    )
    const lane = itemDeclarationsFor("[data-sidebar-session-status-lane]")
    const indicator = itemDeclarationsFor("[data-sidebar-session-status]")

    expect(item).toContain('data-state={props.status() ?? "idle"}')
    expect(item).toContain('aria-hidden="true"')
    expect(item).toContain("<Switch>")
    expect(item).toContain(
      '<Show when={props.statusLabel()}>{(label) => <span class="sr-only">, {label()}</span>}</Show>',
    )
    expect(lane).toContain("width: 16px")
    expect(lane).toContain("height: 16px")
    expect(lane).toContain("flex: 0 0 16px")
    expect(lane).toContain("align-items: center")
    expect(lane).toContain("justify-content: center")
    expect(lane).toContain("border: 0")
    expect(lane).toContain("background: transparent")
    expect(lane).toContain("box-shadow: none")
    expect(lane).not.toMatch(/(?:transition|animation|transform|opacity)\s*:/)
    expect(indicator).toContain("align-items: center")
    expect(indicator).toContain("justify-content: center")
  })

  test("uses one fixed visual scale for preview session status priority", () => {
    const lane = itemDeclarationsFor("[data-sidebar-session-status-lane]")
    const working = itemDeclarationsFor('[data-sidebar-session-status="working"]')
    const permission = itemDeclarationsFor('[data-sidebar-session-status="permission"]')
    const error = itemDeclarationsFor('[data-sidebar-session-status="error"]')
    const unread = itemDeclarationsFor('[data-sidebar-session-status="unread"]')

    expect(lane).toContain("--sidebar-session-status-working-size: 12px")
    expect(lane).toContain("--sidebar-session-status-permission-size: 10px")
    expect(lane).toContain("--sidebar-session-status-error-size: 10px")
    expect(lane).toContain("--sidebar-session-status-unread-size: 6px")
    expect(working).toContain("width: var(--sidebar-session-status-working-size)")
    expect(working).toContain("height: var(--sidebar-session-status-working-size)")
    expect(permission).toContain("width: var(--sidebar-session-status-permission-size)")
    expect(permission).toContain("height: var(--sidebar-session-status-permission-size)")
    expect(error).toContain("width: var(--sidebar-session-status-error-size)")
    expect(error).toContain("height: var(--sidebar-session-status-error-size)")
    expect(unread).toContain("width: var(--sidebar-session-status-unread-size)")
    expect(unread).toContain("height: var(--sidebar-session-status-unread-size)")
  })

  test("distinguishes every preview session state by semantic shape, color, and accessible text", () => {
    const item = itemsSource.slice(
      itemsSource.indexOf("const SessionRow"),
      itemsSource.indexOf("export const SessionItem"),
    )
    const lane = itemDeclarationsFor("[data-sidebar-session-status-lane]")
    const permission = itemDeclarationsFor('[data-sidebar-session-status="permission"]')
    const error = itemDeclarationsFor('[data-sidebar-session-status="error"]')
    const unread = itemDeclarationsFor('[data-sidebar-session-status="unread"]')

    expect(lane).toContain("--sidebar-session-status-working-color: var(--icon-interactive-base)")
    expect(lane).toContain("--sidebar-session-status-permission-color: var(--surface-warning-strong)")
    expect(lane).toContain("--sidebar-session-status-error-color: var(--icon-critical-base)")
    expect(lane).toContain("--sidebar-session-status-unread-color: var(--text-interactive-base)")
    expect(item).toContain('props.tint() ?? "var(--sidebar-session-status-working-color)"')
    expect(item).toContain('<Spinner class="size-3" />')
    expect(permission).toContain("background: var(--sidebar-session-status-permission-color)")
    expect(permission).toContain("border-radius: 2px")
    expect(permission).toContain("transform: rotate(45deg)")
    expect(error).toContain("background: var(--sidebar-session-status-error-color)")
    expect(error).toContain("border-radius: 999px")
    expect(itemsCss).toContain('[data-sidebar-session-status="error"]::before')
    expect(itemsCss).toContain('[data-sidebar-session-status="error"]::after')
    expect(unread).toContain("background: var(--sidebar-session-status-unread-color)")
    expect(unread).toContain("border-radius: 999px")
    expect(item).toContain(
      '<Show when={props.statusLabel()}>{(label) => <span class="sr-only">, {label()}</span>}</Show>',
    )
    expect(itemsCss).toContain("@media (forced-colors: active)")
  })

  test("animates only running work and preserves its status when reduced motion is requested", () => {
    const item = itemsSource.slice(
      itemsSource.indexOf("const SessionRow"),
      itemsSource.indexOf("export const SessionItem"),
    )
    const permission = itemDeclarationsFor('[data-sidebar-session-status="permission"]')
    const error = itemDeclarationsFor('[data-sidebar-session-status="error"]')
    const unread = itemDeclarationsFor('[data-sidebar-session-status="unread"]')
    const reducedMotion = itemsCss.slice(itemsCss.indexOf("@media (prefers-reduced-motion: reduce)"))

    expect(item).toContain('<Match when={props.status() === "working"}>')
    expect(item).toContain('<Spinner class="size-3" />')
    expect(permission).not.toMatch(/(?:animation|transition)\s*:/)
    expect(error).not.toMatch(/(?:animation|transition)\s*:/)
    expect(unread).not.toMatch(/(?:animation|transition)\s*:/)
    expect(reducedMotion).toContain('[data-sidebar-session-status="working"] [data-component="spinner"] rect')
    expect(reducedMotion).toContain("animation: none !important")
    expect(reducedMotion).not.toContain('[data-sidebar-session-status="working"] {\n    display: none')
  })

  test("replaces session status immediately inside the fixed lane without crossfading or shifting the row", () => {
    const item = itemsSource.slice(
      itemsSource.indexOf("const SessionRow"),
      itemsSource.indexOf("export const SessionItem"),
    )
    const lane = itemDeclarationsFor("[data-sidebar-session-status-lane]")
    const indicator = itemDeclarationsFor("[data-sidebar-session-status]")

    expect(item).toContain('data-status-replacement="immediate"')
    expect(item).toContain("<Switch>")
    expect(item.match(/data-sidebar-session-status=/g)).toHaveLength(4)
    expect(item).toContain(
      '<Show when={props.statusLabel()}>{(label) => <span class="sr-only">, {label()}</span>}</Show>',
    )
    expect(lane).toContain("width: 16px")
    expect(lane).toContain("height: 16px")
    expect(lane).not.toMatch(/(?:transition|animation|opacity|scale|translate)\s*:/)
    expect(indicator).toContain("transition: none")
    expect(indicator).toContain("animation: none")
    expect(indicator).toContain("opacity: 1")
    expect(indicator).not.toMatch(/(?:scale|translate)\s*:/)
  })

  test("keeps session status icons informational and leaves pointer interaction to the row", () => {
    const item = itemsSource.slice(
      itemsSource.indexOf("const SessionRow"),
      itemsSource.indexOf("export const SessionItem"),
    )
    const laneMarkup = item.slice(item.indexOf("<div\n        aria-hidden"), item.indexOf(">\n        <Switch>") + 1)
    const lane = itemDeclarationsFor("[data-sidebar-session-status-lane]")

    expect(laneMarkup).toContain('aria-hidden="true"')
    expect(laneMarkup).not.toMatch(/(?:tabindex|role=|title=|onClick|onPointer|onMouse|Tooltip)/)
    expect(lane).toContain("pointer-events: none")
    expect(lane).toContain("user-select: none")
    expect(itemsCss).not.toContain("[data-sidebar-session-status]:hover")
    expect(itemsCss).not.toContain("[data-sidebar-session-status]:focus")
    expect(itemsCss).not.toContain("[data-sidebar-session-status]:active")
    expect(item).toContain(
      '<Show when={props.statusLabel()}>{(label) => <span class="sr-only">, {label()}</span>}</Show>',
    )
  })

  test("keeps session status colors inside the icon lane and sources row materials only from neutral tokens", () => {
    const lane = itemDeclarationsFor("[data-sidebar-session-status-lane]")
    const surface = itemDeclarationsFor("[data-sidebar-session-surface]")
    const forcedColorsStart = itemsCss.indexOf("@media (forced-colors: active)")
    const normalCss = itemsCss.slice(0, forcedColorsStart)
    const surfaceRules = [
      ...normalCss.matchAll(/(?<selectors>[^{}]*\[data-sidebar-session-surface\][^{}]*)\{(?<declarations>[^{}]*)\}/g),
    ]
    const surfacePalette = surfaceRules.map((rule) => rule.groups?.declarations ?? "").join("\n")

    expect(lane).toContain("--sidebar-session-status-working-color")
    expect(surface).toContain("--sidebar-session-surface-material: var(--v2-background-bg-layer-02)")
    expect(surface).toContain("--sidebar-session-surface-hairline: var(--v2-border-border-muted)")
    expect(surface).toContain("--sidebar-session-surface-highlight: var(--v2-alpha-light-14)")
    expect(surfacePalette).toContain("var(--sidebar-session-surface-material)")
    expect(surfacePalette).toContain("var(--sidebar-session-surface-hairline)")
    expect(surfacePalette).toContain("var(--sidebar-session-surface-highlight)")
    expect(surfacePalette).not.toMatch(/sidebar-session-status|surface-warning|critical|interactive/)
  })

  test("keeps active session titles strong and neutral across every semantic status", () => {
    const surface = itemDeclarationsFor("[data-sidebar-session-surface]")
    const title = itemDeclarationsFor("[data-sidebar-session-title]")
    const activeTitle = itemDeclarationsFor("[data-sidebar-session-item]:has(.active) [data-sidebar-session-title]")
    const forcedColorsStart = itemsCss.indexOf("@media (forced-colors: active)")
    const normalCss = itemsCss.slice(0, forcedColorsStart)

    expect(surface).toContain("--sidebar-session-title-rest-color: var(--text-base)")
    expect(surface).toContain("--sidebar-session-title-active-color: var(--text-strong)")
    expect(title).toContain("color: var(--sidebar-session-title-rest-color)")
    expect(activeTitle).toContain("color: var(--sidebar-session-title-active-color)")
    expect(normalCss).not.toMatch(/\[data-sidebar-session-status[^{}]*\][^{}]*\[data-sidebar-session-title\]/)
    expect(`${title}\n${activeTitle}`).not.toMatch(/warning|critical|interactive|agent/)
  })

  test("omits empty workspace groups only from the project preview", () => {
    const component = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const workspaceMemo = component.slice(
      component.indexOf("const previewWorkspaces = createMemo"),
      component.indexOf("const hasRecentSessions = createMemo"),
    )

    expect(workspaceMemo).toContain("if (!props.workspaceEnabled()) return []")
    expect(workspaceMemo).toContain(".workspaces()")
    expect(workspaceMemo).toContain("props.workspaceSessions(directory)")
    expect(workspaceMemo).toContain(".filter((workspace) => workspace.sessions.length > 0)")
    expect(component).toContain("<For each={previewWorkspaces()}>")
    expect(component).toContain("workspace.sessions.slice(0, 2)")
    expect(component).toContain("list={workspace.sessions}")
    expect(component).toContain("slug={base64Encode(workspace.directory)}")
    expect(component).toContain("{props.label(workspace.directory)}")
    expect(component).not.toContain("<For each={props.workspaces()}>")
  })

  test("reveals full workspace labels only when the rendered text is truncated", () => {
    const labelComponent = source.slice(
      source.indexOf("const ProjectPreviewTruncatedLabel"),
      source.indexOf("const ProjectPreviewPanel"),
    )
    const focus = declarationsFor("[data-sidebar-project-preview-truncated-label]:focus-visible")

    expect(source).toContain('import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"')
    expect(source).toContain("sidebarPrimaryActionLabelIsTruncated(label)")
    expect(labelComponent).toContain("ref={setLabel}")
    expect(labelComponent).toContain("observer?.unobserve(label)")
    expect(labelComponent).toContain("observer?.observe(element)")
    expect(labelComponent).toContain("inactive={!state.truncated}")
    expect(labelComponent).toContain("tabIndex={state.truncated ? 0 : undefined}")
    expect(labelComponent).toContain(
      'data-sidebar-project-preview-workspace-label={props.kind === "workspace" ? "" : undefined}',
    )
    expect(labelComponent).toContain('placement="top-start"')
    expect(labelComponent).toMatch(/\n\s+flip\s*\n/)
    expect(labelComponent).toMatch(/\n\s+slide\s*\n/)
    expect(labelComponent).toContain("overflowPadding={8}")
    expect(labelComponent).not.toContain("title=")
    expect(source).toContain('<ProjectPreviewTruncatedLabel\n                          kind="workspace"')
    expect(source).toContain("value={props.label(workspace.directory)}")
    expect(source).toContain('class="text-14-medium text-text-base"')
    expect(focus).toContain("outline: 2px solid var(--v2-border-border-focus)")
    expect(focus).toContain("outline-offset: -2px")
    expect(focus).not.toMatch(/(?:margin|padding)\s*:/)
  })

  test("preserves the compact eight pixel rhythm and dense rows for direct project sessions", () => {
    expect(source).toContain('data-sidebar-project-preview-session-list class="flex flex-col gap-2"')
    expect(source.match(/\bdense\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test("shows preview session title tooltips only for rendered overflow", () => {
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const item = itemsSource.slice(
      itemsSource.indexOf("export const SessionItem"),
      itemsSource.indexOf("export const NewSessionItem"),
    )

    expect(panel.match(/tooltipOverflowOnly/g)?.length).toBe(2)
    expect(itemsSource).toContain("tooltipOverflowOnly?: boolean")
    expect(itemsSource).toContain('import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"')
    expect(itemsSource).toContain("sidebarPrimaryActionLabelIsTruncated(titleLabel)")
    expect(itemsSource).toContain("new ResizeObserver(measureTitleOverflow)")
    expect(itemsSource).toContain('window.addEventListener("resize", measureTitleOverflow)')
    expect(itemsSource).toContain("ref={(element) => props.titleRef?.(element)}")
    expect(item).toContain("inactive={props.tooltipOverflowOnly && !swipe.titleTruncated}")
    expect(item).toContain('placement={props.mobile ? "bottom" : "right"}')
    expect(item).toContain("flip")
    expect(item).toContain("slide")
    expect(item).toContain("overflowPadding={8}")
    expect(item).not.toContain("tabIndex=")
  })

  test("shows one quiet localized inline status when the preview has no sessions", () => {
    const component = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )
    const labelComponent = source.slice(
      source.indexOf("const ProjectPreviewTruncatedLabel"),
      source.indexOf("const ProjectPreviewViewAllButton"),
    )
    const emptyStart = component.indexOf("data-sidebar-project-preview-empty")
    const empty = component.slice(emptyStart, component.indexOf("</div>", emptyStart) + "</div>".length)
    const emptyStyle = declarationsFor("[data-sidebar-project-preview-empty]")

    expect(component).toContain("const hasRecentSessions = createMemo")
    expect(component).toContain("props.projectSessions().length > 0")
    expect(component).toContain("previewWorkspaces().length > 0")
    expect(component).toContain("when={hasRecentSessions()}")
    expect(emptyStart).toBeGreaterThan(-1)
    expect(empty).toContain('role="status"')
    expect(empty).toContain('aria-live="polite"')
    expect(empty).toContain('aria-atomic="true"')
    expect(empty).toContain("<ProjectPreviewTruncatedLabel")
    expect(empty).toContain('kind="empty"')
    expect(empty).toContain('value={props.language.t("sidebar.session.empty")}')
    expect(labelComponent).toContain(
      'data-sidebar-project-preview-empty-label={props.kind === "empty" ? "" : undefined}',
    )
    expect(labelComponent).toContain("inactive={!state.truncated}")
    expect(labelComponent).toContain("tabIndex={state.truncated ? 0 : undefined}")
    expect(labelComponent).toContain("truncate")
    expect(empty).not.toMatch(/<(?:Button|Icon)|(?:card|illustration|onClick|tabIndex)=/)
    expect(emptyStyle).toContain("height: 28px")
    expect(emptyStyle).toContain("display: flex")
    expect(emptyStyle).toContain("align-items: center")
    expect(emptyStyle).toContain("padding-inline: 8px")
    expect(emptyStyle).toContain("font-size: 12px")
    expect(emptyStyle).toContain("font-weight: var(--font-weight-regular)")
    expect(emptyStyle).toContain("line-height: 18px")
    expect(emptyStyle).toContain("color: var(--v2-text-text-muted)")
    expect(emptyStyle).not.toMatch(/(?:border|background|box-shadow|outline|cursor)\s*:/)
    expect(source.indexOf("data-sidebar-project-preview-empty")).toBeLessThan(
      source.indexOf("data-sidebar-project-preview-footer"),
    )
  })

  test("replaces the footer divider with eight pixels of whitespace", () => {
    const footer = declarationsFor("[data-sidebar-project-preview-footer]")
    const footerSource = source.slice(
      source.indexOf("data-sidebar-project-preview-footer"),
      source.indexOf("</div>", source.indexOf("data-sidebar-project-preview-footer")),
    )

    expect(source).toContain("data-sidebar-project-preview-footer")
    expect(footer).toContain("padding-top: 8px")
    expect(footer).toContain("border-top: 0")
    expect(footerSource).not.toMatch(/\bborder-(?:t|top)\b/)
  })

  test("gives view all sessions a stable thirty-six pixel neutral state ramp", () => {
    const rules = cssRules.filter((rule) => rule.groups?.selectors.includes("[data-sidebar-project-preview-view-all]"))
    const base = rules.find(
      (rule) => rule.groups?.selectors.trim() === '[data-component="button"][data-sidebar-project-preview-view-all]',
    )?.groups?.declarations
    const hover = rules.find((rule) =>
      rule.groups?.selectors.replace(/\s+/g, " ").includes(":is(:hover, :focus-visible)"),
    )?.groups?.declarations
    const pressed = rules.find((rule) => rule.groups?.selectors.includes(":active"))?.groups?.declarations

    expect(source).toContain("data-sidebar-project-preview-view-all")
    expect(source).not.toContain("hover:bg-transparent active:bg-transparent")
    expect(base).toContain("height: 36px")
    expect(base).toContain("background-color: transparent")
    expect(hover).toContain("var(--v2-background-bg-layer-02) 6%")
    expect(pressed).toContain("var(--v2-background-bg-layer-02) 12%")
  })

  test("reveals the full view-all label through its button only when rendered text overflows", () => {
    const control = source.slice(
      source.indexOf("const ProjectPreviewViewAllButton"),
      source.indexOf("const ProjectPreviewPanel"),
    )
    const panel = source.slice(
      source.indexOf("const ProjectPreviewPanel"),
      source.indexOf("export const SortableProject"),
    )

    expect(control).toContain("data-sidebar-project-preview-view-all")
    expect(control).toContain("data-sidebar-project-preview-view-all-label")
    expect(control).toContain("sidebarPrimaryActionLabelIsTruncated(label)")
    expect(control).toContain("new ResizeObserver(measure)")
    expect(control).toContain('window.addEventListener("resize", measure)')
    expect(control).toContain("inactive={!state.truncated}")
    expect(control).toContain('class="min-w-0 w-full"')
    expect(control).toContain('class="min-w-0 grow truncate"')
    expect(control).toContain('placement="top-start"')
    expect(control).toContain("flip")
    expect(control).toContain("slide")
    expect(control).toContain("overflowPadding={8}")
    expect(control).not.toContain("tabIndex=")
    expect(control).not.toContain("title=")
    expect(panel).toContain("<ProjectPreviewViewAllButton")
    expect(panel).toContain('label={props.language.t("sidebar.project.viewAllSessions")}')
    expect(declarationsFor('[data-component="button"][data-sidebar-project-preview-view-all]')).toContain(
      "height: 36px",
    )
  })

  test("keeps a persistent fourteen pixel RTL-aware disclosure chevron in a fixed trailing slot", () => {
    const control = source.slice(
      source.indexOf("const ProjectPreviewViewAllButton"),
      source.indexOf("const ProjectPreviewPanel"),
    )
    const slot = declarationsFor("[data-sidebar-project-preview-view-all-icon]")
    const icon = declarationsFor('[data-sidebar-project-preview-view-all-icon] [data-component="icon"]')
    const rtl = declarationsFor("[data-sidebar-project-preview-view-all-icon]:dir(rtl)")

    expect(control).toContain('data-sidebar-project-preview-view-all-icon aria-hidden="true"')
    expect(control).toContain('<Icon name="chevron-right" size="small" />')
    expect(control.indexOf("data-sidebar-project-preview-view-all-label")).toBeLessThan(
      control.indexOf("data-sidebar-project-preview-view-all-icon"),
    )
    expect(slot).toContain("flex: 0 0 16px")
    expect(slot).toContain("width: 16px")
    expect(slot).toContain("height: 16px")
    expect(slot).toContain("color: var(--v2-icon-icon-muted)")
    expect(slot).not.toMatch(/opacity|display:\s*none|visibility:\s*hidden/)
    expect(icon).toContain("width: 14px")
    expect(icon).toContain("height: 14px")
    expect(rtl).toContain("transform: scaleX(-1)")
    expect(declarationsFor('[data-component="button"][data-sidebar-project-preview-view-all]')).toContain(
      "height: 36px",
    )
  })

  test("raises only the disclosure chevron color through hover focus and press", () => {
    const defaultIcon = css.slice(
      css.indexOf(
        '[data-component="button"][data-sidebar-project-preview-view-all]\n  [data-sidebar-project-preview-view-all-icon]\n  [data-slot="icon-svg"]',
      ),
      css.indexOf("[data-sidebar-project-preview-view-all-icon]:dir(rtl)"),
    )
    const interaction = css.slice(
      css.indexOf(
        '[data-component="button"][data-variant="ghost"][data-sidebar-project-preview-view-all]:is(:hover, :focus-visible):not(',
      ),
      css.indexOf('[data-component="button"][data-sidebar-project-preview-view-all]:focus-visible'),
    )
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))

    expect(defaultIcon).toContain("color: var(--v2-icon-icon-muted)")
    expect(defaultIcon).toContain("transition: color 160ms ease-out")
    expect(interaction).toContain(":is(:hover, :focus-visible)")
    expect(interaction).toContain("color: var(--v2-icon-icon-base)")
    expect(interaction).toContain(":active:not(:disabled)")
    expect(interaction).toContain("color: var(--icon-strong-base)")
    expect(interaction).not.toMatch(/(?:transform|translate|scale|opacity)\s*:/)
    expect(reducedMotion).toContain('[data-sidebar-project-preview-view-all-icon] [data-slot="icon-svg"]')
    expect(reducedMotion).toContain("transition: none")
  })

  test("keeps a geometry-stable keyboard focus ring with a forced-colors fallback", () => {
    const focus = cssRules.find(
      (rule) =>
        rule.groups?.selectors.includes("[data-sidebar-project-preview-view-all]:focus-visible") &&
        !rule.groups.selectors.includes("@media"),
    )?.groups?.declarations
    const forcedColors = css.slice(css.indexOf("@media (forced-colors: active)"))

    expect(focus).toContain("outline: 2px solid var(--v2-border-border-focus)")
    expect(focus).toContain("outline-offset: -2px")
    expect(focus).not.toMatch(/(?:width|height|margin|padding|transform)\s*:/)
    expect(forcedColors).toContain("[data-sidebar-project-preview-view-all]:focus-visible")
    expect(forcedColors).toContain("outline-color: Highlight")
  })
})
