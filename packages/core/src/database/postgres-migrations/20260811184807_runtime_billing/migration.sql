CREATE TABLE session_run_usage (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  id text PRIMARY KEY,
  run_id text NOT NULL,
  session_id text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  usage_source text NOT NULL CHECK (usage_source IN ('provider', 'estimated')),
  estimator_id text,
  unknown_input bigint NOT NULL CHECK (unknown_input >= 0),
  image_input bigint NOT NULL CHECK (image_input >= 0),
  audio_input bigint NOT NULL CHECK (audio_input >= 0),
  cache_read_input bigint NOT NULL CHECK (cache_read_input >= 0),
  cache_write_input bigint NOT NULL CHECK (cache_write_input >= 0),
  text_output bigint NOT NULL CHECK (text_output >= 0),
  reasoning_output bigint NOT NULL CHECK (reasoning_output >= 0),
  audio_output bigint NOT NULL CHECK (audio_output >= 0),
  price_catalog_revision text,
  currency text,
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  unpriced_categories text NOT NULL,
  settlement_reservation_id text,
  over_budget boolean NOT NULL DEFAULT false,
  recorded_at bigint NOT NULL,
  CONSTRAINT session_run_usage_tenant_owner_fk FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  CONSTRAINT session_run_usage_user_owner_fk FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX session_run_usage_run_idx ON session_run_usage (run_id, recorded_at);
--> statement-breakpoint
CREATE INDEX session_run_usage_session_idx ON session_run_usage (session_id, recorded_at);
--> statement-breakpoint
CREATE INDEX session_run_usage_tenant_owner_idx ON session_run_usage (tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE session_run_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE session_run_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON session_run_usage
  USING (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id))
  WITH CHECK (
    tenant_id = arforge_current_tenant_id()
    AND owner_user_id = arforge_current_user_id()
    AND arforge_has_tenant_access(tenant_id)
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE session_run_usage TO arforge_app;
  END IF;
END
$$;
