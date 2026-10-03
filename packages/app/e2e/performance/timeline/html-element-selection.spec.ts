import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { createPreviewResourceHost } from "../../../../server/src/preview-resource-host"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/HtmlElementSelection"
const projectID = "proj_html_element_selection"
const sessionID = "ses_html_element_selection"
const title = "HTML element source locations"
const server = playwrightScenarioServer()
const initial = '<style>h1 { color: rgb(1, 2, 3) }</style>\r\n<section>\r\n  <h1 id="heading" title="Original tooltip" onclick="window.__sourceHandler = true">\u4e2d\u6587 &amp; inspect</h1>\r\n  <p id="first">Repeated</p>\r\n  <p id="second">Repeated</p>\r\n</section>\r\n<script>window.__sourceScript = true</script>'

test.use({ viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" })

async function setup(page: Page, read: () => string) {
  await mockArforgeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "html-selection", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: {
      all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }],
      connected: ["arforge"], default: { providerID: "arforge", modelID: "test" },
    },
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : ["page.html"].map((name) => ({ name, path: name, absolute: `${directory}/${name}`, type: "file", ignored: false })),
    fileContent: () => ({ type: "text", content: read() }),
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("arforge.global.dat:layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    localStorage.setItem("arforge.global.dat:review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }))
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId: sessionID }]))
  }, { directory, server, sessionID })
}

function json(route: Route, data: unknown) {
  return route.fulfill({ contentType: "application/json", headers: {
    "access-control-allow-origin": route.request().headers().origin ?? "*",
    "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS",
  }, body: JSON.stringify({ location: { directory }, data }) })
}

async function openPreview(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  await panel.getByRole("button", { name: "page.html", exact: true }).click()
  const preview = panel.locator('[data-component="file-preview"]:visible')
  await preview.getByRole("button", { name: "Preview", exact: true }).click()
  await expect(preview.locator('[data-component="html-file-preview"] iframe')).toBeVisible()
  return preview
}

test("HTML element selection locates exact source without executing document code or writing files", async ({ page }) => {
  await setup(page, () => initial)
  let writes = 0
  page.on("request", (request) => { if (request.method() === "PUT" && new URL(request.url()).pathname.includes("/fs/")) writes++ })
  const preview = await openPreview(page)
  await preview.getByRole("button", { name: "Select elements", exact: true }).click()
  const picker = preview.locator('[data-component="html-element-preview"]')
  const frame = picker.frameLocator("iframe")
  await expect(picker.getByRole("combobox", { name: "HTML element", exact: true })).toBeEnabled()
  await expect(frame.locator("#heading")).toHaveAttribute("title", "Original tooltip")
  await frame.locator("#heading").click()
  await expect(picker.locator('[data-slot="html-element-location"]')).toContainText("page.html:3:3")
  await picker.getByRole("button", { name: "Locate source", exact: true }).click()
  await expect(picker.getByRole("textbox", { name: "Selected HTML source", exact: true })).toHaveValue(initial.split("\r\n")[2]!.trimStart())
  await expect(picker.getByRole("textbox", { name: "Selected HTML source", exact: true })).toHaveAttribute("readonly", "")
  await expect(picker.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts")
  expect(await picker.locator("iframe").evaluate((node) => (node as HTMLIFrameElement).contentDocument === null)).toBe(true)
  expect(await frame.locator("body").evaluate(() => ({ script: Reflect.get(window, "__sourceScript"), handler: Reflect.get(window, "__sourceHandler") }))).toEqual({ script: undefined, handler: undefined })
  await expect(frame.locator("script")).toHaveCount(1)
  await expect(frame.locator("#heading")).not.toHaveAttribute("onclick")
  await picker.getByRole("combobox", { name: "HTML element", exact: true }).selectOption({ label: "p#second :5" })
  await expect(picker.locator('[data-slot="html-element-location"]')).toContainText("page.html:5:3")
  await picker.getByRole("button", { name: "Locate source", exact: true }).click()
  await expect(picker.getByRole("textbox", { name: "Selected HTML source", exact: true })).toHaveValue('<p id="second">Repeated</p>')
  await page.screenshot({ path: test.info().outputPath("html-element-source.png") })
  await frame.locator("#second").click()
  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)
  await expect(preview.locator('[data-component="html-file-preview"] iframe')).toHaveAttribute("sandbox", "")
  expect(writes).toBe(0)
})

