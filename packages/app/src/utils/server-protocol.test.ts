import { describe, expect, test } from "bun:test"
import { detectServerProtocol } from "./server-protocol"

const server = { url: "http://localhost:4096" }
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const mockFetch = (run: (input: string | URL | Request) => Promise<Response>) =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })

describe("detectServerProtocol", () => {
  test("recognizes the canonical V2 marker without requiring a process identifier", async () => {
    const paths: string[] = []
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      paths.push(path)
      return path === "/api/health"
        ? json({ healthy: true, protocol: "v2" })
        : json({ healthy: true, version: "local" })
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
    expect(paths).toEqual(["/api/health"])
  })

  test("prefers the current message owner when both API generations exist", async () => {
    const paths: string[] = []
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      paths.push(path)
      if (path === "/global/health") return Promise.resolve(json({ healthy: true, version: "1.18.4" }))
      return Promise.resolve(json({ healthy: true, version: "2.0.0", pid: 123 }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
    expect(paths).toEqual(["/api/health"])
  })

  test("recognizes V2 health by its process identifier", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      return Promise.resolve(json({ healthy: true, version: "2.0.0", pid: 123 }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
  })

  test("recognizes the transitional V1 API health response", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      return Promise.resolve(json({ healthy: true }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("falls back to a legacy-only server when current health is missing", async () => {
    const paths: string[] = []
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      paths.push(path)
      return path === "/api/health" ? json({}, 404) : json({ healthy: true })
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
    expect(paths).toEqual(["/api/health", "/global/health"])
  })

  test("falls back after a current health transport failure", async () => {
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/api/health") throw new TypeError("fixture connection failure")
      return json({ healthy: true })
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("does not mistake an HTML fallback page for the current API", async () => {
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      return path === "/api/health"
        ? new Response("<html>fallback</html>", { headers: { "content-type": "text/html" } })
        : json({ healthy: true })
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("retains the current default when neither health endpoint identifies a protocol", async () => {
    expect(await detectServerProtocol(server, mockFetch(async () => json({}, 404)))).toBe("v2")
  })
})
