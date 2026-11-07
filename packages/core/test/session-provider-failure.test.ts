import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { Cause, Effect, Exit, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLMError } from "@arforge-ai/llm"
import { RequestExecutor } from "@arforge-ai/llm/route"
import { EventV2 } from "@arforge-ai/core/event"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { createLLMEventPublisher, publicProviderFailure } from "@arforge-ai/core/session/runner/publish-llm-event"
import { settleRunningGoal } from "@arforge-ai/core/session/runner/llm"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { GoalV2 } from "@arforge-ai/core/goal"
import { ProjectV2 } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionTable } from "@arforge-ai/core/session/sql"

for (const [code, status, tag, attempts] of [
  ["invalid_api_key", 401, "Authentication", 1],
  ["insufficient_quota", 429, "QuotaExceeded", 1],
  ["rate_limit_exceeded", 429, "RateLimit", 3],
] as const) {
  test(`real loopback ${code} preserves bounded public reason and excludes diagnostics`, async () => {
    const secret = "sk-owned-private-token-1234567890",
      bodyMarker = "owned-private-body-only",
      headerMarker = "owned-private-header-only"
    let calls = 0
    const server = createServer((_request, response) => {
      calls++
      response.writeHead(status, {
        "content-type": "application/json",
        "retry-after-ms": "0",
        "x-private": headerMarker,
      })
      response.end(
        JSON.stringify({ error: { code, message: "Owned provider failure", token: secret, internal: bodyMarker } }),
      )
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing owned listener")
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          return yield* executor
            .execute(HttpClientRequest.post(`http://127.0.0.1:${address.port}/v1/chat/completions`))
            .pipe(Effect.flip)
        }).pipe(Effect.provide(RequestExecutor.fetchLayer)),
      )
      expect(failure).toBeInstanceOf(LLMError)
      expect(failure.reason._tag).toBe(tag)
      expect(calls).toBe(attempts)
      const captured: Array<typeof SessionEvent.Step.Failed.data.Type> = []
      const events = EventV2.Service.of({
        publish: (definition, data) =>
          Effect.sync(() => {
            if (definition.type === SessionEvent.Step.Failed.type) {
              if (!Schema.is(SessionEvent.Step.Failed.data)(data)) throw new Error("Invalid canonical failure payload")
              captured.push(data)
            }
            return { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
          }),
        subscribe: () => Stream.empty,
        all: () => Stream.empty,
        durable: () => Stream.empty,
        listen: () => Effect.succeed(Effect.void),
        project: () => Effect.void,
        replay: () => Effect.void,
        replayAll: () => Effect.succeed(undefined),
        remove: () => Effect.void,
        claim: () => Effect.void,
      })
      const publisher = createLLMEventPublisher(events, {
        sessionID: SessionSchema.ID.make("ses_owned_provider_failure"),
        agent: "build",
        model: { providerID: ProviderV2.ID.make("owned"), id: ModelV2.ID.make("model") },
      })
      // Exercise the canonical publisher with the real typed transport failure.
      await Effect.runPromise(publisher.failAssistant(failure.reason.message, failure))
      expect(captured).toHaveLength(1)
      const wire = Schema.encodeSync(SessionEvent.Step.Failed.data)(captured[0])
      expect(wire.error).toEqual(publicProviderFailure(failure))
      expect(wire.error).toMatchObject({ reason: tag, statusCode: status, retryable: tag === "RateLimit" })
      for (const privateValue of [secret, bodyMarker, headerMarker, '"error"', '"token"'])
        expect(JSON.stringify(wire.error)).not.toContain(privateValue)
      expect(wire.error.message.length).toBeLessThanOrEqual(500)
      const sessionID = SessionSchema.ID.make("ses_owned_provider_goal")
      const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, GoalV2.node]), [
        [Database.node, Database.layerFromPath(":memory:")],
      ])
      const exit = Exit.fail(failure)
      const saved = await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const goals = yield* GoalV2.Service
          yield* db
            .insert(ProjectTable)
            .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/owned-provider-goal"), sandboxes: [] })
            .run()
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: ProjectV2.ID.global,
              slug: "owned",
              directory: "/owned-provider-goal",
              title: "owned",
              version: "test",
            })
            .run()
          const goal = yield* goals.create({ sessionID, objective: GoalV2.Objective.make("Owned active goal") })
          const running = yield* goals.start({
            sessionID,
            goalID: goal.id,
            expectedRevision: goal.revision,
            promptID: SessionMessage.ID.make("msg_owned_provider_goal"),
          })
          yield* settleRunningGoal(goals, sessionID, exit)
          const blocked = yield* goals.get({ sessionID, goalID: goal.id })
          yield* settleRunningGoal(goals, sessionID, exit)
          expect((yield* goals.get({ sessionID, goalID: goal.id })).revision).toBe(blocked.revision)
          return { running, blocked }
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
      expect(saved.blocked.status).toBe("blocked")
      expect(saved.blocked.revision).toBe(saved.running.revision + 1)
      expect(saved.blocked.promptID).toBe(saved.running.promptID)
      expect(saved.blocked.lastError).toContain(publicProviderFailure(failure).message)
      for (const privateValue of [secret, bodyMarker, headerMarker, '"error"', '"token"'])
        expect(saved.blocked.lastError).not.toContain(privateValue)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }, 15000)
}
