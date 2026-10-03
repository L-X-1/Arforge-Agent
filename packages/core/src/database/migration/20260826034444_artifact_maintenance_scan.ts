import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260826034444_artifact_maintenance_scan",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`artifact_maintenance_scan_page\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`scan_id\` text NOT NULL,
          \`page_number\` integer NOT NULL,
          \`cursor_before\` text,
          \`cursor_after\` text,
          \`scanned_actions\` integer NOT NULL,
          \`referenced_count\` integer NOT NULL,
          \`audit\` text NOT NULL,
          \`page_digest\` text NOT NULL,
          \`recorded_at\` integer NOT NULL,
          CONSTRAINT \`artifact_maintenance_scan_page_pk\` PRIMARY KEY(\`scan_id\`, \`page_number\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`artifact_maintenance_scan\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`status\` text NOT NULL,
          \`scan_limit\` integer NOT NULL,
          \`cursor\` text,
          \`page_count\` integer DEFAULT 0 NOT NULL,
          \`scanned_actions\` integer DEFAULT 0 NOT NULL,
          \`referenced_count\` integer DEFAULT 0 NOT NULL,
          \`session_digest\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`completed_at\` integer,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`artifact_maintenance_scan_page_digest_idx\` ON \`artifact_maintenance_scan_page\` (\`scan_id\`,\`page_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_scan_page_owner_idx\` ON \`artifact_maintenance_scan_page\` (\`tenant_id\`,\`owner_user_id\`,\`recorded_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_scan_owner_status_idx\` ON \`artifact_maintenance_scan\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_scan_expiry_idx\` ON \`artifact_maintenance_scan\` (\`status\`,\`expires_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
