import { createHash, randomUUID } from "node:crypto"
import { and, asc, desc, eq, lte } from "drizzle-orm"
import { Context, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../identity/sql"
import { canonicalHash } from "../util/canonical-hash"
import { Flock } from "../util/flock"
import {
  ArtifactMaintenanceLeaseTable,
  ArtifactMaintenanceScanPageTable,
  ArtifactMaintenanceScanTable,
} from "./maintenance-scan.sql"

export const MAX_SCAN_LIMIT = 100_000
/** The hard per-session action budget; page size remains configurable below this ceiling. */
export const MAX_SCAN_ACTIONS = MAX_SCAN_LIMIT
export const DEFAULT_SCAN_TTL_MS = 15 * 60 * 1_000
export const MAX_SCAN_TTL_MS = 24 * 60 * 60 * 1_000
/** A cooperative worker lease must become recoverable after a crashed owner. */
export const DEFAULT_LEASE_STALE_MS = 30_000
/** HTTP/background maintenance should fail closed instead of waiting forever. */
export const DEFAULT_LEASE_TIMEOUT_MS = 5_000

const ID_PATTERN = /^ams_[a-f0-9-]{10,80}$/
const LEASE_ID_PATTERN = /^aml_[a-f0-9-]{10,80}$/
const CURSOR_PATTERN = /^evt_[^\u0000\u0001-\u001f\u007f]{1,160}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

export const isCursor = (value: string): boolean => CURSOR_PATTERN.test(value)

export const ScanID = Schema.String.check(Schema.isStartsWith("ams_")).pipe(Schema.brand("ArtifactMaintenance.ScanID"))
export type ScanID = typeof ScanID.Type
export const isScanID = (value: string): value is ScanID => ID_PATTERN.test(value)

export const isLeaseID = (value: string): boolean => LEASE_ID_PATTERN.test(value)

export const Status = Schema.Literals(["active", "complete", "expired"])
export type Status = typeof Status.Type

export const LeaseStatus = Schema.Literals(["active", "released", "expired"])
export type LeaseStatus = typeof LeaseStatus.Type

export type AuditCounters = Readonly<{
  readonly scannedEntries: number
  readonly artifactCount: number
  readonly totalBytes: number
  readonly referencedCount: number
  readonly orphanCount: number
  readonly expiredOrphanCount: number
  readonly missingReferenceCount: number
  readonly invalidCount: number
  readonly unsafeCount: number
  readonly corruptCount: number
  readonly overQuota: boolean
}>

export type Scan = Readonly<{
  readonly scanID: ScanID
  readonly scope: "profile"
  readonly status: Status
  readonly scanLimit: number
  readonly startCursor?: string
  readonly cursor?: string
  readonly pageCount: number
  readonly scannedActions: number
  readonly referencedCount: number
  readonly sessionDigest: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly completedAt?: number
  readonly revision: number
}>

export type Page = Readonly<{
  readonly pageNumber: number
  readonly cursorBefore?: string
  readonly cursorAfter?: string
  readonly scannedActions: number
  readonly referencedCount: number
  readonly audit: AuditCounters
  readonly pageDigest: string
  readonly recordedAt: number
}>

/**
 * Public, token-free projection of a durable maintenance lease. The opaque
 * lease ID is only an audit handle; it is never accepted as an authorization
 * capability and is not returned by the HTTP maintenance API.
 */
export type Lease = Readonly<{
  readonly leaseID: string
  readonly scanID: ScanID
  readonly generation: number
  readonly status: LeaseStatus
  readonly acquiredAt: number
  readonly heartbeatAt: number
  readonly expiresAt: number
  readonly releasedAt?: number
}>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ArtifactMaintenanceScan.NotFoundError", {
  scanID: Schema.String,
}) {}

export class ExpiredError extends Schema.TaggedErrorClass<ExpiredError>()("ArtifactMaintenanceScan.ExpiredError", {
  scanID: Schema.String,
  expiresAt: Schema.Number,
}) {}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()(
  "ArtifactMaintenanceScan.StaleRevisionError",
  {
    scanID: Schema.String,
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
  },
) {}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "ArtifactMaintenanceScan.InvalidInputError",
  { reason: Schema.String },
) {}

export class CorruptError extends Schema.TaggedErrorClass<CorruptError>()("ArtifactMaintenanceScan.CorruptError", {
  scanID: Schema.String,
  reason: Schema.String,
}) {}

export class LeaseUnavailableError extends Schema.TaggedErrorClass<LeaseUnavailableError>()(
  "ArtifactMaintenanceScan.LeaseUnavailableError",
  {
    scanID: Schema.String,
    reason: Schema.String,
  },
) {}

export type DomainError =
  | NotFoundError
  | ExpiredError
  | StaleRevisionError
  | InvalidInputError
  | CorruptError
  | LeaseUnavailableError

export type LeaseOptions = Readonly<{
  readonly staleMs?: number
  readonly timeoutMs?: number
}>

export type MaintenanceTick = Readonly<{
  readonly observedAt: number
  readonly expiredScans: number
  readonly activeScans: number
  readonly completeScans: number
  readonly expiredTotal: number
}>

