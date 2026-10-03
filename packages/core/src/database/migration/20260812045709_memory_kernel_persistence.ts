import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812045709_memory_kernel_persistence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_candidate\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`proposed_class\` text NOT NULL,
          \`content\` text NOT NULL,
          \`source_evidence_ids\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`sensitivity\` text NOT NULL,
          \`confidence\` real NOT NULL,
          \`dedup_status\` text NOT NULL,
          \`dedup_compared_memory_ids\` text NOT NULL,
          \`dedup_similarity\` real,
          \`retention_mode\` text NOT NULL,
          \`retention_expires_at\` integer,
          \`retention_reason\` text NOT NULL,
          \`proposer_kind\` text NOT NULL,
          \`principal_ref\` text,
          \`run_id\` text,
          \`policy_status\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`policy_reason\` text NOT NULL,
          \`status\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_expires\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_revision\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`memory_id\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`operation\` text NOT NULL,
          \`actor_kind\` text NOT NULL,
          \`principal_ref\` text,
          \`run_id\` text,
          \`reason\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`prior_digest\` text,
          \`content_digest\` text NOT NULL,
          \`successor_memory_id\` text,
          \`candidate_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_revision_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_revision_successor_memory_id_memory_id_fk\` FOREIGN KEY (\`successor_memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_memory_revision_candidate_id_memory_candidate_id_fk\` FOREIGN KEY (\`candidate_id\`) REFERENCES \`memory_candidate\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`memory_class\` text;`)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`lifecycle\` text DEFAULT 'active' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`memory_version\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`provenance_status\` text DEFAULT 'legacy_unknown' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`content_digest\` text;`)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`retention_mode\` text DEFAULT 'indefinite' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`retention_expires_at\` integer;`)
      yield* tx.run(`
        UPDATE \`memory\`
        SET
          \`lifecycle\` = CASE WHEN \`source\` LIKE 'quarantined%' THEN 'quarantined' ELSE 'active' END,
          \`memory_version\` = 1,
          \`provenance_status\` = 'legacy_unknown',
          \`retention_mode\` = 'indefinite'
      ;`)
      yield* tx.run(
        `CREATE INDEX \`memory_candidate_status_idx\` ON \`memory_candidate\` (\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_candidate_scope_idx\` ON \`memory_candidate\` (\`scope\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`memory_candidate_run_idx\` ON \`memory_candidate\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_revision_memory_version_idx\` ON \`memory_revision\` (\`memory_id\`,\`version\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_revision_memory_created_idx\` ON \`memory_revision\` (\`memory_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_revision_run_idx\` ON \`memory_revision\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`memory_lifecycle_idx\` ON \`memory\` (\`lifecycle\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_class_idx\` ON \`memory\` (\`memory_class\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
