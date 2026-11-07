import windowState from "electron-window-state"
import { setWorkbenchBrowserAppearance } from "./browser-appearance"
import { resolveThemeVariant } from "@arforge-ai/ui/theme/resolve"
import type { DesktopTheme } from "@arforge-ai/ui/theme/types"
import arforgeDefaultThemeJson from "../../../ui/src/theme/themes/arforge-default.json"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { app, BrowserWindow, dialog, net, nativeImage, nativeTheme, protocol } from "electron"
import type { IpcMainEvent, Session, WebContents } from "electron"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { APP_IDS, CHANNEL } from "./constants"
import { exportDebugLogs, write as writeLog } from "./logging"
import { getStore, removeStoreFile } from "./store"
import { PINCH_ZOOM_ENABLED_KEY, WINDOW_IDS_KEY } from "./store-keys"
import { createUnresponsiveSampler } from "./unresponsive"
import { createWindowRegistry } from "./window-registry"
import { safeWindowURL } from "./window-state"
import { redactPreviewResourceURLs } from "./preview-resource-url"
import { resolveRelaunchOptions } from "./relaunch"
import { shouldServeRendererShell } from "./renderer-route"
import { documentPolicyHeader, jsCallStacksDocumentPolicy, withRendererDocumentPolicy } from "./renderer-security"
import { windowRecoveryCopy, type WindowRecoveryAction } from "./window-recovery-copy"
import { observeWorkbenchBrowserOwnerZoom } from "./browser-owner-zoom"
import { createClosePreparation } from "./close-preparation"

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
const rendererProtocol = "arforge"
const rendererHost = "renderer"
const clipboardWritePermission = "clipboard-sanitized-write"
const notificationPermission = "notifications"
const rendererPermissions = new Set([clipboardWritePermission, notificationPermission, "fullscreen"])
const arforgeDefaultTheme = arforgeDefaultThemeJson as DesktopTheme
const defaultBackground = {
  light: resolveThemeVariant(arforgeDefaultTheme.light, false)["background-base"],
  dark: resolveThemeVariant(arforgeDefaultTheme.dark, true)["background-base"],
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

let backgroundColor: string | undefined
let relaunchHandler = () => {
  setAppQuitting()
  app.relaunch(
    resolveRelaunchOptions({
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      argv: process.argv,
      devHostExecPath: process.env.ARFORGE_DESKTOP_DEV_HOST_EXEC_PATH,
    }),
  )
  app.exit(0)
}
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
const titlebarOverlayWindows = new WeakSet<BrowserWindow>()
const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()
const windowIDs = new WeakMap<BrowserWindow, string>()
const closePreparations = new Map<BrowserWindow, ReturnType<typeof createClosePreparation>>()
const closeDialogs = new WeakSet<BrowserWindow>()
const closeWithoutWaiting = new WeakSet<BrowserWindow>()
let preparingWindowGroup = false
const rendererPermissionSessions = new WeakSet<Session>()
const registry = createWindowRegistry<BrowserWindow>({
  read: () => getStore().get(WINDOW_IDS_KEY),
  write: (ids) => getStore().set(WINDOW_IDS_KEY, ids),
  cleanup: (id) => {
    rmSync(join(app.getPath("userData"), windowStateFile(id)), { force: true })
    removeStoreFile(windowDataFile(id))
  },
})
const titlebarHeight = 44
const maxZoomLevel = 10
const minZoomLevel = 0.2

export function setRelaunchHandler(handler: () => void) {
  relaunchHandler = handler
}

export function setAppQuitting(quitting = true) {
  registry.setQuitting(quitting)
}

export function setBackgroundColor(color: string) {
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => {
    win.setBackgroundColor(color)
    if (process.platform === "darwin") win.invalidateShadow()
  })
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

function windowIcon() {
  const path = iconPath()
  const icon = nativeImage.createFromPath(path)
  if (icon.isEmpty()) throw new Error(`Arforge window icon is missing or invalid: ${path}`)
  return icon
}

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function defaultBackgroundColor() {
  return defaultBackground[tone()]
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: mode === "dark" ? "white" : "black",
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  titlebarThemes.set(win, theme)
  setWorkbenchBrowserAppearance(win, { mode: theme.mode ?? tone(), locale: theme.locale })
  // macOS draws the window frame hairline and shadow using the NSWindow
  // appearance, which follows nativeTheme rather than the rendered content.
  // Align it with the app theme so a light app on a dark system does not get
  // the dark-appearance border and shadow. A "system" scheme must map to
  // "system" (not the resolved mode) or prefers-color-scheme stops tracking
  // OS appearance changes in the renderer.
  if (process.platform === "darwin") nativeTheme.themeSource = theme.scheme ?? theme.mode ?? "system"
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  // Only windows created with titleBarOverlay have this native capability.
  if (process.platform !== "win32" || !titlebarOverlayWindows.has(win)) return
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  for (const win of BrowserWindow.getAllWindows()) {
    pinchZoomEnabled.set(win, enabled)
    win.webContents.send("pinch-zoom-enabled-changed", enabled)
    if (!enabled && win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  }
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

export function getWindowID(win: BrowserWindow) {
  return windowIDs.get(win)
}

export function hasMainWindows() {
  return [...closePreparations.keys()].some((win) => !win.isDestroyed())
}

function closePreparationOwner(event: IpcMainEvent) {
  if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.webContents !== event.sender || !getWindowID(win)) return
  return closePreparations.get(win)
}

export function rendererPersistenceReady(event: IpcMainEvent) {
  closePreparationOwner(event)?.resend()
}

export function acknowledgeWindowClose(event: IpcMainEvent, value: unknown) {
  if (!value || typeof value !== "object" || !("requestID" in value) || !("ok" in value)) return
  if (typeof value.requestID !== "string" || value.requestID.length > 128 || typeof value.ok !== "boolean") return
  closePreparationOwner(event)?.acknowledge({ requestID: value.requestID, ok: value.ok })
}

function reportCloseFailure(win: BrowserWindow, unsaved = false) {
  if (win.isDestroyed() || closeDialogs.has(win)) return
  closeDialogs.add(win)
  const locale = (titlebarThemes.get(win)?.locale ?? app.getLocale()).toLowerCase()
  const traditional = /zh-(tw|hk|hant)/.test(locale)
  const zh = locale.startsWith("zh")
  const title = unsaved
    ? traditional
      ? "有未儲存的檔案"
      : zh
        ? "有未保存的文件"
        : "Files have unsaved changes"
    : traditional
      ? "暫時無法關閉"
      : zh
        ? "暂时无法关闭"
        : "Unable to close yet"
  const message = unsaved
    ? traditional
      ? "請先儲存或放棄檔案修改，再關閉 Arforge。"
      : zh
        ? "请先保存或放弃文件修改，再关闭 Arforge。"
        : "Save or discard your file changes before closing Arforge."
    : traditional
      ? "視窗狀態尚未儲存完成。內容已保留，請稍後重試關閉。"
      : zh
        ? "窗口状态尚未保存完成。内容已保留，请稍后重试关闭。"
        : "Window state has not finished saving. Your window remains open; retry closing after saving."
  const keep = traditional ? "保留視窗" : zh ? "保留窗口" : "Keep window open"
  const close = traditional ? "關閉，不再等待儲存" : zh ? "关闭，不再等待保存" : "Close without waiting"
  const detail = traditional
    ? "未完成儲存的內容可能遺失。"
    : zh
      ? "未完成保存的内容可能丢失。"
      : "Changes that have not finished saving may be lost."
  void dialog
    .showMessageBox(win, {
      type: "warning",
      title,
      message,
      detail: unsaved ? undefined : detail,
      buttons: unsaved ? [traditional ? "知道了" : zh ? "知道了" : "OK"] : [keep, close],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    })
    .then((result) => {
      if (unsaved || result.response !== 1 || win.isDestroyed()) return
      closePreparations.get(win)?.cancel()
      closeWithoutWaiting.add(win)
      closeDialogs.delete(win)
      win.close()
    })
    .catch(() => undefined)
    .finally(() => closeDialogs.delete(win))
}

/** Prepare every main window before allowing any of them to close for Quit. */
export async function closeMainWindowsForQuit() {
  const windows = [...closePreparations.keys()].filter((win) => !win.isDestroyed())
  let failureOwner: BrowserWindow | undefined
  preparingWindowGroup = true
  try {
    await Promise.all(
      windows.map(async (win) => {
        try {
          await closePreparations.get(win)?.prepare()
        } catch (error) {
          failureOwner ??= win
          throw error
        }
      }),
    )
    for (const win of windows) {
      if (win.isDestroyed()) continue
      const closed = await new Promise<boolean>((resolve, reject) => {
        const contents = win.webContents
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          win.off("closed", onClosed)
          win.off("close", onClose)
          contents.off("will-prevent-unload", onCancelled)
        }
        const onClosed = () => {
          cleanup()
          resolve(true)
        }
        const onCancelled = () => {
          cleanup()
          resolve(false)
        }
        const onClose = (event: { defaultPrevented: boolean }) => {
          queueMicrotask(() => {
            if (event.defaultPrevented) onCancelled()
          })
        }
        win.once("closed", onClosed)
        win.on("close", onClose)
        contents.once("will-prevent-unload", onCancelled)
        timer = setTimeout(() => {
          cleanup()
          reject(new Error("Window close did not finish"))
        }, 10_000)
        try {
          win.close()
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
      if (!closed) return false
    }
    return !hasMainWindows()
  } catch (error) {
    const owner = failureOwner && !failureOwner.isDestroyed() ? failureOwner : windows.find((win) => !win.isDestroyed())
    if (owner) reportCloseFailure(owner)
    throw error
  } finally {
    preparingWindowGroup = false
    for (const win of windows) {
      if (!win.isDestroyed()) closePreparations.get(win)?.cancel()
    }
  }
}

export function getLastFocusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) return focused
  const win = registry.lastFocused()
  if (!win || win.isDestroyed()) return null
  return win
}

export function restoreMainWindows() {
  const ids = registry.persisted()
  return (ids.length ? ids : [randomUUID()]).map((id) => createMainWindow(id))
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function createMainWindow(id: string = randomUUID()) {
  const state = windowState({
    file: windowStateFile(id),
    defaultWidth: 1280,
    defaultHeight: 800,
  })

  const mode = tone()
  const icon = windowIcon()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    autoHideMenuBar: true,
    title: "Arforge",
    icon,
    backgroundColor: backgroundColor ?? defaultBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 14, y: 15 },
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
          backgroundMaterial: "mica" as const,
          roundedCorners: true,
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (process.platform === "win32") {
    titlebarOverlayWindows.add(win)
    win.setIcon(icon)
    win.setAppDetails({
      appId: app.isPackaged ? APP_IDS[CHANNEL] : APP_IDS.dev,
      appIconPath: iconPath(),
      appIconIndex: 0,
    })
  } else if (process.platform === "linux") {
    win.setIcon(icon)
  }

  allowRendererPermissions(win)
  wireWindowRecovery(win, id)

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const { responseHeaders = {} } = details
    addRendererHeaders(details.url, responseHeaders)
    callback({ responseHeaders })
  })

  state.manage(win)
  registerWindow(win, id)
  if (process.platform === "win32") {
    // The Windows menu is rendered by the App; its accelerator label does not register a native shortcut.
    win.webContents.on("before-input-event", (event, input) => {
      if (
        win.isDestroyed() ||
        win.webContents.isDestroyed() ||
        input.type !== "keyDown" ||
        input.isAutoRepeat ||
        input.isComposing ||
        !input.control ||
        !input.shift ||
        input.alt ||
        input.meta ||
        input.key.toLowerCase() !== "n"
      )
        return
      event.preventDefault()
      createMainWindow()
    })
  }
  loadWindow(win, "index.html")
  wireZoom(win)

  win.once("ready-to-show", () => {
    win.show()
  })

  return win
}

