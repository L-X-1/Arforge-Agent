import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { createPreviewResourceHost } from "../../../../server/src/preview-resource-host"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/HtmlResources"
const projectID = "proj_html_resources"
const sessionID = "ses_html_resources"
const title = "Isolated HTML resources"
const server = playwrightScenarioServer()
const source = `<style>#heading { color: rgb(1, 2, 3) }</style>
<link rel="stylesheet" href="styles/main.css">
<h1 id="heading">Resource preview</h1><img id="local-image" src="pixel.png"><div id="paint">Paint</div>
<script>window.__resourceScriptExecuted = true</script>`
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7V0AAAAASUVORK5CYII=", "base64")

test.use({ viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" })

async function setup(page: Page) {
  await mockArforgeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "html-resources", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: {
      all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }],
      connected: ["arforge"], default: { providerID: "arforge", modelID: "test" },
    },
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : ["page.html", "other.html"].map((name) => ({ name, path: name, absolute: `${directory}/${name}`, type: "file", ignored: false })),
    fileContent: () => ({ type: "text", content: source }),
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("arforge.global.dat:layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    localStorage.setItem("arforge.global.dat:review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }))
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId: sessionID }]))
  }, { directory, server, sessionID })
}

function json(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: {
    "access-control-allow-origin": route.request().headers().origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "POST, OPTIONS",
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
  return { panel, preview, frame: preview.frameLocator('[data-component="html-file-preview"] iframe') }
}

test("HTML resources load only after opt-in, remain sandboxed and revoke on disable", async ({ page }) => {
  await setup(page)
  const host = createPreviewResourceHost()
  const reads: string[] = []
  const grants: Awaited<ReturnType<typeof host.open>>[] = []
  let revoked = 0
  let externalRequests = 0
  const assetHeaders: Record<string, string>[] = []
  try {
    await page.context().addCookies([{ name: "main-session", value: "must-not-reach-assets", url: server }])
    await page.route("http://127.0.0.2:*/resources/**", async (route) => {
      assetHeaders.push(await route.request().allHeaders())
      await route.continue()
    })
    await page.route("https://arforge-preview.invalid/**", async (route) => { externalRequests++; await route.abort() })
    await page.route("**/api/fs/preview/open?**", async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {})
      const grant = await host.open("fixture-owner", "page.html", async (path) => {
        reads.push(path)
        if (path === "pixel.png") return { mime: "image/png", bytes: pixel }
        if (path === "styles/main.css") return { mime: "text/css", bytes: new TextEncoder().encode('@import url("https://arforge-preview.invalid/blocked.css"); @import "theme.css"; #paint { background-image: url("../pixel.png") }') }
        if (path === "styles/theme.css") return { mime: "text/css", bytes: new TextEncoder().encode("#heading { color: rgb(10, 120, 30) }") }
        throw new Error("Missing fixture asset")
      })
      grants.push(grant)
      await json(route, grant)
    })
    await page.route("**/api/fs/preview/close?**", async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {})
      const payload = route.request().postDataJSON() as { id: string }
      const result = host.revoke("fixture-owner", payload.id)
      if (result) revoked++
      await json(route, { revoked: result })
    })
    const { preview, frame } = await openPreview(page)
    await expect(frame.locator("#heading")).toHaveCSS("color", "rgb(1, 2, 3)")
    expect(reads).toEqual([])
    await preview.getByRole("button", { name: "Load local resources", exact: true }).click()
    await expect(frame.locator("#heading")).toHaveCSS("color", "rgb(10, 120, 30)")
    await expect.poll(() => frame.locator("#local-image").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1)
    expect(reads).toContain("styles/main.css")
    expect(reads).toContain("styles/theme.css")
    expect(reads).toContain("pixel.png")
    expect(externalRequests).toBe(0)
    expect(assetHeaders.length).toBeGreaterThan(0)
    for (const headers of assetHeaders) {
      expect(headers.authorization).toBeUndefined()
      expect(headers.cookie).toBeUndefined()
    }
    await expect(preview.locator("iframe")).toHaveAttribute("sandbox", "")
    expect(await frame.locator("body").evaluate(() => Reflect.get(window, "__resourceScriptExecuted"))).toBeUndefined()
    expect(await preview.locator("iframe").evaluate((node) => (node as HTMLIFrameElement).contentDocument === null)).toBe(true)
    await page.screenshot({ path: test.info().outputPath("html-resource-preview.png") })
    await preview.getByRole("button", { name: "Disable local resources", exact: true }).click()
    await expect.poll(() => revoked).toBe(1)
    await expect(frame.locator("#heading")).toHaveCSS("color", "rgb(1, 2, 3)")
    const stale = await fetch(grants[0]!.baseURL + "styles/main.css")
    expect(stale.status).toBeGreaterThanOrEqual(400)
    await stale.text()
  } finally { await host.close() }
})

test("HTML resources failure leaves safe preview usable", async ({ page }) => {
  await setup(page)
  await page.route("**/api/fs/preview/open?**", (route) => json(route, { message: "Unavailable" }, route.request().method() === "OPTIONS" ? 200 : 503))
  const { preview, frame } = await openPreview(page)
  await preview.getByRole("button", { name: "Load local resources", exact: true }).click()
  await expect(preview.getByRole("alert")).toBeVisible()
  await expect(frame.locator("#heading")).toHaveCSS("color", "rgb(1, 2, 3)")
  await expect(preview.getByRole("button", { name: "Load local resources", exact: true })).toBeEnabled()
  await expectSessionTitle(page, title)
})

test("HTML resources revoke when leaving the preview", async ({ page }) => {
  await setup(page)
  const host = createPreviewResourceHost()
  let revoked = 0
  try {
    await page.route("**/api/fs/preview/open?**", async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {})
      await json(route, await host.open("fixture-owner", "page.html", async () => ({ mime: "text/css", bytes: new TextEncoder().encode("#heading { color: rgb(10, 120, 30) }") })))
    })
    await page.route("**/api/fs/preview/close?**", async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {})
      const payload = route.request().postDataJSON() as { id: string }
      const result = host.revoke("fixture-owner", payload.id)
      if (result) revoked++
      await json(route, { revoked: result })
    })
    const { preview } = await openPreview(page)
    await preview.getByRole("button", { name: "Load local resources", exact: true }).click()
    await expect(preview.getByRole("button", { name: "Disable local resources", exact: true })).toBeVisible()
    await preview.getByRole("button", { name: "Source", exact: true }).click()
    await expect.poll(() => revoked).toBe(1)
    await expect(preview.locator('[data-component="html-file-preview"] iframe')).toHaveCount(0)
  } finally { await host.close() }
})
