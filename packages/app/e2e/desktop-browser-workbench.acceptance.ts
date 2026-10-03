import assert from "node:assert/strict"
import { spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test"

// Real built desktop renderer, preload, registered IPC handlers and Core runtime.
// Only the manually browsed website is a fixture. No model request is allowed.
// Rebuild desktop first, then run this file with Node.js. Retain the isolated
// profile and evidence for diagnosis; never attach to an existing desktop.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const desktopRoot = join(root, "packages/desktop")
const artifacts = join(root, "artifacts")
await mkdir(artifacts, { recursive: true })
const runRoot = await mkdtemp(join(artifacts, "browser-workbench-desktop-run-"))
const workspace = join(runRoot, "workspace")
const profile = join(runRoot, "profile")
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
// Only the fields observed by this standalone E2E project cross the bridge.
type CapturedBrowserState = { scope: string; pageID: string; url: string }
type BrowserJournalReceipt = {
  actionID: string; traceID: string; senderID: number; kind: string; name: string; inputDigest: string
  state: string; observationStatus: string; timeCreated: number; timeUpdated: number
  outputDigest?: string; outputByteLength?: number; errorCode?: string
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
// Independent oracle for these flat IPC payloads: Core hashes stableJson(payload),
// sorting object keys with localeCompare. It does not persist the payload fields.
const browserInputDigest = (payload: Record<string, string>) =>
  sha256(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)))))
type NativePage = { id: number; url: string; visible: boolean; muted: boolean; bounds: { x: number; y: number; width: number; height: number } }
let application: ElectronApplication | undefined
let processHandle: ChildProcess | undefined
let page: Page | undefined
let ownerID = 0
let stage = "prepare"
let failure: unknown
let appStdout = ""
let appStderr = ""
let bound = false
let tracing = false
let modelRequests = 0
const requests: string[] = []
const rendererErrors: string[] = []
const apiFailures: Array<{ path: string; status: number }> = []
const checks: string[] = []
type BrowserDiagnostic = { time: number; stage: string; event: string; [key: string]: unknown }
const diagnostics: BrowserDiagnostic[] = []
const diagnosticTasks = new Set<Promise<void>>()
const diagnosticURL = (value: string) => {
  try {
    const url = new URL(value)
    if (url.protocol === "data:") return "data:"
    return (url.origin === "null" ? url.protocol + "//" + url.host : url.origin) + url.pathname
  } catch { return "[non-url]" }
}
const observeDiagnostic = (task: Promise<void>) => {
  const pending = task.catch((error: unknown) => {
    diagnostics.push({ time: Date.now(), stage, event: "diagnostic-unavailable",
      reason: error instanceof Error ? error.name : "unknown" })
  })
  diagnosticTasks.add(pending)
  void pending.then(() => diagnosticTasks.delete(pending))
}
const sessionTitles = new Map<string, string>()
const report: Record<string, unknown> = {
  passed: false, stage, run_root: runRoot, profile, workspace,
  launch_mode: "real-built-desktop", core_mode: "real-local-database",
  browser_content: "loopback-fixture", remote_model: "not-used",
}
const fixture = createServer((request, response) => {
  const path = request.url ?? "/"
  requests.push(path)
  if (path.startsWith("/v1/")) {
    modelRequests++
    response.writeHead(503, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "Model calls are outside this acceptance" } }))
    return
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  response.end('<!doctype html><title>Manual browser fixture</title><h1>' + path +
    '</h1><input id="draft"><a id="next" href="/two">Next page</a><p>Isolated manual content.</p>')
})
const progress = (value: string) => { stage = value; process.stdout.write("BROWSER_DESKTOP_STAGE " + value + "\n") }
const appAPI = () => page!
const panel = () => appAPI().locator('[data-component="workbench-browser-panel"]:visible')
const button = (name: string) => panel().getByRole("button", { name, exact: true })
const sessionTab = (id: string) =>
  appAPI().locator('[data-titlebar-tab-link][href$="/session/' + encodeURIComponent(id) + '"]:visible').first()
