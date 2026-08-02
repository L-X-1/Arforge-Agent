import { index, integer, primaryKey, sqliteTable, text } from "../database/dialect"
import { OwnershipColumns } from "../identity/sql"

/**
 * Canonical durable state for the preserved Python workflow orchestrator.
 *
 * Core owns the schema and migration lifecycle. The Python capability runtime
 * is the bounded writer that schedules graph nodes; App, Desktop, CLI and
 * Server reach it through the typed AgentCapability contract.
 */
export const WorkflowGraphRunTable = sqliteTable(
  "workflow_graph_runs",
  {
    ...OwnershipColumns,
    run_id: text().primaryKey(),
    session_id: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    source_path: text().notNull(),
    workspace: text().notNull(),
    definition_json: text().notNull(),
    permission_mode: text().notNull(),
    status: text().notNull(),
    control: text().notNull().default(""),
    max_parallel: integer().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    started_at: text(),
    finished_at: text(),
    last_error: text().notNull().default(""),
    lease_owner: text().notNull().default(""),
    lease_expires_at: text(),
  },
  (table) => [
    index("workflow_graph_run_session_updated_idx").on(table.session_id, table.updated_at),
    index("workflow_graph_run_status_lease_idx").on(table.status, table.lease_expires_at),
  ],
)

export const WorkflowGraphNodeTable = sqliteTable(
  "workflow_graph_nodes",
  {
    ...OwnershipColumns,
    run_id: text()
      .notNull()
      .references(() => WorkflowGraphRunTable.run_id, { onDelete: "cascade" }),
    node_id: text().notNull(),
    position: integer().notNull(),
    title: text().notNull(),
    kind: text().notNull(),
    access: text().notNull().default("write"),
    status: text().notNull(),
    attempt: integer().notNull().default(0),
    max_attempts: integer().notNull().default(1),
    depends_on_json: text().notNull(),
    continue_on_error: integer({ mode: "boolean" }).notNull().default(false),
    when_step: text().notNull().default(""),
    when_statuses_json: text().notNull().default("[]"),
    output: text().notNull().default(""),
    error: text().notNull().default(""),
    started_at: text(),
    finished_at: text(),
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.node_id] }),
    index("workflow_graph_node_run_position_idx").on(table.run_id, table.position),
    index("workflow_graph_node_run_status_idx").on(table.run_id, table.status),
  ],
)

export const WorkflowGraphEventTable = sqliteTable(
  "workflow_graph_events",
  {
    ...OwnershipColumns,
    run_id: text()
      .notNull()
      .references(() => WorkflowGraphRunTable.run_id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    event_type: text().notNull(),
    node_id: text().notNull().default(""),
    data_json: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.sequence] }),
    index("workflow_graph_event_run_created_idx").on(table.run_id, table.created_at),
  ],
)
