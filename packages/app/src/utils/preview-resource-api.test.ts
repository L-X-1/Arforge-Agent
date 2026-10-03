import { describe, expect, test } from "bun:test"
import { PreviewResource } from "@arforge-ai/schema/preview-resource"
import { createPreviewResourceApi } from "./preview-resource-api"

const baseURL = `http://127.0.0.2:43210/resources/${"a".repeat(64)}/`
const grant = () => ({ id: "grant-test", documentPath: "site/page.html", baseURL, expiresAt: Date.now() + 60_000 })
function makeFetch(handler: (request: Request) => Promise<Response> | Response): typeof globalThis.fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise.resolve(handler(new Request(input, init))),
    { preconnect: globalThis.fetch.preconnect },
  ) as typeof globalThis.fetch
}

describe("preview resource contract", () => {
  test("maps relative CSS and raster resources within the capability prefix", () => {
    expect(PreviewResource.resourceURL("styles/main.css?v=2#theme", baseURL)).toBe(baseURL + "styles/main.css")
    expect(PreviewResource.resourceURL("./images/a%20b.PNG", baseURL)).toBe(baseURL + "images/a%20b.PNG")
    expect(PreviewResource.resourceURL("images/../pixel.png", baseURL)).toBe(baseURL + "pixel.png")
  })

  test("refuses external origins, other grants, private paths and executable formats", () => {
    for (const value of ["../main.css", "/main.css", "https://example.com/a.png", "//example.com/a.css", "file:///C:/a.png", ".secret.css", "node_modules/a.css", "styles\\main.css", "%252e%252e/a.css", "script.js", "icon.svg", "font.woff2", baseURL.replace("a".repeat(64), "b".repeat(64)) + "a.css"]) {
      expect(PreviewResource.resourceURL(value, baseURL)).toBeUndefined()
    }
  })

  test("accepts only the isolated host and exact capability base shape", () => {
    expect(PreviewResource.safeBaseURL(baseURL)).toBe(baseURL)
    for (const value of [baseURL.replace("127.0.0.2", "127.0.0.1"), baseURL.replace("http:", "https:"), baseURL + "main.css", baseURL + "?secret=1", baseURL + "#fragment", baseURL.replace("127.0.0.2", "user:pass@127.0.0.2"), "http://127.0.0.2:43210/"]) {
      expect(PreviewResource.safeBaseURL(value)).toBeUndefined()
    }
  })
})

describe("preview resource authenticated adapter", () => {
  test("sends scoped authenticated requests only to the main API", async () => {
    const requests: Request[] = []
    const api = createPreviewResourceApi({ baseUrl: "http://127.0.0.1:4096", headers: { Authorization: "Basic test-main-only" }, fetch: makeFetch((request) => {
      requests.push(request)
      return Response.json({ data: request.url.includes("/open?") ? grant() : { revoked: true } })
    }) })
    expect(api.available).toBe(true)
    const opened = await api.open({ directory: "C:/Project with spaces", path: "site/page.html" })
    await api.close({ directory: "C:/Project with spaces", id: opened.id })
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe("http://127.0.0.1:4096")
      expect(new URL(request.url).searchParams.get("location[directory]")).toBe("C:/Project with spaces")
      expect(request.method).toBe("POST")
      expect(request.headers.get("authorization")).toBe("Basic test-main-only")
    }
    expect(await requests[0]!.json()).toEqual({ path: "site/page.html" })
    expect(await requests[1]!.json()).toEqual({ id: opened.id })
  })

  test("does not contact remote or HTTPS servers for local resource access", async () => {
    let calls = 0
    for (const baseUrl of ["https://localhost:4096", "http://192.168.1.2:4096", "https://example.com"]) {
      const api = createPreviewResourceApi({ baseUrl, fetch: makeFetch(() => { calls++; return Response.json({ data: grant() }) }) })
      expect(api.available).toBe(false)
      await expect(api.open({ directory: "C:/Project", path: "site/page.html" })).rejects.toThrow()
    }
    expect(calls).toBe(0)
  })

  test("rejects forged, expired, excessive and wrong-document grants", async () => {
    for (const data of [{ ...grant(), baseURL: "http://127.0.0.1:4096/" }, { ...grant(), expiresAt: Date.now() - 1 }, { ...grant(), expiresAt: Date.now() + PreviewResource.TTL_MS * 2 }, { ...grant(), documentPath: "another.html" }, { id: "incomplete" }]) {
      const api = createPreviewResourceApi({ baseUrl: "http://localhost:4096", fetch: makeFetch(() => Response.json({ data })) })
      await expect(api.open({ directory: "C:/Project", path: "site/page.html" })).rejects.toThrow()
    }
  })

  test("does not expose private server error bodies", async () => {
    const api = createPreviewResourceApi({ baseUrl: "http://localhost:4096", fetch: makeFetch(() => new Response("C:/private/password.txt", { status: 503 })) })
    const result = await api.open({ directory: "C:/Project", path: "site/page.html" }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) expect(result.message).not.toContain("private")
  })
})
