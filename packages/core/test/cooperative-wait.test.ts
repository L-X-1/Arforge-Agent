import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { CooperativeWaitV2 } from "@arforge-ai/core/cooperative-wait"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { SessionV2 } from "@arforge-ai/core/session"
import { CooperativeWaitTool } from "@arforge-ai/core/tool/cooperative-wait"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const firstSession = SessionV2.ID.make("ses_cooperative_wait_first")
const secondSession = SessionV2.ID.make("ses_cooperative_wait_second")
const currentLocation = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
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
      CooperativeWaitV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      CooperativeWaitTool.node,
    ]),
    [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Location.node, currentLocation],
      [PermissionV2.node, permission],
    ],
  ),
)

const waitUntilActive = (waits: CooperativeWaitV2.Interface, sessionID: SessionV2.ID) =>
  waits.active(sessionID).pipe(
    Effect.flatMap((active) => (active ? Effect.succeed(active) : Effect.sleep("5 millis").pipe(Effect.andThen(Effect.fail(false))))),
    Effect.retry({ while: (pending) => pending === false, times: 100 }),
  )

const collectEvents = Effect.gen(function* () {
  const captured: EventV2.Payload[] = []
  const events = yield* EventV2.Service
  yield* events.listen((event) =>
    Effect.sync(() => {
      if (event.type.startsWith("wait.")) captured.push(event)
    }),
  )
  return captured
})

describe("CooperativeWait", () => {
  it.live("completes with bounded periodic check-ins and exactly one terminal event", () =>
    Effect.gen(function* () {
      const waits = yield* CooperativeWaitV2.Service
      const events = yield* collectEvents
      const result = yield* waits.wait({
        sessionID: firstSession,
        durationSeconds: 0.16,
        checkInInterval: 0.05,
        reason: "  waiting   for build ",
      })
      yield* Effect.sleep("10 millis")

      expect(result).toMatchObject({ status: "completed", reason: "waiting for build" })
      expect(result.checkInCount).toBeGreaterThanOrEqual(2)
      expect(events[0]?.type).toBe("wait.started")
      expect(events.some((event) => event.type === "wait.check_in")).toBeTrue()
      expect(events.filter((event) => ["wait.completed", "wait.woken", "wait.cancelled", "wait.timed_out"].includes(event.type))).toHaveLength(1)
      expect(events.at(-1)?.type).toBe("wait.completed")
      expect(yield* waits.active(firstSession)).toBeUndefined()
    }),
  )

  it.live("wakes by the backend-issued ID and rejects stale or cross-session identifiers", () =>
    Effect.gen(function* () {
      const waits = yield* CooperativeWaitV2.Service
      const fiber = yield* waits
        .wait({
          sessionID: firstSession,
          durationSeconds: 2,
          checkInInterval: 0.5,
          reason: "external service",
        })
        .pipe(Effect.forkScoped)
      const active = yield* waitUntilActive(waits, firstSession)

      expect(
        yield* waits
          .wake({ sessionID: secondSession, waitID: active.waitID })
          .pipe(Effect.flip),
      ).toBeInstanceOf(CooperativeWaitV2.NotFoundError)
      expect(
        yield* waits
          .wake({ sessionID: firstSession, waitID: CooperativeWaitV2.ID.create() })
          .pipe(Effect.flip),
      ).toBeInstanceOf(CooperativeWaitV2.StaleIDError)
      expect(yield* waits.wake({ sessionID: firstSession, waitID: active.waitID })).toMatchObject({
        wakeRequested: true,
      })
      expect(yield* Fiber.join(fiber)).toMatchObject({ status: "woken" })
      expect(yield* waits.active(firstSession)).toBeUndefined()
    }),
  )

  it.live("rejects concurrent waits and cleans active state when the run is interrupted", () =>
    Effect.gen(function* () {
      const waits = yield* CooperativeWaitV2.Service
      const events = yield* collectEvents
      const fiber = yield* waits
        .wait({ sessionID: firstSession, durationSeconds: 2, checkInInterval: 0.5 })
        .pipe(Effect.forkScoped)
      yield* waitUntilActive(waits, firstSession)
      expect(
        yield* waits
          .wait({ sessionID: firstSession, durationSeconds: 0.1, checkInInterval: 0.05 })
          .pipe(Effect.flip),
      ).toBeInstanceOf(CooperativeWaitV2.ActiveWaitError)

      yield* Fiber.interrupt(fiber)
      yield* Effect.sleep("10 millis")
      expect(yield* waits.active(firstSession)).toBeUndefined()
      expect(events.filter((event) => event.type === "wait.cancelled")).toHaveLength(1)
      expect(events.filter((event) => event.type.startsWith("wait.") && /completed|woken|timed_out$/.test(event.type))).toHaveLength(0)
    }),
  )

  it.live("honors an internal monotonic deadline and rejects unbounded check-in volume", () =>
    Effect.gen(function* () {
      const waits = yield* CooperativeWaitV2.Service
      const result = yield* waits.wait({
        sessionID: firstSession,
        durationSeconds: 1,
        checkInInterval: 0.5,
        deadlineMonotonic: performance.now() + 60,
      })
      expect(result.status).toBe("timed_out")
      expect(result.elapsedSeconds).toBeLessThan(0.3)
      expect(
        yield* waits
          .wait({ sessionID: firstSession, durationSeconds: 300, checkInInterval: 0.05 })
          .pipe(Effect.flip),
      ).toMatchObject({ message: expect.stringContaining("maximum of 120") })
    }),
  )

  it.live("registers the exact deferred tool surface and inherits canonical session context", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["cooperative_wait"])
      expect(
        yield* executeTool(registry, {
          sessionID: firstSession,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-cooperative-wait",
            name: "cooperative_wait",
            input: { duration_seconds: 0.05, check_in_interval: 0.05, reason: "tool probe" },
          },
        }),
      ).toMatchObject({ type: "text", value: expect.stringContaining('"sessionID"') })
    }),
  )
})
