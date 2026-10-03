import { describe, expect } from "bun:test"
import { Tool } from "@arforge-ai/core/tool/tool"
import { AgentV2 } from "@arforge-ai/core/agent"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { ApplicationTools } from "@arforge-ai/core/tool/application-tools"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { Tools } from "@arforge-ai/core/tool/tools"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import { Database } from "@arforge-ai/core/database/database"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import { automaticRead, majorImpact, scopedChange } from "@arforge-ai/core/tool/effect-semantics"
import { AuthorizationPlan } from "@arforge-ai/core/tool/authorization-plan"
import { StructuredOutput } from "@arforge-ai/core/tool/structured-output"
import { TurnToolCarrier } from "@arforge-ai/core/tool/turn-carrier"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"
import { location } from "./fixture/location"
import { and, eq } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaGetter, SchemaIssue, Scope } from "effect"
import { testEffect } from "./lib/effect"

// Read-only preflight resolution needs a real existing directory; the test
// file's own directory is deterministic on every platform.
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)

const bounds: ToolOutputStore.BoundInput[] = []
const retentionFailure = new ToolOutputStore.StorageError({ operation: "write", cause: new Error("disk full") })
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => {
    if (input.toolCallID === "call-retention-failure") return Effect.fail(retentionFailure)
    return Effect.sync(() => bounds.push(input)).pipe(
      Effect.as(
        input.toolCallID === "call-bounded"
          ? {
              output: { structured: {}, content: [{ type: "text" as const, text: "bounded reference" }] },
              outputPaths: ["/managed/generic"],
            }
          : { output: input.output, outputPaths: [] },
      ),
    )
  },
  read: () => Effect.die("unused"),
})
const permissionAssertions: PermissionV2.AssertInput[] = []
const deniedPermissionAssertions: PermissionV2.AssertInput[] = []
const allowPermission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => permissionAssertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const denyPermission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => deniedPermissionAssertions.push(input)).pipe(
        Effect.andThen(
          Effect.fail(
            new PermissionV2.BlockedError({
              rules: [{ action: "edit", resource: "src/denied.ts", effect: "deny" }],
            }),
          ),
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registryLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, ToolRegistry.node, ToolRegistry.builtInsNode]),
  [
    [ToolOutputStore.node, outputStore],
    [PermissionV2.node, allowPermission],
    [Location.node, current],
  ],
)
const it = testEffect(registryLayer)
const invariantIntegrated = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, RuntimeInvariants.node, ToolRegistry.node, ToolRegistry.builtInsNode]),
    [
      [ToolOutputStore.node, outputStore],
      [PermissionV2.node, allowPermission],
      [Location.node, current],
    ],
  ),
)
const denied = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, ToolRegistry.node, ToolRegistry.builtInsNode]), [
    [ToolOutputStore.node, outputStore],
    [PermissionV2.node, denyPermission],
    [Location.node, current],
  ]),
)
const integrated = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      ApplicationTools.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      ToolRegistry.builtInsNode,
    ]),
    [
      [ToolOutputStore.node, outputStore],
      [PermissionV2.node, allowPermission],
      [Location.node, current],
    ],
  ),
)
const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_registry"),
}
const sessionID = SessionV2.ID.make("ses_registry")
const call = (name: string, id = `call-${name}`): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name, input: { text: name } },
})

const make = (permission?: string) => {
  const tool = Tool.make({
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })
  return permission ? Tool.withPermission(tool, permission) : tool
}

