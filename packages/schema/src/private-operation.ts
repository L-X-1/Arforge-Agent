export * as PrivateOperation from "./private-operation"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

export const Check = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.String,
})

export const Doctor = Schema.Struct({
  ok: Schema.Boolean,
  passed: NonNegativeInt,
  failed: NonNegativeInt,
  checks: Schema.Array(Check),
})

export const Usage = Schema.Struct({
  sessions: NonNegativeInt,
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cacheRead: NonNegativeInt,
    cacheWrite: NonNegativeInt,
    total: NonNegativeInt,
  }),
})

/**
 * Availability, checksum and catalog verification are deliberately separate
 * facts: a manifest can exist while its archive is missing, the archive can be
 * unreadable, and the digest can disagree with the manifest. The legacy
 * `checksumVerified` / `restoreListVerified` booleans remain for older clients
 * and are only true for the stronger, actually-verified combinations.
 */
export const Backup = Schema.Struct({
  available: Schema.Boolean,
  createdAt: Schema.String.pipe(optional),
  database: Schema.String.pipe(optional),
  bytes: NonNegativeInt,
  encrypted: Schema.Boolean,
  checksumVerified: Schema.Boolean,
  restoreListVerified: Schema.Boolean,
  fileState: Schema.Literals(["available", "missing", "unavailable"]).pipe(optional),
  checksumState: Schema.Literals(["verified", "mismatch", "missing", "unreadable", "unverified"]).pipe(optional),
  catalogState: Schema.Literals(["recorded", "unrecorded", "missing", "unknown"]).pipe(optional),
})

/**
 * `state` binds the recovery evidence to the selected archive and digest.
 * `historical` means a report is bound to the recorded archive, but the archive
 * currently on disk is not verified against that digest, so the evidence is a
 * historical record and never a current pass. Legacy fields keep their shape
 * for older clients; `passed` is only true for the `verified` state.
 */
export const RecoveryDrill = Schema.Struct({
  available: Schema.Boolean,
  completedAt: Schema.String.pipe(optional),
  passed: Schema.Boolean,
  tables: NonNegativeInt,
  sourceRows: NonNegativeInt,
  restoredRows: NonNegativeInt,
  differences: NonNegativeInt,
  state: Schema.Literals(["verified", "failed", "pending", "unbound", "historical"]).pipe(optional),
  bound: Schema.Boolean.pipe(optional),
})

/**
 * Read-only projection of one known Windows backup scheduled task. Only the
 * allow-listed name, last run time and scheduler result are projected; task
 * actions (command and arguments) are never part of this contract.
 */
export const WindowsBackupTask = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["succeeded", "failed", "running", "never", "disabled", "unknown"]),
  lastRunAt: Schema.String.pipe(optional),
  exitCode: NonNegativeInt.pipe(optional),
})

export const Secrets = Schema.Struct({
  filesScanned: NonNegativeInt,
  filesSkipped: NonNegativeInt,
  findingFiles: NonNegativeInt,
  findings: NonNegativeInt,
  truncated: Schema.Boolean,
})

export const Logs = Schema.Struct({
  retentionDays: NonNegativeInt,
  cutoff: Schema.String,
  files: NonNegativeInt,
  bytes: NonNegativeInt,
})

export const Overview = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  readOnly: Schema.Literal(true),
  doctor: Doctor,
  usage: Usage,
  backup: Backup,
  recoveryDrill: RecoveryDrill,
  secrets: Secrets,
  logs: Logs,
  windowsBackupTasks: Schema.Array(WindowsBackupTask).pipe(optional),
})
export interface Overview extends Schema.Schema.Type<typeof Overview> {}
