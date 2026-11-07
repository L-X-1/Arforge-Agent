import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import ts from "typescript"
import { getWorkbenchBrowserAppearance, setWorkbenchBrowserAppearance } from "./browser-appearance"
import { createWindowRegistry } from "./window-registry"
import { observeWorkbenchBrowserOwnerZoom } from "./browser-owner-zoom"
import type { TitlebarTheme } from "../preload/types"

type Overlay = { color: string; symbolColor: string; height: number }

const sourceURL = new URL("./windows.ts", import.meta.url)
const requireBuiltin = createRequire(import.meta.url)
const compiled = ts.transpileModule(
  readFileSync(sourceURL, "utf8").replaceAll("import.meta.url", JSON.stringify(sourceURL.href)),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText

// Execute the actual window owner with local Electron doubles. No global module
// mocks, Electron process, user store, network or renderer are involved.
function fixture(platform = "win32") {
  const windows: FakeWindow[] = []
  const removedStateFiles: string[] = []
  const nativeTheme = { shouldUseDarkColors: false, themeSource: "system" }
  type PermissionDetails = { requestingUrl?: string; isMainFrame: boolean }
  type PermissionRequest = (sender: { id: number }, permission: string, callback: (allowed: boolean) => void, details: PermissionDetails) => void
  type PermissionCheck = (sender: { id: number } | null, permission: string, origin: string, details: PermissionDetails) => boolean
  // Main windows omit session/partition, so Electron shares this app Session.
  // Registering a handler replaces it for every contents on that Session.
  const defaultSession = {
    permissionRequest: undefined as PermissionRequest | undefined,
    permissionCheck: undefined as PermissionCheck | undefined,
    webRequest: { onHeadersReceived() {} },
    setPermissionRequestHandler(handler: PermissionRequest) { this.permissionRequest = handler },
    setPermissionCheckHandler(handler: PermissionCheck) { this.permissionCheck = handler },
  }
  class FakeContents extends EventEmitter {
    id = windows.length + 1
    zoom = 1
    destroyed = false
    session = defaultSession
    get permissionRequest() { return this.session.permissionRequest }
    get permissionCheck() { return this.session.permissionCheck }
    isDestroyed() {
      return this.destroyed
    }
    getZoomFactor() {
      if (this.destroyed) throw new TypeError("Object has been destroyed")
      return this.zoom
    }
    setZoomFactor(value: number) {
      this.zoom = value
    }
    send() {}
  }
  class FakeWindow extends EventEmitter {
    static fromWebContents(contents: { id: number }) {
      return windows.find(win => win.contents === contents && !win.destroyed) ?? null
    }
    contents = new FakeContents()
    destroyed = false
    overlays: Overlay[] = []
    nativeFailure?: Error
    constructor(readonly options: {
      titleBarOverlay?: Overlay
      webPreferences?: { contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean; session?: unknown; partition?: string }
    } = {}) {
      super()
      windows.push(this)
    }
    get webContents() {
      if (this.destroyed) throw new TypeError("Object has been destroyed")
      return this.contents
    }
    isDestroyed() {
      return this.destroyed
    }
    setTitleBarOverlay(value: Overlay) {
      if (!this.options.titleBarOverlay) throw new TypeError("Titlebar overlay is not enabled")
      if (this.nativeFailure) throw this.nativeFailure
      this.overlays.push(value)
    }
    setIcon() {}
    setAppDetails() {}
    loadURL() {
      return Promise.resolve()
    }
    destroy() {
      this.destroyed = true
      this.contents.destroyed = true
      this.emit("closed")
    }
  }
  const store = new Map<string, unknown>()
  const dependencies: Record<string, unknown> = {
    "node:fs": {
      rmSync: (path: string) => {
        expect(path.replaceAll("\\", "/")).toMatch(/^C:\/titlebar-owned-fixture\/window-state-[a-zA-Z0-9_-]+\.json$/)
        removedStateFiles.push(path)
      },
    },
    "electron-window-state": () => ({ width: 1280, height: 800, manage() {} }),
    electron: {
      app: { isPackaged: false, getLocale: () => "en", getPath: () => "C:/titlebar-owned-fixture" },
      BrowserWindow: FakeWindow,
      nativeTheme,
      nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
      protocol: { registerSchemesAsPrivileged() {} },
    },
    "./browser-appearance": { setWorkbenchBrowserAppearance },
    "./browser-owner-zoom": { observeWorkbenchBrowserOwnerZoom },
    "@arforge-ai/ui/theme/resolve": { resolveThemeVariant: () => ({ "background-base": "#ffffff" }) },
    "../../../ui/src/theme/themes/arforge-default.json": { light: {}, dark: {} },
    "./constants": { APP_IDS: { dev: "titlebar-test" }, CHANNEL: "dev" },
    "./logging": {},
    "./store": { getStore: () => store, removeStoreFile: (name: string) => store.delete(name) },
    "./store-keys": { WINDOW_IDS_KEY: "windows", PINCH_ZOOM_ENABLED_KEY: "pinch" },
    "./unresponsive": { createUnresponsiveSampler: () => ({}) },
    "./window-registry": { createWindowRegistry },
    "./window-state": {},
    "./preview-resource-url": {},
    "./relaunch": {},
    "./renderer-route": {},
    "./renderer-security": {},
    "./window-recovery-copy": { windowRecoveryCopy: () => ({}) },
  }
  const module = { exports: {} }
  new Function("require", "module", "exports", "process", compiled)(
    (name: string) => {
      if (name in dependencies) return dependencies[name]
      if (name.startsWith("node:") && name !== "node:fs") return requireBuiltin(name)
      throw new Error(`Unexpected titlebar fixture dependency: ${name}`)
    },
    module,
    module.exports,
    { platform, env: {} },
  )
  const owner = module.exports as {
    createMainWindow(id?: string): FakeWindow
    getWindowID(win: FakeWindow): string | undefined
    setTitlebar(win: FakeWindow, theme?: Partial<TitlebarTheme>): void
    updateTitlebar(win: FakeWindow): void
  }
  return { owner, nativeTheme, foreign: () => new FakeWindow(), removedStateFiles, windows }
}

describe("Windows main-window shortcut", () => {
  const shortcut = {
    type: "keyDown", key: "N", code: "KeyN", control: true, shift: true, alt: false, meta: false,
    isAutoRepeat: false, isComposing: false,
  }

  test.each(["N", "n"])("creates one registered sibling from the actual owner listener for %s", (key) => {
    const { owner, windows } = fixture()
    const source = owner.createMainWindow("source")
    let prevented = 0
    source.contents.emit("before-input-event", { preventDefault: () => { prevented++ } }, { ...shortcut, key })
    expect(prevented).toBe(1)
    expect(windows).toHaveLength(2)
    const sibling = windows[1]!
    expect(owner.getWindowID(source)).toBe("source")
    expect(owner.getWindowID(sibling)).toBeTruthy()
    expect(owner.getWindowID(sibling)).not.toBe("source")
    expect(sibling.contents).not.toBe(source.contents)
    expect(sibling.options.webPreferences).toEqual(source.options.webPreferences)
    expect(source.destroyed).toBe(false)
  })

  test.each([
    { type: "keyUp" }, { isAutoRepeat: true }, { isComposing: true }, { alt: true }, { meta: true },
    { control: false }, { shift: false }, { key: "M" }, { key: "Process" },
  ])("leaves other/custom key events untouched: %j", (change) => {
    const { owner, windows } = fixture()
    const source = owner.createMainWindow("source")
    let prevented = 0
    source.contents.emit("before-input-event", { preventDefault: () => { prevented++ } }, { ...shortcut, ...change })
    expect(windows).toHaveLength(1)
    expect(prevented).toBe(0)
  })

  test("ignores late input from a destroyed owner or contents", () => {
    for (const destroyOwner of [false, true]) {
      const { owner, windows } = fixture()
      const source = owner.createMainWindow("source")
      const contents = source.contents
      if (destroyOwner) source.destroy()
      else contents.destroyed = true
      let prevented = 0
      contents.emit("before-input-event", { preventDefault: () => { prevented++ } }, shortcut)
      expect(windows).toHaveLength(1)
      expect(prevented).toBe(0)
    }
  })

  test.each(["darwin", "linux"])("does not register a Windows shortcut on %s", (platform) => {
    const { owner } = fixture(platform)
    const source = owner.createMainWindow("source")
    expect(source.contents.listenerCount("before-input-event")).toBe(0)
  })

  test("does not register the shortcut on a foreign window", () => {
    const { owner, foreign } = fixture()
    const source = owner.createMainWindow("source")
    const unrelated = foreign()
    expect(source.contents.listenerCount("before-input-event")).toBe(1)
    expect(unrelated.contents.listenerCount("before-input-event")).toBe(0)
  })
})

describe("native titlebar window ownership", () => {
  test("ignores the overlay API for a foreign preload window without that capability", () => {
    const { owner, foreign } = fixture()
    const win = foreign()
    expect(() => owner.setTitlebar(win, { mode: "dark", locale: "zh" })).not.toThrow()
    expect(() => owner.updateTitlebar(win)).not.toThrow()
    expect(win.overlays).toEqual([])
    expect(getWorkbenchBrowserAppearance(win)).toEqual({ mode: "dark", locale: "zh" })
  })

  test("keeps the configured main window caption colors, transparent overlay and zoom height", () => {
    const { owner } = fixture()
    const win = owner.createMainWindow("main")
    expect(win.options.titleBarOverlay).toEqual({ color: "#00000000", symbolColor: "black", height: 44 })
    owner.setTitlebar(win, { mode: "dark", locale: "zh" })
    expect(win.overlays.at(-1)).toEqual({ color: "#00000000", symbolColor: "white", height: 44 })
    win.contents.zoom = 1.5
    owner.updateTitlebar(win)
    expect(win.overlays.at(-1)?.height).toBe(66)
    win.contents.zoom = 0.5
    owner.setTitlebar(win, { mode: "light" })
    expect(win.overlays.at(-1)).toEqual({ color: "#00000000", symbolColor: "black", height: 44 })
    expect(getWorkbenchBrowserAppearance(win)).toEqual({ mode: "light", locale: "zh" })
  })

  test("does not lose the main window capability when an unsupported window updates", () => {
    const { owner, foreign } = fixture()
    const main = owner.createMainWindow("main")
    expect(() => owner.setTitlebar(foreign(), { mode: "dark" })).not.toThrow()
    owner.setTitlebar(main, { mode: "light" })
    expect(main.overlays.at(-1)?.symbolColor).toBe("black")
  })

  test("late updates after owner destruction do not read the invalid webContents getter or change appearance", () => {
    const { owner } = fixture()
    const win = owner.createMainWindow("main")
    owner.setTitlebar(win, { mode: "dark", locale: "zh" })
    const count = win.overlays.length
    win.destroy()
    expect(() => owner.setTitlebar(win, { mode: "light", locale: "en" })).not.toThrow()
    expect(() => owner.updateTitlebar(win)).not.toThrow()
    expect(win.overlays).toHaveLength(count)
    expect(getWorkbenchBrowserAppearance(win)).toEqual({ mode: "dark", locale: "zh" })
  })

  test("late zoom updates do not use destroyed renderer contents", () => {
    const { owner } = fixture()
    const win = owner.createMainWindow("main")
    win.contents.destroyed = true
    expect(() => owner.setTitlebar(win, { mode: "dark" })).not.toThrow()
    expect(() => owner.updateTitlebar(win)).not.toThrow()
    expect(win.overlays).toEqual([])
  })

  test("still surfaces a real native error from a live overlay-enabled main window", () => {
    const { owner } = fixture()
    const win = owner.createMainWindow("main")
    const failure = new Error("native overlay update failed")
    win.nativeFailure = failure
    expect(() => owner.setTitlebar(win, { mode: "dark" })).toThrow(failure)
  })

  test("macOS keeps native scheme tracking without invoking the Windows overlay API", () => {
    const { owner, nativeTheme } = fixture("darwin")
    const win = owner.createMainWindow("main")
    owner.setTitlebar(win, { mode: "dark", scheme: "system", locale: "zh" })
    expect(nativeTheme.themeSource).toBe("system")
    owner.setTitlebar(win, { mode: "light", scheme: "light" })
    expect(nativeTheme.themeSource).toBe("light")
    expect(win.overlays).toEqual([])
  })

  test("Linux keeps browser appearance synchronization without invoking the Windows overlay API", () => {
    const { owner } = fixture("linux")
    const win = owner.createMainWindow("main")
    owner.setTitlebar(win, { mode: "dark", locale: "zh" })
    owner.updateTitlebar(win)
    expect(getWorkbenchBrowserAppearance(win)).toEqual({ mode: "dark", locale: "zh" })
    expect(win.overlays).toEqual([])
  })
})

describe("renderer media fullscreen permission", () => {
  test("keeps both registered main windows allowed on the shared Session after either closes", () => {
    for (const closeFirst of [false, true]) {
      const { owner, removedStateFiles } = fixture()
      const first = owner.createMainWindow("first")
      const second = owner.createMainWindow("second")
      expect(first.contents.session).toBe(second.contents.session)
      for (const win of [first, second]) {
        expect(win.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
        expect(win.options.webPreferences?.session).toBeUndefined()
        expect(win.options.webPreferences?.partition).toBeUndefined()
      }
      const details = { requestingUrl: "arforge://renderer/index.html", isMainFrame: true }
      const allowed = (contents: typeof first.contents) => {
        for (const permission of ["fullscreen", "clipboard-sanitized-write", "notifications"]) {
          let requested: boolean | undefined
          first.contents.session.permissionRequest!(contents, permission, value => { requested = value }, details)
          expect(requested).toBe(true)
          expect(first.contents.session.permissionCheck!(contents, permission, "arforge://renderer", details)).toBe(true)
        }
      }
      allowed(first.contents)
      allowed(second.contents)
      const closed = closeFirst ? first : second
      const survivor = closeFirst ? second : first
      closed.destroy()
      expect(removedStateFiles).toHaveLength(1)
      allowed(survivor.contents)
      const third = owner.createMainWindow("third")
      allowed(survivor.contents)
      allowed(third.contents)
    }
  })

  test("shared Session denies iframe, foreign, closed and unknown permission requests", () => {
    const { owner, foreign } = fixture()
    const first = owner.createMainWindow("first")
    const second = owner.createMainWindow("second")
    const unregistered = foreign().contents
    const shared = first.contents.session
    const trusted = { requestingUrl: "arforge://renderer/index.html", isMainFrame: true }
    second.destroy()
    for (const [sender, details] of [
      [first.contents, { ...trusted, isMainFrame: false }],
      [unregistered, trusted],
      [second.contents, trusted],
      [first.contents, { requestingUrl: "https://example.com/", isMainFrame: true }],
      [first.contents, { requestingUrl: "blob:arforge://renderer/fixture", isMainFrame: true }],
      [first.contents, { requestingUrl: "data:text/html,fixture", isMainFrame: true }],
    ] as const) {
      let requested = true
      shared.permissionRequest!(sender, "fullscreen", value => { requested = value }, details)
      expect(requested).toBe(false)
      expect(shared.permissionCheck!(sender, "fullscreen", details.requestingUrl, details)).toBe(false)
    }
    expect(shared.permissionCheck!(null, "fullscreen", "arforge://renderer", trusted)).toBe(false)
    for (const permission of ["media", "geolocation", "display-capture", "clipboard-read", "unknown"]) {
      let requested = true
      shared.permissionRequest!(first.contents, permission, value => { requested = value }, trusted)
      expect(requested).toBe(false)
      expect(shared.permissionCheck!(first.contents, permission, "arforge://renderer", trusted)).toBe(false)
    }
  })

  test("allows the registered trusted App main frame through actual request and check handlers", () => {
    const { owner } = fixture()
    const contents = owner.createMainWindow("main").contents
    const details = { requestingUrl: "arforge://renderer/index.html", isMainFrame: true }
    let allowed: boolean | undefined
    contents.permissionRequest!(contents, "fullscreen", value => { allowed = value }, details)
    expect(allowed).toBe(true)
    expect(contents.permissionCheck!(contents, "fullscreen", "arforge://renderer", details)).toBe(true)
  })

  test("denies fullscreen to subframes, foreign contents, opaque sources and websites", () => {
    const { owner } = fixture()
    const contents = owner.createMainWindow("main").contents
    for (const [sender, details] of [
      [contents, { requestingUrl: "arforge://renderer/index.html", isMainFrame: false }],
      [{ id: contents.id + 1 }, { requestingUrl: "arforge://renderer/index.html", isMainFrame: true }],
      [contents, { requestingUrl: "https://example.com/", isMainFrame: true }],
      [contents, { requestingUrl: "blob:arforge://renderer/fixture", isMainFrame: true }],
      [contents, { requestingUrl: "data:text/html,fixture", isMainFrame: true }],
    ] as const) {
      let allowed = true
      contents.permissionRequest!(sender, "fullscreen", value => { allowed = value }, details)
      expect(allowed).toBe(false)
      expect(contents.permissionCheck!(sender, "fullscreen", details.requestingUrl, details)).toBe(false)
    }
    expect(contents.permissionCheck!(null, "fullscreen", "arforge://renderer", { isMainFrame: true })).toBe(false)
  })

  test("retains clipboard and notification grants while denying unrelated permissions", () => {
    const { owner } = fixture()
    const contents = owner.createMainWindow("main").contents
    const details = { requestingUrl: "arforge://renderer/index.html", isMainFrame: true }
    for (const permission of ["clipboard-sanitized-write", "notifications", "media", "geolocation", "display-capture", "clipboard-read"]) {
      let allowed: boolean | undefined
      contents.permissionRequest!(contents, permission, value => { allowed = value }, details)
      expect(allowed).toBe(["clipboard-sanitized-write", "notifications"].includes(permission))
    }
  })
})
