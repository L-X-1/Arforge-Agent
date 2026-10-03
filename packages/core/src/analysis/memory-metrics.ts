import type { Info, RecallQuality, Status } from "../memory"

export interface MemoryMetricsInput {
  readonly status: Pick<Status, "total" | "important" | "workspace" | "global" | "quarantined" | "pendingConflicts">
  readonly recallQuality: Pick<
    RecallQuality,
    "status" | "sampleSize" | "top1Rate" | "meanReciprocalRank" | "noResultRate" | "caveat"
  >
  readonly conflicts: {
    readonly count: number
    readonly items: ReadonlyArray<unknown>
    readonly detectorVersion: string
  }
  /** Bounded visible page used only for source counts; content is not emitted. */
  readonly visible: {
    readonly count: number
    readonly total: number
    readonly items: ReadonlyArray<Pick<Info, "source">>
  }
}

export interface MemoryMetricsReport {
  readonly schema_version: 1
  readonly execution_mode: "read-only-core-memory-metrics"
  readonly side_effects: "none"
  readonly status: {
    readonly total: number
    readonly important: number
    readonly workspace: number
    readonly global: number
    readonly quarantined: number
    readonly pending_conflicts: number
  }
  readonly recall_quality: {
    readonly status: RecallQuality["status"]
    readonly sample_size: number
    readonly top1_rate: number
    readonly mean_reciprocal_rank: number
    readonly no_result_rate: number
    readonly caveat: string
  }
  readonly persisted_conflicts: {
    readonly count: number
    readonly returned: number
    readonly truncated: boolean
    readonly detector_version: string
  }
  readonly source_coverage: {
    readonly status: "not_comparable"
    readonly visible_total: number
    readonly inspected: number
    readonly truncated: boolean
    readonly by_source: ReadonlyArray<{ readonly source: string; readonly count: number }>
    readonly caveat: string
  }
  readonly golden_eval: {
    readonly status: "not_comparable"
    readonly reason: string
  }
  readonly history: {
    readonly status: "not_read"
    readonly reason: string
  }
  readonly caveat: string
}

export interface MemoryWriteStatsInput {
  readonly status: Pick<Status, "total" | "important" | "workspace" | "global" | "quarantined" | "pendingConflicts">
  /** Bounded visible page used for source/type counts; content is not emitted. */
  readonly visible: {
    readonly total: number
    readonly items: ReadonlyArray<Pick<Info, "source" | "type" | "scope">>
  }
}

export interface MemoryWriteStatsReport {
  readonly schema_version: 1
  readonly execution_mode: "read-only-core-memory-write-stats"
  readonly side_effects: "none"
  readonly database: {
    readonly total: number
    readonly important: number
    readonly workspace: number
    readonly global: number
    readonly quarantined: number
    readonly pending_conflicts: number
    readonly inspected: number
    readonly visible_total: number
    readonly truncated: boolean
    readonly by_source: ReadonlyArray<{ readonly source: string; readonly count: number }>
    readonly by_type: ReadonlyArray<{ readonly type: string; readonly count: number }>
    readonly by_scope: ReadonlyArray<{ readonly scope: string; readonly count: number }>
  }
  readonly decision_log: {
    readonly status: "not_read"
    readonly file: "memory_writes.jsonl"
    readonly reason: string
  }
  readonly clear: {
    readonly status: "unsupported"
    readonly reason: string
  }
  readonly caveat: string
}

function sourceCounts(items: ReadonlyArray<Pick<Info, "source">>): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([source, count]) => ({ source, count }))
}

function stableCounts(items: ReadonlyArray<string>): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([value, count]) => ({ value, count }))
}

/**
 * Compose the typed, read-only memory metrics available from Core services.
 *
 * The historical Python command also created isolated golden fixtures and
 * appended benchmark history.  Those are intentionally represented as
 * `not_comparable`/`not_read` until an equivalent typed producer and
 * transaction boundary exist; this function never writes or runs a model.
 */
