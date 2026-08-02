CREATE TABLE "account_state" (
	"id" bigint PRIMARY KEY,
	"active_account_id" text,
	"active_org_id" text
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"url" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expiry" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_account" (
	"email" text,
	"url" text,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expiry" bigint,
	"active" boolean NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "control_account_pkey" PRIMARY KEY("email","url")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"branch" text,
	"directory" text,
	"extra" text,
	"project_id" text NOT NULL,
	"time_used" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" text PRIMARY KEY,
	"integration_id" text,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"connector_id" text,
	"method_id" text,
	"active" boolean,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_sequence" (
	"aggregate_id" text PRIMARY KEY,
	"seq" bigint NOT NULL,
	"owner_id" text
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" text PRIMARY KEY,
	"aggregate_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"data" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY,
	"category" text NOT NULL,
	"rating" bigint NOT NULL,
	"message" text NOT NULL,
	"session_id" text,
	"learning_outcome_id" text,
	"time_created" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"objective" text NOT NULL,
	"status" text NOT NULL,
	"queue_position" bigint DEFAULT 0 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"prompt_id" text,
	"last_error" text DEFAULT '' NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"time_started" bigint,
	"time_finished" bigint
);
--> statement-breakpoint
CREATE TABLE "learning_outcome_pattern" (
	"outcome_id" text,
	"pattern_id" text,
	CONSTRAINT "learning_outcome_pattern_pkey" PRIMARY KEY("outcome_id","pattern_id")
);
--> statement-breakpoint
CREATE TABLE "learning_outcome" (
	"id" text PRIMARY KEY,
	"session_id" text,
	"project_id" text NOT NULL,
	"workspace_path" text NOT NULL,
	"turn_index" bigint DEFAULT 0 NOT NULL,
	"user_input" text NOT NULL,
	"intent" text DEFAULT 'general' NOT NULL,
	"route" text DEFAULT 'agentic' NOT NULL,
	"tools" text NOT NULL,
	"success" boolean NOT NULL,
	"error_type" text DEFAULT '' NOT NULL,
	"error_message" text DEFAULT '' NOT NULL,
	"user_feedback" text DEFAULT '' NOT NULL,
	"fix_strategy" text DEFAULT '' NOT NULL,
	"regression" boolean DEFAULT false NOT NULL,
	"token_count" bigint DEFAULT 0 NOT NULL,
	"response_time_ms" bigint DEFAULT 0 NOT NULL,
	"tags" text NOT NULL,
	"importance" bigint DEFAULT 1 NOT NULL,
	"injected_context_size" bigint DEFAULT 0 NOT NULL,
	"fingerprint" text,
	"time_created" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_pattern" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"workspace_path" text NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"frequency" bigint DEFAULT 1 NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"tags" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory" (
	"id" text PRIMARY KEY,
	"content" text NOT NULL,
	"type" text NOT NULL,
	"tags" text NOT NULL,
	"importance" bigint DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"scope" text NOT NULL,
	"project_id" text,
	"workspace_path" text,
	"related_to" text,
	"strength" double precision DEFAULT 0.5 NOT NULL,
	"review_level" bigint DEFAULT 0 NOT NULL,
	"time_reviewed" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_directory" (
	"project_id" text,
	"directory" text,
	"type" text,
	"strategy" text,
	"time_created" bigint NOT NULL,
	CONSTRAINT "project_directory_pkey" PRIMARY KEY("project_id","directory")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY,
	"worktree" text NOT NULL,
	"vcs" text,
	"name" text,
	"icon_url" text,
	"icon_url_override" text,
	"icon_color" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"time_initialized" bigint,
	"sandboxes" text NOT NULL,
	"commands" text
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"data" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "part" (
	"id" text PRIMARY KEY,
	"message_id" text NOT NULL,
	"session_id" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"data" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_prompt" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"prompt" text NOT NULL,
	"recurring" boolean NOT NULL,
	"durable" boolean NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"next_run" bigint,
	"last_run" bigint,
	"expires" bigint NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"lease_owner" text,
	"lease_until" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_checkpoint" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"label" text NOT NULL,
	"sequence" bigint NOT NULL,
	"message_id" text,
	"time_created" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_context_epoch" (
	"session_id" text PRIMARY KEY,
	"baseline" text NOT NULL,
	"snapshot" text NOT NULL,
	"baseline_seq" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_input" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"prompt" text NOT NULL,
	"delivery" text NOT NULL,
	"admitted_seq" bigint NOT NULL,
	"promoted_seq" bigint,
	"time_created" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_message" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"seq" bigint NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"time_rewound" bigint,
	"data" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"workspace_id" text,
	"parent_id" text,
	"slug" text NOT NULL,
	"directory" text NOT NULL,
	"path" text,
	"title" text NOT NULL,
	"version" text NOT NULL,
	"share_url" text,
	"summary_additions" bigint,
	"summary_deletions" bigint,
	"summary_files" bigint,
	"summary_diffs" text,
	"metadata" text,
	"cost" double precision DEFAULT 0 NOT NULL,
	"tokens_input" bigint DEFAULT 0 NOT NULL,
	"tokens_output" bigint DEFAULT 0 NOT NULL,
	"tokens_reasoning" bigint DEFAULT 0 NOT NULL,
	"tokens_cache_read" bigint DEFAULT 0 NOT NULL,
	"tokens_cache_write" bigint DEFAULT 0 NOT NULL,
	"revert" text,
	"permission" text,
	"agent" text,
	"model" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"time_compacting" bigint,
	"time_archived" bigint
);
--> statement-breakpoint
CREATE TABLE "session_tag" (
	"session_id" text,
	"normalized" text,
	"value" text NOT NULL,
	"position" bigint NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "session_tag_pkey" PRIMARY KEY("session_id","normalized")
);
--> statement-breakpoint
CREATE TABLE "todo" (
	"session_id" text,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"priority" text NOT NULL,
	"position" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "todo_pkey" PRIMARY KEY("session_id","position")
);
--> statement-breakpoint
CREATE TABLE "session_share" (
	"session_id" text PRIMARY KEY,
	"id" text NOT NULL,
	"secret" text NOT NULL,
	"url" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_graph_edge" (
	"session_id" text NOT NULL,
	"blocker_id" text,
	"blocked_id" text,
	"time_created" bigint NOT NULL,
	CONSTRAINT "task_graph_edge_pkey" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "task_graph_task" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"active_form" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"owner" text,
	"metadata" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"time_completed" bigint
);
--> statement-breakpoint
CREATE TABLE "team_member" (
	"team_id" text,
	"name_key" text,
	"name" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"time_joined" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "team_member_pkey" PRIMARY KEY("team_id","name_key")
);
--> statement-breakpoint
CREATE TABLE "team_message" (
	"id" text PRIMARY KEY,
	"team_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"recipients" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"message" text NOT NULL,
	"shutdown_id" text,
	"approve" boolean,
	"time_created" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_shutdown" (
	"id" text PRIMARY KEY,
	"team_id" text NOT NULL,
	"member_key" text NOT NULL,
	"member" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"response_reason" text DEFAULT '' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"time_requested" bigint NOT NULL,
	"time_responded" bigint
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_migration" (
	"name" text PRIMARY KEY,
	"time_completed" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_aggregate_seq_idx" ON "event" ("aggregate_id","seq");--> statement-breakpoint
CREATE INDEX "event_aggregate_type_seq_idx" ON "event" ("aggregate_id","type","seq");--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" ("time_created");--> statement-breakpoint
CREATE INDEX "feedback_category_created_idx" ON "feedback" ("category","time_created");--> statement-breakpoint
CREATE INDEX "goal_session_status_queue_idx" ON "goal" ("session_id","status","queue_position");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_session_active_idx" ON "goal" ("session_id") WHERE "status" in ('active', 'running', 'paused', 'blocked');--> statement-breakpoint
CREATE INDEX "learning_outcome_pattern_outcome_idx" ON "learning_outcome_pattern" ("outcome_id");--> statement-breakpoint
CREATE INDEX "learning_outcome_session_created_idx" ON "learning_outcome" ("session_id","time_created");--> statement-breakpoint
CREATE INDEX "learning_outcome_workspace_created_idx" ON "learning_outcome" ("project_id","workspace_path","time_created");--> statement-breakpoint
CREATE INDEX "learning_outcome_success_created_idx" ON "learning_outcome" ("success","time_created");--> statement-breakpoint
CREATE INDEX "learning_outcome_fingerprint_idx" ON "learning_outcome" ("fingerprint");--> statement-breakpoint
CREATE INDEX "learning_pattern_type_frequency_idx" ON "learning_pattern" ("project_id","workspace_path","type","frequency");--> statement-breakpoint
CREATE INDEX "learning_pattern_updated_idx" ON "learning_pattern" ("time_updated");--> statement-breakpoint
CREATE INDEX "memory_scope_workspace_idx" ON "memory" ("scope","project_id","workspace_path");--> statement-breakpoint
CREATE INDEX "memory_source_idx" ON "memory" ("source");--> statement-breakpoint
CREATE INDEX "memory_type_importance_idx" ON "memory" ("type","importance");--> statement-breakpoint
CREATE INDEX "memory_updated_idx" ON "memory" ("time_updated");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_project_action_resource_idx" ON "permission" ("project_id","action","resource");--> statement-breakpoint
CREATE INDEX "message_session_time_created_id_idx" ON "message" ("session_id","time_created","id");--> statement-breakpoint
CREATE INDEX "part_message_id_id_idx" ON "part" ("message_id","id");--> statement-breakpoint
CREATE INDEX "part_session_idx" ON "part" ("session_id");--> statement-breakpoint
CREATE INDEX "scheduled_prompt_session_created_idx" ON "scheduled_prompt" ("session_id","time_created");--> statement-breakpoint
CREATE INDEX "scheduled_prompt_due_idx" ON "scheduled_prompt" ("enabled","status","next_run");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_prompt_session_name_idx" ON "scheduled_prompt" ("session_id","name");--> statement-breakpoint
CREATE INDEX "session_checkpoint_session_created_idx" ON "session_checkpoint" ("session_id","time_created");--> statement-breakpoint
CREATE INDEX "session_checkpoint_session_sequence_idx" ON "session_checkpoint" ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "session_input_session_pending_delivery_seq_idx" ON "session_input" ("session_id","promoted_seq","delivery","admitted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_input_session_admitted_seq_idx" ON "session_input" ("session_id","admitted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_input_session_promoted_seq_idx" ON "session_input" ("session_id","promoted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_message_session_seq_idx" ON "session_message" ("session_id","seq");--> statement-breakpoint
CREATE INDEX "session_message_session_type_seq_idx" ON "session_message" ("session_id","type","seq");--> statement-breakpoint
CREATE INDEX "session_message_session_time_created_id_idx" ON "session_message" ("session_id","time_created","id");--> statement-breakpoint
CREATE INDEX "session_message_time_created_idx" ON "session_message" ("time_created");--> statement-breakpoint
CREATE INDEX "session_project_idx" ON "session" ("project_id");--> statement-breakpoint
CREATE INDEX "session_workspace_idx" ON "session" ("workspace_id");--> statement-breakpoint
CREATE INDEX "session_parent_idx" ON "session" ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_tag_session_position_idx" ON "session_tag" ("session_id","position");--> statement-breakpoint
CREATE INDEX "session_tag_normalized_idx" ON "session_tag" ("normalized");--> statement-breakpoint
CREATE INDEX "todo_session_idx" ON "todo" ("session_id");--> statement-breakpoint
CREATE INDEX "task_graph_edge_session_blocked_idx" ON "task_graph_edge" ("session_id","blocked_id");--> statement-breakpoint
CREATE INDEX "task_graph_edge_session_blocker_idx" ON "task_graph_edge" ("session_id","blocker_id");--> statement-breakpoint
CREATE INDEX "task_graph_session_status_created_idx" ON "task_graph_task" ("session_id","status","time_created");--> statement-breakpoint
CREATE INDEX "task_graph_session_owner_status_idx" ON "task_graph_task" ("session_id","owner","status");--> statement-breakpoint
CREATE UNIQUE INDEX "task_graph_session_title_idx" ON "task_graph_task" ("session_id","title");--> statement-breakpoint
CREATE UNIQUE INDEX "team_member_agent_idx" ON "team_member" ("team_id","agent_id");--> statement-breakpoint
CREATE INDEX "team_member_status_idx" ON "team_member" ("team_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "team_message_sequence_idx" ON "team_message" ("team_id","sequence");--> statement-breakpoint
CREATE INDEX "team_message_created_idx" ON "team_message" ("team_id","time_created");--> statement-breakpoint
CREATE INDEX "team_shutdown_member_status_idx" ON "team_shutdown" ("team_id","member_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "team_session_idx" ON "team" ("session_id");--> statement-breakpoint
ALTER TABLE "account_state" ADD CONSTRAINT "account_state_active_account_id_account_id_fkey" FOREIGN KEY ("active_account_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_aggregate_id_event_sequence_aggregate_id_fkey" FOREIGN KEY ("aggregate_id") REFERENCES "event_sequence"("aggregate_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_learning_outcome_id_learning_outcome_id_fkey" FOREIGN KEY ("learning_outcome_id") REFERENCES "learning_outcome"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_outcome_pattern" ADD CONSTRAINT "learning_outcome_pattern_outcome_id_learning_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "learning_outcome"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_outcome_pattern" ADD CONSTRAINT "learning_outcome_pattern_pattern_id_learning_pattern_id_fkey" FOREIGN KEY ("pattern_id") REFERENCES "learning_pattern"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_outcome" ADD CONSTRAINT "learning_outcome_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "permission" ADD CONSTRAINT "permission_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_directory" ADD CONSTRAINT "project_directory_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "part" ADD CONSTRAINT "part_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scheduled_prompt" ADD CONSTRAINT "scheduled_prompt_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_checkpoint" ADD CONSTRAINT "session_checkpoint_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_checkpoint" ADD CONSTRAINT "session_checkpoint_message_id_session_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "session_message"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "session_context_epoch" ADD CONSTRAINT "session_context_epoch_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_input" ADD CONSTRAINT "session_input_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_message" ADD CONSTRAINT "session_message_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_tag" ADD CONSTRAINT "session_tag_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo" ADD CONSTRAINT "todo_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_share" ADD CONSTRAINT "session_share_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_graph_edge" ADD CONSTRAINT "task_graph_edge_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_graph_edge" ADD CONSTRAINT "task_graph_edge_blocker_id_task_graph_task_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "task_graph_task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_graph_edge" ADD CONSTRAINT "task_graph_edge_blocked_id_task_graph_task_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "task_graph_task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_graph_task" ADD CONSTRAINT "task_graph_task_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_message" ADD CONSTRAINT "team_message_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_shutdown" ADD CONSTRAINT "team_shutdown_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;