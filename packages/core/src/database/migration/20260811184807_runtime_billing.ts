import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811184807_runtime_billing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_run_usage\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`usage_source\` text NOT NULL,
          \`estimator_id\` text,
          \`unknown_input\` integer NOT NULL,
          \`image_input\` integer NOT NULL,
          \`audio_input\` integer NOT NULL,
          \`cache_read_input\` integer NOT NULL,
          \`cache_write_input\` integer NOT NULL,
          \`text_output\` integer NOT NULL,
          \`reasoning_output\` integer NOT NULL,
          \`audio_output\` integer NOT NULL,
          \`price_catalog_revision\` text,
          \`currency\` text,
          \`amount_minor\` integer,
          \`unpriced_categories\` text NOT NULL,
          \`settlement_reservation_id\` text,
          \`over_budget\` integer DEFAULT false NOT NULL,
          \`recorded_at\` integer NOT NULL
        );
      `)
      yield* tx.run("CREATE INDEX `session_run_usage_run_idx` ON `session_run_usage` (`run_id`,`recorded_at`)")
      yield* tx.run("CREATE INDEX `session_run_usage_session_idx` ON `session_run_usage` (`session_id`,`recorded_at`)")
    })
  },
} satisfies DatabaseMigration.Migration
