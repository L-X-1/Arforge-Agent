import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726070221_scheduled_prompts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`scheduled_prompt\` (
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
      yield* tx.run(
        `CREATE INDEX \`scheduled_prompt_session_created_idx\` ON \`scheduled_prompt\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_prompt_due_idx\` ON \`scheduled_prompt\` (\`enabled\`,\`status\`,\`next_run\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_prompt_session_name_idx\` ON \`scheduled_prompt\` (\`session_id\`,\`name\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
