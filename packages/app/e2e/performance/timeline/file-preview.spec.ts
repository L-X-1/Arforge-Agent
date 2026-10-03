import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/PreviewRegistry"
const projectID = "proj_preview_registry"
const sessionID = "ses_preview_registry"
const title = "Unified file preview"
const server = playwrightScenarioServer()
const files = ["notes.md", "page.html", "slides.ppt", "retry.ts"]

test.use({ viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" })

async function setup(page: Page, read: (path: string) => unknown) {
  await mockArforgeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "preview-registry", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: {
      all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }],
      connected: ["arforge"], default: { providerID: "arforge", modelID: "test" },
    },
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : files.map((name) => ({ name, path: name, absolute: `${directory}/${name}`, type: "file", ignored: false })),
    fileContent: read,
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("arforge.global.dat:layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    localStorage.setItem("arforge.global.dat:review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }))
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId: sessionID }]))
  }, { directory, server, sessionID })
}

async function openPanel(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  return panel
}

test("file preview routes source safely and isolates unavailable formats", async ({ page }) => {
  await setup(page, (path) => path === "slides.ppt"
    ? { type: "binary", encoding: "base64", content: "UEsDBAoAAAA=" }
    : { type: "text", content: path === "page.html" ? "<script>globalThis.__previewExecuted = true</script>" : "# Preview notes" })
  const panel = await openPanel(page)
  await panel.getByRole("button", { name: "notes.md", exact: true }).click()
  const preview = panel.locator('[data-component="file-preview"]:visible')
  await expect(preview).toHaveAttribute("data-preview-kind", "markdown")
  await expect(preview.getByText("Read-only source", { exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "page.html", exact: true }).click()
  await expect(preview).toHaveAttribute("data-preview-kind", "html")
  await expect(preview.getByText("<script>globalThis.__previewExecuted = true</script>", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Reflect.get(window, "__previewExecuted"))).toBeUndefined()
  await panel.getByRole("button", { name: "slides.ppt", exact: true }).click()
  await expect(preview.locator('[data-component="file-preview-unsupported"]')).toBeVisible()
  await expect(preview).not.toContainText("UEsDBAoAAAA=")
  await panel.getByRole("button", { name: "notes.md", exact: true }).click()
  await expect(preview.getByText("# Preview notes", { exact: true })).toBeVisible()
  await expectSessionTitle(page, title)
  await page.screenshot({ path: test.info().outputPath("file-preview.png") })
})

test("file preview retries a failed read and refreshes the loaded version", async ({ page }) => {
  let failing = true
  let source = "const version = 1"
  await setup(page, () => ({ type: "text", content: source }))
  await page.route("**/file/content?**", async (route) => {
    if (failing && new URL(route.request().url()).searchParams.get("path") === "retry.ts") {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Preview fixture unavailable" }) })
    }
    return route.fallback()
  })
  const panel = await openPanel(page)
  await panel.getByRole("button", { name: "retry.ts", exact: true }).click()
  const preview = panel.locator('[data-component="file-preview"]:visible')
  await expect(preview.locator('[data-component="file-preview-error"]')).toBeVisible()
  failing = false
  await preview.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(preview.getByText(source, { exact: true })).toBeVisible()
  await expect(preview.locator('[data-component="file-preview-error"]')).toHaveCount(0)
  source = "const version = 2"
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click()
  await expect(preview.getByText(source, { exact: true })).toBeVisible()
  await expect(preview).toHaveAttribute("aria-busy", "false")
})

test("file preview renders Markdown without executing scripts or loading document resources", async ({ page }) => {
  let source = [
    "# Rendered notes", "", "| Item | Value |", "| --- | --- |", "| Safe | Yes |", "",
    "```ts", "const safe = true", "```", "",
    "<script>globalThis.__markdownUnsafe = true</script>",
    '<img src="https://preview-blocked.invalid/image.png" onerror="globalThis.__markdownUnsafe = true" alt="Diagram">',
    "",
    "[Unsafe](javascript:alert(1))", "[Documentation](https://example.com/docs)",
  ].join("\n")
  let resourceRequests = 0
  await setup(page, () => ({ type: "text", content: source }))
  await page.route("https://preview-blocked.invalid/**", async (route) => {
    resourceRequests++
    await route.fulfill({ status: 200, body: "blocked fixture" })
  })
  const panel = await openPanel(page)
  await panel.getByRole("button", { name: "notes.md", exact: true }).click()
  const preview = panel.locator('[data-component="file-preview"]:visible')
  await preview.getByRole("button", { name: "Preview", exact: true }).click()
  const markdown = preview.locator('[data-component="markdown-file-preview"]')
  await expect(markdown.getByRole("heading", { name: "Rendered notes", exact: true })).toBeVisible()
  await expect(markdown.getByRole("table")).toBeVisible()
  await expect(markdown.getByText("const safe = true", { exact: true })).toBeVisible()
  await expect(markdown.locator("script, iframe, img, form, a[href^='javascript:']")).toHaveCount(0)
  await expect(markdown.getByRole("link", { name: "Documentation" })).toHaveAttribute("rel", "noopener noreferrer")
  expect(await page.evaluate(() => Reflect.get(window, "__markdownUnsafe"))).toBeUndefined()
  expect(resourceRequests).toBe(0)
  await preview.getByRole("button", { name: "Source", exact: true }).click()
  await expect(preview.getByText("# Rendered notes", { exact: true })).toBeVisible()
  await preview.getByRole("button", { name: "Preview", exact: true }).click()
  source = "# Updated notes"
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click()
  await expect(markdown.getByRole("heading", { name: "Updated notes", exact: true })).toBeVisible()
  await expect(preview.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute("aria-pressed", "true")
  await page.screenshot({ path: test.info().outputPath("markdown-preview.png") })
})

test("file preview splits Markdown into independently scrollable responsive panes", async ({ page }) => {
  let source = "# Split document\n\n" + Array.from({ length: 90 }, (_, index) => `Paragraph ${index}.`).join("\n\n")
  await setup(page, () => ({ type: "text", content: source }))
  await page.setViewportSize({ width: 1920, height: 1080 })
  const panel = await openPanel(page)
  await panel.getByRole("button", { name: "notes.md", exact: true }).click()
  const preview = panel.locator('[data-component="file-preview"]:visible')
  await preview.getByRole("button", { name: "Split", exact: true }).click()
  const split = preview.locator('[data-component="markdown-split-preview"]')
  const sourcePane = split.locator('[data-preview-pane="source"]')
  const previewPane = split.locator('[data-preview-pane="preview"]')
  await expect(previewPane.getByRole("heading", { name: "Split document", exact: true })).toBeVisible()
  await expect(sourcePane.getByText("# Split document", { exact: true })).toBeVisible()
  await expect(sourcePane).toHaveAttribute("tabindex", "0")
  await expect(previewPane).toHaveAttribute("tabindex", "0")
  const wideSource = await sourcePane.boundingBox()
  const widePreview = await previewPane.boundingBox()
  expect(wideSource).not.toBeNull()
  expect(widePreview).not.toBeNull()
  expect(widePreview!.x).toBeGreaterThan(wideSource!.x)
  expect(Math.abs(widePreview!.y - wideSource!.y)).toBeLessThan(2)

  await sourcePane.evaluate((element) => { element.scrollTop = 120 })
  await expect.poll(() => sourcePane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await previewPane.evaluate((element) => element.scrollTop)).toBe(0)
  await previewPane.evaluate((element) => { element.scrollTop = 180 })
  await expect.poll(() => previewPane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await sourcePane.evaluate((element) => element.scrollTop)).toBe(120)

  // Exercise a narrow preview container without hiding the desktop review panel.
  await split.evaluate((element) => { element.style.maxWidth = "420px" })
  const narrowSource = await sourcePane.boundingBox()
  const narrowPreview = await previewPane.boundingBox()
  expect(narrowSource).not.toBeNull()
  expect(narrowPreview).not.toBeNull()
  expect(narrowPreview!.y).toBeGreaterThanOrEqual(narrowSource!.y + narrowSource!.height)
  expect(Math.abs(narrowPreview!.x - narrowSource!.x)).toBeLessThan(2)

  source = "# Split refreshed\n\nUpdated document."
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click()
  await expect(preview.getByRole("button", { name: "Split", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(previewPane.getByRole("heading", { name: "Split refreshed", exact: true })).toBeVisible()
  await preview.getByRole("button", { name: "Source", exact: true }).click()
  await expect(split).toHaveCount(0)
  await expect(preview.getByText("# Split refreshed", { exact: true })).toBeVisible()
})
