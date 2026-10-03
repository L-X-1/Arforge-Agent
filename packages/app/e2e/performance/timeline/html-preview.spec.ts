import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockArforgeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { playwrightScenarioServer } from "../playwright-server"

const directory = "C:/Arforge/HtmlPreview"
const projectID = "proj_html_preview"
const sessionID = "ses_html_preview"
const title = "Isolated HTML preview"
const server = playwrightScenarioServer()
test.use({ viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" })

async function setup(page: Page, text: string) {
  const state = { text, version: "a".repeat(64), writes: 0, resourceRequests: 0 }
  await mockArforgeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "html-preview", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: {
      all: [{ id: "arforge", name: "Arforge", models: { test: { id: "test", name: "Test", limit: { context: 200000 } } } }],
      connected: ["arforge"], default: { providerID: "arforge", modelID: "test" },
    },
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
    vcsDiff: [], pageMessages: () => ({ items: [] }),
    fileList: (path) => path ? [] : ["page.html", "other.html"].map((name) => ({ name, path: name, absolute: `${directory}/${name}`, type: "file", ignored: false })),
    fileContent: (path) => ({ type: "text", content: path === "page.html" ? state.text : "<h1>Other file</h1>" }),
  })
  await page.route("https://html-blocked.invalid/**", async (route) => {
    state.resourceRequests++
    await route.fulfill({ status: 200, body: "blocked resource fixture" })
  })
  await page.route("**/__html-preview-probe__/**", async (route) => {
    state.resourceRequests++
    await route.fulfill({ status: 200, body: "local resource fixture" })
  })
  await page.route("**/api/fs/text?*", async (route) => {
    const request = route.request()
    expect(new URL(request.url()).searchParams.get("location[directory]")).toBe(directory)
    if (request.method() === "PUT") {
      const body = request.postDataJSON()
      expect(body.path).toBe("page.html")
      expect(body.baseVersion).toBe(state.version)
      state.writes++
      state.text = body.text
      state.version = "b".repeat(64)
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      location: { directory }, data: { path: "page.html", text: state.text, version: state.version, bom: false, lineEnding: "lf" },
    }) })
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("arforge.global.dat:layout", JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }))
    localStorage.setItem("arforge.global.dat:review-panel-v2", JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }))
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId: sessionID }]))
    localStorage.setItem("html-preview-host-secret", "host-only")
  }, { directory, server, sessionID })
  return state
}

async function openFile(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "Open file", exact: true }).click()
  await panel.getByRole("button", { name: "page.html", exact: true }).click()
  return panel
}

test("HTML preview renders CSS in an opaque sandbox without scripts, navigation or resource requests", async ({ page }) => {
  const source = [
    "<!doctype html><html><head>",
    '<style>@import url("https://html-blocked.invalid/import.css"); body{background:rgb(238, 246, 240)} h1{color:rgb(22, 101, 52)} .probe{background-image:url(/__html-preview-probe__/background.png);height:20px}</style>',
    '<meta http-equiv="refresh" content="0;url=https://html-blocked.invalid/refresh">',
    '<base href="https://html-blocked.invalid/"><link rel="stylesheet" href="https://html-blocked.invalid/theme.css">',
    '</head><body><h1>Safe prototype</h1><div class="probe">Layout</div>',
    '<script>parent.__htmlUnsafe=true;fetch("https://html-blocked.invalid/script");location.href="https://html-blocked.invalid/navigation"</script>',
    '<img src="https://html-blocked.invalid/image.png" onerror="parent.__htmlUnsafe=true">',
    '<img src="/__html-preview-probe__/local.png">',
    '<a href="https://html-blocked.invalid/link" ping="https://html-blocked.invalid/ping" target="_top">External navigation</a>',
    '<form action="https://html-blocked.invalid/form"><button formaction="https://html-blocked.invalid/button">Submit fixture</button><input type="file"></form>',
    '<iframe src="https://html-blocked.invalid/frame"></iframe><object data="https://html-blocked.invalid/object"></object>',
    '<svg><a xlink:href="https://html-blocked.invalid/svg">SVG</a></svg>',
    '<template><img src="https://html-blocked.invalid/template.png"></template>',
    "</body></html>",
  ].join("\n")
  const state = await setup(page, source)
  const panel = await openFile(page)
  const preview = panel.locator('[data-component="file-preview"]')
  await expect(preview.locator("iframe")).toHaveCount(0)
  const hostBackground = await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor)
  await preview.getByRole("button", { name: "Preview", exact: true }).click()
  const iframe = preview.locator('[data-component="html-file-preview"] iframe')
  const frame = preview.frameLocator('[data-component="html-file-preview"] iframe')
  await expect(frame.getByRole("heading", { name: "Safe prototype" })).toBeVisible()
  await expect(frame.getByRole("heading", { name: "Safe prototype" })).toHaveCSS("color", "rgb(22, 101, 52)")
  await expect(iframe).toHaveAttribute("sandbox", "")
  await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer")
  expect(await iframe.evaluate((node) => (node as HTMLIFrameElement).contentDocument === null)).toBe(true)
  await expect(frame.locator("script, iframe, object, embed, form, input[type=file], svg, template, a[href], img[src]")).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, "__htmlUnsafe"))).toBeUndefined()
  expect(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(hostBackground)
  const isolation = await frame.locator("body").evaluate(() => {
    let parentBlocked = false
    let storageBlocked = false
    try { void window.parent.document.body } catch { parentBlocked = true }
    try { localStorage.getItem("html-preview-host-secret") } catch { storageBlocked = true }
    return { parentBlocked, storageBlocked }
  })
  expect(isolation).toEqual({ parentBlocked: true, storageBlocked: true })
  const route = page.url()
  await frame.getByText("External navigation", { exact: true }).click()
  await frame.getByRole("button", { name: "Submit fixture" }).click()
  expect(await frame.locator("body").evaluate(() => location.href)).toBe("about:srcdoc")
  expect(page.url()).toBe(route)
  expect(state.resourceRequests).toBe(0)
  expect(state.writes).toBe(0)
})

