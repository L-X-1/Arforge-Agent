/**
 * Durable metadata-only receipt for cross-owner child settlement recovery.
 *
 * The outbox owns coordination metadata only. Evidence, ChildRunResult and
 * ParentBudget remain owned by ExperienceStore/DurableRun; this module never
 * stores their payloads and never invokes a provider. A receipt is scoped by
 * tenant + user + immutable settlement intent and advances monotonically:
 * prepared -> committed or recovery-required. Between those states, the
 * ordered owner promotion prefix is persisted as metadata-only progress. A
 * recovery-required receipt can be explicitly reopened by prepare() with the
 * exact same commit plan without losing that prefix.
 */

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import * as ChildSettlement from "./child-settlement"
import { ChildSettlementRecoveryOutboxTable, type SettlementOutboxOwnerProgress } from "./settlement-outbox.sql"
import { canonicalHash } from "../util/canonical-hash"

export const SETTLEMENT_OUTBOX_SCHEMA_VERSION = 1 as const
export const SETTLEMENT_OUTBOX_OWNER_PROGRESS_SCHEMA_VERSION = 1 as const
export type SettlementOutboxStatus = "prepared" | "committed" | "recovery-required"

const DIGEST = /^[a-f0-9]{64}$/i
const INTENT_ID = /^stl_[a-f0-9]{64}$/i
const RUN_ID = /^run_[A-Za-z0-9._:-]{1,255}$/
const OWNER_ID = /^[A-Za-z0-9._:-]{1,255}$/
const MAX_REASON_LENGTH = 512

export interface SettlementOutboxIdentity {
  readonly tenantID: string
  readonly userID: string
}

export interface SettlementOutboxRecord {
  readonly schemaVersion: typeof SETTLEMENT_OUTBOX_SCHEMA_VERSION
  readonly tenantID: string
  readonly userID: string
  readonly intentID: string
  readonly parentRunID: ChildSettlement.SettlementCommitPlan["parentRunID"]
  readonly childRunID: ChildSettlement.SettlementCommitPlan["childRunID"]
  readonly commitDigest: string
  readonly mode: "recovery-outbox"
  readonly status: SettlementOutboxStatus
  readonly ownerOrder: ChildSettlement.SettlementCommitPlan["ownerOrder"]
  readonly expectedDigests: ChildSettlement.SettlementCommitPlan["expectedDigests"]
  /** Bounded operator-facing reason; no payload or provider data is allowed. */
  readonly reason: string
  readonly revision: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
  /** Ordered, payload-free owner promotion checkpoint, when present. */
  readonly ownerProgress?: SettlementOutboxOwnerProgress
  /** Digest of this metadata record, excluding observation timestamps. */
  readonly receiptDigest: string
}

export interface SettlementOutboxMutation {
  readonly identity: SettlementOutboxIdentity
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly observedAtMs: number
}

export interface SettlementOutboxRead {
  readonly identity: SettlementOutboxIdentity
  readonly intentID: string
}

export interface SettlementOutboxPromotionMutation extends SettlementOutboxMutation {
  readonly owner: ChildSettlement.SettlementWrite
  readonly ownerDigest: string
}

/**
 * Bounded owner-scoped discovery for a recovery worker.  The query returns
 * only receipt metadata and never crosses the tenant/user boundary.
 */
export interface SettlementOutboxList {
  readonly identity: SettlementOutboxIdentity
  readonly status?: SettlementOutboxStatus
  readonly limit?: number
}

export interface SettlementOutboxResult {
  readonly record: SettlementOutboxRecord
  /** True only when a new row was inserted. */
  readonly inserted: boolean
  /** True when the durable row changed during this call. */
  readonly changed: boolean
}

export class SettlementOutboxError extends Error {
  readonly _tag: string = "Runtime.SettlementOutboxError"

  constructor(readonly reason: string) {
    super(reason)
    this.name = this._tag
  }
}

export class SettlementOutboxConflictError extends SettlementOutboxError {
  override readonly _tag = "Runtime.SettlementOutboxConflictError"
  constructor(
    readonly intentID: string,
    reason: string,
  ) {
    super(reason)
    this.name = this._tag
  }
}

export class SettlementOutboxCorruptError extends SettlementOutboxError {
  override readonly _tag = "Runtime.SettlementOutboxCorruptError"
  constructor(
    readonly intentID: string,
    reason: string,
  ) {
    super(reason)
    this.name = this._tag
  }
}

export class SettlementOutboxStorageError extends SettlementOutboxError {
  override readonly _tag = "Runtime.SettlementOutboxStorageError"
  constructor(reason: string) {
    super(reason)
    this.name = this._tag
  }
}

