import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812105516_self_hosted_share_provider",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`self_hosted_share_publication\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`publication_id\` text NOT NULL,
          \`operation_id\` text NOT NULL,
          \`operation_digest\` text NOT NULL,
          \`provider_receipt_id\` text NOT NULL,
          \`publication_url\` text NOT NULL,
          \`export_digest\` text NOT NULL,
          \`frozen_export\` text NOT NULL,
          \`target_base_url\` text NOT NULL,
          \`visibility\` text NOT NULL,
          \`organization_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`self_hosted_share_publication_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`publication_id\`),
          CONSTRAINT "self_hosted_share_publication_visibility_check" CHECK("visibility" IN ('private', 'organization', 'public'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`self_hosted_share_revocation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`operation_id\` text NOT NULL,
          \`operation_digest\` text NOT NULL,
          \`publication_id\` text NOT NULL,
          \`original_digest\` text NOT NULL,
          \`target_base_url\` text NOT NULL,
          \`visibility\` text NOT NULL,
          \`organization_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`self_hosted_share_revocation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`operation_id\`),
          CONSTRAINT "self_hosted_share_revocation_visibility_check" CHECK("visibility" IN ('private', 'organization', 'public'))
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`self_hosted_share_publication_operation_uidx\` ON \`self_hosted_share_publication\` (\`tenant_id\`,\`owner_user_id\`,\`operation_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`self_hosted_share_publication_receipt_uidx\` ON \`self_hosted_share_publication\` (\`tenant_id\`,\`owner_user_id\`,\`provider_receipt_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`self_hosted_share_publication_created_idx\` ON \`self_hosted_share_publication\` (\`tenant_id\`,\`owner_user_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`self_hosted_share_revocation_operation_uidx\` ON \`self_hosted_share_revocation\` (\`tenant_id\`,\`owner_user_id\`,\`operation_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`self_hosted_share_revocation_publication_uidx\` ON \`self_hosted_share_revocation\` (\`tenant_id\`,\`owner_user_id\`,\`publication_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`self_hosted_share_revocation_created_idx\` ON \`self_hosted_share_revocation\` (\`tenant_id\`,\`owner_user_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
