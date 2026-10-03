import { Effect } from "effect"
import type { InvariantMode, InvariantReport, RuntimeInvariantRegistry } from "./runtime/invariants"
import { assertWorkspaceRootMutationEnableGate } from "./workspace-roots"
import { assertWorkspaceRootProductionOwnerEvidence } from "./workspace-root-production-evidence"
import type {
  WorkspaceRootFileWriterPreflight,
  WorkspaceRootFileWriterPreflightCheck,
} from "./workspace-root-file-writer"

/**
 * Package-owned invariant for the workspace-root writer's read-only evidence
 * card.  This only validates an already-produced preflight snapshot; it does
 * not acquire the writer lock, repair files, or grant mutation authority.
 */
export const OWNER = "workspace-root-writer" as const
export const KEY = "preflight" as const
export const ENABLE_GATE_KEY = "enable-gate" as const
export const PRODUCTION_OWNER_KEY = "production-owner" as const
export const VERSION = "1" as const

const CHECK_IDS: ReadonlySet<WorkspaceRootFileWriterPreflightCheck["id"]> = new Set([
  "profile",
  "primary",
  "state",
  "journal",
  "outbox",
  "audit",
  "rollback",
  "lock",
])

const CHECK_STATUSES: ReadonlySet<WorkspaceRootFileWriterPreflightCheck["status"]> = new Set([
  "satisfied",
  "pending",
  "blocked",
])

const REASONS: ReadonlySet<string> = new Set([
  "writer_disabled",
  "seam_missing",
  "authorization_invalid",
  "plan_mismatch",
  "state_malformed",
  "state_conflict",
  "rollback_unavailable",
  "outbox_unavailable",
  "recovery_required",
  "cas_rejected",
  "audit_unavailable",
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value) && value.length <= 32_768

const hasExactKeys = (record: Record<string, unknown>, required: ReadonlyArray<string>): boolean => {
  const keys = Object.keys(record)
  return keys.length === required.length && required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
}

const assertPreflight = (value: unknown): void => {
  if (!isRecord(value)) throw new Error("workspace writer preflight is not an object")
  if (
    !hasExactKeys(value, [
      "schema_version",
      "execution_mode",
      "side_effects",
      "profile_directory",
      "primary",
      "status",
      "ready",
      "checks",
      "blocking_reasons",
    ])
  )
    throw new Error("workspace writer preflight fields drifted")
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
    throw new Error("workspace writer preflight fields drifted")

  const checks = value.checks as unknown[]
  const ids = new Set<string>()
  for (const item of checks) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !CHECK_IDS.has(item.id as WorkspaceRootFileWriterPreflightCheck["id"])
    )
      throw new Error("workspace writer preflight check id is invalid")
    if (
      !hasExactKeys(
        item,
        item.reason === undefined ? ["id", "status", "observation"] : ["id", "status", "observation", "reason"],
      )
    )
      throw new Error(`workspace writer preflight check fields drifted: ${item.id}`)
    if (ids.has(item.id)) throw new Error(`workspace writer preflight check is duplicated: ${item.id}`)
    ids.add(item.id)
    if (
      typeof item.status !== "string" ||
      !CHECK_STATUSES.has(item.status as WorkspaceRootFileWriterPreflightCheck["status"]) ||
      typeof item.observation !== "string" ||
      item.observation.length === 0 ||
      item.observation.length > 512
    )
      throw new Error(`workspace writer preflight check is malformed: ${item.id}`)
    if (item.reason !== undefined && (typeof item.reason !== "string" || !REASONS.has(item.reason)))
      throw new Error(`workspace writer preflight check reason is invalid: ${item.id}`)
    if ((item.status === "blocked" || item.status === "pending") && item.reason === undefined)
      throw new Error(`workspace writer preflight non-satisfied check lacks a reason: ${item.id}`)
    if (item.status === "satisfied" && item.reason !== undefined)
      throw new Error(`workspace writer preflight satisfied check carries a reason: ${item.id}`)
  }

  if (!ids.has("profile") || !ids.has("primary")) throw new Error("workspace writer preflight root checks are missing")
  if (isAbsolutePath(value.profile_directory) && isAbsolutePath(value.primary) && ids.size !== CHECK_IDS.size)
    throw new Error("workspace writer preflight checks are incomplete")

  const blockingReasons = value.blocking_reasons as unknown[]
  const reasonSet = new Set<string>()
  for (const reason of blockingReasons) {
    if (typeof reason !== "string" || !REASONS.has(reason))
      throw new Error("workspace writer blocking reason is invalid")
    if (reasonSet.has(reason)) throw new Error("workspace writer blocking reasons are duplicated")
    reasonSet.add(reason)
  }

  const checkReasons = new Set(
    checks
      .filter((item): item is Record<string, unknown> => isRecord(item) && item.reason !== undefined)
      .map((item) => item.reason as string),
  )
  for (const reason of reasonSet) {
    if (!checkReasons.has(reason)) throw new Error("workspace writer blocking reason has no check evidence")
  }
  for (const check of checks) {
    if (isRecord(check) && check.reason !== undefined && !reasonSet.has(check.reason as string))
      throw new Error(`workspace writer check reason is missing from blocking reasons: ${check.id}`)
  }

  const hasPendingOrBlocked = checks.some(
    (item) => isRecord(item) && (item.status === "pending" || item.status === "blocked"),
  )
  if (value.status === "clear") {
    if (value.ready !== true || blockingReasons.length !== 0 || hasPendingOrBlocked)
      throw new Error("clear workspace writer preflight is not ready and clean")
  } else if (value.ready !== false || blockingReasons.length === 0 || !hasPendingOrBlocked) {
    throw new Error("blocked workspace writer preflight is internally inconsistent")
  }
}

