import { randomUUID } from "node:crypto"
import { BrowserWindow, WebContentsView, session, type WebContents } from "electron"
import type { BrowserLayoutRequest, BrowserPageCommand, BrowserPageState } from "@arforge-ai/app/browser-workbench"
import { BrowserLayoutOrder, clampBrowserBounds } from "./browser-embed-policy"
import { observeWorkbenchBrowserOwner } from "./browser-owner-lifecycle"
import { normalizeWorkbenchBrowserUrl, requireWorkbenchBrowserOrigin, workbenchBrowserPreferences } from "./browser-policy"

const home = "data:text/html;charset=utf-8," + encodeURIComponent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>:root{color-scheme:light dark}body{font:16px sans-serif;margin:32px;line-height:1.7}</style><p>\u8bf7\u5728\u4e0a\u65b9\u8f93\u5165\u7f51\u5740\u3002\u6b64\u9875\u9762\u4ec5\u4f9b\u4eba\u5de5\u6d4f\u89c8\uff0c\u4e0d\u4f1a\u53d1\u9001\u7ed9 AI\u3002</p>')
const controllers = new Map<number, WorkbenchBrowserController>()
type Page = {
  scope: string; pageID: string; revision: number; notice: string; navigation: number
  view: WebContentsView; contents: WebContents; origins: Set<string>; cleanup: () => void
}

export class WorkbenchBrowserController {
  private pages = new Map<string, Page>()
  private order = new BrowserLayoutOrder()
  private desired?: string
  private epoch = 0
  private disposed = false
  private ownerCleanup: () => void

  constructor(private owner: BrowserWindow, private emit: (state: BrowserPageState) => void = (state) => {
    if (!owner.webContents.isDestroyed()) owner.webContents.send("workbench-browser-state", state)
  }) {
    this.ownerCleanup = observeWorkbenchBrowserOwner(owner, {
      suspend: () => { this.epoch++; this.hideAll() },
      dispose: () => this.dispose(),
    })
  }

  private alive() {
    if (this.disposed || this.owner.isDestroyed()) throw new Error("\u6d4f\u89c8\u5668\u6240\u5c5e\u7a97\u53e3\u5df2\u5173\u95ed")
  }
  private page(scope: string, pageID: string) {
    this.alive()
    const page = this.pages.get(scope)
    if (!page || page.pageID !== pageID || page.contents.isDestroyed()) throw new Error("\u6b64\u4f1a\u8bdd\u7684\u7f51\u9875\u5df2\u5173\u95ed\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00")
    return page
  }
  private snapshot(page: Page): BrowserPageState {
    const contents = page.contents
    return {
      scope: page.scope, pageID: page.pageID, revision: page.revision,
      url: contents.getURL() === home ? "" : contents.getURL(),
      loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(), notice: page.notice,
    }
  }
  private current(page: Page) {
    // Reject a closed/replaced page before touching any native object.
    return !this.disposed && this.pages.get(page.scope) === page &&
      !this.owner.isDestroyed() && !page.contents.isDestroyed()
  }
  private publish(page: Page) {
    if (!this.current(page)) return
    page.revision++
    this.emit(this.snapshot(page))
  }
  private hideAll() {
    for (const page of this.pages.values()) {
      page.view.setVisible(false)
      if (!page.contents.isDestroyed()) page.contents.setAudioMuted(true)
    }
  }

