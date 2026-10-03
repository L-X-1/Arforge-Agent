import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { Memory } from "@arforge-ai/schema/memory"
import { applyConflictBoundary, fingerprint } from "@arforge-ai/core/memory-recall"

const info = (id: Memory.ID, source: Memory.Source) =>
  Memory.Info.make({
    id,
    version: 1,
    content: `content-${String(id)}`,
    type: "fact",
    tags: [],
    importance: 1,
    source,
    scope: "workspace",
    strength: 1,
    reviewLevel: 0,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })

const candidate = (status: Memory.ConflictStatus, chosenMemoryID?: Memory.ID) => {
  const left = info(Memory.ID.make("mem_left"), "user")
  const right = info(Memory.ID.make("mem_right"), "auto")
  return Memory.ConflictCandidate.make({
    conflict: Memory.ConflictInfo.make({
      id: Memory.ConflictID.make("mcf_test"),
      conflictKey: "deployment-region",
      basis: "deterministic-pattern-v1",
      leftMemoryID: left.id,
      rightMemoryID: right.id,
      status,
      ...(chosenMemoryID === undefined ? {} : { chosenMemoryID }),
      time: {
        created: DateTime.makeUnsafe(0),
        updated: DateTime.makeUnsafe(0),
      },
    }),
    left,
    right,
  })
}

describe("Memory Step 5.8 recall pipeline", () => {
  test("uses fingerprints for query and scope telemetry", () => {
    expect(fingerprint("secret user query")).toHaveLength(64)
    expect(fingerprint("secret user query")).not.toContain("secret")
    expect(fingerprint("secret user query")).toBe(fingerprint("secret user query"))
  })

  test("filters unresolved conflicts before the bounded top-K cut", () => {
    const conflict = candidate("pending")
    const hits = applyConflictBoundary(
      [
        { row: { id: Memory.ID.make("mem_left") }, score: 0.99 },
        { row: { id: Memory.ID.make("mem_right") }, score: 0.98 },
        { row: { id: Memory.ID.make("mem_safe") }, score: 0.5 },
      ],
      [conflict],
      "exclude_both",
    )
    expect(hits.map((hit) => String(hit.row.id))).toEqual(["mem_safe"])
  })

  test("lowers rather than removes records under the bounded recall policy", () => {
    const conflict = candidate("pending")
    const hits = applyConflictBoundary(
      [
        { row: { id: Memory.ID.make("mem_left") }, score: 0.99 },
        { row: { id: Memory.ID.make("mem_right") }, score: 0.98 },
      ],
      [conflict],
      "lower_both",
    )
    expect(hits.map((hit) => hit.score)).toEqual([0.495, 0.49])
  })

  test("keeps chosen records and deduplicates repeated ranked rows", () => {
    const conflict = candidate("resolved", Memory.ID.make("mem_right"))
    const hits = applyConflictBoundary(
      [
        { row: { id: Memory.ID.make("mem_right") }, score: 0.4 },
        { row: { id: Memory.ID.make("mem_right") }, score: 0.8 },
        { row: { id: Memory.ID.make("mem_left") }, score: 0.9 },
      ],
      [conflict],
      "exclude_both",
    )
    expect(hits.map((hit) => String(hit.row.id))).toEqual(["mem_right", "mem_left"])
    expect(hits[0]?.score).toBe(0.8)
    expect(hits[1]?.score).toBe(0.45)
  })
})
