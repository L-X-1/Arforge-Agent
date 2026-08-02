import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726074902_team_mailbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`team_member\` (
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
      yield* tx.run(`CREATE UNIQUE INDEX \`team_member_agent_idx\` ON \`team_member\` (\`team_id\`,\`agent_id\`);`)
      yield* tx.run(`CREATE INDEX \`team_member_status_idx\` ON \`team_member\` (\`team_id\`,\`status\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_message_sequence_idx\` ON \`team_message\` (\`team_id\`,\`sequence\`);`)
      yield* tx.run(`CREATE INDEX \`team_message_created_idx\` ON \`team_message\` (\`team_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`team_shutdown_member_status_idx\` ON \`team_shutdown\` (\`team_id\`,\`member_key\`,\`status\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`team_session_idx\` ON \`team\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
