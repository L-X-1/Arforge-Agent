import { index, integer, primaryKey, real, sqliteTable, text } from "../database/dialect"
import { Learning } from "@arforge-ai/schema/learning"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"
import { OwnershipColumns } from "../identity/sql"

export const LearningOutcomeTable = sqliteTable(
  "learning_outcome",
  {
    ...OwnershipColumns,
    id: text().$type<Learning.OutcomeID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    run_id: text(),
    action_id: text(),
    evaluation_id: text(),
    evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<string>>(),
    terminal: integer({ mode: "boolean" }),
    verifier_passed: integer({ mode: "boolean" }),
    project_id: text().notNull(),
    workspace_path: text().notNull(),
    turn_index: integer().notNull().default(0),
    user_input: text().notNull(),
    intent: text().notNull().default("general"),
    route: text().notNull().default("agentic"),
    tools: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    success: integer({ mode: "boolean" }).notNull(),
    error_type: text().notNull().default(""),
    error_message: text().notNull().default(""),
    user_feedback: text().notNull().default(""),
    fix_strategy: text().notNull().default(""),
    regression: integer({ mode: "boolean" }).notNull().default(false),
    token_count: integer().notNull().default(0),
    response_time_ms: integer().notNull().default(0),
    tags: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    importance: integer().notNull().default(1),
    injected_context_size: integer().notNull().default(0),
    fingerprint: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("learning_outcome_session_created_idx").on(table.session_id, table.time_created),
    index("learning_outcome_workspace_created_idx").on(table.project_id, table.workspace_path, table.time_created),
    index("learning_outcome_success_created_idx").on(table.success, table.time_created),
    index("learning_outcome_fingerprint_idx").on(table.fingerprint),
  ],
)

export const LearningPatternTable = sqliteTable(
  "learning_pattern",
  {
    ...OwnershipColumns,
    id: text().$type<Learning.PatternID>().primaryKey(),
    project_id: text().notNull(),
    workspace_path: text().notNull(),
    type: text().notNull(),
    description: text().notNull(),
    frequency: integer().notNull().default(1),
    confidence: real().notNull().default(0.5),
    tags: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("learning_pattern_type_frequency_idx").on(
      table.project_id,
      table.workspace_path,
      table.type,
      table.frequency,
    ),
    index("learning_pattern_updated_idx").on(table.time_updated),
  ],
)

export const LearningOutcomePatternTable = sqliteTable(
  "learning_outcome_pattern",
  {
    ...OwnershipColumns,
    outcome_id: text()
      .$type<Learning.OutcomeID>()
      .notNull()
      .references(() => LearningOutcomeTable.id, { onDelete: "cascade" }),
    pattern_id: text()
      .$type<Learning.PatternID>()
      .notNull()
      .references(() => LearningPatternTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.outcome_id, table.pattern_id] }),
    index("learning_outcome_pattern_outcome_idx").on(table.outcome_id),
  ],
)
