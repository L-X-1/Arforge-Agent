import { expect, test, type Route } from "@playwright/test"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { resolve } from "node:path"
import { mockArforgeServer } from "../utils/mock-server"

const directory = "C:/fusion-evidence"
const session = {
  id: "ses_fusion_evidence",
  slug: "fusion-evidence",
  projectID: "project-fusion-evidence",
  directory,
  title: "Dual-runtime fusion evidence",
  version: "dev",
  time: { created: 1, updated: 2 },
}
const digest = (character: string) => character.repeat(64)
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("shows source-bound TypeScript and Python contributions for one provider turn", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 })
  await mockArforgeServer(page, {
    protocol: "v2",
    sessions: [session],
    provider: { all: [], connected: [], default: {} },
    directory,
    project: {
      id: session.projectID,
      worktree: directory,
      vcs: "git",
      time: { created: 1, updated: 2 },
      sandboxes: [],
    },
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === `/api/session/${session.id}/history`)
      return json(route, {
        data: [fusionEvent(false, 10), fusionEvent(true, 11)],
        hasMore: false,
      })
    if (path === "/api/memory") return json(route, { items: [], count: 0, total: 0 })
    if (path === "/api/memory/facets")
      return json(route, { projects: [], workspaces: [], types: [], sources: [], tags: [] })
    if (path === "/api/memory/recall-quality")
      return json(route, {
        status: "operational_baseline",
        sampleSize: 0,
        top1Rate: 0,
        meanReciprocalRank: 0,
        noResultRate: 0,
        examples: [],
        caveat: "Deterministic local baseline.",
      })
    if (path === "/api/memory/status")
      return json(route, {
        total: 0,
        important: 0,
        workspace: 0,
        global: 0,
        quarantined: 0,
        pendingConflicts: 0,
        recent: [],
      })
    if (path === "/api/memory/conflicts")
      return json(route, {
        detectorVersion: "deterministic-v1",
        scanned: 0,
        detected: 0,
        newCandidates: 0,
        items: [],
        count: 0,
        truncated: false,
      })
    if (path === "/api/learning/status")
      return json(route, {
        totalTurns: 0,
        successfulTurns: 0,
        failedTurns: 0,
        successRate: 0,
        patternCount: 0,
        fixCount: 0,
        regressionCount: 0,
        correctionCount: 0,
        injectionCount: 0,
        averageInjectedContextSize: 0,
        topTags: [],
        recent: [],
        patterns: [],
        impact: {
          status: "insufficient_data",
          injectedCount: 0,
          baselineCount: 0,
          injectedSuccessRate: 0,
          baselineSuccessRate: 0,
          uplift: 0,
          caveat: "Insufficient data.",
        },
      })
    if (path === "/api/feedback")
      return json(route, { schemaVersion: 1, storedLocally: true, items: [], count: 0, total: 0 })
    if (path === "/api/feedback/summary")
      return json(route, { schemaVersion: 1, storedLocally: true, total: 0, byCategory: [] })
    return route.fallback()
  })
  await page.addInitScript(
    ({ directory, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "arforge.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: "C:/fusion-evidence", expanded: true }] },
          lastProject: { local: "C:/fusion-evidence" },
        }),
      )
      localStorage.setItem(
        "arforge.window.browser.dat:tabs",
        JSON.stringify([
          { type: "session", server, dirBase64: base64EncodeForBrowser(directory), sessionId: sessionID },
        ]),
      )

      function base64EncodeForBrowser(value: string) {
        return btoa(unescape(encodeURIComponent(value)))
      }
    },
    { directory, server, sessionID: session.id },
  )

  await page.goto(`/server/${base64Encode(server)}/session/${session.id}?auth_token=dGVzdDp0ZXN0`)
  await expect(page).toHaveURL(new RegExp(`/server/${base64Encode(server)}/session/${session.id}`))
  await expect(page.getByText(session.title).first()).toBeVisible()
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await dialog.getByRole("button", { name: "Show advanced tools" }).click()
  await dialog.getByRole("tab", { name: "Memory / Learning" }).click()

  const evidence = dialog.getByTestId("context-fusion-evidence")
  await expect(evidence).toBeVisible()
  await expect(evidence).toContainText("Actual context assembly evidence")
  await expect(evidence).toContainText("All runtime contributions prepared")
  await expect(evidence).toContainText("Provider call continued with a degraded contribution")
  await expect(evidence).toContainText(session.id)
  await expect(evidence).toContainText("msg_fusion_user")
  await expect(evidence).toContainText("typescript-core")
  await expect(evidence).toContainText("typescript-core")
  await expect(evidence).toContainText("arforge.context/2")
  await expect(evidence).toContainText("Candidates: 1")
  await expect(evidence).toContainText("Active candidates: 1")
  await expect(evidence).toContainText("Injected candidates: 1")
  await expect(evidence).toContainText(digest("d"))
  await evidence.screenshot({
    path: resolve(process.cwd(), "../../artifacts/desktop-context-fusion-turn-evidence.png"),
  })
  const events = evidence.locator("li")
  await events.nth(0).evaluate((node) => node.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(250)
  await events.nth(0).screenshot({
    path: resolve(process.cwd(), "../../artifacts/desktop-context-fusion-degraded.png"),
  })
  await events.nth(1).evaluate((node) => node.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(250)
  await events.nth(1).screenshot({
    path: resolve(process.cwd(), "../../artifacts/desktop-context-fusion-healthy.png"),
  })
})

function fusionEvent(degraded: boolean, seq: number) {
  return {
    id: `evt_fusion_${seq}`,
    type: "session.next.context.fusion.prepared",
    durable: { aggregateID: session.id, seq, version: 1 },
    location: { directory },
    data: {
      timestamp: Date.UTC(2026, 7, 3, 12, seq),
      sessionID: session.id,
      userMessageID: "msg_fusion_user",
      turnStep: 1,
      queryDigest: digest("a"),
      combinedContextDigest: digest("d"),
      totalInjectedBytes: degraded ? 320 : 512,
      providerCallReady: true,
      degraded,
      assemblyProtocol: "arforge.context/2",
      runtimeTopology: "typescript-single-runtime",
      memory: {
        runtime: "typescript-core",
        status: "prepared",
        contextDigest: digest("b"),
        injectedBytes: 256,
        candidateCount: 1,
      },
      learning: {
        runtime: "typescript-core",
        status: "prepared",
        contextDigest: digest("c"),
        injectedBytes: 64,
      },
      evolution: {
        runtime: "typescript-core",
        status: degraded ? "unavailable" : "prepared",
        contextDigest: digest("e"),
        injectedBytes: degraded ? 0 : 192,
        activeCandidateCount: degraded ? 0 : 1,
        injectedCandidateCount: degraded ? 0 : 1,
      },
    },
  }
}

function json(route: Route, body: unknown) {
  const origin = route.request().headers()["origin"]
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": origin ?? "*",
      ...(origin ? { "access-control-allow-credentials": "true", vary: "Origin" } : {}),
      "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers":
        route.request().headers()["access-control-request-headers"] ?? "authorization,content-type,x-arforge-directory",
    },
    body: JSON.stringify(body),
  })
}
