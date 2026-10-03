import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@arforge-ai/app/desktop-menu"
import { NativeActionKind } from "@arforge-ai/core/runtime/native-action"
import type { createNativeActionRuntime } from "@arforge-ai/core/runtime/native-action"

import type { FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { StoreMutationCoordinator } from "./store-mutation"
import { getPinchZoomEnabled, getWindowID, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { executeNative } from "./native-action-bridge"
import { workbenchBrowserController } from "./browser-embed"
import { requireBrowserLayoutRequest, requireBrowserWorkbenchRequest } from "./browser-embed-policy"
import { compactDefined, requireNativeStoreValue } from "./native-input"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()
const storeMutations = new StoreMutationCoordinator()

function requireBrowserOwner(event: IpcMainInvokeEvent) {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame || !getWindowID(owner))
    throw new Error("Browser controls require the owning application main frame")
  return owner
}

const browserInputDigest = (value: string) => createHash("sha256").update(value).digest("hex")

type Deps = {
  nativeActions: ReturnType<typeof createNativeActionRuntime>
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  getRenderingMode?: () => Promise<"software" | "hardware"> | "software" | "hardware"
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
}

const requireNativeString = (name: string, value: unknown, max = 16_384) => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new TypeError(`Invalid ${name}`)
  return value
}

const requireNativeNullableString = (name: string, value: unknown, max = 16_384) => {
  if (value === null) return null
  return requireNativeString(name, value, max)
}

const requireNativeBoolean = (name: string, value: unknown) => {
  if (typeof value !== "boolean") throw new TypeError(`Invalid ${name}`)
  return value
}

const requireNativeFiniteNumber = (name: string, value: unknown, min: number, max: number) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new TypeError(`Invalid ${name}`)
  return value
}

const requireNativeUrl = (value: unknown) => {
  if (value === null) return null
  const raw = requireNativeString("server URL", value, 2048)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new TypeError("Invalid server URL")
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
    throw new TypeError("Invalid server URL")
  return raw
}

const requireNativeStorePart = (name: string, value: unknown) => {
  const raw = requireNativeString(name, value, 256)
  // Persisted renderer keys intentionally use a namespaced `scope:key` form
  // (for example `session:<id>:prompt`). Keep the key bounded and portable,
  // while accepting the namespace separator used by the storage contract.
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) throw new TypeError(`Invalid ${name}`)
  return raw
}

const requireNativePayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new TypeError("Native action payload must be an object")
  return Object.fromEntries(Object.entries(payload))
}

const desktopMenuActions: ReadonlySet<string> = new Set([
  "app.relaunch",
  "edit.undo",
  "edit.redo",
  "edit.cut",
  "edit.copy",
  "edit.paste",
  "edit.delete",
  "edit.selectAll",
  "view.reload",
  "view.toggleDevTools",
  "view.resetZoom",
  "view.zoomIn",
  "view.zoomOut",
  "view.toggleFullscreen",
  "window.new",
  "window.browser",
  "window.close",
  "window.minimize",
  "window.toggleMaximize",
])

const isDesktopMenuAction = (value: string): value is DesktopMenuAction => desktopMenuActions.has(value)

const requireNativeDesktopMenuAction = (value: unknown): DesktopMenuAction => {
  const raw = requireNativeString("desktop menu action", value, 128)
  if (!isDesktopMenuAction(raw)) throw new TypeError("Invalid desktop menu action")
  return raw
}

const nativeKindForDesktopMenuAction = (action: DesktopMenuAction) =>
  action === "edit.copy" || action === "edit.cut" || action === "edit.paste"
    ? NativeActionKind.clipboard
    : NativeActionKind.window

type NativeDirectoryPickerOptions = Readonly<{
  readonly multiple?: boolean
  readonly title?: string
  readonly defaultPath?: string
}>

const requireNativeDirectoryPickerOptions = (opts: unknown): NativeDirectoryPickerOptions => {
  if (opts === undefined) return {}
  const payload = requireNativePayload(opts)
  const multiple = payload.multiple === undefined ? undefined : requireNativeBoolean("multiple", payload.multiple)
  const title =
    payload.title === undefined ? undefined : requireNativeString("directory picker title", payload.title, 512)
  const defaultPath =
    payload.defaultPath === undefined
      ? undefined
      : requireNativeString("directory picker path", payload.defaultPath, 32 * 1024)
  return compactDefined({ multiple, title, defaultPath })
}

