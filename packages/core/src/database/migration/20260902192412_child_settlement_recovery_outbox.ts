import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260902192412_child_settlement_recovery_outbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`child_settlement_recovery_outbox\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`intent_id\` text NOT NULL,
          \`parent_run_id\` text NOT NULL,
          \`child_run_id\` text NOT NULL,
          \`commit_digest\` text NOT NULL,
          \`mode\` text DEFAULT 'recovery-outbox' NOT NULL,
          \`status\` text NOT NULL,
          \`owner_order\` text NOT NULL,
          \`expected_digests\` text NOT NULL,
          \`reason\` text DEFAULT '' NOT NULL,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`child_settlement_recovery_outbox_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`intent_id\`),
          CONSTRAINT "child_settlement_recovery_outbox_mode_check" CHECK("mode" = 'recovery-outbox'),
          CONSTRAINT "child_settlement_recovery_outbox_status_check" CHECK("status" IN ('prepared', 'committed', 'recovery-required')),
          CONSTRAINT "child_settlement_recovery_outbox_revision_check" CHECK("revision" >= 0)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`child_settlement_recovery_outbox_owner_status_idx\` ON \`child_settlement_recovery_outbox\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`child_settlement_recovery_outbox_parent_idx\` ON \`child_settlement_recovery_outbox\` (\`tenant_id\`,\`owner_user_id\`,\`parent_run_id\`,\`time_updated\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
