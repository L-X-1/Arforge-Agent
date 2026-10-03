export type ThemeColorScheme = "light" | "dark" | "system"

/** A missing preference is warm light; an explicit system preference stays system. */
export function normalizeColorScheme(value: unknown): ThemeColorScheme {
  return value === "dark" || value === "system" || value === "light" ? value : "light"
}

/** Resolve CSS token references for the native canvas and theme-color metadata. */
export function themeCanvasColor(tokens: Record<string, string>, dark: boolean): string {
  let value = tokens["v2-background-bg-deep"] ?? tokens["background-base"]
  const seen = new Set<string>()
  while (value) {
    if (/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) return value
    const reference = /^var\(--([\w-]+)\)$/.exec(value.trim())?.[1]
    if (!reference || seen.has(reference)) break
    seen.add(reference)
    value = tokens[reference]
  }
  return dark ? "#1C1D1B" : "#FAFAF7"
}
