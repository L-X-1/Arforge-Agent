import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import {
  WorkflowGraphError,
  WorkflowGraphRuntime,
  discoverWorkflows,
  loadWorkflow,
  previewWorkflow,
  type WorkflowDatabase,
  type WorkflowDefinition,
} from "@arforge-ai/core/analysis/workflow-graph"

function sqliteAdapter(db: Database): WorkflowDatabase {
  return {
    async query(sql, params = []) {
      const statement = db.prepare(sql)
      return statement.all(...(params as never[])) as Array<Record<string, unknown>>
    },
    async execute(sql, params = []) {
      const statement = db.prepare(sql)
      return statement.run(...(params as never[]))
    },
  }
}

function tempWorkspace(): string {
  const root = join(tmpdir(), `arforge-wf-${randomBytes(8).toString("hex")}`)
  mkdirSync(root, { recursive: true })
  return root
}

function makeRuntime(db: Database, runner?: (step: { id: string }, context: Record<string, unknown>) => Promise<string>) {
  const runtime = new WorkflowGraphRuntime({
    database: sqliteAdapter(db),
    runner: runner ?? (async () => "ok"),
  })
  return runtime
}

const DEFINITION: WorkflowDefinition = {
  schema_version: 1,
  name: "release",
  description: "Release pipeline",
  source_path: ".arforge/workflows/release.json",
  steps: [
    { id: "lint", title: "Lint", prompt: "run lint", depends_on: [], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "read" },
    { id: "test", title: "Test", prompt: "run tests", depends_on: ["lint"], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "write" },
    { id: "gate", title: "Approve release", prompt: "Approve?", depends_on: ["test"], continue_on_error: false, kind: "approval", max_attempts: 1, when_step: "", when_statuses: [], access: "read" },
    { id: "deploy", title: "Deploy", prompt: "deploy", depends_on: ["gate"], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "write" },
  ],
}

