CREATE TABLE tenant_policy (
  tenant_id text PRIMARY KEY DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local') REFERENCES identity_tenant(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local') REFERENCES identity_user(id) ON DELETE RESTRICT,
  region text NOT NULL DEFAULT 'self-hosted' CHECK (length(btrim(region)) BETWEEN 1 AND 64),
  retention_days bigint NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 1 AND 3650),
  quota_currency text NOT NULL DEFAULT 'USD' CHECK (quota_currency ~ '^[A-Z]{3}$'),
  quota_limit_minor bigint CHECK (quota_limit_minor IS NULL OR quota_limit_minor >= 0),
  rate_limit_per_minute bigint NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute > 0),
  rate_limit_burst bigint NOT NULL DEFAULT 20 CHECK (rate_limit_burst > 0),
  key_version bigint NOT NULL DEFAULT 1 CHECK (key_version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  time_created bigint NOT NULL,
  time_updated bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE tenant_key (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local') REFERENCES identity_tenant(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local') REFERENCES identity_user(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version > 0),
  wrapped_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  time_created bigint NOT NULL,
  time_updated bigint NOT NULL,
  PRIMARY KEY (tenant_id, version),
  UNIQUE (tenant_id, key_digest)
);
--> statement-breakpoint
CREATE TABLE tenant_secret (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local') REFERENCES identity_tenant(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local') REFERENCES identity_user(id) ON DELETE RESTRICT,
  secret_id text NOT NULL CHECK (secret_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  key_version bigint NOT NULL CHECK (key_version > 0),
  ciphertext text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  time_created bigint NOT NULL,
  time_updated bigint NOT NULL,
  revoked_at bigint,
  PRIMARY KEY (tenant_id, secret_id)
);
--> statement-breakpoint
CREATE TABLE tenant_project_member (
  tenant_id text NOT NULL REFERENCES identity_tenant(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  time_created bigint NOT NULL,
  time_updated bigint NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
--> statement-breakpoint
CREATE TABLE tenant_rate_window (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local') REFERENCES identity_tenant(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local') REFERENCES identity_user(id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (bucket ~ '^[A-Za-z0-9._:-]{1,80}$'),
  window_started_at bigint NOT NULL,
  request_count bigint NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  time_updated bigint NOT NULL,
  PRIMARY KEY (tenant_id, bucket)
);
--> statement-breakpoint
CREATE TABLE tenant_usage_ledger (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local') REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local') REFERENCES identity_user(id) ON DELETE RESTRICT,
  id text PRIMARY KEY,
  settlement_id text NOT NULL,
  run_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  source text NOT NULL DEFAULT 'settled-runtime-usage' CHECK (source = 'settled-runtime-usage'),
  recorded_at bigint NOT NULL,
  UNIQUE (tenant_id, settlement_id)
);
--> statement-breakpoint
CREATE TABLE tenant_data_request (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local') REFERENCES identity_tenant(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local') REFERENCES identity_user(id) ON DELETE RESTRICT,
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('tenant-export', 'tenant-delete')),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'executing', 'completed', 'rejected', 'failed')),
  requested_by text NOT NULL REFERENCES identity_user(id) ON DELETE RESTRICT,
  approved_by text REFERENCES identity_user(id) ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT '',
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  requested_at bigint NOT NULL,
  completed_at bigint,
  UNIQUE (tenant_id, request_digest)
);
--> statement-breakpoint
CREATE TABLE tenant_backup_manifest (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local') REFERENCES identity_tenant(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local') REFERENCES identity_user(id) ON DELETE RESTRICT,
  id text PRIMARY KEY,
  region text NOT NULL CHECK (length(btrim(region)) BETWEEN 1 AND 64),
  schema_revision text NOT NULL,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'verified', 'restored', 'failed')),
  created_at bigint NOT NULL,
  verified_at bigint,
  UNIQUE (tenant_id, artifact_digest)
);
--> statement-breakpoint
CREATE TABLE tenant_audit_export (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local') REFERENCES identity_tenant(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local') REFERENCES identity_user(id) ON DELETE RESTRICT,
  id text PRIMARY KEY,
  requested_by text NOT NULL REFERENCES identity_user(id) ON DELETE RESTRICT,
  item_count bigint NOT NULL CHECK (item_count >= 0),
  export_digest text NOT NULL CHECK (export_digest ~ '^[a-f0-9]{64}$'),
  created_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX tenant_project_member_tenant_idx ON tenant_project_member (tenant_id, user_id, status);
