import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import { Location } from "@arforge-ai/core/location"
import { PersonalWorkspaceV2 } from "@arforge-ai/core/personal-workspace"
import { PersonalJobV2 } from "@arforge-ai/core/personal-job"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { TaskGraphV2 } from "@arforge-ai/core/task-graph"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("C:/workspaces/personal-workspace-core")
const sessionID = SessionV2.ID.make("ses_personal_workspace_authorization")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory, project: { id: Project.ID.global, directory } }),
)
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    TaskGraphV2.node,
    DurableRun.node,
    PersonalJobV2.node,
    PersonalWorkspaceV2.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [Location.node, current],
  ],
)
const it = testEffect(layer)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 3,
  maxDurationMs: 60_000,
  maxCostMicros: 100_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

describe("PersonalWorkspaceV2", () => {
  it.effect("projects a run awaiting authorization as explicit human attention", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "personal-workspace-authorization",
          directory,
          title: "Authorization review",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const runs = yield* DurableRun.Service
      const created = yield* runs.create({
        sessionID,
        initiator: "user",
        authority: "human",
        riskTier: "L2",
        reasonSummary: "Wait for explicit human authorization.",
        budget,
        traceID: "trace-personal-workspace-authorization",
        visibility: "details",
      })
      yield* runs.transition({ runID: created.run.id, to: "preflight", reason: "preflight complete" })
      yield* runs.transition({
        runID: created.run.id,
        to: "awaiting_authorization",
        reason: "human authorization required",
      })

      const snapshot = yield* (yield* PersonalWorkspaceV2.Service).snapshot({ limit: 10 })
      expect(snapshot.runs).toContainEqual(
        expect.objectContaining({
          runID: created.run.id,
          status: "awaiting_authorization",
          state: "needs_human",
          recoveryRequired: false,
        }),
      )
      expect(snapshot.attention).toContainEqual(
        expect.objectContaining({
          kind: "pending_approval",
          resourceType: "run",
          resourceID: created.run.id,
          sessionID,
        }),
      )
      expect(snapshot.sessions).toContainEqual(
        expect.objectContaining({ id: sessionID, state: "needs_human", attentionCount: 1 }),
      )
      expect(snapshot.counts.activeSessions).toBe(1)

      const sentinel = "SECRET_MUST_NOT_REACH_PERSONAL_WORKSPACE"
      yield* db
        .update(EventTable)
        .set({ data: { malformed: true, sentinel } })
        .where(eq(EventTable.aggregate_id, created.run.id))
        .run()
        .pipe(Effect.orDie)
      const failure = yield* (yield* PersonalWorkspaceV2.Service).snapshot({ limit: 10 }).pipe(Effect.flip)
      expect(failure.reason).toBe(`Durable run history for ${sessionID} is not readable.`)
      expect(failure.reason).not.toContain(sentinel)

      const invalidAggregateID = "corrupt-aggregate-id"
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: invalidAggregateID, seq: 0 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(EventTable)
        .set({ aggregate_id: invalidAggregateID })
        .where(eq(EventTable.aggregate_id, created.run.id))
        .run()
        .pipe(Effect.orDie)
      const invalidIdentityFailure = yield* (yield* PersonalWorkspaceV2.Service).snapshot({ limit: 10 }).pipe(
        Effect.flip,
      )
      expect(invalidIdentityFailure.reason).toBe(`Durable run history for ${sessionID} is not readable.`)
    }),
  )
})
