import { createHash } from "node:crypto"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/HtmlReferences"
const projectID = "proj_html_references"
const sessionID = "ses_html_references"
const otherID = "ses_html_references_other"
const title = "HTML source references"
const server = playwrightScenarioServer()
const initial = '<h1 id="heading">Reference this @private.env</h1>\n<p>Other source</p>'
test.use({ viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" })

async function setup(page: Page, read: () => string) {
  await mockArforgeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "html-references", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: { all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }], connected: ["arforge"], default: { providerID: "arforge", modelID: "test" } },
    sessions: [sessionID, otherID].map((id) => ({ id, slug: id, projectID, directory, title: id === sessionID ? title : "Another conversation", version: "dev", time: { created: 1700000000000, updated: 1700000000000 } })),
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : [{ name: "page.html", path: "page.html", absolute: `${directory}/page.html`, type: "file", ignored: false }],
    fileContent: () => ({ type: "text", content: read() }),
  })
  await page.addInitScript(({ directory, server, sessionID, otherID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("arforge.global.dat:layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    localStorage.setItem("arforge.global.dat:review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }))
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([sessionID, otherID].map((id) => ({ type: "session", server, sessionId: id }))))
  }, { directory, server, sessionID, otherID })
}

async function openSelection(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  await panel.getByRole("button", { name: "page.html", exact: true }).click()
  const preview = panel.locator('[data-component="file-preview"]:visible')
  await preview.getByRole("button", { name: "Preview", exact: true }).click()
  await preview.getByRole("button", { name: "Select elements", exact: true }).click()
  const picker = preview.locator('[data-component="html-element-preview"]')
  await expect(picker.getByRole("combobox", { name: "HTML element", exact: true })).toBeEnabled()
  await picker.frameLocator("iframe").locator("#heading").click()
  return { preview, picker }
}

test("HTML selection reference adds one removable card without sending or overwriting the prompt", async ({ page }) => {
  await setup(page, () => initial)
  let sends = 0
  let writes = 0
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === "POST" && /\/(message|prompt|prompt_async)(\/|$)/.test(path)) sends++
    if (request.method() === "PUT" && path.includes("/fs/")) writes++
  })
  const { picker } = await openSelection(page)
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await prompt.fill("Keep my existing question")
  await picker.getByRole("button", { name: "Reference in AI", exact: true }).click()
  await picker.getByRole("button", { name: "Reference in AI", exact: true }).click()
  const cards = page.getByText(/^HTML source snapshot \/ [a-f0-9]{12}$/)
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText("HTML source snapshot")
  await expect(cards).toContainText(createHash("sha256").update(initial).digest("hex").slice(0, 12))
  await expect(prompt).toHaveText("Keep my existing question")
  await expect(picker.getByRole("button", { name: "Jump to editor", exact: true })).toBeDisabled()
  expect(sends).toBe(0)
  expect(writes).toBe(0)
  await page.screenshot({ path: test.info().outputPath("html-selection-reference.png") })
  await page.getByRole("button", { name: "Remove attachment", exact: true }).click()
  await expect(cards).toHaveCount(0)
  await expect(prompt).toHaveText("Keep my existing question")
})

test("HTML selection reference retains the captured version when the source changes", async ({ page }) => {
  let source = initial
  await setup(page, () => source)
  const { preview, picker } = await openSelection(page)
  await picker.getByRole("button", { name: "Reference in AI", exact: true }).click()
  const oldRevision = createHash("sha256").update(source).digest("hex").slice(0, 12)
  source = '<h1 id="heading">A different version</h1>'
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click()
  await expect(picker).toHaveCount(0)
  await preview.getByRole("button", { name: "Select elements", exact: true }).click()
  await expect(picker.getByRole("combobox", { name: "HTML element", exact: true })).toBeEnabled()
  await picker.frameLocator("iframe").locator("#heading").click()
  await picker.getByRole("button", { name: "Reference in AI", exact: true }).click()
  const cards = page.getByText(/^HTML source snapshot \/ [a-f0-9]{12}$/)
  await expect(cards).toHaveCount(2)
  await expect(cards.filter({ hasText: oldRevision })).toHaveCount(1)
  await expect(cards.filter({ hasText: createHash("sha256").update(source).digest("hex").slice(0, 12) })).toHaveCount(1)
})

test("HTML selection reference stays in its conversation after navigation and reload", async ({ page }) => {
  await setup(page, () => initial)
  const { picker } = await openSelection(page)
  await picker.getByRole("button", { name: "Reference in AI", exact: true }).click()
  await expect(page.getByText(/^HTML source snapshot \/ [a-f0-9]{12}$/)).toHaveCount(1)
  await page.goto(`/server/${base64Encode(server)}/session/${otherID}`)
  await expectSessionTitle(page, "Another conversation")
  await expect(page.getByText(/^HTML source snapshot \/ [a-f0-9]{12}$/)).toHaveCount(0)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await expect(page.getByText(/^HTML source snapshot \/ [a-f0-9]{12}$/)).toHaveCount(1)
})