export interface Interface {
  /** Insert or explicitly reopen an exact plan in prepared state. */
  readonly prepare: (input: SettlementOutboxMutation) => Effect.Effect<SettlementOutboxResult, Error>
  /** Persist one exact owner completion in the declared order. */
  readonly promoteOwner: (input: SettlementOutboxPromotionMutation) => Effect.Effect<SettlementOutboxResult, Error>
  /** Advance prepared -> committed only after every owner promotion is durable. */
  readonly commitPromoted: (input: SettlementOutboxMutation) => Effect.Effect<SettlementOutboxResult, Error>
  /** Advance prepared -> committed. Provider execution is never authorized. */
  readonly commit: (input: SettlementOutboxMutation) => Effect.Effect<SettlementOutboxResult, Error>
  /** Record a bounded recovery failure without deleting or downgrading data. */
  readonly markRecoveryRequired: (
    input: SettlementOutboxMutation & { readonly reason: string },
  ) => Effect.Effect<SettlementOutboxResult, Error>
  /** Read only the caller's owner-scoped receipt. */
  readonly read: (input: SettlementOutboxRead) => Effect.Effect<SettlementOutboxRecord | undefined, Error>
  /** Enumerate a bounded, deterministic owner-scoped receipt page. */
  readonly list: (input: SettlementOutboxList) => Effect.Effect<ReadonlyArray<SettlementOutboxRecord>, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SettlementOutbox") {}

const normalizeIdentity = (identity: SettlementOutboxIdentity): SettlementOutboxIdentity => {
  if (
    identity === null ||
    typeof identity !== "object" ||
    !OWNER_ID.test(identity.tenantID) ||
    !OWNER_ID.test(identity.userID)
  )
    throw new SettlementOutboxError("Settlement outbox owner identity is invalid.")
  return Object.freeze({ tenantID: identity.tenantID, userID: identity.userID })
}

const normalizeObservedAt = (observedAtMs: number) => {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
    throw new SettlementOutboxError("Settlement outbox observation time is invalid.")
  return observedAtMs
}

const normalizeListLimit = (limit: number | undefined) => {
  const normalized = limit ?? 100
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 1_000)
    throw new SettlementOutboxError("Settlement outbox list limit must be an integer between 1 and 1000.")
  return normalized
}

const normalizeListStatus = (status: SettlementOutboxStatus | undefined): SettlementOutboxStatus | undefined => {
  if (status === undefined) return undefined
  if (status !== "prepared" && status !== "committed" && status !== "recovery-required")
    throw new SettlementOutboxError("Settlement outbox list status is invalid.")
  return status
}

const normalizeReason = (reason: string) => {
  if (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH || reason.includes("\u0000"))
    throw new SettlementOutboxError("Settlement outbox recovery reason is invalid or too large.")
  return reason
}

const normalizePlan = (plan: ChildSettlement.SettlementCommitPlan) => {
  try {
    ChildSettlement.assertSettlementCommitPlan(plan)
  } catch (cause) {
    throw new SettlementOutboxError(`Settlement outbox commit plan is invalid: ${String(cause)}`)
  }
  if (plan.mode !== "recovery-outbox" || plan.outboxRequired !== true || plan.providerExecutionAllowed !== false)
    throw new SettlementOutboxError("Settlement outbox accepts only provider-free recovery plans.")
  return plan
}

const hasExactObjectKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean => {
  const actual = Reflect.ownKeys(value)
    .filter((key): key is string => typeof key === "string")
    .sort()
  return JSON.stringify(actual) === JSON.stringify([...expected].sort())
}

const ownerDigestFor = (plan: ChildSettlement.SettlementCommitPlan, owner: ChildSettlement.SettlementWrite): string => {
  const digest =
    owner === "admission-evidence"
      ? plan.expectedDigests.evidence
      : owner === "child-result"
        ? plan.expectedDigests.childResult
        : plan.expectedDigests.parentBudget
  if (digest === undefined)
    throw new SettlementOutboxConflictError(plan.intentID, "Settlement owner digest is unavailable.")
  return digest
}

const ownerProgressSemantic = (progress: Omit<SettlementOutboxOwnerProgress, "progressDigest">) => ({
  domain: "arforge/child-settlement-recovery-owner-progress/v1",
  schemaVersion: progress.schemaVersion,
  intentID: progress.intentID,
  commitDigest: progress.commitDigest,
  ownerOrder: [...progress.ownerOrder],
  completed: [...progress.completed],
  ownerDigests: progress.ownerDigests,
})

const ownerProgressDigest = (progress: Omit<SettlementOutboxOwnerProgress, "progressDigest">) =>
  canonicalHash(ownerProgressSemantic(progress))

const makeOwnerProgress = (input: {
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly completed: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly ownerDigests: Readonly<Record<string, string>>
}): SettlementOutboxOwnerProgress => {
  const semantic: Omit<SettlementOutboxOwnerProgress, "progressDigest"> = {
    schemaVersion: SETTLEMENT_OUTBOX_OWNER_PROGRESS_SCHEMA_VERSION,
    intentID: input.plan.intentID,
    commitDigest: input.plan.commitDigest,
    ownerOrder: [...input.plan.ownerOrder] as ChildSettlement.SettlementWrite[],
    completed: [...input.completed] as ChildSettlement.SettlementWrite[],
    ownerDigests: { ...input.ownerDigests },
  } as const
  const progressDigest = ownerProgressDigest(semantic)
  if (progressDigest === undefined)
    throw new SettlementOutboxStorageError("Settlement owner progress is not canonically hashable.")
  return Object.freeze({ ...semantic, progressDigest })
}

const assertOwnerProgressMatchesPlan = (
  progress: SettlementOutboxOwnerProgress,
  plan: ChildSettlement.SettlementCommitPlan,
): void => {
  if (
    progress.schemaVersion !== SETTLEMENT_OUTBOX_OWNER_PROGRESS_SCHEMA_VERSION ||
    progress.intentID !== plan.intentID ||
    progress.commitDigest !== plan.commitDigest ||
    JSON.stringify(progress.ownerOrder) !== JSON.stringify(plan.ownerOrder)
  )
    throw new SettlementOutboxConflictError(plan.intentID, "Settlement owner progress is bound to another commit plan.")
  if (!Array.isArray(progress.completed) || progress.completed.length > plan.ownerOrder.length)
    throw new SettlementOutboxCorruptError(plan.intentID, "Settlement owner progress completion prefix is invalid.")
  for (let index = 0; index < progress.completed.length; index++) {
    if (progress.completed[index] !== plan.ownerOrder[index])
      throw new SettlementOutboxCorruptError(plan.intentID, "Settlement owner progress order is not contiguous.")
  }
  const expectedKeys = [...progress.completed].sort()
  const actualKeys = Object.keys(progress.ownerDigests).sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
    throw new SettlementOutboxCorruptError(plan.intentID, "Settlement owner progress digest keys drifted.")
  for (const owner of progress.completed) {
    const actual = progress.ownerDigests[owner]
    const expected = ownerDigestFor(plan, owner)
    if (actual !== expected)
      throw new SettlementOutboxConflictError(plan.intentID, `Settlement owner digest diverged for ${owner}.`)
  }
  const { progressDigest: _ignored, ...semantic } = progress
  const expected = ownerProgressDigest(semantic)
  if (expected === undefined || expected !== progress.progressDigest)
    throw new SettlementOutboxCorruptError(plan.intentID, "Settlement owner progress digest drifted.")
}

