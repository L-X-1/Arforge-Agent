import { afterEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { BrowserWindow } from "electron"
import type { BrowserBounds, BrowserLayoutRequest } from "@arforge-ai/app/browser-workbench"
import { requireBrowserLayoutRequest } from "../src/main/browser-embed-policy"
import { captureBrowserLayout } from "../src/preload/browser-layout"
import { observeWorkbenchBrowserOwnerZoom } from "../src/main/browser-owner-zoom"

class Contents extends EventEmitter {
  url = ""
  destroyed = false
  muted = true
  zoom = 1
  beforeZoomWrite?: () => void
  navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  isDestroyed() {
    return this.destroyed
  }
  isLoading() {
    return false
  }
  getURL() {
    return this.url
  }
  getZoomFactor() {
    return this.zoom
  }
  setZoomFactor(value: number) {
    this.beforeZoomWrite?.()
    this.zoom = value
  }
  setAudioMuted(value: boolean) {
    this.muted = value
  }
  setWindowOpenHandler() {}
  loadURL(value: string) {
    this.url = value
    return Promise.resolve()
  }
  close() {
    this.destroyed = true
  }
}
class View {
  static all: View[] = []
  webContents = new Contents()
  visible = false
  bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  constructor() {
    View.all.push(this)
  }
  setVisible(value: boolean) {
    this.visible = value
  }
  setBounds(value: BrowserBounds) {
    this.bounds = { ...value }
  }
}
class Session extends EventEmitter {
  webRequest = { onBeforeRequest() {} }
  setPermissionCheckHandler() {}
  setPermissionRequestHandler() {}
  setDevicePermissionHandler() {}
  clearStorageData() {
    return Promise.resolve()
  }
}
class Owner extends EventEmitter {
  id = 1
  width = 1440
  height = 1000
  destroyed = false
  minimized = false
  webContents = new Contents()
  contentView = { addChildView(_view: View) {}, removeChildView(_view: View) {} }
  isDestroyed() {
    return this.destroyed
  }
  isMinimized() {
    return this.minimized
  }
  getContentBounds() {
    return { x: 0, y: 0, width: this.width, height: this.height }
  }
  resize(width: number, height: number) {
    this.width = width
    this.height = height
    this.emit("resize")
  }
}

mock.module("electron", () => ({
  BrowserWindow: Owner,
  WebContentsView: View,
  session: { fromPartition: () => new Session() },
}))
const { WorkbenchBrowserController } = await import("../src/main/browser-embed")
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

function fixture() {
  const owner = new Owner()
  const stopZoom = observeWorkbenchBrowserOwnerZoom(owner)
  const controller = new WorkbenchBrowserController(owner as unknown as BrowserWindow, () => {})
  cleanups.push(() => {
    controller.dispose()
    stopZoom()
  })
  const scope = "fixture:workspace:session"
  const page = controller.open(scope)
  const view = View.all.at(-1)!
  const measure = (sequence: number) => {
    const zoom = owner.webContents.zoom
    const width = owner.width / zoom
    const height = owner.height / zoom
    return captureBrowserLayout(
      scope,
      page.pageID,
      { x: width - 440, y: 120, width: 440, height: height - 160 },
      sequence,
      () => ({ width, height, zoom }),
    )
  }
  const apply = (request: BrowserLayoutRequest) => {
    const checked = requireBrowserLayoutRequest(request)
    const epoch = controller.stageLayout(checked)
    if (epoch !== undefined) controller.commitLayout(checked, epoch)
    return epoch
  }
  return { owner, controller, scope, page, view, measure, apply }
}

test("a pre-resize measurement arriving after owner resize must stay hidden until fresh layout", () => {
  const f = fixture()
  const delayed = f.measure(1) // captured at1440x1000, before native owner resize
  f.owner.resize(1320, 920) // production resize listener advances its epoch and hides pages
  f.apply(delayed) // IPC only arrives now, so the old controller assigns the new epoch
  const expectedX = f.owner.width - delayed.bounds!.width
  const visibleDrift = f.view.visible ? Math.abs(f.view.bounds.x - expectedX) : 0
  console.info(
    "PRE_RESIZE_LATE_ARRIVAL",
    JSON.stringify({
      capturedViewport: delayed.viewport,
      currentOwner: f.owner.getContentBounds(),
      visible: f.view.visible,
      bounds: f.view.bounds,
      expectedX,
      visibleDrift,
    }),
  )
  expect(visibleDrift).toBeLessThanOrEqual(2)
  expect(f.view.visible).toBe(false)
  expect(f.view.webContents.muted).toBe(true)
  f.apply(f.measure(2))
  expect(f.view.visible).toBe(true)
  expect(Math.abs(f.view.bounds.x - expectedX)).toBeLessThanOrEqual(2)
  expect(f.view.bounds.width).toBe(440)
  console.info("FRESH_VIEWPORT_RESTORED", JSON.stringify({ visible: f.view.visible, bounds: f.view.bounds }))
})

test("height-only pre-resize measurements also stay hidden until fresh layout", () => {
  const f = fixture()
  const old = f.measure(1)
  f.owner.resize(1440, 920)
  expect(f.apply(old)).toBeUndefined()
  expect(f.view.visible).toBe(false)
  f.apply(f.measure(2))
  expect(f.view.visible).toBe(true)
  expect(f.view.bounds.height).toBe(760)
})

test("commit rechecks viewport dimensions after authorization even without a resize event", () => {
  const f = fixture()
  const request = f.measure(1)
  const epoch = f.controller.stageLayout(request)!
  // The native bounds changed before the resize callback or authorization completion.
  f.owner.width = 1320
  f.controller.commitLayout(request, epoch)
  expect(f.view.visible).toBe(false)
  expect(f.view.webContents.muted).toBe(true)
  f.apply(f.measure(2))
  expect(f.view.bounds.x).toBe(880)
  expect(f.view.visible).toBe(true)
})

test("a zoom change cannot reuse the old viewport even when CSS dimensions happen to match", () => {
  const f = fixture()
  const request = f.measure(1)
  const epoch = f.controller.stageLayout(request)!
  f.owner.webContents.zoom = 1.25
  f.owner.width = 1800
  f.owner.height = 1250
  f.controller.commitLayout(request, epoch)
  expect(f.view.visible).toBe(false)
  expect(f.apply({ ...request, sequence: 2 })).toBeUndefined()
  f.apply(f.measure(3))
  expect(f.view.visible).toBe(true)
  expect(f.view.bounds.x).toBe(1250)
  expect(f.view.bounds.width).toBe(550)
})

test("programmatic owner zoom hides an already visible page before any fresh layout or resize", () => {
  const f = fixture()
  f.owner.resize(1320, 920)
  const initial = { ...f.measure(1), bounds: { x: 880, y: 257, width: 440, height: 423 } }
  f.apply(initial)
  expect(f.view.visible).toBe(true)
  expect(f.view.webContents.muted).toBe(false)
  let resizes = 0
  f.owner.on("resize", () => {
    resizes++
  })
  let stateAtWrite: { visible: boolean; muted: boolean } | undefined
  f.owner.webContents.beforeZoomWrite = () => {
    stateAtWrite = { visible: f.view.visible, muted: f.view.webContents.muted }
  }
  // This is the same native method the real public set-zoom-factor IPC calls.
  f.owner.webContents.setZoomFactor(1.25)
  console.info(
    "PROGRAMMATIC_ZOOM_BEFORE_FRESH_LAYOUT",
    JSON.stringify({
      zoom: f.owner.webContents.getZoomFactor(),
      visible: f.view.visible,
      muted: f.view.webContents.muted,
      bounds: f.view.bounds,
      resizeEvents: resizes,
    }),
  )
  expect(f.view.visible).toBe(false)
  expect(f.view.webContents.muted).toBe(true)
  expect(stateAtWrite).toEqual({ visible: false, muted: true })
  expect(resizes).toBe(0)
  expect(f.controller.open(f.scope).pageID).toBe(f.page.pageID)
  const fresh = {
    ...f.measure(2),
    bounds: { x: 616.5333862304688, y: 256.5333557128906, width: 439.46661376953125, height: 239.4666748046875 },
  }
  f.apply(fresh)
  expect(f.view.visible).toBe(true)
  expect(f.view.webContents.muted).toBe(false)
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(f.view.bounds[key] - fresh.bounds[key] * 1.25)).toBeLessThanOrEqual(2)
  console.info("PROGRAMMATIC_ZOOM_FRESH_RESTORED", JSON.stringify({ visible: f.view.visible, bounds: f.view.bounds }))
})

