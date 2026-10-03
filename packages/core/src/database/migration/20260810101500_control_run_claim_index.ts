import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * The durable event stream remains authoritative for ControlRun state.  These
 * two tables are only immutable identity/rebuild projections; keeping them
 * separate prevents a lookup index from becoming a second state machine.
 */
export default {
  id: "20260810101500_control_run_claim_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`control_run_claim\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`binding_digest\` text NOT NULL,
          \`base_binding_digest\` text NOT NULL,
          \`generation\` integer NOT NULL CHECK (\`generation\` >= 0),
          \`operation_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`control_plane_id\` text NOT NULL,
          \`location\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`canonical_request_id\` text NOT NULL,
          \`claim_digest\` text NOT NULL,
          \`canonical_authorization_digest\` text NOT NULL,
          \`canonical_action_id\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`input_digest\` text NOT NULL,
          \`payload_digest\` text NOT NULL,
          \`created_run_digest\` text NOT NULL,
          \`created_sequence\` integer NOT NULL CHECK (\`created_sequence\` = 0),
          \`time_created\` integer NOT NULL,
          PRIMARY KEY (\`tenant_id\`, \`owner_user_id\`, \`binding_digest\`)
        );
      `)
      yield* tx.run(
        "CREATE UNIQUE INDEX `control_run_claim_base_generation_uidx` ON `control_run_claim` (`tenant_id`,`owner_user_id`,`base_binding_digest`,`generation`)",
      )
      yield* tx.run(
        "CREATE UNIQUE INDEX `control_run_claim_operation_uidx` ON `control_run_claim` (`tenant_id`,`owner_user_id`,`operation_id`)",
      )
      yield* tx.run(
        "CREATE UNIQUE INDEX `control_run_claim_run_uidx` ON `control_run_claim` (`tenant_id`,`owner_user_id`,`run_id`)",
      )
      yield* tx.run(
        "CREATE INDEX `control_run_claim_subject_idx` ON `control_run_claim` (`tenant_id`,`owner_user_id`,`control_plane_id`,`location`,`project_id`)",
      )
      yield* tx.run(`
        CREATE TABLE \`control_run_request_alias\` (
          \`tenant_id\` text NOT NULL,
          \`owner_user_id\` text NOT NULL,
          \`alias_digest\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`control_plane_id\` text NOT NULL,
          \`binding_digest\` text NOT NULL,
          \`presented_authorization_digest\` text NOT NULL,
          \`presented_action_id\` text NOT NULL,
          \`presented_snapshot_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          PRIMARY KEY (\`tenant_id\`, \`owner_user_id\`, \`alias_digest\`),
          FOREIGN KEY (\`tenant_id\`, \`owner_user_id\`, \`binding_digest\`)
            REFERENCES \`control_run_claim\` (\`tenant_id\`, \`owner_user_id\`, \`binding_digest\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(
        "CREATE UNIQUE INDEX `control_run_request_alias_owner_request_uidx` ON `control_run_request_alias` (`tenant_id`,`owner_user_id`,`control_plane_id`,`request_id`)",
      )
      yield* tx.run(
        "CREATE INDEX `control_run_request_alias_binding_idx` ON `control_run_request_alias` (`tenant_id`,`owner_user_id`,`binding_digest`,`time_created`)",
      )
    })
  },
} satisfies DatabaseMigration.Migration
