import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260822230244_workflow_node_read_default",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_workflow_graph_nodes\` (
          \`tenant_id\` text DEFAULT 'ten_local' NOT NULL,
          \`owner_user_id\` text DEFAULT 'usr_local' NOT NULL,
          \`run_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`title\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`access\` text DEFAULT 'read' NOT NULL,
          \`status\` text NOT NULL,
          \`attempt\` integer DEFAULT 0 NOT NULL,
          \`max_attempts\` integer DEFAULT 1 NOT NULL,
          \`depends_on_json\` text NOT NULL,
          \`continue_on_error\` integer DEFAULT false NOT NULL,
          \`when_step\` text DEFAULT '' NOT NULL,
          \`when_statuses_json\` text DEFAULT '[]' NOT NULL,
          \`output\` text DEFAULT '' NOT NULL,
          \`error\` text DEFAULT '' NOT NULL,
          \`started_at\` text,
          \`finished_at\` text,
          CONSTRAINT \`workflow_graph_nodes_pk\` PRIMARY KEY(\`run_id\`, \`node_id\`),
          CONSTRAINT \`fk_workflow_graph_nodes_run_id_workflow_graph_runs_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`workflow_graph_runs\`(\`run_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_workflow_graph_nodes\`(\`tenant_id\`, \`owner_user_id\`, \`run_id\`, \`node_id\`, \`position\`, \`title\`, \`kind\`, \`access\`, \`status\`, \`attempt\`, \`max_attempts\`, \`depends_on_json\`, \`continue_on_error\`, \`when_step\`, \`when_statuses_json\`, \`output\`, \`error\`, \`started_at\`, \`finished_at\`) SELECT \`tenant_id\`, \`owner_user_id\`, \`run_id\`, \`node_id\`, \`position\`, \`title\`, \`kind\`, \`access\`, \`status\`, \`attempt\`, \`max_attempts\`, \`depends_on_json\`, \`continue_on_error\`, \`when_step\`, \`when_statuses_json\`, \`output\`, \`error\`, \`started_at\`, \`finished_at\` FROM \`workflow_graph_nodes\`;`,
      )
      yield* tx.run(`DROP TABLE \`workflow_graph_nodes\`;`)
      yield* tx.run(`ALTER TABLE \`__new_workflow_graph_nodes\` RENAME TO \`workflow_graph_nodes\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE INDEX \`workflow_graph_node_run_position_idx\` ON \`workflow_graph_nodes\` (\`run_id\`,\`position\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workflow_graph_node_run_status_idx\` ON \`workflow_graph_nodes\` (\`run_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
