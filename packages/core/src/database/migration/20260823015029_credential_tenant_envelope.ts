import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823015029_credential_tenant_envelope",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`encrypted_value\` text;`)
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`value_key_version\` integer;`)
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`value_fingerprint\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
