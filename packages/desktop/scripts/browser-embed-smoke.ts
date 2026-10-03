import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { app, BrowserWindow, WebContentsView, session } from "electron"
import type { BrowserLayoutRequest, BrowserPageState } from "@arforge-ai/app/browser-workbench"
import { WorkbenchBrowserController } from "../src/main/browser-embed"
import { waitForSmokeEvent } from "./browser-smoke-wait"

// Native controller acceptance with an isolated fixture host, not the live app.
const output = resolve(process.env.ARFORGE_BROWSER_SMOKE_OUTPUT ?? "../../artifacts")
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(join(output, "browser-embed-profile-"))
app.setPath("userData", profile)
app.disableHardwareAcceleration()
// Closing the last fixture is an assertion, not the end of the process.
// Stay alive between fixtures; only the acceptance report path calls app.exit().
app.on("window-all-closed", () => undefined)
const report = { passed: false, phase: "app-ready", checks: [] as string[], error: "", profile }
const writeReport = () => {
  writeFileSync(join(output, "browser-embed-smoke.json"), JSON.stringify(report, null, 2))
  console.log("BROWSER_EMBED_SMOKE " + JSON.stringify(report))
}
let fatalExit = false
const unexpectedFailure = (error: unknown) => {
  if (fatalExit) return
  fatalExit = true
  report.passed = false
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
  writeReport()
  app.exit(1)
}
// Electron otherwise presents a blocking native error dialog, hiding the cause
// from this unattended isolated acceptance process.
process.on("uncaughtException", unexpectedFailure)
process.on("unhandledRejection", unexpectedFailure)
const timer = setTimeout(() => { report.error = "Timed out during " + report.phase; writeReport(); app.exit(1) }, 45_000)

async function listen(server: Server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  return "http://127.0.0.1:" + address.port
}

