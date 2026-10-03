ALTER TABLE "memory_candidate" ADD COLUMN IF NOT EXISTS "project_id" text;
--> statement-breakpoint
ALTER TABLE "memory_candidate" ADD COLUMN IF NOT EXISTS "workspace_path" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "memory_candidate_scope_idx";
--> statement-breakpoint
CREATE INDEX "memory_candidate_scope_idx" ON "memory_candidate" ("scope", "project_id", "workspace_path", "time_created");
