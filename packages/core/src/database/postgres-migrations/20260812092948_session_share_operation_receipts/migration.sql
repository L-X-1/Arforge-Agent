CREATE TABLE IF NOT EXISTS "session_share_operation_receipt" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "operation_id" text NOT NULL,
  "run_id" text NOT NULL,
  "action_id" text NOT NULL,
  "request_id" text NOT NULL,
  "kind" text NOT NULL,
  "session_id" text NOT NULL,
  "project_id" text NOT NULL,
  "snapshot_digest" text NOT NULL,
  "export_digest" text NOT NULL,
  "target_base_url" text NOT NULL,
  "visibility" text NOT NULL,
  "organization_id" text,
  "provider_receipt_id" text,
  "publication_id" text NOT NULL,
  "publication_url" text NOT NULL,
  "stored_digest" text,
  "removed_digest" text,
  "response_digest" text NOT NULL,
  "time_created" bigint NOT NULL,
  CONSTRAINT "session_share_operation_receipt_owner_operation_pk"
    PRIMARY KEY ("tenant_id", "owner_user_id", "operation_id"),
  CONSTRAINT "session_share_operation_receipt_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE RESTRICT,
  CONSTRAINT "session_share_operation_receipt_tenant_owner_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "session_share_operation_receipt_user_owner_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "session_share_operation_receipt_kind_fields_check"
    CHECK (
      ("kind" = 'share'
        AND "provider_receipt_id" IS NOT NULL
        AND "stored_digest" IS NOT NULL
        AND "removed_digest" IS NULL)
      OR ("kind" = 'unshare'
        AND "provider_receipt_id" IS NULL
        AND "stored_digest" IS NULL
        AND "removed_digest" IS NOT NULL)
    ),
  CONSTRAINT "session_share_operation_receipt_visibility_check"
    CHECK ("visibility" IN ('private', 'organization', 'public'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_share_operation_receipt_operation_uidx"
  ON "session_share_operation_receipt" ("tenant_id", "owner_user_id", "operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_share_operation_receipt_session_idx"
  ON "session_share_operation_receipt" ("tenant_id", "owner_user_id", "session_id", "time_created");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_share_operation_receipt_publication_idx"
  ON "session_share_operation_receipt" ("tenant_id", "owner_user_id", "publication_id", "time_created");
--> statement-breakpoint
ALTER TABLE "session_share_operation_receipt" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session_share_operation_receipt" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "session_share_operation_receipt";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "session_share_operation_receipt"
  USING (
    tenant_id = arforge_current_tenant_id()
    AND owner_user_id = arforge_current_user_id()
    AND arforge_has_tenant_access(tenant_id)
  )
  WITH CHECK (
    tenant_id = arforge_current_tenant_id()
    AND owner_user_id = arforge_current_user_id()
    AND arforge_has_tenant_access(tenant_id)
  );
--> statement-breakpoint
REVOKE ALL ON TABLE "session_share_operation_receipt" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "session_share_operation_receipt" FROM arforge_app;
    GRANT SELECT, INSERT ON TABLE "session_share_operation_receipt" TO arforge_app;
  END IF;
END
$$;
