// @refresh reload

import { createEffect, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSimpleContext } from "../context/helper"
import arforgeDefaultThemeJson from "./themes/arforge-default.json"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { resolveThemeVariantV2, themeV2ToCss } from "./v2/resolve"
import type { DesktopTheme } from "./types"
import { normalizeColorScheme, themeCanvasColor } from "./preferences"

export type ColorScheme = "light" | "dark" | "system"

const STORAGE_KEYS = {
  THEME_ID: "arforge-theme-id",
  COLOR_SCHEME: "arforge-color-scheme",
  THEME_CSS_LIGHT: "arforge-theme-css-light",
  THEME_CSS_DARK: "arforge-theme-css-dark",
} as const

const THEME_STYLE_ID = "arforge-theme"
let files: Record<string, () => Promise<{ default: DesktopTheme }>> | undefined
let ids: string[] | undefined
let known: Set<string> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob<{ default: DesktopTheme }>("./themes/*.json")
  return files
}

function themeIDs() {
  if (ids) return ids
  ids = Object.keys(getFiles())
    .map((path) => path.slice("./themes/".length, -".json".length))
    .sort()
  return ids
}

function knownThemes() {
  if (known) return known
  known = new Set(themeIDs())
  return known
}

const names: Record<string, string> = {
  "arforge-default": "Arforge Default",
  amoled: "AMOLED",
  aura: "Aura",
  ayu: "Ayu",
  carbonfox: "Carbonfox",
  catppuccin: "Catppuccin",
  "catppuccin-frappe": "Catppuccin Frappe",
  "catppuccin-macchiato": "Catppuccin Macchiato",
  cobalt2: "Cobalt2",
  cursor: "Cursor",
  dracula: "Dracula",
  everforest: "Everforest",
  flexoki: "Flexoki",
  gruvbox: "Gruvbox",
  kanagawa: "Kanagawa",
  "lucent-orng": "Lucent Orng",
  material: "Material",
  matrix: "Matrix",
  mercury: "Mercury",
  monokai: "Monokai",
  nightowl: "Night Owl",
  nord: "Nord",
  "one-dark": "One Dark",
  onedarkpro: "One Dark Pro",
  arforge: "Arforge",
  orng: "Orng",
  "osaka-jade": "Osaka Jade",
  palenight: "Palenight",
  rosepine: "Rose Pine",
  shadesofpurple: "Shades of Purple",
  solarized: "Solarized",
  synthwave84: "Synthwave '84",
  tokyonight: "Tokyonight",
  vercel: "Vercel",
  vesper: "Vesper",
  zenburn: "Zenburn",
}
const arforgeDefaultTheme = arforgeDefaultThemeJson as DesktopTheme
const legacyThemePrefix = ["o", "c"].join("")

function normalize(id: string | null | undefined) {
  return id === `${legacyThemePrefix}-1` || id === `${legacyThemePrefix}-2` ? "arforge-default" : id
}

function read(key: string) {
  if (typeof localStorage !== "object") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function drop(key: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.removeItem(key)
  } catch {}
}

