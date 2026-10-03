CREATE TABLE IF NOT EXISTS "evolution_artifact" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "digest" text NOT NULL,
  "kind" text NOT NULL,
  "uri" text NOT NULL,
  "byte_length" bigint NOT NULL,
  "content" text NOT NULL,
  "created_by" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "digest"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evolution_audit" (
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
CREATE TABLE IF NOT EXISTS "evolution_evaluation" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "proposal_id" text NOT NULL,
  "candidate_digest" text NOT NULL,
  "report_digest" text NOT NULL,
  "report" text NOT NULL,
  "run_id" text,
  "created_by" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evolution_exposure" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "ticket_digest" text NOT NULL,
  "ticket" text NOT NULL,
  "status" text NOT NULL,
  "outcome_input_digest" text,
  "receipt_digest" text,
  "receipt" text,
  "revision" bigint NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evolution_lease" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "aggregate_id" text NOT NULL,
  "run_id" text NOT NULL,
  "lease_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "generation" bigint NOT NULL,
  "heartbeat_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "aggregate_id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evolution_observation" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "proposal_id" text NOT NULL,
  "candidate_digest" text NOT NULL,
  "cohort" text NOT NULL,
  "success" boolean NOT NULL,
  "score" double precision NOT NULL,
  "safety_incident" boolean NOT NULL,
  "evidence_ref" text NOT NULL,
  "record_hash" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evolution_proposal" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "artifact_digest" text NOT NULL,
  "artifact_ref" text NOT NULL,
  "manifest" text NOT NULL,
  "state" text NOT NULL,
  "status" text NOT NULL,
  "revision" bigint NOT NULL,
  "evaluation_id" text,
  "control_run_id" text,
  "created_by" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evolution_artifact_kind_idx" ON "evolution_artifact" ("tenant_id", "owner_user_id", "kind", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evolution_audit_record_hash_idx" ON "evolution_audit" ("tenant_id", "owner_user_id", "record_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evolution_audit_aggregate_idx" ON "evolution_audit" ("tenant_id", "owner_user_id", "aggregate_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evolution_evaluation_proposal_digest_idx" ON "evolution_evaluation" ("tenant_id", "owner_user_id", "proposal_id", "report_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evolution_evaluation_proposal_idx" ON "evolution_evaluation" ("tenant_id", "owner_user_id", "proposal_id", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evolution_exposure_ticket_digest_idx" ON "evolution_exposure" ("tenant_id", "owner_user_id", "ticket_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evolution_exposure_status_idx" ON "evolution_exposure" ("tenant_id", "owner_user_id", "status", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evolution_lease_run_idx" ON "evolution_lease" ("tenant_id", "owner_user_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evolution_lease_expiry_idx" ON "evolution_lease" ("tenant_id", "owner_user_id", "expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evolution_observation_proposal_hash_idx" ON "evolution_observation" ("tenant_id", "owner_user_id", "proposal_id", "record_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evolution_observation_proposal_cohort_idx" ON "evolution_observation" ("tenant_id", "owner_user_id", "proposal_id", "cohort", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evolution_proposal_candidate_idx" ON "evolution_proposal" ("tenant_id", "owner_user_id", "candidate_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evolution_proposal_status_idx" ON "evolution_proposal" ("tenant_id", "owner_user_id", "status", "time_updated");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evolution_proposal_digest_idx" ON "evolution_proposal" ("tenant_id", "owner_user_id", "artifact_digest");
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
  table_names text[] := ARRAY[
    'evolution_artifact', 'evolution_audit', 'evolution_evaluation',
    'evolution_exposure', 'evolution_lease', 'evolution_observation', 'evolution_proposal'
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
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE
      evolution_artifact, evolution_audit, evolution_evaluation,
      evolution_exposure, evolution_lease, evolution_observation, evolution_proposal
    TO arforge_app;
  END IF;
END
$$;
