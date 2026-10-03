CREATE TABLE IF NOT EXISTS "artifact_maintenance_lease" (
  "tenant_id" text NOT NULL DEFAULT 'ten_local',
  "owner_user_id" text NOT NULL DEFAULT 'usr_local',
  "lease_id" text PRIMARY KEY,
  "scan_id" text NOT NULL REFERENCES "artifact_maintenance_scan"("id") ON DELETE CASCADE,
  "generation" bigint NOT NULL,
  "status" text NOT NULL,
  "acquired_at" bigint NOT NULL,
  "heartbeat_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL,
  "released_at" bigint,
  CONSTRAINT "artifact_maintenance_lease_status_check" CHECK ("status" IN ('active', 'released', 'expired')),
  CONSTRAINT "artifact_maintenance_lease_generation_check" CHECK ("generation" >= 0),
  CONSTRAINT "artifact_maintenance_lease_time_check" CHECK ("heartbeat_at" >= "acquired_at" AND "expires_at" >= "acquired_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_maintenance_lease_scan_generation_idx" ON "artifact_maintenance_lease" ("tenant_id", "owner_user_id", "scan_id", "generation");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_maintenance_lease_scan_idx" ON "artifact_maintenance_lease" ("tenant_id", "owner_user_id", "scan_id", "generation");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_maintenance_lease_expiry_idx" ON "artifact_maintenance_lease" ("status", "expires_at");
--> statement-breakpoint
ALTER TABLE "artifact_maintenance_lease" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "artifact_maintenance_lease" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "artifact_maintenance_lease_tenant_isolation" ON "artifact_maintenance_lease"
  USING ("tenant_id" = arforge_current_tenant_id() AND arforge_has_tenant_access("tenant_id"))
  WITH CHECK ("tenant_id" = arforge_current_tenant_id() AND "owner_user_id" = arforge_current_user_id() AND arforge_has_tenant_access("tenant_id"));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "artifact_maintenance_lease" TO arforge_app;
  END IF;
END
$$;
