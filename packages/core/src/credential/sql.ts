import { integer, sqliteTable, text } from "../database/dialect"
import { Timestamps } from "../database/schema.sql"
import type { Credential } from "../credential"
import { OwnershipColumns } from "../identity/sql"

export const CredentialTable = sqliteTable("credential", {
  ...OwnershipColumns,
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  label: text().notNull(),
  value: text({ mode: "json" }).$type<Credential.Value>().notNull(),
  connector_id: text(),
  method_id: text(),
  active: integer({ mode: "boolean" }),
  ...Timestamps,
})
