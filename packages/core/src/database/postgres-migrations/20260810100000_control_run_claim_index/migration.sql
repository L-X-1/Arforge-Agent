CREATE TABLE control_run_claim (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  binding_digest text NOT NULL,
  base_binding_digest text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  operation_id text NOT NULL,
  run_id text NOT NULL,
  control_plane_id text NOT NULL,
  location text NOT NULL,
  project_id text NOT NULL,
  actor text NOT NULL,
  canonical_request_id text NOT NULL,
  claim_digest text NOT NULL,
  canonical_authorization_digest text NOT NULL,
  canonical_action_id text NOT NULL,
  policy_version text NOT NULL,
  input_digest text NOT NULL,
  payload_digest text NOT NULL,
  created_run_digest text NOT NULL,
  created_sequence bigint NOT NULL CHECK (created_sequence = 0),
  time_created bigint NOT NULL,
  CONSTRAINT control_run_claim_owner_binding_pk
    PRIMARY KEY (tenant_id, owner_user_id, binding_digest),
  CONSTRAINT control_run_claim_tenant_owner_fk
    FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  CONSTRAINT control_run_claim_user_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX control_run_claim_base_generation_uidx
  ON control_run_claim (tenant_id, owner_user_id, base_binding_digest, generation);
--> statement-breakpoint
CREATE UNIQUE INDEX control_run_claim_operation_uidx
  ON control_run_claim (tenant_id, owner_user_id, operation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX control_run_claim_run_uidx
  ON control_run_claim (tenant_id, owner_user_id, run_id);
--> statement-breakpoint
CREATE INDEX control_run_claim_subject_idx
  ON control_run_claim (tenant_id, owner_user_id, control_plane_id, location, project_id);
--> statement-breakpoint
CREATE INDEX control_run_claim_tenant_owner_idx
  ON control_run_claim (tenant_id, owner_user_id);
--> statement-breakpoint
CREATE TABLE control_run_request_alias (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  alias_digest text NOT NULL,
  request_id text NOT NULL,
  control_plane_id text NOT NULL,
  binding_digest text NOT NULL,
  presented_authorization_digest text NOT NULL,
  presented_action_id text NOT NULL,
  presented_snapshot_digest text NOT NULL,
  time_created bigint NOT NULL,
  CONSTRAINT control_run_request_alias_owner_alias_pk
    PRIMARY KEY (tenant_id, owner_user_id, alias_digest),
  CONSTRAINT control_run_request_alias_tenant_owner_fk
    FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  CONSTRAINT control_run_request_alias_user_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT,
  CONSTRAINT control_run_request_alias_claim_fk
    FOREIGN KEY (tenant_id, owner_user_id, binding_digest)
    REFERENCES control_run_claim(tenant_id, owner_user_id, binding_digest)
    ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX control_run_request_alias_owner_request_uidx
  ON control_run_request_alias (tenant_id, owner_user_id, control_plane_id, request_id);
--> statement-breakpoint
CREATE INDEX control_run_request_alias_binding_idx
  ON control_run_request_alias (tenant_id, owner_user_id, binding_digest, time_created);
--> statement-breakpoint
CREATE INDEX control_run_request_alias_tenant_owner_idx
  ON control_run_request_alias (tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE control_run_claim ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE control_run_claim FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON control_run_claim
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
ALTER TABLE control_run_request_alias ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE control_run_request_alias FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON control_run_request_alias
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
REVOKE ALL ON TABLE control_run_claim, control_run_request_alias FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE control_run_claim, control_run_request_alias FROM arforge_app;
    GRANT SELECT, INSERT ON TABLE control_run_claim, control_run_request_alias TO arforge_app;
  END IF;
END
$$;
