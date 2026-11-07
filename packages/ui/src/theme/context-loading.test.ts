import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readdirSync, readFileSync } from "node:fs"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { resolveConfig } from "vite"
import type { DesktopTheme } from "./types"

const packageRoot = fileURLToPath(new URL("../../", import.meta.url))
const owner = fileURLToPath(new URL("./context.tsx", import.meta.url)).replaceAll("\\", "/")
const payloadDir = fileURLToPath(new URL("./themes", import.meta.url))
const ids = readdirSync(payloadDir).filter(p => p.endsWith(".json")).map(p => p.slice(0, -5)).sort()
const globals = globalThis as typeof globalThis & { __themeOffline: boolean; __themeModuleEvaluations: string[] }
globals.__themeOffline = false
globals.__themeModuleEvaluations = []
let ThemeProvider: typeof import("./context").ThemeProvider
let useTheme: typeof import("./context").useTheme
let compiled = ""
let dispose: (() => void) | undefined
let host: HTMLDivElement
let mediaDescriptor: PropertyDescriptor | undefined
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

type GlobContext = { environment: object; resolve: (id: string, importer: string) => Promise<{ id: string }> }
type GlobTransform = (this: GlobContext, code: string, id: string) => Promise<{ code: string } | null>

beforeAll(async () => {
  // Compile the actual owner with its production Vite macro and Solid transform.
  // No dev server, bundle emission, alternate resolver or source substitutions.
  const config = await resolveConfig({ configFile: false, root: packageRoot, logLevel: "silent" }, "build")
  const glob = config.plugins.find(p => p.name === "vite:import-glob")
  if (!glob?.transform) throw Error("Vite glob compiler unavailable")
  const transform = (typeof glob.transform === "function" ? glob.transform : glob.transform.handler) as unknown as GlobTransform
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel: { transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null } = require("@babel/core")
  const solid: { default?: unknown } = require("babel-preset-solid")
  plugin({ name: "real-theme-provider-dom", setup(build) {
    build.onLoad({ filter: /[\\/]ui[\\/]src[\\/]theme[\\/]themes[\\/][^\\/]+\.json$/ }, ({ path: jsonPath }) => {
      const id = path.basename(jsonPath, ".json")
      // Actual JSON module payloads. Optional dependency evaluation fails only
      // after startup to model a network change during settings navigation.
      const fault = id === "arforge-default" ? "" : 'globalThis.__themeModuleEvaluations.push(' + JSON.stringify(id) + '); if (globalThis.__themeOffline) throw new Error("net::ERR_NETWORK_CHANGED");'
      return { loader: "js", contents: fault + "\nexport default " + readFileSync(jsonPath, "utf8") }
    })
    build.onLoad({ filter: /[\\/]ui[\\/]src[\\/](theme[\\/]context|context[\\/]helper)\.tsx$/ }, async ({ path: filePath }) => {
      const isOwner = filePath.replaceAll("\\", "/") === owner
      const result = babel.transformSync(readFileSync(filePath, "utf8"), { filename: filePath, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, presets: [[solid.default ?? solid, { generate: "dom" }]] })
      if (!result?.code) throw Error("Real Solid compilation failed")
      const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(result.code)
      const expanded = isOwner ? await transform.call({ environment: {}, resolve: async (id, importer) => ({ id: path.resolve(path.dirname(importer), id) }) }, javascript, filePath.replaceAll("\\", "/")) : undefined
      if (isOwner) compiled = expanded?.code ?? javascript
      return { contents: expanded?.code ?? javascript, loader: "js" }
    })
  } })
  ;({ ThemeProvider, useTheme } = await import("./context"))
})

beforeEach(() => {
  globals.__themeOffline = false
  localStorage.clear()
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("style")
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  mediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia")
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  host = document.createElement("div")
  document.body.append(host)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  host.remove()
  globals.__themeOffline = false
  if (mediaDescriptor) Object.defineProperty(window, "matchMedia", mediaDescriptor)
  else Reflect.deleteProperty(window, "matchMedia")
})

function start() {
  let theme: ReturnType<typeof useTheme> | undefined
  const applications: string[] = []
  dispose = render(() => createComponent(ThemeProvider, {
    onThemeApplied: (value: DesktopTheme) => applications.push(value.id),
    get children() {
      theme = useTheme()
      const draft = document.createElement("textarea")
      draft.value = "retained current draft"
      return draft
    },
  }), host)
  if (!theme) throw Error("Actual ThemeProvider did not mount")
  return { theme, applications }
}

test("catalog remains available after network change without optional theme dependency fetches", async () => {
  const { theme } = start()
  globals.__themeOffline = true
  const evaluations = globals.__themeModuleEvaluations.length
  const result = await theme.loadThemes().then(() => "loaded", () => "rejected")
  expect(result).toBe("loaded")
  expect(theme.ids()).toEqual(ids)
  expect(Object.keys(theme.themes()).sort()).toEqual(ids)
  expect(globals.__themeModuleEvaluations.length).toBe(evaluations)
  expect(host.querySelector("textarea")?.value).toBe("retained current draft")
})