--> statement-breakpoint
CREATE INDEX tenant_rate_window_updated_idx ON tenant_rate_window (tenant_id, time_updated);
--> statement-breakpoint
CREATE INDEX tenant_usage_recorded_idx ON tenant_usage_ledger (tenant_id, recorded_at);
--> statement-breakpoint
CREATE INDEX tenant_data_request_status_idx ON tenant_data_request (tenant_id, status, requested_at);
--> statement-breakpoint
CREATE INDEX tenant_backup_manifest_tenant_idx ON tenant_backup_manifest (tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX tenant_audit_export_tenant_idx ON tenant_audit_export (tenant_id, created_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION arforge_is_tenant_admin(candidate_tenant_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.identity_tenant_member AS membership
    WHERE membership.tenant_id = candidate_tenant_id
      AND membership.user_id = public.arforge_current_user_id()
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION arforge_has_project_access(candidate_project_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project AS project_row
    WHERE project_row.id = candidate_project_id
      AND project_row.tenant_id = public.arforge_current_tenant_id()
      AND (
        project_row.owner_user_id = public.arforge_current_user_id()
        OR public.arforge_is_tenant_admin(project_row.tenant_id)
        OR EXISTS (
          SELECT 1
          FROM public.tenant_project_member AS membership
          WHERE membership.project_id = candidate_project_id
            AND membership.tenant_id = public.arforge_current_tenant_id()
            AND membership.user_id = public.arforge_current_user_id()
            AND membership.status = 'active'
        )
      )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION arforge_has_session_access(candidate_session_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.session AS session_row
    WHERE session_row.id = candidate_session_id
      AND public.arforge_has_project_access(session_row.project_id)
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION arforge_is_tenant_admin(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION arforge_has_project_access(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION arforge_has_session_access(text) FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
  owned_tables text[] := ARRAY[
    'tenant_policy', 'tenant_key', 'tenant_secret',
    'tenant_rate_window', 'tenant_usage_ledger', 'tenant_data_request',
    'tenant_backup_manifest', 'tenant_audit_export'
  ];
BEGIN
  FOREACH table_name IN ARRAY owned_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = arforge_current_tenant_id() AND arforge_has_tenant_access(tenant_id)) WITH CHECK (tenant_id = arforge_current_tenant_id() AND (owner_user_id = arforge_current_user_id() OR arforge_is_tenant_admin(tenant_id)) AND arforge_has_tenant_access(tenant_id))',
      table_name
    );
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE tenant_project_member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_project_member FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_project_member_isolation ON tenant_project_member
  USING (
    tenant_id = arforge_current_tenant_id()
    AND arforge_has_tenant_access(tenant_id)
    AND (user_id = arforge_current_user_id() OR arforge_is_tenant_admin(tenant_id))
  )
  WITH CHECK (
    tenant_id = arforge_current_tenant_id()
    AND arforge_is_tenant_admin(tenant_id)
  );
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
  project_tables text[] := ARRAY['project_directory', 'workspace', 'session', 'learning_outcome', 'learning_pattern', 'permission'];
  session_tables text[] := ARRAY['session_tag', 'message', 'part', 'todo', 'session_message', 'session_checkpoint', 'scheduled_prompt', 'session_input', 'session_context_epoch', 'session_share', 'task_graph_task', 'task_graph_edge', 'feedback', 'goal'];
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON project;
  CREATE POLICY tenant_isolation ON project
    USING (tenant_id = arforge_current_tenant_id() AND arforge_has_project_access(id))
    WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id));
  FOREACH table_name IN ARRAY project_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = arforge_current_tenant_id() AND arforge_has_project_access(project_id)) WITH CHECK (tenant_id = arforge_current_tenant_id() AND (owner_user_id = arforge_current_user_id() OR arforge_is_tenant_admin(tenant_id)) AND arforge_has_project_access(project_id))',
      table_name
    );
  END LOOP;
  FOREACH table_name IN ARRAY session_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = arforge_current_tenant_id() AND arforge_has_session_access(session_id)) WITH CHECK (tenant_id = arforge_current_tenant_id() AND (owner_user_id = arforge_current_user_id() OR arforge_is_tenant_admin(tenant_id)) AND arforge_has_session_access(session_id))',
      table_name
    );
  END LOOP;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      tenant_policy, tenant_key, tenant_secret, tenant_project_member,
      tenant_rate_window, tenant_usage_ledger, tenant_data_request,
      tenant_backup_manifest, tenant_audit_export
    TO arforge_app;
    GRANT EXECUTE ON FUNCTION arforge_is_tenant_admin(text), arforge_has_project_access(text), arforge_has_session_access(text)
    TO arforge_app;
  END IF;
END
$$;
