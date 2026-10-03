import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813170442_tenant_platform_v1_constraints",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_tenant_audit_export\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`id\` text PRIMARY KEY,
          \`requested_by\` text NOT NULL,
          \`item_count\` integer NOT NULL,
          \`export_digest\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_tenant_audit_export_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_audit_export_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_tenant_audit_export_requested_by_identity_user_id_fk\` FOREIGN KEY (\`requested_by\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_tenant_audit_export\`(\`tenant_id\`, \`owner_user_id\`, \`id\`, \`requested_by\`, \`item_count\`, \`export_digest\`, \`created_at\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`id\`, \`requested_by\`, \`item_count\`, \`export_digest\`, \`created_at\` FROM \`tenant_audit_export\`;`,
      )
      yield* tx.run(`DROP TABLE \`tenant_audit_export\`;`)
      yield* tx.run(`ALTER TABLE \`__new_tenant_audit_export\` RENAME TO \`tenant_audit_export\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_tenant_backup_manifest\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`id\` text PRIMARY KEY,
          \`region\` text NOT NULL,
          \`schema_revision\` text NOT NULL,
          \`artifact_digest\` text NOT NULL,
          \`status\` text DEFAULT 'created' NOT NULL,
          \`created_at\` integer NOT NULL,
          \`verified_at\` integer,
          CONSTRAINT \`fk_tenant_backup_manifest_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_backup_manifest_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_tenant_backup_manifest\`(\`tenant_id\`, \`owner_user_id\`, \`id\`, \`region\`, \`schema_revision\`, \`artifact_digest\`, \`status\`, \`created_at\`, \`verified_at\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`id\`, \`region\`, \`schema_revision\`, \`artifact_digest\`, \`status\`, \`created_at\`, \`verified_at\` FROM \`tenant_backup_manifest\`;`,
      )
      yield* tx.run(`DROP TABLE \`tenant_backup_manifest\`;`)
      yield* tx.run(`ALTER TABLE \`__new_tenant_backup_manifest\` RENAME TO \`tenant_backup_manifest\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_tenant_data_request\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`status\` text DEFAULT 'requested' NOT NULL,
          \`requested_by\` text NOT NULL,
          \`approved_by\` text,
          \`reason\` text DEFAULT '' NOT NULL,
          \`request_digest\` text NOT NULL,
          \`requested_at\` integer NOT NULL,
          \`completed_at\` integer,
          CONSTRAINT \`fk_tenant_data_request_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_data_request_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_tenant_data_request_requested_by_identity_user_id_fk\` FOREIGN KEY (\`requested_by\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_tenant_data_request_approved_by_identity_user_id_fk\` FOREIGN KEY (\`approved_by\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_tenant_data_request\`(\`tenant_id\`, \`owner_user_id\`, \`id\`, \`kind\`, \`status\`, \`requested_by\`, \`approved_by\`, \`reason\`, \`request_digest\`, \`requested_at\`, \`completed_at\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`id\`, \`kind\`, \`status\`, \`requested_by\`, \`approved_by\`, \`reason\`, \`request_digest\`, \`requested_at\`, \`completed_at\` FROM \`tenant_data_request\`;`,
      )
      yield* tx.run(`DROP TABLE \`tenant_data_request\`;`)
      yield* tx.run(`ALTER TABLE \`__new_tenant_data_request\` RENAME TO \`tenant_data_request\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_tenant_key\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`wrapped_key\` text NOT NULL,
          \`key_digest\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tenant_key_pk\` PRIMARY KEY(\`tenant_id\`, \`version\`),
          CONSTRAINT \`fk_tenant_key_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_key_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_tenant_key\`(\`tenant_id\`, \`owner_user_id\`, \`version\`, \`wrapped_key\`, \`key_digest\`, \`status\`, \`time_created\`, \`time_updated\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`version\`, \`wrapped_key\`, \`key_digest\`, \`status\`, \`time_created\`, \`time_updated\` FROM \`tenant_key\`;`,
      )
      yield* tx.run(`DROP TABLE \`tenant_key\`;`)
      yield* tx.run(`ALTER TABLE \`__new_tenant_key\` RENAME TO \`tenant_key\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_tenant_policy\` (
          \`tenant_id\` text PRIMARY KEY,
          \`owner_user_id\` text NOT NULL,
          \`region\` text DEFAULT 'self-hosted' NOT NULL,
          \`retention_days\` integer DEFAULT 365 NOT NULL,
          \`quota_currency\` text DEFAULT 'USD' NOT NULL,
          \`quota_limit_minor\` integer,
          \`rate_limit_per_minute\` integer DEFAULT 60 NOT NULL,
          \`rate_limit_burst\` integer DEFAULT 20 NOT NULL,
          \`key_version\` integer DEFAULT 1 NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_tenant_policy_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_policy_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_tenant_policy\`(\`tenant_id\`, \`owner_user_id\`, \`region\`, \`retention_days\`, \`quota_currency\`, \`quota_limit_minor\`, \`rate_limit_per_minute\`, \`rate_limit_burst\`, \`key_version\`, \`revision\`, \`time_created\`, \`time_updated\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`region\`, \`retention_days\`, \`quota_currency\`, \`quota_limit_minor\`, \`rate_limit_per_minute\`, \`rate_limit_burst\`, \`key_version\`, \`revision\`, \`time_created\`, \`time_updated\` FROM \`tenant_policy\`;`,
      )
      yield* tx.run(`DROP TABLE \`tenant_policy\`;`)
      yield* tx.run(`ALTER TABLE \`__new_tenant_policy\` RENAME TO \`tenant_policy\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_tenant_rate_window\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`bucket\` text NOT NULL,
          \`window_started_at\` integer NOT NULL,
          \`request_count\` integer DEFAULT 0 NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tenant_rate_window_pk\` PRIMARY KEY(\`tenant_id\`, \`bucket\`),
          CONSTRAINT \`fk_tenant_rate_window_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_rate_window_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_tenant_rate_window\`(\`tenant_id\`, \`owner_user_id\`, \`bucket\`, \`window_started_at\`, \`request_count\`, \`time_updated\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`bucket\`, \`window_started_at\`, \`request_count\`, \`time_updated\` FROM \`tenant_rate_window\`;`,
      )
      yield* tx.run(`DROP TABLE \`tenant_rate_window\`;`)
      yield* tx.run(`ALTER TABLE \`__new_tenant_rate_window\` RENAME TO \`tenant_rate_window\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_tenant_secret\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`secret_id\` text NOT NULL,
          \`key_version\` integer NOT NULL,
          \`ciphertext\` text NOT NULL,
          \`fingerprint\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`revoked_at\` integer,
          CONSTRAINT \`tenant_secret_pk\` PRIMARY KEY(\`tenant_id\`, \`secret_id\`),
          CONSTRAINT \`fk_tenant_secret_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tenant_secret_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_tenant_secret\`(\`tenant_id\`, \`owner_user_id\`, \`secret_id\`, \`key_version\`, \`ciphertext\`, \`fingerprint\`, \`status\`, \`time_created\`, \`time_updated\`, \`revoked_at\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`secret_id\`, \`key_version\`, \`ciphertext\`, \`fingerprint\`, \`status\`, \`time_created\`, \`time_updated\`, \`revoked_at\` FROM \`tenant_secret\`;`,
      )
      yield* tx.run(`DROP TABLE \`tenant_secret\`;`)
      yield* tx.run(`ALTER TABLE \`__new_tenant_secret\` RENAME TO \`tenant_secret\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_tenant_usage_ledger\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`id\` text PRIMARY KEY,
          \`settlement_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`currency\` text NOT NULL,
          \`amount_minor\` integer NOT NULL,
          \`source\` text DEFAULT 'settled-runtime-usage' NOT NULL,
          \`recorded_at\` integer NOT NULL,
          CONSTRAINT \`fk_tenant_usage_ledger_tenant_id_identity_tenant_id_fk\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`identity_tenant\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_tenant_usage_ledger_owner_user_id_identity_user_id_fk\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`identity_user\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_tenant_usage_ledger\`(\`tenant_id\`, \`owner_user_id\`, \`id\`, \`settlement_id\`, \`run_id\`, \`currency\`, \`amount_minor\`, \`source\`, \`recorded_at\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`id\`, \`settlement_id\`, \`run_id\`, \`currency\`, \`amount_minor\`, \`source\`, \`recorded_at\` FROM \`tenant_usage_ledger\`;`,
      )
      yield* tx.run(`DROP TABLE \`tenant_usage_ledger\`;`)
      yield* tx.run(`ALTER TABLE \`__new_tenant_usage_ledger\` RENAME TO \`tenant_usage_ledger\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE INDEX \`tenant_audit_export_tenant_idx\` ON \`tenant_audit_export\` (\`tenant_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`tenant_backup_manifest_tenant_idx\` ON \`tenant_backup_manifest\` (\`tenant_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`tenant_backup_manifest_digest_idx\` ON \`tenant_backup_manifest\` (\`tenant_id\`,\`artifact_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`tenant_data_request_status_idx\` ON \`tenant_data_request\` (\`tenant_id\`,\`status\`,\`requested_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`tenant_data_request_digest_idx\` ON \`tenant_data_request\` (\`tenant_id\`,\`request_digest\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`tenant_key_digest_idx\` ON \`tenant_key\` (\`tenant_id\`,\`key_digest\`);`)
      yield* tx.run(`CREATE INDEX \`tenant_secret_status_idx\` ON \`tenant_secret\` (\`tenant_id\`,\`status\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`tenant_usage_settlement_idx\` ON \`tenant_usage_ledger\` (\`tenant_id\`,\`settlement_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`tenant_usage_recorded_idx\` ON \`tenant_usage_ledger\` (\`tenant_id\`,\`recorded_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
