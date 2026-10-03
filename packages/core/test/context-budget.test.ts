import { describe, expect, test } from "bun:test"
import { ContextBudget } from "@arforge-ai/core/context-budget"
import { ContextPackage } from "@arforge-ai/core/context-package"

const wordTokenizer: ContextBudget.Tokenizer = {
  revision: "provider-tokenizer-v1",
  count: (input) => (input.trim() === "" ? 0 : input.trim().split(/\s+/u).length),
}

const unitTokenizer: ContextBudget.Tokenizer = {
  revision: "provider-unit-v1",
  count: (input) => (input.trim() === "" ? 0 : 1),
}

describe("ContextBudget", () => {
  test("uses a provider tokenizer when available and records estimator fallback", () => {
    expect(ContextBudget.count("one two three", wordTokenizer)).toEqual({
      tokens: 3,
      method: "provider-tokenizer",
      tokenizerRevision: "provider-tokenizer-v1",
    })
    expect(ContextBudget.count("12345678")).toMatchObject({ method: "estimator", fallbackReason: "unavailable" })
    expect(ContextBudget.count("one two", { revision: "broken", count: () => Number.NaN })).toMatchObject({
      method: "estimator",
      fallbackReason: "failed",
    })
  })

  test("keeps conservative upper-bound accounting distinct from exact provider counts", () => {
    const upperBound: ContextBudget.Tokenizer = {
      revision: "upper-bound-v1",
      kind: "upper-bound",
      count: (input) => input.length + 2,
    }
    expect(ContextBudget.count("abcd", upperBound)).toEqual({
      tokens: 6,
      method: "upper-bound",
      tokenizerRevision: "upper-bound-v1",
    })
  })

  test("reserves output, tool, recovery, and safety capacity before input", () => {
    const result = ContextBudget.plan({
      contextWindowTokens: 200,
      requestedInputTokens: 140,
      outputTokens: 30,
      toolTokens: 20,
      recoveryTokens: 10,
      safetyBufferTokens: 5,
      inputText: "one two three",
      tokenizer: wordTokenizer,
    })
    expect(result).toMatchObject({
      reservedTokens: 65,
      usableInputTokens: 135,
      inputFits: false,
      tokenizer: { tokens: 3, method: "provider-tokenizer", tokenizerRevision: "provider-tokenizer-v1" },
    })
  })

  test("keeps tool call and response atomic while anchoring objective and policy outside the summary", () => {
    const entries: ContextBudget.CompactionEntry[] = [
      { id: "policy", kind: "system", text: "policy policy policy" },
      { id: "old", kind: "user", text: "old old old old old old" },
      { id: "call", kind: "tool-call", pairID: "pair-1", text: "call call call call" },
      { id: "response", kind: "tool-response", pairID: "pair-1", text: "response response response response response" },
      { id: "recent", kind: "user", text: "recent recent" },
    ]
    const result = ContextBudget.compact({
      entries,
      recentTokenBudget: 1,
      anchors: { objective: "Ship the feature", policy: "Never expose secrets", protectedFacts: ["fact-1"] },
      tokenizer: unitTokenizer,
      summarize: ({ entries: head }) => {
        expect(head.map((entry) => entry.id)).toEqual(["policy", "old", "call", "response"])
        return "The earlier work is complete."
      },
    })
    expect(result.status).toBe("compacted")
    expect(result.removed.map((entry) => entry.id)).toEqual(["policy", "old", "call", "response"])
    expect(result.retained.map((entry) => entry.id)).toEqual(["recent"])
    expect(result.summary).toContain("Ship the feature")
    expect(result.summary).toContain("Never expose secrets")
    expect(result.summary).toContain("fact-1")
    expect(result.summary).toContain("The earlier work is complete.")
    expect(result.tokenCountAfter).toBeLessThan(result.tokenCountBefore)
  })

  test("turns failed or non-reducing compaction into a no-op", () => {
    const entries: ContextBudget.CompactionEntry[] = [
      { id: "old", kind: "user", text: "old old old old" },
      { id: "recent", kind: "user", text: "recent recent" },
    ]
    const base = {
      entries,
      recentTokenBudget: 2,
      anchors: { objective: "objective", policy: "policy", protectedFacts: [] },
      tokenizer: wordTokenizer,
    }
    expect(ContextBudget.compact({ ...base, summarize: () => undefined })).toMatchObject({
      status: "noop",
      reason: "failed",
    })
    expect(
      ContextBudget.compact({
        ...base,
        summarize: () => {
          throw new Error("provider failed")
        },
      }),
    ).toMatchObject({
      status: "noop",
      reason: "failed",
    })
    expect(
      ContextBudget.compact({ ...base, summarize: () => "a very long summary that cannot reduce the context at all" }),
    ).toMatchObject({
      status: "noop",
      reason: "not-smaller",
    })
  })

  test("binds cache entries to tenant, package, model profile, and tool schema without storing content", () => {
    const cache = ContextBudget.makeCache()
    const scope = {
      tenantID: "tenant-a",
      packageDigest: "package-digest-a",
      modelProfileRevision: "model-profile-v1",
      toolSchemaDigest: "tool-schema-a",
    }
    const record = cache.put(scope, {
      packageDigest: scope.packageDigest,
      modelProfileRevision: scope.modelProfileRevision,
      toolSchemaDigest: scope.toolSchemaDigest,
      outputDigest: "digest-a",
      tokenCount: 12,
    })
    expect(cache.get(scope)).toBe(record)
    expect(cache.get({ ...scope, tenantID: "tenant-b" })).toBeUndefined()
    expect(cache.get({ ...scope, packageDigest: "package-digest-b" })).toBeUndefined()
    expect(cache.get({ ...scope, modelProfileRevision: "model-profile-v2" })).toBeUndefined()
    expect(cache.get({ ...scope, toolSchemaDigest: "tool-schema-b" })).toBeUndefined()
    expect(ContextBudget.cacheKey(scope)).not.toBe(ContextBudget.cacheKey({ ...scope, tenantID: "tenant-b" }))
    expect(JSON.stringify(record)).not.toContain("The earlier work")
    expect(JSON.stringify(record)).not.toContain("secret")
    expect(Object.keys(record)).not.toContain("content")
  })

  test("can derive the measured package input budget", () => {
    const value = ContextPackage.compile({
      model: "budget-model",
      usableInputTokens: 100,
      units: [
        {
          id: "request",
          origin: "request",
          authority: "runtime-input",
          contextLayer: "current_request",
          trust: "trusted",
          text: "one two three",
          mandatory: true,
          priority: 1,
        },
      ],
    })
    expect(
      ContextBudget.planPackage({
        package: value,
        contextWindowTokens: 100,
        outputTokens: 10,
        toolTokens: 10,
        recoveryTokens: 5,
        tokenizer: wordTokenizer,
      }),
    ).toMatchObject({ requestedInputTokens: 3, usableInputTokens: 75, inputFits: true })
  })
})
