import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import * as TenantPlatform from "@arforge-ai/core/tenant-platform"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { IdentityTenantMemberTable, IdentityTenantTable, IdentityUserTable } from "@arforge-ai/core/identity/sql"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { tmpdir } from "./fixture/tmpdir"
import {
  TenantRateWindowTable,
  TenantDataRequestTable,
  TenantKeyTable,
  TenantSecretTable,
  TenantUsageLedgerTable,
} from "@arforge-ai/core/tenant/sql"
import { testEffect } from "./lib/effect"

const secrets = SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(19), "test-tenant-platform")
const runtimeLayer = AppNodeBuilder.build(LayerNode.group([Database.node, TenantPlatform.node]), [
  [SecretProvider.node, Layer.succeed(SecretProvider.Service, secrets)],
])
const it = testEffect(runtimeLayer)

const owner: TenantPlatform.Principal = { tenantID: "ten_local", userID: "usr_local", role: "owner" }
const member: TenantPlatform.Principal = { tenantID: "ten_local", userID: "usr_member", role: "member" }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

describe("TenantPlatform", () => {
  it.effect(
    "enforces role boundaries and deterministic rate decisions",
    Effect.sync(() => {
      expect(TenantPlatform.roleAllows("member", "member")).toBe(true)
      expect(TenantPlatform.roleAllows("member", "admin")).toBe(false)
      expect(() => TenantPlatform.requireRole(member, "admin")).toThrow()
      expect(
        TenantPlatform.decideRate({
          requestCount: 3,
          limit: 3,
          burst: 1,
          windowStartedAt: 1_000,
          now: 30_000,
        }),
      ).toMatchObject({ allowed: false, remaining: 0 })
      expect(
        TenantPlatform.decideRate({
          requestCount: 3,
          limit: 3,
          burst: 1,
          windowStartedAt: 1_000,
          now: 61_000,
        }),
      ).toMatchObject({ allowed: true, remaining: 0 })
    }),
  )

  it.effect("persists tenant policy, sealed secrets, settled usage, and recoverable requests", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const service = yield* TenantPlatform.Service
      yield* service.overview(owner)
      yield* database.db
        .insert(IdentityUserTable)
        .values({
          id: member.userID,
          email: "member@arforge.invalid",
          normalized_email: "member@arforge.invalid",
          display_name: "Member",
          password_hash: "!",
          status: "active",
          email_verified_at: Date.now(),
          session_epoch: 0,
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
      expect(
        yield* database.db
          .select({ id: IdentityUserTable.id })
          .from(IdentityUserTable)
          .where(eq(IdentityUserTable.id, member.userID))
          .get(),
      ).toMatchObject({ id: member.userID })
      yield* database.db
        .insert(IdentityTenantMemberTable)
        .values({
          tenant_id: member.tenantID,
          user_id: member.userID,
          role: member.role,
          status: "active",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()

      const initial = yield* service.overview(owner)
      expect(initial.policy.tenant_id).toBe(owner.tenantID)
      const policy = yield* service.setPolicy(owner, {
        region: "cn-self-hosted",
        retention_days: 180,
        quota: { currency: "USD", limit_minor: 500 },
        rate_limit: { requests_per_minute: 3, burst: 1 },
        key_version: 1,
      })
      expect(policy.revision).toBe(2)
      expect(policy.region).toBe("cn-self-hosted")
      const invalidPolicy = yield* service
        .setPolicy(owner, {
          region: " ",
          retention_days: 180,
          quota: { currency: "USD", limit_minor: 500 },
          rate_limit: { requests_per_minute: 3, burst: 1 },
          key_version: 1,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(invalidPolicy)).toBe(true)
      const invalidRateTimestamp = yield* service.consumeRate(owner, { now: Number.NaN }).pipe(Effect.exit)
      expect(Exit.isFailure(invalidRateTimestamp)).toBe(true)

      const rotatedPolicy = yield* service.setPolicy(owner, {
        region: "cn-self-hosted",
        retention_days: 180,
        quota: { currency: "USD", limit_minor: 500 },
        rate_limit: { requests_per_minute: 3, burst: 1 },
        key_version: 2,
      })
      expect(rotatedPolicy.key_version).toBe(2)
      const keyDowngrade = yield* service
        .setPolicy(owner, {
          region: "cn-self-hosted",
          retention_days: 180,
          quota: { currency: "USD", limit_minor: 500 },
          rate_limit: { requests_per_minute: 3, burst: 1 },
          key_version: 1,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(keyDowngrade)).toBe(true)

      const stored = yield* service.putSecret(owner, {
        secretID: "provider.api-key",
        plaintext: new TextEncoder().encode("tenant-secret-value"),
      })
      expect(stored.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(stored).not.toHaveProperty("ciphertext")
      expect(new TextDecoder().decode(yield* service.readSecret(owner, { secretID: stored.secret_id }))).toBe(
        "tenant-secret-value",
      )
      expect((yield* service.listSecretMetadata(member)).map((item) => item.secret_id)).toEqual(["provider.api-key"])
      const oversizedSecret = yield* service
        .putSecret(owner, { secretID: "provider.oversized", plaintext: new Uint8Array(64 * 1024 + 1) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(oversizedSecret)).toBe(true)
      const rawSecret = yield* database.db
        .select({ ciphertext: TenantSecretTable.ciphertext, fingerprint: TenantSecretTable.fingerprint })
        .from(TenantSecretTable)
        .where(and(eq(TenantSecretTable.tenant_id, owner.tenantID), eq(TenantSecretTable.secret_id, stored.secret_id)))
        .get()
      expect(rawSecret?.ciphertext).not.toContain("tenant-secret-value")
      expect(stored.fingerprint).toBe(
        createHash("sha256")
          .update(rawSecret?.ciphertext ?? "")
          .digest("hex"),
      )
      expect(stored.fingerprint).not.toBe(createHash("sha256").update("tenant-secret-value").digest("hex"))

      const first = yield* service.recordSettledUsage(owner, {
        settlementID: "settlement-1",
        runID: "run-1",
        currency: "USD",
        amountMinor: 120,
      })
      const replay = yield* service.recordSettledUsage(owner, {
        settlementID: "settlement-1",
        runID: "run-1",
        currency: "USD",
        amountMinor: 120,
      })
      expect(replay).toEqual(first)
      expect(yield* service.overview(owner).pipe(Effect.map((value) => value.usage))).toMatchObject({
        settled_amount_minor: 120,
        settled_records: 1,
      })
      const usageRows = yield* database.db.select().from(TenantUsageLedgerTable).all()
      expect(usageRows).toHaveLength(1)
      const overQuota = yield* service
        .recordSettledUsage(owner, {
          settlementID: "settlement-over-quota",
          runID: "run-over-quota",
          currency: "USD",
          amountMinor: 400,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(overQuota)).toBe(true)

      const other: TenantPlatform.Principal = { tenantID: "ten_other", userID: "usr_other", role: "owner" }
      const otherNow = Date.now()
      yield* database.db
        .insert(IdentityUserTable)
        .values({
          id: other.userID,
          email: "other@arforge.invalid",
          normalized_email: "other@arforge.invalid",
          display_name: "Other owner",
          password_hash: "!",
          status: "active",
          email_verified_at: otherNow,
          session_epoch: 0,
          time_created: otherNow,
          time_updated: otherNow,
        })
        .run()
      yield* database.db
        .insert(IdentityTenantTable)
        .values({
          id: other.tenantID,
          name: "Other workspace",
          slug: "other",
          created_by_user_id: other.userID,
          time_created: otherNow,
          time_updated: otherNow,
        })
        .run()
      yield* database.db
        .insert(IdentityTenantMemberTable)
        .values({
          tenant_id: other.tenantID,
          user_id: other.userID,
          role: other.role,
          status: "active",
          time_created: otherNow,
          time_updated: otherNow,
        })
        .run()
      yield* service.setPolicy(other, {
        region: "other-region",
        retention_days: 30,
        quota: { currency: "USD", limit_minor: 100 },
        rate_limit: { requests_per_minute: 1, burst: 1 },
        key_version: 1,
      })
      expect(yield* service.listSecretMetadata(other)).toHaveLength(0)
      expect((yield* service.consumeRate(other, { bucket: "api", now: 10_000 })).allowed).toBe(true)
      const otherLimited = yield* service.consumeRate(other, { bucket: "api", now: 10_001 }).pipe(Effect.exit)
      expect(Exit.isFailure(otherLimited)).toBe(true)
      expect((yield* service.consumeRate(owner, { bucket: "api", now: 10_001 })).allowed).toBe(true)
      expect((yield* service.overview(other)).usage.settled_amount_minor).toBe(0)

      const emptyRequest = yield* service
        .requestData(member, { kind: "tenant-export", reason: "   " })
        .pipe(Effect.exit)
      expect(Exit.isFailure(emptyRequest)).toBe(true)
      const request = yield* service.requestData(member, { kind: "tenant-delete", reason: "user requested removal" })
      const requestReplay = yield* service.requestData(member, {
        kind: "tenant-delete",
        reason: "user requested removal",
      })
      expect(requestReplay.id).toBe(request.id)
      const oversizedReason = yield* service
        .requestData(member, { kind: "tenant-export", reason: "x".repeat(1_001) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(oversizedReason)).toBe(true)
      expect((yield* service.approveData(owner, { requestID: request.id, approve: true })).status).toBe("approved")
      const rejectedAgain = yield* service.approveData(owner, { requestID: request.id, approve: true })
      expect(rejectedAgain.status).toBe("approved")
      const rejection = yield* service.requestData(member, {
        kind: "tenant-export",
        reason: "request must be rejected with an auditable decision actor",
      })
      const rejected = yield* service.approveData(owner, { requestID: rejection.id, approve: false })
      expect(rejected.status).toBe("rejected")
      expect(rejected).not.toHaveProperty("approved_by")
      expect(
        yield* database.db
          .select({ decided_by: TenantDataRequestTable.approved_by })
          .from(TenantDataRequestTable)
          .where(eq(TenantDataRequestTable.id, rejection.id))
          .get(),
      ).toEqual({ decided_by: owner.userID })

      const backup = yield* service.createBackup(owner, {
        region: "cn-self-hosted",
        schemaRevision: "20260814080000",
        artifactDigest: "a".repeat(64),
      })
      const backupReplay = yield* service.createBackup(owner, {
        region: "cn-self-hosted",
        schemaRevision: "20260814080000",
        artifactDigest: "a".repeat(64),
      })
      expect(backupReplay.id).toBe(backup.id)
      const divergentBackup = yield* service
        .createBackup(owner, {
          region: "cn-self-hosted",
          schemaRevision: "different-schema-revision",
          artifactDigest: "a".repeat(64),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(divergentBackup)).toBe(true)
      const wrongRegionBackup = yield* service
        .createBackup(owner, {
          region: "outside-policy-region",
          schemaRevision: "20260814080000",
          artifactDigest: "b".repeat(64),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrongRegionBackup)).toBe(true)
      expect(
        (yield* service.verifyBackup(owner, { manifestID: backup.id, artifactDigest: "a".repeat(64) })).status,
      ).toBe("verified")
      const exportReceipt = yield* service.exportAudit(owner)
      expect(exportReceipt.item_count).toBeGreaterThan(0)
      expect(exportReceipt.export_digest).toMatch(/^[a-f0-9]{64}$/)
      expect(exportReceipt.artifact_filename).toBe(`arforge-tenant-audit-${exportReceipt.id}.json`)
      expect(exportReceipt.artifact_media_type).toBe("application/json")
      expect(createHash("sha256").update(exportReceipt.artifact_json).digest("hex")).toBe(exportReceipt.export_digest)
      const auditArtifact: unknown = JSON.parse(exportReceipt.artifact_json)
      if (!isRecord(auditArtifact) || !Array.isArray(auditArtifact.rows))
        throw new Error("audit artifact must be an object with rows")
      expect(auditArtifact).toMatchObject({
        schema_version: 1,
        tenant_id: owner.tenantID,
        export_id: exportReceipt.id,
      })
      expect(auditArtifact.rows).toHaveLength(exportReceipt.item_count)
      expect(exportReceipt.artifact_json).toContain(`"decided_by":"${owner.userID}"`)
      expect(exportReceipt.artifact_json).not.toContain("tenant-secret-value")
      expect(exportReceipt.artifact_json).not.toContain(rawSecret?.ciphertext ?? "tenant-secret-value")
      expect(exportReceipt.artifact_json).not.toContain("user requested removal")

      yield* database.db
        .delete(TenantKeyTable)
        .where(and(eq(TenantKeyTable.tenant_id, owner.tenantID), eq(TenantKeyTable.version, stored.key_version)))
        .run()
      const missingKeyRead = yield* service.readSecret(owner, { secretID: stored.secret_id }).pipe(Effect.exit)
      expect(Exit.isFailure(missingKeyRead)).toBe(true)
      expect(
        yield* database.db
          .select({ version: TenantKeyTable.version })
          .from(TenantKeyTable)
          .where(eq(TenantKeyTable.tenant_id, owner.tenantID))
          .all(),
      ).toHaveLength(0)

      const denied = yield* service
        .putSecret(member, {
          secretID: "provider.other",
          plaintext: new TextEncoder().encode("denied"),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
    }),
  )

  it.effect("serializes tenant policy, quota, rate-window, and approval writers under concurrency", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const service = yield* TenantPlatform.Service
      yield* service.overview(owner)
      yield* service.setPolicy(owner, {
        region: "self-hosted",
        retention_days: 365,
        quota: { currency: "USD", limit_minor: 100 },
        rate_limit: { requests_per_minute: 1, burst: 1 },
        key_version: 1,
      })
      const policyUpdates = yield* Effect.all(
        ["region-a", "region-b"].map((region) =>
          service.setPolicy(owner, {
            region,
            retention_days: 365,
            quota: { currency: "USD", limit_minor: 100 },
            rate_limit: { requests_per_minute: 1, burst: 1 },
            key_version: 1,
          }),
        ),
        { concurrency: "unbounded" },
      )
      expect(policyUpdates.map((value) => value.revision).sort((left, right) => left - right)).toEqual([3, 4])

      const usageExits = yield* Effect.all(
        [
          service.recordSettledUsage(owner, {
            settlementID: "concurrent-settlement-a",
            runID: "concurrent-run-a",
            currency: "USD",
            amountMinor: 60,
          }),
          service.recordSettledUsage(owner, {
            settlementID: "concurrent-settlement-b",
            runID: "concurrent-run-b",
            currency: "USD",
            amountMinor: 60,
          }),
        ].map((effect) => effect.pipe(Effect.exit)),
        { concurrency: "unbounded" },
      )
      expect(usageExits.filter(Exit.isSuccess)).toHaveLength(1)
      expect(usageExits.filter(Exit.isFailure)).toHaveLength(1)
      expect((yield* service.overview(owner)).usage.settled_amount_minor).toBe(60)

      const rateExits = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          service.consumeRate(owner, { bucket: "concurrent", now: 10_000 }).pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )
      expect(rateExits.filter(Exit.isSuccess)).toHaveLength(1)
      expect(rateExits.filter(Exit.isFailure)).toHaveLength(3)

      const artifactBytes = yield* service.consumeRate(owner, {
        bucket: TenantPlatform.ARTIFACT_READ_BUCKET,
        bytes: TenantPlatform.ARTIFACT_READ_BYTES_PER_MINUTE - 1,
        now: 20_000,
      })
      expect(artifactBytes.remainingBytes).toBe(1)
      const overByteWindow = yield* service
        .consumeRate(owner, {
          bucket: TenantPlatform.ARTIFACT_READ_BUCKET,
          bytes: 2,
          now: 20_001,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(overByteWindow)).toBe(true)
      const persistedWindow = yield* database.db
        .select({ byte_count: TenantRateWindowTable.byte_count })
        .from(TenantRateWindowTable)
        .where(
          and(
            eq(TenantRateWindowTable.tenant_id, owner.tenantID),
            eq(TenantRateWindowTable.bucket, TenantPlatform.ARTIFACT_READ_BUCKET),
          ),
        )
        .get()
      expect(persistedWindow?.byte_count).toBe(TenantPlatform.ARTIFACT_READ_BYTES_PER_MINUTE - 1)
      const resetBytes = yield* service.consumeRate(owner, {
        bucket: TenantPlatform.ARTIFACT_READ_BUCKET,
        bytes: 1,
        now: 80_000,
      })
      expect(resetBytes.remainingBytes).toBe(TenantPlatform.ARTIFACT_READ_BYTES_PER_MINUTE - 1)

      const duplicateRequests = yield* Effect.all(
        Array.from({ length: 2 }, () =>
          service.requestData(owner, { kind: "tenant-export", reason: "concurrent duplicate request" }),
        ),
        { concurrency: "unbounded" },
      )
      expect(duplicateRequests[0]?.id).toBe(duplicateRequests[1]?.id)

      const request = duplicateRequests[0]
      if (!request) throw new Error("expected concurrent request to be persisted")
      const approvalExits = yield* Effect.all(
        [
          service.approveData(owner, { requestID: request.id, approve: true }),
          service.approveData(owner, { requestID: request.id, approve: false }),
        ].map((effect) => effect.pipe(Effect.exit)),
        { concurrency: "unbounded" },
      )
      expect(approvalExits.filter(Exit.isSuccess)).toHaveLength(1)
      expect(approvalExits.filter(Exit.isFailure)).toHaveLength(1)
    }),
  )

  it.live("keeps artifact byte admission bounded across independent SQLite workers", () =>
    Effect.promise(async () => {
      await using workspace = await tmpdir()
      const databasePath = join(workspace.path, "tenant-rate.sqlite")
      const bytesPerWorker = TenantPlatform.ARTIFACT_READ_BYTES_PER_MINUTE / 2
      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* TenantPlatform.Service
          yield* service.overview(owner)
          yield* service.setPolicy(owner, {
            region: "self-hosted",
            retention_days: 365,
            quota: { currency: "USD", limit_minor: 100 },
            rate_limit: { requests_per_minute: 100, burst: 100 },
            key_version: 1,
          })
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([Database.node, TenantPlatform.node]), [
              [Database.node, Database.layerFromPath(databasePath)],
              [SecretProvider.node, Layer.succeed(SecretProvider.Service, secrets)],
            ]),
          ),
        ),
      )

      const workers = ["one", "two", "three", "four"].map((workerID) =>
        Bun.spawn(
          [process.execPath, "test/fixture/tenant-rate-worker.ts", databasePath, workerID, String(bytesPerWorker)],
          {
            cwd: join(import.meta.dir, ".."),
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              ARFORGE_DB: databasePath,
              ARFORGE_DB_URL: "",
              ARFORGE_DB_ADMIN_URL: "",
            },
          },
        ),
      )
      const results = await Promise.all(
        workers.map(async (worker) => {
          const [exitCode, stdout, stderr] = await Promise.all([
            worker.exited,
            new Response(worker.stdout).text(),
            new Response(worker.stderr).text(),
          ])
          return { exitCode, stdout, stderr }
        }),
      )
      const observations = results.map((result) => {
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
        return JSON.parse(result.stdout) as { readonly success: boolean; readonly allowed?: boolean; readonly error?: string }
      })
      expect(observations.filter((item) => item.success && item.allowed)).toHaveLength(2)
      expect(observations.filter((item) => !item.success && item.error?.includes("RateLimitedError"))).toHaveLength(2)

      const persisted = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          return yield* database.db
            .select({ byte_count: TenantRateWindowTable.byte_count })
            .from(TenantRateWindowTable)
            .where(
              and(
                eq(TenantRateWindowTable.tenant_id, owner.tenantID),
                eq(TenantRateWindowTable.bucket, TenantPlatform.ARTIFACT_READ_BUCKET),
              ),
            )
            .get()
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([Database.node, TenantPlatform.node]), [
              [Database.node, Database.layerFromPath(databasePath)],
              [SecretProvider.node, Layer.succeed(SecretProvider.Service, secrets)],
            ]),
          ),
        ),
      )
      expect(persisted?.byte_count).toBe(TenantPlatform.ARTIFACT_READ_BYTES_PER_MINUTE)
    }),
  )
})
