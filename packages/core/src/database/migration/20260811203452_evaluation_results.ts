import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811203452_evaluation_results",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`evaluation_result\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`suite_id\` text NOT NULL,
          \`suite_revision\` integer NOT NULL,
          \`case_id\` text NOT NULL,
          \`case_revision\` integer NOT NULL,
          \`baseline_artifact_digest\` text NOT NULL,
          \`candidate_artifact_digest\` text NOT NULL,
          \`environment_digest\` text NOT NULL,
          \`toolchain_digest\` text NOT NULL,
          \`sample_size\` integer NOT NULL,
          \`score\` real NOT NULL,
          \`success_delta\` real NOT NULL,
          \`cost_delta\` real NOT NULL,
          \`latency_delta\` real NOT NULL,
          \`passed\` integer NOT NULL,
          \`metrics\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`provider_id\` text,
          \`model_id\` text,
          \`input_tokens\` integer,
          \`output_tokens\` integer,
          \`cost_minor\` integer,
          \`currency\` text,
          \`reviewer_id\` text,
          \`approval_status\` text DEFAULT 'pending' NOT NULL,
          \`approval_reason\` text,
          \`created_at\` integer NOT NULL,
          \`evaluated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`evaluation_result_run_created_idx\` ON \`evaluation_result\` (\`run_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evaluation_result_case_revision_idx\` ON \`evaluation_result\` (\`case_id\`,\`case_revision\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evaluation_result_suite_revision_idx\` ON \`evaluation_result\` (\`suite_id\`,\`suite_revision\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