const normalizePromotionMutation = (input: SettlementOutboxPromotionMutation) => {
  const normalized = validateMutation(input)
  if (!normalized.plan.ownerOrder.includes(input.owner))
    throw new SettlementOutboxConflictError(
      normalized.plan.intentID,
      "Settlement owner is not part of the commit plan.",
    )
  if (typeof input.ownerDigest !== "string" || !DIGEST.test(input.ownerDigest))
    throw new SettlementOutboxError("Settlement owner digest is invalid.")
  const expected = ownerDigestFor(normalized.plan, input.owner)
  if (input.ownerDigest !== expected)
    throw new SettlementOutboxConflictError(
      normalized.plan.intentID,
      `Settlement owner digest diverged for ${input.owner}.`,
    )
  return { ...normalized, owner: input.owner, ownerDigest: input.ownerDigest }
}

const validateMutation = (input: SettlementOutboxMutation) => {
  if (input === null || typeof input !== "object")
    throw new SettlementOutboxError("Settlement outbox input is required.")
  const identity = normalizeIdentity(input.identity)
  const plan = normalizePlan(input.plan)
  const observedAtMs = normalizeObservedAt(input.observedAtMs)
  return { identity, plan, observedAtMs }
}

const recordSemantic = (
  record: Pick<
    SettlementOutboxRecord,
    | "schemaVersion"
    | "tenantID"
    | "userID"
    | "intentID"
    | "parentRunID"
    | "childRunID"
    | "commitDigest"
    | "mode"
    | "status"
    | "ownerOrder"
    | "expectedDigests"
    | "reason"
    | "revision"
    | "ownerProgress"
  >,
) => ({
  domain: "arforge/child-settlement-recovery-receipt/v1",
  schemaVersion: record.schemaVersion,
  tenantID: record.tenantID,
  userID: record.userID,
  intentID: record.intentID,
  parentRunID: record.parentRunID,
  childRunID: record.childRunID,
  commitDigest: record.commitDigest,
  mode: record.mode,
  status: record.status,
  ownerOrder: [...record.ownerOrder],
  expectedDigests: record.expectedDigests,
  reason: record.reason,
  revision: record.revision,
  ...(record.ownerProgress === undefined ? {} : { ownerProgress: record.ownerProgress }),
})

const receiptDigest = (record: Parameters<typeof recordSemantic>[0]) => canonicalHash(recordSemantic(record))

const digestForState = (input: {
  readonly identity: SettlementOutboxIdentity
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly status: SettlementOutboxStatus
  readonly reason: string
  readonly revision: number
  readonly ownerProgress?: SettlementOutboxOwnerProgress
}) =>
  receiptDigest({
    schemaVersion: SETTLEMENT_OUTBOX_SCHEMA_VERSION,
    tenantID: input.identity.tenantID,
    userID: input.identity.userID,
    intentID: input.plan.intentID,
    parentRunID: input.plan.parentRunID,
    childRunID: input.plan.childRunID,
    commitDigest: input.plan.commitDigest,
    mode: "recovery-outbox",
    status: input.status,
    ownerOrder: input.plan.ownerOrder,
    expectedDigests: input.plan.expectedDigests,
    reason: input.reason,
    revision: input.revision,
    ...(input.ownerProgress === undefined ? {} : { ownerProgress: input.ownerProgress }),
  })

const expectedOwnerOrder = (expectedDigests: SettlementOutboxRecord["expectedDigests"]) =>
  expectedDigests.evidence === undefined
    ? (["child-result", "parent-budget"] as const)
    : (["admission-evidence", "child-result", "parent-budget"] as const)

const parseJSON = (value: unknown, field: string, intentID: string): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    throw new SettlementOutboxCorruptError(intentID, `Settlement outbox ${field} JSON is malformed.`)
  }
}

