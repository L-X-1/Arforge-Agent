import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Logger, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { httpClient } from "@arforge-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@arforge-ai/core/session/projector"

import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { AccountRepo } from "../../src/account/repo"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { SessionShareTable } from "@arforge-ai/core/share/sql"
import { Database } from "@arforge-ai/core/database/database"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { SessionV1 } from "@arforge-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const env = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const it = testEffect(env)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

function requestLayer(client: HttpClient.HttpClient) {
  const replacement: LayerNode.Replacements = [
    [Database.node, Database.layerFromPath(":memory:")],
    [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
  ]
  return LayerNode.compile(LayerNode.group([ShareNext.node, AccountRepo.node]), replacement)
}

function integrationLayer(client: HttpClient.HttpClient) {
  const replacement: LayerNode.Replacements = [
    [Database.node, Database.layerFromPath(":memory:")],
    [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
  ]
  return LayerNode.compile(
    LayerNode.group([
      ShareNext.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      AccountRepo.node,
      Database.node,
    ]),
    replacement,
  )
}

function sessionShareLayer(client: HttpClient.HttpClient, flags: Partial<RuntimeFlags.Info> = {}) {
  const replacement: LayerNode.Replacements = [
    [Database.node, Database.layerFromPath(":memory:")],
    [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
  ]
  const replacements = replacement.concat([[RuntimeFlags.node, RuntimeFlags.layer(flags)]])
  return LayerNode.compile(LayerNode.group([SessionShare.node, Session.node, SessionProjector.node, Database.node]), replacements)
}

const share = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionShareTable)
      .where(eq(SessionShareTable.session_id, id))
      .get()
      .pipe(Effect.orDie)
  })

const seed = (url: string, org?: string) =>
  AccountRepo.Service.use((repo) =>
    repo.persistAccount({
      id: AccountID.make("account-1"),
      email: "user@example.com",
      url,
      accessToken: AccessToken.make("st_test_token"),
      refreshToken: RefreshToken.make("rt_test_token"),
      expiry: Date.now() + 10 * 60_000,
      orgID: org ? Option.some(OrgID.make(org)) : Option.none(),
    }),
  )

