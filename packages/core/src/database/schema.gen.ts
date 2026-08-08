import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`feedback\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`category\` text NOT NULL,
          \`rating\` integer NOT NULL,
          \`message\` text NOT NULL,
          \`workspace_path\` text NOT NULL,
          \`session_id\` text,
          \`learning_outcome_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_feedback_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_feedback_learning_outcome_id_learning_outcome_id_fk\` FOREIGN KEY (\`learning_outcome_id\`) REFERENCES \`learning_outcome\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`status\` text NOT NULL,
          \`queue_position\` integer DEFAULT 0 NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`prompt_id\` text,
          \`last_error\` text DEFAULT '' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_started\` integer,
          \`time_finished\` integer,
          CONSTRAINT \`fk_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_rate_limit\` (
          \`bucket\` text NOT NULL,
          \`key_hash\` text NOT NULL,
          \`failures\` integer DEFAULT 0 NOT NULL,
          \`window_started_at\` integer NOT NULL,
          \`blocked_until\` integer DEFAULT 0 NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`identity_rate_limit_pk\` PRIMARY KEY(\`bucket\`, \`key_hash\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_session\` (
          \`id\` text PRIMARY KEY,
          \`user_id\` text NOT NULL,
          \`tenant_id\` text NOT NULL,
          \`token_hash\` text NOT NULL,
          \`session_epoch\` integer NOT NULL,
          \`user_agent_hash\` text DEFAULT '' NOT NULL,
          \`ip_hash\` text DEFAULT '' NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`idle_expires_at\` integer NOT NULL,
          \`last_seen_at\` integer NOT NULL,
          \`revoked_at\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_identity_session_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_identity_session_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_tenant_member\` (
          \`tenant_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`role\` text DEFAULT 'member' NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`identity_tenant_member_pk\` PRIMARY KEY(\`tenant_id\`, \`user_id\`),
          CONSTRAINT \`fk_identity_tenant_member_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_identity_tenant_member_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_tenant\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`slug\` text NOT NULL,
          \`created_by_user_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_identity_tenant_created_by_user_id_identity_user_id_fk\` FOREIGN KEY (\`created_by_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_token\` (
          \`id\` text PRIMARY KEY,
          \`user_id\` text NOT NULL,
          \`purpose\` text NOT NULL,
          \`token_hash\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`consumed_at\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_identity_token_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`identity_user\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`normalized_email\` text NOT NULL,
          \`display_name\` text DEFAULT '' NOT NULL,
          \`password_hash\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`email_verified_at\` integer,
          \`session_epoch\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`learning_outcome_pattern\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`outcome_id\` text NOT NULL,
          \`pattern_id\` text NOT NULL,
          CONSTRAINT \`learning_outcome_pattern_pk\` PRIMARY KEY(\`outcome_id\`, \`pattern_id\`),
          CONSTRAINT \`fk_learning_outcome_pattern_outcome_id_learning_outcome_id_fk\` FOREIGN KEY (\`outcome_id\`) REFERENCES \`learning_outcome\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_learning_outcome_pattern_pattern_id_learning_pattern_id_fk\` FOREIGN KEY (\`pattern_id\`) REFERENCES \`learning_pattern\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`learning_outcome\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`project_id\` text NOT NULL,
          \`workspace_path\` text NOT NULL,
          \`turn_index\` integer DEFAULT 0 NOT NULL,
          \`user_input\` text NOT NULL,
          \`intent\` text DEFAULT 'general' NOT NULL,
          \`route\` text DEFAULT 'agentic' NOT NULL,
          \`tools\` text NOT NULL,
          \`success\` integer NOT NULL,
          \`error_type\` text DEFAULT '' NOT NULL,
          \`error_message\` text DEFAULT '' NOT NULL,
          \`user_feedback\` text DEFAULT '' NOT NULL,
          \`fix_strategy\` text DEFAULT '' NOT NULL,
          \`regression\` integer DEFAULT false NOT NULL,
          \`token_count\` integer DEFAULT 0 NOT NULL,
          \`response_time_ms\` integer DEFAULT 0 NOT NULL,
          \`tags\` text NOT NULL,
          \`importance\` integer DEFAULT 1 NOT NULL,
          \`injected_context_size\` integer DEFAULT 0 NOT NULL,
          \`fingerprint\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_learning_outcome_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`learning_pattern\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_path\` text NOT NULL,
          \`type\` text NOT NULL,
          \`description\` text NOT NULL,
          \`frequency\` integer DEFAULT 1 NOT NULL,
          \`confidence\` real DEFAULT 0.5 NOT NULL,
          \`tags\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_conflict\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`signature\` text NOT NULL,
          \`conflict_key\` text NOT NULL,
          \`basis\` text NOT NULL,
          \`left_memory_id\` text NOT NULL,
          \`right_memory_id\` text NOT NULL,
          \`left_fingerprint\` text NOT NULL,
          \`right_fingerprint\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`chosen_memory_id\` text,
          \`retired_memory_id\` text,
          \`retired_original_source\` text,
          \`decision_reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_decided\` integer,
          \`time_undone\` integer,
          CONSTRAINT \`fk_memory_conflict_left_memory_id_memory_id_fk\` FOREIGN KEY (\`left_memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_conflict_right_memory_id_memory_id_fk\` FOREIGN KEY (\`right_memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_correction\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`original_memory_id\` text NOT NULL,
          \`successor_memory_id\` text NOT NULL,
          \`original_source\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_undone\` integer,
          CONSTRAINT \`fk_memory_correction_original_memory_id_memory_id_fk\` FOREIGN KEY (\`original_memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_correction_successor_memory_id_memory_id_fk\` FOREIGN KEY (\`successor_memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`content\` text NOT NULL,
          \`type\` text NOT NULL,
          \`tags\` text NOT NULL,
          \`importance\` integer DEFAULT 1 NOT NULL,
          \`source\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_path\` text,
          \`related_to\` text,
          \`strength\` real DEFAULT 0.5 NOT NULL,
          \`review_level\` integer DEFAULT 0 NOT NULL,
          \`time_reviewed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_prompt\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`cron\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`recurring\` integer NOT NULL,
          \`durable\` integer NOT NULL,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`status\` text DEFAULT 'scheduled' NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`next_run\` integer,
          \`last_run\` integer,
          \`expires\` integer NOT NULL,
          \`last_error\` text DEFAULT '' NOT NULL,
          \`lease_owner\` text,
          \`lease_until\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_scheduled_prompt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_checkpoint\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`message_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_checkpoint_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_checkpoint_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_rewound\` integer,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_tag\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`session_id\` text NOT NULL,
          \`normalized\` text NOT NULL,
          \`value\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_tag_pk\` PRIMARY KEY(\`session_id\`, \`normalized\`),
          CONSTRAINT \`fk_session_tag_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`task_graph_edge\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`session_id\` text NOT NULL,
          \`blocker_id\` text NOT NULL,
          \`blocked_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`task_graph_edge_pk\` PRIMARY KEY(\`blocker_id\`, \`blocked_id\`),
          CONSTRAINT \`fk_task_graph_edge_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_task_graph_edge_blocker_id_task_graph_task_id_fk\` FOREIGN KEY (\`blocker_id\`) REFERENCES \`task_graph_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_task_graph_edge_blocked_id_task_graph_task_id_fk\` FOREIGN KEY (\`blocked_id\`) REFERENCES \`task_graph_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`task_graph_task\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text DEFAULT '' NOT NULL,
          \`active_form\` text DEFAULT '' NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`owner\` text,
          \`metadata\` text NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_task_graph_task_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_member\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`team_id\` text NOT NULL,
          \`name_key\` text NOT NULL,
          \`name\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`time_joined\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`team_member_pk\` PRIMARY KEY(\`team_id\`, \`name_key\`),
          CONSTRAINT \`fk_team_member_team_id_team_id_fk\` FOREIGN KEY (\`team_id\`) REFERENCES \`team\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_message\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`team_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`sender\` text NOT NULL,
          \`recipient\` text NOT NULL,
          \`recipients\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`message\` text NOT NULL,
          \`shutdown_id\` text,
          \`approve\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_team_message_team_id_team_id_fk\` FOREIGN KEY (\`team_id\`) REFERENCES \`team\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_shutdown\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`team_id\` text NOT NULL,
          \`member_key\` text NOT NULL,
          \`member\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`reason\` text DEFAULT '' NOT NULL,
          \`response_reason\` text DEFAULT '' NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`time_requested\` integer NOT NULL,
          \`time_responded\` integer,
          CONSTRAINT \`fk_team_shutdown_team_id_team_id_fk\` FOREIGN KEY (\`team_id\`) REFERENCES \`team\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text DEFAULT '' NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`next_sequence\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_graph_events\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`run_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`event_type\` text NOT NULL,
          \`node_id\` text DEFAULT '' NOT NULL,
          \`data_json\` text NOT NULL,
          \`created_at\` text NOT NULL,
          CONSTRAINT \`workflow_graph_events_pk\` PRIMARY KEY(\`run_id\`, \`sequence\`),
          CONSTRAINT \`fk_workflow_graph_events_run_id_workflow_graph_runs_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`workflow_graph_runs\`(\`run_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_graph_nodes\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`run_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`title\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`access\` text DEFAULT 'write' NOT NULL,
          \`status\` text NOT NULL,
          \`attempt\` integer DEFAULT 0 NOT NULL,
          \`max_attempts\` integer DEFAULT 1 NOT NULL,
          \`depends_on_json\` text NOT NULL,
          \`continue_on_error\` integer DEFAULT false NOT NULL,
          \`when_step\` text DEFAULT '' NOT NULL,
          \`when_statuses_json\` text DEFAULT '[]' NOT NULL,
          \`output\` text DEFAULT '' NOT NULL,
          \`error\` text DEFAULT '' NOT NULL,
          \`started_at\` text,
          \`finished_at\` text,
          CONSTRAINT \`workflow_graph_nodes_pk\` PRIMARY KEY(\`run_id\`, \`node_id\`),
          CONSTRAINT \`fk_workflow_graph_nodes_run_id_workflow_graph_runs_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`workflow_graph_runs\`(\`run_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_graph_runs\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`run_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text NOT NULL,
          \`source_path\` text NOT NULL,
          \`workspace\` text NOT NULL,
          \`definition_json\` text NOT NULL,
          \`permission_mode\` text NOT NULL,
          \`status\` text NOT NULL,
          \`control\` text DEFAULT '' NOT NULL,
          \`max_parallel\` integer NOT NULL,
          \`created_at\` text NOT NULL,
          \`updated_at\` text NOT NULL,
          \`started_at\` text,
          \`finished_at\` text,
          \`last_error\` text DEFAULT '' NOT NULL,
          \`lease_owner\` text DEFAULT '' NOT NULL,
          \`lease_expires_at\` text
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE INDEX \`feedback_workspace_created_idx\` ON \`feedback\` (\`workspace_path\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`feedback_workspace_category_created_idx\` ON \`feedback\` (\`workspace_path\`,\`category\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`feedback_created_idx\` ON \`feedback\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`feedback_category_created_idx\` ON \`feedback\` (\`category\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`goal_session_status_queue_idx\` ON \`goal\` (\`session_id\`,\`status\`,\`queue_position\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`goal_session_active_idx\` ON \`goal\` (\`session_id\`) WHERE "goal"."status" in ('active', 'running', 'paused', 'blocked');`,
      )
      yield* tx.run(`CREATE INDEX \`identity_rate_limit_expiry_idx\` ON \`identity_rate_limit\` (\`blocked_until\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`identity_session_token_hash_idx\` ON \`identity_session\` (\`token_hash\`);`)
      yield* tx.run(
        `CREATE INDEX \`identity_session_user_active_idx\` ON \`identity_session\` (\`user_id\`,\`revoked_at\`,\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`identity_session_tenant_idx\` ON \`identity_session\` (\`tenant_id\`,\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`identity_tenant_member_user_idx\` ON \`identity_tenant_member\` (\`user_id\`,\`status\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`identity_tenant_slug_idx\` ON \`identity_tenant\` (\`slug\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`identity_token_hash_idx\` ON \`identity_token\` (\`token_hash\`);`)
      yield* tx.run(
        `CREATE INDEX \`identity_token_user_purpose_idx\` ON \`identity_token\` (\`user_id\`,\`purpose\`,\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`identity_user_normalized_email_idx\` ON \`identity_user\` (\`normalized_email\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`learning_outcome_pattern_outcome_idx\` ON \`learning_outcome_pattern\` (\`outcome_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`learning_outcome_session_created_idx\` ON \`learning_outcome\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`learning_outcome_workspace_created_idx\` ON \`learning_outcome\` (\`project_id\`,\`workspace_path\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`learning_outcome_success_created_idx\` ON \`learning_outcome\` (\`success\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`learning_outcome_fingerprint_idx\` ON \`learning_outcome\` (\`fingerprint\`);`)
      yield* tx.run(
        `CREATE INDEX \`learning_pattern_type_frequency_idx\` ON \`learning_pattern\` (\`project_id\`,\`workspace_path\`,\`type\`,\`frequency\`);`,
      )
      yield* tx.run(`CREATE INDEX \`learning_pattern_updated_idx\` ON \`learning_pattern\` (\`time_updated\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_conflict_signature_idx\` ON \`memory_conflict\` (\`signature\`);`)
      yield* tx.run(`CREATE INDEX \`memory_conflict_status_idx\` ON \`memory_conflict\` (\`status\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_conflict_left_idx\` ON \`memory_conflict\` (\`left_memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_conflict_right_idx\` ON \`memory_conflict\` (\`right_memory_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_correction_original_idx\` ON \`memory_correction\` (\`original_memory_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_correction_successor_idx\` ON \`memory_correction\` (\`successor_memory_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_correction_status_idx\` ON \`memory_correction\` (\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_scope_workspace_idx\` ON \`memory\` (\`scope\`,\`project_id\`,\`workspace_path\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_source_idx\` ON \`memory\` (\`source\`);`)
      yield* tx.run(`CREATE INDEX \`memory_type_importance_idx\` ON \`memory\` (\`type\`,\`importance\`);`)
      yield* tx.run(`CREATE INDEX \`memory_updated_idx\` ON \`memory\` (\`time_updated\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`scheduled_prompt_session_created_idx\` ON \`scheduled_prompt\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_prompt_due_idx\` ON \`scheduled_prompt\` (\`enabled\`,\`status\`,\`next_run\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_prompt_session_name_idx\` ON \`scheduled_prompt\` (\`session_id\`,\`name\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_checkpoint_session_created_idx\` ON \`session_checkpoint\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_checkpoint_session_sequence_idx\` ON \`session_checkpoint\` (\`session_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_tag_session_position_idx\` ON \`session_tag\` (\`session_id\`,\`position\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_tag_normalized_idx\` ON \`session_tag\` (\`normalized\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`task_graph_edge_session_blocked_idx\` ON \`task_graph_edge\` (\`session_id\`,\`blocked_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`task_graph_edge_session_blocker_idx\` ON \`task_graph_edge\` (\`session_id\`,\`blocker_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`task_graph_session_status_created_idx\` ON \`task_graph_task\` (\`session_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`task_graph_session_owner_status_idx\` ON \`task_graph_task\` (\`session_id\`,\`owner\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`task_graph_session_title_idx\` ON \`task_graph_task\` (\`session_id\`,\`title\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`team_member_agent_idx\` ON \`team_member\` (\`team_id\`,\`agent_id\`);`)
      yield* tx.run(`CREATE INDEX \`team_member_status_idx\` ON \`team_member\` (\`team_id\`,\`status\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_message_sequence_idx\` ON \`team_message\` (\`team_id\`,\`sequence\`);`)
      yield* tx.run(`CREATE INDEX \`team_message_created_idx\` ON \`team_message\` (\`team_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`team_shutdown_member_status_idx\` ON \`team_shutdown\` (\`team_id\`,\`member_key\`,\`status\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`team_session_idx\` ON \`team\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`workflow_graph_event_run_created_idx\` ON \`workflow_graph_events\` (\`run_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_graph_node_run_position_idx\` ON \`workflow_graph_nodes\` (\`run_id\`,\`position\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_graph_node_run_status_idx\` ON \`workflow_graph_nodes\` (\`run_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_graph_run_session_updated_idx\` ON \`workflow_graph_runs\` (\`session_id\`,\`updated_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_graph_run_status_lease_idx\` ON \`workflow_graph_runs\` (\`status\`,\`lease_expires_at\`);`,
      )
      yield* tx.run(
        `CREATE TABLE \`audit_entry\` (\`tenant_id\` text DEFAULT 'ten_local' NOT NULL, \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL, \`id\` text PRIMARY KEY, \`seq\` integer NOT NULL, \`recorded_at\` integer NOT NULL, \`actor\` text NOT NULL, \`action\` text NOT NULL, \`resource\` text NOT NULL, \`reason\` text, \`metadata\` text, \`previous_hash\` text NOT NULL, \`record_hash\` text NOT NULL);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`audit_entry_seq_idx\` ON \`audit_entry\` (\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`audit_entry_action_idx\` ON \`audit_entry\` (\`action\`,\`recorded_at\`);`)
      yield* tx.run(`CREATE INDEX \`audit_entry_actor_idx\` ON \`audit_entry\` (\`actor\`,\`recorded_at\`);`)
      yield* tx.run(
        `CREATE TABLE \`session_run\` (\`tenant_id\` text DEFAULT 'ten_local' NOT NULL, \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL, \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`status\` text NOT NULL, \`started_at\` integer NOT NULL, \`finished_at\` integer, \`last_seq\` integer, \`error\` text);`,
      )
      yield* tx.run(`CREATE INDEX \`session_run_session_idx\` ON \`session_run\` (\`session_id\`,\`started_at\`);`)
      yield* tx.run(`CREATE INDEX \`session_run_status_idx\` ON \`session_run\` (\`status\`,\`started_at\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
