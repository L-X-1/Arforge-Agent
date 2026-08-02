CREATE TABLE identity_user (
  id text PRIMARY KEY,
  email text NOT NULL,
  normalized_email text NOT NULL,
  display_name text DEFAULT '' NOT NULL,
  password_hash text NOT NULL,
  status text DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  email_verified_at bigint,
  session_epoch bigint DEFAULT 0 NOT NULL CHECK (session_epoch >= 0),
  time_created bigint NOT NULL,
  time_updated bigint NOT NULL,
  CONSTRAINT identity_user_email_normalized CHECK (normalized_email = lower(btrim(email))),
  CONSTRAINT identity_user_password_hash CHECK (id = 'usr_local' OR password_hash LIKE '$argon2id$%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_user_normalized_email_idx ON identity_user (normalized_email);
--> statement-breakpoint
CREATE TABLE identity_tenant (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  created_by_user_id text NOT NULL REFERENCES identity_user(id) ON DELETE RESTRICT,
  time_created bigint NOT NULL,
  time_updated bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_tenant_slug_idx ON identity_tenant (slug);
--> statement-breakpoint
CREATE TABLE identity_tenant_member (
  tenant_id text NOT NULL REFERENCES identity_tenant(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  role text DEFAULT 'member' NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'suspended')),
  time_created bigint NOT NULL,
  time_updated bigint NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
--> statement-breakpoint
CREATE INDEX identity_tenant_member_user_idx ON identity_tenant_member (user_id, status);
--> statement-breakpoint
CREATE TABLE identity_token (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL CHECK (length(token_hash) = 64),
  expires_at bigint NOT NULL,
  consumed_at bigint,
  time_created bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_token_hash_idx ON identity_token (token_hash);
--> statement-breakpoint
CREATE INDEX identity_token_user_purpose_idx ON identity_token (user_id, purpose, expires_at);
--> statement-breakpoint
CREATE TABLE identity_session (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES identity_tenant(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (length(token_hash) = 64),
  session_epoch bigint NOT NULL CHECK (session_epoch >= 0),
  user_agent_hash text DEFAULT '' NOT NULL,
  ip_hash text DEFAULT '' NOT NULL,
  expires_at bigint NOT NULL,
  idle_expires_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  revoked_at bigint,
  time_created bigint NOT NULL,
  CONSTRAINT identity_session_expiry CHECK (idle_expires_at <= expires_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_session_token_hash_idx ON identity_session (token_hash);
--> statement-breakpoint
CREATE INDEX identity_session_user_active_idx ON identity_session (user_id, revoked_at, expires_at);
--> statement-breakpoint
CREATE INDEX identity_session_tenant_idx ON identity_session (tenant_id, expires_at);
--> statement-breakpoint
CREATE TABLE identity_rate_limit (
  bucket text NOT NULL,
  key_hash text NOT NULL CHECK (length(key_hash) = 64),
  failures bigint DEFAULT 0 NOT NULL CHECK (failures >= 0),
  window_started_at bigint NOT NULL,
  blocked_until bigint DEFAULT 0 NOT NULL,
  time_updated bigint NOT NULL,
  PRIMARY KEY (bucket, key_hash)
);
--> statement-breakpoint
CREATE INDEX identity_rate_limit_expiry_idx ON identity_rate_limit (blocked_until);
--> statement-breakpoint
INSERT INTO identity_user (
  id, email, normalized_email, display_name, password_hash, status,
  email_verified_at, session_epoch, time_created, time_updated
) VALUES (
  'usr_local', 'local@arforge.invalid', 'local@arforge.invalid', 'Local owner', '!',
  'disabled', 0, 0, 0, 0
);
--> statement-breakpoint
INSERT INTO identity_tenant (id, name, slug, created_by_user_id, time_created, time_updated)
VALUES ('ten_local', 'Local workspace', 'local', 'usr_local', 0, 0);
--> statement-breakpoint
INSERT INTO identity_tenant_member (tenant_id, user_id, role, status, time_created, time_updated)
VALUES ('ten_local', 'usr_local', 'owner', 'active', 0, 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION arforge_current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION arforge_current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION arforge_has_tenant_access(candidate_tenant_id text)
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
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION arforge_has_tenant_access(text) FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  business_table text;
  ownership_tables text[] := ARRAY[
    'account', 'account_state', 'control_account', 'workspace', 'credential',
    'event_sequence', 'event', 'feedback', 'goal', 'learning_outcome',
    'learning_pattern', 'learning_outcome_pattern', 'memory', 'permission',
    'project', 'project_directory', 'session', 'session_tag', 'message', 'part',
    'todo', 'session_message', 'session_checkpoint', 'scheduled_prompt',
    'session_input', 'session_context_epoch', 'session_share', 'task_graph_task',
    'task_graph_edge', 'team', 'team_member', 'team_message', 'team_shutdown',
    'workflow_graph_runs', 'workflow_graph_nodes', 'workflow_graph_events'
  ];
BEGIN
  FOREACH business_table IN ARRAY ownership_tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT %L',
      business_table,
      'ten_local'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS owner_user_id text NOT NULL DEFAULT %L',
      business_table,
      'usr_local'
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting(''arforge.tenant_id'', true), ''''), ''ten_local'')',
      business_table
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN owner_user_id SET DEFAULT COALESCE(NULLIF(current_setting(''arforge.user_id'', true), ''''), ''usr_local'')',
      business_table
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT',
      business_table,
      left(business_table || '_tenant_owner_fk', 63)
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT',
      business_table,
      left(business_table || '_user_owner_fk', 63)
    );
    EXECUTE format(
      'CREATE INDEX %I ON %I (tenant_id, owner_user_id)',
      left(business_table || '_tenant_owner_idx', 63),
      business_table
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', business_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', business_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', business_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = arforge_current_tenant_id() AND arforge_has_tenant_access(tenant_id)) WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id))',
      business_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      identity_user, identity_tenant, identity_tenant_member, identity_token,
      identity_session, identity_rate_limit
    TO arforge_app;
    GRANT EXECUTE ON FUNCTION arforge_current_tenant_id(), arforge_current_user_id(), arforge_has_tenant_access(text)
    TO arforge_app;
  END IF;
END
$$;
