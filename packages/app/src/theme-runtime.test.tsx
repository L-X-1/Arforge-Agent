import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

let ThemeProvider: typeof import("@arforge-ai/ui/theme/context").ThemeProvider
let useTheme: typeof import("@arforge-ai/ui/theme/context").useTheme

const preload = await Bun.file(new URL("../public/arforge-theme-preload.js", import.meta.url)).text()
let dispose: (() => void) | undefined
let matchMediaDescriptor: PropertyDescriptor | undefined
let mount: HTMLDivElement
let systemDark: boolean
const listeners = new Set<EventListenerOrEventListenerObject>()

beforeAll(async () => {
  // Use the existing runtime-insight component regression's real Solid transform.
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel: {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  } = require("@babel/core")
  const solid = require("babel-preset-solid")
  plugin({
    name: "theme-runtime-dom",
    setup(build) {
      build.onLoad({ filter: /[\\/]packages[\\/]ui[\\/]src[\\/](theme[\\/]context|context[\\/]helper)\.tsx$/ }, async ({ path }) => {
        const result = babel.transformSync(await Bun.file(path).text(), {
          filename: path, configFile: false, babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solid.default ?? solid, { generate: "dom" }]],
        })
        if (!result?.code) throw new Error("Solid compilation failed: " + path)
        return { contents: result.code, loader: "ts" }
      })
    },
  })
  ;({ ThemeProvider, useTheme } = await import("@arforge-ai/ui/theme/context"))
})

beforeEach(() => {
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia")
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("style")
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  systemDark = false
  listeners.clear()
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() { return systemDark },
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener),
    }),
  })
  mount = document.createElement("div")
  document.body.append(mount)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  mount.remove()
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("style")
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  if (matchMediaDescriptor) Object.defineProperty(window, "matchMedia", matchMediaDescriptor)
  else Reflect.deleteProperty(window, "matchMedia")
})

function start() {
  // Exercise the real startup owner: its inline scheme survives stylesheet changes.
  Function(preload)()
  let theme: ReturnType<typeof useTheme> | undefined
  dispose = render(() => createComponent(ThemeProvider, {
    get children() {
      theme = useTheme()
      return document.createElement("span")
    },
  }), mount)
  if (!theme) throw new Error("ThemeProvider did not mount")
  return theme
}

function assertScheme(mode: "light" | "dark") {
  expect(document.documentElement.dataset.colorScheme).toBe(mode)
  expect(getComputedStyle(document.documentElement).colorScheme).toBe(mode)
  expect(document.getElementById("arforge-theme")?.textContent).toContain(`color-scheme: ${mode}`)
}

async function changeSystem(dark: boolean) {
  systemDark = dark
  const event = new Event("change")
  Object.defineProperty(event, "matches", { value: dark })
  for (const listener of listeners) {
    if (typeof listener === "function") listener(event)
    else listener.handleEvent(event)
  }
  await Promise.resolve()
}

describe("runtime color scheme takes ownership from preload", () => {
  test("explicit Dark replaces retained inline Light without changing theme identity", async () => {
    const theme = start()
    assertScheme("light")
    expect(document.documentElement.style.colorScheme).toBe("light")
    theme.setColorScheme("dark")
    await Promise.resolve()
    expect(localStorage.getItem("arforge-color-scheme")).toBe("dark")
    expect(theme.themeId()).toBe("arforge-default")
    assertScheme("dark")
  })

  test("explicit Light replaces retained inline Dark even when the OS prefers Dark", async () => {
    systemDark = true
    localStorage.setItem("arforge-color-scheme", "dark")
    const theme = start()
    assertScheme("dark")
    theme.setColorScheme("light")
    await Promise.resolve()
    expect(localStorage.getItem("arforge-color-scheme")).toBe("light")
    assertScheme("light")
  })

  test("System keeps following OS changes and an explicit choice stops following", async () => {
    const theme = start()
    theme.setColorScheme("system")
    await Promise.resolve()
    assertScheme("light")
    await changeSystem(true)
    expect(localStorage.getItem("arforge-color-scheme")).toBe("system")
    assertScheme("dark")
    await changeSystem(false)
    assertScheme("light")
    theme.setColorScheme("dark")
    await Promise.resolve()
    await changeSystem(false)
    expect(localStorage.getItem("arforge-color-scheme")).toBe("dark")
    assertScheme("dark")
  })
})
