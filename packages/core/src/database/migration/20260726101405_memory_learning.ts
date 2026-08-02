import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726101405_memory_learning",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`learning_outcome_pattern\` (
          \`outcome_id\` text NOT NULL,
          \`pattern_id\` text NOT NULL,
          CONSTRAINT \`learning_outcome_pattern_pk\` PRIMARY KEY(\`outcome_id\`, \`pattern_id\`),
          CONSTRAINT \`fk_learning_outcome_pattern_outcome_id_learning_outcome_id_fk\` FOREIGN KEY (\`outcome_id\`) REFERENCES \`learning_outcome\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_learning_outcome_pattern_pattern_id_learning_pattern_id_fk\` FOREIGN KEY (\`pattern_id\`) REFERENCES \`learning_pattern\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`learning_outcome\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`project_id\` text NOT NULL,
          \`workspace_path\` text NOT NULL,
          \`turn_index\` integer DEFAULT 0 NOT NULL,
          \`user_input\` text NOT NULL,
          \`intent\` text DEFAULT 'general' NOT NULL,
          \`route\` text DEFAULT 'agentic' NOT NULL,
          \`tools\` text NOT NULL,
          \`success\` integer NOT NULL,
          \`error_type\` text DEFAULT '' NOT NULL,
          \`error_message\` text DEFAULT '' NOT NULL,
          \`user_feedback\` text DEFAULT '' NOT NULL,
          \`fix_strategy\` text DEFAULT '' NOT NULL,
          \`regression\` integer DEFAULT false NOT NULL,
          \`token_count\` integer DEFAULT 0 NOT NULL,
          \`response_time_ms\` integer DEFAULT 0 NOT NULL,
          \`tags\` text NOT NULL,
          \`importance\` integer DEFAULT 1 NOT NULL,
          \`injected_context_size\` integer DEFAULT 0 NOT NULL,
          \`fingerprint\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_learning_outcome_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`learning_pattern\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_path\` text NOT NULL,
          \`type\` text NOT NULL,
          \`description\` text NOT NULL,
          \`frequency\` integer DEFAULT 1 NOT NULL,
          \`confidence\` real DEFAULT 0.5 NOT NULL,
          \`tags\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`id\` text PRIMARY KEY,
          \`content\` text NOT NULL,
          \`type\` text NOT NULL,
          \`tags\` text NOT NULL,
          \`importance\` integer DEFAULT 1 NOT NULL,
          \`source\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_path\` text,
          \`related_to\` text,
          \`strength\` real DEFAULT 0.5 NOT NULL,
          \`review_level\` integer DEFAULT 0 NOT NULL,
          \`time_reviewed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`learning_outcome_pattern_outcome_idx\` ON \`learning_outcome_pattern\` (\`outcome_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`learning_outcome_session_created_idx\` ON \`learning_outcome\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`learning_outcome_workspace_created_idx\` ON \`learning_outcome\` (\`project_id\`,\`workspace_path\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`learning_outcome_success_created_idx\` ON \`learning_outcome\` (\`success\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`learning_outcome_fingerprint_idx\` ON \`learning_outcome\` (\`fingerprint\`);`)
      yield* tx.run(
        `CREATE INDEX \`learning_pattern_type_frequency_idx\` ON \`learning_pattern\` (\`project_id\`,\`workspace_path\`,\`type\`,\`frequency\`);`,
      )
      yield* tx.run(`CREATE INDEX \`learning_pattern_updated_idx\` ON \`learning_pattern\` (\`time_updated\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_scope_workspace_idx\` ON \`memory\` (\`scope\`,\`project_id\`,\`workspace_path\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_source_idx\` ON \`memory\` (\`source\`);`)
      yield* tx.run(`CREATE INDEX \`memory_type_importance_idx\` ON \`memory\` (\`type\`,\`importance\`);`)
      yield* tx.run(`CREATE INDEX \`memory_updated_idx\` ON \`memory\` (\`time_updated\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
