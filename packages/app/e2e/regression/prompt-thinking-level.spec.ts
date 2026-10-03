import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { mockArforgeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/Arforge/PromptThinkingLevelRegression"
const projectID = "proj_prompt_thinking_level_regression"
const sessionID = "ses_prompt_thinking_level_regression"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("shows the V2 thinking level control while relevant", async ({ page }) => {
  await mockArforgeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-thinking-level-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "arforge",
          name: "Arforge",
          models: {
            "thinking-model": {
              id: "thinking-model",
              name: "Thinking Model",
              limit: { context: 200_000 },
              variants: { high: {} },
            },
          },
        },
      ],
      connected: ["arforge"],
      default: { providerID: "arforge", modelID: "thinking-model" },
    },
    models: [
      {
        id: "thinking-model",
        modelID: "thinking-model",
        providerID: "arforge",
        name: "Thinking Model",
        api: { id: "thinking-model", type: "native", settings: {} },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        request: { headers: {}, body: {} },
        variants: [{ id: "high", headers: {}, body: {} }],
        time: { released: 1700000000000 },
        cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
        status: "active",
        enabled: true,
        limit: { context: 200_000, output: 16_000 },
      },
    ],
    defaultModel: {
      id: "thinking-model",
      modelID: "thinking-model",
      providerID: "arforge",
      name: "Thinking Model",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [{ id: "high", headers: {}, body: {} }],
      time: { released: 1700000000000 },
      cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200_000, output: 16_000 },
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-thinking-level-regression",
        projectID,
        directory,
        title: "Prompt thinking level regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(({ directory, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "arforge.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
    localStorage.setItem(
      "arforge.window.browser.dat:tabs",
      JSON.stringify([{ type: "session", server, dirBase64: base64EncodeForBrowser(directory), sessionId: sessionID }]),
    )

    function base64EncodeForBrowser(value: string) {
      return btoa(unescape(encodeURIComponent(value)))
    }
  }, { directory, server, sessionID })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  const input = composer.locator('[data-component="prompt-input"]')
  const control = composer.getByRole("button", { name: "Choose model variant" })
  await expectAppVisible(composer)

  await idleComposer(page)
  await expect(control).toBeVisible()

  await control.click()
  const high = page.getByRole("menuitemradio", { name: "high" })
  await expect(high).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(control).toBeVisible()
  await expect(high).toBeVisible()
  await high.click()

  await idleComposer(page)
  await input.focus()
  await expect(control).toBeVisible()

  await idleComposer(page)
  await expect(control).toBeVisible()
})

async function idleComposer(page: Page) {
  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}
