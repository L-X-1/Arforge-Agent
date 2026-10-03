import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, expect, type Browser, type Page, type Request as PlaywrightRequest } from "@playwright/test"

// Real built Electron application, HTTP API, approval queue, filesystem and
// preview. Only the remote model is replaced by a loopback streaming fixture.
// Run with Node.js after rebuilding packages/desktop so the sidecar is current:
// node packages/app/e2e/desktop-html-selection-edit.acceptance.ts
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const desktopRoot = join(root, "packages/desktop")
const artifactRoot = join(root, "artifacts")
const sleep = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds))
const identity = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value)
const scenarios = ["approved", "declined", "stale"] as const
type Scenario = (typeof scenarios)[number]
type Guard = { path: string; directory: string; revision: string; mode: string; start: number; end: number }
type ProviderRequest = {
  messages?: Array<{ role: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }>
}
const oldString = '<h1 id="title">Before</h1>'
const newString = '<h1 id="title" style="font-size:48px">After</h1>'
const source = "<!doctype html>\n<html><body>\n" + oldString + "\n<p>Keep this paragraph.</p>\n</body></html>\n"
const changedSource = source.replace(oldString, newString)
const concurrentSource = source + "<p>Concurrent change outside the selection.</p>\n"
const revision = createHash("sha256").update(source).digest("hex")
const tempBase = resolve(tmpdir())
const temp = await mkdtemp(join(tempBase, "arforge-html-selection-desktop-"))
const workspace = join(temp, "workspace")
const profile = join(temp, "electron-profile")
const home = join(temp, "home")
const database = join(temp, "html-selection.db")
const cases = new Map<Scenario, { requests: number; guard: Guard; receipt?: string }>()
const providerFailures: string[] = []
const rendererErrors: string[] = []
const apiFailures: Array<{ url: string; status: number }> = []
const caseResults: Record<string, unknown>[] = []
let stage = "prepare"
let appProcess: ChildProcess | undefined
let browser: Browser | undefined
let page: Page | undefined
let appStdout = ""
let appStderr = ""
let failure: unknown
let providerBound = false
let tracing = false
let titleRequests = 0
const report: Record<string, unknown> = {
  schema_version: 1,
  passed: false,
  launch_mode: "build",
  model_mode: "loopback-fixture",
  isolated_workspace: workspace,
}

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part) =>
    part && typeof part === "object" && typeof part.text === "string" ? [part.text] : [],
  ).join("\n")
}
const stream = (response: ServerResponse, delta: Record<string, unknown>, reason: "stop" | "tool_calls") => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const chunk = (value: Record<string, unknown>) => JSON.stringify({
    id: "chatcmpl-html-selection",
    object: "chat.completion.chunk",
    choices: [value],
  })
  response.end([
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta }),
    JSON.stringify({
      id: "chatcmpl-html-selection",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: reason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    "[DONE]",
  ].map((event) => "data: " + event + "\n\n").join(""))
}
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) {
      raw += String(chunk)
      assert.ok(raw.length <= 2_000_000, "Fixture provider request exceeded its bound")
    }
    const body = JSON.parse(raw) as ProviderRequest
    const messages = body.messages ?? []
    const text = messages.map((message) => contentText(message.content)).join("\n")
    // Title generation is a separate, tool-free background request. Match its
    // system instruction, never the quoted HTML/user content in the request.
    if (!body.tools?.length && messages.some((message) =>
      message.role === "system" && /You are a title generator\.|Generate a title for this conversation/i.test(contentText(message.content)),
    )) {
      titleRequests++
      stream(response, { content: "HTML selection desktop acceptance" }, "stop")
      return
    }
    const captured = /<html_edit_guard_json>\s*([\s\S]*?)\s*<\/html_edit_guard_json>/.exec(text)
    assert.ok(captured, "The desktop request did not carry the captured HTML edit guard")
    const guard = JSON.parse(captured[1]!) as Guard
    const scenario = basename(guard.path).replace(/\.html$/, "") as Scenario
    assert.ok(scenarios.includes(scenario), "The captured reference points outside the fixture files")
    assert.equal(identity(guard.directory), identity(workspace))
    assert.equal(identity(resolve(workspace, guard.path)), identity(join(workspace, scenario + ".html")))
    assert.equal(guard.revision, revision)
    assert.equal(guard.mode, "file-preview")
    assert.equal(guard.start, source.indexOf(oldString))
    assert.equal(guard.end, source.indexOf(oldString) + oldString.length)
    let current = cases.get(scenario)
    if (!current) {
      const edit = body.tools?.find((tool) => tool.function?.name === "edit")
      assert.ok(edit?.function?.parameters?.properties?.htmlSelection, "The desktop did not advertise guarded edit")
      current = { requests: 0, guard }
      cases.set(scenario, current)
    }
    current.requests++
    assert.ok(current.requests <= 2, "Unexpected extra model continuation")
    assert.deepEqual(guard, current.guard, "A captured HTML reference changed during the turn")
    if (current.requests === 1) {
      stream(response, {
        tool_calls: [{
          index: 0,
          id: "call_html_desktop_" + scenario,
          type: "function",
          function: {
            name: "edit",
            arguments: JSON.stringify({ path: guard.path, oldString, newString, htmlSelection: guard }),
          },
        }],
      }, "tool_calls")
      return
    }
    assert.notEqual(scenario, "declined", "The model continued after the user declined approval")
    current.receipt = messages.filter((message) => message.role === "tool")
      .map((message) => contentText(message.content)).join("\n")
    assert.ok(current.receipt.length > 0, "The model did not receive the real tool result")
    if (scenario === "approved") assert.match(current.receipt, /Edited file successfully/)
    else assert.doesNotMatch(current.receipt, /Edited file successfully/)
    stream(response, {
      content: scenario === "approved" ? "HTML acceptance: saved." : "HTML acceptance: refresh the changed selection.",
    }, "stop")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    providerFailures.push(message)
    if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message, type: "fixture_error" } }))
  }
})

