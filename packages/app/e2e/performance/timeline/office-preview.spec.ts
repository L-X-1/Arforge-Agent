import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { officeFixture } from "../../fixtures/office-documents"
import type { OfficeFormat } from "../../../src/components/preview/office-format"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/OfficePreview"
const sessionID = "ses_office_preview"
const server = playwrightScenarioServer()
const fileNames = ["report.docx", "table.xlsx", "slides.pptx", "legacy.doc", "broken.docx", "notes.md"]

async function setup(page: Page, broken: () => Uint8Array = () => new Uint8Array([1, 2, 3])) {
  const external: string[] = [], errors: string[] = [], writes: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => {
    if (request.url().includes("office-blocked.invalid")) external.push(request.url())
    if (request.method() !== "GET" && /\/fs\/text|\/file\//.test(request.url())) writes.push(request.url())
  })
  await page.route("https://office-blocked.invalid/**", (route) => route.abort())
  await mockArforgeServer(page, {
    directory,
    project: { id: "proj_office", worktree: directory, vcs: "git", name: "office-preview", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: { all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }], connected: ["arforge"], default: { providerID: "arforge", modelID: "test" } },
    sessions: [{ id: sessionID, slug: sessionID, projectID: "proj_office", directory, title: "Office preview test", version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : fileNames.map((name) => ({ name, path: name, absolute: directory + "/" + name, type: "file", ignored: false })),
    fileContent: (path) => {
      if (path === "notes.md") return { type: "text", content: "# Safe notes" }
      const format = path.split(".").at(-1) as OfficeFormat
      const bytes = path === "broken.docx" ? broken() : path === "legacy.doc" ? new Uint8Array([1, 2, 3]) : officeFixture(format)
      return { type: "binary", encoding: "base64", content: Buffer.from(bytes).toString("base64") }
    },
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("arforge.global.dat:layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    localStorage.setItem("arforge.global.dat:review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }))
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId: sessionID }]))
  }, { directory, server, sessionID })
  await page.goto("/server/" + base64Encode(server) + "/session/" + sessionID)
  await expectSessionTitle(page, "Office preview test")
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  const open = async (name: string) => {
    await panel.getByRole("button", { name, exact: true }).click()
    return panel.locator('[data-component="office-file-preview"]:visible')
  }
  return { panel, open, external, errors, writes }
}

test.use({ viewport: { width: 1440, height: 900 } })

test("DOCX renders real content and embedded images without scripts, external resources or writes", async ({ page }) => {
  const fixture = await setup(page)
  const preview = await fixture.open("report.docx")
  await expect(preview).toHaveAttribute("aria-busy", "false")
  await expect(preview.locator(".office-paper")).toContainText("Office report")
  await expect(preview.locator("td").first()).toHaveText("Revenue")
  await expect(preview.locator(".office-paper")).toContainText('<img src="https://office-blocked.invalid/image">')
  await expect(preview.locator("img")).toHaveCount(1)
  await expect.poll(() => preview.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  expect(fixture.external).toEqual([])
  expect(fixture.errors).toEqual([])
  expect(fixture.writes).toEqual([])
})

test("XLSX switches real worksheets and displays saved formula results without executing formulas", async ({ page }) => {
  const fixture = await setup(page)
  const preview = await fixture.open("table.xlsx")
  await expect(preview.locator(".office-paper")).toContainText("Quarter total")
  await expect(preview.locator(".office-paper")).toContainText("Third row")
  await preview.getByRole("combobox", { name: "Worksheet", exact: true }).selectOption("1")
  await expect(preview.locator(".office-paper")).toContainText("Data sheet")
  await expect(preview.locator("td").last()).toHaveText("7")
  await expect(preview.locator(".office-paper")).not.toContainText("WEBSERVICE")
  expect(fixture.external).toEqual([])
  expect(fixture.errors).toEqual([])
})

test("PPTX follows presentation slide order and supports keyboard-selectable page navigation", async ({ page }) => {
  const fixture = await setup(page)
  const preview = await fixture.open("slides.pptx")
  await expect(preview.locator(".office-paper")).toContainText("Second stored slide")
  await preview.getByRole("button", { name: "Next item", exact: true }).click()
  await expect(preview.locator(".office-paper")).toContainText("First stored slide")
  await expect(preview.getByRole("button", { name: "Next item", exact: true })).toBeDisabled()
  await preview.getByRole("combobox", { name: "Slide", exact: true }).selectOption("0")
  await expect(preview.locator(".office-paper")).toContainText("Second stored slide")
  expect(fixture.errors).toEqual([])
})

test("Office errors recover after refresh, preserve legacy fallback and do not leak stale documents", async ({ page }) => {
  let valid = false
  const fixture = await setup(page, () => valid ? officeFixture("docx") : new Uint8Array([1, 2, 3]))
  const preview = await fixture.open("broken.docx")
  await expect(preview.locator('[data-component="office-preview-error"]')).toBeVisible()
  valid = true
  await fixture.panel.locator('[data-component="file-preview"]:visible').getByRole("button", { name: "Refresh preview", exact: true }).click()
  await expect(preview.locator(".office-paper")).toContainText("Office report")
  await fixture.open("legacy.doc")
  await expect(fixture.panel.locator('[data-component="file-preview-unsupported"]:visible')).toBeVisible()
  for (const name of ["report.docx", "table.xlsx", "slides.pptx", "notes.md"]) await fixture.open(name)
  await expect(fixture.panel.locator('[data-component="office-file-preview"]:visible')).toHaveCount(0)
  await expect(fixture.panel.locator('[data-component="file-preview"]:visible')).toContainText("# Safe notes")
  expect(fixture.errors).toEqual([])
})