test("real Vite macro emits static dependencies for all 36 original theme definitions", () => {
  expect(ids).toHaveLength(36)
  expect(compiled.match(/import\([^)]*themes\//g) ?? []).toHaveLength(0)
  expect(compiled.match(/import \* as __vite_glob_\d+_\d+ from/g) ?? []).toHaveLength(36)
})

test("all original theme choices retain exact payloads and work in Dark without network", async () => {
  const { theme } = start()
  globals.__themeOffline = true
  theme.setColorScheme("dark")
  await theme.loadThemes()
  for (const id of ids) {
    const original = JSON.parse(readFileSync(payloadDir + "/" + id + ".json", "utf8"))
    expect(JSON.parse(JSON.stringify(theme.themes()[id]))).toEqual(original)
    theme.setTheme(id)
    await settle()
    expect(theme.themeId()).toBe(id)
    expect(localStorage.getItem("arforge-theme-id")).toBe(id)
    expect(document.documentElement.dataset.theme).toBe(id)
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark")
    expect(localStorage.getItem("arforge-color-scheme")).toBe("dark")
  }
})

test("General catalog loading retains current persisted choice, cached CSS and draft", async () => {
  const { theme } = start()
  theme.setTheme("amoled")
  theme.setColorScheme("dark")
  await settle()
  const cached = ["arforge-theme-id", "arforge-color-scheme", "arforge-theme-css-light", "arforge-theme-css-dark"].map(key => localStorage.getItem(key))
  const css = document.getElementById("arforge-theme")?.textContent
  globals.__themeOffline = true
  await theme.loadThemes()
  await theme.loadThemes()
  expect(["arforge-theme-id", "arforge-color-scheme", "arforge-theme-css-light", "arforge-theme-css-dark"].map(key => localStorage.getItem(key))).toEqual(cached)
  expect(document.getElementById("arforge-theme")?.textContent).toBe(css)
  expect(host.querySelector("textarea")?.value).toBe("retained current draft")
})

test("stored custom theme restores during network failure and repeated catalog calls remain safe", async () => {
  localStorage.setItem("arforge-theme-id", "nightowl")
  localStorage.setItem("arforge-color-scheme", "dark")
  globals.__themeOffline = true
  const { theme } = start()
  await settle()
  await theme.loadThemes()
  await theme.loadThemes()
  expect(document.documentElement.dataset.theme).toBe("nightowl")
  expect(localStorage.getItem("arforge-theme-id")).toBe("nightowl")
  expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark")
})

test("late theme selection cannot replace a newer selection or its storage", async () => {
  const { theme } = start()
  theme.setTheme("amoled")
  theme.setTheme("aura")
  await settle()
  expect(document.documentElement.dataset.theme).toBe("aura")
  expect(localStorage.getItem("arforge-theme-id")).toBe("aura")
})

test("late preview cannot replace a later preview or cancelled selection", async () => {
  const { theme } = start()
  await settle()
  theme.previewTheme("amoled")
  theme.previewTheme("aura")
  await settle()
  expect(document.documentElement.dataset.theme).toBe("aura")
  theme.cancelPreview()
  await settle()
  expect(document.documentElement.dataset.theme).toBe("arforge-default")
  expect(localStorage.getItem("arforge-theme-id")).toBe("arforge-default")
})

test("cancelled preview restoration cannot overwrite a new committed theme", async () => {
  const { theme } = start()
  theme.setTheme("amoled")
  await settle()
  theme.previewTheme("nightowl")
  await settle()
  theme.cancelPreview()
  theme.setTheme("aura")
  await settle()
  expect(document.documentElement.dataset.theme).toBe("aura")
  expect(localStorage.getItem("arforge-theme-id")).toBe("aura")
})

test("provider disposal prevents pending preview, cache, storage and callback writes", async () => {
  const { theme, applications } = start()
  await settle()
  const css = document.getElementById("arforge-theme")?.textContent
  const count = applications.length
  theme.previewTheme("amoled")
  dispose?.()
  dispose = undefined
  await settle()
  expect(applications).toHaveLength(count)
  expect(document.getElementById("arforge-theme")?.textContent).toBe(css)
  expect(theme.themes().amoled).toBeUndefined()
  expect(localStorage.getItem("arforge-theme-id")).toBe("arforge-default")
})

test("storage event selection fences a preceding local asynchronous choice", async () => {
  const { theme } = start()
  theme.setTheme("amoled")
  localStorage.setItem("arforge-theme-id", "aura")
  window.dispatchEvent(new StorageEvent("storage", { key: "arforge-theme-id", newValue: "aura" }))
  await settle()
  expect(theme.themeId()).toBe("aura")
  expect(document.documentElement.dataset.theme).toBe("aura")
  expect(localStorage.getItem("arforge-theme-id")).toBe("aura")
})
