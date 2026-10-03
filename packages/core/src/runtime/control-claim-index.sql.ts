import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { OwnershipColumns } from "../identity/sql"
import { sql } from "drizzle-orm"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

/**
 * Immutable projection of the first durable ControlRunCreated event for one
 * canonical, request-independent control binding. Run state deliberately
 * stays in the durable event stream and is never duplicated here.
 */
export const ControlRunClaimTable = sqliteTable(
  "control_run_claim",
  {
    ...OwnershipColumns,
    binding_digest: text().notNull(),
    base_binding_digest: text().notNull(),
    generation: integer().notNull(),
    operation_id: text().$type<AgentRuntime.ControlOperationID>().notNull(),
    run_id: text().$type<AgentRuntime.RunID>().notNull(),
    control_plane_id: text().$type<AgentRuntime.ControlPlaneID>().notNull(),
    location: text().notNull(),
    project_id: text().notNull(),
    actor: text().$type<AgentRuntime.ControlPlaneSubject["actor"]>().notNull(),
    canonical_request_id: text().$type<AgentRuntime.ControlPlaneRequestID>().notNull(),
    claim_digest: text().notNull(),
    canonical_authorization_digest: text().notNull(),
    canonical_action_id: text().$type<AgentRuntime.ActionID>().notNull(),
    policy_version: text().notNull(),
    input_digest: text().notNull(),
    payload_digest: text().notNull(),
    created_run_digest: text().notNull(),
    created_sequence: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.binding_digest] }),
    check("control_run_claim_generation_check", sql`${table.generation} >= 0`),
    check("control_run_claim_created_sequence_check", sql`${table.created_sequence} = 0`),
    uniqueIndex("control_run_claim_owner_binding_uidx").on(table.tenant_id, table.owner_user_id, table.binding_digest),
    uniqueIndex("control_run_claim_base_generation_uidx").on(
      table.tenant_id,
      table.owner_user_id,
      table.base_binding_digest,
      table.generation,
    ),
    uniqueIndex("control_run_claim_operation_uidx").on(table.tenant_id, table.owner_user_id, table.operation_id),
    uniqueIndex("control_run_claim_run_uidx").on(table.tenant_id, table.owner_user_id, table.run_id),
    index("control_run_claim_subject_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.control_plane_id,
      table.location,
      table.project_id,
    ),
  ],
)

/**
 * Append-only mapping from a presented request identity to the immutable
 * canonical claim. A request can never be rebound, even after the run reaches
 * a terminal state.
 */
export const ControlRunRequestAliasTable = sqliteTable(
  "control_run_request_alias",
  {
    ...OwnershipColumns,
    alias_digest: text().notNull(),
    request_id: text().$type<AgentRuntime.ControlPlaneRequestID>().notNull(),
    control_plane_id: text().$type<AgentRuntime.ControlPlaneID>().notNull(),
    binding_digest: text().notNull(),
    presented_authorization_digest: text().notNull(),
    presented_action_id: text().$type<AgentRuntime.ActionID>().notNull(),
    presented_snapshot_digest: text().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.alias_digest] }),
    uniqueIndex("control_run_request_alias_owner_request_uidx").on(
      table.tenant_id,
      table.owner_user_id,
      table.control_plane_id,
      table.request_id,
    ),
    index("control_run_request_alias_binding_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.binding_digest,
      table.time_created,
    ),
    foreignKey({
      name: "control_run_request_alias_claim_fk",
      columns: [table.tenant_id, table.owner_user_id, table.binding_digest],
      foreignColumns: [
        ControlRunClaimTable.tenant_id,
        ControlRunClaimTable.owner_user_id,
        ControlRunClaimTable.binding_digest,
      ],
    }).onDelete("restrict"),
  ],
)
