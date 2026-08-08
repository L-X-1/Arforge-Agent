import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260804090000_runtime_insight",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE UNIQUE INDEX \`audit_entry_seq_idx\` ON \`audit_entry\` (\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`audit_entry_action_idx\` ON \`audit_entry\` (\`action\`,\`recorded_at\`);`)
      yield* tx.run(`CREATE INDEX \`audit_entry_actor_idx\` ON \`audit_entry\` (\`actor\`,\`recorded_at\`);`)
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
      yield* tx.run(`CREATE INDEX \`session_run_session_idx\` ON \`session_run\` (\`session_id\`,\`started_at\`);`)
      yield* tx.run(`CREATE INDEX \`session_run_status_idx\` ON \`session_run\` (\`status\`,\`started_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
