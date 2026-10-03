ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS "memory_class" text;
--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS "lifecycle" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS "memory_version" bigint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS "provenance_status" text DEFAULT 'legacy_unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS "content_digest" text;
--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS "retention_mode" text DEFAULT 'indefinite' NOT NULL;
--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS "retention_expires_at" bigint;
--> statement-breakpoint
UPDATE "memory"
SET
  "lifecycle" = CASE WHEN "source" LIKE 'quarantined%' THEN 'quarantined' ELSE 'active' END,
  "memory_version" = 1,
  "provenance_status" = 'legacy_unknown',
  "retention_mode" = 'indefinite';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_candidate" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text PRIMARY KEY,
  "proposed_class" text NOT NULL,
  "content" text NOT NULL,
  "source_evidence_ids" text NOT NULL,
  "scope" text NOT NULL,
  "sensitivity" text NOT NULL,
  "confidence" double precision NOT NULL,
  "dedup_status" text NOT NULL,
  "dedup_compared_memory_ids" text NOT NULL,
  "dedup_similarity" double precision,
  "retention_mode" text NOT NULL,
  "retention_expires_at" bigint,
  "retention_reason" text NOT NULL,
  "proposer_kind" text NOT NULL,
  "principal_ref" text,
  "run_id" text,
  "policy_status" text NOT NULL,
  "policy_version" text NOT NULL,
  "policy_reason" text NOT NULL,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  "time_expires" bigint,
  CONSTRAINT "memory_candidate_tenant_owner_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "memory_candidate_user_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_revision" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text PRIMARY KEY,
  "memory_id" text NOT NULL,
  "version" bigint NOT NULL,
  "operation" text NOT NULL,
  "actor_kind" text NOT NULL,
  "principal_ref" text,
  "run_id" text,
  "reason" text NOT NULL,
  "policy_version" text NOT NULL,
  "evidence_ids" text NOT NULL,
  "prior_digest" text,
  "content_digest" text NOT NULL,
  "successor_memory_id" text,
  "candidate_id" text,
  "time_created" bigint NOT NULL,
  CONSTRAINT "memory_revision_memory_fk" FOREIGN KEY ("memory_id") REFERENCES "memory"("id") ON DELETE CASCADE,
  CONSTRAINT "memory_revision_successor_memory_fk" FOREIGN KEY ("successor_memory_id") REFERENCES "memory"("id") ON DELETE SET NULL,
  CONSTRAINT "memory_revision_candidate_fk" FOREIGN KEY ("candidate_id") REFERENCES "memory_candidate"("id") ON DELETE SET NULL,
  CONSTRAINT "memory_revision_tenant_owner_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "memory_revision_user_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_lifecycle_idx" ON "memory" ("lifecycle", "time_updated");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_class_idx" ON "memory" ("memory_class");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_candidate_status_idx" ON "memory_candidate" ("status", "time_updated");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_candidate_scope_idx" ON "memory_candidate" ("scope", "time_created");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_candidate_run_idx" ON "memory_candidate" ("run_id", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_revision_memory_version_idx" ON "memory_revision" ("memory_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_revision_memory_created_idx" ON "memory_revision" ("memory_id", "time_created");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_revision_run_idx" ON "memory_revision" ("run_id", "time_created");
--> statement-breakpoint
ALTER TABLE "memory_candidate" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memory_candidate" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "memory_candidate";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "memory_candidate"
  USING (tenant_id = arforge_current_tenant_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id));
--> statement-breakpoint
ALTER TABLE "memory_revision" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memory_revision" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "memory_revision";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "memory_revision"
  USING (tenant_id = arforge_current_tenant_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "memory_candidate", "memory_revision" TO arforge_app;
  END IF;
END
$$;
