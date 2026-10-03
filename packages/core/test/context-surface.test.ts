import { describe, expect, it } from "bun:test"
import { ContextBudget } from "@arforge-ai/core/context-budget"
import { ContextSurface } from "@arforge-ai/core/context-surface"

const nodes: ContextSurface.SurfaceNode[] = [
  { id: "user-1", sourceSeq: 1, role: "user", text: "A long user request that can be summarized safely.".repeat(8) },
  {
    id: "call-1",
    sourceSeq: 2,
    role: "tool-call",
    pairID: "pair-1",
    text: JSON.stringify({ command: "check" }).repeat(10),
  },
  { id: "result-1", sourceSeq: 3, role: "tool-response", pairID: "pair-1", text: "verified result".repeat(10) },
  { id: "user-2", sourceSeq: 4, role: "user", text: "Keep this recent request." },
]

const anchors: ContextBudget.CompactionAnchors = {
  objective: "Keep the task moving",
  policy: "Do not invent facts",
  protectedFacts: ["verified result"],
}

describe("ContextSurface", () => {
  it("groups tool call/result pairs as one atomic surface unit", () => {
    const surface = ContextSurface.make({ nodes })
    const groups = ContextSurface.group(surface.nodes)
    expect(groups.map((item) => item.nodes.map((node) => node.id))).toEqual([
      ["user-1"],
      ["call-1", "result-1"],
      ["user-2"],
    ])
    expect(groups[1]?.atomic).toBe(true)
    expect(() =>
      ContextSurface.make({
        nodes: [{ id: "broken", sourceSeq: 1, role: "tool-call", text: "missing pair" }],
      }),
    ).toThrow("pairID")
  })

  it("commits a smaller generation without mutating the source log", () => {
    const store = new ContextSurface.SurfaceStore(nodes)
    const before = store.snapshot()
    const result = ContextSurface.compactTransactional({
      store,
      recentTokenBudget: 120,
      anchors,
      summarize: ({ nodes: head }) => `Summarized ${head.length} source nodes.`,
    })
    expect(result.status).toBe("committed")
    expect(result.reason).toBe("compacted")
    expect(result.candidate?.generation).toBe(1)
    expect(result.candidate?.nodes[0]?.role).toBe("context")
    expect(result.removedSourceSeq).toEqual([1])
    const after = store.snapshot()
    expect(after.sourceLog).toEqual(before.sourceLog)
    expect(after.visible.generation).toBe(1)
    expect(after.visible.nodes.some((node) => node.pairID === "pair-1")).toBe(true)
    expect(after.visible.digest).not.toBe(before.visible.digest)
  })

  it("aborts on a concurrent source append before the CAS commit", () => {
    const store = new ContextSurface.SurfaceStore(nodes)
    const result = ContextSurface.compactTransactional({
      store,
      recentTokenBudget: 120,
      anchors,
      summarize: () => {
        store.append([{ id: "user-3", sourceSeq: 5, role: "user", text: "arrived while summarizing" }])
        return "short summary"
      },
    })
    expect(result.status).toBe("aborted")
    expect(result.reason).toBe("stale-surface")
    expect(store.snapshot().visible.nodes.at(-1)?.id).toBe("user-3")
    expect(store.snapshot().visible.generation).toBe(0)
  })

  it("does not commit failed or non-shrinking summaries", () => {
    const store = new ContextSurface.SurfaceStore(nodes)
    expect(
      ContextSurface.compactTransactional({
        store,
        recentTokenBudget: 120,
        anchors,
        summarize: () => undefined,
      }).reason,
    ).toBe("summary-failed")
    const unchanged = store.snapshot().visible
    expect(
      ContextSurface.compactTransactional({
        store,
        recentTokenBudget: 120,
        anchors,
        summarize: () => "x".repeat(10_000),
      }).reason,
    ).toBe("not-smaller")
    expect(store.snapshot().visible).toBe(unchanged)
  })

  it("keeps one tokenizer basis and rejects source-log identity collisions", () => {
    const tokenizer = { revision: "chars-v1", count: (text: string) => text.length }
    const store = new ContextSurface.SurfaceStore(nodes.slice(0, 1), { tokenizer })
    expect(store.snapshot().visible.tokenCount).toBe(nodes[0]!.text.length)
    expect(store.snapshot().visible.tokenizerMethod).toBe("provider-tokenizer")
    expect(store.snapshot().visible.tokenizerRevision).toBe("chars-v1")
    const appended = store.append([{ id: "user-2", sourceSeq: 4, role: "user", text: "recent" }])
    expect(appended.tokenCount).toBe(nodes[0]!.text.length + "recent".length)
    expect(() => store.append([{ id: "user-2", sourceSeq: 5, role: "user", text: "duplicate id" }])).toThrow(
      "unique across the source log",
    )
  })

  it("records an explicit estimator fallback when the provider tokenizer is invalid", () => {
    const store = new ContextSurface.SurfaceStore(
      [{ id: "fallback", sourceSeq: 1, role: "user", text: "accounting fallback" }],
      { tokenizer: { revision: "broken-v1", count: () => Number.NaN } },
    )
    const visible = store.snapshot().visible
    expect(visible.tokenizerMethod).toBe("estimator")
    expect(visible.tokenizerRevision).toBe("broken-v1")
    expect(() => ContextSurface.verify(visible)).not.toThrow()
  })

  it("records an upper-bound tokenizer basis without calling it provider-exact", () => {
    const store = new ContextSurface.SurfaceStore(nodes.slice(0, 2), {
      tokenizer: { revision: "upper-bound-v1", kind: "upper-bound", count: (text: string) => text.length + 1 },
    })
    expect(store.snapshot().visible.tokenizerMethod).toBe("upper-bound")
    expect(store.snapshot().visible.tokenizerRevision).toBe("upper-bound-v1")
    expect(() => ContextSurface.verify(store.snapshot().visible)).not.toThrow()
  })

  it("prunes only the middle, preserves tool pairs, and leaves the source log intact", () => {
    const store = new ContextSurface.SurfaceStore(nodes)
    const before = store.snapshot()
    const result = ContextSurface.pruneTransactional({
      store,
      maxTokens: 130,
      preserveHeadGroups: 1,
      preserveTailGroups: 1,
    })
    expect(result.status).toBe("pruned")
    expect(result.reason).toBe("pruned")
    expect(result.prunedSourceSeq).toEqual([2, 3])
    const after = store.snapshot()
    expect(after.sourceLog).toEqual(before.sourceLog)
    expect(after.visible.generation).toBe(1)
    expect(after.visible.nodes.filter((node) => node.pairID === "pair-1").map((node) => node.text)).toEqual([
      "[omitted; source retained in the durable log]",
      "[omitted; source retained in the durable log]",
    ])
    expect(after.visible.tokenCount).toBeLessThanOrEqual(130)
  })

  it("keeps protected head and tail unchanged when no middle replacement can shrink", () => {
    const store = new ContextSurface.SurfaceStore([
      { id: "head", sourceSeq: 1, role: "user", text: "head" },
      { id: "middle", sourceSeq: 2, role: "context", text: "x" },
      { id: "tail", sourceSeq: 3, role: "user", text: "tail" },
    ])
    const before = store.snapshot().visible
    const result = ContextSurface.pruneTransactional({ store, maxTokens: 0 })
    expect(result.status).toBe("noop")
    expect(result.reason).toBe("replacement-not-smaller")
    expect(store.snapshot().visible).toBe(before)
  })

  it("runs an asynchronous provider through deterministic checkpoints and commits once", async () => {
    const tokenizer = { revision: "chars-v1", count: (text: string) => text.length }
    const store = new ContextSurface.SurfaceStore(nodes, { tokenizer })
    let calls = 0
    const result = await ContextSurface.compactTransactionalAsync({
      store,
      recentTokenBudget: 120,
      anchors,
      provider: {
        revision: "test-provider-v1",
        summarize: async ({ operationID, nodes: head, signal, tokenizerMethod, tokenizerRevision }) => {
          calls += 1
          expect(operationID).toContain("surface-compaction:v1:0:0:")
          expect(head).toHaveLength(3)
          expect(signal.aborted).toBe(false)
          expect(tokenizerMethod).toBe("provider-tokenizer")
          expect(tokenizerRevision).toBe("chars-v1")
          await Promise.resolve()
          return "async summary"
        },
      },
    })

    expect(calls).toBe(1)
    expect(result.status).toBe("committed")
    expect(result.reason).toBe("compacted")
    expect(result.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "prepared",
      "summarizing",
      "summarized",
      "revalidated",
      "committed",
      "closed",
    ])
    expect(result.checkpoints.every((checkpoint) => checkpoint.operationID === result.operationID)).toBe(true)
    expect(JSON.parse(JSON.stringify(result.checkpoints))).toEqual(result.checkpoints)
    expect(ContextSurface.classifyAsyncCompaction([])).toBe("not_started")
    expect(ContextSurface.classifyAsyncCompaction(result.checkpoints.slice(0, 2))).toBe("in_flight")
    expect(ContextSurface.classifyAsyncCompaction(result.checkpoints.slice(0, 5))).toBe("completed_unsettled")
    expect(ContextSurface.classifyAsyncCompaction(result.checkpoints)).toBe("committed")
    expect(() =>
      ContextSurface.verifyAsyncCompactionCheckpoints(
        result.checkpoints.map((checkpoint, index) => (index === 1 ? { ...checkpoint, sequence: 99 } : checkpoint)),
      ),
    ).toThrow("contiguous")
    expect(store.snapshot().visible.generation).toBe(1)
  })

  it("checks cancellation after a provider returns and never commits an ignored abort", async () => {
    const store = new ContextSurface.SurfaceStore(nodes)
    const controller = new AbortController()
    const result = await ContextSurface.compactTransactionalAsync({
      store,
      recentTokenBudget: 120,
      anchors,
      signal: controller.signal,
      provider: {
        revision: "ignores-abort-v1",
        summarize: async () => {
          controller.abort()
          await Promise.resolve()
          return "short summary"
        },
      },
    })

    expect(result.status).toBe("aborted")
    expect(result.reason).toBe("cancelled")
    expect(result.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual(["prepared", "summarizing", "aborted"])
    expect(ContextSurface.classifyAsyncCompaction(result.checkpoints)).toBe("aborted")
    expect(store.snapshot().visible.generation).toBe(0)
  })

  it("classifies a source append during async summarization as stale without retrying", async () => {
    const store = new ContextSurface.SurfaceStore(nodes)
    let calls = 0
    const result = await ContextSurface.compactTransactionalAsync({
      store,
      recentTokenBudget: 120,
      anchors,
      provider: {
        revision: "append-race-v1",
        summarize: async () => {
          calls += 1
          store.append([{ id: "user-3", sourceSeq: 5, role: "user", text: "arrived during async summarization" }])
          await Promise.resolve()
          return "short summary"
        },
      },
    })

    expect(calls).toBe(1)
    expect(result.status).toBe("aborted")
    expect(result.reason).toBe("stale-surface")
    expect(result.checkpoints.at(-1)?.reason).toBe("stale-surface")
    expect(store.snapshot().visible.generation).toBe(0)
    expect(store.snapshot().visible.nodes.at(-1)?.id).toBe("user-3")
  })
})
