import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813025236_stage7_durable_experience_skill",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`experience_audit\` (
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
          CONSTRAINT \`experience_audit_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`aggregate_id\`, \`sequence\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_candidate\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`problem_signature\` text NOT NULL,
          \`applicable_scope\` text NOT NULL,
          \`conditions\` text NOT NULL,
          \`attempted_strategy\` text NOT NULL,
          \`counterexamples\` text NOT NULL,
          \`support_count\` integer NOT NULL,
          \`source_run_ids\` text NOT NULL,
          \`source_support_ids\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`evaluation_digest\` text,
          \`review_actor\` text,
          \`review_reason\` text,
          \`review_status\` text NOT NULL,
          \`status\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`expiry_at\` integer,
          \`digest\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_candidate_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_evaluation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`evaluation_digest\` text NOT NULL,
          \`comparison\` text NOT NULL,
          \`passed\` integer NOT NULL,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_evaluation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_evidence\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`action_id\` text NOT NULL,
          \`observation_id\` text NOT NULL,
          \`record_digest\` text NOT NULL,
          \`record\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_evidence_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_record\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`support_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`action_id\` text NOT NULL,
          \`evaluation_id\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`record_digest\` text NOT NULL,
          \`record\` text NOT NULL,
          \`policy_version\` text NOT NULL,
          \`promoted_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_record_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`experience_support\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`action_id\` text NOT NULL,
          \`evaluation_id\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`support_digest\` text NOT NULL,
          \`learning_outcome_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`experience_support_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_audit\` (
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
          CONSTRAINT \`skill_audit_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`aggregate_id\`, \`sequence\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_canary_observation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`evaluation_id\` text NOT NULL,
          \`cohort_key_digest\` text NOT NULL,
          \`success\` integer NOT NULL,
          \`safety_incident\` integer NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`record_digest\` text NOT NULL,
          \`record\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_canary_observation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_deployment\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`skill_id\` text NOT NULL,
          \`active_candidate_id\` text NOT NULL,
          \`previous_candidate_id\` text,
          \`generation\` integer NOT NULL,
          \`deployment_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_deployment_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`skill_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_evaluation\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`candidate_id\` text NOT NULL,
          \`report_digest\` text NOT NULL,
          \`report\` text NOT NULL,
          \`passed\` integer NOT NULL,
          \`created_by\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_evaluation_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_version\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`id\` text NOT NULL,
          \`skill_id\` text NOT NULL,
          \`version\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`skill_record\` text NOT NULL,
          \`manifest\` text NOT NULL,
          \`artifact_files\` text NOT NULL,
          \`tests\` text NOT NULL,
          \`scan\` text NOT NULL,
          \`source_experience_ids\` text NOT NULL,
          \`source_evidence_ids\` text NOT NULL,
          \`evaluation_id\` text NOT NULL,
          \`evaluation_digest\` text,
          \`evaluation_passed\` integer,
          \`baseline_version_id\` text,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`policy_version\` text NOT NULL,
          \`created_by\` text NOT NULL,
          \`review_actor\` text,
          \`review_reason\` text,
          \`traffic_percent\` integer,
          \`canary_digest\` text,
          \`rollback_version\` text,
          \`record_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`skill_version_pk\` PRIMARY KEY(\`tenant_id\`, \`owner_user_id\`, \`id\`)
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_audit_record_hash_idx\` ON \`experience_audit\` (\`tenant_id\`,\`owner_user_id\`,\`record_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_audit_aggregate_idx\` ON \`experience_audit\` (\`tenant_id\`,\`owner_user_id\`,\`aggregate_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_candidate_digest_idx\` ON \`experience_candidate\` (\`tenant_id\`,\`owner_user_id\`,\`digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_candidate_status_idx\` ON \`experience_candidate\` (\`tenant_id\`,\`owner_user_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_evaluation_candidate_digest_idx\` ON \`experience_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`evaluation_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_evaluation_candidate_idx\` ON \`experience_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_evidence_record_digest_idx\` ON \`experience_evidence\` (\`tenant_id\`,\`owner_user_id\`,\`record_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_evidence_run_action_idx\` ON \`experience_evidence\` (\`tenant_id\`,\`owner_user_id\`,\`run_id\`,\`action_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_record_support_idx\` ON \`experience_record\` (\`tenant_id\`,\`owner_user_id\`,\`support_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_record_digest_idx\` ON \`experience_record\` (\`tenant_id\`,\`owner_user_id\`,\`record_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_record_candidate_idx\` ON \`experience_record\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_support_candidate_run_idx\` ON \`experience_support\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`run_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`experience_support_digest_idx\` ON \`experience_support\` (\`tenant_id\`,\`owner_user_id\`,\`support_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`experience_support_candidate_idx\` ON \`experience_support\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_audit_record_hash_idx\` ON \`skill_audit\` (\`tenant_id\`,\`owner_user_id\`,\`record_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`skill_audit_aggregate_idx\` ON \`skill_audit\` (\`tenant_id\`,\`owner_user_id\`,\`aggregate_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_canary_idempotency_idx\` ON \`skill_canary_observation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_canary_record_digest_idx\` ON \`skill_canary_observation\` (\`tenant_id\`,\`owner_user_id\`,\`record_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`skill_canary_candidate_idx\` ON \`skill_canary_observation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_deployment_digest_idx\` ON \`skill_deployment\` (\`tenant_id\`,\`owner_user_id\`,\`deployment_digest\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_evaluation_candidate_idx\` ON \`skill_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`candidate_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_evaluation_digest_idx\` ON \`skill_evaluation\` (\`tenant_id\`,\`owner_user_id\`,\`report_digest\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_version_identity_idx\` ON \`skill_version\` (\`tenant_id\`,\`owner_user_id\`,\`skill_id\`,\`version\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`skill_version_digest_idx\` ON \`skill_version\` (\`tenant_id\`,\`owner_user_id\`,\`digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`skill_version_status_idx\` ON \`skill_version\` (\`tenant_id\`,\`owner_user_id\`,\`skill_id\`,\`status\`,\`time_updated\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
