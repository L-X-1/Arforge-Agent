import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Location } from "@arforge-ai/core/location"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { PermissionTable } from "@arforge-ai/core/permission/sql"
import { PermissionSaved } from "@arforge-ai/core/permission/saved"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionStore } from "@arforge-ai/core/session/store"
import { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
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
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function setSessionRules(rules: PermissionV1.Ruleset) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ permission: rules })
      .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
      .run()
      .pipe(Effect.orDie)
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest(input: Partial<PermissionV2.AssertInput> = {}) {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion(input)).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("reads legacy session rules and deterministically maps their fields", () =>
    Effect.gen(function* () {
      yield* setup()
      const rules: PermissionV1.Ruleset = [{ permission: "read", pattern: "src/*", action: "allow" }]
      yield* setSessionRules(rules)

      const sessions = yield* SessionStore.Service
      expect(yield* sessions.permissions(SessionV2.ID.make("ses_test"))).toEqual(rules)
      expect(PermissionV2.fromV1Rules(rules)).toEqual([{ action: "read", resource: "src/*", effect: "allow" }])
      expect(yield* sessions.permissions(SessionV2.ID.make("ses_missing"))).toBeUndefined()
    }),
  )

  it.effect("applies session allow and ask after agent rules while preserving deny boundaries", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask" }])
      const service = yield* PermissionV2.Service

      yield* setSessionRules([{ permission: "read", pattern: "*", action: "allow" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([{ action: "read", resource: "*", effect: "allow" }])
      yield* setSessionRules([{ permission: "read", pattern: "*", action: "ask" }])
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_session_ask") }))).toEqual({
        id: PermissionV2.ID.create("per_session_ask"),
        effect: "ask",
      })

      yield* setRules([{ action: "read", resource: "*", effect: "allow" }])
      yield* setSessionRules([{ permission: "read", pattern: "*", action: "deny" }])
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_session_deny") }))).toEqual({
        id: PermissionV2.ID.create("per_session_deny"),
        effect: "deny",
      })

      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      yield* setSessionRules([{ permission: "read", pattern: "*", action: "allow" }])
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_agent_deny") }))).toEqual({
        id: PermissionV2.ID.create("per_agent_deny"),
        effect: "deny",
      })

      yield* setRules([])
      yield* setSessionRules([])
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_no_rules") }))).toEqual({
        id: PermissionV2.ID.create("per_no_rules"),
        effect: "ask",
      })
    }),
  )

  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("forces a fresh L3 confirmation even when an allow rule was previously saved", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "bash", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ action: "bash", resources: ["git push"], forceAsk: true }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "ask",
      })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toMatchObject({
        requiresHumanConfirmation: true,
      })
    }),
  )

  it.effect(
    "normalizes an API-client L3 always reply to one-time approval without saving or unlocking other prompts",
    () =>
      Effect.gen(function* () {
        yield* setup([{ action: "bash", resource: "*", effect: "allow" }])
        const { service, fiber, request } = yield* waitForRequest({
          action: "bash",
          resources: ["opaque-shell"],
          save: ["opaque-shell"],
          forceAsk: true,
        })
        expect(request.requiresHumanConfirmation).toBe(true)
        yield* service.reply({ requestID: request.id, reply: "always" })
        yield* Fiber.join(fiber)
        const saved = yield* PermissionSaved.Service
        expect(yield* saved.list()).toEqual([])
      }),
  )

  it.effect("keeps an L3 force-ask pending when a matching L2 always reply is saved", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const bothAsked = yield* Deferred.make<ReadonlyArray<PermissionV2.Request>>()
      const requests: PermissionV2.Request[] = []
      const unsubscribe = yield* events.listen((event) =>
        event.type !== PermissionV2.Event.Asked.type
          ? Effect.void
          : Effect.sync(() => {
              requests.push(event.data as PermissionV2.Request)
            }).pipe(
              Effect.andThen(() =>
                requests.length === 2 ? Deferred.succeed(bothAsked, [...requests]).pipe(Effect.asVoid) : Effect.void,
              ),
            ),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const l2 = yield* service
        .assert(
          assertion({ id: PermissionV2.ID.create("per_l2"), action: "bash", resources: ["same"], save: ["same"] }),
        )
        .pipe(Effect.forkScoped)
      const l3 = yield* service
        .assert(
          assertion({
            id: PermissionV2.ID.create("per_l3"),
            action: "bash",
            resources: ["same"],
            forceAsk: true,
          }),
        )
        .pipe(Effect.forkScoped)
      const asked = yield* Deferred.await(bothAsked)
      const ordinary = asked.find((request) => request.id === PermissionV2.ID.create("per_l2"))
      const trusted = asked.find((request) => request.id === PermissionV2.ID.create("per_l3"))
      if (!ordinary || !trusted) throw new Error("expected both permission requests")
      yield* service.reply({ requestID: ordinary.id, reply: "always" })
      yield* Fiber.join(l2)
      expect(yield* service.get(trusted.id)).toMatchObject({ requiresHumanConfirmation: true })
      yield* service.reply({ requestID: trusted.id, reply: "once" })
      yield* Fiber.join(l3)
    }),
  )

  it.effect("rejecting one request does not reject unrelated pending work in the same session", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const bothAsked = yield* Deferred.make<ReadonlyArray<PermissionV2.Request>>()
      const requests: PermissionV2.Request[] = []
      const unsubscribe = yield* events.listen((event) =>
        event.type !== PermissionV2.Event.Asked.type
          ? Effect.void
          : Effect.sync(() => {
              requests.push(event.data as PermissionV2.Request)
            }).pipe(
              Effect.andThen(() =>
                requests.length === 2 ? Deferred.succeed(bothAsked, [...requests]).pipe(Effect.asVoid) : Effect.void,
              ),
            ),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const first = yield* service
        .assert(assertion({ id: PermissionV2.ID.create("per_first"), resources: ["one"] }))
        .pipe(Effect.forkScoped)
      const second = yield* service
        .assert(assertion({ id: PermissionV2.ID.create("per_second"), resources: ["two"] }))
        .pipe(Effect.forkScoped)
      const asked = yield* Deferred.await(bothAsked)
      const firstRequest = asked.find((request) => request.id === PermissionV2.ID.create("per_first"))
      const secondRequest = asked.find((request) => request.id === PermissionV2.ID.create("per_second"))
      if (!firstRequest || !secondRequest) throw new Error("expected both permission requests")
      yield* service.reply({ requestID: firstRequest.id, reply: "reject" })
      expect((yield* Fiber.await(first))._tag).toBe("Failure")
      expect(yield* service.get(secondRequest.id)).toBeDefined()
      yield* service.reply({ requestID: secondRequest.id, reply: "once" })
      yield* Fiber.join(second)
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})
