import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726064348_session_organization",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_checkpoint\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`message_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_checkpoint_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_checkpoint_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_tag\` (
          \`session_id\` text NOT NULL,
          \`normalized\` text NOT NULL,
          \`value\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_tag_pk\` PRIMARY KEY(\`session_id\`, \`normalized\`),
          CONSTRAINT \`fk_session_tag_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_message\` ADD \`time_rewound\` integer;`)
      yield* tx.run(
        `CREATE INDEX \`session_checkpoint_session_created_idx\` ON \`session_checkpoint\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_checkpoint_session_sequence_idx\` ON \`session_checkpoint\` (\`session_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_tag_session_position_idx\` ON \`session_tag\` (\`session_id\`,\`position\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_tag_normalized_idx\` ON \`session_tag\` (\`normalized\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
