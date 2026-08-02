import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726072751_task_graph",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`task_graph_edge\` (
          \`session_id\` text NOT NULL,
          \`blocker_id\` text NOT NULL,
          \`blocked_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`task_graph_edge_pk\` PRIMARY KEY(\`blocker_id\`, \`blocked_id\`),
          CONSTRAINT \`fk_task_graph_edge_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_task_graph_edge_blocker_id_task_graph_task_id_fk\` FOREIGN KEY (\`blocker_id\`) REFERENCES \`task_graph_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_task_graph_edge_blocked_id_task_graph_task_id_fk\` FOREIGN KEY (\`blocked_id\`) REFERENCES \`task_graph_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`task_graph_task\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text DEFAULT '' NOT NULL,
          \`active_form\` text DEFAULT '' NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`owner\` text,
          \`metadata\` text DEFAULT '{}' NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_task_graph_task_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`task_graph_edge_session_blocked_idx\` ON \`task_graph_edge\` (\`session_id\`,\`blocked_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`task_graph_edge_session_blocker_idx\` ON \`task_graph_edge\` (\`session_id\`,\`blocker_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`task_graph_session_status_created_idx\` ON \`task_graph_task\` (\`session_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`task_graph_session_owner_status_idx\` ON \`task_graph_task\` (\`session_id\`,\`owner\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`task_graph_session_title_idx\` ON \`task_graph_task\` (\`session_id\`,\`title\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
