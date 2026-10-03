import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908114322_runtime_billing_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_run_usage\` ADD \`billing_receipt\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
