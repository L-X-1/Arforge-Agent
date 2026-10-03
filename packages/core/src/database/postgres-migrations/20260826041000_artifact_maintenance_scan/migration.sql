CREATE TABLE IF NOT EXISTS "artifact_maintenance_scan" (
  "tenant_id" text NOT NULL DEFAULT 'ten_local',
  "owner_user_id" text NOT NULL DEFAULT 'usr_local',
  "id" text PRIMARY KEY,
  "scope" text NOT NULL,
  "status" text NOT NULL,
  "scan_limit" bigint NOT NULL,
  "start_cursor" text,
  "cursor" text,
  "page_count" bigint NOT NULL DEFAULT 0,
  "scanned_actions" bigint NOT NULL DEFAULT 0,
  "referenced_count" bigint NOT NULL DEFAULT 0,
  "session_digest" text NOT NULL,
  "expires_at" bigint NOT NULL,
  "completed_at" bigint,
  "revision" bigint NOT NULL DEFAULT 0,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  CONSTRAINT "artifact_maintenance_scan_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "artifact_maintenance_scan_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "artifact_maintenance_scan_status_check" CHECK ("status" IN ('active', 'complete', 'expired')),
  CONSTRAINT "artifact_maintenance_scan_scope_check" CHECK ("scope" = 'profile'),
  CONSTRAINT "artifact_maintenance_scan_limit_check" CHECK ("scan_limit" > 0 AND "scan_limit" <= 100000),
  CONSTRAINT "artifact_maintenance_scan_counts_check" CHECK ("page_count" >= 0 AND "scanned_actions" >= 0 AND "referenced_count" >= 0 AND "revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact_maintenance_scan_page" (
  "tenant_id" text NOT NULL DEFAULT 'ten_local',
  "owner_user_id" text NOT NULL DEFAULT 'usr_local',
  "scan_id" text NOT NULL,
  "page_number" bigint NOT NULL,
  "cursor_before" text,
  "cursor_after" text,
  "scanned_actions" bigint NOT NULL,
  "referenced_count" bigint NOT NULL,
  "audit" text NOT NULL,
  "page_digest" text NOT NULL,
  "recorded_at" bigint NOT NULL,
  CONSTRAINT "artifact_maintenance_scan_page_pk" PRIMARY KEY ("scan_id", "page_number"),
  CONSTRAINT "artifact_maintenance_scan_page_scan_fk" FOREIGN KEY ("scan_id") REFERENCES "artifact_maintenance_scan"("id") ON DELETE CASCADE,
  CONSTRAINT "artifact_maintenance_scan_page_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "artifact_maintenance_scan_page_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "artifact_maintenance_scan_page_counts_check" CHECK ("page_number" > 0 AND "scanned_actions" >= 0 AND "referenced_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_maintenance_scan_page_digest_idx" ON "artifact_maintenance_scan_page" ("scan_id", "page_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_maintenance_scan_page_owner_idx" ON "artifact_maintenance_scan_page" ("tenant_id", "owner_user_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_maintenance_scan_owner_status_idx" ON "artifact_maintenance_scan" ("tenant_id", "owner_user_id", "status", "time_updated");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_maintenance_scan_expiry_idx" ON "artifact_maintenance_scan" ("status", "expires_at");
--> statement-breakpoint
ALTER TABLE "artifact_maintenance_scan" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "artifact_maintenance_scan" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "artifact_maintenance_scan_tenant_isolation" ON "artifact_maintenance_scan"
  USING ("tenant_id" = arforge_current_tenant_id() AND arforge_has_tenant_access("tenant_id"))
  WITH CHECK ("tenant_id" = arforge_current_tenant_id() AND "owner_user_id" = arforge_current_user_id() AND arforge_has_tenant_access("tenant_id"));
--> statement-breakpoint
ALTER TABLE "artifact_maintenance_scan_page" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "artifact_maintenance_scan_page" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "artifact_maintenance_scan_page_tenant_isolation" ON "artifact_maintenance_scan_page"
  USING ("tenant_id" = arforge_current_tenant_id() AND arforge_has_tenant_access("tenant_id"))
  WITH CHECK ("tenant_id" = arforge_current_tenant_id() AND "owner_user_id" = arforge_current_user_id() AND arforge_has_tenant_access("tenant_id"));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "artifact_maintenance_scan", "artifact_maintenance_scan_page" TO arforge_app;
  END IF;
END
$$;
