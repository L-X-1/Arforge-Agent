import type { Memory } from "@arforge-ai/schema/memory"
import type * as MemoryRetention from "@arforge-ai/schema/memory-retention"

export type LegacyCompatibleRow = {
  readonly id: Memory.ID
  readonly content: Memory.Content
  readonly source: Memory.Source
  readonly scope: Memory.Scope
  readonly lifecycle?: MemoryRetention.Lifecycle | null
  readonly memory_version?: number | null
  readonly provenance_status?: "legacy_unknown" | "verified" | null
  readonly content_digest?: string | null
  readonly retention_mode?: MemoryRetention.RetentionMode | null
}

export type KernelRecord = {
  readonly id: Memory.ID
  readonly content: Memory.Content
  readonly source: Memory.Source
  readonly scope: Memory.Scope
  readonly lifecycle: MemoryRetention.Lifecycle
  readonly version: number
  readonly provenanceStatus: "legacy_unknown" | "verified"
  readonly contentDigest?: string
  readonly retentionMode: MemoryRetention.RetentionMode
}

/**
 * Reads both pre-kernel rows and migrated rows without treating missing
 * provenance as trusted. This adapter is intentionally read-only; Step 5.12
 * owns the later write cutover.
 */
export const read = (row: LegacyCompatibleRow): KernelRecord => ({
  id: row.id,
  content: row.content,
  source: row.source,
  scope: row.scope,
  lifecycle: row.lifecycle ?? (row.source.startsWith("quarantined") ? "quarantined" : "active"),
  version: row.memory_version ?? 1,
  provenanceStatus: row.provenance_status ?? "legacy_unknown",
  ...(row.content_digest === null || row.content_digest === undefined ? {} : { contentDigest: row.content_digest }),
  retentionMode: row.retention_mode ?? "indefinite",
})
