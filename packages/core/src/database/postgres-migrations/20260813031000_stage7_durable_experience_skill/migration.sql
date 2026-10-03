CREATE TABLE IF NOT EXISTS "experience_audit" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "aggregate_id" text NOT NULL,
  "sequence" bigint NOT NULL,
  "action" text NOT NULL,
  "actor" text NOT NULL,
  "reason" text NOT NULL,
  "metadata" text NOT NULL,
  "previous_hash" text NOT NULL,
  "record_hash" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "aggregate_id", "sequence"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experience_candidate" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "problem_signature" text NOT NULL,
  "applicable_scope" text NOT NULL,
  "conditions" text NOT NULL,
  "attempted_strategy" text NOT NULL,
  "counterexamples" text NOT NULL,
  "support_count" bigint NOT NULL,
  "source_run_ids" text NOT NULL,
  "source_support_ids" text NOT NULL,
  "evidence_ids" text NOT NULL,
  "evaluation_digest" text,
  "review_actor" text,
  "review_reason" text,
  "review_status" text NOT NULL,
  "status" text NOT NULL,
  "policy_version" text NOT NULL,
  "expiry_at" bigint,
  "digest" text NOT NULL,
  "revision" bigint NOT NULL,
  "created_by" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experience_evaluation" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "evaluation_digest" text NOT NULL,
  "comparison" text NOT NULL,
  "passed" boolean NOT NULL,
  "created_by" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experience_evidence" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "run_id" text NOT NULL,
  "action_id" text NOT NULL,
  "observation_id" text NOT NULL,
  "record_digest" text NOT NULL,
  "record" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experience_record" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "support_id" text NOT NULL,
  "run_id" text NOT NULL,
  "action_id" text NOT NULL,
  "evaluation_id" text NOT NULL,
  "evidence_ids" text NOT NULL,
  "record_digest" text NOT NULL,
  "record" text NOT NULL,
  "policy_version" text NOT NULL,
  "promoted_by" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experience_support" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "run_id" text NOT NULL,
  "action_id" text NOT NULL,
  "evaluation_id" text NOT NULL,
  "evidence_ids" text NOT NULL,
  "summary" text NOT NULL,
  "support_digest" text NOT NULL,
  "learning_outcome_id" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_audit" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "aggregate_id" text NOT NULL,
  "sequence" bigint NOT NULL,
  "action" text NOT NULL,
  "actor" text NOT NULL,
  "reason" text NOT NULL,
  "metadata" text NOT NULL,
  "previous_hash" text NOT NULL,
  "record_hash" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "aggregate_id", "sequence"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_canary_observation" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "run_id" text NOT NULL,
  "evaluation_id" text NOT NULL,
  "cohort_key_digest" text NOT NULL,
  "success" boolean NOT NULL,
  "safety_incident" boolean NOT NULL,
  "evidence_ids" text NOT NULL,
  "record_digest" text NOT NULL,
  "record" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_deployment" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "skill_id" text NOT NULL,
  "active_candidate_id" text NOT NULL,
  "previous_candidate_id" text,
  "generation" bigint NOT NULL,
  "deployment_digest" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "skill_id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_evaluation" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "report_digest" text NOT NULL,
  "report" text NOT NULL,
  "passed" boolean NOT NULL,
  "created_by" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_version" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "skill_id" text NOT NULL,
  "version" text NOT NULL,
  "digest" text NOT NULL,
  "skill_record" text NOT NULL,
  "manifest" text NOT NULL,
  "artifact_files" text NOT NULL,
  "tests" text NOT NULL,
  "scan" text NOT NULL,
  "source_experience_ids" text NOT NULL,
  "source_evidence_ids" text NOT NULL,
  "evaluation_id" text NOT NULL,
  "evaluation_digest" text,
  "evaluation_passed" boolean,
  "baseline_version_id" text,
  "status" text NOT NULL,
  "revision" bigint NOT NULL,
  "policy_version" text NOT NULL,
  "created_by" text NOT NULL,
  "review_actor" text,
  "review_reason" text,
  "traffic_percent" bigint,
  "canary_digest" text,
  "rollback_version" text,
  "record_digest" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_audit_record_hash_idx" ON "experience_audit" ("tenant_id", "owner_user_id", "record_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_audit_aggregate_idx" ON "experience_audit" ("tenant_id", "owner_user_id", "aggregate_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_candidate_digest_idx" ON "experience_candidate" ("tenant_id", "owner_user_id", "digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_candidate_status_idx" ON "experience_candidate" ("tenant_id", "owner_user_id", "status", "time_updated");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_evaluation_candidate_digest_idx" ON "experience_evaluation" ("tenant_id", "owner_user_id", "candidate_id", "evaluation_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_evaluation_candidate_idx" ON "experience_evaluation" ("tenant_id", "owner_user_id", "candidate_id", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_evidence_record_digest_idx" ON "experience_evidence" ("tenant_id", "owner_user_id", "record_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_evidence_run_action_idx" ON "experience_evidence" ("tenant_id", "owner_user_id", "run_id", "action_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_record_support_idx" ON "experience_record" ("tenant_id", "owner_user_id", "support_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_record_digest_idx" ON "experience_record" ("tenant_id", "owner_user_id", "record_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_record_candidate_idx" ON "experience_record" ("tenant_id", "owner_user_id", "candidate_id", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_support_candidate_run_idx" ON "experience_support" ("tenant_id", "owner_user_id", "candidate_id", "run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_support_digest_idx" ON "experience_support" ("tenant_id", "owner_user_id", "support_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_support_candidate_idx" ON "experience_support" ("tenant_id", "owner_user_id", "candidate_id", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_audit_record_hash_idx" ON "skill_audit" ("tenant_id", "owner_user_id", "record_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_audit_aggregate_idx" ON "skill_audit" ("tenant_id", "owner_user_id", "aggregate_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_canary_idempotency_idx" ON "skill_canary_observation" ("tenant_id", "owner_user_id", "candidate_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_canary_record_digest_idx" ON "skill_canary_observation" ("tenant_id", "owner_user_id", "record_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_canary_candidate_idx" ON "skill_canary_observation" ("tenant_id", "owner_user_id", "candidate_id", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_deployment_digest_idx" ON "skill_deployment" ("tenant_id", "owner_user_id", "deployment_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_evaluation_candidate_idx" ON "skill_evaluation" ("tenant_id", "owner_user_id", "candidate_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_evaluation_digest_idx" ON "skill_evaluation" ("tenant_id", "owner_user_id", "report_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_version_identity_idx" ON "skill_version" ("tenant_id", "owner_user_id", "skill_id", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_version_digest_idx" ON "skill_version" ("tenant_id", "owner_user_id", "digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_version_status_idx" ON "skill_version" ("tenant_id", "owner_user_id", "skill_id", "status", "time_updated");
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
  table_names text[] := ARRAY[
    'experience_audit', 'experience_candidate', 'experience_evaluation',
    'experience_evidence', 'experience_record', 'experience_support',
    'skill_audit', 'skill_canary_observation', 'skill_deployment',
    'skill_evaluation', 'skill_version'
  ];
BEGIN
  FOREACH table_name IN ARRAY table_names LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id)) WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id))',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
  END LOOP;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
  learning_tables text[] := ARRAY['learning_outcome', 'learning_pattern', 'learning_outcome_pattern'];
BEGIN
  FOREACH table_name IN ARRAY learning_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id)) WITH CHECK (tenant_id = arforge_current_tenant_id() AND owner_user_id = arforge_current_user_id() AND arforge_has_tenant_access(tenant_id))',
      table_name
    );
  END LOOP;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT ON TABLE
      experience_audit, experience_evaluation, experience_evidence,
      experience_record, experience_support, skill_audit,
      skill_canary_observation, skill_evaluation
    TO arforge_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE
      experience_candidate, skill_deployment, skill_version
    TO arforge_app;
  END IF;
END
$$;
