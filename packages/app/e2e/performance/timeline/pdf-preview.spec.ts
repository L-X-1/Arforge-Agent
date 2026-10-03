import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/PdfPreview"
const sessionID = "ses_pdf_preview"
const server = playwrightScenarioServer()

function pdf() {
  const stream = (text: string) => {
    const value = "BT /F1 18 Tf 40 700 Td (" + text + ") Tj ET"
    return "<< /Length " + value.length + " >>\nstream\n" + value + "\nendstream"
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction 8 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [9 0 R] >>",
    stream("PDF local page one"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    stream("PDF local page two"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Action /S /JavaScript /JS (app.launchURL\\('https://pdf-blocked.invalid/script'\\)) >>",
    "<< /Type /Annot /Subtype /Link /Rect [20 20 200 80] /A << /S /URI /URI (https://pdf-blocked.invalid/link) >> >>",
  ]
  let result = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(result.length)
    result += String(index + 1) + " 0 obj\n" + object + "\nendobj\n"
  })
  const xref = result.length
  result += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n"
  result += offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("")
  return result + "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n"
}

async function setup(page: Page, content: () => unknown = () => ({ type: "binary", encoding: "base64", mimeType: "application/pdf", content: Buffer.from(pdf()).toString("base64") })) {
  await mockArforgeServer(page, {
    directory,
    project: { id: "proj_pdf", worktree: directory, vcs: "git", name: "pdf-preview", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: { all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }], connected: ["arforge"], default: { providerID: "arforge", modelID: "test" } },
    sessions: [{ id: sessionID, slug: sessionID, projectID: "proj_pdf", directory, title: "PDF preview test", version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : ["report.pdf", "notes.md"].map((name) => ({ name, path: name, absolute: directory + "/" + name, type: "file", ignored: false })),
    fileContent: (path) => path === "report.pdf" ? content() : { type: "text", content: "# Safe notes" },
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("arforge.global.dat:layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    localStorage.setItem("arforge.global.dat:review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }))
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId: sessionID }]))
  }, { directory, server, sessionID })
  await page.goto("/server/" + base64Encode(server) + "/session/" + sessionID)
  await expectSessionTitle(page, "PDF preview test")
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  await panel.getByRole("button", { name: "report.pdf", exact: true }).click()
  return panel.locator('[data-component="pdf-file-preview"]:visible')
}

test.use({ viewport: { width: 1440, height: 900 } })

test("PDF renders real pages locally, navigates and never runs document actions", async ({ page }) => {
  const errors: string[] = []
  const external: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => { if (request.url().includes("pdf-blocked.invalid")) external.push(request.url()) })
  await page.route("https://pdf-blocked.invalid/**", (route) => route.abort())
  const preview = await setup(page)
  await expect(preview).toHaveAttribute("aria-busy", "false")
  await expect(preview.locator("canvas")).toBeVisible()
  expect(await preview.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 200 && pixels[i + 1] < 200 && pixels[i + 2] < 200) return true
    return false
  })).toBe(true)
  await expect(preview.locator('[data-slot="pdf-page-count"]')).toHaveText("/ 2")
  await preview.getByText("Current page text", { exact: true }).click()
  await expect(preview.locator("pre")).toContainText("PDF local page one")
  await preview.getByRole("button", { name: "Next page", exact: true }).click()
  await expect(preview).toHaveAttribute("aria-busy", "false")
  await expect(preview.locator("pre")).toContainText("PDF local page two")
  await expect(preview.getByRole("button", { name: "Next page", exact: true })).toBeDisabled()
  await preview.getByLabel("Zoom", { exact: true }).selectOption("1.5")
  await expect(preview.locator("canvas")).toHaveCSS("width", "918px")
  await preview.getByLabel("Zoom", { exact: true }).selectOption("0")
  await expect(preview).toHaveAttribute("aria-busy", "false")
  expect(external).toEqual([])
  expect(errors).toEqual([])
  await page.screenshot({ path: test.info().outputPath("pdf-local-preview.png") })
})

test("PDF rejects invalid bytes and recovers after refresh without exposing binary source", async ({ page }) => {
  let valid = false
  const preview = await setup(page, () => ({ type: "binary", encoding: "base64", mimeType: "application/pdf", content: Buffer.from(valid ? pdf() : "not a PDF").toString("base64") }))
  await expect(preview.locator('[data-component="pdf-preview-error"]')).toBeVisible()
  await expect(preview).not.toContainText(Buffer.from("not a PDF").toString("base64"))
  valid = true
  await page.locator('[data-component="file-preview"]:visible').getByRole("button", { name: "Refresh preview", exact: true }).click()
  await expect(page.locator('[data-component="pdf-file-preview"]:visible canvas')).toBeVisible()
  await expect(page.locator('[data-component="pdf-preview-error"]:visible')).toHaveCount(0)
})

test("PDF handles ASCII content, narrow panes and rapid file switches without stale renders", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const preview = await setup(page, () => ({ type: "text", content: pdf() }))
  await expect(preview.locator("canvas")).toBeVisible()
  await preview.evaluate((element) => { (element as HTMLElement).style.width = "280px" })
  await expect.poll(() => preview.locator("canvas").evaluate((canvas) => canvas.getBoundingClientRect().width)).toBeLessThanOrEqual(248)
  const panel = page.locator("#review-panel")
  for (let i = 0; i < 3; i++) {
    await panel.getByRole("button", { name: "notes.md", exact: true }).click()
    await expect(panel.locator('[data-component="pdf-file-preview"]:visible')).toHaveCount(0)
    await panel.getByRole("button", { name: "report.pdf", exact: true }).click()
  }
  await expect(preview.locator("canvas")).toBeVisible()
  await expect(preview.locator('[data-component="pdf-preview-error"]')).toHaveCount(0)
  expect(errors).toEqual([])
})
