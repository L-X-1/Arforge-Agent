ALTER TABLE "feedback" ADD COLUMN "workspace_path" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "feedback_workspace_created_idx" ON "feedback" ("workspace_path","time_created");--> statement-breakpoint
CREATE INDEX "feedback_workspace_category_created_idx" ON "feedback" ("workspace_path","category","time_created");