export function composeMemoryMetrics(input: MemoryMetricsInput): MemoryMetricsReport {
  const inspected = input.visible.items.length
  const visibleTotal = input.visible.total
  return {
    schema_version: 1,
    execution_mode: "read-only-core-memory-metrics",
    side_effects: "none",
    status: {
      total: input.status.total,
      important: input.status.important,
      workspace: input.status.workspace,
      global: input.status.global,
      quarantined: input.status.quarantined,
      pending_conflicts: input.status.pendingConflicts,
    },
    recall_quality: {
      status: input.recallQuality.status,
      sample_size: input.recallQuality.sampleSize,
      top1_rate: input.recallQuality.top1Rate,
      mean_reciprocal_rank: input.recallQuality.meanReciprocalRank,
      no_result_rate: input.recallQuality.noResultRate,
      caveat: input.recallQuality.caveat,
    },
    persisted_conflicts: {
      count: input.conflicts.count,
      returned: input.conflicts.items.length,
      truncated: input.conflicts.items.length < input.conflicts.count,
      detector_version: input.conflicts.detectorVersion,
    },
    source_coverage: {
      status: "not_comparable",
      visible_total: visibleTotal,
      inspected,
      truncated: inspected < visibleTotal,
      by_source: sourceCounts(input.visible.items),
      caveat:
        "Core Memory.Info 当前只暴露 source，不暴露旧 Python provenance；此处仅统计有界可见页，不能当作事实来源可溯源覆盖率。",
    },
    golden_eval: {
      status: "not_comparable",
      reason: "旧 Python golden eval 需要隔离 fixture 写入与 benchmark history producer；等价 typed 合同完成前不执行。",
    },
    history: {
      status: "not_read",
      reason: "TypeScript/Core 尚未接管 memory_metrics.jsonl producer；不读取或创建旧 Python 历史文件。",
    },
    caveat:
      "这是 MemoryV2 的只读 Core 指标组合，不是旧 Python golden retrieval benchmark 的等价替代；不会写入数据库、benchmark history、工作区文件，也不会调用模型。",
  }
}

/**
 * Compose the database-side portion of the historical `memory write-stats`
 * report without reading or mutating the legacy decision log.  The old log
 * contains producer decisions (eligible/reason/saved) that Core does not yet
 * expose as a typed event contract, so those values remain explicitly absent.
 */
export function composeMemoryWriteStats(input: MemoryWriteStatsInput): MemoryWriteStatsReport {
  const inspected = input.visible.items.length
  const visibleTotal = input.visible.total
  return {
    schema_version: 1,
    execution_mode: "read-only-core-memory-write-stats",
    side_effects: "none",
    database: {
      total: input.status.total,
      important: input.status.important,
      workspace: input.status.workspace,
      global: input.status.global,
      quarantined: input.status.quarantined,
      pending_conflicts: input.status.pendingConflicts,
      inspected,
      visible_total: visibleTotal,
      truncated: inspected < visibleTotal,
      by_source: sourceCounts(input.visible.items),
      by_type: stableCounts(input.visible.items.map((item) => item.type)).map(({ value, count }) => ({
        type: value,
        count,
      })),
      by_scope: stableCounts(input.visible.items.map((item) => item.scope)).map(({ value, count }) => ({
        scope: value,
        count,
      })),
    },
    decision_log: {
      status: "not_read",
      file: "memory_writes.jsonl",
      reason: "TypeScript/Core 尚未接管旧 Python 写入决策事件 producer；不读取或创建该文件。",
    },
    clear: {
      status: "unsupported",
      reason: "清理旧写入决策日志会删除迁移期数据；等价 typed producer 和权限/审计合同完成前保持退出码 2。",
    },
    caveat:
      "这是工作区 MemoryV2 的只读数据库投影，不是旧 Python 写入门禁事件聚合；eligible/reason/saved 等事件字段在 Core producer 合同完成前不会被猜测。",
  }
}

export const MemoryMetricsAnalysis = {
  compose: composeMemoryMetrics,
}

export const MemoryWriteStatsAnalysis = {
  compose: composeMemoryWriteStats,
}