async function run() {
  await app.whenReady()
  const requests: { path: string; cookie: string }[] = []
  let foreignRequests = 0
  const foreign = createServer((_request, response) => { foreignRequests++; response.end("foreign") })
  const foreignOrigin = await listen(foreign)
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", cookie: request.headers.cookie ?? "" })
    if (request.url === "/redirect") { response.writeHead(302, { location: foreignOrigin + "/blocked" }); response.end(); return }
    if (request.url === "/download") { response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=test.txt" }); response.end("download"); return }
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end('<!doctype html><title>Untrusted title</title><h1>' + request.url + '</h1><input id="draft"><a id="next" href="/two">Next</a><a id="download" href="/download">Download</a>')
  })
  const origin = await listen(server)
  const owner = new BrowserWindow({ show: false, width: 1100, height: 780, webPreferences: { sandbox: true } })
  let controller: WorkbenchBrowserController | undefined
  try {
    await owner.loadURL("data:text/html,<title>Workbench fixture host</title><h1>Conversation</h1><p>Native browser pane on the right</p>")
    const states: BrowserPageState[] = []
    controller = new WorkbenchBrowserController(owner, (state) => states.push(state))
    const browser = controller
    let sequence = 0
    const bounds = { x: 540, y: 100, width: 520, height: 600 }
    const layout = (page: BrowserPageState, rect: typeof bounds | null = bounds) => {
      const request: BrowserLayoutRequest = { scope: page.scope, pageID: page.pageID, bounds: rect, sequence: ++sequence }
      const epoch = browser.stageLayout(request)
      if (epoch !== undefined) browser.commitLayout(request, epoch)
      return request
    }
    const nativeView = () => {
      const view = owner.contentView.children.at(-1)
      assert(view instanceof WebContentsView && view.webContents !== owner.webContents)
      return view
    }
    const navigate = async (page: BrowserPageState, view: WebContentsView, path: string) => {
      report.phase = path
      await waitForSmokeEvent(view.webContents, "did-finish-load", {
        label: path, action: () => browser.command(page.scope, page.pageID, { action: "navigate", url: origin + path }),
        failureEvents: ["did-fail-load", "render-process-gone", "destroyed"],
      })
      assert.equal(view.webContents.getURL(), origin + path)
    }

    report.phase = "embedding-and-isolation"
    const first = browser.open("server:workspace:session-one")
    layout(first)
    const firstView = nativeView()
    await waitForSmokeEvent(firstView.webContents, "did-finish-load", { label: report.phase })
    assert.equal(browser.open(first.scope).pageID, first.pageID)
    assert.deepEqual(firstView.getBounds(), bounds)
    assert.equal(firstView.getVisible(), true)
    assert.notEqual(firstView.webContents.session, owner.webContents.session)
    assert.deepEqual(await firstView.webContents.executeJavaScript("({api:typeof window.api,node:typeof require,process:typeof process})"),
      { api: "undefined", node: "undefined", process: "undefined" })
    await session.defaultSession.cookies.set({ url: origin, name: "owner-secret", value: "owner-only", httpOnly: true })
    await navigate(first, firstView, "/one")
    assert.equal(owner.getTitle(), "Workbench fixture host")
    await firstView.webContents.session.cookies.set({ url: origin, name: "session-one", value: "one-only" })
    report.checks.push("real native child view in fixture host; bounded geometry, no host bridge/Node, isolated owner cookies and title")

    report.phase = "history"
    await waitForSmokeEvent(firstView.webContents, "did-finish-load", {
      label: "link", action: () => firstView.webContents.executeJavaScript("document.getElementById('next').click()", true),
    })
    await waitForSmokeEvent(firstView.webContents, "did-finish-load", {
      label: "back", action: () => browser.command(first.scope, first.pageID, { action: "back" }),
    })
    assert.equal(firstView.webContents.getURL(), origin + "/one")
    await waitForSmokeEvent(firstView.webContents, "did-finish-load", {
      label: "forward", action: () => browser.command(first.scope, first.pageID, { action: "forward" }),
    })
    assert.equal(firstView.webContents.getURL(), origin + "/two")
    const before = requests.filter((request) => request.path === "/two").length
    await waitForSmokeEvent(firstView.webContents, "did-finish-load", {
      label: "reload", action: () => browser.command(first.scope, first.pageID, { action: "reload" }),
    })
    assert(requests.filter((request) => request.path === "/two").length > before)
    await firstView.webContents.executeJavaScript("document.getElementById('draft').value='session-one-draft'")
    report.checks.push("same-origin link, actual back/forward history and reload")

    report.phase = "session-switch-and-stale-layout"
    const second = browser.open("server:workspace:session-two")
    layout(second)
    const secondView = nativeView()
    await waitForSmokeEvent(secondView.webContents, "did-finish-load", { label: "second start" })
    await navigate(second, secondView, "/other")
    assert.notEqual(secondView.webContents.session, firstView.webContents.session)
    assert(requests.filter((request) => request.path === "/other").every((request) => !request.cookie.includes("session-one")))
    assert.equal(firstView.getVisible(), false)
    assert.equal(firstView.webContents.isAudioMuted(), true)
    const oldRequest = { scope: first.scope, pageID: first.pageID, sequence: ++sequence, bounds }
    const oldEpoch = browser.stageLayout(oldRequest)!
    layout(second)
    browser.commitLayout(oldRequest, oldEpoch)
    assert.equal(firstView.getVisible(), false)
    assert.equal(secondView.getVisible(), true)
    layout(first, null)
    assert.equal(secondView.getVisible(), true)
    layout(second, null)
    assert.equal(secondView.getVisible(), false)
    layout(first)
    assert.equal(firstView.webContents.getURL(), origin + "/two")
    assert.equal(await firstView.webContents.executeJavaScript("document.getElementById('draft').value"), "session-one-draft")
    assert.throws(() => browser.command(second.scope, first.pageID, { action: "reload" }))
    report.checks.push("session cookie separation and preserved page/history/draft; stale show/hide and cross-session handles rejected")

    report.phase = "policy-denial"
    assert.equal(await firstView.webContents.executeJavaScript("window.open('/popup') === null", true), true)
    assert.equal(await firstView.webContents.executeJavaScript("Notification.requestPermission()", true), "denied")
    const [download] = await waitForSmokeEvent(firstView.webContents.session, "will-download", {
      label: "download", action: () => firstView.webContents.executeJavaScript("document.getElementById('download').click()", true),
    })
    assert((download as Electron.Event).defaultPrevented)
    await waitForSmokeEvent(firstView.webContents, "did-stop-loading", {
      label: "cross-origin redirect", action: () => browser.command(first.scope, first.pageID, { action: "navigate", url: origin + "/redirect" }),
    })
    assert.equal(foreignRequests, 0)
    assert(states.some((state) => state.notice.length > 0))
    assert(requests.every((request) => !request.cookie.includes("owner-secret")))
    report.checks.push("popup, notification, download and unapproved redirect remain blocked with real user gestures")

    report.phase = "resource-limits"
    const third = browser.open("server:workspace:session-three")
    browser.open("server:workspace:session-four")
    assert.throws(() => browser.open("server:workspace:session-five"))
    const detached = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    const other = new WorkbenchBrowserController(detached, () => undefined)
    assert.throws(() => other.command(first.scope, first.pageID, { action: "reload" }))
    detached.destroy()
    report.checks.push("four-page resource limit and cross-window handle isolation")

    report.phase = "explicit-page-close"
    layout(third)
    const thirdContents = nativeView().webContents
    const thirdStateCount = states.filter((state) => state.pageID === third.pageID).length
    await waitForSmokeEvent(thirdContents, "destroyed", {
      label: report.phase, action: () => browser.close(third.scope, third.pageID),
    })
    assert(thirdContents.isDestroyed())
    const reopened = browser.open(third.scope)
    assert.notEqual(reopened.pageID, third.pageID)
    browser.close(third.scope, third.pageID)
    assert.equal(browser.open(third.scope).pageID, reopened.pageID)
    report.checks.push("explicit page close destroys webContents; reopen has a new handle and ignores stale close")

    report.phase = "late-closed-page-callbacks"
    layout(reopened)
    const reopenedContents = nativeView().webContents
    if (reopenedContents.isLoading()) {
      await waitForSmokeEvent(reopenedContents, "did-finish-load", { label: "reopened page ready" })
    }
    // Flush the old initial load rejection, then exercise retained event
    // listeners deterministically after the native view's contents are gone.
    await new Promise<void>((done) => setImmediate(done))
    const replacementBefore = browser.open(third.scope)
    const stateCountBeforeLateEvents = states.length
    assert.doesNotThrow(() => {
      thirdContents.emit("did-stop-loading")
      thirdContents.emit("did-fail-load", {}, -2, "late initial navigation failure", "", true)
      thirdContents.emit("render-process-gone", {}, { reason: "crashed" })
    })
    await new Promise<void>((done) => setImmediate(done))
    assert.equal(states.filter((state) => state.pageID === third.pageID).length, thirdStateCount)
    assert.equal(states.length, stateCountBeforeLateEvents)
    assert.deepEqual(browser.open(third.scope), replacementBefore)
    assert.equal(replacementBefore.notice, "")
    assert.equal(reopenedContents.isDestroyed(), false)
    report.checks.push("late load rejection and retained events after close cannot publish old state or alter the reopened page")

    report.phase = "owner-close"
    const firstContents = firstView.webContents
    const secondContents = secondView.webContents
    const closedFirst = waitForSmokeEvent(firstContents, "destroyed", { label: "first page disposal" })
    const closedSecond = waitForSmokeEvent(secondContents, "destroyed", { label: "second page disposal" })
    owner.destroy()
    await Promise.all([closedFirst, closedSecond])
    assert(firstContents.isDestroyed())
    assert(secondContents.isDestroyed())
    report.checks.push("forced owner destruction releases native page webContents")
    controller.dispose()

    report.phase = "normal-window-close"
    const normalOwner = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await normalOwner.loadURL("data:text/html,<title>Normal close fixture</title>")
    const normal = new WorkbenchBrowserController(normalOwner, () => undefined)
    const normalPage = normal.open("server:workspace:normal-close")
    const normalLayout: BrowserLayoutRequest = { scope: normalPage.scope, pageID: normalPage.pageID, sequence: 1, bounds }
    const normalEpoch = normal.stageLayout(normalLayout)
    assert.notEqual(normalEpoch, undefined)
    normal.commitLayout(normalLayout, normalEpoch!)
    const normalView = normalOwner.contentView.children.at(-1)
    assert(normalView instanceof WebContentsView)
    const normalContents = normalView.webContents
    await waitForSmokeEvent(normalContents, "did-finish-load", { label: "normal close page ready" })
    await waitForSmokeEvent(normalContents, "destroyed", {
      label: report.phase, action: () => normalOwner.close(),
    })
    assert(normalOwner.isDestroyed())
    assert(normalContents.isDestroyed())
    normal.dispose()
    report.checks.push("normal window close releases its page and repeated disposal is safe")
    report.phase = "complete"
    report.passed = !fatalExit
  } finally {
    controller?.dispose()
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
    server.closeAllConnections(); foreign.closeAllConnections()
    await Promise.all([new Promise<void>((done) => server.close(() => done())), new Promise<void>((done) => foreign.close(() => done()))])
  }
}

void run().catch((error: unknown) => {
  if (!report.error) report.error = error instanceof Error ? error.stack ?? error.message : String(error)
}).finally(() => { clearTimeout(timer); writeReport(); app.exit(report.passed ? 0 : 1) })
