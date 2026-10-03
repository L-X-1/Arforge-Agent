import { request, type IncomingHttpHeaders } from "node:http"
import { describe, expect, test } from "bun:test"
import { PreviewResource } from "@arforge-ai/schema/preview-resource"
import { createPreviewResourceHost } from "./preview-resource-host"

const css = { mime: "text/css", bytes: new TextEncoder().encode("h1 { color: red }") }

function send(url: string, options: { method?: string; path?: string; host?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(url, {
      method: options.method ?? "GET",
      ...(options.path ? { path: options.path } : {}),
      ...(options.host ? { headers: { host: options.host } } : {}),
    }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      response.on("error", reject)
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.setTimeout(3000, () => req.destroy(new Error("Preview test request timed out")))
    req.on("error", reject)
    req.end()
  })
}

describe("independent preview resource HTTP host", () => {
  test("uses a separate loopback address and serves read-only assets", async () => {
    const host = createPreviewResourceHost()
    const reads: string[] = []
    try {
      const grant = await host.open("owner", "site/page.html", async (path) => { reads.push(path); return css })
      expect(new URL(grant.baseURL).hostname).toBe("127.0.0.2")
      expect(PreviewResource.safeBaseURL(grant.baseURL)).toBe(grant.baseURL)
      expect(grant.expiresAt).toBeGreaterThan(Date.now())
      const response = await send(grant.baseURL + "styles/main.css")
      expect(response.status).toBe(200)
      expect(response.body).toBe("h1 { color: red }")
      expect(response.headers["content-type"]).toBe("text/css; charset=utf-8")
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(response.headers["x-content-type-options"]).toBe("nosniff")
      expect(response.headers["access-control-allow-origin"]).toBe("*")
      expect(response.headers["set-cookie"]).toBeUndefined()
      const head = await send(grant.baseURL + "styles/main.css", { method: "HEAD" })
      expect(head.status).toBe(200)
      expect(head.body).toBe("")
      expect(reads).toEqual(["styles/main.css", "styles/main.css"])
    } finally { await host.close() }
  })

  test("rejects application routes, invalid Host, methods and invalid resource paths before reading", async () => {
    const host = createPreviewResourceHost()
    let reads = 0
    try {
      const grant = await host.open("owner", "page.html", async () => { reads++; return css })
      const url = new URL(grant.baseURL)
      for (const resource of ["page.html", "app.js", "icon.svg", ".private.css", "node_modules/main.css", "%2e%2e/outside.css", "a%5cb.css"]) {
        expect((await send(grant.baseURL, { path: url.pathname + resource })).status).toBeGreaterThanOrEqual(400)
      }
      expect((await send(grant.baseURL + "main.css", { host: "attacker.example" })).status).toBeGreaterThanOrEqual(400)
      expect((await send(grant.baseURL + "main.css", { method: "POST" })).status).toBe(405)
      expect((await send(url.origin + "/api/fs/text")).status).toBe(404)
      expect((await send(url.origin + "/resources/" + "0".repeat(64) + "/main.css")).status).toBeGreaterThanOrEqual(400)
      expect(reads).toBe(0)
    } finally { await host.close() }
  })

  test("requires the owner to revoke and expires grants on the next request", async () => {
    let now = 1000
    const host = createPreviewResourceHost({ now: () => now, ttlMs: 100 })
    try {
      const first = await host.open("owner", "page.html", async () => css)
      expect(host.revoke("another-owner", first.id)).toBe(false)
      expect((await send(first.baseURL + "main.css")).status).toBe(200)
      expect(host.revoke("owner", first.id)).toBe(true)
      expect((await send(first.baseURL + "main.css")).status).toBeGreaterThanOrEqual(400)
      const second = await host.open("owner", "page.html", async () => css)
      now = second.expiresAt
      expect((await send(second.baseURL + "main.css")).status).toBeGreaterThanOrEqual(400)
    } finally { await host.close() }
  })

  test("does not return bytes if the grant is revoked during a read", async () => {
    const host = createPreviewResourceHost()
    let finish!: (value: typeof css) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    try {
      const grant = await host.open("owner", "page.html", () => { entered(); return new Promise((resolve) => { finish = resolve }) })
      const pending = send(grant.baseURL + "main.css")
      await started
      expect(host.revoke("owner", grant.id)).toBe(true)
      finish(css)
      const response = await pending
      expect(response.status).toBe(410)
      expect(response.body).not.toContain("color: red")
    } finally { finish?.(css); await host.close() }
  })

  test("caps active grants and reuses capacity after revocation", async () => {
    const host = createPreviewResourceHost({ maxGrants: 1 })
    try {
      const first = await host.open("owner", "page.html", async () => css)
      await expect(host.open("owner", "other.html", async () => css)).rejects.toThrow()
      host.revoke("owner", first.id)
      const second = await host.open("owner", "other.html", async () => css)
      expect(second.id).not.toBe(first.id)
    } finally { await host.close() }
  })

  test("refuses mismatched MIME and hides reader failures", async () => {
    const host = createPreviewResourceHost()
    try {
      const wrong = await host.open("owner", "page.html", async () => ({ ...css, mime: "text/html" }))
      expect((await send(wrong.baseURL + "main.css")).status).toBeGreaterThanOrEqual(400)
      const failed = await host.open("owner", "page.html", async () => { throw new Error("C:/private/passwords.txt") })
      const response = await send(failed.baseURL + "main.css")
      expect(response.status).toBe(404)
      expect(response.body).not.toContain("private")
    } finally { await host.close() }
  })

  test("closing the host prevents new grants", async () => {
    const host = createPreviewResourceHost()
    await host.open("owner", "page.html", async () => css)
    await host.close()
    await expect(host.open("owner", "page.html", async () => css)).rejects.toThrow()
    await host.close()
  })
})
