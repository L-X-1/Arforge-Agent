import { describe, expect, test } from "bun:test"
import { pendingPostgresMigrations, POSTGRES_SCHEMA_MIGRATION_LOCK } from "@arforge-ai/core/database/database"
import { PostgresSchemaMigrations } from "@arforge-ai/core/database/postgres-schema.gen"

const migration = (id: string) => {
  const found = PostgresSchemaMigrations.find((item) => item.id === id)
  if (!found) throw new Error(`PostgreSQL migration ${id} is missing from the generated registry`)
  return found
}

describe("PostgreSQL migration/recovery contract", () => {
  test("projects a deterministic pending plan for every ledger prefix", () => {
    const ids = PostgresSchemaMigrations.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort())
    expect(POSTGRES_SCHEMA_MIGRATION_LOCK).toBe("arforge.schema.migration.v1")

    for (let completedCount = 0; completedCount <= ids.length; completedCount++) {
      const completed = new Set(ids.slice(0, completedCount))
      expect(pendingPostgresMigrations(completed).map((item) => item.id)).toEqual(ids.slice(completedCount))
    }

    const alternating = new Set(ids.filter((_, index) => index % 2 === 0))
    expect(pendingPostgresMigrations(alternating).map((item) => item.id)).toEqual(
      ids.filter((_, index) => index % 2 === 1),
    )
    expect(pendingPostgresMigrations(new Set([...ids, "unknown-future-migration"]))).toEqual([])
  })

  test("keeps the maintenance lease schema crash-safe and tenant-scoped", () => {
    const sql = migration("20260826054241_artifact_maintenance_lease").statements.join("\n")
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "artifact_maintenance_lease"')
    expect(sql).toContain('"lease_id" text PRIMARY KEY')
    expect(sql).toContain('"generation" bigint NOT NULL')
    expect(sql).toContain("\"status\" IN ('active', 'released', 'expired')")
    expect(sql).toContain('"heartbeat_at" >= "acquired_at"')
    expect(sql).toContain('"expires_at" >= "acquired_at"')
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "artifact_maintenance_lease_scan_generation_idx"')
    expect(sql).toContain('ALTER TABLE "artifact_maintenance_lease" FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("arforge_current_tenant_id()")
    expect(sql).toContain('"owner_user_id" = arforge_current_user_id()')
  })

  test("keeps compaction checkpoints append-only and usage settlement recoverable", () => {
    const checkpointSQL = migration("20260826121545_session_compaction_checkpoint").statements.join("\n")
    expect(checkpointSQL).toContain('PRIMARY KEY ("session_id", "operation_id", "sequence")')
    expect(checkpointSQL).toContain('"sequence" > 0')
    expect(checkpointSQL).toContain(
      "'prepared', 'summarizing', 'summarized', 'revalidated', 'committed', 'closed', 'aborted'",
    )
    expect(checkpointSQL).toContain('ALTER TABLE "session_compaction_checkpoint" FORCE ROW LEVEL SECURITY')
    expect(checkpointSQL).toContain('GRANT SELECT, INSERT ON TABLE "session_compaction_checkpoint" TO arforge_app')

    const usageSQL = migration("20260811184807_runtime_billing").statements.join("\n")
    expect(usageSQL).toContain("settlement_reservation_id text")
    expect(usageSQL).toContain("over_budget boolean NOT NULL DEFAULT false")
    expect(usageSQL).toContain("amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0)")
    expect(usageSQL).toContain("ALTER TABLE session_run_usage FORCE ROW LEVEL SECURITY")
    expect(usageSQL).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE session_run_usage TO arforge_app")
  })

  test("guards the latest rate-window byte counter against negative recovery data", () => {
    const sql = migration("20260826144704_tenant_artifact_read_bytes").statements.join("\n")
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS byte_count bigint NOT NULL DEFAULT 0")
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS tenant_rate_window_byte_count_check")
    expect(sql).toContain("CHECK (byte_count >= 0)")
  })

  test("keeps child-settlement recovery receipts metadata-only and tenant-scoped", () => {
    const sql = migration("20260902192412_child_settlement_recovery_outbox").statements.join("\n")
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "child_settlement_recovery_outbox"')
    expect(sql).toContain('PRIMARY KEY ("tenant_id", "owner_user_id", "intent_id")')
    expect(sql).toContain('"status" IN (\'prepared\', \'committed\', \'recovery-required\')')
    expect(sql).toContain('"receipt_digest" text NOT NULL')
    expect(sql).toContain('ALTER TABLE "child_settlement_recovery_outbox" FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('"owner_user_id" = arforge_current_user_id()')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE "child_settlement_recovery_outbox" TO arforge_app')
    expect(sql).not.toContain("summary")
    expect(sql).not.toContain("prompt")
  })

  test("keeps owner promotion checkpoints nullable and payload-free", () => {
    const sql = migration("20260903205327_20260904120000_child_settlement_recovery_outbox_owner_progress").statements.join("\n")
    expect(sql).toContain('ALTER TABLE "child_settlement_recovery_outbox"')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "owner_progress" text')
    expect(sql).not.toContain("summary")
    expect(sql).not.toContain("prompt")
  })
})
