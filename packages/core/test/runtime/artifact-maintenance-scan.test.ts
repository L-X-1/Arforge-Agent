import { describe, expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import * as ArtifactMaintenanceScan from "@arforge-ai/core/runtime/artifact-maintenance-scan"
import { ArtifactMaintenanceLeaseTable } from "@arforge-ai/core/runtime/maintenance-scan.sql"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const runtimeLayer = AppNodeBuilder.build(LayerNode.group([Database.node, ArtifactMaintenanceScan.node]))
const it = testEffect(runtimeLayer)

const audit = (referencedCount = 0, overQuota = false): ArtifactMaintenanceScan.AuditCounters => ({
  scannedEntries: 4,
  artifactCount: 3,
  totalBytes: 128,
  referencedCount,
  orphanCount: 1,
  expiredOrphanCount: 0,
  missingReferenceCount: 0,
  invalidCount: 0,
  unsafeCount: 0,
  corruptCount: 0,
  overQuota,
})

describe("ArtifactMaintenanceScan", () => {
  it.effect("persists a hash-chained continuation session across a service rebuild", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const databaseLayer = Database.layerFromPath(path.join(tmp.path, "maintenance-scan.sqlite"))
      const persistentLayer = () =>
        AppNodeBuilder.build(LayerNode.group([Database.node, ArtifactMaintenanceScan.node]), [
          [Database.node, databaseLayer],
        ])

      const created = yield* Effect.gen(function* () {
        const scans = yield* ArtifactMaintenanceScan.Service
        const created = yield* scans.create({ scanLimit: 100, ttlMs: 10_000, nowMs: 1_000 })
        expect(created.status).toBe("active")
        expect(created.pageCount).toBe(0)
        const first = yield* scans.recordPage({
          scanID: created.scanID,
          expectedRevision: created.revision,
          scannedActions: 100,
          referencedCount: 2,
          audit: audit(2),
          cursorAfter: "evt_page_1",
          recordedAt: 1_100,
        })
        expect(first.status).toBe("active")
        expect(first.pageCount).toBe(1)
        expect(first.cursor).toBe("evt_page_1")

        return yield* scans.recordPage({
          scanID: first.scanID,
          expectedRevision: first.revision,
          cursorBefore: first.cursor,
          scannedActions: 7,
          referencedCount: 1,
          audit: audit(1, true),
          recordedAt: 1_200,
        })
      }).pipe(Effect.provide(Layer.fresh(persistentLayer())))

      const replayed = yield* Effect.gen(function* () {
        const scans = yield* ArtifactMaintenanceScan.Service
        const replayed = yield* scans.get(created.scanID, { nowMs: 1_300 })
        const pages = yield* scans.pages(created.scanID)
        expect(pages).toHaveLength(2)
        expect(pages[1]).toMatchObject({ pageNumber: 2, cursorBefore: "evt_page_1" })
        return replayed
      }).pipe(Effect.provide(Layer.fresh(persistentLayer())))
      expect(replayed.status).toBe("complete")
      expect(replayed).toEqual(created)
    }),
  )

  it.effect("replays durable lease history after rebuilding the database service", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const databaseLayer = Database.layerFromPath(path.join(tmp.path, "maintenance-lease.sqlite"))
      const persistentLayer = () =>
        AppNodeBuilder.build(LayerNode.group([Database.node, ArtifactMaintenanceScan.node]), [
          [Database.node, databaseLayer],
        ])

      const created = yield* Effect.gen(function* () {
        const scans = yield* ArtifactMaintenanceScan.Service
        const created = yield* scans.create({ nowMs: Date.now(), ttlMs: 10_000 })
        yield* scans.withLease(created.scanID, Effect.succeed("persisted"), { timeoutMs: 1_000, staleMs: 1_000 })
        return created
      }).pipe(Effect.provide(Layer.fresh(persistentLayer())))

      const history = yield* Effect.gen(function* () {
        const scans = yield* ArtifactMaintenanceScan.Service
        return yield* scans.leaseHistory(created.scanID)
      }).pipe(Effect.provide(Layer.fresh(persistentLayer())))

      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ generation: 0, status: "released", scanID: created.scanID })
      expect(history[0]?.leaseID).not.toContain("token")
    }),
  )

  it.effect("isolates sessions by tenant and rejects stale continuation writes", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const database = yield* Database.Service
      const owner = { tenantID: "ten_scan_owner", userID: "usr_scan_owner" }
      const other = { tenantID: "ten_scan_other", userID: "usr_scan_other" }
      const created = yield* database.runAsPrincipal(owner, scans.create({ nowMs: 2_000 }))

      const hidden = yield* database.runAsPrincipal(other, scans.get(created.scanID).pipe(Effect.exit))
      expect(Exit.isFailure(hidden)).toBe(true)

      const first = yield* database.runAsPrincipal(
        owner,
        scans.recordPage({
          scanID: created.scanID,
          expectedRevision: created.revision,
          scannedActions: 1,
          referencedCount: 0,
          audit: audit(0),
          recordedAt: 2_100,
        }),
      )
      const stale = yield* database.runAsPrincipal(
        owner,
        scans
          .recordPage({
            scanID: created.scanID,
            expectedRevision: created.revision,
            scannedActions: 1,
            referencedCount: 0,
            audit: audit(0),
            recordedAt: 2_200,
          })
          .pipe(Effect.exit),
      )
      expect(Exit.isFailure(stale)).toBe(true)
      expect(first.revision).toBe(1)
    }),
  )

  it.effect("expires an unfinished session and keeps expired scans non-destructive", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const created = yield* scans.create({ ttlMs: 1_000, nowMs: 3_000 })
      const expired = yield* scans.get(created.scanID, { nowMs: 4_000 })
      expect(expired.status).toBe("expired")
      const rejected = yield* scans
        .recordPage({
          scanID: created.scanID,
          expectedRevision: created.revision,
          scannedActions: 1,
          referencedCount: 0,
          audit: audit(0),
          recordedAt: 4_001,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
    }),
  )

  it.effect("captures a legacy cursor only at session creation", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const created = yield* scans.create({ startCursor: "evt_seed", scanLimit: 10, nowMs: 5_000 })
      expect(created.startCursor).toBe("evt_seed")
      expect(created.cursor).toBe("evt_seed")
      const completed = yield* scans.recordPage({
        scanID: created.scanID,
        expectedRevision: created.revision,
        cursorBefore: created.cursor,
        scannedActions: 0,
        referencedCount: 0,
        audit: audit(0),
        recordedAt: 5_100,
      })
      expect(completed.status).toBe("complete")
      expect(completed.startCursor).toBe("evt_seed")
      expect(completed.cursor).toBeUndefined()
    }),
  )

  it.effect("fails closed for malformed cursors and dishonest page counts", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const malformed = yield* scans.create({ startCursor: "not-an-event-cursor" }).pipe(Effect.exit)
      expect(Exit.isFailure(malformed)).toBe(true)
      const created = yield* scans.create({ scanLimit: 2, nowMs: 6_000 })
      const oversized = yield* scans
        .recordPage({
          scanID: created.scanID,
          expectedRevision: created.revision,
          scannedActions: 3,
          referencedCount: 0,
          audit: audit(0),
          recordedAt: 6_100,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(oversized)).toBe(true)
    }),
  )

  it.effect("serializes cooperating maintenance workers and releases after failure", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const created = yield* scans.create({ nowMs: Date.now(), ttlMs: 10_000 })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const first = yield* scans
        .withLease(
          created.scanID,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return "first"
          }),
          { timeoutMs: 1_000, staleMs: 1_000 },
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)

      const blocked = yield* scans
        .withLease(created.scanID, Effect.succeed("second"), { timeoutMs: 150, staleMs: 1_000 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)

      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(first)).toBe("first")

      const failed = yield* scans
        .withLease(created.scanID, Effect.fail("operation failed"), { timeoutMs: 150, staleMs: 1_000 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(
        yield* scans.withLease(created.scanID, Effect.succeed("released"), { timeoutMs: 150, staleMs: 1_000 }),
      ).toBe("released")
    }),
  )

  it.effect("records token-free durable lease history with monotonic generations", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const created = yield* scans.create({ nowMs: Date.now(), ttlMs: 10_000 })

      expect(
        yield* scans.withLease(created.scanID, Effect.succeed("first"), { timeoutMs: 1_000, staleMs: 1_000 }),
      ).toBe("first")
      expect(
        yield* scans.withLease(created.scanID, Effect.succeed("second"), { timeoutMs: 1_000, staleMs: 1_000 }),
      ).toBe("second")

      const history = yield* scans.leaseHistory(created.scanID)
      expect(history).toHaveLength(2)
      expect(history.map((lease) => lease.generation)).toEqual([0, 1])
      expect(history.map((lease) => lease.status)).toEqual(["released", "released"])
      expect(history.every((lease) => /^aml_[a-f0-9-]{10,80}$/.test(lease.leaseID))).toBe(true)
      expect(history.every((lease) => lease.releasedAt !== undefined)).toBe(true)
    }),
  )

  it.effect("expires a crashed durable lease before advancing its generation", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const database = yield* Database.Service
      const created = yield* scans.create({ nowMs: Date.now(), ttlMs: 10_000 })
      const now = Date.now()
      yield* database.db
        .insert(ArtifactMaintenanceLeaseTable)
        .values({
          tenant_id: "ten_local",
          owner_user_id: "usr_local",
          lease_id: "aml_deadbeef-dead-beef",
          scan_id: created.scanID,
          generation: 0,
          status: "active",
          acquired_at: now - 2_000,
          heartbeat_at: now - 2_000,
          expires_at: now - 1_000,
          released_at: null,
        })
        .run()
        .pipe(Effect.orDie)

      expect(
        yield* scans.withLease(created.scanID, Effect.succeed("recovered"), { timeoutMs: 1_000, staleMs: 1_000 }),
      ).toBe("recovered")
      const history = yield* scans.leaseHistory(created.scanID)
      expect(history.map((lease) => lease.status)).toEqual(["expired", "released"])
      expect(history[1]?.generation).toBe(1)
    }),
  )

  it.effect("exposes a deterministic profile lifecycle tick for stale scans", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const now = Date.now()
      yield* scans.create({ nowMs: now - 5_000, ttlMs: 1_000 })
      yield* scans.create({ nowMs: now, ttlMs: 10_000 })

      const tick = yield* scans.tick({ nowMs: now })
      expect(tick).toMatchObject({
        observedAt: now,
        expiredScans: 1,
        activeScans: 1,
        completeScans: 0,
        expiredTotal: 1,
      })
    }),
  )

  it.effect("returns the latest profile scan as read-only lifecycle evidence", () =>
    Effect.gen(function* () {
      const scans = yield* ArtifactMaintenanceScan.Service
      const first = yield* scans.create({ nowMs: 10_000, ttlMs: 2_000 })
      const second = yield* scans.create({ nowMs: 20_000, ttlMs: 10_000 })
      yield* scans.create({ nowMs: 40_000, ttlMs: 10_000 })

      const latest = yield* scans.latest({ nowMs: 20_000 })
      expect(latest?.scanID).toBe(second.scanID)
      expect(latest?.status).toBe("active")
      expect(latest?.pageCount).toBe(0)
      expect(first.scanID).not.toBe(second.scanID)

      const expired = yield* scans.latest({ nowMs: 30_001 })
      expect(expired?.scanID).toBe(second.scanID)
      expect(expired?.status).toBe("expired")
    }),
  )
})