export type WorkspaceRootWriterInvariantContext =
  | Readonly<{
      readonly preflight: unknown
    }>
  | Readonly<{
      readonly kind: "enable-gate"
      readonly gate: unknown
    }>
  | Readonly<{
      readonly kind: "production-owner"
      readonly evidence: unknown
    }>

export const registerInvariants = (registry: RuntimeInvariantRegistry): void => {
  if (!registry.get(OWNER, KEY, VERSION))
    registry.register({
      owner: OWNER,
      key: KEY,
      version: VERSION,
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (!isRecord(context) || !Object.prototype.hasOwnProperty.call(context, "preflight"))
            throw new Error("workspace writer invariant context is invalid")
          assertPreflight(context.preflight)
        }),
    })
  if (!registry.get(OWNER, ENABLE_GATE_KEY, VERSION))
    registry.register({
      owner: OWNER,
      key: ENABLE_GATE_KEY,
      version: VERSION,
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (!isRecord(context) || context.kind !== "enable-gate")
            throw new Error("workspace writer enable gate invariant context is invalid")
          assertWorkspaceRootMutationEnableGate(context.gate)
        }),
    })
  if (!registry.get(OWNER, PRODUCTION_OWNER_KEY, VERSION))
    registry.register({
      owner: OWNER,
      key: PRODUCTION_OWNER_KEY,
      version: VERSION,
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (!isRecord(context) || context.kind !== "production-owner")
            throw new Error("workspace writer production owner invariant context is invalid")
          assertWorkspaceRootProductionOwnerEvidence(context.evidence)
        }),
    })
}

export const inspect = (
  registry: RuntimeInvariantRegistry,
  context: WorkspaceRootWriterInvariantContext,
  mode: InvariantMode = process.env.NODE_ENV === "production" ? "production" : "development",
): Effect.Effect<InvariantReport> => {
  registerInvariants(registry)
  const key =
    "kind" in context && context.kind === "enable-gate"
      ? ENABLE_GATE_KEY
      : "kind" in context && context.kind === "production-owner"
        ? PRODUCTION_OWNER_KEY
        : KEY
  return registry.run(context, { owner: OWNER, key, mode })
}
