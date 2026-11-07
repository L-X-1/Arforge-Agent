import { test as base, expect } from "@playwright/test"
export const test = base.extend<{ isolation: void }>({ isolation: [async ({ context }, use, info) => {
  const blocked: string[] = [], errors: string[] = []
  context.on("page", page => page.on("pageerror", error => errors.push(error.stack ?? error.message)))
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== "http://127.0.0.1:4481" || !["GET", "HEAD"].includes(request.method())) {
      blocked.push(request.method() + " " + url.origin + url.pathname)
      return route.abort("blockedbyclient")
    }
    return route.continue()
  })
  await context.routeWebSocket(/.*/, socket => { blocked.push("WEBSOCKET"); socket.close() })
  try { await use() } finally {
    await info.attach("isolated-network", { body: JSON.stringify({blocked,errors}), contentType:"application/json" })
    expect(blocked, "Only the fixture's static GET/HEAD files may reach the network").toEqual([])
    expect(errors, "Production management components must not raise renderer errors").toEqual([])
  }
}, { auto: true }] })
export { expect }
