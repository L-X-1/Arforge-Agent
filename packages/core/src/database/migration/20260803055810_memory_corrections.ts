import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803055810_memory_corrections",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(
        `CREATE INDEX \`memory_correction_original_idx\` ON \`memory_correction\` (\`original_memory_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_correction_successor_idx\` ON \`memory_correction\` (\`successor_memory_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_correction_status_idx\` ON \`memory_correction\` (\`status\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
