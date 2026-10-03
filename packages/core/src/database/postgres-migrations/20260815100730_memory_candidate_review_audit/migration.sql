CREATE TABLE IF NOT EXISTS "memory_candidate_audit" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text PRIMARY KEY,
  "candidate_id" text NOT NULL,
  "operation" text NOT NULL,
  "actor_kind" text NOT NULL,
  "principal_ref" text,
  "reason" text NOT NULL,
  "policy_version" text NOT NULL,
  "status_from" text,
  "status_to" text NOT NULL,
  "time_created" bigint NOT NULL,
  CONSTRAINT "memory_candidate_audit_candidate_fk" FOREIGN KEY ("candidate_id") REFERENCES "memory_candidate"("id") ON DELETE CASCADE,
  CONSTRAINT "memory_candidate_audit_tenant_owner_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "memory_candidate_audit_user_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_candidate_audit_candidate_idx" ON "memory_candidate_audit" ("candidate_id", "time_created");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_candidate_audit_operation_idx" ON "memory_candidate_audit" ("operation", "time_created");
--> statement-breakpoint
ALTER TABLE "memory_candidate_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memory_candidate_audit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "memory_candidate_audit";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "memory_candidate_audit"
  USING (tenant_id = arforge_current_tenant_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT ON TABLE "memory_candidate_audit" TO arforge_app;
  END IF;
END
$$;
