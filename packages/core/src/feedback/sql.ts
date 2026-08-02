import { index, integer, sqliteTable, text } from "../database/dialect"
import { Feedback } from "@arforge-ai/schema/feedback"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { Learning } from "@arforge-ai/schema/learning"
import { LearningOutcomeTable } from "../learning/sql"
import { OwnershipColumns } from "../identity/sql"

export const FeedbackTable = sqliteTable(
  "feedback",
  {
    ...OwnershipColumns,
    id: text().$type<Feedback.ID>().primaryKey(),
    category: text().$type<Feedback.Category>().notNull(),
    rating: integer().$type<Feedback.Rating>().notNull(),
    message: text().$type<Feedback.Message>().notNull(),
    workspace_path: text().notNull(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    learning_outcome_id: text()
      .$type<Learning.OutcomeID>()
      .references(() => LearningOutcomeTable.id, { onDelete: "set null" }),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("feedback_workspace_created_idx").on(table.workspace_path, table.time_created),
    index("feedback_workspace_category_created_idx").on(
      table.workspace_path,
      table.category,
      table.time_created,
    ),
    index("feedback_created_idx").on(table.time_created),
    index("feedback_category_created_idx").on(table.category, table.time_created),
  ],
)
