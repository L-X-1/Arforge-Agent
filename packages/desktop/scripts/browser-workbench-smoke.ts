import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { app, BrowserWindow, session } from "electron"
import { createWorkbenchBrowserWindow } from "../src/main/browser-window"
import { waitForSmokeEvent } from "./browser-smoke-wait"

// Build this harness with electron external, then run it with the installed Electron binary.
// It never starts the Arforge app, sidecar or a live user profile.
const output = resolve(process.env.ARFORGE_BROWSER_SMOKE_OUTPUT ?? "../../artifacts")
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(join(output, "browser-workbench-profile-"))
app.setPath("userData", profile)
app.disableHardwareAcceleration()
const startedAt = Date.now()
const report: {
  passed: boolean; phase: string; checks: string[]; notices: string[]; profile: string
  elapsedMs?: number; error?: string
  windows?: { url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }[]
} = { passed: false, phase: "app-ready", checks: [], notices: [], profile }

function captureWindows() {
  report.windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).map((win) => ({
    url: win.webContents.getURL().startsWith("data:") ? "[start-page]" : win.webContents.getURL(),
    loading: win.webContents.isLoading(),
    canGoBack: win.webContents.navigationHistory.canGoBack(),
    canGoForward: win.webContents.navigationHistory.canGoForward(),
  }))
}

function writeReport() {
  report.elapsedMs = Date.now() - startedAt
  writeFileSync(join(output, "browser-workbench-smoke.json"), JSON.stringify(report, null, 2))
  console.log(`BROWSER_WORKBENCH_SMOKE ${JSON.stringify(report)}`)
}

const timer = setTimeout(() => {
  report.passed = false
  report.error = "Overall timeout during " + report.phase
  captureWindows()
  writeReport()
  app.exit(1)
}, 45_000)

async function listen(server: Server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}

async function navigate(win: BrowserWindow, phase: string, expectedUrl: string, action: () => Promise<unknown> | void) {
  report.phase = phase
  await waitForSmokeEvent(win.webContents, "did-finish-load", {
    label: phase, action, failureEvents: ["did-fail-load", "render-process-gone", "destroyed"],
  })
  assert.equal(win.webContents.getURL(), expectedUrl, phase + ": unexpected destination")
}

async function run() {
  await app.whenReady()
  report.phase = "local-fixture-start"
  let crossOriginRequests = 0
  const foreign = createServer((_request, response) => { crossOriginRequests++; response.end("foreign") })
  const foreignOrigin = await listen(foreign)
  const requests: { path: string; cookie: string }[] = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", cookie: request.headers.cookie ?? "" })
    if (request.url === "/redirect") { response.writeHead(302, { location: `${foreignOrigin}/foreign` }); response.end(); return }
    if (request.url === "/download") { response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=test.txt" }); response.end("download"); return }
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<!doctype html><title>Untrusted page title</title><h1>${request.url === "/two" ? "Two" : "One"}</h1><a id="next" href="/two">Next</a><a id="download" href="/download">Download</a>`)
  })
  const origin = await listen(server)
  const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await session.defaultSession.cookies.set({ url: origin, name: "arforge-owner-secret", value: "owner-only", httpOnly: true })
    report.phase = "start-page"
    const browser = createWorkbenchBrowserWindow(owner, { show: false, onNotice: (message) => report.notices.push(message) })
    await waitForSmokeEvent(browser.webContents, "did-finish-load", {
      label: report.phase, failureEvents: ["did-fail-load", "render-process-gone", "destroyed"],
    })
    assert.equal(createWorkbenchBrowserWindow(owner, { show: false }), browser)
    assert.notEqual(browser.webContents.session, owner.webContents.session)
    const isolation = await browser.webContents.executeJavaScript("({api:typeof window.api,node:typeof require,process:typeof process,label:document.querySelector('label').htmlFor})")
    assert.deepEqual(isolation, { api: "undefined", node: "undefined", process: "undefined", label: "address" })
    writeFileSync(join(output, "browser-workbench-start.png"), (await browser.webContents.capturePage()).toPNG())
    report.checks.push("isolated session, no preload/Node API, accessible start page, one browser per owner")

    // Real address submission and clicks carry a user gesture; unactivated history
    // entries can be skipped by Chromium, leaving a synthetic back action a no-op.
    await navigate(browser, "address-navigation", `${origin}/one`, () => browser.webContents.executeJavaScript(`document.getElementById('address').value=${JSON.stringify(`${origin}/one`)};document.getElementById('address-form').requestSubmit()`, true))
    assert.equal(await browser.webContents.executeJavaScript("document.querySelector('h1').textContent"), "One")
    assert(requests.every((request) => !request.cookie.includes("arforge-owner-secret")))
    assert(browser.getTitle().startsWith("Arforge Browser | 127.0.0.1:"))
    report.checks.push("real HTTP navigation, owner cookies not shared, page cannot spoof native title")

    await navigate(browser, "same-origin-link", `${origin}/two`, () => browser.webContents.executeJavaScript("document.getElementById('next').click()", true))
    assert.equal(await browser.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Two")
    await navigate(browser, "history-back", `${origin}/one`, () => {
      assert(browser.webContents.navigationHistory.canGoBack())
      browser.webContents.navigationHistory.goBack()
    })
    assert.equal(await browser.webContents.executeJavaScript("document.querySelector('h1').textContent"), "One")
    await navigate(browser, "history-forward", `${origin}/two`, () => {
      assert(browser.webContents.navigationHistory.canGoForward())
      browser.webContents.navigationHistory.goForward()
    })
    assert.equal(await browser.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Two")
    const beforeReload = requests.filter((request) => request.path === "/two").length
    await navigate(browser, "reload", `${origin}/two`, () => browser.webContents.reload())
    assert(requests.filter((request) => request.path === "/two").length > beforeReload)
    report.checks.push("same-origin links, back, forward and reload")

    report.phase = "permission-and-popup-denial"
    assert.equal(await browser.webContents.executeJavaScript("window.open('/popup') === null", true), true)
    assert.equal(BrowserWindow.getAllWindows().length, 2)
    assert.equal(await browser.webContents.executeJavaScript("Notification.requestPermission()", true), "denied")
    report.phase = "download-denial"
    const [downloadEvent] = await waitForSmokeEvent(browser.webContents.session, "will-download", {
      label: report.phase,
      action: () => browser.webContents.executeJavaScript("document.getElementById('download').click()", true),
    })
    assert((downloadEvent as Electron.Event).defaultPrevented)
    report.checks.push("popup, notification permission and download denied")

    report.phase = "cross-origin-redirect"
    await assert.rejects(browser.webContents.loadURL(`${origin}/redirect`))
    assert.equal(crossOriginRequests, 0)
    assert(report.notices.some((message) => message.includes("origin")))
    report.checks.push("unapproved cross-origin redirect blocked before the target request")

    assert(requests.every((request) => !request.cookie.includes("arforge-owner-secret")))
    report.phase = "owner-close"
    owner.destroy()
    assert(browser.isDestroyed())
    report.checks.push("closing the owner destroys its browser")
    report.phase = "complete"
    report.passed = true
  } finally {
    captureWindows()
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
    server.closeAllConnections(); foreign.closeAllConnections()
    await Promise.all([new Promise<void>((done) => server.close(() => done())), new Promise<void>((done) => foreign.close(() => done()))])
  }
}

void run().catch((error: unknown) => {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
}).finally(() => {
  clearTimeout(timer)
  writeReport()
  app.exit(report.passed ? 0 : 1)
})
