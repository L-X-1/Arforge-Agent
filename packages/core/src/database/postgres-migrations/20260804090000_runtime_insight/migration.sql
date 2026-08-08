CREATE TABLE audit_entry (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  id text PRIMARY KEY,
  seq bigint NOT NULL,
  recorded_at bigint NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  reason text,
  metadata text,
  previous_hash text NOT NULL,
  record_hash text NOT NULL,
  CONSTRAINT audit_entry_tenant_owner_fk FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  CONSTRAINT audit_entry_user_owner_fk FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX audit_entry_seq_idx ON audit_entry (seq);
--> statement-breakpoint
CREATE INDEX audit_entry_action_idx ON audit_entry (action, recorded_at);
--> statement-breakpoint
CREATE INDEX audit_entry_actor_idx ON audit_entry (actor, recorded_at);
--> statement-breakpoint
CREATE INDEX audit_entry_tenant_owner_idx ON audit_entry (tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_entry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_entry
  USING (tenant_id = arforge_current_tenant_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (
    tenant_id = arforge_current_tenant_id()
    AND owner_user_id = arforge_current_user_id()
    AND arforge_has_tenant_access(tenant_id)
  );
--> statement-breakpoint
CREATE TABLE session_run (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  id text PRIMARY KEY,
  session_id text NOT NULL,
  status text NOT NULL,
  started_at bigint NOT NULL,
  finished_at bigint,
  last_seq bigint,
  error text,
  CONSTRAINT session_run_tenant_owner_fk FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  CONSTRAINT session_run_user_owner_fk FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX session_run_session_idx ON session_run (session_id, started_at);
--> statement-breakpoint
CREATE INDEX session_run_status_idx ON session_run (status, started_at);
--> statement-breakpoint
CREATE INDEX session_run_tenant_owner_idx ON session_run (tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE session_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE session_run FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON session_run
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE audit_entry, session_run TO arforge_app;
  END IF;
END
$$;