const navigateSession = async (id: string) => {
  const timeOrigin = await appAPI().evaluate(() => performance.timeOrigin)
  const tab = sessionTab(id)
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(tab.locator("..")).toHaveAttribute("data-active", "true")
  await expect(appAPI().locator('[data-component="prompt-input"][contenteditable="true"]')).toBeVisible({ timeout: 30_000 })
  assert.equal(await appAPI().evaluate(() => performance.timeOrigin), timeOrigin,
    "Session tab navigation reloaded the renderer instead of using its router")
  assert.equal(await appAPI().evaluate(() =>
    Array.isArray((window as unknown as { __browserAcceptanceStates?: unknown }).__browserAcceptanceStates)), true,
    "Session navigation lost the original preload state subscription")
  await expect(panel()).toBeVisible()
}
const nativePages = async (): Promise<NativePage[]> => application!.evaluate(({ BrowserWindow }, id) => {
  const owner = BrowserWindow.getAllWindows().find((window) => window.webContents.id === id)
  if (!owner) throw new Error("The owned renderer window is missing")
  return owner.contentView.children.flatMap((view) => {
    const contents = (view as Electron.WebContentsView).webContents
    if (!contents || contents.isDestroyed() || contents.id === id) return []
    return [{ id: contents.id, url: contents.getURL(), visible: view.getVisible(),
      muted: contents.isAudioMuted(), bounds: view.getBounds() }]
  })
}, ownerID)
const nativeValue = (id: number, code: string) => application!.evaluate(({ webContents }, input) => {
  const contents = webContents.fromId(input.id)
  if (!contents || contents.isDestroyed()) throw new Error("The fixture page was destroyed")
  return contents.executeJavaScript(input.code, true)
}, { id, code })
const visiblePage = async (url?: string) => {
  await expect.poll(async () => (await nativePages()).filter((item) => item.visible &&
    (url === undefined || item.url === url)).length, { timeout: 20_000 }).toBe(1)
  return (await nativePages()).find((item) => item.visible && (url === undefined || item.url === url))!
}
const hiddenPages = () => expect.poll(async () => (await nativePages()).filter((item) => item.visible).length).toBe(0)
const snapshot = async (url: string): Promise<CapturedBrowserState> => {
  const state = await appAPI().evaluate((url) =>
    (window as unknown as { __browserAcceptanceStates: CapturedBrowserState[] })
      .__browserAcceptanceStates.findLast((state) => state.url === url), url)
  assert.ok(state, "No real preload state event was received for " + url)
  return state
}
const assertBounds = async () => {
  const current = await visiblePage()
  const rect = await panel().locator("[data-browser-viewport]").boundingBox()
  assert.ok(rect)
  const zoom = await application!.evaluate(({ BrowserWindow }, id) =>
    BrowserWindow.getAllWindows().find((win) => win.webContents.id === id)!.webContents.getZoomFactor(), ownerID)
  for (const key of ["x", "y", "width", "height"] as const)
    assert.ok(Math.abs(current.bounds[key] - rect[key] * zoom) <= 2, "Native view differs from renderer viewport: " + key)
}
const openBrowser = async () => {
  await button("\u6d4f\u89c8\u5668").click()
  return visiblePage()
}
const navigateWebsite = async (url: string) => {
  await panel().getByLabel("\u7f51\u7ad9\u5730\u5740", { exact: true }).fill(url)
  await button("\u6253\u5f00").click()
  const current = await visiblePage(url)
  await expect.poll(() => nativeValue(current.id, "document.readyState")).toBe("complete")
  return current
}