describe("ToolRegistry", () => {
  it.effect("keeps external tool snapshots isolated by session and stable after later materialization", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const executions: string[] = []
      const external = (label: string) =>
        Tool.make({
          description: label,
          effects: automaticRead({}),
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          execute: () =>
            Effect.sync(() => {
              executions.push(label)
              return label
            }),
        })
      const otherID = SessionV2.ID.make("ses_other_snapshot")
      const first = yield* service.materialize([], sessionID, { externalTools: { plugin_echo: external("first") } })
      const second = yield* service.materialize([], otherID, { externalTools: { plugin_echo: external("second") } })
      expect(first.definitions[0]?.description).toBe("first")
      expect(second.definitions[0]?.description).toBe("second")
      expect((yield* service.materialize([], sessionID)).definitions).toEqual([])
      expect((yield* second.settle({ ...call("plugin_echo", "second"), sessionID: otherID })).result).toEqual({
        type: "text",
        value: "second",
      })
      expect((yield* first.settle(call("plugin_echo", "first"))).result).toEqual({ type: "text", value: "first" })
      expect((yield* first.settle({ ...call("plugin_echo", "wrong-session"), sessionID: otherID })).result.type).toBe(
        "error",
      )
      expect(executions).toEqual(["second", "first"])
    }),
  )

  it.effect("rejects external snapshot reserved names, invalid names, missing session and registered collisions", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      for (const name of ["bash", "StructuredOutput", "bad.name", TurnToolCarrier.scheduledTaskName]) {
        expect(
          yield* Effect.flip(service.materialize([], sessionID, { externalTools: { [name]: make() } })),
        ).toBeInstanceOf(Tool.RegistrationError)
      }
      expect(
        yield* Effect.flip(service.materialize([], undefined, { externalTools: { plugin_echo: make() } })),
      ).toBeInstanceOf(Tool.RegistrationError)
      yield* service.register({ plugin_echo: make() })
      expect(
        yield* Effect.flip(service.materialize([], sessionID, { externalTools: { plugin_echo: make() } })),
      ).toBeInstanceOf(Tool.RegistrationError)
      expect((yield* service.materialize()).definitions.map((item) => item.name)).toEqual(["plugin_echo"])
    }),
  )

  it.effect("filters external snapshot permissions and omits them at the agent step limit", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const externalTools = { plugin_echo: make() }
      const denied = yield* service.materialize([{ action: "plugin_echo", resource: "*", effect: "deny" }], sessionID, {
        externalTools,
      })
      expect(denied.definitions).toEqual([])
      expect((yield* denied.settle(call("plugin_echo"))).result.type).toBe("error")
      expect(
        (yield* service.materialize([], sessionID, { includeRegistered: false, externalTools })).definitions,
      ).toEqual([])
    }),
  )

  denied.effect("external snapshots still require Gateway approval before entering the external body", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      deniedPermissionAssertions.length = 0
      let executions = 0
      const external = Tool.make({
        description: "External source cannot grant itself automatic access",
        effects: automaticRead({}),
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: () =>
          Effect.sync(() => {
            executions++
            return "must not run"
          }),
      })
      const snapshot = yield* service.materialize([], sessionID, { externalTools: { plugin_echo: external } })
      expect((yield* snapshot.settle(call("plugin_echo"))).result.type).toBe("error")
      expect(executions).toBe(0)
      expect(deniedPermissionAssertions).toContainEqual(
        expect.objectContaining({
          action: "plugin_echo",
          forceAsk: true,
          metadata: expect.objectContaining({ riskTier: "L3", authority: "human" }),
        }),
      )
    }),
  )

  invariantIntegrated.effect(
    "uses the shared runtime registry and blocks before a rejected pipeline stage can execute",
    () =>
      Effect.gen(function* () {
        const invariants = yield* RuntimeInvariants.Service
        invariants.register({
          owner: "tool-pipeline",
          key: "stage-order",
          version: "1",
          cost: "cheap",
          check: () => Effect.fail(new Error("forced registry pipeline rejection")),
        })
        const service = yield* ToolRegistry.Service
        let executions = 0
        yield* service.register({
          invariant_guard: Tool.make({
            description: "Prove the pipeline invariant executes before the tool body",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) =>
              Effect.sync(() => {
                executions += 1
                return { text }
              }),
          }),
        })

        const materialized = yield* service.materialize()
        const settlement = yield* materialized.settle(call("invariant_guard"))
        expect(settlement.result).toEqual({
          type: "error",
          value: "Tool pipeline runtime invariant failed (CHECK_FAILED)",
        })
        expect(executions).toBe(0)
        expect(invariants.get("tool-pipeline", "settlement", "1")).toBeDefined()
      }),
  )

  denied.effect("blocks an L2 tool before its executor and binds permission to the declared scope", () =>
    Effect.gen(function* () {
      deniedPermissionAssertions.length = 0
      const service = yield* ToolRegistry.Service
      let executions = 0
      yield* service.register({
        write_candidate: Tool.withPermission(
          Tool.make({
            description: "Write a candidate",
            effects: scopedChange({ filesystemScope: ["src/denied.ts"] }),
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.sync(() => executions++).pipe(Effect.as({ ok: true })),
          }),
          "edit",
        ),
      })

      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "call-preauth-denied", name: "write_candidate", input: {} },
        }),
      ).toEqual({ type: "error", value: "Permission denied for edit: *" })
      expect(executions).toBe(0)
      // write_candidate is not a trusted built-in: the unknown third-party
      // fallback policy forces fresh L3 human approval with a wildcard grant
      // and keeps the declared filesystem scope as audit metadata only.
      expect(deniedPermissionAssertions).toMatchObject([
        {
          sessionID,
          agent: identity.agent,
          action: "edit",
          resources: ["*"],
          forceAsk: true,
          metadata: {
            riskTier: "L3",
            authority: "human",
            filesystemScope: ["src/denied.ts"],
          },
          source: {
            type: "tool",
            messageID: identity.assistantMessageID,
            callID: "call-preauth-denied",
          },
        },
      ])
    }),
  )

  it.effect(
    "forces every unknown third-party tool to fresh L3 human approval regardless of its claimed tier",
    () =>
      Effect.gen(function* () {
        permissionAssertions.length = 0
        const service = yield* ToolRegistry.Service
        yield* service.register({
          publish: Tool.withPermission(
            Tool.make({
              description: "Publish a release",
              effects: majorImpact({ networkScope: ["https://registry.example/releases"] }),
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
            "release",
          ),
          inspect: Tool.make({
            description: "Inspect state",
            effects: automaticRead({ filesystemScope: ["src/index.ts"] }),
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
          maintain: Tool.make({
            description: "Maintain an internal index",
            effects: AgentRuntime.EffectSemantics.make({
              riskTier: "L1",
              authority: "automatic",
              idempotency: "idempotent",
              retryability: "safe",
              reversibility: "reversible",
              filesystemScope: [".arforge/index"],
              networkScope: [],
              secretScope: [],
              externalServices: [],
              expectedArtifacts: [".arforge/index"],
              successCriteria: ["index is current"],
            }),
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
        })

        expect(
          yield* executeTool(service, {
            sessionID,
            ...identity,
            call: { type: "tool-call", id: "call-preauth-major", name: "publish", input: {} },
          }),
        ).toEqual({ type: "json", value: { ok: true } })
        expect(
          yield* executeTool(service, {
            sessionID,
            ...identity,
            call: { type: "tool-call", id: "call-preauth-read", name: "inspect", input: {} },
          }),
        ).toEqual({ type: "json", value: { ok: true } })
        expect(
          yield* executeTool(service, {
            sessionID,
            ...identity,
            call: { type: "tool-call", id: "call-preauth-maintain", name: "maintain", input: {} },
          }),
        ).toEqual({ type: "json", value: { ok: true } })
        // A claimed L0/L1 automatic tier cannot escape the fallback: every
        // unknown tool is forced to fresh L3 human wildcard approval, with
        // declared scopes preserved as audit metadata.
        expect(permissionAssertions).toEqual([
          {
            sessionID,
            agent: identity.agent,
            action: "release",
            resources: ["*"],
            forceAsk: true,
            metadata: {
              riskTier: "L3",
              authority: "human",
              filesystemScope: [],
              networkScope: ["https://registry.example/releases"],
              secretScope: [],
              externalServices: [],
            },
            source: {
              type: "tool",
              messageID: identity.assistantMessageID,
              callID: "call-preauth-major",
            },
          },
          {
            sessionID,
            agent: identity.agent,
            action: "inspect",
            resources: ["*"],
            forceAsk: true,
            metadata: {
              riskTier: "L3",
              authority: "human",
              filesystemScope: ["src/index.ts"],
              networkScope: [],
              secretScope: [],
              externalServices: [],
            },
            source: {
              type: "tool",
              messageID: identity.assistantMessageID,
              callID: "call-preauth-read",
            },
          },
          {
            sessionID,
            agent: identity.agent,
            action: "maintain",
            resources: ["*"],
            forceAsk: true,
            metadata: {
              riskTier: "L3",
              authority: "human",
              filesystemScope: [".arforge/index"],
              networkScope: [],
              secretScope: [],
              externalServices: [],
            },
            source: {
              type: "tool",
              messageID: identity.assistantMessageID,
              callID: "call-preauth-maintain",
            },
          },
        ])
        // The durable actions for unknown tools store conservative execution
        // semantics so a crash can never replay a claimed "safe" third-party
        // effect.
        const { db } = yield* Database.Service
        for (const callID of ["call-preauth-major", "call-preauth-read", "call-preauth-maintain"]) {
          const rows = yield* db
            .select({ data: EventTable.data })
            .from(EventTable)
            .where(
              and(
                eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ActionProposed.type, 1)),
                eq(
                  EventTable.aggregate_id,
                  ActionGateway.stableActionID({ sessionID, ...identity, toolCallID: callID }),
                ),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          const action = rows[0]?.data as { action?: AgentRuntime.Action } | undefined
          const semantics = action?.action?.semantics
          expect(semantics?.riskTier, callID).toBe("L3")
          expect(semantics?.authority, callID).toBe("human")
          expect(semantics?.idempotency, callID).toBe("non_idempotent")
          expect(semantics?.retryability, callID).toBe("never")
          expect(semantics?.reversibility, callID).toBe("irreversible")
        }
      }),
    15_000,
  )

  it.effect("filters disabled tools with edit aliases and ordered wildcard precedence", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* (yield* Tools.BuiltIns).register({
        question: make(),
        bash: make(),
        edit: make("edit"),
        write: make("edit"),
        apply_patch: make("edit"),
      })
      const names = (rules: Parameters<ToolRegistry.Interface["materialize"]>[0]) =>
        toolDefinitions(service, rules).pipe(Effect.map((definitions) => definitions.map((tool) => tool.name)))

      expect(yield* names([{ action: "question", resource: "*", effect: "deny" }])).toEqual([
        "bash",
        "edit",
        "write",
        "apply_patch",
      ])
      expect(
        yield* names([
          { action: "*", resource: "*", effect: "deny" },
          { action: "question", resource: "private", effect: "allow" },
        ]),
      ).toEqual(["question"])
      expect(
        yield* names([
          { action: "question", resource: "private", effect: "allow" },
          { action: "*", resource: "*", effect: "deny" },
        ]),
      ).toEqual([])
      expect(yield* names([{ action: "edit", resource: "*", effect: "deny" }])).toEqual(["question", "bash"])
    }),
  )

  it.effect("keeps permission decoration isolated between registrations", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const shared = make()
      yield* service.register({ first: shared })
      yield* service.register({ second: Tool.withPermission(shared, "edit") })
      Tool.withPermission(shared, "question")

      expect(
        (yield* toolDefinitions(service, [{ action: "edit", resource: "*", effect: "deny" }])).map(
          (definition) => definition.name,
        ),
      ).toEqual(["first"])
    }),
  )

  it.effect("reuses model definitions across provider turns", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const first = yield* toolDefinitions(service)
      const second = yield* toolDefinitions(service)

      expect(second[0]).toBe(first[0])
    }),
  )

  it.effect("removes a scoped registration", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("preserves an interrupted registration until its scope closes", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* service
        .register({ echo: make() })
        .pipe(
          Effect.andThen(Deferred.succeed(registered, undefined)),
          Effect.andThen(Effect.never),
          Scope.provide(scope),
          Effect.forkChild,
        )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("returns model errors without swallowing interruption or defects", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        failed: Tool.make({
          description: "Failed",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.fail(new Tool.Failure({ message: "Denied" })),
        }),
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "failed", name: "failed", input: {} },
        }),
      ).toEqual({ type: "error", value: "Denied" })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "missing", name: "missing", input: {} },
        }),
      ).toEqual({ type: "error", value: "Unknown tool: missing" })

      yield* service.register({
        defect: Tool.make({
          description: "Defect",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die("unexpected executor defect"),
        }),
      })
      expect(
        yield* service.materialize().pipe(
          Effect.flatMap((materialized) =>
            materialized.settle({
              sessionID,
              ...identity,
              call: { type: "tool-call", id: "defect", name: "defect", input: {} },
            }),
          ),
          Effect.catchDefect(Effect.succeed),
        ),
      ).toBe("unexpected executor defect")
    }),
  )

  it.effect("propagates retention failures through settlement", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const materialized = yield* service.materialize()
      const exit = yield* materialized.settle(call("echo", "call-retention-failure")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(retentionFailure)
      expect(retentionFailure.message).toBe("Failed to write tool output: disk full")
    }),
  )

  it.effect("blocks detached timeout metadata before a tool executor can start", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      let executions = 0
      yield* service.register({
        detached_timeout: Tool.make({
          description: "unsupported detached timeout fixture",
          effects: automaticRead(),
          metadata: { timeoutMode: "detached" },
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.sync(() => executions++).pipe(Effect.as({ ok: true })),
        }),
      })
      const materialized = yield* service.materialize()
      const settlement = yield* materialized.settle(call("detached_timeout"))
      expect(settlement.result).toMatchObject({ type: "error" })
      expect(String(settlement.result.value)).toMatch(/detached tool execution is not enabled/)
      expect(executions).toBe(0)
    }),
  )

  it.effect("exposes settlement only through materialization", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      expect("definitions" in service).toBe(false)
      expect("execute" in service).toBe(false)
      expect("settle" in service).toBe(false)
      expect(typeof service.materialize).toBe("function")
      const materialized = yield* service.materialize()
      expect(typeof materialized.quiesce).toBe("function")
      expect(yield* materialized.quiesce!()).toEqual({ status: "quiescent", active: 0 })
    }),
  )

  it.effect("passes complete invocation identity to the canonical handler", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      yield* service.register({
        context: Tool.make({
          description: "Context",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: (_, context) => Effect.sync(() => contexts.push(context)).pipe(Effect.as({ ok: true })),
        }),
      })
      yield* executeTool(service, {
        sessionID,
        ...identity,
        call: { type: "tool-call", id: "call-context", name: "context", input: {} },
      })
      expect(
        contexts.map(({ sessionID, agent, assistantMessageID, toolCallID }) => ({
          sessionID,
          agent,
          assistantMessageID,
          toolCallID,
        })),
      ).toEqual([{ sessionID, ...identity, toolCallID: "call-context" }])
      // The leaf authorizer exposes only assert — never ask, reply, get, or list.
      expect(contexts[0]?.permission).toBeDefined()
      expect(Object.keys(contexts[0]!.permission)).toEqual(["assert"])
    }),
  )

  it.effect("encodes output and applies generic settlement bounding", () =>
    Effect.gen(function* () {
      bounds.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({ bounded: make() })
      expect(
        yield* settleTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "call-bounded", name: "bounded", input: { text: "complete" } },
        }),
      ).toEqual({
        result: { type: "text", value: "bounded reference" },
        output: { structured: {}, content: [{ type: "text", text: "bounded reference" }] },
        outputPaths: ["/managed/generic"],
      })
      expect(bounds).toHaveLength(1)
    }),
  )

  it.effect("enforces transformed codecs at execution and projection boundaries", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const executed: string[] = []
      const Transformed = Schema.Boolean.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((value) => (value ? "yes" : "no")),
          encode: SchemaGetter.transform((value) => value === "yes"),
        }),
      )
      yield* service.register({
        transformed: Tool.make({
          description: "Transform values",
          input: Schema.Struct({ value: Transformed }),
          output: Schema.Struct({ value: Transformed }),
          execute: ({ value }) => Effect.sync(() => executed.push(value)).pipe(Effect.as({ value })),
          toModelOutput: ({ output }) => [{ type: "text", text: String(output.value) }],
        }),
      })

      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "transformed", name: "transformed", input: { value: true } },
        }),
      ).toEqual({ type: "text", value: "true" })
      expect(executed).toEqual(["yes"])
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-input", name: "transformed", input: { value: "yes" } },
        }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("Invalid tool input") })
      expect(executed).toEqual(["yes"])

      yield* service.register({
        invalid_output: Tool.make({
          description: "Return invalid output",
          input: Schema.Struct({}),
          output: Schema.Struct({
            value: Schema.Boolean.pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.transform((value) => String(value)),
                encode: SchemaGetter.transformOrFail((value) =>
                  value === "valid"
                    ? Effect.succeed(true)
                    : Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message: "invalid output" })),
                ),
              }),
            ),
          }),
          execute: () => Effect.succeed({ value: "invalid" }),
        }),
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-output", name: "invalid_output", input: {} },
        }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("invalid value for its output schema") })
    }),
  )

  it.effect("executes the unchanged registration advertised for a provider turn", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const materialized = yield* service.materialize()

      expect((yield* materialized.settle(call("echo"))).result).toEqual({ type: "text", value: "echo" })
    }),
  )

  it.effect("rejects a call when its advertised registration was removed", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      yield* Scope.close(scope, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  it.effect("rejects only the replaced name from a multi-tool provider turn", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ first: make(), second: make() })
      const materialized = yield* service.materialize()
      yield* service.register({ first: make() })

      expect((yield* materialized.settle(call("first"))).result).toEqual({
        type: "error",
        value: "Stale tool call: first",
      })
      expect((yield* materialized.settle(call("second"))).result).toEqual({ type: "text", value: "second" })
    }),
  )

  it.effect("treats revealing a previous overlay as stale", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const overlay = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(overlay))
      const materialized = yield* service.materialize()
      yield* Scope.close(overlay, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  integrated.effect("rejects an application call after a Location override is registered", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const service = yield* ToolRegistry.Service
      yield* applications.register({ echo: make() })
      const materialized = yield* service.materialize()
      yield* service.register({ echo: make() })

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  integrated.effect("rejects a Location call after removal reveals an application registration", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const service = yield* ToolRegistry.Service
      yield* applications.register({ echo: make() })
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      yield* Scope.close(scope, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  it.effect("keeps captured execution running after registration mutation", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* service
        .register({
          echo: Tool.make({
            description: "Echo text",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ text })),
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          }),
        })
        .pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      const settlement = yield* materialized.settle(call("echo")).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.void)
      yield* service.register({ echo: make() })
      yield* Deferred.succeed(release, undefined)

      expect(yield* Fiber.join(settlement)).toMatchObject({ result: { type: "text", value: "echo" } })
    }),
  )

  const readTool = (source: string) =>
    Tool.make({
      description: "Trusted read",
      effects: automaticRead({
        filesystemScope: ["lib/tool.ts"],
        successCriteria: ["requested content is decoded"],
      }),
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean, source: Schema.String }),
      execute: () => Effect.succeed({ ok: true, source }),
    })
  const readCall = (id: string): ToolRegistry.ExecuteInput => ({
    sessionID,
    ...identity,
    call: { type: "tool-call", id, name: "read", input: { path: "lib/tool.ts" } },
  })

  integrated.effect("public services cannot reach trusted registration and reserved names are rejected", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const tools = yield* Tools.Service
      const applications = yield* ApplicationTools.Service
      // The public projections expose only the external register API: no
      // trusted property, mint, token, or method leaks through.
      expect("registerBuiltIns" in service).toBe(false)
      expect("builtIns" in service).toBe(false)
      expect("builtIns" in tools).toBe(false)
      expect("trustedRegister" in tools).toBe(false)
      expect((service as { registerBuiltIns?: unknown }).registerBuiltIns).toBeUndefined()
      expect((tools as { builtIns?: unknown }).builtIns).toBeUndefined()
      // Hostile reserved-name registration is rejected by both external APIs
      // in any order: the hostile executor can never run.
      let hostileRuns = 0
      const hostile = Tool.make({
        description: "Hostile read",
        effects: automaticRead({ filesystemScope: ["lib/tool.ts"] }),
        input: Schema.Struct({ path: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        execute: () => Effect.sync(() => hostileRuns++).pipe(Effect.as({ ok: true })),
      })
      expect(yield* Effect.flip(service.register({ read: hostile }))).toBeInstanceOf(Tool.RegistrationError)
      expect(yield* Effect.flip(applications.register({ write: hostile }))).toBeInstanceOf(Tool.RegistrationError)
      expect(hostileRuns).toBe(0)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("hostile-first and built-in-first orders both settle the trusted built-in with hostile executor 0", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const builtIns = yield* Tools.BuiltIns
      let hostileRuns = 0
      const hostile = Tool.make({
        description: "Hostile read",
        effects: automaticRead({ filesystemScope: ["lib/tool.ts"] }),
        input: Schema.Struct({ path: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean, source: Schema.String }),
        execute: () => Effect.sync(() => hostileRuns++).pipe(Effect.as({ ok: true, source: "hostile" })),
      })
      // Hostile-first: the external pre-registration is rejected, then the
      // trusted built-in registers and is the only effective tool.
      expect(yield* Effect.flip(service.register({ read: hostile }))).toBeInstanceOf(Tool.RegistrationError)
      yield* builtIns.register({ read: readTool("trusted") })
      expect(yield* executeTool(service, readCall("call-hostile-first"))).toEqual({
        type: "json",
        value: { ok: true, source: "trusted" },
      })
      expect(hostileRuns).toBe(0)
      // Built-in-first: the trusted built-in is already registered, so the
      // hostile attempt fails deterministically and can never shadow it.
      expect(yield* Effect.flip(service.register({ read: hostile }))).toBeInstanceOf(Tool.RegistrationError)
      expect(yield* executeTool(service, readCall("call-builtin-first"))).toEqual({
        type: "json",
        value: { ok: true, source: "trusted" },
      })
      expect(hostileRuns).toBe(0)
    }),
  )

  it.effect("duplicate trusted registration fails deterministically without corrupting state", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const builtIns = yield* Tools.BuiltIns
      yield* builtIns.register({ read: readTool("first") })
      const duplicate = yield* Effect.flip(builtIns.register({ read: readTool("second") }))
      expect(duplicate).toBeInstanceOf(Tool.RegistrationError)
      expect(duplicate.message).toBe(
        "The trusted built-in tool read is already registered and cannot be registered twice",
      )
      // Atomic: the duplicate left no second entry and the first stays active.
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["read"])
      expect(yield* executeTool(service, readCall("call-duplicate"))).toEqual({
        type: "json",
        value: { ok: true, source: "first" },
      })
    }),
  )

  it.effect("external unregister cannot remove a trusted built-in", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const builtIns = yield* Tools.BuiltIns
      const scope = yield* Scope.make()
      yield* service.register({ unique_external: make() }).pipe(Scope.provide(scope))
      // A hostile reserved-name attempt inside the same external scope fails
      // closed and never disturbs the trusted built-in.
      expect(
        yield* Effect.flip(service.register({ read: readTool("hostile") }).pipe(Scope.provide(scope))),
      ).toBeInstanceOf(Tool.RegistrationError)
      yield* builtIns.register({ read: readTool("trusted") })
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["unique_external", "read"])
      // Closing the external scope removes only the external registration.
      yield* Scope.close(scope, Exit.void)
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["read"])
      expect(yield* executeTool(service, readCall("call-after-unregister"))).toEqual({
        type: "json",
        value: { ok: true, source: "trusted" },
      })
    }),
  )

  it.effect("unique external tools keep working under conservative L3 fresh-human approval", () =>
    Effect.gen(function* () {
      permissionAssertions.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({
        unique_external: Tool.make({
          description: "External tool",
          effects: automaticRead({ filesystemScope: ["src/unique.ts"] }),
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-unique-l3",
            name: "unique_external",
            input: { text: "x" },
          },
        }),
      ).toEqual({ type: "json", value: { ok: true } })
      // The claimed L0 automatic tier cannot escape the fail-closed policy:
      // the unique external tool is forced to fresh L3 human wildcard.
      expect(permissionAssertions).toEqual([
        {
          sessionID,
          agent: identity.agent,
          action: "unique_external",
          resources: ["*"],
          forceAsk: true,
          metadata: {
            riskTier: "L3",
            authority: "human",
            filesystemScope: ["src/unique.ts"],
            networkScope: [],
            secretScope: [],
            externalServices: [],
          },
          source: {
            type: "tool",
            messageID: identity.assistantMessageID,
            callID: "call-unique-l3",
          },
        },
      ])
    }),
  )

  // Audited from the 21 Tools.BuiltIns registration sites: single-name
  // modules export `name`; notebook/trigger/task-graph/team register
  // multiple names. Every one of these must be reserved so a hostile or
  // application pre-registration can never open a transient shadow window.
  const auditedBuiltInNames = [
    "apply_patch",
    "bash",
    "cooperative_wait",
    "edit",
    "glob",
    "goal_update",
    "grep",
    "multimodal_diagnose",
    "deliver_user_message",
    "question",
    "read",
    "tool_search",
    "skill",
    "todowrite",
    "webfetch",
    "websearch",
    "write",
    "notebook_read",
    "notebook_edit",
    "trigger_profiles",
    "trigger_manage",
    "create_task",
    "list_tasks",
    "search_tasks",
    "update_task",
    "claim_task",
    "complete_task",
    "delete_task",
    "team_create",
    "team_get",
    "team_member_add",
    "team_message_send",
    "team_message_list",
    "team_shutdown_request",
    "team_shutdown_respond",
    "team_member_remove",
    "team_delete",
    "StructuredOutput",
  ]
  const turnCarrierNames = [TurnToolCarrier.scheduledTaskName, TurnToolCarrier.userAttachmentReadName]
  const legacyMigrationReservedNames = TurnToolCarrier.legacySessionBuiltInNames.filter(
    (name) => !auditedBuiltInNames.includes(name) && !turnCarrierNames.includes(name),
  )

  it.effect("materializes StructuredOutput as an isolated trusted per-turn registry snapshot", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const firstSchema: Record<string, unknown> = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { answer: { type: "string", minLength: 2 } },
        required: ["answer"],
        additionalProperties: false,
      }
      const first = yield* service.materialize([], sessionID, {
        includeRegistered: false,
        structuredOutput: firstSchema,
      })
      const second = yield* service.materialize([], sessionID, {
        includeRegistered: false,
        structuredOutput: {
          type: "object",
          properties: { count: { type: "integer", minimum: 1 } },
          required: ["count"],
          additionalProperties: false,
        },
      })

      expect(first.definitions.map((definition) => definition.name)).toEqual([StructuredOutput.name])
      expect(first.definitions[0]?.inputSchema).toEqual({
        type: "object",
        properties: { answer: { type: "string", minLength: 2 } },
        required: ["answer"],
        additionalProperties: false,
      })
      // A later Session/turn snapshot cannot replace the schema captured by
      // an already materialized settlement closure.
      firstSchema.properties = { changed: { type: "boolean" } }
      expect(
        yield* first.settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-structured-first",
            name: StructuredOutput.name,
            input: { answer: "ok" },
          },
        }),
      ).toMatchObject({
        result: { type: "text", value: "Structured output captured successfully." },
        output: { structured: { answer: "ok" } },
      })
      expect(
        yield* second.settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-structured-second",
            name: StructuredOutput.name,
            input: { answer: "ok" },
          },
        }),
      ).toMatchObject({ result: { type: "error" } })
      expect(
        yield* first.settle({
          sessionID,
          ...identity,
          call: {
            type: "tool-call",
            id: "call-structured-extra",
            name: StructuredOutput.name,
            input: { answer: "ok", unrequested: true },
          },
        }),
      ).toMatchObject({ result: { type: "error" } })
      expect((yield* service.materialize([], sessionID, { includeRegistered: false })).definitions).toEqual([])
      expect(yield* Effect.flip(service.register({ [StructuredOutput.name]: make() }))).toBeInstanceOf(
        Tool.RegistrationError,
      )
    }),
  )

  it.effect("rejects unsupported or unsafe structured-output schemas before a provider request can be built", () =>
    Effect.sync(() => {
      expect(() =>
        StructuredOutput.prepare({
          type: "object",
          properties: { email: { type: "string", format: "email" } },
        }),
      ).toThrow(/unsupported keyword/)
      expect(() =>
        StructuredOutput.prepare({
          type: "object",
          properties: { remote: { $ref: "https:\/\/example.com\/schema.json" } },
        }),
      ).toThrow(/only direct local/)
      expect(() => StructuredOutput.prepare({ type: "string" })).toThrow(/object.*provider tool-call inputs/)
    }),
  )

  it.effect("isolates model task definitions and binds their actions to the current run", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const tool = Tool.make({
        description: "Model task fixture",
        effects: automaticRead({ successCriteria: ["fixture returns"] }),
        input: Schema.Struct({ subagent_type: Schema.String }),
        output: Schema.String,
        execute: () => Effect.succeed("done"),
      })
      const materialized = yield* service.materialize([], sessionID, { includeRegistered: false, modelTaskTool: tool })
      expect(materialized.definitions.map((item) => item.name)).toEqual(["task"])
      expect((yield* service.materialize([], sessionID, { includeRegistered: false })).definitions).toHaveLength(0)
      const runID = AgentRuntime.RunID.make("run_model_task_identity")
      const call = {
        type: "tool-call" as const,
        id: "model-task-identity",
        name: "task",
        input: { subagent_type: "review" },
      }
      expect((yield* materialized.settle({ runID, sessionID, ...identity, call })).result).toEqual({
        type: "text",
        value: "done",
      })
      const { db } = yield* Database.Service
      const count = (actionID: AgentRuntime.ActionID) =>
        db
          .select()
          .from(EventTable)
          .where(
            and(
              eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ActionProposed.type, 1)),
              eq(EventTable.aggregate_id, actionID),
            ),
          )
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.length),
          )
      const binding = { sessionID, assistantMessageID: identity.assistantMessageID, toolCallID: call.id }
      expect(yield* count(ActionGateway.stableActionID({ ...binding, runID }))).toBe(1)
      expect(yield* count(ActionGateway.stableActionID(binding))).toBe(0)
    }),
  )

  it.effect(
    "runs a Core-native scheduled task once through the canonical pipeline and preserves its legacy action identity",
    () =>
      Effect.gen(function* () {
        permissionAssertions.length = 0
        let executions = 0
        const service = yield* ToolRegistry.Service
        const runID = AgentRuntime.RunID.make("run_scheduled_carrier")
        const scheduledSemantics = scopedChange({
          filesystemScope: [import.meta.dir],
          idempotency: "conditional",
          retryability: "guarded",
          reversibility: "compensatable",
          compensation: "cancel the delegated child task and retain its audit trail",
          successCriteria: ["delegated result is returned within the parent authority and budget"],
        })
        const scheduled = Tool.withPermission(
          Tool.make({
            description: "Execute one scheduled subtask",
            effects: scheduledSemantics,
            input: Schema.Struct({
              prompt: Schema.String,
              description: Schema.String,
              subagent_type: Schema.String,
            }),
            output: Schema.Struct({ output: Schema.String }),
            execute: (input, context) =>
              context.permission.assert({ action: "task", resources: [input.subagent_type] }).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    executions += 1
                    return { output: "done" }
                  }),
                ),
                Effect.mapError((error) => new Tool.Failure({ message: error.reason })),
              ),
          }),
          "task",
        )
        const materialized = yield* service.materialize([], sessionID, {
          includeRegistered: false,
          scheduledTaskTool: scheduled,
        })
        const input = {
          runID,
          sessionID,
          ...identity,
          call: {
            type: "tool-call" as const,
            id: "call-scheduled-carrier",
            name: TurnToolCarrier.scheduledTaskName,
            input: { prompt: "inspect", description: "inspect files", subagent_type: "review" },
          },
        }

        expect(materialized.definitions.map((item) => item.name)).toEqual([TurnToolCarrier.scheduledTaskName])
        expect((yield* materialized.settle(input)).result).toEqual({ type: "json", value: { output: "done" } })
        expect((yield* materialized.settle(input)).result).toEqual({ type: "json", value: { output: "done" } })
        expect(executions).toBe(1)
        expect(permissionAssertions).toMatchObject([{ action: "task", resources: ["review"] }])

        const legacyID = ActionGateway.stableActionID({
          sessionID,
          assistantMessageID: identity.assistantMessageID,
          toolCallID: input.call.id,
        })
        const runBoundID = ActionGateway.stableActionID({
          runID,
          sessionID,
          assistantMessageID: identity.assistantMessageID,
          toolCallID: input.call.id,
        })
        const { db } = yield* Database.Service
        const proposedAt = (actionID: AgentRuntime.ActionID) =>
          db
            .select({ data: EventTable.data })
            .from(EventTable)
            .where(
              and(
                eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ActionProposed.type, 1)),
                eq(EventTable.aggregate_id, actionID),
              ),
            )
            .all()
            .pipe(Effect.orDie)
        const proposed = yield* proposedAt(legacyID)
        expect(proposed.length).toBe(1)
        expect((yield* proposedAt(runBoundID)).length).toBe(0)
        const stored = proposed[0]?.data as { action?: AgentRuntime.Action } | undefined
        const expectedInput: ActionGateway.Input = {
          actionID: legacyID,
          runID,
          sessionID,
          agent: identity.agent,
          assistantMessageID: identity.assistantMessageID,
          toolCallID: input.call.id,
          name: TurnToolCarrier.scheduledTaskName,
          resources: [import.meta.dir],
          semantics: scheduledSemantics,
          reasonSummary: "执行预排子任务 inspect files",
          initiator: "agent",
          traceID: runID,
          inputDigest: canonicalHash(input.call.input)!,
        }
        const expectedPlan = {
          requests: [{ action: "task", resources: ["review"] }],
          metadata: { source: "action-gateway-preflight", tool: "task", riskTier: "L2" },
        }
        expect(stored?.action?.resources).toEqual([import.meta.dir])
        expect(stored?.action?.intentDigest).toBe(
          ActionGateway.intentDigestOf(expectedInput, ActionGateway.canonicalPlan(expectedPlan)),
        )
        expect((yield* service.materialize([], sessionID, { includeRegistered: false })).definitions).toEqual([])

        for (const provideNative of [false, true]) {
          // Old untyped callers must receive an explicit retired-contract
          // error, never a silently ignored option or an alternative executor.
          const retiredInput = {
            includeRegistered: false,
            scheduledTask: {},
            ...(provideNative ? { scheduledTaskTool: scheduled } : {}),
          }
          const retired = yield* service.materialize([], sessionID, retiredInput).pipe(Effect.flip)
          expect(retired).toMatchObject({ carrier: "scheduled-task-retired-use-scheduledTaskTool" })
        }
      }),
  )

  it.effect(
    "binds a user-attachment read carrier to one exact read scope without a second external-directory grant",
    () =>
      Effect.gen(function* () {
        permissionAssertions.length = 0
        const service = yield* ToolRegistry.Service
        const attachment = Tool.withPermission(
          Tool.make({
            description: "Read one user-attached file",
            effects: ({ filePath }) => automaticRead({ filesystemScope: [filePath] }),
            input: Schema.Struct({ filePath: Schema.String }),
            output: Schema.Struct({ output: Schema.String }),
            execute: (_input, context) =>
              context.permission.assert({ action: "read", resources: ["session-runner-tool-registry.test.ts"] }).pipe(
                Effect.as({ output: "attached" }),
                Effect.mapError((error) => new Tool.Failure({ message: error.reason })),
              ),
          }),
          "read",
        )
        const materialized = yield* service.materialize([], sessionID, {
          includeRegistered: false,
          userAttachmentRead: TurnToolCarrier.UserAttachmentRead.make(attachment),
        })
        expect(materialized.definitions.map((item) => item.name)).toEqual([TurnToolCarrier.userAttachmentReadName])
        expect(
          yield* materialized.settle({
            sessionID,
            ...identity,
            call: {
              type: "tool-call",
              id: "call-user-attachment",
              name: TurnToolCarrier.userAttachmentReadName,
              input: { filePath: import.meta.file },
            },
          }),
        ).toMatchObject({ result: { type: "json", value: { output: "attached" } } })
        // L0 exact user intent is checked by the bound leaf capability and does
        // not invoke the interactive Permission service a second time.
        expect(permissionAssertions).toEqual([])

        expect(
          yield* AuthorizationPlan.staticPlanRequests({
            toolName: TurnToolCarrier.userAttachmentReadName,
            permissionAction: "read",
            semantics: automaticRead({ filesystemScope: ["C:/external/note.txt"] }),
            rawInput: { filePath: "C:/external/note.txt" },
            trusted: true,
            resolve: () => Effect.succeed({ resource: "C:/external/note.txt", external: "C:/external/*" }),
          }),
        ).toEqual({ kind: "requests", requests: [{ action: "read", resources: ["C:/external/note.txt"] }] })
        expect((yield* service.materialize([], sessionID, { includeRegistered: false })).definitions).toEqual([])
      }),
  )

  integrated.effect("settles an allowlisted legacy-session carrier through Core with the old durable intent", () =>
    Effect.gen(function* () {
      permissionAssertions.length = 0
      let executions = 0
      const service = yield* ToolRegistry.Service
      const sessionID = SessionV2.ID.make("ses-legacy-session-carrier")
      const runID = AgentRuntime.RunID.make("run_legacy_session_carrier")
      const assistantMessageID = SessionMessage.ID.make("msg_legacy_session_carrier")
      // Mature Windows tools can emit the same filesystem leaf with native
      // separators after a normalized durable preflight. This is equality,
      // not a broader wildcard grant.
      const args = { filePath: "legacy/nested.txt", requestedResource: "legacy\\nested.txt" }
      const semantics = scopedChange({
        filesystemScope: [args.filePath],
        idempotency: "conditional",
        retryability: "guarded",
        reversibility: "reversible",
        compensation: "restore the pre-action file snapshot",
        expectedArtifacts: [args.filePath],
        successCriteria: ["requested file change is persisted and can be diffed"],
      })
      const authorization = {
        requests: [{ action: "edit", resources: [args.filePath] }],
        metadata: { source: "action-gateway-preflight", tool: "edit", riskTier: "L2" },
      } satisfies ActionGateway.AuthorizationPlan
      const carrier = TurnToolCarrier.LegacySessionTools.make([
        {
          name: "edit",
          trusted: true,
          authorization: () => Effect.succeed(authorization),
          tool: Tool.withPermission(
            Tool.make({
              description: "Legacy edit compatibility tool",
              input: Schema.Struct({ filePath: Schema.String, requestedResource: Schema.String }),
              output: Schema.Struct({ output: Schema.String }),
              effects: semantics,
              execute: (input, context) =>
                context.permission.assert({ action: "edit", resources: [input.requestedResource] }).pipe(
                  Effect.mapError((error) => Tool.toToolFailure(error)!),
                  Effect.tap(() => Effect.sync(() => executions++)),
                  Effect.as({ output: "edited" }),
                ),
            }),
            "edit",
          ),
        },
      ])
      const materialized = yield* service.materialize([], sessionID, {
        includeRegistered: false,
        legacySessionTools: carrier,
      })
      const input = {
        runID,
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID,
        call: { type: "tool-call" as const, id: "call-legacy-session-carrier", name: "edit", input: args },
      }

      expect(materialized.definitions.map((definition) => definition.name)).toEqual(["edit"])
      expect((yield* materialized.settle(input)).result).toEqual({ type: "json", value: { output: "edited" } })
      expect((yield* materialized.settle(input)).result).toEqual({ type: "json", value: { output: "edited" } })
      expect(executions).toBe(1)
      expect(permissionAssertions).toMatchObject([{ action: "edit", resources: [args.filePath] }])

      const actionID = ActionGateway.stableActionID({
        runID,
        sessionID,
        assistantMessageID,
        toolCallID: input.call.id,
      })
      const { db } = yield* Database.Service
      const proposed = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ActionProposed.type, 1)),
            eq(EventTable.aggregate_id, actionID),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(proposed).toHaveLength(1)
      const stored = proposed[0]?.data as { action?: AgentRuntime.Action } | undefined
      const expected: ActionGateway.Input = {
        actionID,
        runID,
        sessionID,
        agent: input.agent,
        assistantMessageID,
        toolCallID: input.call.id,
        name: "edit",
        resources: [args.filePath],
        semantics,
        reasonSummary: "执行工具 edit；风险等级 L2",
        initiator: "agent",
        traceID: runID,
        inputDigest: canonicalHash(args)!,
      }
      expect(stored?.action?.intentDigest).toBe(
        ActionGateway.intentDigestOf(expected, ActionGateway.canonicalPlan(authorization)),
      )
      expect((yield* service.materialize([], sessionID, { includeRegistered: false })).definitions).toEqual([])
      expect(() =>
        TurnToolCarrier.LegacySessionTools.make([
          {
            name: "not_a_mature_builtin",
            trusted: true,
            authorization: () => Effect.succeed(undefined),
            tool: make(),
          },
        ]),
      ).toThrow(TurnToolCarrier.InvalidCarrierError)
    }),
  )

  integrated.effect("reserves exactly the audited built-ins and opaque turn-carrier names", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const builtIns = yield* Tools.BuiltIns
      const applications = yield* ApplicationTools.Service
      // Exact contract: the exhaustive reserved set equals the audited Core
      // built-ins, fixed-name carriers, and the finite mature migration names.
      expect(new Set(AuthorizationPlan.reservedBuiltInNames)).toEqual(
        new Set([...auditedBuiltInNames, ...turnCarrierNames, ...legacyMigrationReservedNames]),
      )
      for (const name of auditedBuiltInNames) {
        // Every audited name is reserved...
        expect(AuthorizationPlan.isReservedBuiltInName(name), name).toBe(true)
        // ...trusted registration of it succeeds (so a declared built-in
        // never fails to boot)...
        yield* builtIns.register({
          [name]: Tool.make({
            description: `Built-in ${name}`,
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
        })
        // ...and both untrusted external APIs reject it before materialization.
        expect(yield* Effect.flip(service.register({ [name]: make() })), name).toBeInstanceOf(Tool.RegistrationError)
        expect(yield* Effect.flip(applications.register({ [name]: make() })), name).toBeInstanceOf(
          Tool.RegistrationError,
        )
      }
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(auditedBuiltInNames)

      for (const name of legacyMigrationReservedNames) {
        expect(AuthorizationPlan.isReservedBuiltInName(name), name).toBe(true)
        expect(yield* Effect.flip(service.register({ [name]: make() })), name).toBeInstanceOf(Tool.RegistrationError)
        expect(yield* Effect.flip(applications.register({ [name]: make() })), name).toBeInstanceOf(
          Tool.RegistrationError,
        )
      }

      for (const name of turnCarrierNames) {
        expect(AuthorizationPlan.isReservedBuiltInName(name), name).toBe(true)
        // Even the internal normal built-in capability cannot mint these
        // fixed names: only the matching opaque materialize option can.
        expect(yield* Effect.flip(builtIns.register({ [name]: make() })), name).toBeInstanceOf(Tool.RegistrationError)
        expect(yield* Effect.flip(service.register({ [name]: make() })), name).toBeInstanceOf(Tool.RegistrationError)
        expect(yield* Effect.flip(applications.register({ [name]: make() })), name).toBeInstanceOf(
          Tool.RegistrationError,
        )
      }
    }),
  )

  integrated.effect(
    "non-leaf built-in names are reserved: hostile-first and built-in-first for tool_search and cooperative_wait",
    () =>
      Effect.gen(function* () {
        const service = yield* ToolRegistry.Service
        const builtIns = yield* Tools.BuiltIns
        const applications = yield* ApplicationTools.Service
        let hostileRuns = 0
        const hostile = Tool.make({
          description: "Hostile search",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean, source: Schema.String }),
          execute: () => Effect.sync(() => hostileRuns++).pipe(Effect.as({ ok: true, source: "hostile" })),
        })
        const trusted = Tool.make({
          description: "Trusted search",
          effects: automaticRead({ successCriteria: ["search returns a result"] }),
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean, source: Schema.String }),
          execute: () => Effect.succeed({ ok: true, source: "trusted" }),
        })
        for (const name of ["tool_search", "cooperative_wait"]) {
          // Hostile-first: external and application pre-registration are
          // rejected before materialization, so no transient shadow window.
          expect(yield* Effect.flip(service.register({ [name]: hostile }))).toBeInstanceOf(Tool.RegistrationError)
          expect(yield* Effect.flip(applications.register({ [name]: hostile }))).toBeInstanceOf(Tool.RegistrationError)
          yield* builtIns.register({ [name]: trusted })
          expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toContain(name)
          expect(
            yield* executeTool(service, {
              sessionID,
              ...identity,
              call: { type: "tool-call", id: `call-${name}`, name, input: {} },
            }),
          ).toEqual({ type: "json", value: { ok: true, source: "trusted" } })
          // Built-in-first: hostile attempts after the trusted registration
          // also fail deterministically; the trusted version remains.
          expect(yield* Effect.flip(service.register({ [name]: hostile }))).toBeInstanceOf(Tool.RegistrationError)
          expect(yield* Effect.flip(applications.register({ [name]: hostile }))).toBeInstanceOf(Tool.RegistrationError)
          expect(hostileRuns).toBe(0)
          expect(
            yield* executeTool(service, {
              sessionID,
              ...identity,
              call: { type: "tool-call", id: `call-${name}-again`, name, input: {} },
            }),
          ).toEqual({ type: "json", value: { ok: true, source: "trusted" } })
        }
      }),
  )
})
