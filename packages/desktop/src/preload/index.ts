import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron"
import type { ElectronAPI, TitlebarTheme, WslServersEvent } from "./types"
import { observeBrowserAppearance } from "./browser-appearance"
import { createDesktopStoreWriter } from "./store-write"
import { createPersistenceDrain } from "../shared/persistence-drain"
import { captureBrowserLayout, readBrowserViewport } from "./browser-layout"
import type { UpdaterState } from "@arforge-ai/app/updater"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
const closePreparations = new Set<() => Promise<void>>()
const preparingClose = new Set<string>()
const storeDrain = createPersistenceDrain()
const storeNamespace = (name: string) => JSON.stringify(name) + ":"
const storeKey = (name: string, key: string) => storeNamespace(name) + JSON.stringify(["key", key])
const writeStore = createDesktopStoreWriter({
  set: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  begin: (name, key, length) => ipcRenderer.invoke("store-write-begin", name, key, length),
  chunk: (id, index, value) => ipcRenderer.invoke("store-write-chunk", id, index, value),
  commit: (id) => ipcRenderer.invoke("store-write-commit", id),
  abort: (id) => ipcRenderer.invoke("store-write-abort", id),
})
ipcRenderer.on("prepare-window-close", (_event: unknown, requestID: unknown) => {
  if (
    typeof requestID !== "string" ||
    requestID.length === 0 ||
    requestID.length > 128 ||
    preparingClose.has(requestID)
  )
    return
  preparingClose.add(requestID)
  void Promise.resolve()
    .then(async () => {
      await Promise.all([...closePreparations].map((prepare) => prepare()))
      await storeDrain.flush()
      ipcRenderer.send("window-close-prepared", { requestID, ok: true })
    })
    .catch(() =>
      ipcRenderer.send("window-close-prepared", {
        requestID,
        ok: false,
        error: "Unable to finish saving window state",
      }),
    )
    .finally(() => preparingClose.delete(requestID))
})
let lastTitlebarTheme: TitlebarTheme | undefined
let browserLayoutSequence = 0
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const api: ElectronAPI = {
  browserWorkbench: {
    open: (scope) => ipcRenderer.invoke("workbench-browser", { action: "open", scope }),
    command: (scope, pageID, command) => ipcRenderer.invoke("workbench-browser", { ...command, scope, pageID }),
    close: (scope, pageID) => ipcRenderer.invoke("workbench-browser", { action: "close", scope, pageID }),
    layout: (scope, pageID, bounds) =>
      ipcRenderer.invoke(
        "workbench-browser-layout",
        captureBrowserLayout(scope, pageID, bounds, ++browserLayoutSequence, () =>
          readBrowserViewport(window.visualViewport, webFrame.getZoomFactor()),
        ),
      ),
    subscribe: (callback) => {
      const handler = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state)
      ipcRenderer.on("workbench-browser-state", handler)
      return () => ipcRenderer.removeListener("workbench-browser-state", handler)
    },
  },
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeAddable: (distros) => ipcRenderer.invoke("wsl-servers-probe-addable", distros),
    installArforge: (name) => ipcRenderer.invoke("wsl-servers-install-arforge", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  isFirstLaunchOnboardingPending: () => ipcRenderer.invoke("is-first-launch-onboarding-pending"),
  finishFirstLaunchOnboarding: (createDefaultProject) =>
    ipcRenderer.invoke("finish-first-launch-onboarding", createDefaultProject),
  isOldLayoutEligible: () => ipcRenderer.invoke("is-old-layout-eligible"),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  getRenderingMode: () => ipcRenderer.invoke("get-rendering-mode"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => storeDrain.track(storeKey(name, key), writeStore(name, key, value)),
  storeDelete: (name, key) => storeDrain.track(storeKey(name, key), ipcRenderer.invoke("store-delete", name, key)),
  storeClear: (name) =>
    storeDrain.track(storeNamespace(name) + "clear", ipcRenderer.invoke("store-clear", name), {
      clearsPrefix: storeNamespace(name),
    }),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),
  onPrepareClose: (callback) => {
    closePreparations.add(callback)
    return () => {
      closePreparations.delete(callback)
    }
  },

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  getWindowID: () => ipcRenderer.invoke("get-window-id"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },
  onNativeActionReceipt: (cb) => {
    const handler = (_: unknown, receipt: Parameters<typeof cb>[0]) => cb(receipt)
    ipcRenderer.on("native-action-receipt", handler)
    return () => ipcRenderer.removeListener("native-action-receipt", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  revealPath: (path) => ipcRenderer.invoke("reveal-path", path),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => {
    lastTitlebarTheme = theme
    return ipcRenderer.invoke("set-titlebar", {
      ...theme,
      locale: document.documentElement?.lang || "en",
    })
  },
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  setForceFocus: (enabled) => ipcRenderer.invoke("set-force-focus", enabled),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
}

contextBridge.exposeInMainWorld("api", api)

const stopAppearanceSync = observeBrowserAppearance((theme) => api.setTitlebar({ ...lastTitlebarTheme, ...theme }))
window.addEventListener("unload", stopAppearanceSync, { once: true })
ipcRenderer.send("window-persistence-ready")
