import { describe, expect, it } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DateTime } from "effect"
import { create, makeService, resolveReferenceSet } from "@arforge-ai/core/evidence"
import * as SourceRegistry from "@arforge-ai/core/source-registry"

const sourceDigest = "sha256:" + "b".repeat(64)

const source = SourceRegistry.make({
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
  provenance: { locator: "workspace/README.md", digest: sourceDigest },
  redactionPolicy: { mode: "secrets", fields: ["authorization"] },
  retrievalAdapter: "filesystem",
})

const input = {
  evidenceID: AgentRuntime.EvidenceID.make("evd_readme"),
  sourceID: source.sourceID,
  contentDigest: sourceDigest,
  extractionMethod: "filesystem.readFileString",
  extractionVersion: "v1",
  trust: "verified" as const,
  instructionAllowed: false,
  sensitivity: "internal" as const,
  capturedAt: 1_725_000_000_000,
  validAt: 1_725_000_000_000,
  summary: "README facts",
  artifactRef: "workspace/README.md",
  verificationStatus: "verified" as const,
}

describe("EvidenceUnit", () => {
  it("creates the canonical AgentRuntime.Evidence and a bounded projection", () => {
    const service = makeService([], SourceRegistry.makeRegistry([source]))
    const evidence = service.create(input)
    const projection = service.project(evidence.id)
    expect(evidence.source).toBe("file:project/readme")
    expect(evidence.contentDigest).toBe(sourceDigest)
    expect(evidence.observationIDs).toEqual([])
    expect(projection?.sourceID).toBe("file:project/readme")
    expect(projection?.verificationStatus).toBe("verified")
    expect(projection?.summary).toBe("README facts")
  })

  it("keeps run/action/observation references while excluding raw payload", () => {
    const evidence = create({
      ...input,
      evidenceID: AgentRuntime.EvidenceID.make("evd_refs"),
      runID: AgentRuntime.RunID.make("run_test"),
      actionID: AgentRuntime.ActionID.make("act_test"),
      observationIDs: [AgentRuntime.ObservationID.make("obs_test")],
      artifactDigest: "sha256:" + "c".repeat(64),
    })
    expect(String(evidence.runID)).toBe("run_test")
    expect(String(evidence.actionID)).toBe("act_test")
    expect(evidence.observationIDs?.map(String)).toEqual(["obs_test"])
    expect("rawPayload" in evidence).toBe(false)
    expect(DateTime.toEpochMillis(evidence.capturedAt)).toBe(1_725_000_000_000)
  })

  it("fails closed on untrusted instructions, unknown sources, and oversized summaries", () => {
    expect(() => create({ ...input, instructionAllowed: true, trust: "untrusted" })).toThrow("only trusted")
    expect(() => makeService([], SourceRegistry.makeRegistry([source])).create({ ...input, sourceID: "file:missing" })).toThrow(
      "sourceID is not registered",
    )
    expect(() => create({ ...input, summary: "x".repeat(2_001) })).toThrow("summary must be bounded")
  })

  it("is immutable and rejects evidence identity drift", () => {
    const service = makeService()
    const first = service.create(input)
    expect(service.create(input)).toBe(first)
    expect(() => service.create({ ...input, contentDigest: "sha256:" + "d".repeat(64) })).toThrow("different content")
    expect(() => {
      ;(first as { summary: string }).summary = "mutated"
    }).toThrow()
  })

  it("resolves bounded EvidenceID references without exposing payload", () => {
    const evidence = create(input)
    const service = makeService([evidence])
    const present = service.resolve([evidence.id])
    expect(present).toMatchObject({
      present: [evidence.id],
      missing: [],
      duplicate: [],
      invalid: [],
      valid: true,
    })
    const restarted = makeService(service.list())
    expect(restarted.resolve([evidence.id]).valid).toBe(true)

    const missingID = AgentRuntime.EvidenceID.make("evd_missing")
    const missing = service.resolve([missingID])
    expect(missing).toMatchObject({ present: [], missing: [missingID], valid: false })

    const duplicate = resolveReferenceSet([evidence.id, evidence.id], new Set([String(evidence.id)]))
    expect(duplicate).toMatchObject({ present: [evidence.id, evidence.id], duplicate: [evidence.id], valid: false })

    const invalid = resolveReferenceSet(["not-an-evidence-id" as AgentRuntime.EvidenceID], new Set())
    expect(invalid.invalid).toEqual(["not-an-evidence-id"])
    expect(invalid.valid).toBe(false)

    const overBound = resolveReferenceSet(
      Array.from({ length: 33 }, (_, index) => AgentRuntime.EvidenceID.make(`evd_bound_${index}`)),
      new Set(),
    )
    expect(overBound.requested).toHaveLength(33)
    expect(overBound.valid).toBe(false)
  })
})
