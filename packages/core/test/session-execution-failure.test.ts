import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { EventV2 } from "@arforge-ai/core/event"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { reportDrainFailure } from "@arforge-ai/core/session/execution/failure"

const sessionID = SessionSchema.ID.make("ses_drain_failure_fixture")
const directory = AbsolutePath.make("E:/isolated-drain-fixture")
function fixture(failPublish = false) {
  const listeners = new Set<EventV2.Subscriber>()
  const published: Array<{ type: string; data: unknown; location: unknown }> = []
  const publish: EventV2.Interface["publish"] = (definition, data, options) =>
    Effect.gen(function* () {
      if (failPublish) return yield* Effect.die(new Error("isolated event transport failure"))
      published.push({ type: definition.type, data, location: options?.location })
      const event = { id: EventV2.ID.create(), type: definition.type, data }
      for (const listener of [...listeners]) yield* listener(event)
      return event
    })
  const listen: EventV2.Interface["listen"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener)
      return Effect.sync(() => {
        listeners.delete(listener)
      })
    })
  return { events: { publish, listen }, published, listeners }
}

describe("session drain failure observation", () => {
  for (const mode of ["typed", "defect"] as const)
    test(`${mode} admission failure publishes one scoped existing error and preserves its cause`, async () => {
      const state = fixture()
      const failure = new Error("Failed to drain Formal Session: isolated getSQL admission defect")
      const exit = await Effect.runPromise(
        reportDrainFailure(mode === "typed" ? Effect.fail(failure) : Effect.die(failure), {
          sessionID,
          events: state.events,
          location: { directory },
        }).pipe(Effect.exit),
      )
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
      expect(state.published).toEqual([
        {
          type: "session.error",
          data: { sessionID, error: { name: "UnknownError", data: { message: failure.message } } },
          location: { directory },
        },
      ])
      expect(state.listeners.size).toBe(0)
    })

  test("success preserves queued input facts and terminal state without publishing or retrying", async () => {
    const state = fixture()
    const facts = { inputID: "msg_original", delivery: "queue", promotedSeq: undefined, runStatus: "failed" }
    let calls = 0
    const value = await Effect.runPromise(
      reportDrainFailure(
        Effect.sync(() => {
          calls++
          return facts
        }),
        { sessionID, events: state.events },
      ),
    )
    expect(value).toBe(facts)
    expect(facts).toEqual({ inputID: "msg_original", delivery: "queue", promotedSeq: undefined, runStatus: "failed" })
    expect(calls).toBe(1)
    expect(state.published).toEqual([])
    expect(state.listeners.size).toBe(0)
  })

  test("interruption remains interruption and does not become a session error", async () => {
    const state = fixture()
    const exit = await Effect.runPromise(
      reportDrainFailure(Effect.interrupt, { sessionID, events: state.events }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(state.published).toEqual([])
    expect(state.listeners.size).toBe(0)
  })

  test("redacts and bounds API errors while withholding provider headers and body", async () => {
    const state = fixture()
    const token = "synthetic-private-provider-token"
    const failure = {
      name: "APIError" as const,
      data: {
        message: `Provider rejected token=${token}; ${"diagnostic ".repeat(2_000)}`,
        statusCode: 401,
        isRetryable: false,
        responseHeaders: { authorization: "Bearer synthetic-header-secret" },
        responseBody: "synthetic-private-response-content",
        metadata: { credential: "synthetic-private-metadata" },
      },
    }
    const exit = await Effect.runPromise(
      reportDrainFailure(Effect.fail(failure), { sessionID, events: state.events }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
    expect(state.published).toHaveLength(1)
    const data = state.published[0].data as { error: { name: string; data: Record<string, unknown> } }
    expect(data.error.name).toBe("APIError")
    expect(Object.keys(data.error.data).sort()).toEqual(["isRetryable", "message", "statusCode"])
    expect(data.error.data.statusCode).toBe(401)
    expect(data.error.data.isRetryable).toBe(false)
    expect(typeof data.error.data.message).toBe("string")
    expect(String(data.error.data.message).startsWith("Provider rejected token=[REDACTED_SECRET];")).toBe(true)
    expect(String(data.error.data.message).length).toBeLessThanOrEqual(500)
    const wire = JSON.stringify(state.published[0].data)
    for (const privateValue of [token, "synthetic-header-secret", failure.data.responseBody, failure.data.metadata.credential])
      expect(wire.includes(privateValue)).toBe(false)
    expect(wire.length).toBeLessThan(800)
    expect(failure.data.message.length).toBeGreaterThan(10_000)
    expect(state.listeners.size).toBe(0)
  })

  test("redacts credentials in plain errors and preserves the original cause", async () => {
    const state = fixture()
    const key = "sk-synthetic-private-key-1234567890"
    const failure = new Error(
      `Provider rejected ${key} Bearer synthetic-private-bearer-123456; postgres://demo:synthetic-db-pass@local.invalid/db ${"detail ".repeat(1_000)}`,
    )
    const exit = await Effect.runPromise(
      reportDrainFailure(Effect.die(failure), { sessionID, events: state.events }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
    const data = state.published[0].data as { error: { name: string; data: { message: string } } }
    expect(data.error.name).toBe("UnknownError")
    expect(data.error.data.message.length).toBeLessThanOrEqual(500)
    expect(data.error.data.message.includes("[REDACTED_SECRET]")).toBe(true)
    const wire = JSON.stringify(data)
    for (const privateValue of [key, "synthetic-private-bearer-123456", "synthetic-db-pass"])
      expect(wire.includes(privateValue)).toBe(false)
    expect(wire.length).toBeLessThan(800)
    expect(failure.message.includes(key)).toBe(true)
  })

  test("a step failure already projected for this session is not reported twice", async () => {
    const state = fixture()
    const failure = new Error("provider step failed")
    const body = Effect.gen(function* () {
      for (const listener of [...state.listeners])
        yield* listener({ id: EventV2.ID.create(), type: SessionEvent.Step.Failed.type, data: { sessionID } })
      return yield* Effect.fail(failure)
    })
    const exit = await Effect.runPromise(
      reportDrainFailure(body, { sessionID, events: state.events }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
    expect(state.published).toEqual([])
  })

  test("another session's failure cannot suppress this session's admission failure", async () => {
    const state = fixture()
    const body = Effect.gen(function* () {
      for (const listener of [...state.listeners])
        yield* listener({ id: EventV2.ID.create(), type: SessionV1.Event.Error.type, data: { sessionID: "ses_other" } })
      return yield* Effect.die(new Error("this session failed"))
    })
    await Effect.runPromise(reportDrainFailure(body, { sessionID, events: state.events }).pipe(Effect.exit))
    expect(state.published).toHaveLength(1)
    expect(state.published[0].data).toMatchObject({ sessionID })
  })

  test("error publication failure cannot replace the original execution cause", async () => {
    const state = fixture(true)
    const failure = new Error("original database admission failure")
    const exit = await Effect.runPromise(
      reportDrainFailure(Effect.die(failure), { sessionID, events: state.events }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
    expect(state.listeners.size).toBe(0)
  })
})
