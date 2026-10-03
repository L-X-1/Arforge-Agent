import type { Memory } from "@arforge-ai/schema/memory"
import * as Truth from "@arforge-ai/schema/memory-truth-boundary"

export const NEAR_DUPLICATE_THRESHOLD = 0.92

export const dedup = (input: {
  readonly leftMemoryID: Memory.ID
  readonly rightMemoryID: Memory.ID
  readonly similarity: number
  readonly exactDigestMatch?: boolean
}): Truth.DedupDecision => ({
  relation: input.exactDigestMatch
    ? "exact_duplicate"
    : input.similarity >= NEAR_DUPLICATE_THRESHOLD
      ? "near_duplicate"
      : "novel",
  similarity: input.similarity,
  leftMemoryID: input.leftMemoryID,
  rightMemoryID: input.rightMemoryID,
})

const sourcePriority = (source: Memory.Source): number => {
  switch (source) {
    case "user-corrected":
      return 4
    case "user":
      return 3
    case "imported":
      return 2
    case "auto":
    case "model":
      return 1
    case "quarantined":
    case "quarantined:auto":
      case "quarantined:model":
        return 0
  }
  return 0
}

const lowerOrExclude = (mode: Truth.UnresolvedMode): Truth.RecallDisposition =>
  mode === "exclude_both" ? "exclude" : "lower"

export const conflict = (input: Truth.ConflictInput): Truth.ConflictDecision => {
  if (input.status === "resolved" && input.chosenMemoryID !== undefined) {
    if (input.chosenMemoryID !== input.leftMemoryID && input.chosenMemoryID !== input.rightMemoryID) {
      return {
        truthBoundary: "governed_record",
        left: "lower",
        right: "lower",
        reason: "Resolved conflict points outside the two records; both remain bounded.",
      }
    }
    return {
      truthBoundary: "governed_record",
      left: input.chosenMemoryID === input.leftMemoryID ? "include" : "lower",
      right: input.chosenMemoryID === input.rightMemoryID ? "include" : "lower",
      priorityMemoryID: input.chosenMemoryID,
      reason: "Resolved conflict promotes the chosen governed record without claiming objective truth.",
    }
  }

  if (input.status === "dismissed" || input.status === "undone") {
    return {
      truthBoundary: "governed_record",
      left: "include",
      right: "include",
      reason: "Closed or undone conflict no longer restricts either governed record.",
    }
  }

  if (input.kind === "stale_successor" && input.staleMemoryID !== undefined) {
    return {
      truthBoundary: "governed_record",
      left: input.staleMemoryID === input.leftMemoryID ? "lower" : "include",
      right: input.staleMemoryID === input.rightMemoryID ? "lower" : "include",
      reason: "Stale successor is lowered until its lineage is reviewed.",
    }
  }

  const disposition = lowerOrExclude(input.unresolvedMode)
  const priorityMemoryID =
    input.kind === "user_vs_auto_priority"
      ? sourcePriority(input.leftSource) >= sourcePriority(input.rightSource)
        ? input.leftMemoryID
        : input.rightMemoryID
      : undefined
  return {
    truthBoundary: "governed_record",
    left: disposition,
    right: disposition,
    ...(priorityMemoryID === undefined ? {} : { priorityMemoryID }),
    reason:
      input.unresolvedMode === "exclude_both"
        ? "Unresolved conflict excludes both records from ordinary recall."
        : "Unresolved conflict lowers both records; priority is advisory and not truth.",
  }
}