  open(scope: string) {
    this.alive()
    const existing = this.pages.get(scope)
    if (existing && !existing.contents.isDestroyed()) return this.snapshot(existing)
    if (existing) this.close(scope, existing.pageID)
    if (this.pages.size >= 4) throw new Error("\u6700\u591a\u540c\u65f6\u4fdd\u7559 4 \u4e2a\u4f1a\u8bdd\u7f51\u9875\uff0c\u8bf7\u5148\u8fd4\u56de\u5176\u4ed6\u4f1a\u8bdd\u5173\u95ed\u4e0d\u518d\u4f7f\u7528\u7684\u9875\u9762")
    const partition = "arforge-browser-" + randomUUID()
    const isolated = session.fromPartition(partition, { cache: false })
    isolated.setPermissionCheckHandler(() => false)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setDevicePermissionHandler(() => false)
    const view = new WebContentsView({ webPreferences: workbenchBrowserPreferences(partition) })
    view.setVisible(false)
    const contents = view.webContents
    contents.setAudioMuted(true)
    const page: Page = { scope, pageID: randomUUID(), revision: 0, notice: "", navigation: 0, view, contents, origins: new Set(), cleanup: () => {} }
    this.pages.set(scope, page)
    const notice = (message: string) => {
      if (!this.current(page)) return
      page.notice = message
      this.publish(page)
    }
    const allowed = (value: string) => requireWorkbenchBrowserOrigin(value, page.origins)
    contents.on("will-navigate", (event, value) => {
      try { if (value !== home) allowed(value) }
      catch { event.preventDefault(); notice("\u6b64\u7f51\u9875\u6765\u6e90\u5c1a\u672a\u6388\u6743\uff0c\u8bf7\u5728\u5730\u5740\u680f\u660e\u786e\u8f93\u5165\u540e\u6253\u5f00") }
    })
    contents.on("will-redirect", (event, value, _inPlace, isMainFrame) => {
      try { if (isMainFrame) allowed(value); else normalizeWorkbenchBrowserUrl(value) }
      catch { event.preventDefault(); notice("\u5df2\u963b\u6b62\u8df3\u8f6c\u5230\u672a\u7ecf\u6388\u6743\u7684\u7f51\u9875\u6765\u6e90") }
    })
    isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      if (details.url === home && details.resourceType === "mainFrame") { callback({ cancel: false }); return }
      try {
        if (details.resourceType === "mainFrame") allowed(details.url)
        else normalizeWorkbenchBrowserUrl(details.url)
        callback({ cancel: false })
      } catch {
        callback({ cancel: true })
        if (details.resourceType === "mainFrame") notice("\u5df2\u963b\u6b62\u4e0d\u5b89\u5168\u7684\u5730\u5740\u6216\u672a\u7ecf\u6388\u6743\u7684\u7f51\u9875\u6765\u6e90")
      }
    })
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    contents.on("will-attach-webview", (event) => event.preventDefault())
    contents.on("will-prevent-unload", (event) => event.preventDefault())
    contents.on("did-fail-load", (_event, code, _description, _url, main) => {
      if (main && code !== -3) notice("\u7f51\u9875\u52a0\u8f7d\u5931\u8d25\uff08" + code + "\uff09\uff0c\u8bf7\u68c0\u67e5\u5730\u5740\u540e\u91cd\u8bd5")
    })
    contents.on("render-process-gone", () => notice("\u7f51\u9875\u8fdb\u7a0b\u5df2\u9000\u51fa\uff0c\u53ef\u70b9\u51fb\u5237\u65b0\u91cd\u8bd5"))
    contents.on("did-start-loading", () => this.publish(page))
    contents.on("did-stop-loading", () => this.publish(page))
    contents.on("did-navigate", () => this.publish(page))
    contents.on("did-navigate-in-page", () => this.publish(page))
    const download = (event: Electron.Event) => { event.preventDefault(); notice("\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u4e0b\u8f7d\uff0c\u5df2\u963b\u6b62\u6b64\u8bf7\u6c42") }
    isolated.on("will-download", download)
    page.cleanup = () => {
      isolated.webRequest.onBeforeRequest(null)
      isolated.removeListener("will-download", download)
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
      void isolated.clearStorageData().catch(() => undefined)
    }
    void contents.loadURL(home).catch(() => { if (page.navigation === 0) notice("\u6d4f\u89c8\u5668\u8d77\u59cb\u9875\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u5173\u95ed\u9875\u9762\u540e\u91cd\u65b0\u6253\u5f00") })
    return this.snapshot(page)
  }

  command(scope: string, pageID: string, command: BrowserPageCommand) {
    const page = this.page(scope, pageID)
    const contents = page.contents
    page.notice = ""
    const navigation = ++page.navigation
    if (command.action === "navigate") {
      const url = normalizeWorkbenchBrowserUrl(command.url)
      page.origins.add(new URL(url).origin)
      void contents.loadURL(url).catch(() => {
        if (this.current(page) && page.navigation === navigation && !page.notice) {
          page.notice = "\u7f51\u9875\u672a\u80fd\u52a0\u8f7d\uff0c\u8bf7\u68c0\u67e5\u5730\u5740\u6216\u7f51\u7edc\u540e\u91cd\u8bd5"
          this.publish(page)
        }
      })
    } else if (command.action === "back") {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    } else if (command.action === "forward") {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    } else if (command.action === "reload") contents.reload()
    else contents.stop()
    this.publish(page)
    return this.snapshot(page)
  }

  // Reserve before awaiting Core authorization so an older pending show cannot
  // overtake a newer hide/scope switch. Hiding is immediate and fail-closed.
  stageLayout(request: BrowserLayoutRequest): number | undefined {
    if (this.disposed) return
    const page = this.pages.get(request.scope)
    if (!page || page.pageID !== request.pageID) {
      if (request.bounds === null) return
      throw new Error("\u7f51\u9875\u72b6\u6001\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00")
    }
    if (request.bounds === null && this.desired !== request.pageID) return
    if (!this.order.reserve(request.sequence)) return
    this.desired = request.bounds === null ? undefined : request.pageID
    this.hideAll()
    return this.epoch
  }

  commitLayout(request: BrowserLayoutRequest, epoch: number) {
    if (this.disposed || epoch !== this.epoch || !this.order.current(request.sequence) || this.desired !== request.pageID || !request.bounds) return
    const page = this.page(request.scope, request.pageID)
    const size = this.owner.getContentBounds()
    const bounds = clampBrowserBounds(request.bounds, this.owner.webContents.getZoomFactor(), size.width, size.height)
    if (!bounds || this.owner.isMinimized()) return
    this.owner.contentView.addChildView(page.view)
    page.view.setBounds(bounds)
    page.view.setVisible(true)
    page.contents.setAudioMuted(false)
  }

  close(scope: string, pageID: string) {
    const page = this.pages.get(scope)
    if (!page || page.pageID !== pageID) return
    this.pages.delete(scope)
    if (this.desired === pageID) this.desired = undefined
    page.view.setVisible(false)
    if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(page.view)
    page.cleanup()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.ownerCleanup()
    for (const page of this.pages.values()) this.close(page.scope, page.pageID)
    if (controllers.get(this.owner.id) === this) controllers.delete(this.owner.id)
  }
}

export function workbenchBrowserController(owner: BrowserWindow) {
  let controller = controllers.get(owner.id)
  if (!controller) { controller = new WorkbenchBrowserController(owner); controllers.set(owner.id, controller) }
  return controller
}
