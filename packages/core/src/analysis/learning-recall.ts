import type { RecallQuality } from "../memory"
import type { Status as LearningStatus } from "../learning"

export type LearningRecallMemorySource = Pick<
  RecallQuality,
  "status" | "sampleSize" | "top1Rate" | "meanReciprocalRank" | "noResultRate" | "caveat"
>

export type LearningRecallLearningSource = Pick<
  LearningStatus,
  "totalTurns" | "patternCount" | "successRate" | "impact"
>

export interface LearningRecallReport {
  readonly schema_version: 1
  /** This report composes two existing read-only Core contracts. */
  readonly execution_mode: "read-only-composition"
  readonly top1_hit_rate: number
  readonly pattern_count: number
  readonly sample_size: number
  readonly mean_reciprocal_rank: number
  readonly no_result_rate: number
  readonly learning_turns: number
  readonly learning_success_rate: number
  readonly memory_status: LearningRecallMemorySource["status"]
  readonly learning_impact_status: LearningRecallLearningSource["impact"]["status"]
  readonly caveat: string
}

export function composeLearningRecall(
  memory: LearningRecallMemorySource,
  learning: LearningRecallLearningSource,
): LearningRecallReport {
  return {
    schema_version: 1,
    execution_mode: "read-only-composition",
    top1_hit_rate: memory.top1Rate,
    pattern_count: learning.patternCount,
    sample_size: memory.sampleSize,
    mean_reciprocal_rank: memory.meanReciprocalRank,
    no_result_rate: memory.noResultRate,
    learning_turns: learning.totalTurns,
    learning_success_rate: learning.successRate,
    memory_status: memory.status,
    learning_impact_status: learning.impact.status,
    caveat:
      "此报告只组合 Memory.recallQuality 与 Learning.status 的只读数据；不会运行 dream/consolidation，也不会写入状态。",
  }
}

export const LearningRecallAnalysis = {
  compose: composeLearningRecall,
}
