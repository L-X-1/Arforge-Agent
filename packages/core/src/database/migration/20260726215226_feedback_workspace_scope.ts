import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726215226_feedback_workspace_scope",
  up(tx) {
    return Effect.gen(function* () {
      // Existing feedback predates shared PostgreSQL workspace scoping. Keep
      // those rows unassigned so they cannot leak into any active workspace.
      yield* tx.run(`ALTER TABLE \`feedback\` ADD \`workspace_path\` text DEFAULT '' NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`feedback_workspace_created_idx\` ON \`feedback\` (\`workspace_path\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`feedback_workspace_category_created_idx\` ON \`feedback\` (\`workspace_path\`,\`category\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
