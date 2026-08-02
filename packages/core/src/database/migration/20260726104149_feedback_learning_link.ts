import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726104149_feedback_learning_link",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`feedback\` ADD \`learning_outcome_id\` text REFERENCES learning_outcome(id);`)
    })
  },
} satisfies DatabaseMigration.Migration