export interface Interface {
  readonly create: (input?: {
    readonly scanLimit?: number
    readonly ttlMs?: number
    readonly nowMs?: number
    /** Legacy event cursor can seed a new durable scan; later pages are session-owned. */
    readonly startCursor?: string
  }) => Effect.Effect<Scan, InvalidInputError>
  readonly get: (
    scanID: ScanID,
    input?: { readonly nowMs?: number },
  ) => Effect.Effect<Scan, NotFoundError | CorruptError>
  /** Read the most recently updated scan for the current profile owner. */
  readonly latest: (input?: {
    readonly nowMs?: number
  }) => Effect.Effect<Scan | undefined, InvalidInputError | CorruptError>
  readonly recordPage: (input: {
    readonly scanID: ScanID
    readonly expectedRevision: number
    readonly cursorBefore?: string
    readonly cursorAfter?: string
    readonly scannedActions: number
    readonly referencedCount: number
    readonly audit: AuditCounters
    readonly recordedAt?: number
  }) => Effect.Effect<Scan, DomainError>
  readonly expireStale: (input?: { readonly nowMs?: number }) => Effect.Effect<number>
  /** Explicit profile-lifecycle hook; never starts a background worker. */
  readonly tick: (input?: { readonly nowMs?: number }) => Effect.Effect<MaintenanceTick, DomainError>
  readonly pages: (scanID: ScanID) => Effect.Effect<ReadonlyArray<Page>, NotFoundError | CorruptError>
  /** Reads the append-only lease audit for one owner-scoped maintenance scan. */
  readonly leaseHistory: (scanID: ScanID) => Effect.Effect<ReadonlyArray<Lease>, NotFoundError | CorruptError>
  /**
   * Serializes a maintenance worker across cooperating Arforge processes.
   * The lease is deliberately held only around the supplied operation; page
   * writes still use the durable revision CAS as the final correctness fence.
   */
  readonly withLease: <A, E, R>(
    scanID: ScanID,
    operation: Effect.Effect<A, E, R>,
    options?: LeaseOptions,
  ) => Effect.Effect<A, E | DomainError, R>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ArtifactMaintenanceScan") {}

type ScanRow = typeof ArtifactMaintenanceScanTable.$inferSelect
type PageRow = typeof ArtifactMaintenanceScanPageTable.$inferSelect
type LeaseRow = typeof ArtifactMaintenanceLeaseTable.$inferSelect

const numberField = (name: string, value: unknown, minimum = 0) => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new InvalidInputError({ reason: `${name} must be a safe integer greater than or equal to ${minimum}.` })
  return value as number
}

const optionalCursor = (name: string, value: string | null | undefined) => {
  if (value === undefined || value === null) return undefined
  if (!isCursor(value)) throw new InvalidInputError({ reason: `${name} is not a valid durable cursor.` })
  return value
}

const auditKeys = [
  "scannedEntries",
  "artifactCount",
  "totalBytes",
  "referencedCount",
  "orphanCount",
  "expiredOrphanCount",
  "missingReferenceCount",
  "invalidCount",
  "unsafeCount",
  "corruptCount",
  "overQuota",
] as const

const validateAudit = (audit: AuditCounters): AuditCounters => {
  if (audit === null || typeof audit !== "object" || Array.isArray(audit))
    throw new InvalidInputError({ reason: "audit must be an object." })
  for (const key of auditKeys) {
    if (!(key in audit)) throw new InvalidInputError({ reason: `audit.${key} is required.` })
  }
  for (const key of auditKeys.slice(0, -1)) numberField(`audit.${key}`, audit[key])
  if (typeof audit.overQuota !== "boolean") throw new InvalidInputError({ reason: "audit.overQuota must be boolean." })
  return Object.freeze({ ...audit })
}

const toCorruptError = (scanID: string, error: unknown) =>
  error instanceof CorruptError
    ? error
    : new CorruptError({
        scanID,
        reason:
          error instanceof InvalidInputError ? error.reason : "The maintenance record contains invalid persisted data.",
      })

const digest = (value: unknown, scanID: string): string => {
  const result = canonicalHash(value)
  if (result === undefined) throw new CorruptError({ scanID, reason: "The maintenance scan digest input is invalid." })
  return result
}

const owner = Effect.fn("ArtifactMaintenanceScan.owner")(function* () {
  const principal = yield* Database.CurrentPrincipal
  return {
    tenantID: principal?.tenantID ?? LOCAL_TENANT_ID,
    userID: principal?.userID ?? LOCAL_USER_ID,
  }
})

