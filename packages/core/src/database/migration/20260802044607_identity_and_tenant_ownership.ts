import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802044607_identity_and_tenant_ownership",
  up(tx) {
    return Effect.gen(function* () {
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
        INSERT INTO \`identity_user\` (
          \`id\`, \`email\`, \`normalized_email\`, \`display_name\`, \`password_hash\`,
          \`status\`, \`email_verified_at\`, \`session_epoch\`, \`time_created\`, \`time_updated\`
        ) VALUES ('usr_local', 'local@arforge.invalid', 'local@arforge.invalid', 'Local owner', '!', 'disabled', 0, 0, 0, 0);
      `)
      yield* tx.run(`
        INSERT INTO \`identity_tenant\` (
          \`id\`, \`name\`, \`slug\`, \`created_by_user_id\`, \`time_created\`, \`time_updated\`
        ) VALUES ('ten_local', 'Local workspace', 'local', 'usr_local', 0, 0);
      `)
      yield* tx.run(`
        INSERT INTO \`identity_tenant_member\` (
          \`tenant_id\`, \`user_id\`, \`role\`, \`status\`, \`time_created\`, \`time_updated\`
        ) VALUES ('ten_local', 'usr_local', 'owner', 'active', 0, 0);
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
      yield* tx.run(`ALTER TABLE \`workspace\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`workspace\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`account_state\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`account_state\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`control_account\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`control_account\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`event_sequence\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`event_sequence\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`event\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`event\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`feedback\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`feedback\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`goal\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`goal\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome_pattern\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome_pattern\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`learning_pattern\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`learning_pattern\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`permission\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`permission\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`project_directory\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`project_directory\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`message\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`message\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`scheduled_prompt\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`scheduled_prompt\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_checkpoint\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_checkpoint\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_message\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_message\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_tag\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_tag\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_share\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_share\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_graph_edge\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_graph_edge\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_graph_task\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_graph_task\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team_member\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team_member\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team_message\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team_message\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team_shutdown\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team_shutdown\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team\` ADD \`tenant_id\` text DEFAULT 'ten_local' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team\` ADD \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL;`)
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
} satisfies DatabaseMigration.Migration
