import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Location } from "@arforge-ai/core/location"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { TaskGraphV2 } from "@arforge-ai/core/task-graph"
import { TaskGraphTools } from "@arforge-ai/core/tool/task-graph"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

// Read-only preflight resolution needs a real existing directory; the test
// file's own directory is deterministic on every platform.
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)

const sessionID = SessionV2.ID.make("ses_task_graph_tool_test")
const assertions: PermissionV2.AssertInput[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      TaskGraphV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      TaskGraphTools.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Location.node, current],
    ],
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "task-graph-tool",
      directory: "/project",
      title: "task-graph-tool",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const call = (name: string, input: unknown, id = `call-${name}`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

describe("TaskGraphTools", () => {
  it.effect("registers the source-compatible task tool surface and preserves blockers", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "create_task",
        "list_tasks",
        "search_tasks",
        "update_task",
        "claim_task",
        "complete_task",
        "delete_task",
      ])

      const first = yield* executeTool(registry, call("create_task", { title: "Design task graph" }))
      expect(first).toMatchObject({ type: "text", value: expect.stringContaining("Design task graph") })
      const tasks = yield* TaskGraphV2.Service
      const design = (yield* tasks.list({ sessionID })).items[0]!
      yield* executeTool(
        registry,
        call(
          "create_task",
          {
            title: "Implement task graph",
            blockedBy: [design.id],
          },
          "call-create-implementation",
        ),
      )
      const implementation = (yield* tasks.list({ sessionID })).items[1]!

      expect(
        yield* executeTool(
          registry,
          call("claim_task", {
            taskID: implementation.id,
            expectedRevision: implementation.revision,
            owner: "worker-1",
          }),
        ),
      ).toEqual({ type: "error", value: "The task still has unresolved blockers" })

      yield* executeTool(
        registry,
        call("complete_task", {
          taskID: design.id,
          expectedRevision: design.revision,
        }),
      )
      expect(
        yield* executeTool(
          registry,
          call(
            "claim_task",
            {
              taskID: implementation.id,
              expectedRevision: implementation.revision,
              owner: "worker-1",
            },
            "call-claim-implementation",
          ),
        ),
      ).toMatchObject({ type: "text", value: expect.stringContaining('"status": "in_progress"') })
      expect(assertions.map((item) => item.action)).toEqual([
        "create_task",
        "create_task",
        "claim_task",
        "complete_task",
        "claim_task",
      ])
    }),
    // The full Core matrix starts many isolated SQLite layers in parallel;
    // preserve the default fast budget for ordinary tests while giving this
    // source-compatibility integration enough room under suite-wide load.
    { timeout: 15_000 },
  )
})
