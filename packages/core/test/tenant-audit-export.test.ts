import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as TenantPlatform from "@arforge-ai/core/tenant-platform"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { TenantAuditExportTable } from "@arforge-ai/core/tenant/sql"
import { testEffect } from "./lib/effect"

const secrets = SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(29), "test-tenant-audit-export")
const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, TenantPlatform.node]),
  [[SecretProvider.node, Layer.succeed(SecretProvider.Service, secrets)]],
)
const it = testEffect(runtimeLayer)

const owner: TenantPlatform.Principal = { tenantID: "ten_local", userID: "usr_local", role: "owner" }

describe("TenantPlatform audit export", () => {
  it.effect("includes each earlier export receipt in the next tenant-scoped audit", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const service = yield* TenantPlatform.Service

      yield* service.overview(owner)
      const first = yield* service.exportAudit(owner)
      const second = yield* service.exportAudit(owner)
      const third = yield* service.exportAudit(owner)

      expect(first.item_count).toBeGreaterThan(0)
      expect(second.item_count).toBe(first.item_count + 1)
      expect(third.item_count).toBe(second.item_count + 1)
      expect(new Set([first.export_digest, second.export_digest, third.export_digest]).size).toBe(3)

      const receipts = yield* database.db
        .select({
          id: TenantAuditExportTable.id,
          item_count: TenantAuditExportTable.item_count,
          export_digest: TenantAuditExportTable.export_digest,
        })
        .from(TenantAuditExportTable)
        .where(eq(TenantAuditExportTable.tenant_id, owner.tenantID))
        .all()

      expect(receipts).toHaveLength(3)
      expect(receipts).toEqual(
        expect.arrayContaining(
          [first, second, third].map((receipt) => ({
            id: receipt.id,
            item_count: receipt.item_count,
            export_digest: receipt.export_digest,
          })),
        ),
      )
    }),
  )
})
