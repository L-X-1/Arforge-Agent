ALTER TABLE learning_outcome ADD COLUMN IF NOT EXISTS run_id text;
--> statement-breakpoint
ALTER TABLE learning_outcome ADD COLUMN IF NOT EXISTS action_id text;
--> statement-breakpoint
ALTER TABLE learning_outcome ADD COLUMN IF NOT EXISTS evaluation_id text;
--> statement-breakpoint
ALTER TABLE learning_outcome ADD COLUMN IF NOT EXISTS evidence_ids text;
--> statement-breakpoint
ALTER TABLE learning_outcome ADD COLUMN IF NOT EXISTS terminal boolean;
--> statement-breakpoint
ALTER TABLE learning_outcome ADD COLUMN IF NOT EXISTS verifier_passed boolean;
