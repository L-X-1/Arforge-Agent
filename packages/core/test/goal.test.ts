import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { EventV2 } from "@arforge-ai/core/event"
import { GoalV2 } from "@arforge-ai/core/goal"
import { GoalGuidance } from "@arforge-ai/core/goal/guidance"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SystemContext } from "@arforge-ai/core/system-context"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, GoalV2.node, GoalGuidance.node])))
const sessionID = SessionV2.ID.make("ses_goal_test")

const setup = Effect.gen(function* () {
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
      slug: "goal",
      directory: "/project",
      title: "goal",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("GoalV2", () => {
  it.effect("queues behind one active goal and advances after completion", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const first = yield* goals.create({
        sessionID,
        objective: GoalV2.Objective.make("Finish the migration"),
      })
      const second = yield* goals.create({
        sessionID,
        objective: GoalV2.Objective.make("Verify the migration"),
      })

      expect(first.status).toBe("active")
      expect(second).toMatchObject({ status: "queued", queuePosition: 1 })

      const running = yield* goals.start({
        sessionID,
        goalID: first.id,
        expectedRevision: first.revision,
        promptID: SessionMessage.ID.create(),
      })
      const completed = yield* goals.complete({
        sessionID,
        goalID: first.id,
        expectedRevision: running.revision,
      })
      const page = yield* goals.list({ sessionID })

      expect(completed.status).toBe("completed")
      expect(page.active).toMatchObject({ id: second.id, status: "active", queuePosition: 0 })
      expect(page.history.map((goal) => goal.id)).toEqual([first.id])
    }),
  )

  it.effect("rejects stale revisions without mutating the goal", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const goal = yield* goals.create({
        sessionID,
        objective: GoalV2.Objective.make("Run validation"),
      })
      const replaced = yield* goals.replace({
        sessionID,
        goalID: goal.id,
        expectedRevision: goal.revision,
        objective: GoalV2.Objective.make("Run all validation"),
      })
      const error = yield* Effect.flip(
        goals.pause({
          sessionID,
          goalID: goal.id,
          expectedRevision: goal.revision,
        }),
      )

      expect(error).toMatchObject({
        _tag: "Goal.StaleRevisionError",
        expectedRevision: goal.revision,
        actualRevision: replaced.revision,
      })
      expect(yield* goals.get({ sessionID, goalID: goal.id })).toMatchObject({
        objective: "Run all validation",
        status: "active",
        revision: replaced.revision,
      })
    }),
  )

  it.effect("requires an exact revisioned queue when reordering", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Active") })
      const second = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Second") })
      const third = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Third") })

      const reordered = yield* goals.reorder({
        sessionID,
        goals: [
          { id: third.id, revision: third.revision },
          { id: second.id, revision: second.revision },
        ],
      })
      expect(reordered.queued.map((goal) => goal.id)).toEqual([third.id, second.id])

      const error = yield* Effect.flip(
        goals.reorder({
          sessionID,
          goals: [{ id: second.id, revision: second.revision }],
        }),
      )
      expect(error).toMatchObject({
        _tag: "Goal.InvalidQueueError",
        message: "goals must contain every queued goal exactly once",
      })
    }),
  )

  it.effect("deletes only queued goals and keeps queue positions contiguous", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const active = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Active") })
      const second = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Second") })
      const third = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Third") })

      yield* goals.deleteQueued({
        sessionID,
        goalID: second.id,
        expectedRevision: second.revision,
      })
      expect((yield* goals.list({ sessionID, includeHistory: false })).queued).toMatchObject([
        { id: third.id, queuePosition: 1 },
      ])

      const error = yield* Effect.flip(
        goals.deleteQueued({
          sessionID,
          goalID: active.id,
          expectedRevision: active.revision,
        }),
      )
      expect(error).toMatchObject({
        _tag: "Goal.InvalidStateError",
        status: "active",
        action: "delete",
      })
    }),
  )

  it.effect("renders the active goal as refreshable system context and removes it after completion", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* GoalV2.Service
      const guidance = yield* GoalGuidance.Service
      const goal = yield* goals.create({
        sessionID,
        objective: GoalV2.Objective.make("Verify <all> & report"),
      })
      const initialized = yield* guidance.load(sessionID).pipe(Effect.flatMap(SystemContext.initialize))

      expect(initialized.baseline).toContain("<id>" + goal.id + "</id>")
      expect(initialized.baseline).toContain("<objective>Verify &lt;all&gt; &amp; report</objective>")
      expect(initialized.baseline).toContain("A plan, partial implementation, or unverified claim is not completion.")

      yield* goals.complete({
        sessionID,
        goalID: goal.id,
        expectedRevision: goal.revision,
      })
      expect(
        yield* guidance
          .load(sessionID)
          .pipe(Effect.flatMap((context) => SystemContext.reconcile(context, initialized.snapshot))),
      ).toMatchObject({
        _tag: "Updated",
        text: "There is no longer an active autonomous goal. Do not update a previously active goal.",
      })
    }),
  )
})
