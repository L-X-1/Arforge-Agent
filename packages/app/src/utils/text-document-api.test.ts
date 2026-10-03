import { describe, expect, test } from "bun:test"
import { createTextDocumentApi } from "./text-document-api"

const document = { path: "notes.md", text: "hello", version: "a".repeat(64), bom: false, lineEnding: "lf" as const }
function makeFetch(handler: (request: Request) => Promise<Response> | Response): typeof globalThis.fetch {
  return Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise.resolve(handler(new Request(input, init))), {
    preconnect: globalThis.fetch.preconnect,
  }) as typeof globalThis.fetch
}

describe("text document HTTP adapter", () => {
  test("uses the authenticated location-scoped read contract without writing", async () => {
    const requests: Request[] = []
    const api = createTextDocumentApi({
      baseUrl: "http://localhost:4096", headers: { Authorization: "Basic test" },
      fetch: makeFetch((request) => { requests.push(request); return Response.json({ data: document }) }),
    })
    expect(await api.read({ path: "notes.md", directory: "C:/project", workspace: "workspace-1" })).toEqual(document)
    const request = requests[0]!
    const url = new URL(request.url)
    expect(request.method).toBe("GET")
    expect(url.pathname).toBe("/api/fs/text")
    expect(url.searchParams.get("location[directory]")).toBe("C:/project")
    expect(url.searchParams.get("location[workspace]")).toBe("workspace-1")
    expect(request.headers.get("Authorization")).toBe("Basic test")
    expect(requests).toHaveLength(1)
  })
  test("sends the exact base version and content in one explicit PUT", async () => {
    let received: unknown
    const api = createTextDocumentApi({ baseUrl: "http://localhost", fetch: makeFetch(async (request) => {
      expect(request.method).toBe("PUT")
      received = await request.json()
      return Response.json({ data: document })
    }) })
    await api.save({ directory: "C:/project", path: document.path, text: document.text, baseVersion: document.version })
    expect(received).toEqual({ path: document.path, text: document.text, baseVersion: document.version })
  })
  test("retains a structured 409 conflict without retrying", async () => {
    let calls = 0
    const api = createTextDocumentApi({ baseUrl: "http://localhost", fetch: makeFetch(() => {
      calls++
      return Response.json({ name: "TextDocumentConflict", data: { message: "changed on disk" } }, { status: 409 })
    }) })
    await expect(api.save({ directory: "C:/project", path: document.path, text: document.text, baseVersion: document.version }))
      .rejects.toMatchObject({ status: 409, message: "changed on disk" })
    expect(calls).toBe(1)
  })
  test("rejects snapshots for the wrong file and invalid version tokens", async () => {
    for (const invalid of [{ ...document, path: "other.md" }, { ...document, version: "latest" }]) {
      const api = createTextDocumentApi({ baseUrl: "http://localhost", fetch: makeFetch(() => Response.json({ data: invalid })) })
      await expect(api.read({ path: document.path, directory: "C:/project" })).rejects.toMatchObject({ status: 502 })
    }
  })
  test("explains compatibility failure instead of falling back to an unsafe write", async () => {
    const api = createTextDocumentApi({ baseUrl: "http://localhost", fetch: makeFetch(() => new Response("Not found", { status: 404 })) })
    await expect(api.read({ path: document.path, directory: "C:/project" })).rejects.toThrow("read-only")
  })
})
