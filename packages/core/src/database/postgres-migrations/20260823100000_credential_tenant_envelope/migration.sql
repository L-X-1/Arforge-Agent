ALTER TABLE credential
  ADD COLUMN encrypted_value text,
  ADD COLUMN value_key_version bigint CHECK (value_key_version IS NULL OR value_key_version > 0),
  ADD COLUMN value_fingerprint text CHECK (value_fingerprint IS NULL OR value_fingerprint ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON credential;
--> statement-breakpoint
DROP POLICY IF EXISTS credential_owner_isolation ON credential;
--> statement-breakpoint
CREATE POLICY credential_owner_isolation ON credential
  USING (
    tenant_id = arforge_current_tenant_id()
    AND arforge_has_tenant_access(tenant_id)
    AND (owner_user_id = arforge_current_user_id() OR arforge_is_tenant_admin(tenant_id))
  )
  WITH CHECK (
    tenant_id = arforge_current_tenant_id()
    AND owner_user_id = arforge_current_user_id()
    AND arforge_has_tenant_access(tenant_id)
  );