describe("WorkflowGraph", () => {
  test("executes a linear graph through an approval gate", async () => {
    const db = new Database(":memory:")
    const runtime = makeRuntime(db)
    await runtime.ensureSchema()

    const created = await runtime.createRun({ definition: DEFINITION, sessionId: "ses_wf", workspace: tempWorkspace() })
    expect(created.status).toBe("planned")

    await runtime.start(created.run_id)
    const run = await runtime.wait(created.run_id, 5_000)
    expect(run.status).toBe("waiting_approval")

    await runtime.decideApproval(created.run_id, "gate", true, "approved")
    const final = await runtime.wait(created.run_id, 5_000)
    expect(final.status).toBe("completed")

    const events = await runtime.events(created.run_id)
    const types = events.items.map((event) => event.event_type)
    expect(types).toContain("graph.created")
    expect(types).toContain("node.started")
    expect(types).toContain("node.approval_requested")
    expect(types).toContain("node.approved")
    expect(types).toContain("graph.completed")
  })

  test("blocks nodes on failed dependencies unless the dependency tolerates it", async () => {
    const db = new Database(":memory:")
    const runtime = makeRuntime(db, async (step) => {
      if (step.id === "a") throw new Error("intentional failure")
      return "ok"
    })
    await runtime.ensureSchema()

    const definition: WorkflowDefinition = {
      ...DEFINITION,
      steps: [
        { id: "a", title: "A", prompt: "a", depends_on: [], continue_on_error: true, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "read" },
        { id: "b", title: "B", prompt: "b", depends_on: ["a"], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "write" },
      ],
    }
    const created = await runtime.createRun({ definition, sessionId: "ses_wf", workspace: tempWorkspace() })
    await runtime.start(created.run_id)
    const run = await runtime.wait(created.run_id, 5_000)
    expect(run.status).toBe("failed")

    const nodes = await db.prepare("SELECT node_id, status FROM workflow_graph_nodes ORDER BY position").all()
    expect(nodes[0]).toMatchObject({ node_id: "a", status: "failed" })
    expect(nodes[1]).toMatchObject({ node_id: "b", status: "completed" })
  })

  test("skips steps whose when condition is not met", async () => {
    const db = new Database(":memory:")
    const runtime = makeRuntime(db, async () => "ok")
    await runtime.ensureSchema()

    const definition: WorkflowDefinition = {
      ...DEFINITION,
      steps: [
        { id: "main", title: "Main", prompt: "main", depends_on: [], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "read" },
        { id: "extra", title: "Extra", prompt: "extra", depends_on: [], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "main", when_statuses: ["failed"], access: "read" },
      ],
    }
    const created = await runtime.createRun({ definition, sessionId: "ses_wf", workspace: tempWorkspace() })
    await runtime.start(created.run_id)
    const run = await runtime.wait(created.run_id, 5_000)
    expect(run.status).toBe("completed")
    const extra = await db.prepare("SELECT status FROM workflow_graph_nodes WHERE node_id='extra'").get()
    expect(extra).toMatchObject({ status: "skipped" })
  })

  test("pause and resume control the run", async () => {
    const db = new Database(":memory:")
    let calls = 0
    const runtime = makeRuntime(db, async () => {
      calls += 1
      return "ok"
    })
    await runtime.ensureSchema()

    const created = await runtime.createRun({ definition: DEFINITION, sessionId: "ses_wf", workspace: tempWorkspace() })
    await runtime.start(created.run_id)
    await runtime.pause(created.run_id)
    let paused = await runtime.getRun(created.run_id)
    const deadline = Date.now() + 5_000
    while (paused.status !== "paused" && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      paused = await runtime.getRun(created.run_id)
    }
    expect(paused.status).toBe("paused")

    await runtime.resume(created.run_id)
    const final = await runtime.wait(created.run_id, 5_000)
    expect(final.status).toBe("waiting_approval")
    expect(calls).toBeGreaterThan(0)
  })

  test("cancel marks the run as cancelled", async () => {
    const db = new Database(":memory:")
    const runtime = makeRuntime(db)
    await runtime.ensureSchema()
    const created = await runtime.createRun({ definition: DEFINITION, sessionId: "ses_wf", workspace: tempWorkspace() })
    await runtime.start(created.run_id)
    await runtime.cancel(created.run_id)
    const run = await runtime.wait(created.run_id, 5_000)
    expect(run.status).toBe("cancelled")
  })

  test("retry resets failed nodes", async () => {
    const db = new Database(":memory:")
    let failFirst = true
    const runtime = makeRuntime(db, async () => {
      if (failFirst) {
        failFirst = false
        throw new Error("transient failure")
      }
      return "ok"
    })
    await runtime.ensureSchema()

    const definition: WorkflowDefinition = {
      ...DEFINITION,
      steps: [
        { id: "a", title: "A", prompt: "a", depends_on: [], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "read" },
        { id: "b", title: "B", prompt: "b", depends_on: ["a"], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "write" },
      ],
    }
    const created = await runtime.createRun({ definition, sessionId: "ses_wf", workspace: tempWorkspace() })
    await runtime.start(created.run_id)
    let run = await runtime.wait(created.run_id, 5_000)
    expect(run.status).toBe("failed")

    await runtime.retryNode(created.run_id, "a", true)
    run = await runtime.wait(created.run_id, 5_000)
    expect(run.status).toBe("completed")
  })

  test("discovers, loads, and previews workflow definitions", () => {
    const workspace = tempWorkspace()
    const dir = join(workspace, ".arforge", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "demo.json"),
      JSON.stringify({
        name: "demo",
        description: "Demo workflow",
        steps: [
          { id: "first", title: "First", prompt: "run first", kind: "agent" },
          { id: "second", title: "Second", prompt: "run second", depends_on: ["first"], kind: "command" },
        ],
      }),
      "utf8",
    )

    const discovered = discoverWorkflows(workspace)
    expect(discovered).toHaveLength(1)
    const definition = loadWorkflow(discovered[0], workspace)
    expect(definition.name).toBe("demo")
    const preview = previewWorkflow(definition)
    expect(preview).toMatchObject({ steps: 2, edges: [{ from: "first", to: "second" }] })
  })

  test("rejects invalid definitions and unknown steps", async () => {
    const runtime = makeRuntime(new Database(":memory:"))
    await expect(
      runtime.createRun({
        definition: {
          ...DEFINITION,
          steps: [{ id: "a", title: "A", prompt: "a", depends_on: ["missing"], continue_on_error: false, kind: "agent", max_attempts: 1, when_step: "", when_statuses: [], access: "read" }],
        },
        sessionId: "ses_wf",
        workspace: tempWorkspace(),
      }),
    ).rejects.toThrow(WorkflowGraphError)
  })
})