test("HTML element selection clears stale locations after a source refresh", async ({ page }) => {
  let source = initial
  await setup(page, () => source)
  const preview = await openPreview(page)
  await preview.getByRole("button", { name: "Select elements", exact: true }).click()
  const picker = preview.locator('[data-component="html-element-preview"]')
  const frame = picker.frameLocator("iframe")
  await expect(picker.getByRole("combobox", { name: "HTML element", exact: true })).toBeEnabled()
  await frame.locator("#heading").click()
  await picker.getByRole("button", { name: "Locate source", exact: true }).click()
  await expect(picker.getByRole("textbox", { name: "Selected HTML source", exact: true })).toBeVisible()
  source = '\n\n\n<h2 id="replacement">Fresh source</h2>'
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(preview.frameLocator('[data-component="html-file-preview"] iframe').locator("#replacement")).toBeVisible()
  await expect(preview.locator('[data-component="html-file-preview"] iframe')).toHaveAttribute("sandbox", "")
  await preview.getByRole("button", { name: "Select elements", exact: true }).click()
  await expect(picker.getByRole("combobox", { name: "HTML element", exact: true })).toBeEnabled()
  await expect(frame.locator("#replacement")).toBeVisible()
  await expect(picker.locator('[data-slot="html-element-location"]')).toHaveCount(0)
  await expect(picker.getByRole("button", { name: "Locate source", exact: true })).toBeDisabled()
  await expect(picker.getByRole("textbox", { name: "Selected HTML source", exact: true })).toHaveCount(0)
  await frame.locator("#replacement").click()
  await expect(picker.locator('[data-slot="html-element-location"]')).toContainText("page.html:4:1")
  await expectSessionTitle(page, title)
})

test("HTML element selection reuses scoped resources and resets when resource access is disabled", async ({ page }) => {
  await setup(page, () => initial + '<link rel="stylesheet" href="main.css">')
  const host = createPreviewResourceHost()
  let opens = 0
  let revocations = 0
  try {
    await page.route("**/api/fs/preview/open?**", async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {})
      opens++
      await json(route, await host.open("fixture-owner", "page.html", async () => ({ mime: "text/css", bytes: new TextEncoder().encode("#heading { color: rgb(10, 120, 30) }") })))
    })
    await page.route("**/api/fs/preview/close?**", async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {})
      const payload = route.request().postDataJSON() as { id: string }
      const revoked = host.revoke("fixture-owner", payload.id)
      if (revoked) revocations++
      await json(route, { revoked })
    })
    const preview = await openPreview(page)
    await preview.getByRole("button", { name: "Load local resources", exact: true }).click()
    await expect(preview.frameLocator('[data-component="html-file-preview"] iframe').locator("#heading")).toHaveCSS("color", "rgb(10, 120, 30)")
    await preview.getByRole("button", { name: "Select elements", exact: true }).click()
    const picker = preview.locator('[data-component="html-element-preview"]')
    const frame = picker.frameLocator("iframe")
    await expect(frame.locator("#heading")).toHaveCSS("color", "rgb(10, 120, 30)")
    await expect(picker.getByRole("combobox", { name: "HTML element", exact: true })).toBeEnabled()
    await frame.locator("#heading").click()
    await expect(picker.getByRole("button", { name: "Locate source", exact: true })).toBeEnabled()
    expect(opens).toBe(1)
    await preview.getByRole("button", { name: "Disable local resources", exact: true }).click()
    await expect.poll(() => revocations).toBe(1)
    await expect(frame.locator("#heading")).toHaveCSS("color", "rgb(1, 2, 3)")
    await expect(picker.getByRole("button", { name: "Locate source", exact: true })).toBeDisabled()
    await expect(picker.getByRole("combobox", { name: "HTML element", exact: true })).toBeEnabled()
  } finally { await host.close() }
})
