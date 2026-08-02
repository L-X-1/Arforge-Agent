import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { Team } from "@arforge-ai/schema/team"
import { AgentV2 } from "../agent"
import { Timestamps } from "../database/schema.sql"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { OwnershipColumns } from "../identity/sql"

export const TeamTable = sqliteTable(
  "team",
  {
    ...OwnershipColumns,
    id: text().$type<Team.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().$type<Team.Name>().notNull(),
    description: text().$type<Team.Description>().notNull().default(""),
    revision: integer().notNull().default(1),
    next_sequence: integer().notNull().default(1),
    ...Timestamps,
  },
  (table) => [uniqueIndex("team_session_idx").on(table.session_id)],
)

export const TeamMemberTable = sqliteTable(
  "team_member",
  {
    ...OwnershipColumns,
    team_id: text()
      .$type<Team.ID>()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    name_key: text().notNull(),
    name: text().$type<Team.MemberName>().notNull(),
    agent_id: text().$type<AgentV2.ID>().notNull(),
    status: text().$type<Team.MemberStatus>().notNull().default("active"),
    revision: integer().notNull().default(1),
    time_joined: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.team_id, table.name_key] }),
    uniqueIndex("team_member_agent_idx").on(table.team_id, table.agent_id),
    index("team_member_status_idx").on(table.team_id, table.status),
  ],
)

export const TeamMessageTable = sqliteTable(
  "team_message",
  {
    ...OwnershipColumns,
    id: text().$type<Team.MessageID>().primaryKey(),
    team_id: text()
      .$type<Team.ID>()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    sender: text().$type<Team.MemberName>().notNull(),
    recipient: text().notNull(),
    recipients: text({ mode: "json" }).$type<ReadonlyArray<Team.MemberName>>().notNull(),
    kind: text().$type<Team.MessageKind>().notNull(),
    summary: text().$type<Team.Summary>().notNull(),
    message: text().$type<Team.MessageText>().notNull(),
    shutdown_id: text().$type<Team.ShutdownID>(),
    approve: integer({ mode: "boolean" }),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("team_message_sequence_idx").on(table.team_id, table.sequence),
    index("team_message_created_idx").on(table.team_id, table.time_created),
  ],
)

export const TeamShutdownTable = sqliteTable(
  "team_shutdown",
  {
    ...OwnershipColumns,
    id: text().$type<Team.ShutdownID>().primaryKey(),
    team_id: text()
      .$type<Team.ID>()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    member_key: text().notNull(),
    member: text().$type<Team.MemberName>().notNull(),
    status: text().$type<Team.ShutdownStatus>().notNull().default("pending"),
    reason: text().$type<Team.ShutdownReason>().notNull().default(""),
    response_reason: text().$type<Team.ShutdownReason>().notNull().default(""),
    revision: integer().notNull().default(1),
    time_requested: integer()
      .notNull()
      .$default(() => Date.now()),
    time_responded: integer(),
  },
  (table) => [
    index("team_shutdown_member_status_idx").on(table.team_id, table.member_key, table.status),
  ],
)
