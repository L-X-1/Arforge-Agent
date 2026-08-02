import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { TeamV2 } from "@arforge-ai/core/team"
import { TeamTools } from "@arforge-ai/core/tool/team"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_team_tool_test")
const coder = AgentV2.ID.make("coder")
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
      AgentV2.node,
      TeamV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      TeamTools.node,
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
      slug: "team-tool",
      directory: "/project",
      title: "team-tool",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) =>
    editor.update(coder, (agent) => {
      agent.mode = "subagent"
    }),
  )
})

const call = (name: string, input: unknown, agent = AgentV2.defaultID) => ({
  sessionID,
  ...toolIdentity,
  agent,
  call: { type: "tool-call" as const, id: `call-${name}-${agent}`, name, input },
})

describe("TeamTools", () => {
  it.effect("isolates member mailboxes and keeps lifecycle operations lead-only", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "team_create",
        "team_get",
        "team_member_add",
        "team_message_send",
        "team_message_list",
        "team_shutdown_request",
        "team_shutdown_respond",
        "team_member_remove",
        "team_delete",
      ])

      expect(yield* executeTool(registry, call("team_create", { name: "Tool team" }))).toMatchObject({
        type: "text",
        value: expect.stringContaining("Tool team"),
      })
      yield* executeTool(registry, call("team_member_add", { memberName: "coder", agentID: coder }))
      yield* executeTool(
        registry,
        call("team_message_send", {
          recipient: "coder",
          message: "Implement the task graph.",
          kind: "request",
        }),
      )
      expect(yield* executeTool(registry, call("team_message_list", {}, coder))).toMatchObject({
        type: "text",
        value: expect.stringContaining("Implement the task graph."),
      })
      expect(yield* executeTool(registry, call("team_delete", {}, coder))).toEqual({
        type: "error",
        value: "Only the current session's team lead can use this lifecycle tool",
      })

      const teams = yield* TeamV2.Service
      const shutdown = yield* teams.requestShutdown({
        sessionID,
        member: TeamV2.CollaboratorName.make("coder"),
      })
      expect(
        yield* executeTool(
          registry,
          call(
            "team_shutdown_respond",
            {
              requestID: shutdown.id,
              approve: true,
            },
            coder,
          ),
        ),
      ).toMatchObject({ type: "text", value: expect.stringContaining('"status": "approved"') })
      expect((yield* teams.get(sessionID)).members[1]).toMatchObject({ name: "coder", status: "stopped" })
      expect(assertions.map((item) => item.action)).toEqual(["team_create", "team_member_add"])
    }),
  )
})
