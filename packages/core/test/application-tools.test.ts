import { describe, expect } from "bun:test"
import { Tool } from "@arforge-ai/core/tool/tool"
import { ApplicationTools } from "@arforge-ai/core/tool/application-tools"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { Tools } from "@arforge-ai/core/tool/tools"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { testEffect } from "./lib/effect"
import { location } from "./fixture/location"
import { ActionGateway } from "@arforge-ai/core/action-gateway"

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
// Read-only preflight resolution needs a real existing directory; the test
// file's own directory is deterministic on every platform.
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, ToolRegistry.toolsNode]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [PermissionV2.node, permission],
    [Location.node, current],
  ]),
)

const sessionID = SessionV2.ID.make("ses_application_tool")
const agent = AgentV2.ID.make("build")
const assistantMessageID = SessionMessage.ID.make("msg_application_tool")
const contextual = (contexts: Tool.Context[]) =>
  Tool.make({
    description: "Read application context",
    input: Schema.Struct({ query: Schema.String }),
    output: Schema.Struct({ answer: Schema.String }),
    execute: ({ query }, context) =>
      Effect.sync(() => {
        contexts.push(context)
        return { answer: query.toUpperCase() }
      }),
    toModelOutput: ({ output }) => [
      { type: "text", text: output.answer },
      { type: "file", data: "aGVsbG8=", mime: "image/png", name: "result.png" },
    ],
  })

