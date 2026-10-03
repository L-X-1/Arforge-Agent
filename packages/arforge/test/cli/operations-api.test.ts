import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createOperationsApi, createOperationsFetch } from "../../src/cli/operations-api"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

type PendingControlApproval = {
  id: string
  action: string
  subject?: { location?: string }
}

async function withControlApproval<A>(directory: string, operation: () => Promise<A>): Promise<A> {
  const pendingOperation = operation()
  const fetch = createOperationsFetch(directory)
  const deadline = Date.now() + 5_000
  let approval: PendingControlApproval | undefined
  let observed: PendingControlApproval[] = []

  while (!approval && Date.now() < deadline) {
    const response = await fetch("http://arforge.local/experimental/control-approval")
    if (!response.ok) throw new Error(`control approval list failed with HTTP ${response.status}`)
    const items = (await response.json()) as PendingControlApproval[]
    observed = items
    approval = items.find((item) => item.subject?.location === resolve(directory))
    if (!approval) await Bun.sleep(20)
  }

  if (!approval) {
    void pendingOperation.catch(() => undefined)
    throw new Error(
      `control approval was not published for ${directory}; observed ${JSON.stringify(observed)}`,
    )
  }

  const replied = await fetch(
    `http://arforge.local/experimental/control-approval/${encodeURIComponent(approval.id)}/reply`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: "once" }),
    },
  )
  if (!replied.ok) throw new Error(`control approval reply failed with HTTP ${replied.status}`)
  return pendingOperation
}

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
    const skillID = `reviewer-${randomUUID().replaceAll("-", "").slice(0, 12)}`

    const skillRoot = join(workspace.path, ".arforge", "skills", skillID)
    const pluginRoot = join(workspace.path, ".arforge", "plugins", "local-tools")
    const workflowRoot = join(workspace.path, ".arforge", "workflows")
    await mkdir(skillRoot, { recursive: true })
    await mkdir(pluginRoot, { recursive: true })
    await mkdir(workflowRoot, { recursive: true })
    await Bun.write(
      join(skillRoot, "SKILL.md"),
      `---\nid: ${skillID}\nname: ${skillID}\ndescription: Reviews one bounded change.\n---\n# Reviewer\n`,
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
      expect.objectContaining({ id: skillID, enabled: true, problems: [] }),
    )
    try {
      const disabledSkill = await withControlApproval(workspace.path, () =>
        api.agentCapabilities.skillSetEnabled({
          ...location,
          skillID,
          enabled: false,
        }),
      )
      expect(disabledSkill.data).toMatchObject({ skill_id: skillID, enabled: false, changed: true })
    } finally {
      await withControlApproval(workspace.path, () =>
        api.agentCapabilities.skillSetEnabled({ ...location, skillID, enabled: true }),
      ).catch(() => undefined)
    }

    const plugins = await api.agentCapabilities.pluginList(location)
    expect(plugins.data.items).toContainEqual(
      expect.objectContaining({ name: "local-tools", managed: true, enabled: true, problems: [] }),
    )
    const disabledPlugins = await withControlApproval(workspace.path, () =>
      api.agentCapabilities.pluginSetEnabled({
        ...location,
        name: "local-tools",
        enabled: false,
      }),
    )
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
    const installed = await withControlApproval(workspace.path, () =>
      api.agentCapabilities.pluginApply({
        ...location,
        token: inspection.data.token,
        name: "installed-tools",
      }),
    )
    expect(installed.data.plugins.items).toContainEqual(
      expect.objectContaining({ name: "installed-tools", managed: true, enabled: false }),
    )
    const removed = await withControlApproval(workspace.path, () =>
      api.agentCapabilities.pluginRemove({ ...location, name: "installed-tools" }),
    )
    const transaction = removed.data.transaction as { recovery?: { recovery_id?: string } }
    expect(transaction.recovery?.recovery_id).toBeString()
    const restored = await withControlApproval(workspace.path, () =>
      api.agentCapabilities.pluginRestore({
        ...location,
        recoveryID: transaction.recovery!.recovery_id!,
      }),
    )
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
