import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726011601_arforge_goals",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`goal\` (
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
      yield* tx.run(
        `CREATE INDEX \`goal_session_status_queue_idx\` ON \`goal\` (\`session_id\`,\`status\`,\`queue_position\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`goal_session_active_idx\` ON \`goal\` (\`session_id\`) WHERE "goal"."status" in ('active', 'running', 'paused', 'blocked');`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