try {
  for (const directory of [workspace, profile]) await mkdir(directory, { recursive: true })
  await writeFile(join(workspace, "notes.txt"), "Isolated desktop browser acceptance.\n", "utf8")
  await new Promise<void>((done, fail) => { fixture.once("error", fail); fixture.listen(0, "127.0.0.1", done) })
  bound = true
  const address = fixture.address()
  assert.ok(address && typeof address !== "string")
  const origin = "http://127.0.0.1:" + address.port
  await writeFile(join(workspace, "arforge.json"), JSON.stringify({
    $schema: "urn:arforge:config", formatter: false, lsp: false,
    provider: {
      test: {
        name: "Manual browser acceptance", id: "test", env: [], npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model", name: "Browser Acceptance Model (unused)", attachment: false,
            reasoning: false, temperature: false, tool_call: true,
            release_date: "2026-09-15", modalities: { input: ["text"], output: ["text"] },
            limit: { context: 100_000, output: 10_000 }, cost: { input: 0, output: 0 }, options: {},
          },
        },
        options: { apiKey: "isolated-unused-fixture-key", baseURL: origin + "/v1" },
      },
    },
  }), "utf8")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !/^(?:ARFORGE_|OPENCODE_)/.test(key) &&
    !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(key) &&
    !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "NODE_OPTIONS"].includes(key))) as Record<string, string>
  progress("launch-real-isolated-desktop")
  application = await _electron.launch({
    executablePath: join(desktopRoot, "node_modules/electron/dist/electron.exe"),
    args: ["--user-data-dir=" + profile, desktopRoot], cwd: workspace, timeout: 60_000,
    env: { ...env, ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1", ARFORGE_DATABASE_MODE: "local",
      ARFORGE_DB: join(runRoot, "browser-workbench.db"), ARFORGE_DB_URL: "", ARFORGE_DB_ADMIN_URL: "",
      ARFORGE_MULTIAGENT_DB_URL: "", ARFORGE_DISABLE_HARDWARE_ACCELERATION: "1", NODE_ENV: "production" },
  })
  processHandle = application.process()
  processHandle.stdout?.on("data", (chunk) => { appStdout = (appStdout + String(chunk)).slice(-20_000) })
  processHandle.stderr?.on("data", (chunk) => { appStderr = (appStderr + String(chunk)).slice(-20_000) })
  await application.evaluate(({ app, webContents }) => {
    const target = globalThis as unknown as { __browserAcceptanceSecurity: Array<Record<string, unknown>> }
    target.__browserAcceptanceSecurity = []
    const watch = (contents: Electron.WebContents) => {
      contents.on("console-message", (details) => {
        if (!/Electron Security Warning|Content.Security.Policy|unsafe-eval/i.test(details.message)) return
        let location = "[destroyed]"
        try {
          const url = new URL(contents.getURL())
          location = url.protocol === "data:" ? "data:"
            : (url.origin === "null" ? url.protocol + "//" + url.host : url.origin) + url.pathname
        } catch {}
        target.__browserAcceptanceSecurity.push({
          time: Date.now(), contents_id: contents.id, url: location,
          level: details.level, message: details.message.slice(0, 1800),
        })
        if (target.__browserAcceptanceSecurity.length > 100) target.__browserAcceptanceSecurity.shift()
      })
    }
    for (const contents of webContents.getAllWebContents()) watch(contents)
    app.on("web-contents-created", (_event, contents) => watch(contents))
  })
  page = await application.firstWindow({ timeout: 60_000 })
  page.setDefaultTimeout(15_000)
  page.on("pageerror", (error) => rendererErrors.push(error.message))
  page.on("requestfailed", (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith("/api/")) return
    diagnostics.push({ time: Date.now(), stage, event: "request-failed",
      path: url.pathname, method: request.method(), resource_type: request.resourceType(),
      error: request.failure()?.errorText })
  })
  page.on("console", (message) => {
    if (!/Failed to load sessions|\[session-review\] failed to load vcs diff/.test(message.text())) return
    const entry: BrowserDiagnostic = {
      time: Date.now(), stage, event: "renderer-console", level: message.type(),
      message: message.text().slice(0, 1200),
      source: diagnosticURL(message.location().url), line: message.location().lineNumber,
    }
    diagnostics.push(entry)
    observeDiagnostic((async () => {
      const details: unknown[] = []
      for (const argument of message.args()) {
        details.push(await argument.evaluate((input: unknown) => {
          // Read only bounded diagnostic fields, never headers, credentials, response
          // bodies, source code or arbitrary request objects from an SDK error.
          const fields = ["_tag", "name", "message", "code", "status", "statusCode", "reason",
            "cause", "error", "detail", "description", "mode", "type", "method", "kind"]
          const seen = new WeakSet<object>()
          const summarize = (value: unknown, depth: number): unknown => {
            if (value === null || typeof value === "number" || typeof value === "boolean") return value
            if (typeof value === "string")
              return value.replace(/https?:\/\/[^\s"'<>]+/g, (address) => {
                try { const url = new URL(address); return url.origin + url.pathname }
                catch { return "[url]" }
              }).slice(0, 1200)
            if (typeof value !== "object") return String(value)
            if (depth >= 5 || seen.has(value)) return "[nested]"
            seen.add(value)
            if (Array.isArray(value)) return value.slice(0, 8).map((item) => summarize(item, depth + 1))
            const result: Record<string, unknown> = {}
            for (const key of fields)
              if (key in value) {
                try { result[key] = summarize((value as Record<string, unknown>)[key], depth + 1) }
                catch { result[key] = "[unavailable]" }
              }
            return result
          }
          return summarize(input, 0)
        }).catch(() => "[execution-context-unavailable]"))
      }
      entry.details = details
    })())
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith("/api/"))
      diagnostics.push({ time: Date.now(), stage, event: "api-response",
        path: url.pathname, method: response.request().method(), status: response.status() })
    if (response.request().resourceType() === "document" && url.protocol === "arforge:")
      diagnostics.push({ time: Date.now(), stage, event: "renderer-document-policy",
        url: diagnosticURL(response.url()), csp: response.headers()["content-security-policy"] ?? null })
    if (response.status() >= 400 && /^\/api\/(?:session|file|vcs)(?:\/|$)/.test(url.pathname))
      apiFailures.push({ path: url.pathname, status: response.status() })
  })
  assert.equal(resolve(await application.evaluate(({ app }) => app.getPath("userData"))), resolve(profile))
  await page.waitForFunction(() => Boolean((window as unknown as { api?: { browserWorkbench?: unknown } }).api?.browserWorkbench))
  ownerID = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith("arforge://renderer/"))!.webContents.id)
  await application.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows().find((win) => win.webContents.id === id)!.setContentSize(1440, 1000)
  }, ownerID)
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  tracing = true
  progress("configure-real-renderer-and-create-sessions")
  const initialization = await page.evaluate(async (directory) => {
    const api = (window as unknown as { api: {
      storeSet: (file: string, key: string, value: string) => Promise<void>
      awaitInitialization: () => Promise<{ url: string }>
    } }).api
    await api.storeSet("default.dat", "settings.v3", JSON.stringify({
      general: { newLayoutDesigns: true, showFileTree: true, newInterfaceNoticeDismissed: true, shouldDisplayTabsToast: false },
      permissions: { autoApprove: false },
      sounds: { agentEnabled: false, permissionsEnabled: false, errorsEnabled: false },
      notifications: { agent: false, permissions: false, errors: false },
    }))
    await api.storeSet("arforge.global.dat", "server", JSON.stringify({
      projects: { local: [{ worktree: directory, expanded: true }] },
      lastProject: { local: directory }, recentlyClosed: { local: [] },
    }))
    await api.storeSet("arforge.global.dat", "layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    await api.storeSet("arforge.global.dat", "review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 260, expandMode: "collapse" }))
    return api.awaitInitialization()
  }, workspace)
  const health = await fetch(initialization.url + "/api/health", { signal: AbortSignal.timeout(10_000) })
  assert.ok(health.ok)
  const healthBody = await health.json() as { healthy: boolean; protocol: string }
  assert.equal(healthBody.healthy, true)
  assert.equal(healthBody.protocol, "v2")
  const sessions: string[] = []
  for (let i = 0; i < 2; i++) {
    const created = await fetch(initialization.url + "/api/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: workspace }, model: { providerID: "test", id: "test-model" } }),
      signal: AbortSignal.timeout(15_000),
    })
    assert.ok(created.ok, "Real session creation failed: HTTP " + created.status)
    const body = await created.json() as { data?: { id?: string; title?: string } }
    assert.ok(body.data?.id)
    assert.ok(body.data.title, "The real session response must provide its visible title")
    sessions.push(body.data.id)
    sessionTitles.set(body.data.id, body.data.title)
  }
  diagnostics.push({ time: Date.now(), stage, event: "harness-reload-begin" })
  await page.reload()
  diagnostics.push({ time: Date.now(), stage, event: "harness-reload-end" })
  await page.waitForFunction(() => Boolean((window as unknown as { api?: { browserWorkbench?: unknown } }).api?.browserWorkbench))
  await page.evaluate(() => {
    const target = window as unknown as {
      __browserAcceptanceStates: CapturedBrowserState[]
      api: { browserWorkbench: { subscribe: (callback: (state: CapturedBrowserState) => void) => () => void } }
    }
    target.__browserAcceptanceStates = []
    target.api.browserWorkbench.subscribe((state) => {
      target.__browserAcceptanceStates.push(state)
      if (target.__browserAcceptanceStates.length > 1000) target.__browserAcceptanceStates.shift()
    })
  })
  diagnostics.push({ time: Date.now(), stage, event: "renderer-policy-meta",
    policies: await page.evaluate(() => Array.from(document.querySelectorAll("meta[http-equiv]"))
      .filter((element) => element.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy")
      .map((element) => element.getAttribute("content"))) })
  progress("wait-for-home-and-open-real-session-tabs")
  const homeRows = page.locator('[data-component="home-session-row"]')
  await expect(homeRows).toHaveCount(sessions.length, { timeout: 30_000 })
  const guide = page.locator('[data-component="arforge-first-run-guide"]')
  if (await guide.isVisible()) {
    // The guide's first button is its actual dismiss control, before Start.
    await guide.getByRole("button").first().click()
    await expect(guide).toBeHidden()
  }
  // Use the product's background-open gesture while the home list is visible.
  // The subsequent switches then exercise real tab callbacks, not injected links.
  for (const id of sessions) {
    const row = homeRows.filter({ hasText: sessionTitles.get(id)! })
    await expect(row).toHaveCount(1)
    await row.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] })
    await expect(sessionTab(id)).toBeVisible()
  }
  await navigateSession(sessions[0]!)
  checks.push("real home rows and session tabs without document reload; real desktop renderer and preload; registered IPC/Core runtime; isolated v2 server and real sessions")

  progress("ui-browser-open-address-and-native-bounds")
  const start = await openBrowser()
  assert.ok(start.url.startsWith("data:text/html"))
  const first = await navigateWebsite(origin + "/one")
  await assertBounds()
  assert.deepEqual(await nativeValue(first.id, "({api:typeof window.api,node:typeof require,process:typeof process})"),
    { api: "undefined", node: "undefined", process: "undefined" })
  const firstSnapshot = await snapshot(origin + "/one")
  checks.push("actual panel buttons and address form reach native view through real IPC; matching bounds and no host bridge")

  progress("ui-history-and-reload")
  await nativeValue(first.id, "document.getElementById('next').click()")
  await visiblePage(origin + "/two")
  await button("\u540e\u9000").click()
  await visiblePage(origin + "/one")
  await button("\u524d\u8fdb").click()
  await visiblePage(origin + "/two")
  const beforeReload = requests.filter((path) => path === "/two").length
  await button("\u5237\u65b0").click()
  await expect.poll(() => requests.filter((path) => path === "/two").length).toBeGreaterThan(beforeReload)
  await expect.poll(() => nativeValue(first.id, "document.readyState")).toBe("complete")
  await nativeValue(first.id, "document.getElementById('draft').value='first-session-draft';document.cookie='fixture=first;path=/'")
  checks.push("renderer back/forward/reload controls drive actual navigation and network reload")

  progress("file-mode-state-retention")
  await button("\u6587\u4ef6\u4e0e\u66f4\u6539").click()
  await hiddenPages()
  assert.equal((await nativePages()).find((item) => item.id === first.id)?.muted, true)
  assert.equal((await openBrowser()).id, first.id)
  assert.equal(await nativeValue(first.id, "document.getElementById('draft').value"), "first-session-draft")
  checks.push("files/browser UI toggle hides and mutes native content while retaining its page and draft")

  progress("real-host-menu-and-window-resize")
  const modelControl = page.locator('[data-component="prompt-input-v2"] [data-action="prompt-model"]')
  await expect(modelControl).toBeVisible()
  await modelControl.click()
  const menu = page.locator('[role="menu"]:visible, [role="dialog"]:visible').first()
  await expect(menu).toBeVisible()
  await hiddenPages()
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  await visiblePage(origin + "/two")
  await application.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows().find((win) => win.webContents.id === id)!.setContentSize(1320, 920)
  }, ownerID)
  await expect.poll(() => page!.evaluate(() => innerWidth)).toBe(1320)
  await assertBounds()
  checks.push("real model menu suppresses native content; dismissal and real window resize restore correctly bounded content")

  progress("real-session-switch-isolation")
  await navigateSession(sessions[1]!)
  await hiddenPages()
  const second = await openBrowser()
  assert.notEqual(second.id, first.id)
  await navigateWebsite(origin + "/other")
  assert.equal(await nativeValue(second.id, "document.cookie"), "")
  await nativeValue(second.id, "document.getElementById('draft').value='second-session-draft'")
  const secondSnapshot = await snapshot(origin + "/other")
  assert.notEqual(secondSnapshot.scope, firstSnapshot.scope)
  await navigateSession(sessions[0]!)
  await hiddenPages()
  assert.equal((await openBrowser()).id, first.id)
  await visiblePage(origin + "/two")
  assert.equal(await nativeValue(first.id, "document.getElementById('draft').value"), "first-session-draft")
  checks.push("real session routing resets browser mode; per-session native page, cookie, URL and draft isolation survive switching")

  progress("ui-close-reopen-and-stale-ipc-handle")
  const closeStarted = Date.now()
  await button("\u5173\u95ed\u9875\u9762").click()
  await hiddenPages()
  // Hiding a view and destroying its native contents are distinct asynchronous events.
  // Observe real destruction with a deadline; never force-close here to make the test pass.
  await expect.poll(() => application!.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)
    return !contents || contents.isDestroyed()
  }, first.id), { timeout: 10_000, message: "Closed browser contents were not destroyed" }).toBe(true)
  diagnostics.push({ time: Date.now(), stage, event: "native-page-destroyed",
    contents_id: first.id, elapsed_ms: Date.now() - closeStarted })
  const reopened = await openBrowser()
  assert.notEqual(reopened.id, first.id)
  assert.ok(reopened.url.startsWith("data:text/html"))
  await expect(panel().getByLabel("\u7f51\u7ad9\u5730\u5740", { exact: true })).toHaveValue("")
  const stale = await page.evaluate(async (old) => {
    try {
      await (window as unknown as { api: { browserWorkbench: {
        command: (scope: string, pageID: string, command: { action: "reload" }) => Promise<unknown>
      } } }).api.browserWorkbench.command(old.scope, old.pageID, { action: "reload" })
      return false
    } catch { return true }
  }, firstSnapshot)
  assert.equal(stale, true)
  assert.equal((await visiblePage()).id, reopened.id)
  checks.push("UI close destroys the original native contents; reopen starts clean and old preload/IPC handle is rejected")

  progress("unregistered-owner-ipc-rejection")
  const rejected = await application.evaluate(async ({ BrowserWindow }, preload) => {
    const foreign = new BrowserWindow({ show: false, webPreferences: {
      preload, sandbox: true, contextIsolation: true,
    } })
    try {
      await foreign.loadURL("data:text/html,<title>Unregistered acceptance owner</title>")
      return await foreign.webContents.executeJavaScript(
        "window.api.browserWorkbench.open('unregistered-acceptance-scope').then(()=>false,()=>true)",
      )
    } finally { foreign.destroy() }
  }, join(desktopRoot, "out/preload/index.js"))
  assert.equal(rejected, true)
  checks.push("real preload invocation from an unregistered window is refused by the production IPC owner guard")

  progress("core-journal-and-evidence")
  await expect.poll(() => diagnostics.some((entry) =>
    entry.event === "api-response" && entry.path === "/api/vcs/diff" && entry.status === 200),
    { timeout: 20_000, message: "The real renderer did not receive a successful VCS diff response" }).toBe(true)
  assert.equal(diagnostics.some((entry) => entry.event === "renderer-console" &&
    String(entry.message).includes("[session-review] failed to load vcs diff")), false,
    "The VCS diff UI still reported an error")
  report.vcs_diff_responses = diagnostics.filter((entry) =>
    entry.event === "api-response" && entry.path === "/api/vcs/diff").map((entry) => entry.status)
  await navigateWebsite(origin + "/evidence")
  await assertBounds()
  await page.screenshot({ path: join(runRoot, "desktop-browser-host.png"), fullPage: true })
  const png = await application.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id)!
    return (await contents.capturePage()).toPNG().toString("base64")
  }, reopened.id)
  await writeFile(join(runRoot, "desktop-browser-native-page.png"), Buffer.from(png, "base64"))
  const reopenedSnapshot = await snapshot(origin + "/evidence")
  assert.equal(reopenedSnapshot.scope, firstSnapshot.scope)
  assert.notEqual(reopenedSnapshot.pageID, firstSnapshot.pageID)
  const journal = (await readFile(join(profile, "native-actions.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean)
  const browserRecords = journal.map((line) => JSON.parse(line) as BrowserJournalReceipt)
    .filter((record) => record.name === "workbench-browser" || record.name === "workbench-browser-layout")
  assert.ok(browserRecords.length > 0, "Core did not persist any browser native action")
  const receiptFields = new Set([
    "actionID", "traceID", "senderID", "kind", "name", "inputDigest", "state", "observationStatus",
    "timeCreated", "timeUpdated", "outputDigest", "outputByteLength", "errorCode",
  ])
  const privateValues = [
    origin, firstSnapshot.scope, secondSnapshot.scope, ...sessions,
    "unregistered-acceptance-scope", "first-session-draft", "second-session-draft",
  ]
  const actions = new Map<string, BrowserJournalReceipt[]>()
  for (const record of browserRecords) {
    // Inspect decoded values, not raw JSON substrings: escaped scopes must not evade the check.
    for (const [key, value] of Object.entries(record)) {
      assert.ok(receiptFields.has(key), "Unexpected persisted Core receipt field: " + key)
      if (typeof value === "string")
        for (const privateValue of privateValues)
          assert.equal(value.includes(privateValue), false, "Raw browser input leaked into Core field: " + key)
    }
    assert.match(record.actionID, /^act_native_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert.equal(record.traceID, record.actionID.replace("act_native_", "trace_native_"))
    assert.equal(record.senderID, ownerID, "An unregistered window reached the Core browser journal")
    assert.equal(record.kind, "window")
    assert.match(record.inputDigest, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(record.timeCreated) && record.timeCreated > 0)
    assert.ok(Number.isSafeInteger(record.timeUpdated) && record.timeUpdated >= record.timeCreated)
    const history = actions.get(record.actionID) ?? []
    history.push(record)
    actions.set(record.actionID, history)
  }

  const firstBinding = { scopeDigest: sha256(firstSnapshot.scope), pageID: firstSnapshot.pageID }
  const secondBinding = { scopeDigest: sha256(secondSnapshot.scope), pageID: secondSnapshot.pageID }
  const reopenedBinding = { scopeDigest: sha256(reopenedSnapshot.scope), pageID: reopenedSnapshot.pageID }
  const bindings: Array<{ label: string; payload: Record<string, string> }> = [
    { label: "first-session open", payload: { action: "open", scopeDigest: firstBinding.scopeDigest } },
    { label: "second-session open", payload: { action: "open", scopeDigest: secondBinding.scopeDigest } },
    { label: "first-session navigation", payload: { action: "navigate", ...firstBinding, addressDigest: sha256(origin + "/one") } },
    { label: "second-session navigation", payload: { action: "navigate", ...secondBinding, addressDigest: sha256(origin + "/other") } },
    { label: "reopened-page navigation", payload: { action: "navigate", ...reopenedBinding, addressDigest: sha256(origin + "/evidence") } },
    { label: "back", payload: { action: "back", ...firstBinding } },
    { label: "forward", payload: { action: "forward", ...firstBinding } },
    { label: "reload", payload: { action: "reload", ...firstBinding } },
    { label: "close", payload: { action: "close", ...firstBinding } },
  ]
  const staleDigest = browserInputDigest({ action: "reload", ...firstBinding })
  const settled: BrowserJournalReceipt[] = []
  let staleRejections = 0
  let layoutActions = 0
  for (const [actionID, history] of actions) {
    const initial = history[0]!
    for (let index = 0; index < history.length; index++) {
      const current = history[index]!
      for (const key of ["traceID", "senderID", "kind", "name", "inputDigest", "timeCreated"] as const)
        assert.equal(current[key], initial[key], "Core action binding changed: " + actionID + "/" + key)
      if (index > 0) assert.ok(current.timeUpdated >= history[index - 1]!.timeUpdated)
    }
    assert.equal(initial.timeUpdated, initial.timeCreated)
    const terminal = history[history.length - 1]!
    if (terminal.state === "settled") {
      assert.deepEqual(history.map((record) => record.state), ["proposed", "executing", "observed", "settled"])
      assert.deepEqual(history.map((record) => record.observationStatus), ["unknown", "unknown", "succeeded", "succeeded"])
      const observed = history[2]!
      assert.match(observed.outputDigest!, /^[a-f0-9]{64}$/)
      assert.ok(Number.isSafeInteger(observed.outputByteLength) && observed.outputByteLength! >= 0)
      assert.equal(terminal.outputDigest, observed.outputDigest)
      assert.equal(terminal.outputByteLength, observed.outputByteLength)
      for (const record of history) assert.equal(record.errorCode, undefined)
      settled.push(terminal)
      if (terminal.name === "workbench-browser-layout") {
        // commitLayout returns undefined; Core records its canonical JSON value, null.
        assert.equal(terminal.outputDigest, sha256("null"))
        assert.equal(terminal.outputByteLength, 4)
        layoutActions++
      }
    } else {
      // The deliberate stale-handle probe throws an ordinary operation error.
      // Core conservatively records recovery_required/unknown, not blocked/failed.
      assert.equal(terminal.name, "workbench-browser")
      assert.equal(terminal.inputDigest, staleDigest, "Unexpected failed browser action")
      assert.deepEqual(history.map((record) => record.state), ["proposed", "executing", "recovery_required"])
      assert.deepEqual(history.map((record) => record.observationStatus), ["unknown", "unknown", "unknown"])
      assert.equal(terminal.errorCode, "NATIVE_ACTION_OPERATION_FAILED")
      assert.equal(terminal.outputDigest, undefined)
      assert.equal(terminal.outputByteLength, undefined)
      staleRejections++
    }
    for (const record of history.slice(0, 2)) {
      assert.equal(record.outputDigest, undefined)
      assert.equal(record.outputByteLength, undefined)
      assert.equal(record.errorCode, undefined)
    }
  }
  assert.equal(staleRejections, 1, "Only the intentional stale-handle probe may fail")
  assert.ok(layoutActions > 0, "No real Core layout action completed")
  for (const binding of bindings) {
    const expectedDigest = browserInputDigest(binding.payload)
    assert.ok(settled.some((record) => record.name === "workbench-browser" && record.inputDigest === expectedDigest),
      "Core inputDigest does not bind the actual UI operation: " + binding.label)
  }
  report.browser_journal_audit = {
    actions: actions.size, settled_actions: settled.length, layout_actions: layoutActions,
    stale_handle_rejections: staleRejections, command_bindings: bindings.map((binding) => binding.label),
    privacy: "no raw browser URL, session scope, session ID or fixture draft in receipts",
  }
  checks.push("real Core journal binds nine UI commands by canonical inputDigest; action lifecycles, intentional stale rejection and receipt privacy verified")
  assert.deepEqual(rendererErrors, [])
  assert.deepEqual(apiFailures, [])
  assert.equal(modelRequests, 0)
  report.browser_journal_records = browserRecords.length
  report.native_pages = await nativePages()
  report.evidence = [join(runRoot, "desktop-browser-host.png"), join(runRoot, "desktop-browser-native-page.png")]
  report.passed = true
  progress("complete")
} catch (error) {
  failure = error
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
  if (page) {
    await page.screenshot({ path: join(runRoot, "failure.png"), fullPage: true, timeout: 5000 }).catch(() => undefined)
    report.renderer_text = await page.locator("body").innerText({ timeout: 3000 })
      .then((text) => text.slice(-8000)).catch(() => undefined)
  }
} finally {
  if (application)
    report.security_console = await application.evaluate(() =>
      (globalThis as unknown as { __browserAcceptanceSecurity?: Array<Record<string, unknown>> })
        .__browserAcceptanceSecurity ?? []).catch(() => [])
  await Promise.race([Promise.all([...diagnosticTasks]), sleep(3000)])
  report.diagnostics = diagnostics
  if (tracing && page)
    await page.context().tracing.stop({ path: join(runRoot, "trace.zip") }).catch(() => undefined)
  if (application)
    await Promise.race([application.close().catch(() => undefined), sleep(8000)])
  if (processHandle?.pid && processHandle.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(processHandle.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 })
    for (let i = 0; i < 20 && processHandle.exitCode === null; i++) await sleep(100)
  }
  if (processHandle?.pid && processHandle.exitCode === null) {
    report.passed = false
    report.cleanup_error = "Owned acceptance process did not exit; profile retained"
    failure ??= new Error(String(report.cleanup_error))
  }
  if (bound) {
    fixture.closeAllConnections()
    await new Promise<void>((done) => fixture.close(() => done()))
  }
  Object.assign(report, { stage, checks, renderer_errors: rendererErrors, api_failures: apiFailures,
    model_requests: modelRequests, app_stdout: appStdout, app_stderr: appStderr })
  await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2), "utf8")
  await writeFile(join(artifacts, "desktop-browser-workbench-audit.json"), JSON.stringify(report, null, 2), "utf8")
}
process.stdout.write("BROWSER_DESKTOP_ACCEPTANCE " + JSON.stringify(report) + "\n")
process.exitCode = failure || report.passed !== true ? 1 : 0