function registerWindow(win: BrowserWindow, id: string) {
  windowIDs.set(win, id)
  registry.register(id, win)
  const preparation = createClosePreparation({
    createID: randomUUID,
    request: (requestID) => win.webContents.send("prepare-window-close", requestID),
    blockInput: () => {
      const enabled = win.isEnabled()
      win.setEnabled(false)
      return () => {
        if (!win.isDestroyed()) win.setEnabled(enabled)
      }
    },
  })
  closePreparations.set(win, preparation)
  win.on("close", (event) => {
    if (preparation.ready || closeWithoutWaiting.has(win)) {
      closeWithoutWaiting.delete(win)
      queueMicrotask(() => {
        if (event.defaultPrevented) {
          preparation.cancel()
          setAppQuitting(false)
        }
      })
      return
    }
    event.preventDefault()
    void preparation
      .prepare()
      .then(() => {
        if (!preparingWindowGroup && !win.isDestroyed()) win.close()
      })
      .catch(() => reportCloseFailure(win))
  })
  win.webContents.on("will-prevent-unload", () => {
    preparation.cancel()
    setAppQuitting(false)
    reportCloseFailure(win, true)
  })
  win.on("closed", () => {
    preparation.cancel()
    closePreparations.delete(win)
  })

  win.on("focus", () => registry.focused(id))
  // Windows never emits before-quit on OS shutdown/logoff, but each window
  // gets session-end before it closes; flag the quit so ids stay persisted.
  win.on("session-end", () => registry.setQuitting())
  win.on("closed", () => registry.closed(id))
}