describe("ApplicationTools", () => {
  it.effect("keeps an external JSON Schema exact and binds one canonical child-action context", () =>
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      const exactSchema = {
        type: "object",
        properties: {
          city: { type: "string", minLength: 1 },
          units: { enum: ["metric", "imperial"] },
        },
        required: ["city"],
        additionalProperties: false,
      }
      yield* tools.register({
        external_weather: Tool.make({
          description: "External weather",
          input: Schema.Unknown,
          inputJsonSchema: exactSchema,
          output: Schema.String,
          execute: (_input, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return "sunny"
            }),
        }),
      })
      exactSchema.properties.city.minLength = 99
      const materialized = yield* registry.materialize()
      expect(materialized.definitions.find((item) => item.name === "external_weather")?.inputSchema).toEqual(
        {
          ...exactSchema,
          properties: {
            ...exactSchema.properties,
            city: { ...exactSchema.properties.city, minLength: 1 },
          },
        },
      )
      expect(
        yield* materialized.settle({
          sessionID,
          agent,
          assistantMessageID,
          call: {
            type: "tool-call",
            id: "call-external-schema",
            name: "external_weather",
            input: { city: "Shanghai" },
          },
        }),
      ).toMatchObject({ result: { type: "text", value: "sunny" } })
      expect(contexts).toHaveLength(1)
      expect(contexts[0]?.abort).toBeInstanceOf(AbortSignal)
      expect(contexts[0]?.abort?.aborted).toBe(false)
      expect(contexts[0]?.childActions?.parentActionID).toBe(
        ActionGateway.stableActionID({
          sessionID,
          assistantMessageID,
          toolCallID: "call-external-schema",
        }),
      )
      expect(contexts[0]?.childActions?.execute).toBeTypeOf("function")
    }),
  )

  it.effect("keeps the Core carrier opaque and executes its single handler", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      const tool = contextual(contexts)
      expect(Object.keys(tool)).toEqual([])

      yield* applications.register({ opaque: tool })
      expect(
        yield* executeTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-opaque", name: "opaque", input: { query: "once" } },
        }),
      ).toEqual({
        type: "content",
        value: [
          { type: "text", text: "ONCE" },
          { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "result.png" },
        ],
      })
      expect(
        contexts.map(({ sessionID, agent, assistantMessageID, toolCallID }) => ({
          sessionID,
          agent,
          assistantMessageID,
          toolCallID,
        })),
      ).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-opaque" }])
    }),
  )

  it.effect("exposes narrow scoped Location registration and validates names", () =>
    Effect.gen(function* () {
      const tools: Tools.Interface = yield* Tools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()

      yield* tools.register({ location_tool: contextual([]) }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["location_tool"])
      expect(yield* Effect.flip(tools.register({ "invalid name": contextual([]) }))).toBeInstanceOf(
        Tool.RegistrationError,
      )

      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("filters an application tool catalog entry independently from runtime authorization", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      yield* applications.register({ application_context: contextual(contexts) })

      expect(
        yield* toolDefinitions(registry, [{ action: "application_context", resource: "*", effect: "deny" }]),
      ).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-denied", name: "application_context", input: { query: "hello" } },
        }),
      ).toMatchObject({ result: { type: "content" } })
      expect(
        contexts.map(({ sessionID, agent, assistantMessageID, toolCallID }) => ({
          sessionID,
          agent,
          assistantMessageID,
          toolCallID,
        })),
      ).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-denied" }])
    }),
  )

  it.effect("advertises and executes a scoped application tool with Session context", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []

      yield* applications.register({ application_context: contextual(contexts) })

      expect(yield* toolDefinitions(registry)).toMatchObject([
        { name: "application_context", description: "Read application context" },
      ])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-context", name: "application_context", input: { query: "hello" } },
        }),
      ).toEqual({
        result: {
          type: "content",
          value: [
            { type: "text", text: "HELLO" },
            { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "result.png" },
          ],
        },
        output: {
          structured: { answer: "HELLO" },
          content: [
            { type: "text", text: "HELLO" },
            { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "result.png" },
          ],
        },
      })
      expect(
        contexts.map(({ sessionID, agent, assistantMessageID, toolCallID }) => ({
          sessionID,
          agent,
          assistantMessageID,
          toolCallID,
        })),
      ).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-context" }])
    }),
  )

  it.effect("removes an application tool when its registration scope closes", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()

      yield* applications.register({ temporary: contextual([]) }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["temporary"])

      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("removes a tool before settling a call produced from an earlier definition", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const registrationScope = yield* Scope.make()
      yield* applications.register({ contextual: contextual([]) }).pipe(Scope.provide(registrationScope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["contextual"])

      yield* Scope.close(registrationScope, Exit.void)
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-removed", name: "contextual", input: { query: "hello" } },
        }),
      ).toEqual({ result: { type: "error", value: "Unknown tool: contextual" } })
    }),
  )

  it.effect("does not leak a registration into an already closed scope", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* Scope.close(scope, Exit.void)

      yield* applications.register({ closed: contextual([]) }).pipe(Scope.provide(scope))

      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("preserves an interrupted application registration until its scope closes", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* applications
        .register({ interrupted: contextual([]) })
        .pipe(
          Effect.andThen(Deferred.succeed(registered, undefined)),
          Effect.andThen(Effect.never),
          Scope.provide(scope),
          Effect.forkChild,
        )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["interrupted"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("captures the registered record before later State rebuilds", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const registered = { stable: contextual([]) }
      yield* applications.register(registered)
      Object.assign(registered, { late: contextual([]) })

      yield* Effect.scoped(applications.register({ temporary: contextual([]) }))

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["stable"])
    }),
  )

  it.effect("settles with the current same-name application tool and restores earlier registrations", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const firstContexts: Tool.Context[] = []
      const secondContexts: Tool.Context[] = []
      const scope = yield* Scope.make()
      yield* applications.register({ contextual: contextual(firstContexts) })
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["contextual"])
      yield* applications.register({ contextual: contextual(secondContexts) }).pipe(Scope.provide(scope))

      yield* settleTool(registry, {
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-second", name: "contextual", input: { query: "second" } },
      })
      yield* Scope.close(scope, Exit.void)
      yield* settleTool(registry, {
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-first", name: "contextual", input: { query: "first" } },
      })

      expect(
        secondContexts.map(({ sessionID, agent, assistantMessageID, toolCallID }) => ({
          sessionID,
          agent,
          assistantMessageID,
          toolCallID,
        })),
      ).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-second" }])
      expect(
        firstContexts.map(({ sessionID, agent, assistantMessageID, toolCallID }) => ({
          sessionID,
          agent,
          assistantMessageID,
          toolCallID,
        })),
      ).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-first" }])
    }),
  )

  it.effect("keeps the Location tool when an application tool has the same name", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const locationContexts: Tool.Context[] = []
      const applicationContexts: Tool.Context[] = []
      const location = contextual(locationContexts)
      yield* registry.register({ shared: location })
      yield* applications.register({ shared: contextual(applicationContexts) })

      expect(
        (yield* toolDefinitions(registry, [{ action: "shared", resource: "*", effect: "deny" }])).map(
          (definition) => definition.name,
        ),
      ).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-shared", name: "shared", input: { query: "location" } },
        }),
      ).toMatchObject({ result: { type: "content" } })
      expect(
        locationContexts.map(({ sessionID, agent, assistantMessageID, toolCallID }) => ({
          sessionID,
          agent,
          assistantMessageID,
          toolCallID,
        })),
      ).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-shared" }])
      expect(applicationContexts).toEqual([])
    }),
  )
})
