import { randomUUID } from "node:crypto"
import { BrowserWindow, Menu, dialog, session } from "electron"
import { normalizeWorkbenchBrowserUrl, requireWorkbenchBrowserOrigin, workbenchBrowserPreferences } from "./browser-policy"
import { workbenchBrowserStartPage } from "./browser-start-page"

const windows = new Map<number, BrowserWindow>()

export function createWorkbenchBrowserWindow(
  owner: BrowserWindow,
  options: { show?: boolean; onNotice?: (message: string) => void } = {},
) {
  if (owner.isDestroyed()) throw new Error("Browser owner has been closed")
  const existing = windows.get(owner.id)
  if (existing && !existing.isDestroyed()) {
    if (options.show !== false) { existing.show(); existing.focus() }
    return existing
  }

  const partition = `arforge-browser-${randomUUID()}`
  const isolated = session.fromPartition(partition, { cache: false })
  isolated.setPermissionCheckHandler(() => false)
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setDevicePermissionHandler(() => false)
  const win = new BrowserWindow({
    parent: owner,
    title: "Arforge Browser",
    width: 1100,
    height: 780,
    minWidth: 420,
    minHeight: 420,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: "#f4f5f6",
    webPreferences: workbenchBrowserPreferences(partition),
  })
  windows.set(owner.id, win)
  const contents = win.webContents
  const home = `data:text/html;charset=utf-8,${encodeURIComponent(workbenchBrowserStartPage(randomUUID().replaceAll("-", "")))}`
  const allowedOrigins = new Set<string>()
  let showingNotice = false
  const notice = (message: string) => {
    if (win.isDestroyed()) return
    if (options.onNotice) { options.onNotice(message); return }
    if (showingNotice) return
    showingNotice = true
    void dialog.showMessageBox(win, {
      type: "warning", title: "Arforge Browser", message: "Browser request blocked or failed", detail: message,
      buttons: ["OK"], noLink: true,
    }).catch(() => undefined).finally(() => { showingNotice = false })
  }
  const openAddress = () => {
    if (win.isDestroyed()) return
    void contents.loadURL(home).catch((error: unknown) => notice(String(error)))
  }
  const updateTitle = () => {
    if (win.isDestroyed()) return
    const value = contents.getURL()
    if (!value || value === home) { win.setTitle("Arforge Browser"); return }
    try {
      const url = new URL(value)
      win.setTitle(`Arforge Browser | ${url.host}${url.pathname.slice(0, 160)}`)
    } catch { win.setTitle("Arforge Browser") }
  }

  // Only the trusted start page may extend the explicit top-level origin scope.
  contents.on("will-navigate", (event, value) => {
    if (value === home) return
    try {
      const url = normalizeWorkbenchBrowserUrl(value)
      if (contents.getURL() === home) allowedOrigins.add(new URL(url).origin)
      else requireWorkbenchBrowserOrigin(url, allowedOrigins)
    } catch (error) { event.preventDefault(); notice(String(error)) }
  })
  contents.on("will-redirect", (event, value, _inPlace, isMainFrame) => {
    try {
      if (isMainFrame) requireWorkbenchBrowserOrigin(value, allowedOrigins)
      else normalizeWorkbenchBrowserUrl(value)
    } catch (error) { event.preventDefault(); notice(String(error)) }
  })
  // loadURL/history do not emit will-navigate. Enforce the same boundary at request time.
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (details.url === home && details.resourceType === "mainFrame") { callback({ cancel: false }); return }
    try {
      if (details.resourceType === "mainFrame") requireWorkbenchBrowserOrigin(details.url, allowedOrigins)
      else normalizeWorkbenchBrowserUrl(details.url)
      callback({ cancel: false })
    } catch (error) {
      callback({ cancel: true })
      if (details.resourceType === "mainFrame") notice(String(error))
    }
  })
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  contents.on("will-attach-webview", (event) => event.preventDefault())
  contents.on("will-prevent-unload", (event) => event.preventDefault())
  contents.on("page-title-updated", (event) => { event.preventDefault(); updateTitle() })
  contents.on("did-navigate", updateTitle)
  contents.on("did-navigate-in-page", updateTitle)
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) notice(`Page load failed (${code}): ${description}`)
  })
  const denyDownload = (event: Electron.Event) => { event.preventDefault(); notice("Downloads are not enabled in this browser.") }
  isolated.on("will-download", denyDownload)

  win.setMenu(Menu.buildFromTemplate([
    { label: "Browser", submenu: [
      { label: "Address...", accelerator: "CmdOrCtrl+L", click: openAddress },
      { label: "Back", accelerator: "Alt+Left", click: () => {
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
      } },
      { label: "Forward", accelerator: "Alt+Right", click: () => {
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
      } },
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => contents.reload() },
      { label: "Stop", accelerator: "Esc", click: () => contents.stop() },
      { type: "separator" },
      { label: "Close", accelerator: "CmdOrCtrl+W", click: () => win.close() },
    ] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
  ]))
  // Native keyboard handling also keeps controls available on platforms without per-window menus.
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return
    const modifier = process.platform === "darwin" ? input.meta : input.control
    if (modifier && input.key.toLowerCase() === "l") { event.preventDefault(); openAddress() }
    if (modifier && input.key.toLowerCase() === "r") { event.preventDefault(); contents.reload() }
    if (modifier && input.key.toLowerCase() === "w") { event.preventDefault(); win.close() }
  })

  const closeWithOwner = () => { if (!win.isDestroyed()) win.destroy() }
  owner.once("closed", closeWithOwner)
  win.once("closed", () => {
    windows.delete(owner.id)
    owner.removeListener("closed", closeWithOwner)
    isolated.webRequest.onBeforeRequest(null)
    isolated.removeListener("will-download", denyDownload)
    void isolated.clearStorageData().catch(() => undefined)
  })
  win.once("ready-to-show", () => { if (options.show !== false && !win.isDestroyed()) win.show() })
  openAddress()
  return win
}
