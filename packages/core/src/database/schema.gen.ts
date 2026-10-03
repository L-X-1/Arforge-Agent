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
        CREATE TABLE \`control_run_claim\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`binding_digest\` text NOT NULL,
          \`base_binding_digest\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`operation_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`control_plane_id\` text NOT NULL,
          \`location\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`canonical_request_id\` text NOT NULL,
          \`claim_digest\` text NOT NULL,
          \`canonical_authorization_digest\` text NOT NULL,
          \`canonical_action_id\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`input_digest\` text NOT NULL,
          \`payload_digest\` text NOT NULL,
          \`created_run_digest\` text NOT NULL,
          \`created_sequence\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`control_run_claim_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`binding_digest\`),
          CONSTRAINT "control_run_claim_generation_check" CHECK("generation" >= 0),
          CONSTRAINT "control_run_claim_created_sequence_check" CHECK("created_sequence" = 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_run_request_alias\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`alias_digest\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`control_plane_id\` text NOT NULL,
          \`binding_digest\` text NOT NULL,
          \`presented_authorization_digest\` text NOT NULL,
          \`presented_action_id\` text NOT NULL,
          \`presented_snapshot_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`control_run_request_alias_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`alias_digest\`),
          CONSTRAINT \`control_run_request_alias_claim_fk\` FOREIGN KEY (\`tenant_id\`,\`owner_user_id\`,\`binding_digest\`) REFERENCES \`control_run_claim\`(\`tenant_id\`,\`owner_user_id\`,\`binding_digest\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`artifact_maintenance_lease\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`lease_id\` text PRIMARY KEY,
          \`scan_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`acquired_at\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`released_at\` integer,
          CONSTRAINT \`fk_artifact_maintenance_lease_scan_id_artifact_maintenance_scan_id_fk\` FOREIGN KEY (\`scan_id\`) REFERENCES \`artifact_maintenance_scan\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`artifact_maintenance_scan_page\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`scan_id\` text NOT NULL,
          \`page_number\` integer NOT NULL,
          \`cursor_before\` text,
          \`cursor_after\` text,
          \`scanned_actions\` integer NOT NULL,
          \`referenced_count\` integer NOT NULL,
          \`audit\` text NOT NULL,
          \`page_digest\` text NOT NULL,
          \`recorded_at\` integer NOT NULL,
          CONSTRAINT \`artifact_maintenance_scan_page_pk\` PRIMARY KEY(\`scan_id\`, \`page_number\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`artifact_maintenance_scan\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`status\` text NOT NULL,
          \`scan_limit\` integer NOT NULL,
          \`start_cursor\` text,
          \`cursor\` text,
          \`page_count\` integer DEFAULT 0 NOT NULL,
          \`scanned_actions\` integer DEFAULT 0 NOT NULL,
          \`referenced_count\` integer DEFAULT 0 NOT NULL,
          \`session_digest\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`completed_at\` integer,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`child_settlement_recovery_outbox\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`intent_id\` text NOT NULL,
          \`parent_run_id\` text NOT NULL,
          \`child_run_id\` text NOT NULL,
          \`commit_digest\` text NOT NULL,
          \`mode\` text DEFAULT 'recovery-outbox' NOT NULL,
          \`status\` text NOT NULL,
          \`owner_order\` text NOT NULL,
          \`expected_digests\` text NOT NULL,
          \`reason\` text DEFAULT '' NOT NULL,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`receipt_digest\` text NOT NULL,
          \`owner_progress\` text,
          CONSTRAINT \`child_settlement_recovery_outbox_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`intent_id\`),
          CONSTRAINT "child_settlement_recovery_outbox_mode_check" CHECK("mode" = 'recovery-outbox'),
          CONSTRAINT "child_settlement_recovery_outbox_status_check" CHECK("status" IN ('prepared', 'committed', 'recovery-required')),
          CONSTRAINT "child_settlement_recovery_outbox_revision_check" CHECK("revision" >= 0)
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
          \`encrypted_value\` text,
          \`value_key_version\` integer,
          \`value_fingerprint\` text,
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
        CREATE TABLE \`evolution_artifact\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`digest\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`uri\` text NOT NULL,
          \`byte_length\` integer NOT NULL,
          \`content\` text NOT NULL,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_artifact_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`digest\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_audit\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`action\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`metadata\` text NOT NULL,
          \`previous_hash\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_audit_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`aggregate_id\`, \`sequence\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_evaluation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`proposal_id\` text NOT NULL,
          \`candidate_digest\` text NOT NULL,
          \`report_digest\` text NOT NULL,
          \`report\` text NOT NULL,
          \`run_id\` text,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_evaluation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_exposure\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`ticket_digest\` text NOT NULL,
          \`ticket\` text NOT NULL,
          \`status\` text NOT NULL,
          \`outcome_input_digest\` text,
          \`receipt_digest\` text,
          \`receipt\` text,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_exposure_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_lease\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`lease_id\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_lease_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`aggregate_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_observation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`proposal_id\` text NOT NULL,
          \`candidate_digest\` text NOT NULL,
          \`cohort\` text NOT NULL,
          \`success\` integer NOT NULL,
          \`score\` real NOT NULL,
          \`safety_incident\` integer NOT NULL,
          \`evidence_ref\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_observation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_proposal\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`artifact_digest\` text NOT NULL,
          \`artifact_ref\` text NOT NULL,
          \`manifest\` text NOT NULL,
          \`state\` text NOT NULL,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`evaluation_id\` text,
          \`control_run_id\` text,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_proposal_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_graph_relation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`source_kind\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`source_digest\` text NOT NULL,
          \`target_kind\` text NOT NULL,
          \`target_id\` text NOT NULL,
          \`target_digest\` text NOT NULL,
          \`relation_kind\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_audit\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`action\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`metadata\` text NOT NULL,
          \`previous_hash\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_audit_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`aggregate_id\`, \`sequence\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_candidate\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`problem_signature\` text NOT NULL,
          \`applicable_scope\` text NOT NULL,
          \`conditions\` text NOT NULL,
          \`attempted_strategy\` text NOT NULL,
          \`counterexamples\` text NOT NULL,
          \`support_count\` integer NOT NULL,
          \`source_run_ids\` text NOT NULL,
          \`source_support_ids\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`evaluation_digest\` text,
          \`review_actor\` text,
          \`review_reason\` text,
          \`review_status\` text NOT NULL,
          \`status\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`expiry_at\` integer,
          \`digest\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_candidate_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_evaluation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`evaluation_digest\` text NOT NULL,
          \`comparison\` text NOT NULL,
          \`passed\` integer NOT NULL,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_evaluation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_evidence\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`action_id\` text NOT NULL,
          \`observation_id\` text NOT NULL,
          \`record_digest\` text NOT NULL,
          \`record\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_evidence_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_record\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`support_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`action_id\` text NOT NULL,
          \`evaluation_id\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`record_digest\` text NOT NULL,
          \`record\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`promoted_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_record_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_support\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`action_id\` text NOT NULL,
          \`evaluation_id\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`support_digest\` text NOT NULL,
          \`learning_outcome_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_support_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
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
          \`run_id\` text,
          \`action_id\` text,
          \`evaluation_id\` text,
          \`evidence_ids\` text,
          \`terminal\` integer,
          \`verifier_passed\` integer,
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
        CREATE TABLE \`mailbox_message\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`protocol_version\` integer DEFAULT 1 NOT NULL,
          \`team_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`sender\` text NOT NULL,
          \`recipient\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`message\` text NOT NULL,
          \`artifact_refs\` text NOT NULL,
          \`evidence_refs\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`status\` text DEFAULT 'queued' NOT NULL,
          \`cancel_reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`mailbox_message_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`),
          CONSTRAINT \`fk_mailbox_message_team_id_team_id_fk\` FOREIGN KEY (\`team_id\`) REFERENCES \`team\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_mailbox_message_task_id_task_graph_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`task_graph_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`mailbox_receipt\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`protocol_version\` integer DEFAULT 1 NOT NULL,
          \`message_id\` text NOT NULL,
          \`team_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`recipient\` text NOT NULL,
          \`status\` text NOT NULL,
          \`message_digest\` text NOT NULL,
          \`reason\` text DEFAULT '' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`mailbox_receipt_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`),
          CONSTRAINT \`mailbox_receipt_message_fk\` FOREIGN KEY (\`tenant_id\`,\`owner_user_id\`,\`message_id\`) REFERENCES \`mailbox_message\`(\`tenant_id\`,\`owner_user_id\`,\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_candidate_audit\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`candidate_id\` text NOT NULL,
          \`operation\` text NOT NULL,
          \`actor_kind\` text NOT NULL,
          \`principal_ref\` text,
          \`reason\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`status_from\` text,
          \`status_to\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_candidate_audit_candidate_id_memory_candidate_id_fk\` FOREIGN KEY (\`candidate_id\`) REFERENCES \`memory_candidate\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_candidate\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`proposed_class\` text NOT NULL,
          \`content\` text NOT NULL,
          \`source_evidence_ids\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_path\` text,
          \`sensitivity\` text NOT NULL,
          \`confidence\` real NOT NULL,
          \`dedup_status\` text NOT NULL,
          \`dedup_compared_memory_ids\` text NOT NULL,
          \`dedup_similarity\` real,
          \`retention_mode\` text NOT NULL,
          \`retention_expires_at\` integer,
          \`retention_reason\` text NOT NULL,
          \`proposer_kind\` text NOT NULL,
          \`principal_ref\` text,
          \`run_id\` text,
          \`policy_status\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`policy_reason\` text NOT NULL,
          \`status\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_expires\` integer
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
        CREATE TABLE \`memory_revision\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`memory_id\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`operation\` text NOT NULL,
          \`actor_kind\` text NOT NULL,
          \`principal_ref\` text,
          \`run_id\` text,
          \`reason\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`prior_digest\` text,
          \`content_digest\` text NOT NULL,
          \`successor_memory_id\` text,
          \`candidate_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_revision_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_revision_successor_memory_id_memory_id_fk\` FOREIGN KEY (\`successor_memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_memory_revision_candidate_id_memory_candidate_id_fk\` FOREIGN KEY (\`candidate_id\`) REFERENCES \`memory_candidate\`(\`id\`) ON DELETE SET NULL
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
          \`memory_class\` text,
          \`lifecycle\` text DEFAULT 'active' NOT NULL,
          \`memory_version\` integer DEFAULT 1 NOT NULL,
          \`provenance_status\` text DEFAULT 'legacy_unknown' NOT NULL,
          \`content_digest\` text,
          \`retention_mode\` text DEFAULT 'indefinite' NOT NULL,
          \`retention_expires_at\` integer,
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
        CREATE TABLE \`audit_entry\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`recorded_at\` integer NOT NULL,
          \`actor\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`reason\` text,
          \`metadata\` text,
          \`previous_hash\` text NOT NULL,
          \`record_hash\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evaluation_result\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`suite_id\` text NOT NULL,
          \`suite_revision\` integer NOT NULL,
          \`case_id\` text NOT NULL,
          \`case_revision\` integer NOT NULL,
          \`baseline_artifact_digest\` text NOT NULL,
          \`candidate_artifact_digest\` text NOT NULL,
          \`environment_digest\` text NOT NULL,
          \`toolchain_digest\` text NOT NULL,
          \`sample_size\` integer NOT NULL,
          \`score\` real NOT NULL,
          \`success_delta\` real NOT NULL,
          \`cost_delta\` real NOT NULL,
          \`latency_delta\` real NOT NULL,
          \`passed\` integer NOT NULL,
          \`metrics\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`provider_id\` text,
          \`model_id\` text,
          \`input_tokens\` integer,
          \`output_tokens\` integer,
          \`cost_minor\` integer,
          \`currency\` text,
          \`reviewer_id\` text,
          \`approval_status\` text DEFAULT 'pending' NOT NULL,
          \`approval_reason\` text,
          \`created_at\` integer NOT NULL,
          \`evaluated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_run\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`finished_at\` integer,
          \`last_seq\` integer,
          \`error\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_run_usage\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`usage_source\` text NOT NULL,
          \`estimator_id\` text,
          \`unknown_input\` integer NOT NULL,
          \`image_input\` integer NOT NULL,
          \`audio_input\` integer NOT NULL,
          \`cache_read_input\` integer NOT NULL,
          \`cache_write_input\` integer NOT NULL,
          \`text_output\` integer NOT NULL,
          \`reasoning_output\` integer NOT NULL,
          \`audio_output\` integer NOT NULL,
          \`price_catalog_revision\` text,
          \`currency\` text,
          \`amount_minor\` integer,
          \`unpriced_categories\` text NOT NULL,
          \`settlement_reservation_id\` text,
          \`billing_receipt\` text,
          \`over_budget\` integer DEFAULT false NOT NULL,
          \`recorded_at\` integer NOT NULL
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
        CREATE TABLE \`session_compaction_checkpoint\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`session_id\` text NOT NULL,
          \`operation_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`phase\` text NOT NULL,
          \`checkpoint\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_compaction_checkpoint_pk\` PRIMARY KEY(\`session_id\`, \`operation_id\`, \`sequence\`),
          CONSTRAINT \`fk_session_compaction_checkpoint_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
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
        CREATE TABLE \`self_hosted_share_publication\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`publication_id\` text NOT NULL,
          \`operation_id\` text NOT NULL,
          \`operation_digest\` text NOT NULL,
          \`provider_receipt_id\` text NOT NULL,
          \`publication_url\` text NOT NULL,
          \`export_digest\` text NOT NULL,
          \`frozen_export\` text NOT NULL,
          \`target_base_url\` text NOT NULL,
          \`visibility\` text NOT NULL,
          \`organization_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`self_hosted_share_publication_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`publication_id\`),
          CONSTRAINT "self_hosted_share_publication_visibility_check" CHECK("visibility" IN ('private', 'organization', 'public'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`self_hosted_share_revocation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`operation_id\` text NOT NULL,
          \`operation_digest\` text NOT NULL,
          \`publication_id\` text NOT NULL,
          \`original_digest\` text NOT NULL,
          \`target_base_url\` text NOT NULL,
          \`visibility\` text NOT NULL,
          \`organization_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`self_hosted_share_revocation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`operation_id\`),
          CONSTRAINT "self_hosted_share_revocation_visibility_check" CHECK("visibility" IN ('private', 'organization', 'public'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share_operation_receipt\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`operation_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`action_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`snapshot_digest\` text NOT NULL,
          \`export_digest\` text NOT NULL,
          \`target_base_url\` text NOT NULL,
          \`visibility\` text NOT NULL,
          \`organization_id\` text,
          \`provider_receipt_id\` text,
          \`publication_id\` text NOT NULL,
          \`publication_url\` text NOT NULL,
          \`stored_digest\` text,
          \`removed_digest\` text,
          \`response_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_share_operation_receipt_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`operation_id\`),
          CONSTRAINT \`fk_session_share_operation_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT "session_share_operation_receipt_kind_fields_check" CHECK("kind" = 'share' AND "provider_receipt_id" IS NOT NULL AND "stored_digest" IS NOT NULL AND "removed_digest" IS NULL OR "kind" = 'unshare' AND "provider_receipt_id" IS NULL AND "stored_digest" IS NULL AND "removed_digest" IS NOT NULL),
          CONSTRAINT "session_share_operation_receipt_visibility_check" CHECK("visibility" IN ('private', 'organization', 'public'))
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
        CREATE TABLE \`skill_audit\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`action\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`metadata\` text NOT NULL,
          \`previous_hash\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_audit_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`aggregate_id\`, \`sequence\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_canary_observation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`evaluation_id\` text NOT NULL,
          \`cohort_key_digest\` text NOT NULL,
          \`success\` integer NOT NULL,
          \`safety_incident\` integer NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`record_digest\` text NOT NULL,
          \`record\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_canary_observation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_deployment\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`skill_id\` text NOT NULL,
          \`active_candidate_id\` text NOT NULL,
          \`previous_candidate_id\` text,
          \`generation\` integer NOT NULL,
          \`deployment_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_deployment_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`skill_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_evaluation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`report_digest\` text NOT NULL,
          \`report\` text NOT NULL,
          \`passed\` integer NOT NULL,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_evaluation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_version\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`skill_id\` text NOT NULL,
          \`version\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`skill_record\` text NOT NULL,
          \`manifest\` text NOT NULL,
          \`artifact_files\` text NOT NULL,
          \`tests\` text NOT NULL,
          \`scan\` text NOT NULL,
          \`source_experience_ids\` text NOT NULL,
          \`source_evidence_ids\` text NOT NULL,
          \`evaluation_id\` text NOT NULL,
          \`evaluation_digest\` text,
          \`evaluation_passed\` integer,
          \`baseline_version_id\` text,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`policy_version\` text NOT NULL,
          \`created_by\` text NOT NULL,
          \`review_actor\` text,
          \`review_reason\` text,
          \`traffic_percent\` integer,
          \`canary_digest\` text,
          \`rollback_version\` text,
          \`record_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_version_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
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
        CREATE TABLE \`tenant_audit_export\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`id\` text PRIMARY KEY,
          \`requested_by\` text NOT NULL,
          \`item_count\` integer NOT NULL,
          \`export_digest\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_tenant_audit_export_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_audit_export_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_tenant_audit_export_requested_by_identity_user_id_fk\` FOREIGN KEY (\`requested_by\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tenant_backup_manifest\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`id\` text PRIMARY KEY,
          \`region\` text NOT NULL,
          \`schema_revision\` text NOT NULL,
          \`artifact_digest\` text NOT NULL,
          \`status\` text DEFAULT 'created' NOT NULL,
          \`created_at\` integer NOT NULL,
          \`verified_at\` integer,
          CONSTRAINT \`fk_tenant_backup_manifest_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_backup_manifest_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tenant_data_request\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`status\` text DEFAULT 'requested' NOT NULL,
          \`requested_by\` text NOT NULL,
          \`approved_by\` text,
          \`reason\` text DEFAULT '' NOT NULL,
          \`request_digest\` text NOT NULL,
          \`requested_at\` integer NOT NULL,
          \`completed_at\` integer,
          CONSTRAINT \`fk_tenant_data_request_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_data_request_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_tenant_data_request_requested_by_identity_user_id_fk\` FOREIGN KEY (\`requested_by\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_tenant_data_request_approved_by_identity_user_id_fk\` FOREIGN KEY (\`approved_by\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tenant_key\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`wrapped_key\` text NOT NULL,
          \`key_digest\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tenant_key_pk\` PRIMARY KEY(\`tenant_id\`, \`version\`),
          CONSTRAINT \`fk_tenant_key_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_key_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tenant_policy\` (
          \`tenant_id\` text PRIMARY KEY,
          \`owner_user_id\` text NOT NULL,
          \`region\` text DEFAULT 'self-hosted' NOT NULL,
          \`retention_days\` integer DEFAULT 365 NOT NULL,
          \`quota_currency\` text DEFAULT 'USD' NOT NULL,
          \`quota_limit_minor\` integer,
          \`rate_limit_per_minute\` integer DEFAULT 60 NOT NULL,
          \`rate_limit_burst\` integer DEFAULT 20 NOT NULL,
          \`key_version\` integer DEFAULT 1 NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_tenant_policy_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_policy_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tenant_project_member\` (
          \`tenant_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`role\` text DEFAULT 'viewer' NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tenant_project_member_pk\` PRIMARY KEY(\`project_id\`, \`user_id\`),
          CONSTRAINT \`fk_tenant_project_member_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_project_member_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_project_member_user_id_identity_user_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tenant_rate_window\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`bucket\` text NOT NULL,
          \`window_started_at\` integer NOT NULL,
          \`request_count\` integer DEFAULT 0 NOT NULL,
          \`byte_count\` integer DEFAULT 0 NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tenant_rate_window_pk\` PRIMARY KEY(\`tenant_id\`, \`bucket\`),
          CONSTRAINT \`fk_tenant_rate_window_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_rate_window_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tenant_secret\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`secret_id\` text NOT NULL,
          \`key_version\` integer NOT NULL,
          \`ciphertext\` text NOT NULL,
          \`fingerprint\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`revoked_at\` integer,
          CONSTRAINT \`tenant_secret_pk\` PRIMARY KEY(\`tenant_id\`, \`secret_id\`),
          CONSTRAINT \`fk_tenant_secret_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_secret_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tenant_usage_ledger\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`id\` text PRIMARY KEY,
          \`settlement_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`currency\` text NOT NULL,
          \`amount_minor\` integer NOT NULL,
          \`source\` text DEFAULT 'settled-runtime-usage' NOT NULL,
          \`recorded_at\` integer NOT NULL,
          CONSTRAINT \`fk_tenant_usage_ledger_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_tenant_usage_ledger_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
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
          \`access\` text DEFAULT 'read' NOT NULL,
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
      yield* tx.run(
        `CREATE UNIQUE INDEX \`control_run_claim_owner_binding_uidx\` ON \`control_run_claim\` (\`tenant_id\`,\`owner_user_id\`,\`binding_digest\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`control_run_claim_base_generation_uidx\` ON \`control_run_claim\` (\`tenant_id\`,\`owner_user_id\`,\`base_binding_digest\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`control_run_claim_operation_uidx\` ON \`control_run_claim\` (\`tenant_id\`,\`owner_user_id\`,\`operation_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`control_run_claim_run_uidx\` ON \`control_run_claim\` (\`tenant_id\`,\`owner_user_id\`,\`run_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`control_run_claim_subject_idx\` ON \`control_run_claim\` (\`tenant_id\`,\`owner_user_id\`,\`control_plane_id\`,\`location\`,\`project_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`control_run_request_alias_owner_request_uidx\` ON \`control_run_request_alias\` (\`tenant_id\`,\`owner_user_id\`,\`control_plane_id\`,\`request_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`control_run_request_alias_binding_idx\` ON \`control_run_request_alias\` (\`tenant_id\`,\`owner_user_id\`,\`binding_digest\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`artifact_maintenance_lease_scan_generation_idx\` ON \`artifact_maintenance_lease\` (\`tenant_id\`,\`owner_user_id\`,\`scan_id\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_lease_scan_idx\` ON \`artifact_maintenance_lease\` (\`tenant_id\`,\`owner_user_id\`,\`scan_id\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_lease_expiry_idx\` ON \`artifact_maintenance_lease\` (\`status\`,\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`artifact_maintenance_scan_page_digest_idx\` ON \`artifact_maintenance_scan_page\` (\`scan_id\`,\`page_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_scan_page_owner_idx\` ON \`artifact_maintenance_scan_page\` (\`tenant_id\`,\`owner_user_id\`,\`recorded_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_scan_owner_status_idx\` ON \`artifact_maintenance_scan\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_scan_expiry_idx\` ON \`artifact_maintenance_scan\` (\`status\`,\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`child_settlement_recovery_outbox_owner_status_idx\` ON \`child_settlement_recovery_outbox\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`child_settlement_recovery_outbox_parent_idx\` ON \`child_settlement_recovery_outbox\` (\`tenant_id\`,\`owner_user_id\`,\`parent_run_id\`,\`time_updated\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE INDEX \`evolution_artifact_kind_idx\` ON \`evolution_artifact\` (\`tenant_id\`,\`owner_user_id\`,\`kind\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_audit_record_hash_idx\` ON \`evolution_audit\` (\`tenant_id\`,\`owner_user_id\`,\`record_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_audit_aggregate_idx\` ON \`evolution_audit\` (\`tenant_id\`,\`owner_user_id\`,\`aggregate_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_evaluation_proposal_digest_idx\` ON \`evolution_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`proposal_id\`,\`report_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_evaluation_proposal_idx\` ON \`evolution_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`proposal_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_exposure_ticket_digest_idx\` ON \`evolution_exposure\` (\`tenant_id\`,\`owner_user_id\`,\`ticket_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_exposure_status_idx\` ON \`evolution_exposure\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_lease_run_idx\` ON \`evolution_lease\` (\`tenant_id\`,\`owner_user_id\`,\`run_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_lease_expiry_idx\` ON \`evolution_lease\` (\`tenant_id\`,\`owner_user_id\`,\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_observation_proposal_hash_idx\` ON \`evolution_observation\` (\`tenant_id\`,\`owner_user_id\`,\`proposal_id\`,\`record_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_observation_proposal_cohort_idx\` ON \`evolution_observation\` (\`tenant_id\`,\`owner_user_id\`,\`proposal_id\`,\`cohort\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_proposal_candidate_idx\` ON \`evolution_proposal\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_proposal_status_idx\` ON \`evolution_proposal\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_proposal_digest_idx\` ON \`evolution_proposal\` (\`tenant_id\`,\`owner_user_id\`,\`artifact_digest\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_graph_relation_identity_idx\` ON \`experience_graph_relation\` (\`tenant_id\`,\`owner_user_id\`,\`source_kind\`,\`source_id\`,\`target_kind\`,\`target_id\`,\`relation_kind\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_graph_relation_source_idx\` ON \`experience_graph_relation\` (\`source_kind\`,\`source_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_graph_relation_target_idx\` ON \`experience_graph_relation\` (\`target_kind\`,\`target_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_graph_relation_kind_idx\` ON \`experience_graph_relation\` (\`relation_kind\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_audit_record_hash_idx\` ON \`experience_audit\` (\`tenant_id\`,\`owner_user_id\`,\`record_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_audit_aggregate_idx\` ON \`experience_audit\` (\`tenant_id\`,\`owner_user_id\`,\`aggregate_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_candidate_digest_idx\` ON \`experience_candidate\` (\`tenant_id\`,\`owner_user_id\`,\`digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_candidate_status_idx\` ON \`experience_candidate\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_evaluation_candidate_digest_idx\` ON \`experience_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`evaluation_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_evaluation_candidate_idx\` ON \`experience_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_evidence_record_digest_idx\` ON \`experience_evidence\` (\`tenant_id\`,\`owner_user_id\`,\`record_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_evidence_run_action_idx\` ON \`experience_evidence\` (\`tenant_id\`,\`owner_user_id\`,\`run_id\`,\`action_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_record_support_idx\` ON \`experience_record\` (\`tenant_id\`,\`owner_user_id\`,\`support_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_record_digest_idx\` ON \`experience_record\` (\`tenant_id\`,\`owner_user_id\`,\`record_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_record_candidate_idx\` ON \`experience_record\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_support_candidate_run_idx\` ON \`experience_support\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`run_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_support_digest_idx\` ON \`experience_support\` (\`tenant_id\`,\`owner_user_id\`,\`support_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_support_candidate_idx\` ON \`experience_support\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`time_created\`);`,
      )
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
      yield* tx.run(
        `CREATE UNIQUE INDEX \`mailbox_message_idempotency_idx\` ON \`mailbox_message\` (\`tenant_id\`,\`owner_user_id\`,\`team_id\`,\`run_id\`,\`task_id\`,\`sender\`,\`recipient\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`mailbox_message_thread_idx\` ON \`mailbox_message\` (\`tenant_id\`,\`owner_user_id\`,\`team_id\`,\`run_id\`,\`task_id\`,\`recipient\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`mailbox_message_status_idx\` ON \`mailbox_message\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`mailbox_receipt_message_recipient_idx\` ON \`mailbox_receipt\` (\`tenant_id\`,\`owner_user_id\`,\`message_id\`,\`recipient\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`mailbox_receipt_thread_idx\` ON \`mailbox_receipt\` (\`tenant_id\`,\`owner_user_id\`,\`team_id\`,\`run_id\`,\`task_id\`,\`recipient\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_candidate_audit_candidate_idx\` ON \`memory_candidate_audit\` (\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_candidate_audit_operation_idx\` ON \`memory_candidate_audit\` (\`operation\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_candidate_status_idx\` ON \`memory_candidate\` (\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_candidate_scope_idx\` ON \`memory_candidate\` (\`scope\`,\`project_id\`,\`workspace_path\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_candidate_run_idx\` ON \`memory_candidate\` (\`run_id\`,\`time_created\`);`)
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
        `CREATE UNIQUE INDEX \`memory_revision_memory_version_idx\` ON \`memory_revision\` (\`memory_id\`,\`version\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_revision_memory_created_idx\` ON \`memory_revision\` (\`memory_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_revision_run_idx\` ON \`memory_revision\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_scope_workspace_idx\` ON \`memory\` (\`scope\`,\`project_id\`,\`workspace_path\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_source_idx\` ON \`memory\` (\`source\`);`)
      yield* tx.run(`CREATE INDEX \`memory_type_importance_idx\` ON \`memory\` (\`type\`,\`importance\`);`)
      yield* tx.run(`CREATE INDEX \`memory_updated_idx\` ON \`memory\` (\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_lifecycle_idx\` ON \`memory\` (\`lifecycle\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_class_idx\` ON \`memory\` (\`memory_class\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`audit_entry_seq_idx\` ON \`audit_entry\` (\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`audit_entry_action_idx\` ON \`audit_entry\` (\`action\`,\`recorded_at\`);`)
      yield* tx.run(`CREATE INDEX \`audit_entry_actor_idx\` ON \`audit_entry\` (\`actor\`,\`recorded_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`evaluation_result_run_created_idx\` ON \`evaluation_result\` (\`run_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evaluation_result_case_revision_idx\` ON \`evaluation_result\` (\`case_id\`,\`case_revision\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evaluation_result_suite_revision_idx\` ON \`evaluation_result\` (\`suite_id\`,\`suite_revision\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_run_session_idx\` ON \`session_run\` (\`session_id\`,\`started_at\`);`)
      yield* tx.run(`CREATE INDEX \`session_run_status_idx\` ON \`session_run\` (\`status\`,\`started_at\`);`)
      yield* tx.run(`CREATE INDEX \`session_run_usage_run_idx\` ON \`session_run_usage\` (\`run_id\`,\`recorded_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_run_usage_session_idx\` ON \`session_run_usage\` (\`session_id\`,\`recorded_at\`);`,
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
        `CREATE INDEX \`session_compaction_checkpoint_session_created_idx\` ON \`session_compaction_checkpoint\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_compaction_checkpoint_operation_sequence_idx\` ON \`session_compaction_checkpoint\` (\`session_id\`,\`operation_id\`,\`sequence\`);`,
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
        `CREATE UNIQUE INDEX \`self_hosted_share_publication_operation_uidx\` ON \`self_hosted_share_publication\` (\`tenant_id\`,\`owner_user_id\`,\`operation_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`self_hosted_share_publication_receipt_uidx\` ON \`self_hosted_share_publication\` (\`tenant_id\`,\`owner_user_id\`,\`provider_receipt_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`self_hosted_share_publication_created_idx\` ON \`self_hosted_share_publication\` (\`tenant_id\`,\`owner_user_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`self_hosted_share_revocation_operation_uidx\` ON \`self_hosted_share_revocation\` (\`tenant_id\`,\`owner_user_id\`,\`operation_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`self_hosted_share_revocation_publication_uidx\` ON \`self_hosted_share_revocation\` (\`tenant_id\`,\`owner_user_id\`,\`publication_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`self_hosted_share_revocation_created_idx\` ON \`self_hosted_share_revocation\` (\`tenant_id\`,\`owner_user_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_share_operation_receipt_operation_uidx\` ON \`session_share_operation_receipt\` (\`tenant_id\`,\`owner_user_id\`,\`operation_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_share_operation_receipt_session_idx\` ON \`session_share_operation_receipt\` (\`tenant_id\`,\`owner_user_id\`,\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_share_operation_receipt_publication_idx\` ON \`session_share_operation_receipt\` (\`tenant_id\`,\`owner_user_id\`,\`publication_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_audit_record_hash_idx\` ON \`skill_audit\` (\`tenant_id\`,\`owner_user_id\`,\`record_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`skill_audit_aggregate_idx\` ON \`skill_audit\` (\`tenant_id\`,\`owner_user_id\`,\`aggregate_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_canary_idempotency_idx\` ON \`skill_canary_observation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_canary_record_digest_idx\` ON \`skill_canary_observation\` (\`tenant_id\`,\`owner_user_id\`,\`record_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`skill_canary_candidate_idx\` ON \`skill_canary_observation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_deployment_digest_idx\` ON \`skill_deployment\` (\`tenant_id\`,\`owner_user_id\`,\`deployment_digest\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_evaluation_candidate_idx\` ON \`skill_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_evaluation_digest_idx\` ON \`skill_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`report_digest\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_version_identity_idx\` ON \`skill_version\` (\`tenant_id\`,\`owner_user_id\`,\`skill_id\`,\`version\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_version_digest_idx\` ON \`skill_version\` (\`tenant_id\`,\`owner_user_id\`,\`digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`skill_version_status_idx\` ON \`skill_version\` (\`tenant_id\`,\`owner_user_id\`,\`skill_id\`,\`status\`,\`time_updated\`);`,
      )
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
        `CREATE INDEX \`tenant_audit_export_tenant_idx\` ON \`tenant_audit_export\` (\`tenant_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`tenant_backup_manifest_tenant_idx\` ON \`tenant_backup_manifest\` (\`tenant_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`tenant_backup_manifest_digest_idx\` ON \`tenant_backup_manifest\` (\`tenant_id\`,\`artifact_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`tenant_data_request_status_idx\` ON \`tenant_data_request\` (\`tenant_id\`,\`status\`,\`requested_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`tenant_data_request_digest_idx\` ON \`tenant_data_request\` (\`tenant_id\`,\`request_digest\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`tenant_key_digest_idx\` ON \`tenant_key\` (\`tenant_id\`,\`key_digest\`);`)
      yield* tx.run(
        `CREATE INDEX \`tenant_project_member_tenant_idx\` ON \`tenant_project_member\` (\`tenant_id\`,\`user_id\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`tenant_secret_status_idx\` ON \`tenant_secret\` (\`tenant_id\`,\`status\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`tenant_usage_settlement_idx\` ON \`tenant_usage_ledger\` (\`tenant_id\`,\`settlement_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`tenant_usage_recorded_idx\` ON \`tenant_usage_ledger\` (\`tenant_id\`,\`recorded_at\`);`,
      )
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
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
