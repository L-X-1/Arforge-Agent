import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Mailbox } from "@arforge-ai/schema/mailbox"
import { TaskGraph } from "@arforge-ai/schema/task-graph"
import { Team } from "@arforge-ai/schema/team"
import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { OwnershipColumns } from "../identity/sql"
import { Timestamps } from "../database/schema.sql"
import { TaskGraphTable } from "../task-graph/sql"
import { TeamTable } from "../team/sql"

export const MailboxMessageTable = sqliteTable(
  "mailbox_message",
  {
    ...OwnershipColumns,
    id: text().$type<Mailbox.MessageID>().notNull(),
    protocol_version: integer().$type<Mailbox.ProtocolVersion>().notNull().default(1),
    team_id: text()
      .$type<Team.ID>()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    run_id: text().$type<AgentRuntime.RunID>().notNull(),
    task_id: text()
      .$type<TaskGraph.ID>()
      .notNull()
      .references(() => TaskGraphTable.id, { onDelete: "cascade" }),
    sender: text().$type<Team.MemberName>().notNull(),
    recipient: text().$type<Team.MemberName>().notNull(),
    sequence: integer().notNull(),
    idempotency_key: text().$type<Mailbox.IdempotencyKey>().notNull(),
    kind: text().$type<Mailbox.Kind>().notNull(),
    summary: text().$type<Mailbox.Summary>().notNull(),
    message: text().$type<Mailbox.Text>().notNull(),
    artifact_refs: text({ mode: "json" })
      .$type<ReadonlyArray<AgentRuntime.ArtifactID>>()
      .notNull(),
    evidence_refs: text({ mode: "json" })
      .$type<ReadonlyArray<AgentRuntime.EvidenceID>>()
      .notNull(),
    digest: text().$type<Mailbox.Digest>().notNull(),
    status: text().$type<Mailbox.MessageStatus>().notNull().default("queued"),
    cancel_reason: text().$type<Mailbox.Reason>(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("mailbox_message_idempotency_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.team_id,
      table.run_id,
      table.task_id,
      table.sender,
      table.recipient,
      table.idempotency_key,
    ),
    index("mailbox_message_thread_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.team_id,
      table.run_id,
      table.task_id,
      table.recipient,
      table.sequence,
    ),
    index("mailbox_message_status_idx").on(table.tenant_id, table.owner_user_id, table.status, table.time_updated),
  ],
)

export const MailboxReceiptTable = sqliteTable(
  "mailbox_receipt",
  {
    ...OwnershipColumns,
    id: text().$type<Mailbox.ReceiptID>().notNull(),
    protocol_version: integer().$type<Mailbox.ProtocolVersion>().notNull().default(1),
    message_id: text().$type<Mailbox.MessageID>().notNull(),
    team_id: text().$type<Team.ID>().notNull(),
    run_id: text().$type<AgentRuntime.RunID>().notNull(),
    task_id: text().$type<TaskGraph.ID>().notNull(),
    recipient: text().$type<Team.MemberName>().notNull(),
    status: text().$type<Mailbox.AckStatus>().notNull(),
    message_digest: text().$type<Mailbox.Digest>().notNull(),
    reason: text().$type<Mailbox.Reason>().notNull().default(""),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    foreignKey({
      name: "mailbox_receipt_message_fk",
      columns: [table.tenant_id, table.owner_user_id, table.message_id],
      foreignColumns: [MailboxMessageTable.tenant_id, MailboxMessageTable.owner_user_id, MailboxMessageTable.id],
    }).onDelete("cascade"),
    uniqueIndex("mailbox_receipt_message_recipient_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.message_id,
      table.recipient,
    ),
    index("mailbox_receipt_thread_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.team_id,
      table.run_id,
      table.task_id,
      table.recipient,
      table.time_created,
    ),
  ],
)