try {
  for (const directory of [workspace, profile, home, artifactRoot]) await mkdir(directory, { recursive: true })
  for (const scenario of scenarios) await writeFile(join(workspace, scenario + ".html"), source, "utf8")
  await new Promise<void>((done, fail) => {
    provider.once("error", fail)
    provider.listen(0, "127.0.0.1", done)
  })
  providerBound = true
  const address = provider.address()
  assert.ok(address && typeof address !== "string")
  await writeFile(join(workspace, "arforge.json"), JSON.stringify({
    $schema: "urn:arforge:config",
    formatter: false,
    lsp: false,
    provider: {
      test: {
        name: "HTML selection desktop fixture",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "HTML Selection Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: new Date().toISOString().slice(0, 10),
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "html-selection-fixture-key", baseURL: "http://127.0.0.1:" + address.port + "/v1" },
      },
    },
  }), "utf8")

  stage = "launch isolated desktop"
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(key)) delete env[key]
  }
  delete env.ARFORGE_CONFIG
  delete env.ARFORGE_CONFIG_DIR
  delete env.ARFORGE_CONFIG_CONTENT
  appProcess = spawn(join(desktopRoot, "node_modules/electron/dist/electron.exe"), [
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    desktopRoot,
  ], {
    cwd: workspace,
    env: {
      ...env,
      ARFORGE_HOME: home,
      ARFORGE_DB: database,
      ARFORGE_DATABASE_MODE: "local",
      ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
      ARFORGE_DB_URL: "",
      ARFORGE_DB_ADMIN_URL: "",
      ARFORGE_MULTIAGENT_DB_URL: "",
      NODE_ENV: "production",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  appProcess.on("error", (error) => { failure = error })
  appProcess.stdout?.on("data", (chunk) => { appStdout = (appStdout + String(chunk)).slice(-20_000) })
  appProcess.stderr?.on("data", (chunk) => { appStderr = (appStderr + String(chunk)).slice(-20_000) })
  let endpoint = ""
  const deadline = Date.now() + 60_000
  while (!endpoint && Date.now() < deadline) {
    if (failure) throw failure
    if (appProcess.exitCode !== null) throw new Error("Isolated desktop exited before CDP was ready")
    let port = Number(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(appStderr)?.[1] ?? 0)
    if (!port) {
      for (const file of [join(profile, "DevToolsActivePort"), join(profile, "session/DevToolsActivePort")]) {
        const raw = await readFile(file, "utf8").catch(() => "")
        port = Number(raw.split(/\r?\n/, 1)[0])
        if (port > 0) break
      }
    }
    if (Number.isInteger(port) && port > 0) {
      const version = await fetch("http://127.0.0.1:" + port + "/json/version").then((value) => value.json()).catch(() => undefined) as
        { webSocketDebuggerUrl?: string } | undefined
      endpoint = version?.webSocketDebuggerUrl ?? ""
    }
    if (!endpoint) await sleep(200)
  }
  assert.ok(endpoint, "Isolated desktop CDP startup timed out")
  browser = await chromium.connectOverCDP(endpoint)
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("arforge://renderer"))
    if (!page) await sleep(200)
  }
  assert.ok(page, "The isolated Electron renderer is missing")
  page.setDefaultTimeout(20_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  tracing = true
  page.on("pageerror", (error) => rendererErrors.push(error.message))
  const apiOrigins = new Set<string>()
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname.startsWith("/api/")) {
      apiOrigins.add(url.origin)
    }
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (response.status() >= 400 && /^\/api\/(?:session|file)(?:\/|$)/.test(url.pathname)) {
      apiFailures.push({ url: url.pathname, status: response.status() })
    }
  })
  stage = "configure isolated renderer"
  await page.waitForFunction(() => Boolean((window as unknown as { api?: { storeSet?: unknown } }).api?.storeSet))
  await page.evaluate(async (directory) => {
    const api = (window as unknown as {
      api: { storeSet: (file: string, key: string, value: string) => Promise<void> }
    }).api
    await api.storeSet("default.dat", "settings.v3", JSON.stringify({
      general: {
        newLayoutDesigns: true,
        showFileTree: true,
        newInterfaceNoticeDismissed: true,
        shouldDisplayTabsToast: false,
      },
      permissions: { autoApprove: false },
      sounds: { agentEnabled: false, permissionsEnabled: false, errorsEnabled: false },
      notifications: { agent: false, permissions: false, errors: false },
    }))
    await api.storeSet("arforge.global.dat", "server", JSON.stringify({
      projects: { local: [{ worktree: directory, expanded: true }] },
      lastProject: { local: directory },
      recentlyClosed: { local: [] },
    }))
    await api.storeSet("arforge.global.dat", "layout", JSON.stringify({
      review: { diffStyle: "split", panelOpened: true },
    }))
    await api.storeSet("arforge.global.dat", "review-panel-v2", JSON.stringify({
      sidebarOpened: true, sidebarWidth: 260, expandMode: "collapse",
    }))
  }, workspace)
  await page.reload()
  const skip = page.getByRole("button", { name: /Skip for now|\u6682\u65f6\u8df3\u8fc7|\u7a0d\u5f8c\u518d\u8aaa/i })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await expect.poll(() => apiOrigins.size, { timeout: 60_000 }).toBeGreaterThan(0)
  const apiOrigin = apiOrigins.values().next().value!

  for (const scenario of scenarios) {
    if (scenario === "approved") {
      stage = "verify the actual current protocol handshake"
      const health = await fetch(apiOrigin + "/api/health")
      assert.ok(health.ok, "Current health check failed with HTTP " + health.status)
      const healthBody = await health.json() as { healthy?: boolean; protocol?: string }
      assert.equal(healthBody.healthy, true)
      assert.equal(healthBody.protocol, "v2", "The built sidecar did not advertise its current message protocol")
      report.protocol_verified = healthBody.protocol
      stage = "verify the configured model in the current runtime catalog"
      process.stdout.write("HTML desktop acceptance: " + stage + "\n")
      const current = await fetch(apiOrigin + "/api/model?" + new URLSearchParams({ "location[directory]": workspace }))
      assert.ok(current.ok, "Current model catalog failed with HTTP " + current.status)
      const currentBody = await current.json() as {
        data?: Array<{ id: string; providerID: string; capabilities: { tools: boolean; input: string[]; output: string[] } }>
      }
      const configured = currentBody.data?.find((item) => item.providerID === "test" && item.id === "test-model")
      assert.ok(configured, "The real runtime did not load the configured test model")
      assert.equal(configured.capabilities.tools, true)
      assert.ok(configured.capabilities.input.includes("text"))
      assert.ok(configured.capabilities.output.includes("text"))

      report.current_catalog_verified = true
    }
    stage = scenario + ": create real session"
    process.stdout.write("HTML desktop acceptance: " + stage + "\n")
    const created = await fetch(apiOrigin + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: workspace }, model: { providerID: "test", id: "test-model" } }),
    })
    assert.ok(created.ok, "Real session creation failed: HTTP " + created.status)
    const body = await created.json() as { data?: { id?: string } }
    const sessionID = body.data?.id
    assert.ok(sessionID, "Real session creation did not return an ID")
    await page.evaluate((route) => {
      const link = document.createElement("a")
      link.href = route
      document.body.appendChild(link)
      link.click()
      link.remove()
    }, "/server/c2lkZWNhcg/session/" + encodeURIComponent(sessionID))
    const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 60_000 })
    const file = scenario + ".html"
    stage = scenario + ": capture HTML selection in the UI"
    await page.locator("#review-panel").getByRole("button", {
      name: /^(Open file|\u6253\u5f00\u6587\u4ef6|\u958b\u555f\u6a94\u6848)$/i,
    }).click()
    const fileBrowser = page.locator("#session-side-panel-file-browser-tabpanel")
    await expect(fileBrowser).toBeVisible()
    await fileBrowser.getByRole("button", { name: file, exact: true }).dblclick()
    await page.getByRole("button", { name: /^(Preview|\u9884\u89c8)$/ }).click()
    const previewHeading = () => page!.frameLocator("iframe:visible").last().getByRole("heading", { name: "Before", exact: true })
    await expect(previewHeading()).toBeVisible()
    await page.getByRole("button", { name: /^(Select elements|\u9009\u62e9\u5143\u7d20)$/i }).click()
    const reference = page.getByRole("button", { name: /^(Reference in AI|\u5f15\u7528\u5230 AI)$/i })
    await expect(reference).toBeVisible()
    await previewHeading().click()
    await reference.click()
    const card = page.getByText(/^HTML (?:source snapshot|\u6e90\u7801\u5feb\u7167) \/ [a-f0-9]{12}$/)
    await expect(card).toHaveCount(1)
    const capturedCaption = await card.innerText()
    stage = scenario + ": select fixture model and send the captured reference"
    process.stdout.write("HTML desktop acceptance: " + stage + "\n")
    const modelControl = page.locator('[data-component="prompt-input-v2"] [data-action="prompt-model"]')
    await expect(modelControl).toBeVisible({ timeout: 60_000 })
    await modelControl.click()
    const modelPicker = page.locator('[role="menu"]:visible, [role="dialog"]:visible')
    await expect(modelPicker).toBeVisible()
    await modelPicker.getByText("HTML Selection Test Model", { exact: true }).click()
    await expect(modelPicker).toBeHidden()
    await expect(modelControl).toContainText("HTML Selection Test Model")
    await editor.fill("Change only the selected heading to After with a 48px font size. Ask for approval before saving.")
    await editor.press("Enter")
    await expect.poll(() => cases.has(scenario), { timeout: 30_000 }).toBe(true)

    stage = scenario + ": wait for visible human approval"
    process.stdout.write("HTML desktop acceptance: " + stage + "\n")
    const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
    await expect(permission).toBeVisible({ timeout: 30_000 })
    await expect(permission.locator('[data-variant="human-confirmation"]')).toBeVisible()
    const buttons = permission.locator('[data-slot="permission-footer-actions"] button')
    await expect(buttons).toHaveCount(2)
    assert.deepEqual(await readFile(join(workspace, file)), Buffer.from(source, "utf8"))
    assert.equal(cases.get(scenario)!.requests, 1)
    if (scenario === "stale") await writeFile(join(workspace, file), concurrentSource, "utf8")
    const replyRequest: Promise<PlaywrightRequest> = page.waitForRequest((request) => {
      const url = new URL(request.url())
      const current = url.pathname.startsWith("/api/session/" + sessionID + "/permission/")
        && url.pathname.endsWith("/reply")
      const legacy = /^\/permission\/[^/]+\/reply$/.test(url.pathname)
      return request.method() === "POST" && url.origin === apiOrigin && (current || legacy)
    })
    await (scenario === "declined" ? buttons.first() : buttons.last()).click()
    const reply: PlaywrightRequest = await replyRequest
    const replyPath = new URL(reply.url()).pathname
    assert.ok(replyPath.startsWith("/api/session/" + sessionID + "/permission/"),
      "The dual-protocol desktop selected a legacy approval route instead of its current message owner: " + replyPath)
    assert.deepEqual(reply.postDataJSON(), { reply: scenario === "declined" ? "reject" : "once" })
    assert.equal((await reply.response())?.ok(), true)
    await expect(permission).toHaveCount(0)

    stage = scenario + ": verify source and renderer outcome"
    if (scenario === "declined") {
      await expect(editor).toBeVisible()
      await sleep(350)
      assert.equal(cases.get(scenario)!.requests, 1)
      assert.deepEqual(await readFile(join(workspace, file)), Buffer.from(source, "utf8"))
      await expect(previewHeading()).toBeVisible()
    } else {
      const finalText = scenario === "approved" ? "HTML acceptance: saved." : "HTML acceptance: refresh the changed selection."
      await expect(page.getByText(finalText, { exact: true })).toBeVisible({ timeout: 30_000 })
      assert.equal(cases.get(scenario)!.requests, 2)
      assert.deepEqual(await readFile(join(workspace, file)), Buffer.from(scenario === "approved" ? changedSource : concurrentSource, "utf8"))
      if (scenario === "approved") {
        const heading = () => page!.frameLocator("iframe:visible").last().getByRole("heading", { name: "After", exact: true })
        await expect(heading()).toBeVisible()
        await expect(heading()).toHaveCSS("font-size", "48px")
        await page.reload()
        await expect(page.getByRole("tab", { name: file, exact: true })).toBeVisible({ timeout: 30_000 })
        await expect(page.getByText(finalText, { exact: true })).toBeVisible({ timeout: 30_000 })
        await expect(heading()).toBeVisible()
        await expect(heading()).toHaveCSS("font-size", "48px")
      } else await expect(previewHeading()).toBeVisible()
    }
    caseResults.push({
      scenario,
      session_id: sessionID,
      passed: true,
      captured_caption: capturedCaption,
      human_approval_visible: true,
      permission_endpoint: replyPath,
      provider_requests: cases.get(scenario)!.requests,
      source_verified: true,
      preview_verified: true,
      reload_verified: scenario === "approved",
    })
  }
  assert.deepEqual(providerFailures, [])
  assert.deepEqual(rendererErrors, [])
  assert.deepEqual(apiFailures, [])
  report.passed = true
} catch (error) {
  failure = error
  report.error = error instanceof Error ? error.message : String(error)
  if (page) {
    await page.screenshot({ path: join(artifactRoot, "desktop-html-selection-edit-failure.png"), fullPage: true }).catch(() => undefined)
    report.renderer_text = await page.locator("body").innerText().then((text) => text.slice(-8_000)).catch(() => undefined)
  }
} finally {
  report.stage = stage
  report.cases = caseResults
  report.provider_failures = providerFailures
  report.title_requests = titleRequests
  report.renderer_errors = rendererErrors
  report.api_failures = apiFailures
  if (failure) {
    report.app_stdout = appStdout
    report.app_stderr = appStderr
  }
  if (tracing && page) {
    await page.context().tracing.stop({ path: join(artifactRoot, "desktop-html-selection-edit-trace.zip") }).catch(() => undefined)
  }
  await browser?.close().catch(() => undefined)
  if (appProcess?.pid && appProcess.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(appProcess.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    } else appProcess.kill("SIGTERM")
    for (let attempt = 0; attempt < 20 && appProcess.exitCode === null; attempt++) await sleep(100)
  }
  if (providerBound) {
    provider.closeAllConnections()
    await new Promise<void>((done) => provider.close(() => done()))
  }
  const inside = relative(tempBase, resolve(temp))
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside) && basename(temp).startsWith("arforge-html-selection-desktop-"),
    "Refusing to remove an acceptance directory outside the verified temporary root")
  if (appProcess?.pid && appProcess.exitCode === null) {
    report.passed = false
    report.cleanup_error = "The isolated desktop did not exit; its temporary profile was retained."
    failure ??= new Error(String(report.cleanup_error))
  } else {
    await rm(temp, { recursive: true, force: true }).catch((error) => {
      report.passed = false
      report.cleanup_error = String(error)
      failure ??= error
    })
  }
  await mkdir(artifactRoot, { recursive: true })
  await writeFile(join(artifactRoot, "desktop-html-selection-edit-audit.json"), JSON.stringify(report, null, 2), "utf8")
}
process.stdout.write(JSON.stringify(report, null, 2) + "\n")
if (failure) throw failure
