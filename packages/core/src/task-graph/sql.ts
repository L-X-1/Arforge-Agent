import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { TaskGraph } from "@arforge-ai/schema/task-graph"
import { Timestamps } from "../database/schema.sql"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { OwnershipColumns } from "../identity/sql"

export const TaskGraphTable = sqliteTable(
  "task_graph_task",
  {
    ...OwnershipColumns,
    id: text().$type<TaskGraph.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    title: text().$type<TaskGraph.Title>().notNull(),
    description: text().$type<TaskGraph.Description>().notNull().default(""),
    active_form: text().$type<TaskGraph.ActiveForm>().notNull().default(""),
    status: text().$type<TaskGraph.Status>().notNull().default("pending"),
    owner: text().$type<TaskGraph.Owner>(),
    metadata: text({ mode: "json" })
      .$type<TaskGraph.Metadata>()
      .notNull()
      .$default(() => ({})),
    revision: integer().notNull().default(1),
    ...Timestamps,
    time_completed: integer(),
  },
  (table) => [
    index("task_graph_session_status_created_idx").on(table.session_id, table.status, table.time_created),
    index("task_graph_session_owner_status_idx").on(table.session_id, table.owner, table.status),
    uniqueIndex("task_graph_session_title_idx").on(table.session_id, table.title),
  ],
)

export const TaskGraphEdgeTable = sqliteTable(
  "task_graph_edge",
  {
    ...OwnershipColumns,
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    blocker_id: text()
      .$type<TaskGraph.ID>()
      .notNull()
      .references(() => TaskGraphTable.id, { onDelete: "cascade" }),
    blocked_id: text()
      .$type<TaskGraph.ID>()
      .notNull()
      .references(() => TaskGraphTable.id, { onDelete: "cascade" }),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.blocker_id, table.blocked_id] }),
    index("task_graph_edge_session_blocked_idx").on(table.session_id, table.blocked_id),
    index("task_graph_edge_session_blocker_idx").on(table.session_id, table.blocker_id),
  ],
)
