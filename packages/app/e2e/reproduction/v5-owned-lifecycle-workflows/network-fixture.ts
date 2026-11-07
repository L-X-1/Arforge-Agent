import { test as base, expect } from "@playwright/test"
import type { ExtensionFixture } from "./sdk-fixture"

const origin = process.env.ARFORGE_WORKFLOW_FIXTURE_ORIGIN ?? "http://127.0.0.1:4631"
const fixtureOrigin = new URL(origin)
if (fixtureOrigin.protocol !== "http:" || fixtureOrigin.hostname !== "127.0.0.1" || fixtureOrigin.username || fixtureOrigin.password || fixtureOrigin.pathname !== "/") throw new Error("Expected owned loopback workflow fixture origin")

function allowed(raw: string, websocket = false) {
  try {
    const url = new URL(raw)
    return url.protocol === (websocket ? "ws:" : "http:") &&
      url.hostname === "127.0.0.1" && url.port === fixtureOrigin.port &&
      !url.username && !url.password && (!websocket || url.pathname === "/")
  } catch {
    return false
  }
}

function publicURL(raw: string) {
  try {
    const url = new URL(raw)
    return url.origin + url.pathname
  } catch {
    return "[invalid URL]"
  }
}

export const test = base.extend<{ networkFence: void }>({
  networkFence: [async ({ context }, use, testInfo) => {
    const blocked: string[] = []
    const pageErrors: string[] = []
    const audit = { origin, documentTransport: "node-fetch-manual-redirect", localTransportMaxRetries: 2, allowedHTTP: 0, allowedHMR: 0, blocked, pageErrors }
    context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message)))
    await context.route("**/*", async (route) => {
      const request = route.request()
      if (!allowed(request.url()) || !["GET", "HEAD"].includes(request.method())) {
        blocked.push(request.method() + " " + publicURL(request.url()))
        await route.abort("blockedbyclient")
        return
      }
      audit.allowedHTTP++
      // The local document transport avoids the reproducible cold-start APIRequestContext timeout.
      // It remains GET/HEAD-only, fixed to the already-validated loopback origin, with redirects disabled.
      if (new URL(request.url()).pathname === "/") {
        const document = await globalThis.fetch(request.url(), {
          method: request.method(), headers: { accept: "text/html" },
          redirect: "manual", signal: AbortSignal.timeout(15_000),
        }).catch(async (error) => { await route.abort("failed"); throw error })
        const location = document.headers.get("location")
        if (document.status >= 300 && document.status < 400 && location &&
            !allowed(new URL(location, request.url()).href)) {
          blocked.push("REDIRECT " + publicURL(new URL(location, request.url()).href))
          await route.abort("blockedbyclient")
          return
        }
        const headers = Object.fromEntries(document.headers)
        delete headers["content-encoding"]
        delete headers["content-length"]
        await route.fulfill({ status: document.status, headers, body: Buffer.from(await document.arrayBuffer()) })
        return
      }
      // Only pre-approved loopback GET/HEAD requests reach this bounded transport retry.
      // SDK task mutations are never replayed by the network fixture.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 2, timeout: 15_000 }).catch(async (error) => {
        await route.abort("failed")
        throw error
      })
      const location = response.headers()["location"]
      if (response.status() >= 300 && response.status() < 400 && location &&
        !allowed(new URL(location, request.url()).href)) {
        blocked.push("REDIRECT " + publicURL(new URL(location, request.url()).href))
        await route.abort("blockedbyclient")
        return
      }
      await route.fulfill({ response })
    })
    await context.routeWebSocket(/.*/, (socket) => {
      if (!allowed(socket.url(), true)) {
        blocked.push("WEBSOCKET " + publicURL(socket.url()))
        socket.close({ code: 1008, reason: "Only Goal fixture HMR is allowed" })
        return
      }
      audit.allowedHMR++
      socket.connectToServer()
    })
    try {
      await use()
    } finally {
      let application: ReturnType<ExtensionFixture["snapshot"]> | undefined
      const page = context.pages()[0]
      if (page && !page.isClosed())
        application = await page.evaluate(() => window.__extensionAcceptance?.snapshot()).catch(() => undefined)
      const evidence = { test: testInfo.title, network: audit, application }
      console.log("[extension-acceptance-audit] " + JSON.stringify(evidence))
      await testInfo.attach("extension-acceptance-audit", {
        body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: "application/json",
      })
      expect(blocked, "Unexpected network or business HTTP requests are forbidden").toEqual([])
      expect(pageErrors, "The production component must not raise page errors").toEqual([])
      if (application) {
        expect(application.violations, "The fixture must implement every SDK dependency actually used").toEqual([])
        expect(application.nativeAttempts, "Native actions are outside this acceptance").toEqual([])
      }
    }
  }, { auto: true }],
})

export { expect }
