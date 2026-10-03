import { describe, expect, test } from "bun:test"
import themeJson from "./themes/arforge-default.json"
import { normalizeColorScheme, themeCanvasColor } from "./preferences"
import { resolveThemeVariant } from "./resolve"
import { resolveThemeVariantV2 } from "./v2/resolve"
import type { DesktopTheme } from "./types"

const theme = themeJson as DesktopTheme

describe("approved V2 theme foundation", () => {
  for (const [mode, background, text, accent, onAccent] of [
    ["light", "#FAFAF7", "#292B2B", "#292B2B", "#FFFFFF"],
    ["dark", "#1C1D1B", "#ECEEE6", "#E8EBDF", "#24251F"],
  ] as const) {
    test(mode + " uses the approved canvas and readable semantic foregrounds", () => {
      const legacy = resolveThemeVariant(theme[mode], mode === "dark")
      const modern = resolveThemeVariantV2(theme[mode], mode === "dark")
      expect(legacy["background-base"]).toBe(background)
      expect(legacy["text-strong"]).toBe(text)
      expect(modern["v2-background-bg-deep"]).toBe(background)
      expect(modern["v2-text-text-base"]).toBe(text)
      expect(modern["v2-background-bg-accent"]).toBe(accent)
      expect(modern["v2-text-text-contrast"]).toBe(onAccent)
      expect(modern["arforge-review-canvas"]).toBe(background)
      expect(themeCanvasColor({ ...legacy, ...modern }, mode === "dark")).toBe(background)
    })

    test(mode + " retains syntax and independent semantic status colors", () => {
      const legacy = resolveThemeVariant(theme[mode], mode === "dark")
      const modern = resolveThemeVariantV2(theme[mode], mode === "dark")
      expect(legacy["syntax-keyword"]).toBeTruthy()
      expect(legacy["syntax-string"]).toBeTruthy()
      expect(modern["v2-state-fg-success"]).not.toBe(modern["v2-state-fg-danger"])
      expect(modern["v2-state-fg-warning"]).not.toBe(modern["v2-text-text-base"])
      expect(legacy["icon-weak-base"]).toMatch(/^#[\da-f]{6}$/i)
    })
  }

  test("missing or malformed scheme defaults to light without replacing explicit choices", () => {
    for (const missing of [null, undefined, "", "corrupt", 1]) {
      expect(normalizeColorScheme(missing)).toBe("light")
    }
    for (const explicit of ["light", "dark", "system"] as const) {
      expect(normalizeColorScheme(explicit)).toBe(explicit)
    }
  })

  test("custom-theme canvas references resolve without changing the custom token map", () => {
    const tokens = {
      "v2-background-bg-deep": "var(--custom-surface)",
      "custom-surface": "var(--custom-neutral)",
      "custom-neutral": "#123456",
    }
    const snapshot = { ...tokens }
    expect(themeCanvasColor(tokens, false)).toBe("#123456")
    expect(tokens).toEqual(snapshot)
  })

  test("malformed or cyclic custom tokens use a safe scheme fallback", () => {
    expect(themeCanvasColor({ "background-base": "var(--background-base)" }, false)).toBe("#FAFAF7")
    expect(themeCanvasColor({}, true)).toBe("#1C1D1B")
    expect(themeCanvasColor({ "background-base": "#abcd" }, false)).toBe("#FAFAF7")
  })
})
