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
  "evolution_artifact",
  "evolution_audit",
  "evolution_evaluation",
  "evolution_exposure",
  "evolution_lease",
  "evolution_observation",
  "evolution_proposal",
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
    const migrations = PostgresSchemaMigrations.filter((item) =>
      ["20260802050000_identity_and_tenant_rls", "20260812143720_evolution_durable_runtime"].includes(item.id),
    )
    expect(migrations).toHaveLength(2)
    const sqlText = migrations.flatMap((migration) => migration.statements).join("\n")
    expect(sqlText).toContain("FORCE ROW LEVEL SECURITY")
    expect(sqlText).toContain("CREATE POLICY tenant_isolation")
    expect(sqlText).toContain("arforge_has_tenant_access")
    for (const table of businessTables) expect(sqlText).toContain(`'${table}'`)
  })

  test("scopes project and session rows through tenant project membership", () => {
    const migration = PostgresSchemaMigrations.find((item) => item.id === "20260814080000_tenant_platform_v1")
    expect(migration).toBeDefined()
    const sqlText = migration?.statements.join("\n") ?? ""
    expect(sqlText).toContain("tenant_project_member_isolation")
    expect(sqlText).toContain("arforge_has_project_access")
    expect(sqlText).toContain("arforge_has_session_access")
    expect(sqlText).toContain("arforge_is_tenant_admin(project_row.tenant_id)")
    expect(sqlText).toContain("ALTER TABLE tenant_project_member FORCE ROW LEVEL SECURITY")
    for (const table of ["project", "project_directory", "workspace", "session", "message", "goal"])
      expect(sqlText).toContain(table)
  })

  test("scopes provider credentials to their owning user inside a tenant", () => {
    const migration = PostgresSchemaMigrations.find((item) => item.id === "20260823100000_credential_tenant_envelope")
    expect(migration).toBeDefined()
    const sqlText = migration?.statements.join("\n") ?? ""
    expect(sqlText).toContain("credential_owner_isolation")
    expect(sqlText).toContain("owner_user_id = arforge_current_user_id()")
    expect(sqlText).toContain("OR arforge_is_tenant_admin(tenant_id)")
    expect(sqlText).toContain("ADD COLUMN encrypted_value")
    expect(sqlText).toContain("ADD COLUMN value_key_version")
    expect(sqlText).toContain("ADD COLUMN value_fingerprint")
  })
})