function windowStateFile(id: string) {
  return `window-state-${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
}

// Mirrors windowStorage() in packages/app/src/utils/persist.ts, which names
// the per-window renderer store this window persists its tabs into.
function windowDataFile(id: string) {
  return `arforge.window.${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.dat`
}

export function registerRendererProtocol() {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    const url = new URL(request.url)
    if (url.host !== rendererHost) {
      writeLog("protocol", "rejected host", { url: request.url }, "warn")
      return new Response("Not found", { status: 404 })
    }

    const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    const rel = relative(rendererRoot, file)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      writeLog("protocol", "rejected path", { url: request.url, file }, "warn")
      return new Response("Not found", { status: 404 })
    }

    const range = request.headers.get("range")
    const candidates = shouldServeRendererShell({ method: request.method, pathname: url.pathname, range })
      ? [file, join(rendererRoot, "index.html")]
      : [file]
    let failure: unknown
    for (const candidate of candidates) {
      try {
        const response = await net.fetch(pathToFileURL(candidate).toString(), {
          headers: range ? { range } : undefined,
        })
        if (response.status < 400) {
          if (candidate !== file) writeLog("protocol", "served renderer shell for navigation", { url: request.url })
          return withRendererDocumentPolicy(response, candidate)
        }
        failure = { status: response.status, statusText: response.statusText }
      } catch (error) {
        failure = error
      }
    }
    writeLog("protocol", "fetch failed", { url: request.url, file, error: failure }, "error")
    return new Response("Not found", { status: 404 })
  })
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

function wireWindowRecovery(win: BrowserWindow, name: string) {
  let showing = false
  const sampler = createUnresponsiveSampler(win, name)
  const copy = windowRecoveryCopy(app.getLocale())

  const handle = async (action: WindowRecoveryAction | undefined, wait: boolean) => {
    if (action === "export_logs") {
      const sampling = sampler.stopAndFlush()
      await exportDebugLogs().catch((error) => writeLog("main", "failed to export debug logs", { error }, "error"))
      if (wait && sampling) sampler.start()
      return true
    }
    if (action === "relaunch") {
      sampler.stopAndFlush()
      relaunchHandler()
      return false
    }
    if (action === "quit") {
      sampler.stopAndFlush()
      app.quit()
    }
    return false
  }

  const show = async (message: string, detail: string, wait: boolean) => {
    if (showing || win.isDestroyed()) return
    showing = true
    try {
      while (!win.isDestroyed()) {
        const actions: WindowRecoveryAction[] = wait
          ? ["relaunch", "export_logs", "keep_waiting"]
          : ["relaunch", "export_logs", "quit"]
        const buttons = actions.map((action) => copy.actions[action])
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons,
          defaultId: 0,
          cancelId: 2,
          message,
          detail,
        })
        if (await handle(actions[result.response], wait)) continue
        return
      }
    } finally {
      showing = false
    }
  }

  const failed = (
    event: string,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    writeLog(
      "window",
      "renderer load failed",
      {
        window: name,
        event,
        errorCode,
        errorDescription,
        validatedURL: redactPreviewResourceURLs(validatedURL),
        currentURL: safeWindowURL(win),
        isMainFrame,
      },
      "error",
    )

    if (!isMainFrame || errorCode === -3) return
    void show(
      copy.loadFailed,
      [
        `${copy.window}: ${name}`,
        `${copy.url}: ${validatedURL}`,
        `${copy.error}: ${errorCode} ${errorDescription}`,
      ].join("\n"),
      false,
    )
  }

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-provisional-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    sampler.stopAndFlush()
    writeLog("window", "renderer process gone", { window: name, currentURL: safeWindowURL(win), details }, "error")
    void show(
      copy.terminated,
      [
        `${copy.window}: ${name}`,
        `${copy.reason}: ${details.reason}`,
        `${copy.code}: ${details.exitCode ?? copy.unknown}`,
      ].join("\n"),
      false,
    )
  })
  win.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { window: name, currentURL: safeWindowURL(win) }, "error")
    sampler.start()
    void show(copy.unresponsive, copy.unresponsiveDetail, true)
  })
  win.on("responsive", () => {
    writeLog("window", "renderer responsive", { window: name, currentURL: safeWindowURL(win) }, "error")
    sampler.stopAndFlush()
  })
  win.webContents.on("console-message", (event) => {
    const { level, message, lineNumber: line, sourceId } = event
    if (message.toLowerCase().includes("terminal") || sourceId.toLowerCase().includes("terminal")) {
      writeLog("pty", "console", {
        window: name,
        level,
        message: redactPreviewResourceURLs(message),
        line,
        sourceId: redactPreviewResourceURLs(sourceId),
      })
    }
  })
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    writeLog("preload", "preload error", { window: name, preloadPath, error }, "error")
  })
}

function allowRendererPermissions(win: BrowserWindow) {
  const session = win.webContents.session
  if (rendererPermissionSessions.has(session)) return
  rendererPermissionSessions.add(session)

  // Permission handlers belong to the shared Session, not the last window
  // that installed them. Resolve the current registered main-frame owner.
  const ownsRenderer = (contents: WebContents | null) => {
    if (!contents) return false
    const owner = BrowserWindow.fromWebContents(contents)
    return (
      !!owner &&
      windowIDs.has(owner) &&
      !owner.isDestroyed() &&
      !contents.isDestroyed() &&
      owner.webContents === contents &&
      contents.session === session
    )
  }

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissions.has(permission) &&
        (permission !== "fullscreen" || details.isMainFrame) &&
        isTrustedRendererUrl(details.requestingUrl) &&
        ownsRenderer(webContents),
    )
  })
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!rendererPermissions.has(permission)) return false
    if (permission === "fullscreen" && (!webContents || !details.isMainFrame)) return false
    if (webContents && !ownsRenderer(webContents)) return false
    return isTrustedRendererUrl(details.requestingUrl) || isTrustedRendererUrl(requestingOrigin)
  })
}

function isTrustedRendererUrl(value?: string) {
  return isRendererUrl(value)
}

function addRendererHeaders(value: string, headers: Record<string, any>) {
  if (!isRendererUrl(value)) return
  upsertKeyValue(headers, "Access-Control-Allow-Origin", ["*"])
  upsertKeyValue(headers, "Access-Control-Allow-Headers", ["*"])
  if (isRendererUrl(value, true)) upsertKeyValue(headers, documentPolicyHeader, [jsCallStacksDocumentPolicy])
}

function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}

function wireZoom(win: BrowserWindow) {
  observeWorkbenchBrowserOwnerZoom(win)
  pinchZoomEnabled.set(win, getPinchZoomEnabled())
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", (event, zoomDirection) => {
    event.preventDefault()
    if (pinchZoomEnabled.get(win)) {
      win.webContents.setZoomFactor(clampZoom(win.webContents.getZoomFactor() + (zoomDirection === "in" ? 0.2 : -0.2)))
      updateZoom(win)
      return
    }
    if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  })
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  win.webContents.send("zoom-factor-changed", win.webContents.getZoomFactor())
}

function upsertKeyValue(obj: Record<string, any>, keyToChange: string, value: any) {
  const keyToChangeLower = keyToChange.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === keyToChangeLower) {
      // Reassign old key
      obj[key] = value
      // Done
      return
    }
  }
  // Insert at end instead
  obj[keyToChange] = value
}
