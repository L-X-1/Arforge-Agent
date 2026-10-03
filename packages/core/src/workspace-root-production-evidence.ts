import type { WorkspaceRootProductionOwner } from "./workspace-root-owner"
import type {
  WorkspaceRootFileWriterPreflight,
  WorkspaceRootFileWriterPreflightCheck,
} from "./workspace-root-file-writer"
import { assertWorkspaceRootMutationEnableGate, type WorkspaceRootMutationEnableDecision } from "./workspace-roots"

/**
 * A metadata-only proof that the canonical production binding is complete.
 *
 * This card deliberately does not enable the writer.  It records whether the
 * concrete owner exposes every required seam, together with the authoritative
 * five-gate decision and the read-only persisted-boundary preflight.  A clean
 * card therefore proves inspectability and ownership, never permission to
 * mutate a user profile.
 */
export const SCHEMA_VERSION = 1 as const
export const EXECUTION_MODE = "read-only-workspace-root-production-owner-evidence" as const
export const OWNER = "typescript-core-workspace-root-writer" as const

export const REQUIRED_SEAMS = [
  "readState",
  "targetIsDirectory",
  "createRollbackArtifact",
  "appendRecoveryOutbox",
  "compareAndSwap",
  "audit",
  "findExactCommittedMutation",
  "withExclusive",
] as const

export type WorkspaceRootProductionOwnerEvidence = Readonly<{
  readonly schema_version: typeof SCHEMA_VERSION
  readonly execution_mode: typeof EXECUTION_MODE
  readonly side_effects: "none"
  readonly owner: typeof OWNER
  readonly profile_directory: string
  readonly primary: string
  readonly binding_status: "complete" | "incomplete"
  readonly required_seams: ReadonlyArray<
    Readonly<{ readonly id: (typeof REQUIRED_SEAMS)[number]; readonly bound: boolean }>
  >
  readonly missing_seams: ReadonlyArray<(typeof REQUIRED_SEAMS)[number]>
  readonly writer_enabled: boolean
  readonly preflight: WorkspaceRootFileWriterPreflight
  readonly enable_gate: WorkspaceRootMutationEnableDecision
  readonly status: "ready" | "blocked"
  readonly ready: boolean
  readonly decision: "keep-disabled"
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasExactKeys = (record: Record<string, unknown>, required: ReadonlyArray<string>): boolean => {
  const keys = Object.keys(record).sort()
  return JSON.stringify(keys) === JSON.stringify([...required].sort())
}

const isAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value) && value.length <= 32_768

function assertPreflightSummary(value: unknown): asserts value is WorkspaceRootFileWriterPreflight {
  if (!isRecord(value)) throw new Error("workspace production owner preflight is invalid")
  if (
    value.schema_version !== 1 ||
    value.execution_mode !== "read-only-workspace-root-writer-preflight" ||
    value.side_effects !== "none" ||
    !isAbsolutePath(value.profile_directory) ||
    !isAbsolutePath(value.primary) ||
    (value.status !== "clear" && value.status !== "blocked") ||
    typeof value.ready !== "boolean" ||
    !Array.isArray(value.checks) ||
    !Array.isArray(value.blocking_reasons)
  )
    throw new Error("workspace production owner preflight fields are invalid")

  const checks = value.checks as unknown[]
  const ids = new Set<string>()
  for (const item of checks) {
    if (!isRecord(item)) throw new Error("workspace production owner preflight check is invalid")
    if (
      typeof item.id !== "string" ||
      !new Set<WorkspaceRootFileWriterPreflightCheck["id"]>([
        "profile",
        "primary",
        "state",
        "journal",
        "outbox",
        "audit",
        "rollback",
        "lock",
      ]).has(item.id as WorkspaceRootFileWriterPreflightCheck["id"]) ||
      ids.has(item.id) ||
      (item.status !== "satisfied" && item.status !== "pending" && item.status !== "blocked") ||
      typeof item.observation !== "string" ||
      item.observation.length === 0 ||
      item.observation.length > 512
    )
      throw new Error("workspace production owner preflight check is invalid")
    ids.add(item.id)
    if (item.reason !== undefined && typeof item.reason !== "string")
      throw new Error("workspace production owner preflight check reason is invalid")
    if ((item.status === "blocked" || item.status === "pending") && item.reason === undefined)
      throw new Error("workspace production owner preflight check reason is missing")
    if (item.status === "satisfied" && item.reason !== undefined)
      throw new Error("workspace production owner preflight satisfied check has a reason")
  }
  if (ids.size !== 8 || !ids.has("profile") || !ids.has("primary"))
    throw new Error("workspace production owner preflight checks are incomplete")
  const blocking = value.blocking_reasons as unknown[]
  if (blocking.some((reason) => typeof reason !== "string"))
    throw new Error("workspace production owner preflight blocking reason is invalid")
  const hasBlocked = checks.some((item) => isRecord(item) && (item.status === "blocked" || item.status === "pending"))
  if (value.status === "clear" && (!value.ready || blocking.length !== 0 || hasBlocked))
    throw new Error("clear workspace production owner preflight is inconsistent")
  if (value.status === "blocked" && (value.ready || blocking.length === 0 || !hasBlocked))
    throw new Error("blocked workspace production owner preflight is inconsistent")
}

