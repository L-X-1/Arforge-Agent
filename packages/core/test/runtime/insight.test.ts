import { describe, expect, it, beforeEach } from "bun:test"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"

describe("RuntimeInsight audit chain", () => {
  beforeEach(() => RuntimeInsight.reset())

  it("records an append-only hash chain", () => {
    const first = RuntimeInsight.auditRecord({ actor: "agent", action: "tool.execute.start", resource: "bash" })
    const second = RuntimeInsight.auditRecord({ actor: "agent", action: "tool.execute.end", resource: "bash" })
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(second.previousHash).toBe(first.recordHash)
    expect(RuntimeInsight.auditVerify()).toMatchObject({ valid: true, count: 2 })
  })

  it("detects tampering in the chain", () => {
    RuntimeInsight.auditRecord({ actor: "agent", action: "a", resource: "r1" })
    RuntimeInsight.auditRecord({ actor: "agent", action: "b", resource: "r2" })
    const store = RuntimeInsight.__storeForTesting()
    store.audit = [...store.audit.slice(0, 1), { ...store.audit[1], resource: "tampered" }]
    const result = RuntimeInsight.auditVerify()
    expect(result.valid).toBe(false)
    expect(result.issue).toContain("hash mismatch")
  })

  it("rejects a broken previous-hash link", () => {
    RuntimeInsight.auditRecord({ actor: "agent", action: "a", resource: "r1" })
    const store = RuntimeInsight.__storeForTesting()
    store.audit = [{ ...store.audit[0], previousHash: "wrong" }]
    const result = RuntimeInsight.auditVerify()
    expect(result.valid).toBe(false)
    expect(result.issue).toContain("chain break")
  })

  it("records context layers, routing, verifications and runs", () => {
    RuntimeInsight.recordContextLayers({
      sessionID: "ses_1",
      timestamp: 1,
      model: "deepseek/deepseek-v4-flash",
      totalTokens: 42,
      layers: [{ layer: "L1", name: "agent", source: "Agent 身份与能力边界", tokens: 10, chars: 40, kept: true }],
    })
    RuntimeInsight.recordRoutingDecision({
      timestamp: 1,
      sessionID: "ses_1",
      task: "debug",
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      inputCost: 0.1,
      outputCost: 0.3,
      reason: "default",
      candidates: [],
    })
    RuntimeInsight.recordVerification({
      timestamp: 1,
      sessionID: "ses_1",
      toolCallID: "call_1",
      claim: "fix works",
      commands: ["npm test"],
      results: [{ command: "npm test", ok: true, exitCode: 0, outputTail: "ok" }],
      passed: true,
      durationMs: 5,
    })
    const run = RuntimeInsight.runBegin("ses_1", "run_1")
    RuntimeInsight.runFinish("run_1", "completed")
    expect(RuntimeInsight.contextLayers(1)).toHaveLength(1)
    expect(RuntimeInsight.routingDecisions(1)).toHaveLength(1)
    expect(RuntimeInsight.verifications(1)).toHaveLength(1)
    expect(RuntimeInsight.runs(10)[0]).toMatchObject({ runID: run.runID, status: "completed" })
  })

  it("caps the audit memory but keeps the chain valid", () => {
    for (let i = 0; i < 1100; i++) RuntimeInsight.auditRecord({ actor: "agent", action: `a${i}`, resource: "r" })
    const result = RuntimeInsight.auditVerify()
    expect(result.valid).toBe(true)
    expect(result.count).toBeLessThanOrEqual(1000)
    expect(RuntimeInsight.auditList(100).dropped).toBeGreaterThan(0)
  })

  it("records and reads memory recalls newest first", () => {
    RuntimeInsight.recordMemoryRecall({
      timestamp: 1,
      sessionID: "session",
      query: "deploy",
      algorithm: "hybrid_bm25_hashing_vector",
      hits: [{ memoryID: "mem_1", content: "deploy steps", score: 0.8, source: "user" }],
    })
    RuntimeInsight.recordMemoryRecall({
      timestamp: 2,
      sessionID: "session",
      query: "auth",
      algorithm: "hybrid_bm25_embedding_api",
      hits: [{ memoryID: "mem_2", content: "auth flow", score: 0.6, source: "auto" }],
    })
    expect(RuntimeInsight.memoryRecalls(1)).toHaveLength(1)
    expect(RuntimeInsight.memoryRecalls(1)[0]).toMatchObject({ query: "auth", hits: [{ memoryID: "mem_2" }] })
    const both = RuntimeInsight.memoryRecalls(10)
    expect(both.map((record) => record.query)).toEqual(["auth", "deploy"])
    expect(RuntimeInsight.snapshot().recalls).toBe(2)
  })

  it("caps memory recalls and clears them on reset", () => {
    for (let i = 0; i < 120; i++)
      RuntimeInsight.recordMemoryRecall({
        timestamp: i,
        sessionID: "session",
        query: `q${i}`,
        algorithm: "hybrid_bm25_hashing_vector",
        hits: [],
      })
    expect(RuntimeInsight.memoryRecalls(200)).toHaveLength(100)
    expect(RuntimeInsight.memoryRecalls(1)[0]?.query).toBe("q119")
    RuntimeInsight.reset()
    expect(RuntimeInsight.memoryRecalls(10)).toHaveLength(0)
    expect(RuntimeInsight.snapshot().recalls).toBe(0)
  })

  it("clones recalled hits so later mutation does not leak into the store", () => {
    const hits = [{ memoryID: "mem_1", content: "alpha", score: 0.9, source: "user" }]
    RuntimeInsight.recordMemoryRecall({
      timestamp: 1,
      sessionID: "session",
      query: "alpha",
      algorithm: "hybrid_bm25_hashing_vector",
      hits,
    })
    hits[0].content = "mutated"
    expect(RuntimeInsight.memoryRecalls(1)[0]?.hits[0]?.content).toBe("alpha")
  })
})
