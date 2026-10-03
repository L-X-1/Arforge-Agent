import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/HtmlEditRefresh"
const projectID = "proj_html_edit_refresh"
const sessionID = "ses_html_edit_refresh"
const title = "HTML edit refresh"
const server = playwrightScenarioServer()

test.use({ viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" })

async function setup(page: Page) {
  let source = '<h1 id="title">Before</h1>'
  let reads = 0
  const updates: unknown[] = []
  await mockArforgeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "html-edit-refresh", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: {
      all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }],
      connected: ["arforge"], default: { providerID: "arforge", modelID: "test" },
    },
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : ["page.html", "other.html"].map((name) => ({ name, path: name, absolute: `${directory}/${name}`, type: "file", ignored: false })),
    fileContent: (path) => { reads++; return { type: "text", content: path === "other.html" ? "<h2>Other file</h2>" : source } },
    events: () => updates.splice(0),
    eventRetry: 100,
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    if (window !== window.top) return
    const seed = (key: string, value: unknown) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value))
    }
    seed("settings.v3", { general: { newLayoutDesigns: true } })
    seed("arforge.global.dat:server", { projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } })
    seed("arforge.global.dat:layout", { review: { diffStyle: "split", panelOpened: true } })
    seed("arforge.global.dat:review-panel-v2", { sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" })
    seed("arforge.window.browser.dat:tabs", [{ type: "session", server, sessionId: sessionID }])
  }, { directory, server, sessionID })
  return {
    reads: () => reads,
    commit: () => {
      source = '<h1 id="title" style="font-size:32px">After</h1>'
      updates.push({ directory, payload: { id: "evt_html_edit_refresh", type: "file.watcher.updated", properties: { file: `${directory}/page.html`, event: "change" } } })
    },
  }
}

test("HTML edit refresh reloads committed source from the scoped event and preserves the old reference", async ({ page }) => {
  const state = await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  await panel.getByRole("button", { name: "page.html", exact: true }).click()
  const preview = panel.locator('[data-component="file-preview"]:visible')
  await preview.getByRole("button", { name: "Preview", exact: true }).click()
  const html = preview.locator('[data-component="html-file-preview"]')
  await expect(html.frameLocator("iframe").getByRole("heading", { name: "Before", exact: true })).toBeVisible()
  await html.getByRole("button", { name: "Select elements", exact: true }).click()
  const picker = html.locator('[data-component="html-element-preview"]')
  await expect(picker.getByRole("combobox", { name: "HTML element", exact: true })).toBeEnabled()
  await picker.frameLocator("iframe").getByRole("heading", { name: "Before", exact: true }).click()
  await picker.getByRole("button", { name: "Reference in AI", exact: true }).click()
  const cards = page.getByText(/^HTML source snapshot \/ [a-f0-9]{12}$/)
  await expect(cards).toHaveCount(1)
  const captured = await cards.textContent()
  const beforeReads = state.reads()
  state.commit()
  await expect.poll(state.reads).toBeGreaterThan(beforeReads)
  await expect(html.frameLocator("iframe").getByRole("heading", { name: "After", exact: true })).toBeVisible()
  await expect(cards).toHaveText(captured!)
  await page.reload()
  await expectSessionTitle(page, title)
  await expect(panel.getByRole("tab", { name: "page.html", exact: true })).toBeVisible()
  await expect(html.frameLocator("iframe").getByRole("heading", { name: "After", exact: true })).toBeVisible()
  await expect(cards).toHaveText(captured!)
})

test("HTML preview modes and file tabs survive reload without leaking between files", async ({ page }) => {
  await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  await panel.getByRole("button", { name: "page.html", exact: true }).dblclick()
  const preview = panel.locator('[data-component="file-preview"]:visible')
  await preview.getByRole("button", { name: "Split", exact: true }).click()
  await expect(preview.locator('[data-component="html-split-preview"]')).toBeVisible()
  await panel.getByRole("button", { name: "other.html", exact: true }).click()
  await expect(preview.getByRole("button", { name: "Source", exact: true })).toHaveAttribute("aria-pressed", "true")
  await preview.getByRole("button", { name: "Preview", exact: true }).click()
  await expect(preview.frameLocator("iframe").getByRole("heading", { name: "Other file", exact: true })).toBeVisible()
  await panel.getByRole("tab", { name: "page.html", exact: true }).click()
  await expect(preview.getByRole("button", { name: "Split", exact: true })).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expectSessionTitle(page, title)
  await expect(panel.getByRole("tab", { name: "page.html", exact: true })).toHaveAttribute("data-selected", "")
  await expect(preview.getByRole("button", { name: "Split", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(preview.locator('[data-component="html-split-preview"]')).toBeVisible()
  await panel.getByRole("tab", { name: "other.html", exact: true }).click()
  await expect(preview.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(preview.frameLocator("iframe").getByRole("heading", { name: "Other file", exact: true })).toBeVisible()
})
