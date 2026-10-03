import { expect, test } from "@playwright/test"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { fixture, pageMessages } from "./smoke/session-timeline.fixture"
import { mockArforgeServer } from "./utils/mock-server"

for (const width of [1440, 1100]) {
  test(`V2 isolated startup evidence at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(45_000)
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    const requests: string[] = []
    const responses: Array<{ url: string; status: number; body: string }> = []
    page.on("pageerror", (error) => errors.push(String(error.stack ?? error)))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
    page.on("request", (request) => {
      if (["fetch", "xhr", "document"].includes(request.resourceType())) requests.push(request.url())
    })
    page.on("response", async (response) => {
      if (!["fetch", "xhr"].includes(response.request().resourceType())) return
      if (/event|stream/.test(response.url())) return
      let body = ""
      try { body = (await response.text()).slice(0, 1200) } catch {}
      responses.push({ url: response.url(), status: response.status(), body })
    })
    await mockArforgeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    await page.addInitScript((directory) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: {
        editToolPartsExpanded: true, shellToolPartsExpanded: true, showReasoningSummaries: true,
      } }))
      localStorage.setItem("arforge.global.dat:server", JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }))
    }, fixture.directory)
    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`, {
      waitUntil: "domcontentloaded", timeout: 15_000,
    })
    let visible = false
    try {
      await page.getByRole("heading", { name: fixture.expected.sourceTitle }).waitFor({ timeout: 8000 })
      visible = true
    } catch {}
    const state = await Promise.race([
      page.evaluate(() => ({
        url: location.href,
        text: document.body.innerText.slice(0, 6000),
        headings: [...document.querySelectorAll("h1,h2,h3,[role=heading]")].map((node) => ({
          text: node.textContent,
          hidden: !!node.closest('[aria-hidden="true"], [inert]'),
        })),
        main: document.querySelector("#workspace-main")?.innerHTML.slice(0, 10000),
        rows: document.querySelectorAll("[data-timeline-row]").length,
        editor: !!document.querySelector('[contenteditable="true"]'),
        fonts: document.fonts.status,
        storageKeys: Object.keys(localStorage),
      })),
      new Promise((resolve) => setTimeout(() => resolve({ evaluationTimedOut: true }), 5000)),
    ])
    const evidence = { width, visible, state, errors, requests, responses }
    console.log("UI_V2_STARTUP_EVIDENCE", JSON.stringify(evidence))
    await testInfo.attach("startup-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" })
    try {
      const cdp = await page.context().newCDPSession(page)
      const capture = await cdp.send("Page.captureScreenshot", { format: "png" })
      await testInfo.attach("startup-frame", { body: Buffer.from(capture.data, "base64"), contentType: "image/png" })
      await cdp.detach()
    } catch (error) { console.log("UI_V2_CAPTURE_ERROR", String(error)) }
    expect(visible, "The real session heading must be visible; diagnostics must not turn a blank view into a pass").toBe(true)
  })
}