const parseOwnerProgress = (
  value: unknown,
  input: {
    readonly intentID: string
    readonly commitDigest: string
    readonly ownerOrder: ReadonlyArray<string>
    readonly expectedDigests: SettlementOutboxRecord["expectedDigests"]
  },
): SettlementOutboxOwnerProgress | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value))
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress must be a plain object.")
  const record = value as Record<string, unknown>
  if (
    !hasExactObjectKeys(record, [
      "schemaVersion",
      "intentID",
      "commitDigest",
      "ownerOrder",
      "completed",
      "ownerDigests",
      "progressDigest",
    ])
  )
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress fields drifted.")
  if (record.schemaVersion !== SETTLEMENT_OUTBOX_OWNER_PROGRESS_SCHEMA_VERSION)
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress schema is invalid.")
  if (record.intentID !== input.intentID || record.commitDigest !== input.commitDigest)
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress identity drifted.")
  if (
    !Array.isArray(record.ownerOrder) ||
    record.ownerOrder.some((owner) => typeof owner !== "string") ||
    JSON.stringify(record.ownerOrder) !== JSON.stringify(input.ownerOrder)
  )
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress owner order is invalid.")
  if (
    !Array.isArray(record.completed) ||
    record.completed.some((owner) => typeof owner !== "string") ||
    record.completed.length > input.ownerOrder.length
  )
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress completion prefix is invalid.")
  for (let index = 0; index < record.completed.length; index++) {
    if (record.completed[index] !== input.ownerOrder[index])
      throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress order is not contiguous.")
  }
  if (new Set(record.completed).size !== record.completed.length)
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress contains duplicate owners.")
  const ownerDigests = record.ownerDigests
  if (ownerDigests === null || typeof ownerDigests !== "object" || Array.isArray(ownerDigests))
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress digest projection is invalid.")
  const digestProjection = ownerDigests as Record<string, unknown>
  if (!hasExactObjectKeys(digestProjection, record.completed as string[]))
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress digest keys drifted.")
  for (const owner of record.completed as string[]) {
    const digest = digestProjection[owner]
    if (typeof digest !== "string" || !DIGEST.test(digest) || digest !== digest.toLowerCase())
      throw new SettlementOutboxCorruptError(
        input.intentID,
        `Settlement owner progress digest is invalid for ${owner}.`,
      )
    const expected =
      owner === "admission-evidence"
        ? input.expectedDigests.evidence
        : owner === "child-result"
          ? input.expectedDigests.childResult
          : owner === "parent-budget"
            ? input.expectedDigests.parentBudget
            : undefined
    if (expected === undefined || digest !== expected)
      throw new SettlementOutboxCorruptError(input.intentID, `Settlement owner progress digest diverged for ${owner}.`)
  }
  if (typeof record.progressDigest !== "string" || !DIGEST.test(record.progressDigest))
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress digest identity is invalid.")
  const semantic: Omit<SettlementOutboxOwnerProgress, "progressDigest"> = {
    schemaVersion: record.schemaVersion,
    intentID: record.intentID,
    commitDigest: record.commitDigest,
    ownerOrder: [...(record.ownerOrder as SettlementOutboxOwnerProgress["ownerOrder"][number][])],
    completed: [...(record.completed as SettlementOutboxOwnerProgress["completed"][number][])],
    ownerDigests: { ...digestProjection } as Record<string, string>,
  }
  const expectedProgressDigest = ownerProgressDigest(semantic)
  if (expectedProgressDigest === undefined || expectedProgressDigest !== record.progressDigest)
    throw new SettlementOutboxCorruptError(input.intentID, "Settlement owner progress digest drifted.")
  return Object.freeze({
    ...semantic,
    progressDigest: expectedProgressDigest,
  })
}

const toRecord = (row: typeof ChildSettlementRecoveryOutboxTable.$inferSelect): SettlementOutboxRecord => {
  const intentID = String(row.intent_id)
  if (!INTENT_ID.test(intentID))
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox intent identity is invalid.")
  if (!OWNER_ID.test(String(row.tenant_id)) || !OWNER_ID.test(String(row.owner_user_id)))
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox owner identity is invalid.")
  if (!RUN_ID.test(String(row.parent_run_id)) || !RUN_ID.test(String(row.child_run_id)))
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox run identity is invalid.")
  if (String(row.mode) !== "recovery-outbox")
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox mode is invalid.")
  const status = String(row.status)
  if (!(status === "prepared" || status === "committed" || status === "recovery-required"))
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox status is invalid.")
  if (!DIGEST.test(String(row.commit_digest)))
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox commit digest is invalid.")
  const ownerOrder = parseJSON(row.owner_order, "owner order", intentID)
  const expectedDigests = parseJSON(row.expected_digests, "expected digests", intentID)
  if (!Array.isArray(ownerOrder) || ownerOrder.some((item) => typeof item !== "string"))
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox owner order is invalid.")
  if (
    expectedDigests === null ||
    typeof expectedDigests !== "object" ||
    Array.isArray(expectedDigests) ||
    !DIGEST.test(String((expectedDigests as Record<string, unknown>).childResult)) ||
    !DIGEST.test(String((expectedDigests as Record<string, unknown>).parentBudget)) ||
    ((expectedDigests as Record<string, unknown>).evidence !== undefined &&
      !DIGEST.test(String((expectedDigests as Record<string, unknown>).evidence)))
  )
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox expected digest projection is invalid.")
  const digestKeys = Object.keys(expectedDigests).sort()
  const allowedDigestKeys =
    (expectedDigests as Record<string, unknown>).evidence === undefined
      ? ["childResult", "parentBudget"]
      : ["childResult", "evidence", "parentBudget"]
  if (JSON.stringify(digestKeys) !== JSON.stringify(allowedDigestKeys))
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox expected digest keys are not canonical.")
  if (
    JSON.stringify(ownerOrder) !==
    JSON.stringify(expectedOwnerOrder(expectedDigests as SettlementOutboxRecord["expectedDigests"]))
  )
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox owner order is not canonical.")
  const ownerProgress = parseOwnerProgress((row as typeof row & { owner_progress?: unknown }).owner_progress, {
    intentID,
    commitDigest: String(row.commit_digest).toLowerCase(),
    ownerOrder: ownerOrder as ReadonlyArray<string>,
    expectedDigests: expectedDigests as SettlementOutboxRecord["expectedDigests"],
  })
  const reason = String(row.reason)
  normalizeReason(reason)
  const revision = Number(row.revision)
  const createdAtMs = Number(row.time_created)
  const updatedAtMs = Number(row.time_updated)
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    !Number.isSafeInteger(updatedAtMs) ||
    updatedAtMs < createdAtMs
  )
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox revision or timestamp is invalid.")
  const record = {
    schemaVersion: SETTLEMENT_OUTBOX_SCHEMA_VERSION,
    tenantID: String(row.tenant_id),
    userID: String(row.owner_user_id),
    intentID,
    parentRunID: row.parent_run_id as SettlementOutboxRecord["parentRunID"],
    childRunID: row.child_run_id as SettlementOutboxRecord["childRunID"],
    commitDigest: String(row.commit_digest).toLowerCase(),
    mode: "recovery-outbox" as const,
    status: status as SettlementOutboxStatus,
    ownerOrder: Object.freeze([...ownerOrder]) as SettlementOutboxRecord["ownerOrder"],
    expectedDigests: Object.freeze({ ...(expectedDigests as SettlementOutboxRecord["expectedDigests"]) }),
    reason,
    revision,
    createdAtMs,
    updatedAtMs,
    ...(ownerProgress === undefined ? {} : { ownerProgress }),
  }
  const digest = receiptDigest(record)
  if (digest === undefined)
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox metadata is not canonicalizable.")
  // The digest is computed from the durable projection itself. The table does
  // not carry an executable payload, and a changed digest is therefore a
  // fail-closed corruption signal rather than a reason to replay a provider.
  const storedDigest = (row as typeof row & { receipt_digest?: unknown }).receipt_digest
  if (
    typeof storedDigest !== "string" ||
    !DIGEST.test(storedDigest) ||
    storedDigest.toLowerCase() !== digest.toLowerCase()
  )
    throw new SettlementOutboxCorruptError(intentID, "Settlement outbox receipt digest drifted.")
  return Object.freeze({ ...record, receiptDigest: digest })
}

