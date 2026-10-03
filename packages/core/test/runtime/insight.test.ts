import { describe, expect, it, beforeEach } from "bun:test"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import * as RuntimeBilling from "@arforge-ai/core/runtime/billing"

describe("RuntimeInsight audit chain", () => {
  beforeEach(() => {
    RuntimeInsight.reset()
    RuntimeInsight.attachPersistence({})
  })

  it("records an append-only hash chain", () => {
    const first = RuntimeInsight.auditRecord({ actor: "agent", action: "tool.execute.start", resource: "bash" })
    const second = RuntimeInsight.auditRecord({ actor: "agent", action: "tool.execute.end", resource: "bash" })
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(second.previousHash).toBe(first.recordHash)
    expect(RuntimeInsight.auditVerify()).toMatchObject({ valid: true, count: 2 })
  })

  it("does not repeat persistence for an already stored billing receipt", () => {
    let writes = 0
    RuntimeInsight.attachPersistence({
      insertBilling: () => {
        writes += 1
      },
    })
    try {
      const record = {
        billingID: "billing-stored",
        runID: "run-stored",
        sessionID: "session-stored",
        providerID: "test",
        modelID: "test",
        usage: RuntimeBilling.fromStepTokens({ input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      }
      RuntimeInsight.recordBilling(record, { persist: false })
      expect(writes).toBe(0)
      expect(RuntimeInsight.billing()).toHaveLength(1)
      RuntimeInsight.recordBilling({ ...record, billingID: "billing-best-effort" })
      expect(writes).toBe(1)
    } finally {
      RuntimeInsight.attachPersistence({})
    }
  })

  it("binds request-scoped audit entries to their tenant owner without breaking the chain", () => {
    const entry = RuntimeInsight.auditRecord({
      actor: "usr_a",
      action: "artifact.read.success",
      resource: "art_a",
      tenantID: "ten_a",
      ownerUserID: "usr_a",
      metadata: { sessionID: "ses_a", sizeBytes: 12 },
    })
    expect(entry).toMatchObject({ tenantID: "ten_a", ownerUserID: "usr_a", action: "artifact.read.success" })
    expect(RuntimeInsight.auditVerify()).toMatchObject({ valid: true, count: 1 })
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
      layers: [
        {
          layer: "L1",
          name: "agent",
          source: "Agent 身份与能力边界",
          unitID: "instruction:agent",
          origin: "instruction",
          contextLayer: "authority",
          authority: "runtime-input",
          trust: "trusted",
          mandatory: false,
          priority: 0,
          tokens: 10,
          chars: 40,
          kept: true,
        },
      ],
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
    const run = RuntimeInsight.runBegin("ses_1", "run_1", { traceID: "trace_run_1" })
    RuntimeInsight.runFinish("run_1", "completed")
    expect(RuntimeInsight.contextLayers(1)).toHaveLength(1)
    expect(RuntimeInsight.routingDecisions(1)).toHaveLength(1)
    expect(RuntimeInsight.verifications(1)).toHaveLength(1)
    expect(RuntimeInsight.runs(10)[0]).toMatchObject({ runID: run.runID, traceID: "trace_run_1", status: "completed" })
  })

  it("keeps bounded model-call and metric projections free of prompt bodies", () => {
    RuntimeInsight.recordModelCall({
      runID: "run_1",
      sessionID: "ses_1",
      traceID: "trace_1",
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      requestDigest: "digest_1",
      mode: "primary",
      attempt: 0,
      status: "succeeded",
      category: "unknown",
      outputStarted: true,
      toolCallStarted: false,
      startedAt: 10,
      finishedAt: 18,
    })
    RuntimeInsight.recordMetric({
      name: "llm.call",
      value: 1,
      unit: "count",
      attributes: { runID: "run_1", modelID: "deepseek-v4-flash", requestDigest: "digest_1" },
    })

    expect(RuntimeInsight.modelCalls(1)[0]).toMatchObject({
      runID: "run_1",
      requestDigest: "digest_1",
      durationMs: 8,
    })
    expect(RuntimeInsight.metrics(1)[0]).toMatchObject({ name: "llm.call", unit: "count" })
    expect(RuntimeInsight.snapshot()).toMatchObject({ metrics: 1, modelCalls: 1 })
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
      scopeHash: "scope",
      queryFingerprint: "fp_deploy",
      algorithm: "hybrid_bm25_hashing_vector",
      algorithmRevision: "memory-recall-v1",
      latencyMs: 2,
      hits: [{ memoryID: "mem_1", score: 0.8, source: "user" }],
    })
    RuntimeInsight.recordMemoryRecall({
      timestamp: 2,
      sessionID: "session",
      scopeHash: "scope",
      queryFingerprint: "fp_auth",
      algorithm: "hybrid_bm25_embedding_api",
      algorithmRevision: "memory-recall-v1",
      latencyMs: 3,
      hits: [{ memoryID: "mem_2", score: 0.6, source: "auto" }],
    })
    expect(RuntimeInsight.memoryRecalls(1)).toHaveLength(1)
    expect(RuntimeInsight.memoryRecalls(1)[0]).toMatchObject({
      queryFingerprint: "fp_auth",
      hits: [{ memoryID: "mem_2" }],
    })
    const both = RuntimeInsight.memoryRecalls(10)
    expect(both.map((record) => record.queryFingerprint)).toEqual(["fp_auth", "fp_deploy"])
    expect(RuntimeInsight.snapshot().recalls).toBe(2)
  })

  it("records provider usage and forwards the immutable billing snapshot", () => {
    const persisted: unknown[] = []
    RuntimeInsight.attachPersistence({
      insertBilling: (record) => {
        persisted.push(record)
      },
    })
    const record = RuntimeInsight.recordBilling({
      billingID: "billing_1",
      runID: "run_1",
      sessionID: "ses_1",
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      recordedAt: 42,
      usage: RuntimeBilling.fromStepTokens({
        input: 10,
        output: 8,
        reasoning: 2,
        cache: { read: 3, write: 1 },
      }),
    })

    expect(record.usage.tokens).toEqual({
      unknownInput: 10,
      imageInput: 0,
      audioInput: 0,
      cacheReadInput: 3,
      cacheWriteInput: 1,
      textOutput: 8,
      reasoningOutput: 2,
      audioOutput: 0,
    })
    expect(RuntimeInsight.billing(1)).toEqual([record])
    expect(RuntimeInsight.snapshot().billing).toBe(1)
    expect(persisted).toEqual([record])
  })

  it("caps memory recalls and clears them on reset", () => {
    for (let i = 0; i < 120; i++)
      RuntimeInsight.recordMemoryRecall({
        timestamp: i,
        sessionID: "session",
        scopeHash: `scope${i}`,
        queryFingerprint: `fp${i}`,
        algorithm: "hybrid_bm25_hashing_vector",
        algorithmRevision: "memory-recall-v1",
        latencyMs: i,
        hits: [],
      })
    expect(RuntimeInsight.memoryRecalls(200)).toHaveLength(100)
    expect(RuntimeInsight.memoryRecalls(1)[0]?.queryFingerprint).toBe("fp119")
    RuntimeInsight.reset()
    expect(RuntimeInsight.memoryRecalls(10)).toHaveLength(0)
    expect(RuntimeInsight.snapshot().recalls).toBe(0)
  })

  it("clones recalled hits so later mutation does not leak into the store", () => {
    const hits = [{ memoryID: "mem_1", score: 0.9, source: "user" }]
    RuntimeInsight.recordMemoryRecall({
      timestamp: 1,
      sessionID: "session",
      scopeHash: "scope",
      queryFingerprint: "fingerprint",
      algorithm: "hybrid_bm25_hashing_vector",
      algorithmRevision: "memory-recall-v1",
      latencyMs: 1,
      hits,
    })
    hits[0].score = 0.1
    expect(RuntimeInsight.memoryRecalls(1)[0]?.hits[0]?.score).toBe(0.9)
  })
})