test("HTML preview follows the latest unsaved buffer and toggles without remounting the editor", async ({ page }) => {
  const original = "<h1>Original HTML</h1>"
  const state = await setup(page, original)
  const panel = await openFile(page)
  await panel.getByRole("button", { name: "Edit file", exact: true }).click()
  const editor = panel.locator('[data-component="text-document-editor"]')
  const code = editor.locator(".cm-content")
  const frame = editor.frameLocator('[data-component="html-file-preview"] iframe')
  await expect(frame.getByRole("heading", { name: "Original HTML" })).toBeVisible()
  await code.evaluate((node) => Reflect.set(node, "__htmlEditorProbe", "original"))
  await code.fill("<h1>Intermediate draft</h1>")
  const next = '<style>h1{color:rgb(180, 83, 9)}</style><h1>Latest draft</h1>'
  await code.fill(next)
  await expect(frame.getByRole("heading", { name: "Latest draft" })).toBeVisible()
  await expect(frame.getByRole("heading", { name: "Latest draft" })).toHaveCSS("color", "rgb(180, 83, 9)")
  await expect(editor).toHaveAttribute("data-dirty", "true")
  expect(state.writes).toBe(0)
  expect(state.text).toBe(original)
  await editor.getByRole("button", { name: "Live preview", exact: true }).click()
  await expect(editor.locator("iframe")).toHaveCount(0)
  expect(await code.evaluate((node) => Reflect.get(node, "__htmlEditorProbe"))).toBe("original")
  await editor.getByRole("button", { name: "Live preview", exact: true }).click()
  await expect(frame.getByRole("heading", { name: "Latest draft" })).toBeVisible()
  expect(await code.evaluate((node) => Reflect.get(node, "__htmlEditorProbe"))).toBe("original")
  await editor.getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor).toHaveAttribute("data-dirty", "false")
  expect(state.writes).toBe(1)
  expect(state.text).toBe(next)
  await editor.getByRole("button", { name: "Back to preview", exact: true }).click()
  const preview = panel.locator('[data-component="file-preview"]')
  await preview.getByRole("button", { name: "Preview", exact: true }).click()
  await expect(preview.frameLocator("iframe").getByRole("heading", { name: "Latest draft" })).toBeVisible()
})

test("HTML preview splits responsively, refreshes the file and releases frames on tab changes", async ({ page }) => {
  const state = await setup(page, "<h1>Split HTML</h1>\n" + "<p>Long document paragraph.</p>\n".repeat(90))
  await page.setViewportSize({ width: 1920, height: 1080 })
  const panel = await openFile(page)
  const preview = panel.locator('[data-component="file-preview"]')
  await preview.getByRole("button", { name: "Split", exact: true }).click()
  const split = preview.locator('[data-component="html-split-preview"]')
  const sourcePane = split.locator('[data-preview-pane="source"]')
  const previewPane = split.locator('[data-preview-pane="preview"]')
  const frame = previewPane.frameLocator("iframe")
  await expect(frame.getByRole("heading", { name: "Split HTML" })).toBeVisible()
  const wideSource = await sourcePane.boundingBox()
  const widePreview = await previewPane.boundingBox()
  expect(widePreview!.x).toBeGreaterThan(wideSource!.x)
  expect(Math.abs(widePreview!.y - wideSource!.y)).toBeLessThan(2)
  await sourcePane.evaluate((node) => { node.scrollTop = 100 })
  expect(await frame.locator("body").evaluate(() => window.scrollY)).toBe(0)
  await split.evaluate((node) => { node.style.maxWidth = "420px" })
  const narrowSource = await sourcePane.boundingBox()
  const narrowPreview = await previewPane.boundingBox()
  expect(narrowPreview!.y).toBeGreaterThanOrEqual(narrowSource!.y + narrowSource!.height)
  state.text = "<h1>Refreshed HTML</h1>"
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click()
  await expect(frame.getByRole("heading", { name: "Refreshed HTML" })).toBeVisible()
  await expect(preview.getByRole("button", { name: "Split", exact: true })).toHaveAttribute("aria-pressed", "true")
  await panel.getByRole("button", { name: "other.html", exact: true }).click()
  await expect(panel.locator('[data-component="html-file-preview"] iframe')).toHaveCount(0)
  expect(state.writes).toBe(0)
})

