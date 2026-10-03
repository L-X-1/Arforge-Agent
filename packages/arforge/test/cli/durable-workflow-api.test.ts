import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createOperationsApi } from "../../src/cli/operations-api"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Durable Workflow operations API", () => {
  test("starts, pauses at approval, resumes, and completes through HTTP", async () => {
    await using workspace = await tmpdir()
    const api = createOperationsApi(workspace.path)
    const location = { location: { directory: workspace.path } }
    const workflowRoot = join(workspace.path, ".arforge", "workflows")
    await mkdir(workflowRoot, { recursive: true })
    await Bun.write(
      join(workflowRoot, "approval.json"),
      JSON.stringify({
        schema_version: 2,
        name: "approval_flow",
        description: "Durable HTTP workflow contract",
        steps: [
          { id: "gate", title: "Human gate", kind: "approval" },
          {
            id: "agent",
            title: "Agent child run",
            kind: "agent",
            access: "read",
            prompt: "bounded agent work",
            depends_on: ["gate"],
          },
          { id: "done", title: "Done", kind: "checkpoint", depends_on: ["agent"] },
        ],
      }),
    )

    const listed = await api.agentCapabilities.workflowList(location)
    const listedDefinition = listed.data.items.find((item) => item.name === "approval_flow")
    expect(listedDefinition?.path).toBe(".arforge/workflows/approval.json")
    const preview = await api.agentCapabilities.workflowPreview({
      ...location,
      path: listedDefinition!.path,
    })
    expect(preview.data).toMatchObject({ name: "approval_flow", dry_run: true, success: true })
    expect(preview.data.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent",
          kind: "agent",
          access: "read",
          max_attempts: 1,
          depends_on: ["gate"],
          continue_on_error: false,
          condition: { when_step: "", when_statuses: [] },
        }),
      ]),
    )
    await expect(
      api.agentCapabilities.workflowPreview({
        ...location,
        path: "../outside-workspace.json",
      }),
    ).rejects.toThrow("workflow definition must stay inside the current workspace")

    const started = await api.agentCapabilities.workflowStart({
      ...location,
      path: listedDefinition!.path,
      sessionID: "ses_durable_workflow_api",
      permissionMode: "plan",
      maxParallel: 2,
    })
    expect(started.data.permission_mode).toBe("plan")
    expect(started.data.definition_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(started.data.budget).toMatchObject({ max_attempts: 3, reserved_attempts: 0, used_attempts: 0 })
    expect(started.data.scheduling).toMatchObject({
      action: "single",
      execute_mode: "single",
      effective_max_parallel: 1,
    })

    let waiting = started.data
    for (let attempt = 0; attempt < 100 && waiting.status !== "waiting_approval"; attempt++) {
      await Bun.sleep(20)
      waiting = (await api.agentCapabilities.workflowRunGet({ ...location, runID: started.data.run_id })).data
    }
    expect(waiting.status).toBe("waiting_approval")
    expect(waiting.nodes).toContainEqual(expect.objectContaining({ node_id: "gate", status: "waiting_approval" }))

    const approved = await api.agentCapabilities.workflowApprove({
      ...location,
      runID: started.data.run_id,
      nodeID: "gate",
      approved: true,
      comment: "verified",
    })
    expect(["running", "completed"]).toContain(approved.data.status)

    let completed = approved.data
    for (let attempt = 0; attempt < 100 && completed.status !== "completed"; attempt++) {
      await Bun.sleep(20)
      completed = (await api.agentCapabilities.workflowRunGet({ ...location, runID: started.data.run_id })).data
    }
    expect(completed.status).toBe("completed")
    expect(completed.verification).toMatchObject({
      action_kind: "workflow",
      action_version: "1",
      passed: true,
      failed_checks: [],
    })
    expect(completed.verification?.evidence_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(completed.progress.percent).toBe(100)
    expect(completed.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node_id: "agent",
          status: "completed",
          budget_reserved_attempts: 1,
          child_run_id: expect.any(String),
        }),
        expect.objectContaining({ node_id: "done", status: "completed" }),
      ]),
    )

    const events = await api.agentCapabilities.workflowRunEvents({
      ...location,
      runID: started.data.run_id,
      after: 0,
      limit: 100,
    })
    expect(events.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "graph.created" }),
        expect.objectContaining({ type: "node.approved", node_id: "gate" }),
      ]),
    )
  }, 30_000)
})
