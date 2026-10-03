import { describe, expect, it as bunIt } from "bun:test"
import { DateTime, Effect } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { TaskGraphV2 } from "@arforge-ai/core/task-graph"
import { TaskV2 } from "@arforge-ai/core/task"
import { SessionV2 } from "@arforge-ai/core/session"
import { testEffect } from "./lib/effect"

const effect = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, TaskGraphV2.node, TaskV2.node])),
)
const integrationSessionID = SessionV2.ID.make("ses_task_adapter")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: integrationSessionID,
      project_id: Project.ID.global,
      slug: "task-adapter",
      directory: "/project",
      title: "task adapter",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("AgentRuntime Task adapter", () => {
  bunIt("projects a TaskGraph record into the business-task contract", () => {
    const created = DateTime.makeUnsafe(1)
    const updated = DateTime.makeUnsafe(2)
    const task = {
      id: TaskGraphV2.ID.make("tsk_adapter"),
      sessionID: SessionV2.ID.make("ses_adapter"),
      title: TaskGraphV2.Title.make("Freeze the task authority"),
      description: TaskGraphV2.Description.make("Keep the graph as the durable backing store."),
      activeForm: TaskGraphV2.ActiveForm.make("Freezing task authority"),
      status: TaskGraphV2.Status.make("in_progress"),
      owner: TaskGraphV2.Owner.make("runtime"),
      metadata: TaskGraphV2.Metadata.make({ source: "stage-2.2" }),
      blocks: [],
      blockedBy: [],
      unresolvedBlockers: 0,
      revision: 2,
      time: { created, updated },
    } satisfies TaskGraphV2.Info

    const projected = TaskV2.fromTaskGraph(task)

    expect(projected).toEqual({
      id: task.id,
      sessionID: task.sessionID,
      objective: task.title,
      status: task.status,
      revision: task.revision,
      time: task.time,
    })
    expect(AgentRuntime.Task.make(projected)).toEqual(projected)
  })

  effect.effect("reads the canonical task through the Core facade", Effect.gen(function* () {
    yield* setup
    const taskGraph = yield* TaskGraphV2.Service
    const task = yield* taskGraph.create({
      sessionID: integrationSessionID,
      title: TaskGraphV2.Title.make("Read through the canonical facade"),
    })
    const canonical = yield* TaskV2.Service
    const projected = yield* canonical.get({ sessionID: integrationSessionID, taskID: task.id })

    expect(projected).toMatchObject({
      id: task.id,
      sessionID: integrationSessionID,
      objective: task.title,
      status: task.status,
      revision: task.revision,
    })
  }))
})