for (const zoom of [0.2, 0.8, 1.25, 10])
  test(`programmatic zoom ${zoom} suspends and restores the same page with strict geometry`, () => {
    const f = fixture()
    f.owner.resize(1441, 1001)
    f.apply(f.measure(1))
    const contents = f.view.webContents
    f.controller.command(f.scope, f.page.pageID, { action: "navigate", url: "https://example.com/retained" })
    const url = contents.getURL()
    f.owner.webContents.setZoomFactor(zoom)
    expect(f.view.visible).toBe(false)
    expect(contents.muted).toBe(true)
    expect(contents.destroyed).toBe(false)
    expect(contents.getURL()).toBe(url)
    expect(f.controller.open(f.scope).pageID).toBe(f.page.pageID)
    const width = f.owner.width / zoom
    const height = f.owner.height / zoom
    const request = { ...f.measure(2), bounds: { x: width / 2, y: height / 4, width: width * 0.4, height: height / 2 } }
    f.apply(request)
    expect(f.view.visible).toBe(true)
    expect(contents.muted).toBe(false)
    for (const key of ["x", "y", "width", "height"] as const)
      expect(Math.abs(f.view.bounds[key] - request.bounds[key] * zoom)).toBeLessThanOrEqual(2)
  })

test("zoom away and back invalidates old authorization even with the original viewport restored", () => {
  const f = fixture()
  const request = f.measure(1)
  const epoch = f.controller.stageLayout(request)!
  f.owner.webContents.setZoomFactor(1.25)
  f.owner.webContents.setZoomFactor(1)
  f.controller.commitLayout(request, epoch)
  expect(f.view.visible).toBe(false)
  expect(f.view.webContents.muted).toBe(true)
  f.apply(f.measure(2))
  expect(f.view.visible).toBe(true)
})

