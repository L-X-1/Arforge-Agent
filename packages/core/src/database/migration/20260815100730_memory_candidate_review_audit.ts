import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815100730_memory_candidate_review_audit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_candidate_audit\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`candidate_id\` text NOT NULL,
          \`operation\` text NOT NULL,
          \`actor_kind\` text NOT NULL,
          \`principal_ref\` text,
          \`reason\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`status_from\` text,
          \`status_to\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_candidate_audit_candidate_id_memory_candidate_id_fk\` FOREIGN KEY (\`candidate_id\`) REFERENCES \`memory_candidate\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`memory_candidate_audit_candidate_idx\` ON \`memory_candidate_audit\` (\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_candidate_audit_operation_idx\` ON \`memory_candidate_audit\` (\`operation\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
