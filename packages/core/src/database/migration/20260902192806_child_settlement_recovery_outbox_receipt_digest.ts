import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260902192806_child_settlement_recovery_outbox_receipt_digest",
  up(tx) {
    return Effect.gen(function* () {
      // Keep rolling upgrades safe when an older process inserted a prepared
      // metadata row between the table and column migrations. The empty
      // sentinel is intentionally not a valid receipt digest; the outbox
      // decoder will fail closed until the row is rebuilt through the exact
      // commit plan rather than trusting a guessed digest.
      yield* tx.run(`ALTER TABLE \`child_settlement_recovery_outbox\` ADD \`receipt_digest\` text NOT NULL DEFAULT '';`)
    })
  },
} satisfies DatabaseMigration.Migration
