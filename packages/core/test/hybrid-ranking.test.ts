import { describe, expect, it } from "bun:test"
import * as HybridRanking from "@arforge-ai/core/hybrid-ranking"
import * as SourceRegistry from "@arforge-ai/core/source-registry"

const source = (id: string, trust: SourceRegistry.TrustClass) =>
  SourceRegistry.make({
    sourceID: id,
    type: "file",
    owner: "project",
    projectID: "project-1",
    location: `${id}.ts`,
    trust,
    instructionAllowed: false,
    sensitivity: "internal",
    freshness: { observedAt: 1_725_000_000_000, expiresAt: 1_725_086_400_000 },
    limits: { maxBytes: 100_000, maxTokens: 10_000 },
    provenance: { locator: `${id}.ts`, digest: "sha256:" + "a".repeat(64) },
    redactionPolicy: { mode: "secrets", fields: ["token"] },
    retrievalAdapter: "filesystem",
  })

type CandidateOptions = {
  readonly contentDigest?: string
  readonly tokenCost?: number
  readonly modelRelevance?: number
}

const candidate = (id: string, trust: SourceRegistry.TrustClass, overrides: CandidateOptions = {}): HybridRanking.Candidate => ({
  source: source(id, trust),
  hit: {
    sourceID: id,
    path: `${id}.ts`,
    lineStart: 1,
    lineEnd: 2,
    snippet: id,
    lexicalScore: 0.8,
    semanticScore: 0.7,
    semanticBackend: "hashing",
    structureScore: 0.6,
    freshnessScore: 0.9,
    contentDigest: overrides.contentDigest ?? "digest-" + id,
    fingerprint: "fingerprint-" + id,
  },
  ...(overrides.tokenCost === undefined ? {} : { tokenCost: overrides.tokenCost }),
  ...(overrides.modelRelevance === undefined ? {} : { modelRelevance: overrides.modelRelevance }),
})

describe("HybridRanking", () => {
  it("combines explainable features with a versioned profile", () => {
    const ranked = HybridRanking.rank({
      candidates: [candidate("trusted", "trusted"), candidate("external", "untrusted", { tokenCost: 8_000 })],
      maxTokenCost: 10_000,
    })
    expect(ranked[0]?.candidate.source.sourceID).toBe("trusted")
    expect(ranked[0]?.weightVersion).toBe("hybrid-v1")
    expect(ranked[0]?.features.trust).toBe(1)
    expect(ranked[0]?.contributions.trust).toBeGreaterThan(0)
    expect(ranked[0]?.explanation).toContain("weights=hybrid-v1")
  })

  it("penalizes duplicate content and limits result count deterministically", () => {
    const candidates = [candidate("one", "verified", { contentDigest: "same" }), candidate("two", "verified", { contentDigest: "same" }), candidate("three", "verified")]
    const first = HybridRanking.rank({ candidates, maxResults: 2 })
    const second = HybridRanking.rank({ candidates, maxResults: 2 })
    expect(first).toEqual(second)
    expect(first.every((item) => item.features.duplication < 1 || item.candidate.hit.contentDigest !== "same")).toBe(true)
    expect(first).toHaveLength(2)
    expect(first[0]?.rank).toBe(1)
  })

  it("does not allow a model-only relevance feature to be the only ranking authority", () => {
    const profile = { ...HybridRanking.DEFAULT_WEIGHTS, version: "hybrid-test-v1", modelRelevance: 100 }
    const ranked = HybridRanking.rank({
      weights: profile,
      candidates: [candidate("verified", "verified", { modelRelevance: 1 }), candidate("hostile", "hostile", { modelRelevance: 1 })],
    })
    expect(ranked.find((item) => item.candidate.source.sourceID === "hostile")?.features.trust).toBe(0)
    expect(ranked.every((item) => item.weightVersion === "hybrid-test-v1")).toBe(true)
  })

  it("rejects invalid weight profiles", () => {
    expect(() => HybridRanking.rank({ candidates: [], weights: { ...HybridRanking.DEFAULT_WEIGHTS, version: "", lexical: -1 } })).toThrow(
      "weight profile",
    )
  })
})