describe("ShareNext", () => {
  it.live("request uses legacy share API without active org account", () =>
    provideTmpdirInstance(
      () =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.api.create).toBe("/api/share")
            expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe("https://legacy-share.example.com")
            expect(req.headers).toEqual({})
          }),
        ).pipe(Effect.provide(requestLayer(none))),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("request rejects sharing when no endpoint is configured", () =>
    provideTmpdirInstance(() =>
      ShareNext.Service.use((svc) =>
        Effect.gen(function* () {
          const error = yield* svc.request().pipe(Effect.flip)
          expect(error).toBeInstanceOf(ShareNext.EndpointNotConfiguredError)
          expect(String(error)).toContain("explicit enterprise.url")
        }),
      ).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("request uses org share API with auth headers when account is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* seed("https://control.example.com", "org-1")

        const req = yield* ShareNext.use.request()

        expect(req.api.create).toBe("/api/shares")
        expect(req.api.sync("shr_123")).toBe("/api/shares/shr_123/sync")
        expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
        expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
        expect(req.baseUrl).toBe("https://control.example.com")
        expect(req.headers).toEqual({
          authorization: "Bearer st_test_token",
          "x-org-id": "org-1",
        })
      }).pipe(Effect.provide(requestLayer(none))),
    ),
  )

  it.live("create fails closed before HTTP or persistence", () =>
    provideTmpdirInstance(
      () => {
        const requests: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          requests.push(req)
          return Effect.die("unexpected HTTP call")
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })

          const error = yield* (yield* ShareNext.Service).create(session.id).pipe(Effect.flip)

          expect(error).toBeInstanceOf(ShareNext.MutationUnavailableError)
          expect(error.operation).toBe("create")
          expect(error.message).toContain("sealed ControlRun worker")
          expect(yield* share(session.id)).toBeUndefined()
          expect(requests).toEqual([])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove fails closed before HTTP and preserves the publication receipt", () =>
    provideTmpdirInstance(
      () => {
        const seen: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          seen.push(req)
          return Effect.die("unexpected HTTP call")
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "test" })
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: session.id,
              id: "shr_abc",
              url: "https://legacy-share.example.com/share/abc",
              secret: "sec_123",
            })
            .run()
            .pipe(Effect.orDie)
          const service = yield* ShareNext.Service

          const error = yield* service.remove(session.id).pipe(Effect.flip)

          expect(error).toBeInstanceOf(ShareNext.MutationUnavailableError)
          expect(error.operation).toBe("remove")
          expect(yield* share(session.id)).toMatchObject({ id: "shr_abc", secret: "sec_123" })
          expect(seen).toEqual([])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("create does not consult endpoint configuration before failing closed", () =>
    provideTmpdirInstance(() => {
      return Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "test" })

        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id)))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("ShareNext.MutationUnavailableError")
        expect(yield* share(session.id)).toBeUndefined()
      }).pipe(Effect.provide(integrationLayer(none)))
    }),
  )

  it.live("does not register live sync listeners or send new message data and share secrets", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const shareNext = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* shareNext.init()
          yield* Effect.sleep(50)
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_abc",
              url: "https://legacy-share.example.com/share/abc",
              secret: "sec_123",
            })
            .run()
            .pipe(Effect.orDie)

          yield* session.setTitle({ sessionID: info.id, title: "updated after sharing" })
          const messageID = MessageID.ascending()
          yield* session.updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as SessionV1.Info)
          yield* session.updatePart({
            id: PartID.ascending(),
            sessionID: info.id,
            messageID,
            type: "text",
            text: "new secret message must remain local",
          })
          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: "a.ts",
                patch:
                  "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n\\ No newline at end of file\n",
                additions: 1,
                deletions: 1,
                status: "modified",
              },
            ],
          })
          yield* Effect.sleep("1200 millis")

          expect(seen).toEqual([])
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("suppresses config auto-share while session creation succeeds and emits warning telemetry", () =>
    provideTmpdirInstance(
      () => {
        const requests: HttpClientRequest.HttpClientRequest[] = []
        const logs: Array<{ level: string; message: unknown }> = []
        const client = HttpClient.make((req) => {
          requests.push(req)
          return Effect.succeed(
            json(req, {
              id: "shr_unexpected",
              url: "https://legacy-share.example.com/share/unexpected",
              secret: "sec_unexpected",
            }),
          )
        })
        const logger = Logger.make((options) => {
          logs.push({ level: options.logLevel, message: options.message })
        })

        return Effect.gen(function* () {
          const result = yield* SessionShare.Service.use((service) => service.create({ title: "local only" }))
          yield* Effect.sleep("100 millis")

          expect(result.title).toBe("local only")
          expect(requests).toEqual([])
          expect(yield* share(result.id)).toBeUndefined()

          const warning = logs.find((entry) => entry.level === "Warn")
          expect(JSON.stringify(warning?.message)).toContain(
            "automatic session sharing suppressed until controlled publishing is available",
          )
          expect(JSON.stringify(warning?.message)).toContain('"outcome":"suppressed"')
        }).pipe(Effect.provide(Logger.layer([logger])), Effect.provide(sessionShareLayer(client)))
      },
      {
        config: {
          share: "auto",
          enterprise: { url: "https://legacy-share.example.com" },
        },
      },
    ),
  )

  it.live("suppresses ARFORGE_AUTO_SHARE without invoking the legacy share client", () =>
    provideTmpdirInstance(() => {
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const client = HttpClient.make((req) => {
        requests.push(req)
        return Effect.succeed(
          json(req, {
            id: "shr_unexpected",
            url: "https://legacy-share.example.com/share/unexpected",
            secret: "sec_unexpected",
          }),
        )
      })

      return Effect.gen(function* () {
        const result = yield* SessionShare.Service.use((service) => service.create({ title: "local only" }))
        yield* Effect.sleep("100 millis")

        expect(result.title).toBe("local only")
        expect(requests).toEqual([])
        expect(yield* share(result.id)).toBeUndefined()
      }).pipe(Effect.provide(sessionShareLayer(client, { autoShare: true })))
    }),
  )

  it.live("SessionShare hard-blocks explicit share and unshare without changing session metadata", () =>
    provideTmpdirInstance(
      () => {
        const requests: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          requests.push(req)
          return Effect.die("unexpected HTTP call")
        })

        return Effect.gen(function* () {
          const service = yield* SessionShare.Service
          const session = yield* Session.Service
          const created = yield* service.create({ title: "explicit share" })

          const shareError = yield* service.share(created.id).pipe(Effect.flip)
          expect(shareError).toBeInstanceOf(SessionShare.MutationUnavailableError)
          expect(shareError.operation).toBe("share")
          expect((yield* session.get(created.id)).share).toBeUndefined()

          yield* session.setShare({ sessionID: created.id, share: { url: "https://already.example/share/receipt" } })
          const unshareError = yield* service.unshare(created.id).pipe(Effect.flip)

          expect(unshareError).toBeInstanceOf(SessionShare.MutationUnavailableError)
          expect(unshareError.operation).toBe("unshare")
          expect((yield* session.get(created.id)).share?.url).toBe("https://already.example/share/receipt")
          expect(yield* share(created.id)).toBeUndefined()
          expect(requests).toEqual([])
        }).pipe(Effect.provide(sessionShareLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )
})