/**
 * Validate a durable outbox projection without reading the database.
 *
 * Runtime invariant checks and operator/audit projections receive plain JSON,
 * not Drizzle rows.  Reconstructing the narrow row shape here deliberately
 * reuses the same canonical decoder and receipt-digest verification as the
 * database path; no payload, provider response, or owner state is accepted.
 */
export const assertSettlementOutboxRecord = (value: unknown): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new SettlementOutboxCorruptError("unknown", "Settlement outbox receipt must be a plain object.")
  const record = value as Record<string, unknown>
  const hasProgress = Object.prototype.hasOwnProperty.call(record, "ownerProgress")
  const expectedKeys = [
    "schemaVersion",
    "tenantID",
    "userID",
    "intentID",
    "parentRunID",
    "childRunID",
    "commitDigest",
    "mode",
    "status",
    "ownerOrder",
    "expectedDigests",
    "reason",
    "revision",
    "createdAtMs",
    "updatedAtMs",
    ...(hasProgress ? ["ownerProgress"] : []),
    "receiptDigest",
  ]
  if (!hasExactObjectKeys(record, expectedKeys))
    throw new SettlementOutboxCorruptError(
      String(record.intentID ?? "unknown"),
      "Settlement outbox receipt fields drifted.",
    )
  if (record.schemaVersion !== SETTLEMENT_OUTBOX_SCHEMA_VERSION)
    throw new SettlementOutboxCorruptError(
      String(record.intentID ?? "unknown"),
      "Settlement outbox receipt schema is invalid.",
    )
  if (hasProgress && (record.ownerProgress === null || typeof record.ownerProgress !== "object"))
    throw new SettlementOutboxCorruptError(
      String(record.intentID ?? "unknown"),
      "Settlement outbox owner progress is invalid.",
    )

  const row = {
    tenant_id: record.tenantID,
    owner_user_id: record.userID,
    intent_id: record.intentID,
    parent_run_id: record.parentRunID,
    child_run_id: record.childRunID,
    commit_digest: record.commitDigest,
    mode: record.mode,
    status: record.status,
    owner_order: JSON.stringify(record.ownerOrder),
    expected_digests: JSON.stringify(record.expectedDigests),
    reason: record.reason,
    revision: record.revision,
    time_created: record.createdAtMs,
    time_updated: record.updatedAtMs,
    receipt_digest: record.receiptDigest,
    owner_progress: hasProgress ? (record.ownerProgress ?? null) : null,
  } as unknown as typeof ChildSettlementRecoveryOutboxTable.$inferSelect
  // `toRecord` performs the complete structural, plan-order, owner-progress,
  // timestamp and receipt-digest validation.  Do not compare JSON strings
  // here: equivalent projections are allowed to differ in object insertion
  // order while retaining the same canonical receipt digest.
  toRecord(row)
}

const rowFor = (identity: SettlementOutboxIdentity, intentID: string) =>
  and(
    eq(ChildSettlementRecoveryOutboxTable.tenant_id, identity.tenantID),
    eq(ChildSettlementRecoveryOutboxTable.owner_user_id, identity.userID),
    eq(ChildSettlementRecoveryOutboxTable.intent_id, intentID),
  )

const assertPlanMatches = (record: SettlementOutboxRecord, plan: ChildSettlement.SettlementCommitPlan) => {
  if (
    record.intentID !== plan.intentID ||
    record.parentRunID !== plan.parentRunID ||
    record.childRunID !== plan.childRunID ||
    record.commitDigest !== plan.commitDigest ||
    JSON.stringify(record.ownerOrder) !== JSON.stringify(plan.ownerOrder) ||
    JSON.stringify(record.expectedDigests) !== JSON.stringify(plan.expectedDigests)
  )
    throw new SettlementOutboxConflictError(
      plan.intentID,
      "Settlement outbox is bound to a different immutable commit plan.",
    )
}