// Exercise the production preview-to-CodeMirror bridge through real browser input.
async function navigationPreview(page: import("@playwright/test").Page) {
  const panel = page.locator("#review-panel")
  const preview = panel.locator('[data-component="html-file-preview"]:visible')
  if (await preview.count() === 0) {
    await panel.getByRole("button", { name: /live preview/i }).click()
  }
  await expect(preview).toBeVisible()
  const select = preview.getByRole("button", { name: "Select elements", exact: true })
  if (await select.count() > 0) await select.click()
  const picker = preview.locator('[data-component="html-element-preview"]')
  const elements = picker.getByRole("combobox", { name: "HTML element", exact: true })
  await expect(elements).toBeEnabled()
  await expect.poll(() => elements.locator("option").count()).toBeGreaterThan(1)
  return { panel, picker, elements }
}

async function assertHtmlEditorJump(page: import("@playwright/test").Page, expected?: string) {
  const { panel, picker, elements } = await navigationPreview(page)
  const editor = panel.locator(".cm-content:visible")
  await expect(editor).toHaveCount(1)
  const before = await editor.innerText()
  await elements.selectOption({ index: 1 })
  await picker.getByRole("button", { name: "Locate source", exact: true }).click()
  const excerpt = picker.locator("textarea")
  await expect(excerpt).toBeVisible()
  const captured = await excerpt.inputValue()
  expect(captured.length).toBeGreaterThan(0)
  expect(captured.length).toBeLessThan(12000)
  if (expected !== undefined) expect(captured).toBe(expected)
  await expect(picker.getByRole("button", { name: "Jump to editor", exact: true })).toBeEnabled()
  await picker.getByRole("button", { name: "Jump to editor", exact: true }).click()
  await expect(editor).toBeFocused()
  await expect.poll(() => editor.evaluate((element) => {
    const selection = element.ownerDocument.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null
    if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return null
    return selection.toString().replace(/\r\n?/g, "\n")
  })).toBe(captured.replace(/\r\n?/g, "\n"))
  expect(await editor.innerText()).toBe(before)
  await expect(picker.getByRole("alert")).toHaveCount(0)
}

test("HTML editor navigation selects saved source without changing or saving it", async ({ page }) => {
  const original = "<h1>Original HTML</h1>"
  const state = await setup(page, original)
  const panel = await openFile(page)
  await panel.getByRole("button", { name: "Edit file", exact: true }).click()
  const editor = panel.locator('[data-component="text-document-editor"]')
  const code = editor.locator(".cm-content")
  const frame = editor.frameLocator('[data-component="html-file-preview"] iframe')
  await expect(frame.getByRole("heading", { name: "Original HTML" })).toBeVisible()
  await code.evaluate((node) => Reflect.set(node, "__htmlEditorProbe", "original"))
  const navigationWrites: string[] = []
  page.on("request", (request) => {
    if (["PUT", "PATCH", "POST", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/fs/")) {
      navigationWrites.push(request.url())
    }
  })
  await expect(page.locator("#review-panel").getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await assertHtmlEditorJump(page)
  await expect(page.locator("#review-panel").getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  expect(navigationWrites).toEqual([])
})

test("HTML editor navigation follows the updated Unicode draft without saving it", async ({ page }) => {
  const original = "<h1>Original HTML</h1>"
  const state = await setup(page, original)
  const panel = await openFile(page)
  await panel.getByRole("button", { name: "Edit file", exact: true }).click()
  const editor = panel.locator('[data-component="text-document-editor"]')
  const code = editor.locator(".cm-content")
  const frame = editor.frameLocator('[data-component="html-file-preview"] iframe')
  await expect(frame.getByRole("heading", { name: "Original HTML" })).toBeVisible()
  await code.evaluate((node) => Reflect.set(node, "__htmlEditorProbe", "original"))
  const navigationWrites: string[] = []
  page.on("request", (request) => {
    if (["PUT", "PATCH", "POST", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/fs/")) {
      navigationWrites.push(request.url())
    }
  })
  await assertHtmlEditorJump(page)
  const navigationEditor = page.locator("#review-panel .cm-content:visible")
  const navigationTarget = '<h2 id="navigation-draft">\u4e2d\u6587 \ud83d\ude80 &amp; draft</h2>'.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  const navigationSource = `<!-- changed prefix -->\r\n${navigationTarget}\r\n<p>Retained draft</p>`.replace(/\\r\\n/g, "\r\n")
  await navigationEditor.fill(navigationSource)
  const navigationPanel = page.locator("#review-panel")
  await expect(navigationPanel.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  const navigationPicker = navigationPanel.locator('[data-component="html-element-preview"]')
  await expect(navigationPicker.frameLocator("iframe").locator("#navigation-draft")).toBeVisible()
  await assertHtmlEditorJump(page, navigationTarget)
  await expect(navigationPanel.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  expect(navigationWrites).toEqual([])
})