test("setting the current zoom does not strand an already valid visible view", () => {
  const f = fixture()
  f.apply(f.measure(1))
  f.owner.webContents.setZoomFactor(1)
  expect(f.view.visible).toBe(true)
  expect(f.view.webContents.muted).toBe(false)
})

test("programmatic zoom suspends only the window that owns the visible page", () => {
  const first = fixture()
  const other = fixture()
  first.apply(first.measure(1))
  other.apply(other.measure(1))
  first.owner.webContents.setZoomFactor(1.25)
  expect(first.view.visible).toBe(false)
  expect(first.view.webContents.muted).toBe(true)
  expect(other.view.visible).toBe(true)
  expect(other.view.webContents.muted).toBe(false)
})

test("fresh layouts at fractional zoom keep the original strict two-pixel geometry contract", () => {
  const f = fixture()
  f.owner.resize(1441, 1001)
  f.owner.webContents.zoom = 1.25
  const request = f.measure(1)
  f.apply(request)
  expect(f.view.visible).toBe(true)
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(f.view.bounds[key] - request.bounds![key] * 1.25)).toBeLessThanOrEqual(2)
})

test("fresh maximum supported zoom with fractional viewport remains visible and aligned", () => {
  const f = fixture()
  f.owner.resize(1441, 1001)
  f.owner.webContents.zoom = 10
  const request = captureBrowserLayout(
    f.scope,
    f.page.pageID,
    { x: 60.05, y: 20.15, width: 80, height: 70 },
    1,
    () => ({ width: 144.10000610351562, height: 100.0999984741211, zoom: 10 }),
  )
  f.apply(request)
  expect(f.view.visible).toBe(true)
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(f.view.bounds[key] - request.bounds![key] * 10)).toBeLessThanOrEqual(2)
})

test("a small resize at maximum zoom cannot reuse a viewport with the same integer innerWidth", () => {
  const f = fixture()
  f.owner.resize(1441, 1001)
  f.owner.webContents.zoom = 10
  const captured = { width: 144.1, height: 100.1, zoom: 10 }
  const bounds = { x: 60.05, y: 20.15, width: 80, height: 70 }
  const stale = captureBrowserLayout(f.scope, f.page.pageID, bounds, 1, () => captured)
  f.owner.resize(1444, 1001)
  expect(Math.round(captured.width)).toBe(Math.round(f.owner.width / 10))
  expect(f.apply(stale)).toBeUndefined()
  expect(f.view.visible).toBe(false)
  f.apply(
    captureBrowserLayout(f.scope, f.page.pageID, { ...bounds, x: 60.35 }, 2, () => ({
      width: 144.4,
      height: 100.1,
      zoom: 10,
    })),
  )
  expect(f.view.visible).toBe(true)
  expect(Math.abs(f.view.bounds.x - 603.5)).toBeLessThanOrEqual(2)
})