const failure = (cause: unknown) =>
  cause instanceof SettlementOutboxError
    ? cause
    : new SettlementOutboxStorageError(cause instanceof Error ? cause.message : String(cause))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    const readRow = (identity: SettlementOutboxIdentity, intentID: string) =>
      db
        .select()
        .from(ChildSettlementRecoveryOutboxTable)
        .where(rowFor(identity, intentID))
        .get()
        .pipe(Effect.mapError(failure))

    const read: Interface["read"] = Effect.fn("SettlementOutbox.read")(function* (input) {
      let normalized: SettlementOutboxIdentity
      let intentID: string
      try {
        normalized = normalizeIdentity(input.identity)
        intentID = String(input.intentID)
        if (!INTENT_ID.test(intentID)) throw new SettlementOutboxError("Settlement outbox intent identity is invalid.")
      } catch (cause) {
        return yield* Effect.fail(failure(cause))
      }
      return yield* database.runAsPrincipal(
        normalized,
        Effect.gen(function* () {
          const row = yield* readRow(normalized, intentID)
          return row === undefined ? undefined : toRecord(row)
        }),
      )
    })

    const list: Interface["list"] = Effect.fn("SettlementOutbox.list")(function* (input) {
      let normalized: SettlementOutboxIdentity
      let status: SettlementOutboxStatus | undefined
      let limit: number
      try {
        normalized = normalizeIdentity(input.identity)
        status = normalizeListStatus(input.status)
        limit = normalizeListLimit(input.limit)
      } catch (cause) {
        return yield* Effect.fail(failure(cause))
      }
      return yield* database.runAsPrincipal(
        normalized,
        db
          .select()
          .from(ChildSettlementRecoveryOutboxTable)
          .where(
            and(
              eq(ChildSettlementRecoveryOutboxTable.tenant_id, normalized.tenantID),
              eq(ChildSettlementRecoveryOutboxTable.owner_user_id, normalized.userID),
              ...(status === undefined ? [] : [eq(ChildSettlementRecoveryOutboxTable.status, status)]),
            ),
          )
          .orderBy(
            asc(ChildSettlementRecoveryOutboxTable.time_updated),
            asc(ChildSettlementRecoveryOutboxTable.intent_id),
          )
          .limit(limit)
          .all()
          .pipe(
            Effect.map((rows) => rows.map(toRecord)),
            Effect.mapError(failure),
          ),
      )
    })

    const prepare: Interface["prepare"] = Effect.fn("SettlementOutbox.prepare")(function* (input) {
      let normalized: ReturnType<typeof validateMutation>
      try {
        normalized = validateMutation(input)
      } catch (cause) {
        return yield* Effect.fail(failure(cause))
      }
      const { identity, plan, observedAtMs } = normalized
      return yield* database.transactionAsPrincipal(identity, (tx) =>
        Effect.gen(function* () {
          const existingRow = yield* tx
            .select()
            .from(ChildSettlementRecoveryOutboxTable)
            .where(rowFor(identity, plan.intentID))
            .get()
            .pipe(Effect.mapError(failure))
          if (existingRow !== undefined) {
            const existing = toRecord(existingRow)
            assertPlanMatches(existing, plan)
            if (existing.status !== "recovery-required") return { record: existing, inserted: false, changed: false }
            const updated = yield* tx
              .update(ChildSettlementRecoveryOutboxTable)
              .set({
                status: "prepared",
                reason: "",
                revision: existing.revision + 1,
                time_updated: Math.max(existing.updatedAtMs, observedAtMs),
                receipt_digest:
                  digestForState({
                    identity,
                    plan,
                    status: "prepared",
                    reason: "",
                    revision: existing.revision + 1,
                    ownerProgress: existing.ownerProgress,
                  }) ?? "",
              })
              .where(
                and(
                  rowFor(identity, plan.intentID),
                  eq(ChildSettlementRecoveryOutboxTable.status, "recovery-required"),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.mapError(failure))
            if (updated === undefined)
              throw new SettlementOutboxConflictError(
                plan.intentID,
                "Settlement outbox changed while reopening recovery.",
              )
            return { record: toRecord(updated), inserted: false, changed: true }
          }

          const inserted = yield* tx
            .insert(ChildSettlementRecoveryOutboxTable)
            .values({
              tenant_id: identity.tenantID,
              owner_user_id: identity.userID,
              intent_id: plan.intentID,
              parent_run_id: plan.parentRunID,
              child_run_id: plan.childRunID,
              commit_digest: plan.commitDigest,
              mode: "recovery-outbox",
              status: "prepared",
              owner_order: [...plan.ownerOrder],
              expected_digests: { ...plan.expectedDigests },
              reason: "",
              revision: 0,
              time_created: observedAtMs,
              time_updated: observedAtMs,
              receipt_digest: digestForState({ identity, plan, status: "prepared", reason: "", revision: 0 }) ?? "",
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.mapError(failure))
          if (inserted !== undefined) return { record: toRecord(inserted), inserted: true, changed: true }
          const racedRow = yield* tx
            .select()
            .from(ChildSettlementRecoveryOutboxTable)
            .where(rowFor(identity, plan.intentID))
            .get()
            .pipe(Effect.mapError(failure))
          if (racedRow === undefined)
            throw new SettlementOutboxStorageError("Settlement outbox insert race left no row.")
          const raced = toRecord(racedRow)
          assertPlanMatches(raced, plan)
          return { record: raced, inserted: false, changed: false }
        }),
      )
    })

    const promoteOwner: Interface["promoteOwner"] = Effect.fn("SettlementOutbox.promoteOwner")(function* (input) {
      let normalized: ReturnType<typeof normalizePromotionMutation>
      try {
        normalized = normalizePromotionMutation(input)
      } catch (cause) {
        return yield* Effect.fail(failure(cause))
      }
      const { identity, plan, owner, ownerDigest, observedAtMs } = normalized
      return yield* database.transactionAsPrincipal(identity, (tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select()
            .from(ChildSettlementRecoveryOutboxTable)
            .where(rowFor(identity, plan.intentID))
            .get()
            .pipe(Effect.mapError(failure))
          if (row === undefined)
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "Settlement outbox must be prepared before owner promotion.",
            )
          const existing = toRecord(row)
          assertPlanMatches(existing, plan)
          if (existing.ownerProgress !== undefined) assertOwnerProgressMatchesPlan(existing.ownerProgress, plan)
          if (existing.status === "committed") {
            if (existing.ownerProgress?.completed.includes(owner))
              return { record: existing, inserted: false, changed: false }
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "A committed settlement receipt lacks the requested owner promotion proof.",
            )
          }
          if (existing.status !== "prepared")
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "A recovery-required outbox must be explicitly reopened before owner promotion.",
            )
          const completed = existing.ownerProgress?.completed ?? []
          const ownerIndex = plan.ownerOrder.indexOf(owner)
          if (ownerIndex < completed.length) {
            if (
              existing.ownerProgress?.completed[ownerIndex] === owner &&
              existing.ownerProgress.ownerDigests[owner] === ownerDigest
            )
              return { record: existing, inserted: false, changed: false }
            throw new SettlementOutboxConflictError(
              plan.intentID,
              `Settlement owner promotion conflicts with the already durable ${owner} prefix.`,
            )
          }
          if (ownerIndex !== completed.length)
            throw new SettlementOutboxConflictError(
              plan.intentID,
              `Settlement owner promotion must follow the declared order; expected index ${completed.length}.`,
            )
          const nextProgress = makeOwnerProgress({
            plan,
            completed: [...completed, owner],
            ownerDigests: {
              ...(existing.ownerProgress?.ownerDigests ?? {}),
              [owner]: ownerDigest,
            },
          })
          const nextRevision = existing.revision + 1
          const updated = yield* tx
            .update(ChildSettlementRecoveryOutboxTable)
            .set({
              owner_progress: nextProgress,
              revision: nextRevision,
              time_updated: Math.max(existing.updatedAtMs, observedAtMs),
              receipt_digest:
                digestForState({
                  identity,
                  plan,
                  status: existing.status,
                  reason: existing.reason,
                  revision: nextRevision,
                  ownerProgress: nextProgress,
                }) ?? "",
            })
            .where(
              and(
                rowFor(identity, plan.intentID),
                eq(ChildSettlementRecoveryOutboxTable.status, "prepared"),
                eq(ChildSettlementRecoveryOutboxTable.revision, existing.revision),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.mapError(failure))
          if (updated === undefined) {
            const racedRow = yield* tx
              .select()
              .from(ChildSettlementRecoveryOutboxTable)
              .where(rowFor(identity, plan.intentID))
              .get()
              .pipe(Effect.mapError(failure))
            if (racedRow !== undefined) {
              const raced = toRecord(racedRow)
              assertPlanMatches(raced, plan)
              if (
                raced.ownerProgress?.completed.includes(owner) &&
                raced.ownerProgress.ownerDigests[owner] === ownerDigest
              )
                return { record: raced, inserted: false, changed: false }
            }
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "Settlement outbox changed while promoting an owner.",
            )
          }
          return { record: toRecord(updated), inserted: false, changed: true }
        }),
      )
    })

    const commitPromoted: Interface["commitPromoted"] = Effect.fn("SettlementOutbox.commitPromoted")(function* (input) {
      let normalized: ReturnType<typeof validateMutation>
      try {
        normalized = validateMutation(input)
      } catch (cause) {
        return yield* Effect.fail(failure(cause))
      }
      const { identity, plan, observedAtMs } = normalized
      return yield* database.transactionAsPrincipal(identity, (tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select()
            .from(ChildSettlementRecoveryOutboxTable)
            .where(rowFor(identity, plan.intentID))
            .get()
            .pipe(Effect.mapError(failure))
          if (row === undefined)
            throw new SettlementOutboxConflictError(plan.intentID, "Settlement outbox must be prepared before commit.")
          const existing = toRecord(row)
          assertPlanMatches(existing, plan)
          if (existing.ownerProgress !== undefined) assertOwnerProgressMatchesPlan(existing.ownerProgress, plan)
          if (existing.status === "committed") {
            if (existing.ownerProgress?.completed.length === plan.ownerOrder.length)
              return { record: existing, inserted: false, changed: false }
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "A committed settlement receipt lacks complete owner promotion proof.",
            )
          }
          if (existing.status !== "prepared")
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "A recovery-required outbox must be explicitly reopened before promoted commit.",
            )
          if (existing.ownerProgress?.completed.length !== plan.ownerOrder.length)
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "Settlement outbox cannot commit before every owner is promoted.",
            )
          const nextRevision = existing.revision + 1
          const updated = yield* tx
            .update(ChildSettlementRecoveryOutboxTable)
            .set({
              status: "committed",
              reason: "",
              revision: nextRevision,
              time_updated: Math.max(existing.updatedAtMs, observedAtMs),
              receipt_digest:
                digestForState({
                  identity,
                  plan,
                  status: "committed",
                  reason: "",
                  revision: nextRevision,
                  ownerProgress: existing.ownerProgress,
                }) ?? "",
            })
            .where(
              and(
                rowFor(identity, plan.intentID),
                eq(ChildSettlementRecoveryOutboxTable.status, "prepared"),
                eq(ChildSettlementRecoveryOutboxTable.revision, existing.revision),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.mapError(failure))
          if (updated === undefined) {
            const racedRow = yield* tx
              .select()
              .from(ChildSettlementRecoveryOutboxTable)
              .where(rowFor(identity, plan.intentID))
              .get()
              .pipe(Effect.mapError(failure))
            if (racedRow !== undefined) {
              const raced = toRecord(racedRow)
              assertPlanMatches(raced, plan)
              if (raced.status === "committed" && raced.ownerProgress?.completed.length === plan.ownerOrder.length)
                return { record: raced, inserted: false, changed: false }
            }
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "Settlement outbox changed while committing promoted owners.",
            )
          }
          return { record: toRecord(updated), inserted: false, changed: true }
        }),
      )
    })

    const commit: Interface["commit"] = Effect.fn("SettlementOutbox.commit")(function* (input) {
      let normalized: ReturnType<typeof validateMutation>
      try {
        normalized = validateMutation(input)
      } catch (cause) {
        return yield* Effect.fail(failure(cause))
      }
      const { identity, plan, observedAtMs } = normalized
      return yield* database.transactionAsPrincipal(identity, (tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select()
            .from(ChildSettlementRecoveryOutboxTable)
            .where(rowFor(identity, plan.intentID))
            .get()
            .pipe(Effect.mapError(failure))
          if (row === undefined)
            throw new SettlementOutboxConflictError(plan.intentID, "Settlement outbox must be prepared before commit.")
          const existing = toRecord(row)
          assertPlanMatches(existing, plan)
          if (existing.status === "committed") return { record: existing, inserted: false, changed: false }
          if (existing.status !== "prepared")
            throw new SettlementOutboxConflictError(
              plan.intentID,
              "A recovery-required outbox must be explicitly reopened before commit.",
            )
          const updated = yield* tx
            .update(ChildSettlementRecoveryOutboxTable)
            .set({
              status: "committed",
              reason: "",
              revision: existing.revision + 1,
              time_updated: Math.max(existing.updatedAtMs, observedAtMs),
              receipt_digest:
                digestForState({
                  identity,
                  plan,
                  status: "committed",
                  reason: "",
                  revision: existing.revision + 1,
                  ownerProgress: existing.ownerProgress,
                }) ?? "",
            })
            .where(and(rowFor(identity, plan.intentID), eq(ChildSettlementRecoveryOutboxTable.status, "prepared")))
            .returning()
            .get()
            .pipe(Effect.mapError(failure))
          if (updated === undefined)
            throw new SettlementOutboxConflictError(plan.intentID, "Settlement outbox changed while committing.")
          return { record: toRecord(updated), inserted: false, changed: true }
        }),
      )
    })

    const markRecoveryRequired: Interface["markRecoveryRequired"] = Effect.fn("SettlementOutbox.markRecoveryRequired")(
      function* (input) {
        let normalized: ReturnType<typeof validateMutation>
        let reason: string
        try {
          normalized = validateMutation(input)
          reason = normalizeReason(input.reason)
        } catch (cause) {
          return yield* Effect.fail(failure(cause))
        }
        const { identity, plan, observedAtMs } = normalized
        return yield* database.transactionAsPrincipal(identity, (tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(ChildSettlementRecoveryOutboxTable)
              .where(rowFor(identity, plan.intentID))
              .get()
              .pipe(Effect.mapError(failure))
            if (row === undefined) {
              const inserted = yield* tx
                .insert(ChildSettlementRecoveryOutboxTable)
                .values({
                  tenant_id: identity.tenantID,
                  owner_user_id: identity.userID,
                  intent_id: plan.intentID,
                  parent_run_id: plan.parentRunID,
                  child_run_id: plan.childRunID,
                  commit_digest: plan.commitDigest,
                  mode: "recovery-outbox",
                  status: "recovery-required",
                  owner_order: [...plan.ownerOrder],
                  expected_digests: { ...plan.expectedDigests },
                  reason,
                  revision: 0,
                  time_created: observedAtMs,
                  time_updated: observedAtMs,
                  receipt_digest:
                    digestForState({ identity, plan, status: "recovery-required", reason, revision: 0 }) ?? "",
                })
                .onConflictDoNothing()
                .returning()
                .get()
                .pipe(Effect.mapError(failure))
              if (inserted !== undefined) return { record: toRecord(inserted), inserted: true, changed: true }
              throw new SettlementOutboxConflictError(
                plan.intentID,
                "Settlement outbox changed while recording recovery failure.",
              )
            }
            const existing = toRecord(row)
            assertPlanMatches(existing, plan)
            if (existing.status === "committed") return { record: existing, inserted: false, changed: false }
            if (existing.status === "recovery-required") {
              if (existing.reason !== reason)
                throw new SettlementOutboxConflictError(
                  plan.intentID,
                  "Recovery-required receipt already carries another failure reason.",
                )
              return { record: existing, inserted: false, changed: false }
            }
            const updated = yield* tx
              .update(ChildSettlementRecoveryOutboxTable)
              .set({
                status: "recovery-required",
                reason,
                revision: existing.revision + 1,
                time_updated: Math.max(existing.updatedAtMs, observedAtMs),
                receipt_digest:
                  digestForState({
                    identity,
                    plan,
                    status: "recovery-required",
                    reason,
                    revision: existing.revision + 1,
                    ownerProgress: existing.ownerProgress,
                  }) ?? "",
              })
              .where(and(rowFor(identity, plan.intentID), eq(ChildSettlementRecoveryOutboxTable.status, "prepared")))
              .returning()
              .get()
              .pipe(Effect.mapError(failure))
            if (updated === undefined)
              throw new SettlementOutboxConflictError(
                plan.intentID,
                "Settlement outbox changed while recording recovery failure.",
              )
            return { record: toRecord(updated), inserted: false, changed: true }
          }),
        )
      },
    )

    return { prepare, promoteOwner, commitPromoted, commit, markRecoveryRequired, read, list }
  }),
)

// The outbox is a durable coordination service and must be shared by every
// owner in a process.  Expose a global node for services such as DurableRun
// that already live at the global scope, while retaining the location node
// compatibility entrypoint for existing consumers.
export const globalNode = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
const locationLayer = Layer.effect(
  Service,
  Service.use((outbox) => Effect.succeed(Service.of(outbox))),
)
export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [globalNode] })
