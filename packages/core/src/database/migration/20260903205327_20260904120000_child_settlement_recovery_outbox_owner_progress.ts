import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260903205327_20260904120000_child_settlement_recovery_outbox_owner_progress",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`child_settlement_recovery_outbox\` ADD \`owner_progress\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
