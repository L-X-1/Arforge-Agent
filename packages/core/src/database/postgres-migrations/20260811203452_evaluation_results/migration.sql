CREATE TABLE evaluation_result (
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  owner_user_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  id text PRIMARY KEY,
  run_id text NOT NULL,
  suite_id text NOT NULL,
  suite_revision bigint NOT NULL CHECK (suite_revision > 0),
  case_id text NOT NULL,
  case_revision bigint NOT NULL CHECK (case_revision > 0),
  baseline_artifact_digest text NOT NULL CHECK (length(baseline_artifact_digest) > 0),
  candidate_artifact_digest text NOT NULL CHECK (length(candidate_artifact_digest) > 0),
  environment_digest text NOT NULL CHECK (length(environment_digest) > 0),
  toolchain_digest text NOT NULL CHECK (length(toolchain_digest) > 0),
  sample_size bigint NOT NULL CHECK (sample_size >= 0),
  score double precision NOT NULL,
  success_delta double precision NOT NULL,
  cost_delta double precision NOT NULL,
  latency_delta double precision NOT NULL,
  passed boolean NOT NULL,
  metrics text NOT NULL,
  evidence_ids text NOT NULL,
  provider_id text,
  model_id text,
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_minor bigint CHECK (cost_minor IS NULL OR cost_minor >= 0),
  currency text,
  reviewer_id text,
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approval_reason text,
  created_at bigint NOT NULL,
  evaluated_at bigint NOT NULL,
  CONSTRAINT evaluation_result_tenant_owner_fk FOREIGN KEY (tenant_id) REFERENCES identity_tenant(id) ON DELETE RESTRICT,
  CONSTRAINT evaluation_result_user_owner_fk FOREIGN KEY (owner_user_id) REFERENCES identity_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX evaluation_result_run_created_idx ON evaluation_result (run_id, created_at);
--> statement-breakpoint
CREATE INDEX evaluation_result_case_revision_idx ON evaluation_result (case_id, case_revision);
--> statement-breakpoint
CREATE INDEX evaluation_result_suite_revision_idx ON evaluation_result (suite_id, suite_revision);
--> statement-breakpoint
CREATE INDEX evaluation_result_tenant_owner_idx ON evaluation_result (tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE evaluation_result ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE evaluation_result FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON evaluation_result
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE evaluation_result TO arforge_app;
  END IF;
END
$$;
