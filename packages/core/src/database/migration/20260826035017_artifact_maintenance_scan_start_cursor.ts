import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260826035017_artifact_maintenance_scan_start_cursor",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`artifact_maintenance_scan\` ADD \`start_cursor\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
