import { sqliteTable, text } from "../database/dialect"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"
import { OwnershipColumns } from "../identity/sql"

export const SessionShareTable = sqliteTable("session_share", {
  ...OwnershipColumns,
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  id: text().notNull(),
  secret: text().notNull(),
  url: text().notNull(),
  ...Timestamps,
})
