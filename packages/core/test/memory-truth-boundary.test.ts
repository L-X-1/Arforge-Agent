import { describe, expect, test } from "bun:test"
import { Memory } from "@arforge-ai/schema/memory"
import { conflict, dedup, NEAR_DUPLICATE_THRESHOLD } from "@arforge-ai/core/memory-truth-boundary"

const ids = { leftMemoryID: Memory.ID.make("mem_left"), rightMemoryID: Memory.ID.make("mem_right") }
const base = {
  kind: "mutually_exclusive_fact" as const,
  status: "pending" as const,
  leftSource: "user" as const,
  rightSource: "auto" as const,
  leftScope: "workspace" as const,
  rightScope: "workspace" as const,
  unresolvedMode: "exclude_both" as const,
  ...ids,
}

describe("Memory Step 5.6 truth boundary", () => {
  test("distinguishes exact, near duplicate, and novel records", () => {
    expect(dedup({ ...ids, similarity: 1, exactDigestMatch: true }).relation).toBe("exact_duplicate")
    expect(dedup({ ...ids, similarity: NEAR_DUPLICATE_THRESHOLD }).relation).toBe("near_duplicate")
    expect(dedup({ ...ids, similarity: 0.2 }).relation).toBe("novel")
  })

  test("excludes both unresolved mutually exclusive records when policy says so", () => {
    expect(conflict(base)).toMatchObject({
      truthBoundary: "governed_record",
      left: "exclude",
      right: "exclude",
    })
    expect(conflict(base).reason).toContain("excludes both")
  })

  test("lowers both unresolved records when policy chooses bounded recall", () => {
    expect(conflict({ ...base, unresolvedMode: "lower_both" })).toMatchObject({
      left: "lower",
      right: "lower",
      truthBoundary: "governed_record",
    })
  })

  test("resolved conflict only prioritizes the selected record", () => {
    expect(
      conflict({ ...base, status: "resolved", chosenMemoryID: ids.rightMemoryID }),
    ).toMatchObject({ left: "lower", right: "include", priorityMemoryID: ids.rightMemoryID })
  })

  test("handles stale successors and closed/undone conflicts", () => {
    expect(conflict({ ...base, kind: "stale_successor", staleMemoryID: ids.leftMemoryID })).toMatchObject({
      left: "lower",
      right: "include",
    })
    expect(conflict({ ...base, status: "dismissed" })).toMatchObject({ left: "include", right: "include" })
    expect(conflict({ ...base, status: "undone" })).toMatchObject({ left: "include", right: "include" })
  })

  test("exposes user-over-auto priority only as advisory metadata", () => {
    const decision = conflict({ ...base, kind: "user_vs_auto_priority", unresolvedMode: "lower_both" })
    expect(decision.priorityMemoryID).toBe(ids.leftMemoryID)
    expect(decision.reason).toContain("not truth")
  })
})
