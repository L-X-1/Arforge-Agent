import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803064956_memory_conflicts",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_conflict_signature_idx\` ON \`memory_conflict\` (\`signature\`);`)
      yield* tx.run(`CREATE INDEX \`memory_conflict_status_idx\` ON \`memory_conflict\` (\`status\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_conflict_left_idx\` ON \`memory_conflict\` (\`left_memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_conflict_right_idx\` ON \`memory_conflict\` (\`right_memory_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
