import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { Goal } from "@arforge-ai/schema/goal"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { Timestamps } from "../database/schema.sql"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { OwnershipColumns } from "../identity/sql"

export const GoalTable = sqliteTable(
  "goal",
  {
    ...OwnershipColumns,
    id: text().$type<Goal.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    objective: text().$type<Goal.Objective>().notNull(),
    status: text().$type<Goal.Status>().notNull(),
    queue_position: integer().notNull().default(0),
    revision: integer().notNull().default(1),
    prompt_id: text().$type<SessionMessage.ID>(),
    last_error: text().notNull().default(""),
    ...Timestamps,
    time_started: integer(),
    time_finished: integer(),
  },
  (table) => [
    index("goal_session_status_queue_idx").on(table.session_id, table.status, table.queue_position),
    uniqueIndex("goal_session_active_idx")
      .on(table.session_id)
      .where(sql`${table.status} in ('active', 'running', 'paused', 'blocked')`),
  ],
)
