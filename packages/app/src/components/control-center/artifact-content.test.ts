import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createOperationsApiForServer } from "@/utils/server"
import { artifactContentMime, artifactDownloadName, artifactTextPreview, readArtifactContent, type ArtifactReference } from "./artifact-content"

const body = new TextEncoder().encode("Actual retained tool output\nsecond line")
function receipt(bytes = body, scope: "session" | "profile" | "tenant" = "session"): ArtifactReference {
  const digest = createHash("sha256").update(bytes).digest("hex")
  return { version: 1, artifactID: "art_" + digest, kind: "tool_output", digest, mime: "text/plain", sizeBytes: bytes.byteLength,
    owner: { scope, id: scope === "session" ? "ses_artifact_owned" : "opaque_owner" }, retention: { mode: "session" },
    retrievalHint: { kind: "managed", handle: "artifact_bound_owned" }, createdAt: 1000 }
}
function client(handler: (request: Request) => Response | Promise<Response>) {
  return createOperationsApiForServer({ server: { url: "http://127.0.0.1:4096" }, fetch: Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new Request(input, init)),
    { preconnect: globalThis.fetch.preconnect },
  ) })
}
const signal = () => new AbortController().signal

describe("authenticated artifact content", () => {
  test("uses the exact session receipt and verifies returned bytes without filesystem access", async () => {
    const requests: Request[] = [], reference = receipt()
    const api = client(request => { requests.push(request); return new Response(body) })
    expect(await readArtifactContent({ readers: api.artifacts, reference, owner: reference.owner, signal: signal() })).toEqual(body)
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe("/api/session/ses_artifact_owned/artifacts/read")
    expect(requests[0].method).toBe("POST")
    expect(await requests[0].json()).toEqual({ reference, maxBytes: 10 * 1024 * 1024 })
  })

  test("keeps profile and tenant receipts on their existing scoped route", async () => {
    for (const scope of ["profile", "tenant"] as const) {
      const requests: Request[] = [], reference = receipt(body, scope)
      const api = client(request => { requests.push(request); return new Response(body) })
      await readArtifactContent({ readers: api.artifacts, reference, owner: reference.owner, signal: signal() })
      expect(new URL(requests[0].url).pathname).toBe("/api/artifacts/read")
      expect((await requests[0].json()).reference.owner.scope).toBe(scope)
    }
  })

  test("does not request bytes for a receipt from a different selected owner", async () => {
    let calls = 0; const reference = receipt(), api = client(() => { calls++; return new Response(body) })
    await expect(readArtifactContent({ readers: api.artifacts, reference, owner: { scope: "session", id: "ses_foreign" }, signal: signal() })).rejects.toThrow("selected source")
    expect(calls).toBe(0)
  })

  test("rejects changed size or content instead of displaying an unverified snapshot", async () => {
    for (const bytes of [body.subarray(1), new Uint8Array(body.length).fill(65)]) {
      const reference = receipt(), api = client(() => new Response(bytes))
      await expect(readArtifactContent({ readers: api.artifacts, reference, owner: reference.owner, signal: signal() })).rejects.toThrow("receipt")
    }
  })

  test("preserves an authorization failure without a path or alternate read fallback", async () => {
    let calls = 0; const reference = receipt()
    const api = client(() => { calls++; return Response.json({ message: "outside authorized session" }, { status: 403 }) })
    await expect(readArtifactContent({ readers: api.artifacts, reference, owner: reference.owner, signal: signal() })).rejects.toBeDefined()
    expect(calls).toBe(1)
  })

  test("cancels an already-started read even when a transport ignores cancellation", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    const reference = receipt(), controller = new AbortController()
    const api = client(async () => { await gate; return new Response(body) })
    const pending = readArtifactContent({ readers: api.artifacts, reference, owner: reference.owner, signal: controller.signal })
    controller.abort(); release()
    await expect(pending).rejects.toBeDefined()
  })

  test("reads large receipts through ETag-bound ranges and verifies the complete digest", async () => {
    const bytes = new Uint8Array(10 * 1024 * 1024 + 3).fill(65), reference = receipt(bytes)
    const ranges: { offset: number; length: number; ifMatch: string }[] = []
    const api = client(async request => {
      expect(new URL(request.url).pathname).toBe("/api/session/ses_artifact_owned/artifacts/read-range")
      const input = await request.json(); ranges.push(input)
      expect(input.reference).toEqual(reference); expect(input.ifMatch).toBe(reference.digest)
      return new Response(bytes.slice(input.offset, input.offset + input.length), { status: 206 })
    })
    expect(await readArtifactContent({ readers: api.artifacts, reference, owner: reference.owner, signal: signal() })).toEqual(bytes)
    expect(ranges).toHaveLength(11)
    expect(ranges[10]).toMatchObject({ offset: 10 * 1024 * 1024, length: 3 })
  })

  test("keeps binary bytes intact and treats executable markup as plain text", () => {
    expect(artifactTextPreview(new Uint8Array([0, 255]), "application/octet-stream")).toBeUndefined()
    expect(artifactTextPreview(new Uint8Array([255]), "text/plain")).toBeUndefined()
    expect(artifactTextPreview(new TextEncoder().encode("<script>owned</script>"), "text/html")).toBe("<script>owned</script>")
    const reference = { ...receipt(), label: "../quoted\\file.txt", mime: "text/plain; charset=utf-8" }
    expect(artifactContentMime(reference)).toBe("text/plain")
    expect(artifactDownloadName(reference)).not.toMatch(/[\\/]/)
  })
})
