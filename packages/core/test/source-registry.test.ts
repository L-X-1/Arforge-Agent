import { describe, expect, it } from "bun:test"
import { DateTime, Schema } from "effect"
import { SourceRegistry } from "@arforge-ai/core/source-registry"

const fixedDigest = "sha256:" + "a".repeat(64)

const source = (overrides: Record<string, unknown> = {}) => ({
  sourceID: "file:project/readme",
  type: "file",
  owner: "project",
  projectID: "project-1",
  location: "workspace/README.md",
  trust: "verified",
  instructionAllowed: false,
  sensitivity: "internal",
  freshness: { observedAt: 1_725_000_000_000, expiresAt: 1_725_086_400_000 },
  limits: { maxBytes: 100_000, maxTokens: 10_000 },
  provenance: { locator: "workspace/README.md", digest: fixedDigest },
  redactionPolicy: { mode: "secrets", fields: ["authorization", "apiKey"] },
  retrievalAdapter: "filesystem",
  ...overrides,
})

describe("SourceRegistry", () => {
  it("registers a bounded source record with provenance and decoded freshness", () => {
    const value = SourceRegistry.make(source())
    expect(value.sourceID).toBe("file:project/readme")
    expect(value.provenance.digest).toBe(fixedDigest)
    expect(DateTime.toEpochMillis(value.freshness.observedAt)).toBe(1_725_000_000_000)
    expect(value.limits.maxTokens).toBe(10_000)
  })

  it("covers every planned source type with one explicit retrieval adapter", () => {
    const types = [
      "system_rules",
      "project_rules",
      "user_message",
      "session_history",
      "file",
      "git",
      "lsp",
      "mcp_resource",
      "web",
      "memory",
      "learning",
      "workflow",
      "tool_output",
    ] as const
    expect(types.every((type) => SourceRegistry.adapterFor(type).length > 0)).toBe(true)
    expect(new Set(types.map(SourceRegistry.adapterFor)).size).toBe(11)
  })

  it("allows instructions only for trusted system/project rules", () => {
    expect(() => SourceRegistry.make(source({ instructionAllowed: true }))).toThrow(
      "Only trusted system_rules or project_rules",
    )
    expect(
      SourceRegistry.make(
        source({
          sourceID: "project:rules",
          type: "project_rules",
          trust: "trusted",
          instructionAllowed: true,
          location: "project/ARFORGE.md",
          provenance: { locator: "project/ARFORGE.md", digest: fixedDigest },
          retrievalAdapter: "static",
        }),
      ).instructionAllowed,
    ).toBe(true)
  })

  it("fails closed on adapter, freshness, and secret-redaction mismatches", () => {
    expect(() => SourceRegistry.make(source({ retrievalAdapter: "web" }))).toThrow("must use adapter filesystem")
    expect(() => SourceRegistry.make(source({ freshness: { observedAt: 10, expiresAt: 10 } }))).toThrow(
      "expiry must be later",
    )
    expect(() => SourceRegistry.make(source({ sensitivity: "secret", redactionPolicy: { mode: "none", fields: [] } }))).toThrow(
      "must have a redaction policy",
    )
  })

  it("is idempotent for identical registrations and rejects source identity drift", () => {
    const registry = SourceRegistry.makeRegistry()
    const first = registry.register(source())
    expect(registry.register(source())).toBe(first)
    expect(registry.list()).toHaveLength(1)
    expect(() => registry.register(source({ provenance: { locator: "workspace/README.md", digest: "b".repeat(64) } }))).toThrow(
      "already registered",
    )
  })

  it("validates source IDs and digests without accepting path traversal", () => {
    expect(() => SourceRegistry.make(source({ sourceID: "../secret" }))).toThrow()
    expect(() => SourceRegistry.make(source({ provenance: { locator: "x", digest: "not-a-digest" } }))).toThrow()
    expect(Schema.decodeUnknownSync(SourceRegistry.Digest)("a".repeat(64))).toBe("a".repeat(64))
  })
})
