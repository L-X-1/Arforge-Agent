CREATE TABLE IF NOT EXISTS "self_hosted_share_publication" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "publication_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "operation_digest" text NOT NULL,
  "provider_receipt_id" text NOT NULL,
  "publication_url" text NOT NULL,
  "export_digest" text NOT NULL,
  "frozen_export" text NOT NULL,
  "target_base_url" text NOT NULL,
  "visibility" text NOT NULL,
  "organization_id" text,
  "time_created" bigint NOT NULL,
  CONSTRAINT "self_hosted_share_publication_pk"
    PRIMARY KEY ("tenant_id", "owner_user_id", "publication_id"),
  CONSTRAINT "self_hosted_share_publication_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "self_hosted_share_publication_user_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "self_hosted_share_publication_visibility_check"
    CHECK ("visibility" IN ('private', 'organization', 'public'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "self_hosted_share_publication_operation_uidx"
  ON "self_hosted_share_publication" ("tenant_id", "owner_user_id", "operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "self_hosted_share_publication_receipt_uidx"
  ON "self_hosted_share_publication" ("tenant_id", "owner_user_id", "provider_receipt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "self_hosted_share_publication_created_idx"
  ON "self_hosted_share_publication" ("tenant_id", "owner_user_id", "time_created");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "self_hosted_share_revocation" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "operation_id" text NOT NULL,
  "operation_digest" text NOT NULL,
  "publication_id" text NOT NULL,
  "original_digest" text NOT NULL,
  "target_base_url" text NOT NULL,
  "visibility" text NOT NULL,
  "organization_id" text,
  "time_created" bigint NOT NULL,
  CONSTRAINT "self_hosted_share_revocation_pk"
    PRIMARY KEY ("tenant_id", "owner_user_id", "operation_id"),
  CONSTRAINT "self_hosted_share_revocation_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "self_hosted_share_revocation_user_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "self_hosted_share_revocation_visibility_check"
    CHECK ("visibility" IN ('private', 'organization', 'public'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "self_hosted_share_revocation_operation_uidx"
  ON "self_hosted_share_revocation" ("tenant_id", "owner_user_id", "operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "self_hosted_share_revocation_publication_uidx"
  ON "self_hosted_share_revocation" ("tenant_id", "owner_user_id", "publication_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "self_hosted_share_revocation_created_idx"
  ON "self_hosted_share_revocation" ("tenant_id", "owner_user_id", "time_created");
--> statement-breakpoint
ALTER TABLE "self_hosted_share_publication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "self_hosted_share_publication" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "self_hosted_share_publication";
CREATE POLICY tenant_isolation ON "self_hosted_share_publication"
  USING (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id));
ALTER TABLE "self_hosted_share_revocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "self_hosted_share_revocation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "self_hosted_share_revocation";
CREATE POLICY tenant_isolation ON "self_hosted_share_revocation"
  USING (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id));
--> statement-breakpoint
REVOKE ALL ON TABLE "self_hosted_share_publication", "self_hosted_share_revocation" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "self_hosted_share_publication", "self_hosted_share_revocation" FROM arforge_app;
    GRANT SELECT, INSERT ON TABLE "self_hosted_share_publication", "self_hosted_share_revocation" TO arforge_app;
  END IF;
END
$$;
