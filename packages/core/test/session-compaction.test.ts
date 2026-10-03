import { expect, test } from "bun:test"
import { SessionCompaction } from "@arforge-ai/core/session/compaction"
import { ContextSurface } from "@arforge-ai/core/context-surface"
import { RuntimeInvariantRegistry } from "@arforge-ai/core/runtime/invariants"
import { Effect } from "effect"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction transaction invariant binds the terminal result to its checkpoint chain", async () => {
  const registry = new RuntimeInvariantRegistry()
  SessionCompaction.registerInvariants(registry)
  const store = new ContextSurface.SurfaceStore([
    { id: "old", sourceSeq: 1, role: "user", text: "Old context that is safe to summarize. ".repeat(30) },
    { id: "recent", sourceSeq: 2, role: "user", text: "Keep this recent request." },
  ])
  const result = await ContextSurface.compactTransactionalAsync({
    store,
    recentTokenBudget: 20,
    anchors: { objective: "Continue the task", policy: "Keep exact facts", protectedFacts: [] },
    provider: { revision: "session-compaction-test/v1", summarize: async () => "Short anchored summary" },
  })

  const passed = await Effect.runPromise(
    registry.assert(
      { kind: "transaction-result", result },
      { owner: "session-compaction", key: "transaction-result", mode: "test" },
    ),
  )
  expect(passed.passedAll).toBe(true)
  const drifted = await Effect.runPromise(
    registry.run(
      { kind: "transaction-result", result: { ...result, status: "noop" } },
      { owner: "session-compaction", key: "transaction-result", mode: "test" },
    ),
  )
  expect(drifted).toMatchObject({ failed: 1, passedAll: false })
})
