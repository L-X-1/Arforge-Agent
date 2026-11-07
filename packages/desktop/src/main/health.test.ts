import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { checkHealth, waitForHealth } from "./health"

describe("real backend health", () => {
  test("an open HTTP port returning failures is not ready; legacy health fallback works", async () => {
    let healthy = false
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? "")
      response.writeHead(healthy && request.url === "/global/health" ? 200 : 503)
      response.end(JSON.stringify({ healthy: true, version: "1.0.0" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("missing owned listener")
      const url = `http://127.0.0.1:${address.port}`
      expect(await checkHealth(url)).toBe(false)
      healthy = true
      expect(await checkHealth(url)).toBe(true)
      expect(requests).toEqual(["/api/health", "/global/health", "/api/health", "/global/health"])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("rejects unhealthy, arbitrary HTML, empty, malformed and incorrect protocol responses", async () => {
    let body = ""
    const server = createServer((_request, response) => {
      response.writeHead(200)
      response.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("missing owned listener")
      const url = `http://127.0.0.1:${address.port}`
      for (const invalid of [
        "",
        "<html>ready</html>",
        "{",
        "null",
        "{}",
        '{"healthy":false,"protocol":"v2"}',
        '{"healthy":true,"protocol":"v1"}',
      ]) {
        body = invalid
        expect(await checkHealth(url)).toBe(false)
      }
      body = '{"healthy":true,"protocol":"v2"}'
      expect(await checkHealth(url)).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("readiness waits for health and fails boundedly instead of treating a timeout as success", async () => {
    let attempts = 0
    await waitForHealth({ check: async () => ++attempts === 2, signal: new AbortController().signal, intervalMs: 1 })
    expect(attempts).toBe(2)
    await expect(
      waitForHealth({ check: async () => false, signal: new AbortController().signal, timeoutMs: 5, intervalMs: 1 }),
    ).rejects.toThrow("health check failed")
  })

  test("owned process exit cancels health polling", async () => {
    const controller = new AbortController()
    let attempts = 0
    const wait = waitForHealth({
      check: async () => {
        attempts++
        return false
      },
      signal: controller.signal,
      intervalMs: 1000,
    })
    controller.abort(new Error("owned backend exited"))
    await expect(wait).rejects.toThrow("health check failed")
    expect(attempts).toBe(1)
  })
})
