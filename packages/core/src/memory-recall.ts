import { createHash } from "node:crypto"
import type { Memory } from "@arforge-ai/schema/memory"
import type { ConflictCandidate } from "@arforge-ai/schema/memory"
import * as Truth from "@arforge-ai/schema/memory-truth-boundary"
import { conflict as evaluateConflict } from "./memory-truth-boundary"

export const ALGORITHM_REVISION = "memory-recall-v1"

export const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex")

type RankedHit = {
  readonly row: { readonly id: Memory.ID }
  readonly score: number
}

const decisionFor = (conflict: ConflictCandidate, unresolvedMode: Truth.UnresolvedMode) =>
  evaluateConflict({
    kind: "mutually_exclusive_fact",
    status: conflict.conflict.status,
    leftMemoryID: conflict.left.id,
    rightMemoryID: conflict.right.id,
    leftSource: conflict.left.source,
    rightSource: conflict.right.source,
    leftScope: conflict.left.scope,
    rightScope: conflict.right.scope,
    unresolvedMode,
    ...(conflict.conflict.chosenMemoryID === undefined
      ? {}
      : { chosenMemoryID: conflict.conflict.chosenMemoryID }),
  })

/**
 * Applies the truth-boundary disposition before the bounded top-K cut. This
 * prevents excluded or lowered records from consuming the result budget.
 */
export const applyConflictBoundary = <T extends RankedHit>(
  hits: ReadonlyArray<T>,
  conflicts: ReadonlyArray<ConflictCandidate>,
  unresolvedMode: Truth.UnresolvedMode,
): ReadonlyArray<T> => {
  const dispositions = new Map<Memory.ID, Truth.RecallDisposition>()
  for (const conflict of conflicts) {
    const decision = decisionFor(conflict, unresolvedMode)
    const left = conflict.left.id
    const right = conflict.right.id
    dispositions.set(left, mergeDisposition(dispositions.get(left), decision.left))
    dispositions.set(right, mergeDisposition(dispositions.get(right), decision.right))
  }
  const unique = new Map<Memory.ID, T>()
  for (const hit of hits) {
    const disposition = dispositions.get(hit.row.id)
    if (disposition === "exclude") continue
    const adjusted = disposition === "lower" ? { ...hit, score: hit.score * 0.5 } : hit
    const previous = unique.get(hit.row.id)
    if (previous === undefined || adjusted.score > previous.score) unique.set(hit.row.id, adjusted)
  }
  return [...unique.values()].sort((left, right) => right.score - left.score)
}

const mergeDisposition = (
  previous: Truth.RecallDisposition | undefined,
  next: Truth.RecallDisposition,
): Truth.RecallDisposition => {
  if (previous === "exclude" || next === "exclude") return "exclude"
  if (previous === "lower" || next === "lower") return "lower"
  return "include"
}
