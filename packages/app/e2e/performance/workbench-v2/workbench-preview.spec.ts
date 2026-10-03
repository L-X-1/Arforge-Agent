import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"
import { officeFixture } from "../../fixtures/office-documents"

const directory = "C:/Arforge/WorkbenchV2"
const sessionID = "ses_workbench_v2"
const server = playwrightScenarioServer()

function pdf() {
  const stream = (text: string) => {
    const content = `BT /F1 18 Tf 40 700 Td (${text}) Tj ET`
    return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    stream("First page"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    stream("Second page search target"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let result = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(result.length); result += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = result.length
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  result += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  return result + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

async function setup(page: Page, fileName: string) {
  await mockArforgeServer(page, {
    directory,
    project: { id: "proj_workbench", worktree: directory, vcs: "git", name: "workbench", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: { all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }], connected: ["arforge"], default: { providerID: "arforge", modelID: "test" } },
    sessions: [{ id: sessionID, slug: sessionID, projectID: "proj_workbench", directory, title: "Workbench V2 test", version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : ["report.pdf", "slides.pptx", "notes.md"].map((name) => ({ name, path: name, absolute: directory + "/" + name, type: "file", ignored: false })),
    fileContent: (path) => path === "notes.md" ? { type: "text", content: "# Draft" } : {
      type: "binary", encoding: "base64", content: Buffer.from(path === "report.pdf" ? pdf() : officeFixture("pptx")).toString("base64"),
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
  await expectSessionTitle(page, "Workbench V2 test")
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  await panel.getByRole("button", { name: fileName, exact: true }).click()
  return panel
}

test.use({ viewport: { width: 1920, height: 1080 } })

test("PDF search navigates real matching pages and downloads the authorized snapshot", async ({ page }) => {
  const panel = await setup(page, "report.pdf")
  const preview = panel.locator('[data-component="pdf-file-preview"]')
  await expect(preview.locator("canvas")).toBeVisible()
  await preview.getByRole("searchbox", { name: "Find in PDF" }).fill("search target")
  await expect(preview.getByLabel("Page", { exact: true })).toHaveValue("2")
  await expect(preview.locator('[data-slot="pdf-search"]')).toContainText("1 / 1 matching pages")
  const downloaded = page.waitForEvent("download")
  await panel.getByRole("button", { name: "Download file snapshot", exact: true }).click()
  expect((await downloaded).suggestedFilename()).toBe("report.pdf")
  await preview.getByRole("searchbox", { name: "Find in PDF" }).fill("missing phrase")
  await expect(preview.locator('[data-slot="pdf-search"]')).toContainText("No matching text")
})

test("compact workbench switches the primary pane while preserving Office controls", async ({ page }) => {
  const panel = await setup(page, "slides.pptx")
  const workbench = panel.locator('[data-component="review-file-workbench"]')
  await workbench.evaluate((element) => { (element as HTMLElement).style.width = "360px" })
  await expect(workbench).toHaveAttribute("data-compact", "true")
  await expect(workbench).toHaveAttribute("data-navigation", "false")
  const preview = panel.locator('[data-component="office-file-preview"]')
  await expect(preview.locator(".office-paper")).toContainText("Second stored slide")
  await preview.getByLabel("Document zoom", { exact: true }).selectOption("1.5")
  await expect(preview.locator(".office-paper")).toHaveCSS("zoom", "1.5")
  await preview.locator('[data-slot="office-slide-outline"] button').nth(1).click()
  await expect(preview.locator(".office-paper")).toContainText("First stored slide")
  expect((await preview.boundingBox())!.width).toBeGreaterThan(250)
  await workbench.locator('[data-slot="workbench-pane-switch"] button').first().click()
  await expect(workbench).toHaveAttribute("data-navigation", "true")
  await panel.getByRole("button", { name: "notes.md", exact: true }).click()
  await expect(workbench).toHaveAttribute("data-navigation", "false")
  await expect(panel.locator('[data-component="file-preview"]')).toContainText("notes.md")
})

test("a save conflict keeps the draft and exposes the current disk version for comparison", async ({ page }) => {
  const panel = await setup(page, "notes.md")
  let changed = false
  let writes = 0
  await page.route("**/api/fs/text**", async (route) => {
    if (route.request().method() === "PUT") {
      changed = true
      writes++
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ data: { message: "File changed on disk" } }) })
      return
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { path: "notes.md", text: changed ? "External disk change" : "# Draft", version: (changed ? "b" : "a").repeat(64), bom: false, lineEnding: "lf" } }) })
  })
  await panel.getByRole("button", { name: "Edit file", exact: true }).click()
  const editor = panel.locator('[data-component="text-document-editor"]')
  await expect(editor.locator(".cm-content")).toBeVisible()
  await editor.locator(".cm-content").press("ControlOrMeta+End")
  await page.keyboard.insertText(" my unsaved text")
  await editor.getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor.locator('[data-slot="text-editor-conflict"]')).toContainText("my unsaved text")
  await expect(editor.locator('[data-slot="text-editor-conflict"]')).toContainText("External disk change")
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  expect(writes).toBe(1)
})
