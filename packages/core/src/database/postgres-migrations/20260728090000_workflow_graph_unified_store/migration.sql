CREATE TABLE "workflow_graph_runs" (
	"run_id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"source_path" text NOT NULL,
	"workspace" text NOT NULL,
	"definition_json" text NOT NULL,
	"permission_mode" text NOT NULL,
	"status" text NOT NULL,
	"control" text DEFAULT '' NOT NULL,
	"max_parallel" bigint NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"started_at" text,
	"finished_at" text,
	"last_error" text DEFAULT '' NOT NULL,
	"lease_owner" text DEFAULT '' NOT NULL,
	"lease_expires_at" text
);
--> statement-breakpoint
CREATE INDEX "workflow_graph_run_session_updated_idx" ON "workflow_graph_runs" ("session_id","updated_at");
--> statement-breakpoint
CREATE INDEX "workflow_graph_run_status_lease_idx" ON "workflow_graph_runs" ("status","lease_expires_at");
--> statement-breakpoint
CREATE TABLE "workflow_graph_nodes" (
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"position" bigint NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"access" text DEFAULT 'write' NOT NULL,
	"status" text NOT NULL,
	"attempt" bigint DEFAULT 0 NOT NULL,
	"max_attempts" bigint DEFAULT 1 NOT NULL,
	"depends_on_json" text NOT NULL,
	"continue_on_error" boolean DEFAULT false NOT NULL,
	"when_step" text DEFAULT '' NOT NULL,
	"when_statuses_json" text DEFAULT '[]' NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"started_at" text,
	"finished_at" text,
	CONSTRAINT "workflow_graph_nodes_pkey" PRIMARY KEY("run_id","node_id")
);
--> statement-breakpoint
CREATE INDEX "workflow_graph_node_run_position_idx" ON "workflow_graph_nodes" ("run_id","position");
--> statement-breakpoint
CREATE INDEX "workflow_graph_node_run_status_idx" ON "workflow_graph_nodes" ("run_id","status");
--> statement-breakpoint
CREATE TABLE "workflow_graph_events" (
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"node_id" text DEFAULT '' NOT NULL,
	"data_json" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "workflow_graph_events_pkey" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE INDEX "workflow_graph_event_run_created_idx" ON "workflow_graph_events" ("run_id","created_at");
--> statement-breakpoint
ALTER TABLE "workflow_graph_nodes" ADD CONSTRAINT "workflow_graph_nodes_run_id_workflow_graph_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_graph_runs"("run_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_graph_events" ADD CONSTRAINT "workflow_graph_events_run_id_workflow_graph_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_graph_runs"("run_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arforge_app') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE workflow_graph_runs, workflow_graph_nodes, workflow_graph_events TO arforge_app;
	END IF;
END
$$;
