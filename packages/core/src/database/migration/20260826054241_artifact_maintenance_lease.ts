import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260826054241_artifact_maintenance_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`artifact_maintenance_lease\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`lease_id\` text PRIMARY KEY,
          \`scan_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`acquired_at\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`released_at\` integer,
          CONSTRAINT \`fk_artifact_maintenance_lease_scan_id_artifact_maintenance_scan_id_fk\` FOREIGN KEY (\`scan_id\`) REFERENCES \`artifact_maintenance_scan\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`artifact_maintenance_lease_scan_generation_idx\` ON \`artifact_maintenance_lease\` (\`tenant_id\`,\`owner_user_id\`,\`scan_id\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_lease_scan_idx\` ON \`artifact_maintenance_lease\` (\`tenant_id\`,\`owner_user_id\`,\`scan_id\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`artifact_maintenance_lease_expiry_idx\` ON \`artifact_maintenance_lease\` (\`status\`,\`expires_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