const toScan = (row: ScanRow): Effect.Effect<Scan, CorruptError> =>
  Effect.try({
    try: () => {
      if (!isScanID(row.id))
        throw new CorruptError({ scanID: String(row.id), reason: "The maintenance scan ID is invalid." })
      if (row.scope !== "profile")
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan scope is invalid." })
      if (!Status.literals.includes(row.status as Status))
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan status is invalid." })
      numberField("scan_limit", row.scan_limit, 1)
      if (row.scan_limit > MAX_SCAN_LIMIT)
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan limit is unsafe." })
      const startCursor = optionalCursor("start_cursor", row.start_cursor)
      const rowCursor = optionalCursor("cursor", row.cursor)
      numberField("page_count", row.page_count)
      numberField("scanned_actions", row.scanned_actions)
      numberField("referenced_count", row.referenced_count)
      numberField("revision", row.revision)
      if (row.scanned_actions > MAX_SCAN_ACTIONS)
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan action budget is unsafe." })
      if (!Number.isSafeInteger(row.expires_at) || row.expires_at <= 0)
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan expiry is invalid." })
      if (!Number.isSafeInteger(row.time_created) || row.time_created <= 0 || !Number.isSafeInteger(row.time_updated))
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan timestamps are invalid." })
      if (row.time_updated < row.time_created)
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan timestamps are out of order." })
      if (row.expires_at <= row.time_created)
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan expiry precedes its creation." })
      if (!DIGEST_PATTERN.test(row.session_digest))
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan digest is invalid." })
      if (row.page_count === 0 && row.cursor !== null)
        throw new CorruptError({ scanID: row.id, reason: "An empty maintenance scan cannot have a current cursor." })
      if (row.page_count > 0 && row.status === "active" && row.cursor === null)
        throw new CorruptError({ scanID: row.id, reason: "An active maintenance scan must expose its current cursor." })
      if (row.status === "complete" && (row.cursor !== null || row.completed_at === null))
        throw new CorruptError({
          scanID: row.id,
          reason: "A completed maintenance scan has an invalid terminal projection.",
        })
      if (row.completed_at !== null && (!Number.isSafeInteger(row.completed_at) || row.completed_at <= 0))
        throw new CorruptError({ scanID: row.id, reason: "The maintenance scan completion timestamp is invalid." })
      if (row.revision < row.page_count)
        throw new CorruptError({
          scanID: row.id,
          reason: "The maintenance scan revision regressed behind its page ledger.",
        })
      const currentCursor = row.page_count === 0 ? startCursor : rowCursor
      return {
        scanID: ScanID.make(row.id),
        scope: "profile",
        status: row.status as Status,
        scanLimit: row.scan_limit,
        ...(startCursor === undefined ? {} : { startCursor }),
        ...(currentCursor === undefined ? {} : { cursor: currentCursor }),
        pageCount: row.page_count,
        scannedActions: row.scanned_actions,
        referencedCount: row.referenced_count,
        sessionDigest: row.session_digest,
        createdAt: row.time_created,
        expiresAt: row.expires_at,
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
        revision: row.revision,
      }
    },
    catch: (error) => toCorruptError(String(row.id), error),
  })

const toPage = (row: PageRow, scanID: string): Effect.Effect<Page, CorruptError> =>
  Effect.try({
    try: () => {
      numberField("page_number", row.page_number, 1)
      numberField("scanned_actions", row.scanned_actions)
      numberField("referenced_count", row.referenced_count)
      if (row.scanned_actions > MAX_SCAN_ACTIONS)
        throw new CorruptError({ scanID, reason: "The maintenance page action budget is unsafe." })
      if (!Number.isSafeInteger(row.recorded_at) || row.recorded_at <= 0)
        throw new CorruptError({ scanID, reason: "The maintenance page timestamp is invalid." })
      const cursorBefore = optionalCursor("cursor_before", row.cursor_before)
      const cursorAfter = optionalCursor("cursor_after", row.cursor_after)
      if (cursorBefore !== undefined && cursorBefore === cursorAfter)
        throw new CorruptError({ scanID, reason: "The maintenance page cursor did not advance." })
      if (!DIGEST_PATTERN.test(row.page_digest))
        throw new CorruptError({ scanID, reason: "The maintenance page digest is invalid." })
      const audit = validateAudit(row.audit as AuditCounters)
      if (audit.referencedCount > row.referenced_count || audit.missingReferenceCount > row.referenced_count)
        throw new CorruptError({ scanID, reason: "The maintenance page audit reference counts are inconsistent." })
      return {
        pageNumber: row.page_number,
        ...(cursorBefore === undefined ? {} : { cursorBefore }),
        ...(cursorAfter === undefined ? {} : { cursorAfter }),
        scannedActions: row.scanned_actions,
        referencedCount: row.referenced_count,
        audit,
        pageDigest: row.page_digest,
        recordedAt: row.recorded_at,
      }
    },
    catch: (error) => toCorruptError(scanID, error),
  })

const toLease = (row: LeaseRow, expectedScanID?: string): Effect.Effect<Lease, CorruptError> =>
  Effect.try({
    try: () => {
      const scanID = String(row.scan_id)
      if (!isScanID(scanID)) throw new CorruptError({ scanID, reason: "The maintenance lease scan ID is invalid." })
      if (expectedScanID !== undefined && scanID !== expectedScanID)
        throw new CorruptError({ scanID: expectedScanID, reason: "The maintenance lease points at another scan." })
      if (!isLeaseID(String(row.lease_id)))
        throw new CorruptError({ scanID, reason: "The maintenance lease ID is invalid." })
      if (!LeaseStatus.literals.includes(row.status as LeaseStatus))
        throw new CorruptError({ scanID, reason: "The maintenance lease status is invalid." })
      numberField("generation", row.generation)
      if (!Number.isSafeInteger(row.acquired_at) || row.acquired_at <= 0)
        throw new CorruptError({ scanID, reason: "The maintenance lease acquisition timestamp is invalid." })
      if (!Number.isSafeInteger(row.heartbeat_at) || row.heartbeat_at < row.acquired_at)
        throw new CorruptError({ scanID, reason: "The maintenance lease heartbeat timestamp is invalid." })
      if (!Number.isSafeInteger(row.expires_at) || row.expires_at < row.acquired_at)
        throw new CorruptError({ scanID, reason: "The maintenance lease expiry timestamp is invalid." })
      if (row.released_at !== null && (!Number.isSafeInteger(row.released_at) || row.released_at <= 0))
        throw new CorruptError({ scanID, reason: "The maintenance lease release timestamp is invalid." })
      if (row.status === "released" && row.released_at === null)
        throw new CorruptError({ scanID, reason: "A released maintenance lease must expose its release timestamp." })
      if (row.status !== "released" && row.released_at !== null)
        throw new CorruptError({ scanID, reason: "Only a released maintenance lease may expose a release timestamp." })
      return {
        leaseID: String(row.lease_id),
        scanID: ScanID.make(scanID),
        generation: row.generation,
        status: row.status as LeaseStatus,
        acquiredAt: row.acquired_at,
        heartbeatAt: row.heartbeat_at,
        expiresAt: row.expires_at,
        ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
      }
    },
    catch: (error) => toCorruptError(expectedScanID ?? String(row.scan_id), error),
  })

