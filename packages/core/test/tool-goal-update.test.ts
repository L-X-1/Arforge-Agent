import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { GoalV2 } from "@arforge-ai/core/goal"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { GoalUpdateTool } from "@arforge-ai/core/tool/goal-update"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_goal_update_tool_test")
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
      GoalV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      GoalUpdateTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
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
      slug: "goal-update",
      directory: "/project",
      title: "goal-update",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const call = (input: typeof GoalUpdateTool.Input.Type, id = "call-goal-update") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: GoalUpdateTool.name, input },
})

describe("GoalUpdateTool", () => {
  it.effect("completes the owned running goal and activates the next goal", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const registry = yield* ToolRegistry.Service
      const first = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("First") })
      const second = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Second") })
      const running = yield* goals.start({
        sessionID,
        goalID: first.id,
        expectedRevision: first.revision,
        promptID: SessionMessage.ID.create(),
      })

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([GoalUpdateTool.name])
      expect(
        yield* executeTool(
          registry,
          call({
            goalID: first.id,
            expectedRevision: running.revision,
            status: "completed",
          }),
        ),
      ).toEqual({
        type: "text",
        value: expect.stringContaining(`"id": "${first.id}"`),
      })
      expect(yield* goals.get({ sessionID, goalID: first.id })).toMatchObject({ status: "completed" })
      expect((yield* goals.list({ sessionID, includeHistory: false })).active).toMatchObject({
        id: second.id,
        status: "active",
      })
      expect(assertions).toMatchObject([
        {
          sessionID,
          action: GoalUpdateTool.name,
          resources: [first.id],
          save: [first.id],
        },
      ])
    }),
  )

  it.effect("rejects a blocked state without a factual error", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const registry = yield* ToolRegistry.Service
      const goal = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Blocked") })
      const running = yield* goals.start({
        sessionID,
        goalID: goal.id,
        expectedRevision: goal.revision,
        promptID: SessionMessage.ID.create(),
      })

      expect(
        yield* executeTool(
          registry,
          call({
            goalID: goal.id,
            expectedRevision: running.revision,
            status: "blocked",
          }),
        ),
      ).toEqual({
        type: "error",
        value: "Blocked goals require a factual error",
      })
      expect(yield* goals.get({ sessionID, goalID: goal.id })).toMatchObject({ status: "running" })
    }),
  )
})
