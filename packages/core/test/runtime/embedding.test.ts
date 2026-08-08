import { describe, expect, it } from "bun:test"
import { embedBatch, featureVector, similarity, vectorForTerms, vectorForText } from "@arforge-ai/core/runtime/embedding"

describe("RuntimeEmbedding", () => {
  it("produces deterministic feature vectors for terms", () => {
    const left = vectorForTerms(["cache", "resolver"])
    const right = vectorForTerms(["cache", "resolver"])
    expect(left).toEqual(right)
    expect(left.length).toBe(256)
  })

  it("ranks related text above unrelated text with hashing", async () => {
    const query = "修复缓存失效问题"
    const related = "cache invalidation bug fix"
    const unrelated = "pizza delivery scheduling"
    const batch = await embedBatch(query, [related, unrelated])
    expect(batch.backend).toBe("hashing")
    expect(similarity(batch.query, batch.documents[0])).toBeGreaterThan(similarity(batch.query, batch.documents[1]))
  })

  it("derives term vectors via char n-gram feature hashing", () => {
    const vector = vectorForText("hello world")
    expect(vector.length).toBe(256)
    const same = vectorForText("hello world")
    expect(vector).toEqual(same)
  })

  it("defaults to hashing when the API backend is not configured", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    delete process.env.EMBED_API_KEY
    const batch = await embedBatch("q", ["d"])
    expect(batch.backend).toBe("hashing")
    if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
    else process.env.ARFORGE_EMBED_BACKEND = previous
  })
})
