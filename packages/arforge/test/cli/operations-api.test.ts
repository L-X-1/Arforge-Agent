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

describe("CLI operations API", () => {
  test("shares Goal, Task and Prompt Queue state with the integrated server", async () => {
    await using workspace = await tmpdir()
    const api = createOperationsApi(workspace.path)
    const sessionID = "ses_cli_operations"

    await api.sessions.create({
      id: sessionID,
      location: { directory: workspace.path },
    })

    const goal = await api.goals.create({
      sessionID,
      objective: "Unify operations",
      queue: false,
    })
    expect(await api.goals.list({ sessionID, history: "true" })).toMatchObject({
      active: { id: goal.id, objective: "Unify operations", status: "active" },
    })

    const task = await api.tasks.create({
      sessionID,
      title: "Verify one state owner",
      description: "Created by the CLI client path",
    })
    expect(await api.tasks.list({ sessionID })).toMatchObject({
      total: 1,
      items: [{ id: task.id, title: "Verify one state owner", status: "pending" }],
    })

    const admitted = await api.sessions.prompt({
      sessionID,
      id: "msg_cli_operations",
      prompt: { text: "durable queued work", route: { agent: "build" } },
      delivery: "queue",
      resume: false,
    })
    expect(await api.sessions.promptQueueList({ sessionID })).toMatchObject([
      {
        id: admitted.id,
        admittedSeq: admitted.admittedSeq,
        prompt: { text: "durable queued work", route: { agent: "build" } },
      },
    ])

    await api.sessions.promptQueueRemove({
      sessionID,
      messageID: admitted.id,
      expectedAdmittedSeq: admitted.admittedSeq,
    })
    expect(await api.sessions.promptQueueList({ sessionID })).toEqual([])
  }, 30_000)

  test("manages Workflow, Plugin and Skill through one typed API", async () => {
    await using workspace = await tmpdir()
    const api = createOperationsApi(workspace.path)
    const location = { location: { directory: workspace.path } }

    const skillRoot = join(workspace.path, ".arforge", "skills", "reviewer")
    const pluginRoot = join(workspace.path, ".arforge", "plugins", "local-tools")
    const workflowRoot = join(workspace.path, ".arforge", "workflows")
    await mkdir(skillRoot, { recursive: true })
    await mkdir(pluginRoot, { recursive: true })
    await mkdir(workflowRoot, { recursive: true })
    await Bun.write(
      join(skillRoot, "SKILL.md"),
      "---\nname: reviewer\ndescription: Reviews one bounded change.\n---\n# Reviewer\n",
    )
    await Bun.write(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({
        name: "local-tools",
        version: "1.0.0",
        description: "Local declarative tools.",
        tools: [
          {
            name: "echo",
            description: "Echo one value.",
            command: ["python", "tool.py"],
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      }),
    )
    await Bun.write(join(pluginRoot, "tool.py"), "import json,sys\nprint(json.dumps(json.load(sys.stdin)))\n")
    await Bun.write(
      join(workflowRoot, "approval.json"),
      JSON.stringify({
        schema_version: 2,
        name: "approval_flow",
        steps: [
          { id: "gate", title: "Human gate", kind: "approval" },
          { id: "done", title: "Done", kind: "checkpoint", depends_on: ["gate"] },
        ],
      }),
    )

    const skills = await api.agentCapabilities.skillList(location)
    expect(skills.data.items).toContainEqual(
      expect.objectContaining({ id: "reviewer", enabled: true, problems: [] }),
    )
    const disabledSkill = await api.agentCapabilities.skillSetEnabled({
      ...location,
      skillID: "reviewer",
      enabled: false,
    })
    expect(disabledSkill.data).toMatchObject({ skill_id: "reviewer", enabled: false, changed: true })

    const plugins = await api.agentCapabilities.pluginList(location)
    expect(plugins.data.items).toContainEqual(
      expect.objectContaining({ name: "local-tools", managed: true, enabled: true, problems: [] }),
    )
    const disabledPlugins = await api.agentCapabilities.pluginSetEnabled({
      ...location,
      name: "local-tools",
      enabled: false,
    })
    expect(disabledPlugins.data.items).toContainEqual(
      expect.objectContaining({ name: "local-tools", enabled: false }),
    )

    const packageRoot = join(workspace.path, "plugin-package")
    await mkdir(packageRoot, { recursive: true })
    await Bun.write(
      join(packageRoot, "plugin.json"),
      JSON.stringify({
        name: "installed-tools",
        version: "2.0.0",
        description: "Two-phase install fixture.",
        tools: [
          {
            name: "inspect",
            description: "Inspect one value.",
            command: ["python", "tool.py"],
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        ],
      }),
    )
    await Bun.write(join(packageRoot, "tool.py"), "import json,sys\nprint(json.dumps(json.load(sys.stdin)))\n")
    const inspection = await api.agentCapabilities.pluginInspect({ ...location, source: packageRoot })
    expect(inspection.data).toMatchObject({
      selection_required: false,
      candidates: [{ name: "installed-tools", version: "2.0.0" }],
    })
    const installed = await api.agentCapabilities.pluginApply({
      ...location,
      token: inspection.data.token,
      name: "installed-tools",
    })
    expect(installed.data.plugins.items).toContainEqual(
      expect.objectContaining({ name: "installed-tools", managed: true, enabled: false }),
    )
    const removed = await api.agentCapabilities.pluginRemove({ ...location, name: "installed-tools" })
    const transaction = removed.data.transaction as { recovery?: { recovery_id?: string } }
    expect(transaction.recovery?.recovery_id).toBeString()
    const restored = await api.agentCapabilities.pluginRestore({
      ...location,
      recoveryID: transaction.recovery!.recovery_id!,
    })
    expect(restored.data.plugins.items).toContainEqual(
      expect.objectContaining({ name: "installed-tools", managed: true, enabled: false }),
    )

    const workflows = await api.agentCapabilities.workflowList(location)
    expect(workflows.data.items).toContainEqual(
      expect.objectContaining({ name: "approval_flow", valid: true, nodes: 2, has_approval: true }),
    )
    const preview = await api.agentCapabilities.workflowPreview({
      ...location,
      path: ".arforge/workflows/approval.json",
    })
    expect(preview.data).toMatchObject({ name: "approval_flow", dry_run: true, success: true })

    const started = await api.agentCapabilities.workflowStart({
      ...location,
      path: ".arforge/workflows/approval.json",
      sessionID: "ses_extension_management",
      permissionMode: "plan",
      maxParallel: 2,
    })
    let waiting = started.data
    for (let attempt = 0; attempt < 50 && waiting.status !== "waiting_approval"; attempt++) {
      await Bun.sleep(20)
      waiting = (await api.agentCapabilities.workflowRunGet({ ...location, runID: started.data.run_id })).data
    }
    expect(waiting.status).toBe("waiting_approval")
    const approved = await api.agentCapabilities.workflowApprove({
      ...location,
      runID: started.data.run_id,
      nodeID: "gate",
      approved: true,
      comment: "verified",
    })
    expect(["running", "completed"]).toContain(approved.data.status)

    let completed = approved.data
    for (let attempt = 0; attempt < 50 && completed.status !== "completed"; attempt++) {
      await Bun.sleep(20)
      completed = (await api.agentCapabilities.workflowRunGet({ ...location, runID: started.data.run_id })).data
    }
    expect(completed.status).toBe("completed")
    expect(completed.progress.percent).toBe(100)
  }, 30_000)
})
