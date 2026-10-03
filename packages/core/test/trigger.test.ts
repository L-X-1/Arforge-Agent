import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Location } from "@arforge-ai/core/location"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ScheduledPromptV2 } from "@arforge-ai/core/scheduled-prompt"
import { ScheduledPromptTriggerAccess } from "@arforge-ai/core/scheduled-prompt/trigger-access"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { TriggerV2 } from "@arforge-ai/core/trigger"
import { TriggerTools } from "@arforge-ai/core/tool/trigger"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_trigger_runtime_test")
const currentLocation = Location.boundNode({ directory: AbsolutePath.make(import.meta.dir) })
const base = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, ScheduledPromptTriggerAccess.node]), [
  [Location.node, currentLocation],
])
const it = testEffect(Layer.empty)

const withTriggers = <A, E, R>(
  options: TriggerV2.LayerOptions,
  body: Effect.Effect<A, E, R | TriggerV2.Service | Database.Service>,
) => body.pipe(Effect.provide(Layer.provideMerge(TriggerV2.layerWith(options), base)))

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
      slug: "trigger-runtime",
      directory: "/project",
      title: "trigger-runtime",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const profileJson = (profile: Record<string, unknown>) => JSON.stringify({ profiles: [profile] })
const mockFetch = (
  handler: (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => Object.assign(handler, { preconnect: () => undefined })
const bearerProfile = {
  name: "prod",
  kind: "http",
  base_url: "https://triggers.example.test/v1/triggers",
  auth: { type: "bearer_environment", environment_variable: "TRIGGER_TOKEN" },
  headers: { "X-Tenant": "tenant-a" },
  timeout: 7,
}

describe("TriggerV2", () => {
  it.live("maps the complete local lifecycle onto the authoritative scheduled-prompt table", () =>
    withTriggers(
      {},
      Effect.gen(function* () {
        yield* setup
        const triggers = yield* TriggerV2.Service
        expect(triggers.profiles()).toEqual({
          items: [{ name: "local", kind: "local", baseUrl: "", timeout: 20, headerNames: [] }],
          count: 1,
        })
        const created = yield* triggers.execute({
          action: "create",
          sessionID,
          body: {
            name: "Release review",
            cron_expression: "* * * * *",
            prompt: "review the release",
            recurring: true,
            durable: true,
            enabled: false,
          },
        })
        expect(created).toMatchObject({
          ok: true,
          kind: "local",
          data: { name: "Release review", recurring: true, durable: true, enabled: false },
        })
        const schedule = created.data as unknown as ScheduledPromptV2.Info
        expect((yield* triggers.execute({ action: "list", sessionID })).data).toMatchObject({ count: 1 })
        expect(
          (yield* triggers.execute({
            action: "get",
            sessionID,
            triggerID: schedule.id,
          })).data,
        ).toMatchObject({ prompt: "review the release" })
        const updated = yield* triggers.execute({
          action: "update",
          sessionID,
          triggerID: schedule.id,
          body: {
            name: "Release evidence",
            prompt: "collect release evidence",
            recurring: false,
            enabled: true,
          },
        })
        expect(updated.data).toMatchObject({
          name: "Release evidence",
          prompt: "collect release evidence",
          recurring: false,
          enabled: true,
        })
        const beforeRun = updated.data as unknown as ScheduledPromptV2.Info
        const run = yield* triggers.execute({ action: "run", sessionID, triggerID: schedule.id })
        expect(run.data).toMatchObject({ prompt: "collect release evidence", revision: beforeRun.revision })
      }),
    ),
  )

  it.live("uses fixed HTTP routes, manual redirects, bounded bodies, and host-only bearer authentication", () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch = mockFetch(async (input, init) => {
      requests.push({ url: String(input), init })
      return new Response(JSON.stringify({ request: requests.length }), {
        status: requests.length === 2 ? 202 : 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    return withTriggers(
      {
        profilesJson: profileJson(bearerProfile),
        environment: { TRIGGER_TOKEN: "never-print-me" },
        fetch,
      },
      Effect.gen(function* () {
        yield* setup
        const triggers = yield* TriggerV2.Service
        const publicState = JSON.stringify(triggers.profiles())
        expect(publicState).not.toContain("never-print-me")
        expect(triggers.profiles().items[1]).toMatchObject({
          name: "prod",
          kind: "http",
          headerNames: ["X-Tenant"],
          auth: { type: "bearer_environment", environmentVariable: "TRIGGER_TOKEN", configured: true },
        })

        yield* triggers.execute({ action: "list", profile: TriggerV2.ProfileName.make("prod"), sessionID })
        yield* triggers.execute({
          action: "get",
          profile: TriggerV2.ProfileName.make("prod"),
          sessionID,
          triggerID: "nightly",
        })
        yield* triggers.execute({
          action: "create",
          profile: TriggerV2.ProfileName.make("prod"),
          sessionID,
          body: { name: "nightly" },
        })
        yield* triggers.execute({
          action: "update",
          profile: TriggerV2.ProfileName.make("prod"),
          sessionID,
          triggerID: "nightly",
          body: { enabled: true },
        })
        const run = yield* triggers.execute({
          action: "run",
          profile: TriggerV2.ProfileName.make("prod"),
          sessionID,
          triggerID: "nightly",
        })
        expect(run).toMatchObject({ status: 200, ok: true })
        expect(requests.map((item) => [item.init?.method, item.url])).toEqual([
          ["GET", "https://triggers.example.test/v1/triggers"],
          ["GET", "https://triggers.example.test/v1/triggers/nightly"],
          ["POST", "https://triggers.example.test/v1/triggers"],
          ["POST", "https://triggers.example.test/v1/triggers/nightly"],
          ["POST", "https://triggers.example.test/v1/triggers/nightly/run"],
        ])
        expect(requests.every((item) => item.init?.redirect === "manual")).toBeTrue()
        expect(
          requests.every(
            (item) => (item.init?.headers as Record<string, string>).Authorization === "Bearer never-print-me",
          ),
        ).toBeTrue()
        expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({ name: "nightly" })
        expect(requests[4]!.init?.body).toBe("{}")
      }),
    )
  })

  it.live("obtains OAuth credentials in process, caches tokens, and never exposes secret values", () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch = mockFetch(async (input, init) => {
      requests.push({ url: String(input), init })
      return String(input).includes("/oauth/token")
        ? new Response(JSON.stringify({ access_token: "private-oauth-token", expires_in: 3600 }))
        : new Response(JSON.stringify({ ok: true }))
    })
    const config = {
      name: "oauth",
      base_url: "https://remote.example.test/triggers",
      auth: {
        type: "oauth_client_credentials",
        token_url: "https://identity.example.test/oauth/token",
        client_id_environment: "TRIGGER_CLIENT_ID",
        client_secret_environment: "TRIGGER_CLIENT_SECRET",
        scopes: ["triggers.manage"],
        audience: "trigger-api",
      },
    }
    return withTriggers(
      {
        profilesJson: profileJson(config),
        environment: { TRIGGER_CLIENT_ID: "client", TRIGGER_CLIENT_SECRET: "secret" },
        fetch,
      },
      Effect.gen(function* () {
        yield* setup
        const triggers = yield* TriggerV2.Service
        const profile = TriggerV2.ProfileName.make("oauth")
        yield* triggers.execute({ action: "list", profile, sessionID })
        yield* triggers.execute({ action: "list", profile, sessionID })
        expect(requests.map((item) => item.url)).toEqual([
          "https://identity.example.test/oauth/token",
          "https://remote.example.test/triggers",
          "https://remote.example.test/triggers",
        ])
        expect(String(requests[0]!.init?.body)).toContain("grant_type=client_credentials")
        expect((requests[1]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer private-oauth-token")
        expect(JSON.stringify(triggers.profiles())).not.toMatch(/private-oauth-token|secret/)
      }),
    )
  })

  it.live("rejects unsafe profiles, invalid IDs, excessive request bodies, and oversized or malformed responses", () =>
    Effect.gen(function* () {
      expect(() =>
        TriggerV2.parseProfiles(profileJson({ ...bearerProfile, base_url: "http://remote.example.test/triggers" }), {
          TRIGGER_TOKEN: "token",
        }),
      ).toThrow("HTTPS")
      expect(() =>
        TriggerV2.parseProfiles(
          profileJson({ ...bearerProfile, base_url: "https://user:pass@remote.example.test/triggers" }),
          { TRIGGER_TOKEN: "token" },
        ),
      ).toThrow("credentials")

      yield* withTriggers(
        {
          profilesJson: profileJson(bearerProfile),
          environment: { TRIGGER_TOKEN: "never-print-me" },
          fetch: mockFetch(async () => new Response("x".repeat(TriggerV2.MAX_TRIGGER_RESPONSE_BYTES + 1))),
        },
        Effect.gen(function* () {
          yield* setup
          const triggers = yield* TriggerV2.Service
          expect(
            yield* triggers
              .execute({
                action: "get",
                profile: TriggerV2.ProfileName.make("prod"),
                sessionID,
                triggerID: "../escape",
              })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "INVALID_TRIGGER_ID" })
          expect(
            yield* triggers
              .execute({
                action: "create",
                profile: TriggerV2.ProfileName.make("prod"),
                sessionID,
                body: { value: "x".repeat(TriggerV2.MAX_TRIGGER_BODY_BYTES) },
              })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "BODY_TOO_LARGE" })
          expect(
            yield* triggers
              .execute({ action: "list", profile: TriggerV2.ProfileName.make("prod"), sessionID })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "RESPONSE_TOO_LARGE", message: expect.not.stringContaining("never-print-me") })
        }),
      )
    }),
  )
})

const permissionAssertions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
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

const toolLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    ScheduledPromptTriggerAccess.node,
    TriggerV2.node,
    ToolRegistry.node,
    ToolRegistry.toolsNode,
    TriggerTools.node,
  ]),
  [
    [TriggerV2.node, TriggerV2.layerWith({}).pipe(Layer.orDie)],
    [Location.node, currentLocation],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const toolIt = testEffect(toolLayer)

describe("TriggerTools", () => {
  toolIt.effect("registers exact deferred names, derives session identity, and returns stable safe errors", () =>
    Effect.gen(function* () {
      permissionAssertions.length = 0
      yield* setup
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "trigger_profiles",
        "trigger_manage",
      ])
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "profiles", name: "trigger_profiles", input: {} },
        }),
      ).toMatchObject({ type: "text", value: expect.stringContaining('"local"') })
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "manage",
            name: "trigger_manage",
            input: { action: "get", trigger_id: "../escape" },
          },
        }),
      ).toMatchObject({ type: "text", value: expect.stringContaining('"code": "INVALID_TRIGGER_ID"') })
      const triggers = yield* TriggerV2.Service
      const created = yield* triggers.execute({
        action: "create",
        sessionID,
        body: {
          name: "Tool run",
          cron_expression: "* * * * *",
          prompt: "run from this turn",
          enabled: false,
        },
      })
      const schedule = created.data as unknown as { readonly id: string }
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "run",
            name: "trigger_manage",
            input: { action: "run", trigger_id: schedule.id },
          },
        }),
      ).toMatchObject({
        type: "text",
        value: expect.stringContaining("Execute its prompt in the current session turn."),
      })
      expect(permissionAssertions.map((item) => [item.action, item.resources])).toEqual([
        ["trigger_manage", ["local"]],
      ])
    }),
  )
})
