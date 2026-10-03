import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812134845_learning_verified_outcomes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`learning_outcome\` ADD \`run_id\` text;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome\` ADD \`action_id\` text;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome\` ADD \`evaluation_id\` text;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome\` ADD \`evidence_ids\` text;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome\` ADD \`terminal\` integer;`)
      yield* tx.run(`ALTER TABLE \`learning_outcome\` ADD \`verifier_passed\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
