import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813125806_mailbox_protocol",
  up(tx) {
    return Effect.gen(function* () {
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
    })
  },
} satisfies DatabaseMigration.Migration
