import { integer, sqliteTable, text } from "./database/dialect"

export const DataMigrationTable = sqliteTable("data_migration", {
  name: text().primaryKey(),
  time_completed: integer().notNull(),
})
