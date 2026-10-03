import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/TextEditor"
const projectID = "proj_text_editor"
const sessionID = "ses_text_editor"
const title = "Safe text editing"
const server = playwrightScenarioServer()
test.use({ viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" })

async function setup(page: Page) {
  const state = { text: "# Original\n", version: "a".repeat(64), reads: 0, writes: 0, gate: undefined as Promise<void> | undefined }
  await mockArforgeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "text-editor", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: {
      all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } } }],
      connected: ["arforge"], default: { providerID: "arforge", modelID: "test" },
    },
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [],
    fileList: (path) => path ? [] : ["notes.md", "other.ts"].map((name) => ({ name, path: name, absolute: `${directory}/${name}`, type: "file", ignored: false })),
    fileContent: (path) => ({ type: "text", content: path === "notes.md" ? state.text : "other file" }),
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/fs/text?*", async (route) => {
    const request = route.request()
    expect(new URL(request.url()).searchParams.get("location[directory]")).toBe(directory)
    if (request.method() === "PUT") {
      state.writes++
      await state.gate
      const body = request.postDataJSON()
      if (body.baseVersion !== state.version)
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ name: "TextDocumentConflict", data: { message: "File changed on disk" } }) })
      state.text = body.text
      state.version = (state.version[0] === "a" ? "b" : "a").repeat(64)
    } else state.reads++
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      location: { directory }, data: { path: "notes.md", text: state.text, version: state.version, bom: false, lineEnding: "lf" },
    }) })
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("arforge.global.dat:layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    localStorage.setItem("arforge.global.dat:review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }))
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId: sessionID }]))
  }, { directory, server, sessionID })
  return state
}

async function openEditor(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  await panel.getByRole("button", { name: "notes.md", exact: true }).click()
  await panel.getByRole("button", { name: "Edit file", exact: true }).click()
  const editor = panel.locator('[data-component="text-document-editor"]')
  await expect(editor.locator(".cm-content")).toBeVisible()
  return editor
}

test("text editor preserves newer typing during save and supports local search", async ({ page }) => {
  const state = await setup(page)
  const editor = await openEditor(page)
  expect(state.writes).toBe(0)
  const code = editor.locator(".cm-content")
  await code.fill("# Saved value\n")
  await code.press("ControlOrMeta+f")
  await expect(editor.locator(".cm-search")).toBeVisible()
  await page.keyboard.press("Escape")
  let release!: () => void
  state.gate = new Promise<void>((resolve) => { release = resolve })
  await editor.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.writes).toBe(1)
  await code.fill("# Newer draft\n")
  state.gate = undefined
  release()
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  await expect(code).toContainText("Newer draft")
  expect(state.text).toBe("# Saved value\n")
  await code.press("ControlOrMeta+s")
  await expect(editor).toHaveAttribute("data-dirty", "false")
  expect(state.text).toBe("# Newer draft\n")
  await editor.getByRole("button", { name: "Back to preview", exact: true }).click()
  await expect(page.locator('[data-component="file-preview"]')).toContainText("Newer draft")
})

test("text editor protects disk conflicts and requires an explicit discard before reload", async ({ page }) => {
  const state = await setup(page)
  const editor = await openEditor(page)
  const code = editor.locator(".cm-content")
  await code.fill("my unsaved draft")
  state.text = "external change"
  state.version = "c".repeat(64)
  await editor.getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor.getByRole("button", { name: "Reload disk file" })).toBeVisible()
  await expect(code).toContainText("my unsaved draft")
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  expect(state.text).toBe("external change")
  await editor.getByRole("button", { name: "Reload disk file" }).click()
  await editor.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(code).toContainText("my unsaved draft")
  await editor.getByRole("button", { name: "Reload disk file" }).click()
  await editor.getByRole("alertdialog").getByRole("button", { name: "Discard draft", exact: true }).click()
  await expect(editor.locator(".cm-content")).toContainText("external change")
  await expect(editor).toHaveAttribute("data-dirty", "false")
  expect(state.writes).toBe(1)
})

test("text editor restores a draft after switching file tabs and cancels accidental discard", async ({ page }) => {
  const state = await setup(page)
  let editor = await openEditor(page)
  await editor.locator(".cm-content").fill("draft survives tab switch")
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "other.ts", exact: true }).click()
  await panel.getByRole("button", { name: "notes.md", exact: true }).click()
  await panel.getByRole("button", { name: "Edit file", exact: true }).click()
  editor = panel.locator('[data-component="text-document-editor"]')
  await expect(editor.locator(".cm-content")).toContainText("draft survives tab switch")
  await editor.getByRole("button", { name: "Back to preview", exact: true }).click()
  await editor.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(editor).toHaveAttribute("data-dirty", "true")
  await editor.getByRole("button", { name: "Back to preview", exact: true }).click()
  await editor.getByRole("alertdialog").getByRole("button", { name: "Discard draft", exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect(state.text).toBe("# Original\n")
  expect(state.writes).toBe(0)
})
