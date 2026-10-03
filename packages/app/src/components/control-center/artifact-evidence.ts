import type { Locale } from "@/context/language"

export type ArtifactAuditChainRecord = Readonly<{
  readonly sequence: number
  readonly previousHash: string
  readonly recordHash: string
}>

export type ArtifactAuditChainState = "empty" | "intact" | "windowed" | "broken"

/** Keep immutable identifiers useful to a human without making the card noisy. */
export function shortArtifactIdentifier(value: string, visible = 12): string {
  const normalized = value.trim()
  if (normalized.length <= visible) return normalized
  const head = Math.max(4, Math.floor((visible - 1) / 2))
  const tail = Math.max(3, visible - head - 1)
  return `${normalized.slice(0, head)}…${normalized.slice(-tail)}`
}

/** Format receipt sizes without exposing a local storage path or filesystem detail. */
export function formatArtifactBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—"
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

/**
 * Classify only what the returned audit window proves. A bounded page cannot
 * be presented as a complete chain when older records were dropped or paged
 * out, so `windowed` is deliberately distinct from `intact`.
 */
export function artifactAuditChainState(
  records: ReadonlyArray<ArtifactAuditChainRecord>,
  droppedAuditEntries: number,
): ArtifactAuditChainState {
  if (records.length === 0) return "empty"
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (current.sequence !== previous.sequence + 1 || current.previousHash !== previous.recordHash) return "broken"
  }
  const first = ordered[0]
  if (droppedAuditEntries > 0 || first.sequence !== 1 || first.previousHash !== "genesis") return "windowed"
  return "intact"
}

/** Localized action labels for metadata-only audit rows. */
export function artifactActionText(action: string, locale: Locale): string {
  const labels: Record<string, readonly [string, string, string]> = {
    registered: ["Registered", "已登记", "已登記"],
    read: ["Read", "已读取", "已讀取"],
    range: ["Range read", "已读取范围", "已讀取範圍"],
    rejected: ["Rejected", "已拒绝", "已拒絕"],
    rate_limited: ["Rate limited", "已限流", "已限流"],
    removed: ["Removed", "已移除", "已移除"],
  }
  const value = labels[action]
  if (!value) return action
  return value[locale === "zh" ? 1 : locale === "zht" ? 2 : 0]
}