/** Validate a copied owner-evidence card before it reaches a runtime invariant. */
export const assertWorkspaceRootProductionOwnerEvidence = (value: unknown): void => {
  if (!isRecord(value)) throw new Error("workspace production owner evidence is invalid")
  const keys = [
    "schema_version",
    "execution_mode",
    "side_effects",
    "owner",
    "profile_directory",
    "primary",
    "binding_status",
    "required_seams",
    "missing_seams",
    "writer_enabled",
    "preflight",
    "enable_gate",
    "status",
    "ready",
    "decision",
  ]
  if (!hasExactKeys(value, keys)) throw new Error("workspace production owner evidence fields drifted")
  if (
    value.schema_version !== SCHEMA_VERSION ||
    value.execution_mode !== EXECUTION_MODE ||
    value.side_effects !== "none" ||
    value.owner !== OWNER ||
    !isAbsolutePath(value.profile_directory) ||
    !isAbsolutePath(value.primary) ||
    (value.binding_status !== "complete" && value.binding_status !== "incomplete") ||
    !Array.isArray(value.required_seams) ||
    !Array.isArray(value.missing_seams) ||
    typeof value.writer_enabled !== "boolean" ||
    (value.status !== "ready" && value.status !== "blocked") ||
    typeof value.ready !== "boolean" ||
    value.decision !== "keep-disabled"
  )
    throw new Error("workspace production owner evidence fields are invalid")

  const preflight = value.preflight as WorkspaceRootFileWriterPreflight
  const enableGate = value.enable_gate as WorkspaceRootMutationEnableDecision
  assertPreflightSummary(preflight)
  assertWorkspaceRootMutationEnableGate(enableGate)
  const ready = value.ready as boolean
  const writerEnabled = value.writer_enabled as boolean

  const seamRows = value.required_seams as unknown[]
  if (seamRows.length !== REQUIRED_SEAMS.length)
    throw new Error("workspace production owner evidence seam set is incomplete")
  const seen = new Set<string>()
  for (const [index, item] of seamRows.entries()) {
    if (!isRecord(item) || !hasExactKeys(item, ["id", "bound"]))
      throw new Error("workspace production owner evidence seam row is invalid")
    if (item.id !== REQUIRED_SEAMS[index] || typeof item.bound !== "boolean" || seen.has(item.id as string))
      throw new Error("workspace production owner evidence seam row drifted")
    seen.add(item.id as string)
  }
  const missing = value.missing_seams as unknown[]
  if (
    missing.some(
      (item) => typeof item !== "string" || !REQUIRED_SEAMS.includes(item as (typeof REQUIRED_SEAMS)[number]),
    ) ||
    new Set(missing).size !== missing.length ||
    JSON.stringify(missing) !==
      JSON.stringify(
        seamRows
          .filter((item) => !(item as Record<string, unknown>).bound)
          .map((item) => (item as Record<string, unknown>).id),
      )
  )
    throw new Error("workspace production owner evidence missing seam projection drifted")
  if ((value.binding_status === "complete") !== (missing.length === 0))
    throw new Error("workspace production owner evidence binding status drifted")
  if ((value.status === "ready") !== ready) throw new Error("workspace production owner evidence ready/status drifted")
  if (ready && (writerEnabled !== true || preflight.ready !== true))
    throw new Error("ready workspace production owner evidence is not enabled by every gate")
  if (!ready && writerEnabled && enableGate.ready === false)
    throw new Error("enabled workspace production owner evidence contradicts the enable gate")
}

/** Build a deterministic, side-effect-free production owner evidence card. */
export const inspectWorkspaceRootProductionOwner = (
  owner: WorkspaceRootProductionOwner,
): WorkspaceRootProductionOwnerEvidence => {
  const seamRows = REQUIRED_SEAMS.map((id) => ({
    id,
    bound: typeof owner.writer[id] === "function",
  }))
  const missing = seamRows.filter((row) => !row.bound).map((row) => row.id)
  const preflight = owner.preflight()
  const binding_status = missing.length === 0 ? ("complete" as const) : ("incomplete" as const)
  const ready =
    binding_status === "complete" &&
    owner.enabled &&
    owner.writer.enabled === true &&
    owner.gate.ready &&
    preflight.ready
  const evidence: WorkspaceRootProductionOwnerEvidence = {
    schema_version: SCHEMA_VERSION,
    execution_mode: EXECUTION_MODE,
    side_effects: "none",
    owner: OWNER,
    profile_directory: owner.profileDirectory,
    primary: owner.primary,
    binding_status,
    required_seams: Object.freeze(seamRows),
    missing_seams: Object.freeze(missing),
    writer_enabled: owner.writer.enabled === true,
    preflight,
    enable_gate: owner.gate,
    status: ready ? "ready" : "blocked",
    ready,
    decision: "keep-disabled",
  }
  assertWorkspaceRootProductionOwnerEvidence(evidence)
  return Object.freeze(evidence)
}
