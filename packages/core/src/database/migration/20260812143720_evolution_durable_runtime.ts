import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812143720_evolution_durable_runtime",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`evolution_artifact\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`digest\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`uri\` text NOT NULL,
          \`byte_length\` integer NOT NULL,
          \`content\` text NOT NULL,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_artifact_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`digest\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_audit\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`action\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`metadata\` text NOT NULL,
          \`previous_hash\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_audit_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`aggregate_id\`, \`sequence\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_evaluation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`proposal_id\` text NOT NULL,
          \`candidate_digest\` text NOT NULL,
          \`report_digest\` text NOT NULL,
          \`report\` text NOT NULL,
          \`run_id\` text,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_evaluation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_exposure\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`ticket_digest\` text NOT NULL,
          \`ticket\` text NOT NULL,
          \`status\` text NOT NULL,
          \`outcome_input_digest\` text,
          \`receipt_digest\` text,
          \`receipt\` text,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_exposure_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_lease\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`lease_id\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_lease_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`aggregate_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_observation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`proposal_id\` text NOT NULL,
          \`candidate_digest\` text NOT NULL,
          \`cohort\` text NOT NULL,
          \`success\` integer NOT NULL,
          \`score\` real NOT NULL,
          \`safety_incident\` integer NOT NULL,
          \`evidence_ref\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_observation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`evolution_proposal\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`artifact_digest\` text NOT NULL,
          \`artifact_ref\` text NOT NULL,
          \`manifest\` text NOT NULL,
          \`state\` text NOT NULL,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`evaluation_id\` text,
          \`control_run_id\` text,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`evolution_proposal_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`evolution_artifact_kind_idx\` ON \`evolution_artifact\` (\`tenant_id\`,\`owner_user_id\`,\`kind\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_audit_record_hash_idx\` ON \`evolution_audit\` (\`tenant_id\`,\`owner_user_id\`,\`record_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_audit_aggregate_idx\` ON \`evolution_audit\` (\`tenant_id\`,\`owner_user_id\`,\`aggregate_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_evaluation_proposal_digest_idx\` ON \`evolution_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`proposal_id\`,\`report_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_evaluation_proposal_idx\` ON \`evolution_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`proposal_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_exposure_ticket_digest_idx\` ON \`evolution_exposure\` (\`tenant_id\`,\`owner_user_id\`,\`ticket_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_exposure_status_idx\` ON \`evolution_exposure\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_lease_run_idx\` ON \`evolution_lease\` (\`tenant_id\`,\`owner_user_id\`,\`run_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_lease_expiry_idx\` ON \`evolution_lease\` (\`tenant_id\`,\`owner_user_id\`,\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_observation_proposal_hash_idx\` ON \`evolution_observation\` (\`tenant_id\`,\`owner_user_id\`,\`proposal_id\`,\`record_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_observation_proposal_cohort_idx\` ON \`evolution_observation\` (\`tenant_id\`,\`owner_user_id\`,\`proposal_id\`,\`cohort\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`evolution_proposal_candidate_idx\` ON \`evolution_proposal\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_proposal_status_idx\` ON \`evolution_proposal\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`evolution_proposal_digest_idx\` ON \`evolution_proposal\` (\`tenant_id\`,\`owner_user_id\`,\`artifact_digest\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
