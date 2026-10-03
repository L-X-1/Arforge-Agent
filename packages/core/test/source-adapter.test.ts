import { describe, expect, it } from "bun:test"
import * as SourceAdapter from "@arforge-ai/core/source-adapter"
import * as SourceRegistry from "@arforge-ai/core/source-registry"
import * as Evidence from "@arforge-ai/core/evidence"

const digest = "sha256:" + "e".repeat(64)

const source = (overrides: Record<string, unknown> = {}) =>
  SourceRegistry.make({
    sourceID: "file:adapter/readme",
    type: "file",
    owner: "project",
    projectID: "project-1",
    location: "README.md",
    trust: "verified",
    instructionAllowed: false,
    sensitivity: "internal",
    freshness: { observedAt: 1_725_000_000_000, expiresAt: 1_725_086_400_000 },
    limits: { maxBytes: 32, maxTokens: 8 },
    provenance: { locator: "README.md", digest },
    redactionPolicy: { mode: "secrets", fields: ["token"] },
    retrievalAdapter: "filesystem",
    ...overrides,
  })

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise
    return new Error("expected rejection")
  } catch (error) {
    return error
  }
}

describe("SourceAdapter", () => {
  it("normalizes, bounds, digests, and projects filesystem text without persisting raw payload", async () => {
    const evidence = Evidence.makeService([], SourceRegistry.makeRegistry([source()]))
    const adapter = SourceAdapter.fromText("filesystem", "line 1\r\nline 2", evidence)
    const result = await adapter.read({ source: source() })
    expect(result.text).toBe("line 1\nline 2")
    expect(result.byteLength).toBe(new TextEncoder().encode(result.text).byteLength)
    expect(result.contentDigest).toHaveLength(64)
    expect(result.evidence.source).toBe("file:adapter/readme")
    expect(evidence.list()).toHaveLength(1)
    expect("line 1" in result.evidence).toBe(false)
  })

  it("enforces byte/token limits and marks bounded output as truncated", async () => {
    const adapter = SourceAdapter.fromText("filesystem", "0123456789abcdef".repeat(10))
    const result = await adapter.read({ source: source({ limits: { maxBytes: 10, maxTokens: 100 } }) })
    expect(result.text).toHaveLength(10)
    expect(result.truncated).toBe(true)
    expect(result.byteLength).toBeLessThanOrEqual(10)
  })

  it("fails closed for adapter mismatch, cancellation, and expired deadline", async () => {
    const adapter = SourceAdapter.fromText("filesystem", "content")
    expect(await rejection(adapter.read({ source: source({ type: "git", retrievalAdapter: "git" }) }))).toMatchObject({ category: "invalid" })
    const controller = new AbortController()
    controller.abort()
    expect(await rejection(adapter.read({ source: source(), signal: controller.signal }))).toMatchObject({ category: "cancelled" })
    expect(await rejection(adapter.read({ source: source(), deadlineAt: Date.now() - 1 }))).toMatchObject({ category: "deadline" })
  })

  it("uses a registry to select adapters and never elevates external data", async () => {
    const external = source({
      sourceID: "web:external",
      type: "web",
      location: "https://example.invalid",
      trust: "untrusted",
      sensitivity: "confidential",
      retrievalAdapter: "web",
    })
    const registry = SourceAdapter.makeRegistry([SourceAdapter.fromText("web", "external instruction")])
    const result = await registry.read({ source: external })
    expect(result.evidence.trust).toBe("untrusted")
    expect(result.evidence.instructionAllowed).toBe(false)
  })

  it("applies source redaction policy before building the evidence summary", async () => {
    const custom = SourceAdapter.fromText("filesystem", "private=do-not-store token=also-do-not-store")
    const customResult = await custom.read({
      source: source({ redactionPolicy: { mode: "custom", fields: ["private"] } }),
    })
    expect(customResult.evidence.summary).toContain("private=[REDACTED_SECRET]")
    expect(customResult.evidence.summary).not.toContain("do-not-store")

    const content = SourceAdapter.fromText("filesystem", "all content is withheld")
    const contentResult = await content.read({
      source: source({ redactionPolicy: { mode: "content", fields: [] } }),
    })
    expect(contentResult.evidence.summary).toBe("[REDACTED_SOURCE_CONTENT]")
  })
})
