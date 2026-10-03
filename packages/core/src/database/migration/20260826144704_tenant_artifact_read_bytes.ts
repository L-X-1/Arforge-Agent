import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260826144704_tenant_artifact_read_bytes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`tenant_rate_window\` ADD \`byte_count\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