test("fresh minimum supported zoom with fractional owner dimensions remains visible and aligned", () => {
  const f = fixture()
  f.owner.resize(1441, 1001)
  f.owner.webContents.zoom = 0.2
  const request = f.measure(1)
  f.apply(request)
  expect(f.view.visible).toBe(true)
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(f.view.bounds[key] - request.bounds![key] * 0.2)).toBeLessThanOrEqual(2)
})

test("an intervening resize invalidates authorization even after returning to the same viewport", () => {
  const f = fixture()
  const request = f.measure(1)
  const epoch = f.controller.stageLayout(request)!
  f.owner.resize(1320, 920)
  f.owner.resize(1440, 1000)
  f.controller.commitLayout(request, epoch)
  expect(f.view.visible).toBe(false)
  f.apply(f.measure(2))
  expect(f.view.visible).toBe(true)
})

test("a rejected stale higher sequence still invalidates an earlier authorized show", () => {
  const f = fixture()
  const old = f.measure(2)
  f.owner.resize(1320, 920)
  const fresh = f.measure(1)
  const epoch = f.controller.stageLayout(fresh)!
  expect(f.apply(old)).toBeUndefined()
  f.controller.commitLayout(fresh, epoch)
  expect(f.view.visible).toBe(false)
  f.apply(f.measure(3))
  expect(f.view.visible).toBe(true)
})

test("a newer null hide immediately hides and mutes and blocks pending authorization", () => {
  const f = fixture()
  f.apply(f.measure(1))
  const request = f.measure(2)
  const epoch = f.controller.stageLayout(request)!
  f.apply({ scope: f.scope, pageID: f.page.pageID, sequence: 3, bounds: null })
  f.controller.commitLayout(request, epoch)
  expect(f.view.visible).toBe(false)
  expect(f.view.webContents.muted).toBe(true)
  f.apply(f.measure(4))
  expect(f.view.visible).toBe(true)
})

test("newer scope wins and an unrelated old-scope hide cannot hide it", () => {
  const f = fixture()
  const first = f.measure(1)
  const epoch = f.controller.stageLayout(first)!
  const scope = "fixture:other-workspace:other-session"
  const second = f.controller.open(scope)
  const view = View.all.at(-1)!
  f.apply({ ...f.measure(2), scope, pageID: second.pageID })
  f.controller.commitLayout(first, epoch)
  f.apply({ scope: f.scope, pageID: f.page.pageID, sequence: 3, bounds: null })
  expect(f.view.visible).toBe(false)
  expect(view.visible).toBe(true)
  expect(view.webContents.muted).toBe(false)
})

test("missing viewport is never shown via either policy or direct controller entry", () => {
  const f = fixture()
  const { viewport: _viewport, ...request } = f.measure(1)
  expect(() => requireBrowserLayoutRequest(request)).toThrow()
  expect(f.controller.stageLayout(request)).toBeUndefined()
  expect(f.view.visible).toBe(false)
})

test("closed page handles and disposed owners cannot commit pending layouts", () => {
  const f = fixture()
  const request = f.measure(1)
  const epoch = f.controller.stageLayout(request)!
  f.controller.close(f.scope, f.page.pageID)
  f.controller.open(f.scope)
  expect(() => f.controller.stageLayout(request)).toThrow()
  f.controller.commitLayout(request, epoch)
  expect(f.view.visible).toBe(false)
  expect(f.view.webContents.destroyed).toBe(true)
  f.owner.emit("closed")
  expect(f.controller.stageLayout({ ...request, sequence: 2 })).toBeUndefined()
})

test("owner blur and minimize retain their epoch suspension guard", () => {
  for (const event of ["blur", "minimize"]) {
    const f = fixture()
    const request = f.measure(1)
    const epoch = f.controller.stageLayout(request)!
    f.owner.emit(event)
    f.controller.commitLayout(request, epoch)
    expect(f.view.visible).toBe(false)
    expect(f.view.webContents.muted).toBe(true)
  }
})
