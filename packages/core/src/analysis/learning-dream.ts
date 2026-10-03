import type { Learning } from "@arforge-ai/schema/learning"
import type { Status as LearningStatus } from "../learning"

/**
 * Compose the safe portion of the historical `learning dream` report.
 *
 * This is intentionally a pure projection over the already workspace-scoped
 * Core status.  It does not extract or persist patterns, invoke an LLM, read
 * the legacy Python database, or create a second learning state machine.
 */
export function composeLearningDream(
  status: Omit<
    Pick<LearningStatus, "totalTurns" | "failedTurns" | "successRate" | "patternCount" | "patterns">,
    "patterns"
  > & {
    readonly patterns: ReadonlyArray<
      Pick<LearningStatus["patterns"][number], "type" | "description" | "frequency" | "confidence">
    >
  },
  now = Date.now(),
): Learning.Dream {
  const insights: string[] = []
  const suggestions: string[] = []
  const patterns = status.patterns
  const totalTurns = Math.max(0, Math.trunc(status.totalTurns))
  const totalFailures = Math.max(0, Math.trunc(status.failedTurns))
  const totalPatterns = Math.max(0, Math.trunc(status.patternCount))
  const successRate = Number.isFinite(status.successRate) ? Math.max(0, Math.min(1, status.successRate)) : 0
  const percent = Math.round(successRate * 100)

  if (totalTurns > 10) {
    if (successRate < 0.7) {
      insights.push(`Success rate is low (${percent}%); ${totalFailures}/${totalTurns} failures.`)
      suggestions.push("Review the most frequent failure pattern before enabling more automation.")
    } else if (successRate >= 0.9) {
      insights.push(`Success rate is high (${percent}%); system is performing well.`)
    }
  }

  const types = new Set(patterns.map((pattern) => pattern.type.trim().toLowerCase()))
  if (!types.has("fix")) suggestions.push("No fix strategies are visible yet; collect verified outcomes before proposing one.")
  if (!types.has("preference")) suggestions.push("No user preferences are visible yet; more explicit feedback may help.")

  const topFailure = patterns.find((pattern) => pattern.type.trim().toLowerCase() === "failure")
  if (topFailure) {
    const description = clip(topFailure.description, 160)
    insights.push(
      `Top failure: ${description} (seen ${Math.max(1, Math.trunc(topFailure.frequency))}x, confidence ${Math.round(topFailure.confidence * 100)}%).`,
    )
    suggestions.push(`Address the top failure pattern: ${clip(topFailure.description, 100)}`)
  }

  const stale = patterns.filter((pattern) => pattern.frequency === 1 && pattern.confidence < 0.4).length
  if (stale > 0) {
    insights.push(`${stale} low-confidence patterns are visible (${totalPatterns} total); more data is needed.`)
  }

  return {
    consolidation: {
      status: "not_run",
      patternsFound: 0,
      savedNew: 0,
      updatedExisting: 0,
      patterns: 0,
      breakdown: { failure: 0, fix: 0, preference: 0 },
      reason:
        "This read-only projection does not run consolidation or write patterns. Use a future typed maintenance action when its transaction and evidence contract is available.",
    },
    dream: {
      totalTurns,
      totalFailures,
      totalPatterns,
      insights,
      suggestions,
      timestamp: new Date(now).toISOString(),
    },
    executionMode: "read-only-core-projection",
    sideEffects: "none",
    caveat:
      "This reflection is a deterministic projection of the workspace-scoped Learning.status. It does not run legacy consolidation, call a model, or prove causal improvement.",
  }
}

function clip(value: string, maximum: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim()
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized
}

export const LearningDreamAnalysis = {
  compose: composeLearningDream,
}
