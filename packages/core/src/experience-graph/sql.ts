import { index, integer, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { OwnershipColumns } from "../identity/sql"
import type { NodeKind, RelationKind } from "../experience-graph"

/** Durable, polymorphic edges between verified experience graph nodes. */
export const ExperienceGraphRelationTable = sqliteTable(
  "experience_graph_relation",
  {
    ...OwnershipColumns,
    id: text().primaryKey(),
    source_kind: text().$type<NodeKind>().notNull(),
    source_id: text().notNull(),
    source_digest: text().notNull(),
    target_kind: text().$type<NodeKind>().notNull(),
    target_id: text().notNull(),
    target_digest: text().notNull(),
    relation_kind: text().$type<RelationKind>().notNull(),
    evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    policy_version: text().notNull(),
    digest: text().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("experience_graph_relation_identity_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.source_kind,
      table.source_id,
      table.target_kind,
      table.target_id,
      table.relation_kind,
    ),
    index("experience_graph_relation_source_idx").on(table.source_kind, table.source_id, table.time_created),
    index("experience_graph_relation_target_idx").on(table.target_kind, table.target_id, table.time_created),
    index("experience_graph_relation_kind_idx").on(table.relation_kind, table.time_created),
  ],
)
