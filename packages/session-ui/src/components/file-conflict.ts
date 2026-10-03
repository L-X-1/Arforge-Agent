export type FileConflictCode = "observed_version_mismatch" | "target_exists"

export type FileConflict = {
  kind: "file_conflict"
  code: FileConflictCode
  path: string
  observedVersion?: string
  currentVersion?: string
}

const record = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const text = (value: unknown, max: number) => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/**
 * Read the shared file-conflict metadata emitted by Core and mature tools.
 * The nested form is accepted for forward/backward compatibility with
 * adapters that wrap structured tool metadata under `conflict`.
 */
export function parseFileConflict(metadata: unknown): FileConflict | undefined {
  const root = record(metadata)
  if (!root) return undefined
  const value = record(root.conflict) ?? root
  if (value.kind !== "file_conflict") return undefined
  const code = value.code
  if (code !== "observed_version_mismatch" && code !== "target_exists") return undefined
  const path = text(value.path, 2048)
  if (!path) return undefined

  return {
    kind: "file_conflict",
    code,
    path,
    ...(text(value.observedVersion, 64) ? { observedVersion: text(value.observedVersion, 64) } : {}),
    ...(text(value.currentVersion, 64) ? { currentVersion: text(value.currentVersion, 64) } : {}),
  }
}

/** Keep content hashes useful for diagnostics without filling the timeline. */
export function shortVersion(value: string | undefined) {
  if (!value) return undefined
  return value.length <= 12 ? value : `${value.slice(0, 12)}…`
}
