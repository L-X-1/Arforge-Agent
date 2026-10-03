CREATE TABLE IF NOT EXISTS "mailbox_message" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "protocol_version" bigint NOT NULL DEFAULT 1,
  "team_id" text NOT NULL,
  "run_id" text NOT NULL,
  "task_id" text NOT NULL,
  "sender" text NOT NULL,
  "recipient" text NOT NULL,
  "sequence" bigint NOT NULL,
  "idempotency_key" text NOT NULL,
  "kind" text NOT NULL,
  "summary" text NOT NULL,
  "message" text NOT NULL,
  "artifact_refs" text NOT NULL,
  "evidence_refs" text NOT NULL,
  "digest" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "cancel_reason" text,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  CONSTRAINT "mailbox_message_pk" PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  CONSTRAINT "mailbox_message_team_fk" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_message_task_fk" FOREIGN KEY ("task_id") REFERENCES "task_graph_task"("id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_message_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "mailbox_message_user_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "mailbox_message_kind_check" CHECK ("kind" IN ('request', 'response', 'result', 'event', 'error', 'cancel')),
  CONSTRAINT "mailbox_message_status_check" CHECK ("status" IN ('queued', 'acknowledged', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailbox_receipt" (
  "tenant_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.tenant_id', true), ''), 'ten_local'),
  "owner_user_id" text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('arforge.user_id', true), ''), 'usr_local'),
  "id" text NOT NULL,
  "protocol_version" bigint NOT NULL DEFAULT 1,
  "message_id" text NOT NULL,
  "team_id" text NOT NULL,
  "run_id" text NOT NULL,
  "task_id" text NOT NULL,
  "recipient" text NOT NULL,
  "status" text NOT NULL,
  "message_digest" text NOT NULL,
  "reason" text NOT NULL DEFAULT '',
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  CONSTRAINT "mailbox_receipt_pk" PRIMARY KEY ("tenant_id", "owner_user_id", "id"),
  CONSTRAINT "mailbox_receipt_message_fk" FOREIGN KEY ("tenant_id", "owner_user_id", "message_id") REFERENCES "mailbox_message"("tenant_id", "owner_user_id", "id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_receipt_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity_tenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "mailbox_receipt_user_fk" FOREIGN KEY ("owner_user_id") REFERENCES "identity_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "mailbox_receipt_status_check" CHECK ("status" IN ('accepted', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_message_idempotency_idx"
  ON "mailbox_message" ("tenant_id", "owner_user_id", "team_id", "run_id", "task_id", "sender", "recipient", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailbox_message_thread_idx"
  ON "mailbox_message" ("tenant_id", "owner_user_id", "team_id", "run_id", "task_id", "recipient", "sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailbox_message_status_idx"
  ON "mailbox_message" ("tenant_id", "owner_user_id", "status", "time_updated");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_receipt_message_recipient_idx"
  ON "mailbox_receipt" ("tenant_id", "owner_user_id", "message_id", "recipient");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailbox_receipt_thread_idx"
  ON "mailbox_receipt" ("tenant_id", "owner_user_id", "team_id", "run_id", "task_id", "recipient", "time_created");
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
  table_names text[] := ARRAY['mailbox_message', 'mailbox_receipt'];
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
    GRANT SELECT, INSERT, UPDATE ON TABLE "mailbox_message", "mailbox_receipt" TO arforge_app;
  END IF;
END
$$;