export function registerIpcHandlers(deps: Deps) {
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)

  ipcMain.handle("workbench-browser", (event: IpcMainInvokeEvent, value: unknown) => {
    const checked = requireBrowserWorkbenchRequest(value)
    const controller = workbenchBrowserController(requireBrowserOwner(event))
    return executeNative(deps.nativeActions, event, NativeActionKind.window, "workbench-browser", {
      action: checked.action,
      scopeDigest: browserInputDigest(checked.scope),
      ...("pageID" in checked ? { pageID: checked.pageID } : {}),
      ...(checked.action === "navigate" ? { addressDigest: browserInputDigest(checked.url) } : {}),
    }, () => {
      requireBrowserOwner(event)
      if (checked.action === "open") return controller.open(checked.scope)
      if (checked.action === "close") return controller.close(checked.scope, checked.pageID)
      return controller.command(checked.scope, checked.pageID, checked)
    })
  })

  ipcMain.handle("workbench-browser-layout", (event: IpcMainInvokeEvent, value: unknown) => {
    const checked = requireBrowserLayoutRequest(value)
    const controller = workbenchBrowserController(requireBrowserOwner(event))
    const epoch = controller.stageLayout(checked)
    if (epoch === undefined) return
    return executeNative(deps.nativeActions, event, NativeActionKind.window, "workbench-browser-layout", {
      scopeDigest: browserInputDigest(checked.scope), pageID: checked.pageID,
      sequence: checked.sequence, bounds: checked.bounds,
    }, () => {
      requireBrowserOwner(event)
      controller.commitLayout(checked, epoch)
    })
  })

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (event: IpcMainInvokeEvent, url: string | null) => {
    const checked = requireNativeUrl(url)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.filesystem,
      "set-default-server-url",
      { url: checked },
      () => deps.setDefaultServerUrl(checked),
    )
  })
  ipcMain.handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  ipcMain.handle("finish-first-launch-onboarding", (event: IpcMainInvokeEvent, createDefaultProject: boolean) => {
    const checked = requireNativeBoolean("createDefaultProject", createDefaultProject)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.filesystem,
      "finish-first-launch-onboarding",
      { createDefaultProject: checked },
      () => deps.finishFirstLaunchOnboarding(checked),
    )
  })
  ipcMain.handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("get-rendering-mode", () => deps.getRenderingMode?.() ?? "hardware")
  ipcMain.handle("set-display-backend", (event: IpcMainInvokeEvent, backend: string | null) => {
    const checked = requireNativeNullableString("display backend", backend, 32)
    if (checked !== null && checked !== "auto" && checked !== "wayland") throw new TypeError("Invalid display backend")
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.window,
      "set-display-backend",
      { backend: checked },
      () => deps.setDisplayBackend(checked),
    )
  })
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", (event: IpcMainInvokeEvent) =>
    executeNative(deps.nativeActions, event, NativeActionKind.process, "updater-install", {}, () =>
      deps.updater.install(),
    ),
  )
  ipcMain.handle("set-background-color", (event: IpcMainInvokeEvent, color: string) => {
    const checked = requireNativeString("background color", color, 64)
    if (!/^#[0-9a-f]{6,8}$/i.test(checked)) throw new TypeError("Invalid background color")
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.window,
      "set-background-color",
      { color: checked },
      () => deps.setBackgroundColor(checked),
    )
  })
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) => {
    const checked = requireNativeBoolean("enabled", enabled)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.window,
      "set-force-focus",
      { enabled: checked },
      () => setForceFocus(event.sender, checked),
    )
  })
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    const checkedName = requireNativeStorePart("store name", name)
    const checkedKey = requireNativeStorePart("store key", key)
    const checkedValue = requireNativeStoreValue(value)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.filesystem,
      "store-set",
      { name: checkedName, key: checkedKey, value: checkedValue },
      () =>
        storeMutations.run(checkedName, () => {
          getStore(checkedName).set(checkedKey, checkedValue)
        }),
    )
  })
  ipcMain.handle("store-delete", (event: IpcMainInvokeEvent, name: string, key: string) => {
    const checkedName = requireNativeStorePart("store name", name)
    const checkedKey = requireNativeStorePart("store key", key)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.filesystem,
      "store-delete",
      { name: checkedName, key: checkedKey },
      () =>
        storeMutations.run(checkedName, async () => {
          getStore(checkedName).delete(checkedKey)
          await removeStoreFileIfEmpty(checkedName)
        }),
    )
  })
  ipcMain.handle("store-clear", (event: IpcMainInvokeEvent, name: string) => {
    const checkedName = requireNativeStorePart("store name", name)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.filesystem,
      "store-clear",
      { name: checkedName },
      () =>
        storeMutations.run(checkedName, async () => {
          getStore(checkedName).clear()
          await removeStoreFileIfEmpty(checkedName)
        }),
    )
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const checked = requireNativeDirectoryPickerOptions(opts)
      return executeNative(
        deps.nativeActions,
        event,
        NativeActionKind.filesystem,
        "open-directory-picker",
        checked,
        async () => {
          const result = await dialog.showOpenDialog({
            properties: ["openDirectory", ...(checked.multiple ? ["multiSelections" as const] : []), "createDirectory"],
            title: checked.title ?? "Choose a folder",
            defaultPath: checked.defaultPath,
          })
          if (result.canceled) return null
          return checked.multiple ? result.filePaths : result.filePaths[0]
        },
      )
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (event: IpcMainEvent, url: string) => {
    const checked = requireNativeString("URL", url, 8192)
    let parsed: URL
    try {
      parsed = new URL(checked)
    } catch {
      return
    }
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol) || parsed.username || parsed.password) return
    void executeNative(deps.nativeActions, event, NativeActionKind.process, "open-link", { url: checked }, () =>
      shell.openExternal(checked),
    ).catch(() => undefined)
  })

  ipcMain.handle("open-path", async (event: IpcMainInvokeEvent, path: string, app?: string) => {
    const checkedPath = requireNativeString("path", path, 32 * 1024)
    const checkedApp = app === undefined ? undefined : requireNativeString("app", app, 512)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.process,
      "open-path",
      { path: checkedPath, app: checkedApp ?? null },
      async () => {
        if (!checkedApp) return shell.openPath(checkedPath)
        await new Promise<void>((resolve, reject) => {
          const [cmd, args] =
            process.platform === "darwin"
              ? (["open", ["-a", checkedApp, checkedPath]] as const)
              : ([checkedApp, [checkedPath]] as const)
          execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
        })
        return undefined
      },
    )
  })

  ipcMain.handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    const checkedPath = requireNativeString("path", path, 32 * 1024)
    const exists = await stat(checkedPath).then(
      () => true,
      () => false,
    )
    if (!exists) return false
    shell.showItemInFolder(checkedPath)
    return true
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (event: IpcMainEvent, title: string, body?: string) => {
    const checkedTitle = requireNativeString("notification title", title, 512)
    const checkedBody = body === undefined ? undefined : requireNativeString("notification body", body, 4096)
    void executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.notification,
      "show-notification",
      { title: checkedTitle, body: checkedBody ?? null },
      () => {
        new Notification({ title: checkedTitle, body: checkedBody }).show()
      },
    ).catch(() => undefined)
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return executeNative(deps.nativeActions, event, NativeActionKind.window, "set-window-focus", {}, () => win?.focus())
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return executeNative(deps.nativeActions, event, NativeActionKind.window, "show-window", {}, () => win?.show())
  })

  ipcMain.on("relaunch", (event: IpcMainEvent) => {
    void executeNative(deps.nativeActions, event, NativeActionKind.process, "relaunch", {}, () =>
      deps.relaunch(),
    ).catch(() => undefined)
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    const checked = requireNativeFiniteNumber("zoom factor", factor, 0.2, 10)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.window,
      "set-zoom-factor",
      { factor: checked },
      () => {
        event.sender.setZoomFactor(checked)
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win) updateTitlebar(win)
      },
    )
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (event: IpcMainInvokeEvent, enabled: boolean) => {
    const checked = requireNativeBoolean("enabled", enabled)
    return executeNative(
      deps.nativeActions,
      event,
      NativeActionKind.window,
      "set-pinch-zoom-enabled",
      { enabled: checked },
      () => setPinchZoomEnabled(checked),
    )
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return Promise.resolve(undefined)
    const payload = requireNativePayload(theme)
    const mode = payload.mode
    const scheme = payload.scheme
    if (mode !== "light" && mode !== "dark") throw new TypeError("Invalid titlebar mode")
    if (scheme !== undefined && scheme !== "system" && scheme !== "light" && scheme !== "dark")
      throw new TypeError("Invalid titlebar scheme")
    const checked = { mode, ...(scheme === undefined ? {} : { scheme }) }
    return executeNative(deps.nativeActions, event, NativeActionKind.window, "set-titlebar", checked, () =>
      setTitlebar(win, checked),
    )
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    const checked = requireNativeDesktopMenuAction(action)
    return executeNative(
      deps.nativeActions,
      event,
      nativeKindForDesktopMenuAction(checked),
      "run-desktop-menu-action",
      { action: checked },
      () =>
        runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), checked, {
          relaunch: deps.relaunch,
        }),
    )
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
