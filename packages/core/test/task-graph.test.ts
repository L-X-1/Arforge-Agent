import { describe, expect } from "bun:test"
import { eq, or } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { TaskGraphV2 } from "@arforge-ai/core/task-graph"
import { TaskGraphEdgeTable } from "@arforge-ai/core/task-graph/sql"
import { testEffect } from "./lib/effect"

let rejectCreate = false
let rejectComplete = false
const guard = Layer.succeed(
  TaskGraphV2.Guard,
  TaskGraphV2.Guard.of({
    beforeCreate: () =>
      rejectCreate
        ? new TaskGraphV2.MutationRejectedError({ event: "task_created", message: "creation blocked by policy" })
        : Effect.void,
    beforeComplete: () =>
      rejectComplete
        ? new TaskGraphV2.MutationRejectedError({ event: "task_completed", message: "completion blocked by policy" })
        : Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, TaskGraphV2.node]), [
    [TaskGraphV2.guardNode, guard],
  ]),
)
const sessionID = SessionV2.ID.make("ses_task_graph_test")

const setup = Effect.gen(function* () {
  rejectCreate = false
  rejectComplete = false
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
      id: sessionID,
      project_id: Project.ID.global,
      slug: "task-graph",
      directory: "/project",
      title: "task graph",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const create = (title: string, blockedBy: TaskGraphV2.ID[] = []) =>
  TaskGraphV2.Service.use((tasks) =>
    tasks.create({
      sessionID,
      title: TaskGraphV2.Title.make(title),
      blockedBy,
    }),
  )

describe("TaskGraph", () => {
  it.effect("stores symmetric dependencies and rejects cycles atomically", () =>
    Effect.gen(function* () {
      yield* setup
      const tasks = yield* TaskGraphV2.Service
      const first = yield* create("foundation")
      const second = yield* create("integration", [first.id])
      const third = yield* create("verification", [second.id])

      expect(yield* tasks.get({ sessionID, taskID: first.id })).toMatchObject({
        blocks: [second.id],
        blockedBy: [],
      })
      expect(yield* tasks.get({ sessionID, taskID: second.id })).toMatchObject({
        blocks: [third.id],
        blockedBy: [first.id],
        unresolvedBlockers: 1,
      })

      const cycle = yield* Effect.flip(
        tasks.update({
          sessionID,
          taskID: first.id,
          expectedRevision: first.revision,
          blockedBy: [third.id],
        }),
      )
      expect(cycle).toMatchObject({
        _tag: "TaskGraph.InvalidDependencyError",
        taskID: first.id,
        message: "Task dependency cycles are not allowed.",
      })
      expect((yield* tasks.get({ sessionID, taskID: first.id })).blockedBy).toEqual([])
    }),
  )

  it.effect("enforces blockers and one in-progress task per owner", () =>
    Effect.gen(function* () {
      yield* setup
      const tasks = yield* TaskGraphV2.Service
      const first = yield* create("foundation")
      const second = yield* create("integration", [first.id])
      const owner = TaskGraphV2.Owner.make("builder")

      const blocked = yield* Effect.flip(
        tasks.claim({ sessionID, taskID: second.id, expectedRevision: second.revision, owner }),
      )
      expect(blocked).toMatchObject({ _tag: "TaskGraph.BlockedError", blockers: [first.id] })

      const firstClaimed = yield* tasks.claim({
        sessionID,
        taskID: first.id,
        expectedRevision: first.revision,
        owner,
      })
      const ownership = yield* Effect.flip(
        tasks.claim({ sessionID, taskID: second.id, expectedRevision: second.revision, owner }),
      )
      expect(ownership).toMatchObject({
        _tag: "TaskGraph.BlockedError",
        taskID: second.id,
      })

      const firstCompleted = yield* tasks.complete({
        sessionID,
        taskID: first.id,
        expectedRevision: firstClaimed.revision,
      })
      expect(firstCompleted.status).toBe("completed")
      const secondClaimed = yield* tasks.claim({
        sessionID,
        taskID: second.id,
        expectedRevision: second.revision,
        owner,
      })
      expect(secondClaimed).toMatchObject({ owner, status: "in_progress", unresolvedBlockers: 0 })

      const independent = yield* create("documentation")
      const conflict = yield* Effect.flip(
        tasks.claim({ sessionID, taskID: independent.id, expectedRevision: independent.revision, owner }),
      )
      expect(conflict).toMatchObject({
        _tag: "TaskGraph.OwnerConflictError",
        conflictingTaskID: second.id,
      })
    }),
  )

  it.effect("removes dangling edges and rejects stale mutation revisions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const tasks = yield* TaskGraphV2.Service
      const first = yield* create("foundation")
      const second = yield* create("integration", [first.id])
      const updated = yield* tasks.update({
        sessionID,
        taskID: second.id,
        expectedRevision: second.revision,
        description: TaskGraphV2.Description.make("Connect all boundaries."),
      })
      const stale = yield* Effect.flip(
        tasks.update({
          sessionID,
          taskID: second.id,
          expectedRevision: second.revision,
          description: TaskGraphV2.Description.make("Stale write."),
        }),
      )
      expect(stale).toMatchObject({ _tag: "TaskGraph.StaleRevisionError", actualRevision: updated.revision })

      yield* tasks.delete({ sessionID, taskID: first.id, expectedRevision: first.revision })
      expect((yield* tasks.get({ sessionID, taskID: second.id })).blockedBy).toEqual([])
      expect(
        yield* db
          .select()
          .from(TaskGraphEdgeTable)
          .where(or(eq(TaskGraphEdgeTable.blocker_id, first.id), eq(TaskGraphEdgeTable.blocked_id, first.id)))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
    }),
  )

  it.effect("redacts bounded metadata and lets pre-mutation guards fail closed", () =>
    Effect.gen(function* () {
      yield* setup
      const tasks = yield* TaskGraphV2.Service
      const task = yield* tasks.create({
        sessionID,
        title: TaskGraphV2.Title.make("secure integration"),
        metadata: TaskGraphV2.Metadata.make({
          api_key: "sk-supersecretvalue123456",
          note: "Bearer abcdefghijklmnopqrstuvwxyz",
        }),
      })
      expect(task.metadata).toEqual({
        api_key: "[REDACTED]",
        note: "Bearer [REDACTED]",
      })

      rejectComplete = true
      const rejected = yield* Effect.flip(
        tasks.complete({ sessionID, taskID: task.id, expectedRevision: task.revision }),
      )
      expect(rejected).toMatchObject({ _tag: "TaskGraph.MutationRejectedError", event: "task_completed" })
      expect((yield* tasks.get({ sessionID, taskID: task.id })).status).toBe("pending")

      rejectCreate = true
      expect(yield* Effect.flip(create("blocked by hook"))).toMatchObject({
        _tag: "TaskGraph.MutationRejectedError",
        event: "task_created",
      })
      expect((yield* tasks.list({ sessionID })).items.map((item) => item.title)).toEqual(["secure integration"])
    }),
  )

  it.effect("treats SQL wildcard characters as literal task-search text", () =>
    Effect.gen(function* () {
      yield* setup
      const tasks = yield* TaskGraphV2.Service
      yield* create("coverage 100%")
      yield* create("coverage 100x")
      yield* create("under_score")
      yield* create("underXscore")

      expect((yield* tasks.list({ sessionID, search: "100%" })).items.map((item) => item.title)).toEqual([
        "coverage 100%",
      ])
      expect((yield* tasks.list({ sessionID, search: "under_score" })).items.map((item) => item.title)).toEqual([
        "under_score",
      ])
    }),
  )
})
