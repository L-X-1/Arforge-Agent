import { expect, test } from "@playwright/test"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { mockArforgeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/Arforge/PromptInputV2Editing"
const projectID = "proj_prompt_input_v2_editing"
const sessionID = "ses_prompt_input_v2_editing"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("preserves the draft when a populated command menu triggers a built-in", async ({ page }) => {
  await mockArforgeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-input-v2-editing",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-input-v2-editing",
        projectID,
        directory,
        title: "Prompt input V2 editing",
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
  await expectAppVisible(composer)

  await input.fill("keep me")
  await composer.getByRole("button", { name: "Add files" }).click()
  await page.getByRole("menuitem", { name: "Commands" }).click()
  await page.locator('[data-suggestion-id="model.choose"]').click()

  await expect(input).toHaveText("keep me")
})
