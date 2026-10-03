import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812140331_experience_graph",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`experience_graph_relation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`source_kind\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`source_digest\` text NOT NULL,
          \`target_kind\` text NOT NULL,
          \`target_id\` text NOT NULL,
          \`target_digest\` text NOT NULL,
          \`relation_kind\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_graph_relation_identity_idx\` ON \`experience_graph_relation\` (\`tenant_id\`,\`owner_user_id\`,\`source_kind\`,\`source_id\`,\`target_kind\`,\`target_id\`,\`relation_kind\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_graph_relation_source_idx\` ON \`experience_graph_relation\` (\`source_kind\`,\`source_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_graph_relation_target_idx\` ON \`experience_graph_relation\` (\`target_kind\`,\`target_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_graph_relation_kind_idx\` ON \`experience_graph_relation\` (\`relation_kind\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
