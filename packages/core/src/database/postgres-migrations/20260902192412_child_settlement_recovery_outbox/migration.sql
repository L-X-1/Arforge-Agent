CREATE TABLE IF NOT EXISTS "child_settlement_recovery_outbox" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "intent_id" text NOT NULL,
  "parent_run_id" text NOT NULL,
  "child_run_id" text NOT NULL,
  "commit_digest" text NOT NULL CHECK ("commit_digest" ~ '^[a-f0-9]{64}$'),
  "mode" text NOT NULL DEFAULT 'recovery-outbox',
  "status" text NOT NULL,
  "owner_order" text NOT NULL,
  "expected_digests" text NOT NULL,
  "reason" text NOT NULL DEFAULT '',
  "revision" bigint NOT NULL DEFAULT 0,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  "receipt_digest" text NOT NULL CHECK ("receipt_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "child_settlement_recovery_outbox_pk" PRIMARY KEY ("tenant_id", "owner_user_id", "intent_id"),
  CONSTRAINT "child_settlement_recovery_outbox_mode_check" CHECK ("mode" = 'recovery-outbox'),
  CONSTRAINT "child_settlement_recovery_outbox_status_check" CHECK ("status" IN ('prepared', 'committed', 'recovery-required')),
  CONSTRAINT "child_settlement_recovery_outbox_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "child_settlement_recovery_outbox_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "child_settlement_recovery_outbox_user_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "child_settlement_recovery_outbox_owner_status_idx"
  ON "child_settlement_recovery_outbox" ("tenant_id", "owner_user_id", "status", "time_updated");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "child_settlement_recovery_outbox_parent_idx"
  ON "child_settlement_recovery_outbox" ("tenant_id", "owner_user_id", "parent_run_id", "time_updated");
--> statement-breakpoint
ALTER TABLE "child_settlement_recovery_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "child_settlement_recovery_outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "child_settlement_recovery_outbox_tenant_isolation" ON "child_settlement_recovery_outbox";
--> statement-breakpoint
CREATE POLICY "child_settlement_recovery_outbox_tenant_isolation" ON "child_settlement_recovery_outbox"
  USING (
    "tenant_id" = arforge_current_tenant_id()
    AND arforge_has_tenant_access("tenant_id")
  )
  WITH CHECK (
    "tenant_id" = arforge_current_tenant_id()
    AND "owner_user_id" = arforge_current_user_id()
    AND arforge_has_tenant_access("tenant_id")
  );
--> statement-breakpoint
REVOKE ALL ON TABLE "child_settlement_recovery_outbox" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "child_settlement_recovery_outbox" TO arforge_app;
  END IF;
END
$$;
