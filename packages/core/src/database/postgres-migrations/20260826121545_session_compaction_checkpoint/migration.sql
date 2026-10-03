CREATE TABLE IF NOT EXISTS "session_compaction_checkpoint" (
  "tenant_id" text NOT NULL DEFAULT 'ten_local',
  "owner_user_id" text NOT NULL DEFAULT 'usr_local',
  "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "operation_id" text NOT NULL,
  "sequence" bigint NOT NULL,
  "phase" text NOT NULL,
  "checkpoint" text NOT NULL,
  "time_created" bigint NOT NULL,
  CONSTRAINT "session_compaction_checkpoint_pk" PRIMARY KEY ("session_id", "operation_id", "sequence"),
  CONSTRAINT "session_compaction_checkpoint_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "session_compaction_checkpoint_phase_check" CHECK (
    "phase" IN ('prepared', 'summarizing', 'summarized', 'revalidated', 'committed', 'closed', 'aborted')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_compaction_checkpoint_session_created_idx"
  ON "session_compaction_checkpoint" ("session_id", "time_created");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_compaction_checkpoint_operation_sequence_idx"
  ON "session_compaction_checkpoint" ("session_id", "operation_id", "sequence");
--> statement-breakpoint
ALTER TABLE "session_compaction_checkpoint" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session_compaction_checkpoint" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "session_compaction_checkpoint_tenant_isolation" ON "session_compaction_checkpoint"
  USING ("tenant_id" = arforge_current_tenant_id() AND arforge_has_tenant_access("tenant_id"))
  WITH CHECK (
    "tenant_id" = arforge_current_tenant_id()
    AND "owner_user_id" = arforge_current_user_id()
    AND arforge_has_tenant_access("tenant_id")
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
    GRANT SELECT, INSERT ON TABLE "session_compaction_checkpoint" TO arforge_app;
  END IF;
END
$$;
