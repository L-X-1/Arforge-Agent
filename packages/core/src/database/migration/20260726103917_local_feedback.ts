import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726103917_local_feedback",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`feedback\` (
          \`id\` text PRIMARY KEY,
          \`category\` text NOT NULL,
          \`rating\` integer NOT NULL,
          \`message\` text NOT NULL,
          \`session_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_feedback_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`feedback_created_idx\` ON \`feedback\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`feedback_category_created_idx\` ON \`feedback\` (\`category\`,\`time_created\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
