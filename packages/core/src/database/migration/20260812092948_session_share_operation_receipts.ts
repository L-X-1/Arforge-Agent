import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812092948_session_share_operation_receipts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_share_operation_receipt\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`operation_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`action_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`snapshot_digest\` text NOT NULL,
          \`export_digest\` text NOT NULL,
          \`target_base_url\` text NOT NULL,
          \`visibility\` text NOT NULL,
          \`organization_id\` text,
          \`provider_receipt_id\` text,
          \`publication_id\` text NOT NULL,
          \`publication_url\` text NOT NULL,
          \`stored_digest\` text,
          \`removed_digest\` text,
          \`response_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_share_operation_receipt_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`operation_id\`),
          CONSTRAINT \`fk_session_share_operation_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT "session_share_operation_receipt_kind_fields_check" CHECK("kind" = 'share' AND "provider_receipt_id" IS NOT NULL AND "stored_digest" IS NOT NULL AND "removed_digest" IS NULL OR "kind" = 'unshare' AND "provider_receipt_id" IS NULL AND "stored_digest" IS NULL AND "removed_digest" IS NOT NULL),
          CONSTRAINT "session_share_operation_receipt_visibility_check" CHECK("visibility" IN ('private', 'organization', 'public'))
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_share_operation_receipt_operation_uidx\` ON \`session_share_operation_receipt\` (\`tenant_id\`,\`owner_user_id\`,\`operation_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_share_operation_receipt_session_idx\` ON \`session_share_operation_receipt\` (\`tenant_id\`,\`owner_user_id\`,\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_share_operation_receipt_publication_idx\` ON \`session_share_operation_receipt\` (\`tenant_id\`,\`owner_user_id\`,\`publication_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
