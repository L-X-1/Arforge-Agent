import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815103339_memory_candidate_workspace_scope",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_candidate\` ADD \`project_id\` text;`)
      yield* tx.run(`ALTER TABLE \`memory_candidate\` ADD \`workspace_path\` text;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`memory_candidate_scope_idx\`;`)
      yield* tx.run(
        `CREATE INDEX \`memory_candidate_scope_idx\` ON \`memory_candidate\` (\`scope\`,\`project_id\`,\`workspace_path\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
