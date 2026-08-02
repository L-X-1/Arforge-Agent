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

export const Backup = Schema.Struct({
  available: Schema.Boolean,
  createdAt: Schema.String.pipe(optional),
  database: Schema.String.pipe(optional),
  bytes: NonNegativeInt,
  encrypted: Schema.Boolean,
  checksumVerified: Schema.Boolean,
  restoreListVerified: Schema.Boolean,
})

export const RecoveryDrill = Schema.Struct({
  available: Schema.Boolean,
  completedAt: Schema.String.pipe(optional),
  passed: Schema.Boolean,
  tables: NonNegativeInt,
  sourceRows: NonNegativeInt,
  restoredRows: NonNegativeInt,
  differences: NonNegativeInt,
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
})
export interface Overview extends Schema.Schema.Type<typeof Overview> {}
