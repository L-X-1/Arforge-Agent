CREATE TABLE memory_correction (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  id text PRIMARY KEY,
  original_memory_id text NOT NULL,
  successor_memory_id text NOT NULL,
  original_source text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  time_created bigint NOT NULL,
  time_undone bigint,
  CONSTRAINT memory_correction_original_memory_fk FOREIGN KEY (original_memory_id) REFERENCES memory(id) ON DELETE CASCADE,
  CONSTRAINT memory_correction_successor_memory_fk FOREIGN KEY (successor_memory_id) REFERENCES memory(id) ON DELETE CASCADE,
  CONSTRAINT memory_correction_tenant_owner_fk FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  CONSTRAINT memory_correction_user_owner_fk FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX memory_correction_original_idx ON memory_correction (original_memory_id, time_created);
--> statement-breakpoint
CREATE INDEX memory_correction_successor_idx ON memory_correction (successor_memory_id);
--> statement-breakpoint
CREATE INDEX memory_correction_status_idx ON memory_correction (status, time_created);
--> statement-breakpoint
CREATE INDEX memory_correction_tenant_owner_idx ON memory_correction (tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE memory_correction ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memory_correction FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memory_correction
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE memory_correction TO arforge_app;
  END IF;
END
$$;