function clear() {
  drop(STORAGE_KEYS.THEME_CSS_LIGHT)
  drop(STORAGE_KEYS.THEME_CSS_DARK)
}

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function getSystemMode(): "light" | "dark" {
  if (typeof window !== "object") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function applyThemeCss(theme: DesktopTheme, themeId: string, mode: "light" | "dark") {
  const isDark = mode === "dark"
  const variant = isDark ? theme.dark : theme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)
  const v2Tokens = resolveThemeVariantV2(variant, isDark)
  const v2 = themeV2ToCss(v2Tokens)
  const canvas = themeCanvasColor({ ...tokens, ...v2Tokens }, isDark)

  if (themeId !== "arforge-default") {
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, `${css}\n  ${v2}`)
  }

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
  ${v2}
}`

  document.getElementById("arforge-theme-preload")?.remove()
  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  const nativeGlass = document.documentElement.dataset.runtime === "desktop"
  document.documentElement.style.backgroundColor = nativeGlass ? "transparent" : canvas

  // Update theme-color meta tag to match light/dark mode
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", canvas)
}

function cacheThemeVariants(theme: DesktopTheme, themeId: string) {
  if (themeId === "arforge-default") return
  for (const mode of ["light", "dark"] as const) {
    const isDark = mode === "dark"
    const variant = isDark ? theme.dark : theme.light
    const tokens = resolveThemeVariant(variant, isDark)
    const css = themeToCss(tokens)
    const v2 = themeV2ToCss(resolveThemeVariantV2(variant, isDark))
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, `${css}\n  ${v2}`)
  }
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: {
    defaultTheme?: string
    onThemeApplied?: (theme: DesktopTheme, mode: "light" | "dark", scheme: ColorScheme) => void
  }) => {
    const themeId = normalize(read(STORAGE_KEYS.THEME_ID) ?? props.defaultTheme) ?? "arforge-default"
    const colorScheme = normalizeColorScheme(read(STORAGE_KEYS.COLOR_SCHEME))
    const mode = colorScheme === "system" ? getSystemMode() : colorScheme
    const [store, setStore] = createStore({
      themes: {
        "arforge-default": arforgeDefaultTheme,
      } as Record<string, DesktopTheme>,
      themeId,
      colorScheme,
      mode,
      previewThemeId: null as string | null,
      previewScheme: null as ColorScheme | null,
    })

    const loads = new Map<string, Promise<DesktopTheme | undefined>>()

    const load = (id: string) => {
      const next = normalize(id)
      if (!next) return Promise.resolve(undefined)
      const hit = store.themes[next]
      if (hit) return Promise.resolve(hit)
      const pending = loads.get(next)
      if (pending) return pending
      const file = getFiles()[`./themes/${next}.json`]
      if (!file) return Promise.resolve(undefined)
      const task = file()
        .then((mod) => {
          const theme = mod.default
          setStore("themes", next, theme)
          return theme
        })
        .finally(() => {
          loads.delete(next)
        })
      loads.set(next, task)
      return task
    }

    const applyTheme = (theme: DesktopTheme, themeId: string, mode: "light" | "dark", scheme: ColorScheme) => {
      applyThemeCss(theme, themeId, mode)
      props.onThemeApplied?.(theme, mode, scheme)
    }

    const ids = () => {
      const extra = Object.keys(store.themes)
        .filter((id) => !knownThemes().has(id))
        .sort()
      const all = themeIDs()
      if (extra.length === 0) return all
      return [...all, ...extra]
    }

    const loadThemes = () => Promise.all(themeIDs().map(load)).then(() => store.themes)

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.THEME_ID || e.key === null) {
        const next = normalize(e.key === null ? read(STORAGE_KEYS.THEME_ID) : e.newValue) ?? "arforge-default"
        if (!next) return
        if (next !== "arforge-default" && !knownThemes().has(next) && !store.themes[next]) return
        setStore("themeId", next)
        if (next === "arforge-default") {
          clear()
          return
        }
        void load(next).then((theme) => {
          if (!theme || store.themeId !== next) return
          cacheThemeVariants(theme, next)
        })
      }
      if (e.key === STORAGE_KEYS.COLOR_SCHEME || e.key === null) {
        const scheme = normalizeColorScheme(e.key === null ? read(STORAGE_KEYS.COLOR_SCHEME) : e.newValue)
        setStore("colorScheme", scheme)
        setStore("mode", scheme === "system" ? getSystemMode() : scheme)
      }
    }

    onMount(() => {
      makeEventListener(window, "storage", onStorage)

      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const onMedia = () => {
        if (store.colorScheme !== "system") return
        setStore("mode", getSystemMode())
      }
      makeEventListener(mediaQuery, "change", onMedia)

      const rawTheme = read(STORAGE_KEYS.THEME_ID)
      const savedTheme = normalize(rawTheme ?? props.defaultTheme) ?? "arforge-default"
      const savedScheme = normalizeColorScheme(read(STORAGE_KEYS.COLOR_SCHEME))
      if (rawTheme && rawTheme !== savedTheme) {
        write(STORAGE_KEYS.THEME_ID, savedTheme)
        clear()
      }
      if (savedTheme !== store.themeId) setStore("themeId", savedTheme)
      if (savedScheme !== store.colorScheme) setStore("colorScheme", savedScheme)
      setStore("mode", savedScheme === "system" ? getSystemMode() : savedScheme)
      void load(savedTheme).then((theme) => {
        if (!theme || store.themeId !== savedTheme) return
        cacheThemeVariants(theme, savedTheme)
      })
    })

    createEffect(() => {
      const theme = store.themes[store.themeId]
      if (!theme) return
      applyTheme(theme, store.themeId, store.mode, store.colorScheme)
    })

    const setTheme = (id: string) => {
      const next = normalize(id)
      if (!next) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      if (next !== "arforge-default" && !knownThemes().has(next) && !store.themes[next]) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      setStore("themeId", next)
      if (next === "arforge-default") {
        write(STORAGE_KEYS.THEME_ID, next)
        clear()
        return
      }
      void load(next).then((theme) => {
        if (!theme || store.themeId !== next) return
        cacheThemeVariants(theme, next)
        write(STORAGE_KEYS.THEME_ID, next)
      })
    }

    const setColorScheme = (scheme: ColorScheme) => {
      setStore("colorScheme", scheme)
      write(STORAGE_KEYS.COLOR_SCHEME, scheme)
      setStore("mode", scheme === "system" ? getSystemMode() : scheme)
    }

    return {
      themeId: () => store.themeId,
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      ids,
      name: (id: string) => store.themes[id]?.name ?? names[id] ?? id,
      loadThemes,
      themes: () => store.themes,
      setTheme,
      setColorScheme,
      registerTheme: (theme: DesktopTheme) => setStore("themes", theme.id, theme),
      previewTheme: (id: string) => {
        const next = normalize(id)
        if (!next) return
        if (next !== "arforge-default" && !knownThemes().has(next) && !store.themes[next]) return
        setStore("previewThemeId", next)
        void load(next).then((theme) => {
          if (!theme || store.previewThemeId !== next) return
          const mode = store.previewScheme
            ? store.previewScheme === "system"
              ? getSystemMode()
              : store.previewScheme
            : store.mode
          applyTheme(theme, next, mode, store.previewScheme ?? store.colorScheme)
        })
      },
      previewColorScheme: (scheme: ColorScheme) => {
        setStore("previewScheme", scheme)
        const mode = scheme === "system" ? getSystemMode() : scheme
        const id = store.previewThemeId ?? store.themeId
        void load(id).then((theme) => {
          if (!theme) return
          if ((store.previewThemeId ?? store.themeId) !== id) return
          if (store.previewScheme !== scheme) return
          applyTheme(theme, id, mode, scheme)
        })
      },
      commitPreview: () => {
        if (store.previewThemeId) {
          setTheme(store.previewThemeId)
        }
        if (store.previewScheme) {
          setColorScheme(store.previewScheme)
        }
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
      },
      cancelPreview: () => {
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
        void load(store.themeId).then((theme) => {
          if (!theme) return
          applyTheme(theme, store.themeId, store.mode, store.colorScheme)
        })
      },
    }
  },
})
