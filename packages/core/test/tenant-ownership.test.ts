import { describe, expect, test } from "bun:test"
import { Database } from "@arforge-ai/core/database/database"
import { PostgresSchemaMigrations } from "@arforge-ai/core/database/postgres-schema.gen"
import { Effect } from "effect"
import { sql } from "drizzle-orm"

const businessTables = [
  "account",
  "account_state",
  "control_account",
  "workspace",
  "credential",
  "event_sequence",
  "event",
  "feedback",
  "goal",
  "learning_outcome",
  "learning_pattern",
  "learning_outcome_pattern",
  "memory",
  "permission",
  "project",
  "project_directory",
  "session",
  "session_tag",
  "message",
  "part",
  "todo",
  "session_message",
  "session_checkpoint",
  "scheduled_prompt",
  "session_input",
  "session_context_epoch",
  "session_share",
  "task_graph_task",
  "task_graph_edge",
  "team",
  "team_member",
  "team_message",
  "team_shutdown",
  "workflow_graph_runs",
  "workflow_graph_nodes",
  "workflow_graph_events",
] as const

describe("tenant ownership", () => {
  test("adds non-null ownership columns to every core business table", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        for (const table of businessTables) {
          const columns = yield* db
            .all<{ name: string; notnull: number; dflt_value: string | null }>(sql.raw(`PRAGMA table_info('${table}')`))
            .pipe(Effect.orDie)
          expect(columns.find((column) => column.name === "tenant_id")).toMatchObject({
            notnull: 1,
            dflt_value: "'ten_local'",
          })
          expect(columns.find((column) => column.name === "owner_user_id")).toMatchObject({
            notnull: 1,
            dflt_value: "'usr_local'",
          })
        }
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  })

  test("forces PostgreSQL RLS across the complete owned table set", () => {
    const migration = PostgresSchemaMigrations.find((item) => item.id === "20260802050000_identity_and_tenant_rls")
    expect(migration).toBeDefined()
    const sqlText = migration?.statements.join("\n") ?? ""
    expect(sqlText).toContain("FORCE ROW LEVEL SECURITY")
    expect(sqlText).toContain("CREATE POLICY tenant_isolation")
    expect(sqlText).toContain("arforge_has_tenant_access")
    for (const table of businessTables) expect(sqlText).toContain(`'${table}'`)
  })
})
