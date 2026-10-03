CREATE TABLE IF NOT EXISTS "experience_graph_relation" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "source_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "source_digest" text NOT NULL,
  "target_kind" text NOT NULL,
  "target_id" text NOT NULL,
  "target_digest" text NOT NULL,
  "relation_kind" text NOT NULL,
  "evidence_ids" text NOT NULL,
  "policy_version" text NOT NULL,
  "digest" text NOT NULL,
  "time_created" bigint NOT NULL,
  CONSTRAINT "experience_graph_relation_pk"
    PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  CONSTRAINT "experience_graph_relation_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "experience_graph_relation_user_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_graph_relation_identity_uidx"
  ON "experience_graph_relation" ("tenant_id", "owner_user_id", "source_kind", "source_id", "target_kind", "target_id", "relation_kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_graph_relation_source_idx"
  ON "experience_graph_relation" ("tenant_id", "owner_user_id", "source_kind", "source_id", "time_created");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_graph_relation_target_idx"
  ON "experience_graph_relation" ("tenant_id", "owner_user_id", "target_kind", "target_id", "time_created");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_graph_relation_kind_idx"
  ON "experience_graph_relation" ("tenant_id", "owner_user_id", "relation_kind", "time_created");
--> statement-breakpoint
ALTER TABLE "experience_graph_relation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "experience_graph_relation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "experience_graph_relation";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "experience_graph_relation"
  USING (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id));
--> statement-breakpoint
REVOKE ALL ON TABLE "experience_graph_relation" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "experience_graph_relation" FROM arforge_app;
    GRANT SELECT, INSERT ON TABLE "experience_graph_relation" TO arforge_app;
  END IF;
END
$$;
