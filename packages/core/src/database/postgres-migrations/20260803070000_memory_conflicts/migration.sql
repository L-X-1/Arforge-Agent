CREATE TABLE memory_conflict (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  id text PRIMARY KEY,
  signature text NOT NULL,
  conflict_key text NOT NULL,
  basis text NOT NULL,
  left_memory_id text NOT NULL,
  right_memory_id text NOT NULL,
  left_fingerprint text NOT NULL,
  right_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  chosen_memory_id text,
  retired_memory_id text,
  retired_original_source text,
  decision_reason text,
  time_created bigint NOT NULL,
  time_updated bigint NOT NULL,
  time_decided bigint,
  time_undone bigint,
  CONSTRAINT memory_conflict_left_memory_fk FOREIGN KEY (left_memory_id) REFERENCES memory(id) ON DELETE CASCADE,
  CONSTRAINT memory_conflict_right_memory_fk FOREIGN KEY (right_memory_id) REFERENCES memory(id) ON DELETE CASCADE,
  CONSTRAINT memory_conflict_tenant_owner_fk FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  CONSTRAINT memory_conflict_user_owner_fk FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_conflict_signature_idx ON memory_conflict (signature);
--> statement-breakpoint
CREATE INDEX memory_conflict_status_idx ON memory_conflict (status, time_updated);
--> statement-breakpoint
CREATE INDEX memory_conflict_left_idx ON memory_conflict (left_memory_id);
--> statement-breakpoint
CREATE INDEX memory_conflict_right_idx ON memory_conflict (right_memory_id);
--> statement-breakpoint
CREATE INDEX memory_conflict_tenant_owner_idx ON memory_conflict (tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE memory_conflict ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memory_conflict FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memory_conflict
  USING (tenant_id = arforge_current_tenant_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (
    tenant_id = arforge_current_tenant_id()
    AND owner_user_id = arforge_current_user_id()
    AND arforge_has_tenant_access(tenant_id)
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE memory_conflict TO arforge_app;
  END IF;
END
$$;
