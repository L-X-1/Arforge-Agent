import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260826121545_session_compaction_checkpoint",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(
        `CREATE INDEX \`session_compaction_checkpoint_session_created_idx\` ON \`session_compaction_checkpoint\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_compaction_checkpoint_operation_sequence_idx\` ON \`session_compaction_checkpoint\` (\`session_id\`,\`operation_id\`,\`sequence\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