const pageMaterial = (input: {
  readonly scanID: string
  readonly pageNumber: number
  readonly cursorBefore?: string
  readonly cursorAfter?: string
  readonly scannedActions: number
  readonly referencedCount: number
  readonly audit: AuditCounters
  readonly recordedAt: number
  readonly previousDigest: string
}) => ({
  domain: "arforge.artifact-maintenance-page/v1",
  scanID: input.scanID,
  pageNumber: input.pageNumber,
  cursorBefore: input.cursorBefore ?? null,
  cursorAfter: input.cursorAfter ?? null,
  scannedActions: input.scannedActions,
  referencedCount: input.referencedCount,
  audit: input.audit,
  recordedAt: input.recordedAt,
  previousDigest: input.previousDigest,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const readPages = Effect.fn("ArtifactMaintenanceScan.readPages")(function* (scan: Scan) {
      const principal = yield* owner()
      const rows = yield* db
        .select()
        .from(ArtifactMaintenanceScanPageTable)
        .where(
          and(
            eq(ArtifactMaintenanceScanPageTable.scan_id, scan.scanID),
            eq(ArtifactMaintenanceScanPageTable.tenant_id, principal.tenantID),
            eq(ArtifactMaintenanceScanPageTable.owner_user_id, principal.userID),
          ),
        )
        .orderBy(asc(ArtifactMaintenanceScanPageTable.page_number))
        .all()
        .pipe(Effect.orDie)
      const pages = yield* Effect.forEach(rows, (row) => toPage(row, scan.scanID))
      return yield* Effect.try({
        try: () => {
          let previousDigest = digest(
            {
              domain: "arforge.artifact-maintenance-session/v1",
              scanID: scan.scanID,
              scope: scan.scope,
              scanLimit: scan.scanLimit,
              createdAt: scan.createdAt,
              expiresAt: scan.expiresAt,
              startCursor: scan.startCursor ?? null,
            },
            scan.scanID,
          )
          let scannedActions = 0
          let referencedCount = 0
          let cursor: string | undefined = scan.startCursor
          for (const [index, page] of pages.entries()) {
            if (page.pageNumber !== index + 1)
              throw new CorruptError({ scanID: scan.scanID, reason: "Maintenance page numbers are not contiguous." })
            if (page.cursorBefore !== cursor)
              throw new CorruptError({ scanID: scan.scanID, reason: "Maintenance page cursor chain is inconsistent." })
            const expected = digest(
              pageMaterial({
                scanID: scan.scanID,
                pageNumber: page.pageNumber,
                cursorBefore: page.cursorBefore,
                cursorAfter: page.cursorAfter,
                scannedActions: page.scannedActions,
                referencedCount: page.referencedCount,
                audit: page.audit,
                recordedAt: page.recordedAt,
                previousDigest,
              }),
              scan.scanID,
            )
            if (expected !== page.pageDigest)
              throw new CorruptError({
                scanID: scan.scanID,
                reason: "Maintenance page digest chain failed verification.",
              })
            previousDigest = page.pageDigest
            scannedActions += page.scannedActions
            referencedCount += page.referencedCount
            cursor = page.cursorAfter
          }
          if (
            scan.pageCount !== pages.length ||
            scan.scannedActions !== scannedActions ||
            scan.referencedCount !== referencedCount ||
            scannedActions > MAX_SCAN_ACTIONS
          )
            throw new CorruptError({
              scanID: scan.scanID,
              reason: "Maintenance scan totals do not match its page ledger.",
            })
          if (scan.sessionDigest !== previousDigest)
            throw new CorruptError({
              scanID: scan.scanID,
              reason: "Maintenance session digest does not match its page ledger.",
            })
          if (scan.cursor !== cursor)
            throw new CorruptError({
              scanID: scan.scanID,
              reason: "Maintenance session cursor does not match its page ledger.",
            })
          if (scan.status === "complete" && cursor !== undefined)
            throw new CorruptError({
              scanID: scan.scanID,
              reason: "Completed maintenance scan still exposes a cursor.",
            })
          if (scan.status === "active" && pages.length > 0 && cursor === undefined)
            throw new CorruptError({
              scanID: scan.scanID,
              reason: "Active maintenance scan has no continuation cursor.",
            })
          return pages
        },
        catch: (error) => toCorruptError(scan.scanID, error),
      })
    })

    const getRow = Effect.fn("ArtifactMaintenanceScan.getRow")(function* (scanID: ScanID) {
      const principal = yield* owner()
      const row = yield* db
        .select()
        .from(ArtifactMaintenanceScanTable)
        .where(
          and(
            eq(ArtifactMaintenanceScanTable.id, scanID),
            eq(ArtifactMaintenanceScanTable.tenant_id, principal.tenantID),
            eq(ArtifactMaintenanceScanTable.owner_user_id, principal.userID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ scanID })
      return row
    })

    const markExpired = Effect.fn("ArtifactMaintenanceScan.markExpired")(function* (row: ScanRow, nowMs: number) {
      if (row.status !== "active" || row.expires_at > nowMs) return row
      const principal = yield* owner()
      const updated = yield* db
        .update(ArtifactMaintenanceScanTable)
        .set({ status: "expired", time_updated: nowMs, revision: row.revision + 1 })
        .where(
          and(
            eq(ArtifactMaintenanceScanTable.id, row.id),
            eq(ArtifactMaintenanceScanTable.tenant_id, principal.tenantID),
            eq(ArtifactMaintenanceScanTable.owner_user_id, principal.userID),
            eq(ArtifactMaintenanceScanTable.revision, row.revision),
            eq(ArtifactMaintenanceScanTable.status, "active"),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (updated) return updated
      return yield* getRow(ScanID.make(row.id))
    })

    /**
     * Recover durable leases left active by a crashed process. This is a
     * compare-and-set update so a live heartbeat cannot be mistaken for a
     * stale owner while another worker is claiming the same scan.
     */
    const expireStaleLeases = Effect.fn("ArtifactMaintenanceScan.expireStaleLeases")(function* (nowMs: number) {
      const principal = yield* owner()
      const rows = yield* db
        .update(ArtifactMaintenanceLeaseTable)
        .set({ status: "expired" })
        .where(
          and(
            eq(ArtifactMaintenanceLeaseTable.tenant_id, principal.tenantID),
            eq(ArtifactMaintenanceLeaseTable.owner_user_id, principal.userID),
            eq(ArtifactMaintenanceLeaseTable.status, "active"),
            lte(ArtifactMaintenanceLeaseTable.expires_at, nowMs),
          ),
        )
        .returning()
        .all()
        .pipe(Effect.orDie)
      return rows.length
    })

    /**
     * Claims the database side of the lease after the local Flock admission.
     * The generation unique index is the cross-process race fence: if two
     * databases/hosts observe the same latest generation, only one insert can
     * commit and the loser receives a retryable LeaseUnavailableError.
     */
    const claimLease = (scanID: ScanID, staleMs: number, nowMs: number) =>
      Effect.gen(function* () {
        const principal = yield* owner()
        const leaseID = "aml_" + randomUUID()
        const expiresAt = nowMs + staleMs
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMs)
          return yield* new LeaseUnavailableError({
            scanID,
            reason: "The durable maintenance lease expiry is invalid.",
          })

        const row = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const latestRow = yield* tx
                .select()
                .from(ArtifactMaintenanceLeaseTable)
                .where(
                  and(
                    eq(ArtifactMaintenanceLeaseTable.scan_id, scanID),
                    eq(ArtifactMaintenanceLeaseTable.tenant_id, principal.tenantID),
                    eq(ArtifactMaintenanceLeaseTable.owner_user_id, principal.userID),
                  ),
                )
                .orderBy(desc(ArtifactMaintenanceLeaseTable.generation))
                .limit(1)
                .get()
              const latest = latestRow === undefined ? undefined : yield* toLease(latestRow, scanID)
              if (latest?.status === "active" && latest.expiresAt > nowMs)
                return yield* new LeaseUnavailableError({
                  scanID,
                  reason: "Another maintenance worker owns this scan according to the durable lease.",
                })
              if (latest?.status === "active")
                yield* tx
                  .update(ArtifactMaintenanceLeaseTable)
                  .set({ status: "expired" })
                  .where(
                    and(
                      eq(ArtifactMaintenanceLeaseTable.lease_id, latest.leaseID),
                      eq(ArtifactMaintenanceLeaseTable.generation, latest.generation),
                      eq(ArtifactMaintenanceLeaseTable.status, "active"),
                      lte(ArtifactMaintenanceLeaseTable.expires_at, nowMs),
                    ),
                  )
                  .run()
              const generation = latest === undefined ? 0 : latest.generation + 1
              if (!Number.isSafeInteger(generation))
                return yield* new LeaseUnavailableError({ scanID, reason: "The durable lease generation overflowed." })
              const inserted = yield* tx
                .insert(ArtifactMaintenanceLeaseTable)
                .values({
                  tenant_id: principal.tenantID,
                  owner_user_id: principal.userID,
                  lease_id: leaseID,
                  scan_id: scanID,
                  generation,
                  status: "active",
                  acquired_at: nowMs,
                  heartbeat_at: nowMs,
                  expires_at: expiresAt,
                  released_at: null,
                })
                .returning()
                .get()
              if (!inserted)
                return yield* new LeaseUnavailableError({
                  scanID,
                  reason: "The durable maintenance lease could not be recorded.",
                })
              return inserted
            }),
          )
          .pipe(
            Effect.catch((error) => {
              if (error instanceof LeaseUnavailableError || error instanceof CorruptError) return Effect.fail(error)
              return Effect.fail(
                new LeaseUnavailableError({
                  scanID,
                  reason: "The durable maintenance lease could not be recorded; retry the operation.",
                }),
              )
            }),
          )
        return yield* toLease(row, scanID)
      })

    const heartbeatLease = (lease: Lease, staleMs: number) => {
      const nowMs = Date.now()
      const expiresAt = nowMs + staleMs
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || !Number.isSafeInteger(expiresAt)) return Effect.void
      return db
        .update(ArtifactMaintenanceLeaseTable)
        .set({ heartbeat_at: nowMs, expires_at: expiresAt })
        .where(
          and(
            eq(ArtifactMaintenanceLeaseTable.lease_id, lease.leaseID),
            eq(ArtifactMaintenanceLeaseTable.generation, lease.generation),
            eq(ArtifactMaintenanceLeaseTable.status, "active"),
          ),
        )
        .run()
        .pipe(Effect.asVoid)
    }

    const releaseLease = (lease: Lease) =>
      Effect.gen(function* () {
        const nowMs = Date.now()
        if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return
        yield* db
          .update(ArtifactMaintenanceLeaseTable)
          .set({ status: "released", heartbeat_at: nowMs, released_at: nowMs })
          .where(
            and(
              eq(ArtifactMaintenanceLeaseTable.lease_id, lease.leaseID),
              eq(ArtifactMaintenanceLeaseTable.generation, lease.generation),
              eq(ArtifactMaintenanceLeaseTable.status, "active"),
            ),
          )
          .run()
      }).pipe(
        Effect.asVoid,
        // Cleanup is best effort. If the database is unavailable, the row is
        // intentionally left active and the next claimant will expire it by
        // its durable expiry timestamp before advancing the generation.
        Effect.catch(() => Effect.void),
      )

    const startLeaseHeartbeat = (lease: Lease, staleMs: number) =>
      Effect.gen(function* () {
        const intervalMs = Math.max(100, Math.floor(staleMs / 3))
        while (true) {
          yield* Effect.sleep(Duration.millis(intervalMs))
          yield* heartbeatLease(lease, staleMs).pipe(Effect.catch(() => Effect.void))
        }
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.forkChild,
      )

    const create: Interface["create"] = Effect.fn("ArtifactMaintenanceScan.create")(function* (input) {
      const scanLimit = input?.scanLimit ?? MAX_SCAN_LIMIT
      if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > MAX_SCAN_LIMIT)
        return yield* new InvalidInputError({ reason: `scanLimit must be an integer between 1 and ${MAX_SCAN_LIMIT}.` })
      const ttlMs = input?.ttlMs ?? DEFAULT_SCAN_TTL_MS
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_SCAN_TTL_MS)
        return yield* new InvalidInputError({ reason: `ttlMs must be between 1000 and ${MAX_SCAN_TTL_MS}.` })
      const nowMs = input?.nowMs ?? Date.now()
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
        return yield* new InvalidInputError({ reason: "nowMs is invalid." })
      const startCursor = yield* Effect.try({
        try: () => optionalCursor("startCursor", input?.startCursor),
        catch: (error) =>
          error instanceof InvalidInputError ? error : new InvalidInputError({ reason: "startCursor is invalid." }),
      })
      const principal = yield* owner()
      const id = ScanID.make(`ams_${randomUUID()}`)
      const sessionDigest = digest(
        {
          domain: "arforge.artifact-maintenance-session/v1",
          scanID: id,
          scope: "profile",
          scanLimit,
          createdAt: nowMs,
          expiresAt: nowMs + ttlMs,
          startCursor: startCursor ?? null,
        },
        id,
      )
      const row = yield* db
        .insert(ArtifactMaintenanceScanTable)
        .values({
          tenant_id: principal.tenantID,
          owner_user_id: principal.userID,
          id,
          scope: "profile",
          status: "active",
          scan_limit: scanLimit,
          start_cursor: startCursor ?? null,
          cursor: null,
          page_count: 0,
          scanned_actions: 0,
          referenced_count: 0,
          session_digest: sessionDigest,
          expires_at: nowMs + ttlMs,
          completed_at: null,
          revision: 0,
          time_created: nowMs,
          time_updated: nowMs,
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new InvalidInputError({ reason: "The maintenance scan could not be created." })
      return yield* toScan(row).pipe(Effect.orDie)
    })

    const get: Interface["get"] = Effect.fn("ArtifactMaintenanceScan.get")(function* (scanID, input) {
      const nowMs = input?.nowMs ?? Date.now()
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
        return yield* new CorruptError({ scanID, reason: "The maintenance scan read timestamp is invalid." })
      const row = yield* getRow(scanID)
      const current = yield* markExpired(row, nowMs)
      const scan = yield* toScan(current)
      yield* readPages(scan)
      return scan
    })

    const latest: Interface["latest"] = Effect.fn("ArtifactMaintenanceScan.latest")(function* (input) {
      const nowMs = input?.nowMs ?? Date.now()
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
        return yield* new InvalidInputError({ reason: "The maintenance latest-read timestamp is invalid." })

      // Keep the lifecycle projection deterministic: stale scans and leases
      // are expired before selecting the latest record, but no background
      // worker or destructive operation is started by this read.
      yield* expireStale({ nowMs })
      yield* expireStaleLeases(nowMs)
      const principal = yield* owner()
      const row = yield* db
        .select()
        .from(ArtifactMaintenanceScanTable)
        .where(
          and(
            eq(ArtifactMaintenanceScanTable.tenant_id, principal.tenantID),
            eq(ArtifactMaintenanceScanTable.owner_user_id, principal.userID),
            lte(ArtifactMaintenanceScanTable.time_updated, nowMs),
          ),
        )
        // Expiry is a lifecycle projection and can update multiple rows at the
        // same observation timestamp. Preserve creation order as the stable
        // tie-break so an older scan that was merely marked expired cannot
        // eclipse a newer scan created at the same logical time.
        .orderBy(
          desc(ArtifactMaintenanceScanTable.time_updated),
          desc(ArtifactMaintenanceScanTable.time_created),
          desc(ArtifactMaintenanceScanTable.id),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const scan = yield* toScan(row)
      yield* readPages(scan)
      return scan
    })

    const withLease: Interface["withLease"] = <A, E, R>(
      scanID: ScanID,
      operation: Effect.Effect<A, E, R>,
      options?: LeaseOptions,
    ) =>
      Effect.gen(function* () {
        const scan = yield* get(scanID)
        if (scan.status === "expired")
          return yield* new ExpiredError({ scanID: scan.scanID, expiresAt: scan.expiresAt })

        const staleMs = options?.staleMs ?? DEFAULT_LEASE_STALE_MS
        const timeoutMs = options?.timeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS
        if (!Number.isSafeInteger(staleMs) || staleMs < 1_000 || staleMs > MAX_SCAN_TTL_MS)
          return yield* new LeaseUnavailableError({ scanID, reason: "The maintenance lease stale timeout is invalid." })
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_SCAN_TTL_MS)
          return yield* new LeaseUnavailableError({ scanID, reason: "The maintenance lease wait timeout is invalid." })

        const principal = yield* owner()
        const key = `artifact-maintenance-scan:${principal.tenantID}:${principal.userID}:${scanID}`
        const lock = yield* Effect.tryPromise({
          try: (signal) => Flock.acquire(key, { signal, staleMs, timeoutMs }),
          catch: (error) =>
            new LeaseUnavailableError({
              scanID,
              reason: `Another maintenance worker owns this scan or the lease could not be acquired: ${String(error)}`,
            }),
        })
        const releaseLock = Effect.tryPromise({
          try: () => lock.release(),
          catch: (error) => new Error(`Maintenance lease release failed: ${String(error)}`),
        }).pipe(
          Effect.asVoid,
          // A compromised/stale lock is recoverable by Flock's stale-owner
          // path. Do not replace a successful maintenance result with a
          // release-only error, but never omit the cleanup attempt.
          Effect.catch(() => Effect.void),
        )
        const lease = yield* claimLease(scanID, staleMs, Date.now()).pipe(Effect.ensuring(releaseLock))
        const heartbeatFiber = yield* startLeaseHeartbeat(lease, staleMs)
        const release = Effect.gen(function* () {
          yield* Fiber.interrupt(heartbeatFiber).pipe(Effect.ignore)
          yield* releaseLease(lease)
          yield* releaseLock
        })
        return yield* operation.pipe(Effect.ensuring(release))
      }) as Effect.Effect<A, E | DomainError, R>

    const recordPage: Interface["recordPage"] = Effect.fn("ArtifactMaintenanceScan.recordPage")(function* (input) {
      const nowMs = input.recordedAt ?? Date.now()
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
        return yield* new InvalidInputError({ reason: "recordedAt is invalid." })
      const validated = yield* Effect.try({
        try: () => {
          numberField("expectedRevision", input.expectedRevision)
          numberField("scannedActions", input.scannedActions)
          numberField("referencedCount", input.referencedCount)
          const cursorBefore = optionalCursor("cursorBefore", input.cursorBefore)
          const cursorAfter = optionalCursor("cursorAfter", input.cursorAfter)
          if (cursorBefore === cursorAfter && cursorAfter !== undefined)
            throw new InvalidInputError({ reason: "A maintenance page must advance its cursor." })
          const audit = validateAudit(input.audit)
          return { cursorBefore, cursorAfter, audit }
        },
        catch: (error) =>
          error instanceof InvalidInputError
            ? error
            : new InvalidInputError({ reason: "The maintenance page input is invalid." }),
      })
      const row = yield* getRow(input.scanID)
      const current = yield* markExpired(row, nowMs)
      const scan = yield* toScan(current)
      yield* readPages(scan)
      if (scan.status === "expired") return yield* new ExpiredError({ scanID: scan.scanID, expiresAt: scan.expiresAt })
      if (scan.status === "complete")
        return yield* new InvalidInputError({
          reason: "This maintenance scan is already complete; start a new scan to audit again.",
        })
      if (scan.revision !== input.expectedRevision)
        return yield* new StaleRevisionError({
          scanID: scan.scanID,
          expectedRevision: input.expectedRevision,
          actualRevision: scan.revision,
        })
      if (validated.cursorBefore !== scan.cursor)
        return yield* new StaleRevisionError({
          scanID: scan.scanID,
          expectedRevision: scan.revision,
          actualRevision: scan.revision,
        })
      if (input.scannedActions > scan.scanLimit)
        return yield* new InvalidInputError({
          reason: `scannedActions cannot exceed the page limit of ${scan.scanLimit}.`,
        })
      if (scan.scannedActions > MAX_SCAN_ACTIONS - input.scannedActions)
        return yield* new InvalidInputError({
          reason: `A maintenance scan cannot exceed ${MAX_SCAN_ACTIONS} durable actions.`,
        })
      if (
        validated.audit.referencedCount > input.referencedCount ||
        validated.audit.missingReferenceCount > input.referencedCount
      )
        return yield* new InvalidInputError({ reason: "audit reference counts cannot exceed referencedCount." })
      const pageNumber = scan.pageCount + 1
      const pageDigest = digest(
        pageMaterial({
          scanID: scan.scanID,
          pageNumber,
          cursorBefore: validated.cursorBefore,
          cursorAfter: validated.cursorAfter,
          scannedActions: input.scannedActions,
          referencedCount: input.referencedCount,
          audit: validated.audit,
          recordedAt: nowMs,
          previousDigest: scan.sessionDigest,
        }),
        scan.scanID,
      )
      const nextStatus: Status = validated.cursorAfter === undefined ? "complete" : "active"
      const principal = yield* owner()
      const updated = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const inserted = yield* tx
              .insert(ArtifactMaintenanceScanPageTable)
              .values({
                tenant_id: principal.tenantID,
                owner_user_id: principal.userID,
                scan_id: scan.scanID,
                page_number: pageNumber,
                cursor_before: validated.cursorBefore ?? null,
                cursor_after: validated.cursorAfter ?? null,
                scanned_actions: input.scannedActions,
                referenced_count: input.referencedCount,
                audit: validated.audit,
                page_digest: pageDigest,
                recorded_at: nowMs,
              })
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!inserted) return yield* Effect.die(new Error("Maintenance page insert returned no row"))
            const result = yield* tx
              .update(ArtifactMaintenanceScanTable)
              .set({
                status: nextStatus,
                cursor: validated.cursorAfter ?? null,
                page_count: pageNumber,
                scanned_actions: scan.scannedActions + input.scannedActions,
                referenced_count: scan.referencedCount + input.referencedCount,
                session_digest: pageDigest,
                completed_at: nextStatus === "complete" ? nowMs : null,
                revision: scan.revision + 1,
                time_updated: nowMs,
              })
              .where(
                and(
                  eq(ArtifactMaintenanceScanTable.id, scan.scanID),
                  eq(ArtifactMaintenanceScanTable.tenant_id, principal.tenantID),
                  eq(ArtifactMaintenanceScanTable.owner_user_id, principal.userID),
                  eq(ArtifactMaintenanceScanTable.status, "active"),
                  eq(ArtifactMaintenanceScanTable.revision, scan.revision),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!result)
              return yield* new StaleRevisionError({
                scanID: scan.scanID,
                expectedRevision: scan.revision,
                actualRevision: scan.revision + 1,
              })
            return result
          }),
        )
        .pipe(Effect.orDie)
      return yield* toScan(updated)
    })

    const expireStale: Interface["expireStale"] = Effect.fn("ArtifactMaintenanceScan.expireStale")(function* (input) {
      const nowMs = input?.nowMs ?? Date.now()
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return 0
      const principal = yield* owner()
      const result = yield* db
        .update(ArtifactMaintenanceScanTable)
        .set({ status: "expired", time_updated: nowMs })
        .where(
          and(
            eq(ArtifactMaintenanceScanTable.tenant_id, principal.tenantID),
            eq(ArtifactMaintenanceScanTable.owner_user_id, principal.userID),
            eq(ArtifactMaintenanceScanTable.status, "active"),
            lte(ArtifactMaintenanceScanTable.expires_at, nowMs),
          ),
        )
        .returning()
        .all()
        .pipe(Effect.orDie)
      return result.length
    })

    const tick: Interface["tick"] = Effect.fn("ArtifactMaintenanceScan.tick")(function* (input) {
      const nowMs = input?.nowMs ?? Date.now()
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
        return yield* new InvalidInputError({ reason: "The maintenance tick timestamp is invalid." })
      const expiredScans = yield* expireStale({ nowMs })
      yield* expireStaleLeases(nowMs)
      const principal = yield* owner()
      const rows = yield* db
        .select()
        .from(ArtifactMaintenanceScanTable)
        .where(
          and(
            eq(ArtifactMaintenanceScanTable.tenant_id, principal.tenantID),
            eq(ArtifactMaintenanceScanTable.owner_user_id, principal.userID),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const scans = yield* Effect.forEach(rows, toScan)
      return {
        observedAt: nowMs,
        expiredScans,
        activeScans: scans.filter((scan) => scan.status === "active").length,
        completeScans: scans.filter((scan) => scan.status === "complete").length,
        expiredTotal: scans.filter((scan) => scan.status === "expired").length,
      }
    })

    const pages: Interface["pages"] = Effect.fn("ArtifactMaintenanceScan.pages")(function* (scanID) {
      const scan = yield* get(scanID)
      return yield* readPages(scan)
    })

    const leaseHistory: Interface["leaseHistory"] = Effect.fn("ArtifactMaintenanceScan.leaseHistory")(
      function* (scanID) {
        const scan = yield* get(scanID)
        const principal = yield* owner()
        const rows = yield* db
          .select()
          .from(ArtifactMaintenanceLeaseTable)
          .where(
            and(
              eq(ArtifactMaintenanceLeaseTable.scan_id, scan.scanID),
              eq(ArtifactMaintenanceLeaseTable.tenant_id, principal.tenantID),
              eq(ArtifactMaintenanceLeaseTable.owner_user_id, principal.userID),
            ),
          )
          .orderBy(asc(ArtifactMaintenanceLeaseTable.generation))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, (row) => toLease(row, scan.scanID))
      },
    )

    return { create, get, latest, recordPage, expireStale, tick, pages, leaseHistory, withLease }
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
