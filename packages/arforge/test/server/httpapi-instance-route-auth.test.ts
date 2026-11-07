import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { ProjectV2 } from "@arforge-ai/core/project"
import { SessionV1 } from "@arforge-ai/schema/session-v1"
import { eq } from "drizzle-orm"
import { GlobalBus } from "../../src/bus/global"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { PtyID } from "@arforge-ai/core/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function app(input: { password?: string; username?: string; userMode?: boolean }, memoMap?: Layer.MemoMap) {
  const config: Record<string, string> = {
    ARFORGE_AUTH_MODE: input.userMode ? "users" : "private",
    ARFORGE_PUBLIC_URL: "http://localhost",
    ARFORGE_AUTH_EXPOSE_TOKENS: input.userMode ? "true" : "false",
  }
  if (input.password) config.ARFORGE_SERVER_PASSWORD = input.password
  if (input.username) config.ARFORGE_SERVER_USERNAME = input.username
  if (input.userMode) config.ARFORGE_AUTH_SECRET = "test-only-auth-secret-with-at-least-32-characters"
  const { handler } = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config)))),
    { disableLogger: true, memoMap },
  )

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

async function signIn(server: ReturnType<typeof app>, email: string, register = true) {
  const post = (path: string, body: object) =>
    server.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const credentials = { email, password: "correct horse battery staple" }
  if (register) {
    const registration = await post("/auth/register", credentials)
    const { developmentToken } = (await registration.json()) as { developmentToken?: string }
    if (!developmentToken) throw new Error(`Missing verification token for ${email}`)
    expect((await post("/auth/verify-email", { token: developmentToken })).status).toBe(200)
  }
  const login = await post("/auth/login", credentials)
  expect(login.status).toBe(200)
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0]
  if (!cookie) throw new Error("Missing session cookie")
  return cookie
}

function readSse(response: Response) {
  if (!response.body) throw new Error("Missing event stream")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return {
    async next(): Promise<{ type?: string; id?: string; payload?: { type: string; id: string } }> {
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (boundary) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))
          if (data) return JSON.parse(data.slice(5))
          continue
        }
        const value = await reader.read()
        if (value.done) throw new Error("Event stream closed")
        buffer += decoder.decode(value.value, { stream: true })
      }
    },
    close: () => reader.cancel().catch(() => {}),
  }
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi instance route authorization", () => {
  test("supports registration, verification, persistent sessions, and global logout", async () => {
    const server = app({ userMode: true })
    const anonymous = await server.request("/auth/session")
    expect(await anonymous.json()).toMatchObject({ authenticated: false, mode: "users" })
    expect((await server.request("/doc")).status).toBe(401)

    const registration = await server.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery staple" }),
    })
    expect(registration.status).toBe(202)
    const registered: unknown = await registration.json()
    if (
      !registered ||
      typeof registered !== "object" ||
      !("developmentToken" in registered) ||
      typeof registered.developmentToken !== "string"
    ) {
      throw new Error("Expected a development verification token")
    }
    expect(registered.developmentToken).toBeString()

    const verification = await server.request("/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: registered.developmentToken }),
    })
    expect(verification.status).toBe(200)

    const signIn = () =>
      server.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery staple" }),
      })
    const first = await signIn()
    const second = await signIn()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstCookie = first.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
    const secondCookie = second.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
    expect(firstCookie).not.toBe(secondCookie)

    const protectedResponse = await server.request("/doc", { headers: { cookie: firstCookie } })
    expect(protectedResponse.status).toBe(200)
    const crossOriginLogout = await server.request("/auth/logout-all", {
      method: "POST",
      headers: { cookie: firstCookie, origin: "https://attacker.example" },
    })
    expect(crossOriginLogout.status).toBe(403)
    const globalLogout = await server.request("/auth/logout-all", {
      method: "POST",
      headers: { cookie: firstCookie, origin: "http://localhost" },
    })
    expect(globalLogout.status).toBe(200)
    const invalidated = await server.request("/auth/session", { headers: { cookie: secondCookie } })
    expect(await invalidated.json()).toMatchObject({ authenticated: false, mode: "users" })
  })

  test("creates, checks, and clears a private browser session", async () => {
    const server = app({ password: "secret", username: "arforge_owner" })

    const missing = await server.request("/auth/session")
    expect(missing.status).toBe(200)
    expect(await missing.json()).toEqual({ authenticated: false, sessionRequired: true, mode: "private" })

    const rejected = await server.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "arforge_owner", password: "wrong" }),
    })
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get("set-cookie")).toBeNull()

    const login = await server.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "arforge_owner", password: "secret" }),
    })
    expect(login.status).toBe(200)
    const setCookie = login.headers.get("set-cookie")
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Strict")
    // The in-memory Effect server omits Host, so the cookie must fail secure.
    expect(setCookie).toContain("Secure")
    const cookie = setCookie?.split(";")[0] ?? ""

    const session = await server.request("/auth/session", { headers: { cookie } })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      authenticated: true,
      sessionRequired: true,
      username: "arforge_owner",
    })

    const doc = await server.request("/doc", { headers: { cookie } })
    expect(doc.status).toBe(200)

    const logout = await server.request("/auth/logout", { method: "POST", headers: { cookie } })
    expect(logout.status).toBe(200)
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0")

    const browser = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" }
    for (const route of ["/file/content?path=private.txt", "/api/session", "/doc"]) {
      const background = await server.request(route, { headers: { ...browser, cookie } })
      const direct = await server.request(route, { headers: { cookie } })

      expect(background.status).toBe(401)
      expect(background.headers.get("www-authenticate")).toBeNull()
      expect(direct.status).toBe(401)
      expect(direct.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
      expect(await background.text()).toBe(await direct.text())
    }

    const relogin = await server.request("/auth/login", {
      method: "POST",
      headers: { ...browser, cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "arforge_owner", password: "secret" }),
    })
    expect(relogin.status).toBe(200)
    const freshCookie = relogin.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
    expect((await server.request("/doc", { headers: { cookie: freshCookie } })).status).toBe(200)
  })

  test("requires configured auth before opening the instance event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const headers = { "x-arforge-directory": tmp.path }

    const missing = await server.request(EventPaths.event, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(EventPaths.event, {
      headers: { ...headers, authorization: basic("arforge", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(200)
  })

  test("streams committed project updates to the owner on both feeds without leaking principal or location", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const memoMap = Layer.makeMemoMapUnsafe()
    const server = app({ userMode: true }, memoMap)
    const runtime = ManagedRuntime.make(
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2Bridge.node])),
      { memoMap },
    )
    const streams: ReturnType<typeof readSse>[] = []
    let writer: string | undefined
    try {
      const ownerEmail = "project-events-owner@example.test"
      writer = await signIn(server, ownerEmail)
      const peer = await signIn(server, ownerEmail, false)
      const foreign = await signIn(server, "project-events-foreign@example.test")
      expect(peer).not.toBe(writer)
      const scopeHeaders = { cookie: writer, "x-arforge-directory": tmp.path }
      const session = await server.request("/auth/session", { headers: scopeHeaders })
      const owner = (await session.json()) as { user: { id: string }; tenant: { id: string } }
      const initial = await server.request("/project/current", { headers: scopeHeaders })
      expect(initial.status).toBe(200)
      const id = ProjectV2.ID.make(((await initial.json()) as { id: string }).id)
      expect(id).not.toBe("global")
      // SQLite bootstrap uses the embedded owner defaults. Give this fixture
      // the ownership that authenticated PostgreSQL discovery would persist.
      await runtime.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.update(ProjectTable)
            .set({ tenant_id: owner.tenant.id, owner_user_id: owner.user.id })
            .where(eq(ProjectTable.id, id))
            .run()
        }),
      )

      const initialListeners = GlobalBus.listenerCount("event")
      for (const cookie of [peer, foreign]) {
        for (const path of ["/api/event", "/global/event"]) {
          const response = await server.request(path, {
            headers: { cookie, "x-arforge-directory": tmp.path },
            signal: AbortSignal.timeout(15_000),
          })
          expect(response.status).toBe(200)
          const stream = readSse(response)
          streams.push(stream)
          const connected = await stream.next()
          expect((connected.payload ?? connected).type).toBe("server.connected")
        }
      }
      // Legacy attaches its listener after sending the connected frame.
      const deadline = Date.now() + 5_000
      while (GlobalBus.listenerCount("event") < initialListeners + 2) {
        if (Date.now() >= deadline) throw new Error("Legacy subscribers did not register")
        await Bun.sleep(5)
      }

      const metadata = []
      for (const [path, name] of [
        [`/api/project/${id}`, "V2 project name"],
        [`/project/${id}`, "Legacy project name"],
      ]) {
        const patched = await server.request(path, {
          method: "PATCH",
          headers: { ...scopeHeaders, origin: "http://localhost", "content-type": "application/json" },
          body: JSON.stringify({ name }),
        })
        expect(patched.status).toBe(200)
        const project = await patched.json()
        expect(project).toMatchObject({ id, name })
        metadata.push(project)
      }
      // An unscoped non-project marker proves all streams drained past both
      // writes, including streams that must receive zero project events.
      const marker = await runtime.runPromise(
        Effect.flatMap(EventV2Bridge.Service, (events) =>
          events.publish(SessionV1.Event.Error, { error: { name: "UnknownError", data: { message: "test marker" } } }),
        ),
      )
      const received = await Promise.all(streams.map(async (stream) => {
        const events = []
        while (true) {
          const event = await stream.next()
          if ((event.payload ?? event).id === marker.id) return events
          if ((event.payload ?? event).type === "project.updated") events.push(event)
        }
      }))
      const [native, legacy, foreignNative, foreignLegacy] = received
      expect(native).toEqual(metadata.map((data) => ({ id: expect.any(String), type: "project.updated", data })))
      expect(legacy).toEqual(metadata.map((properties, index) => ({
        directory: "global",
        project: id,
        payload: { id: native[index].id!, type: "project.updated", properties },
      })))
      expect(foreignNative).toEqual([])
      expect(foreignLegacy).toEqual([])
    } finally {
      await Promise.all(streams.map((stream) => stream.close()))
      try {
        if (writer) {
          const disposed = await server.request("/global/dispose", {
            method: "POST",
            headers: { cookie: writer, origin: "http://localhost" },
          })
          expect(disposed.status).toBe(200)
        }
      } finally {
        await runtime.dispose()
      }
    }
  }, 60_000)

  test("requires configured auth before resolving the PTY websocket route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const route = PtyPaths.connect.replace(":ptyID", PtyID.ascending())
    const headers = { "x-arforge-directory": tmp.path }

    const missing = await server.request(route, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(route, {
      headers: { ...headers, authorization: basic("arforge", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(404)
  })

  test("rejects user-auth mutations before detached dispatch can orphan an RLS-scoped run", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ userMode: true })
    const [firstCookie, secondCookie] = await Promise.all([
      signIn(server, "first-principal@example.com"),
      signIn(server, "second-principal@example.com"),
    ])
    const requestID = "cpr_same_principal_isolation"
    const mutation = (cookie: string) =>
      server.request(ExperimentalPaths.worktree, {
        method: "POST",
        headers: {
          cookie,
          origin: "http://localhost",
          "content-type": "application/json",
          "x-arforge-directory": tmp.path,
        },
        body: JSON.stringify({ name: "principal-isolation", requestID }),
      })
    const [firstRejected, secondRejected] = await Promise.all([mutation(firstCookie), mutation(secondCookie)])
    expect(firstRejected.status).toBe(400)
    expect(secondRejected.status).toBe(400)
    expect(await firstRejected.json()).toMatchObject({ name: "WorktreeControlExecutionDeniedError" })
    expect(await secondRejected.json()).toMatchObject({ name: "WorktreeControlExecutionDeniedError" })

    const approvals = async (cookie: string) => {
      const response = await server.request(
        `${ExperimentalPaths.controlApproval}?${new URLSearchParams({ requestID })}`,
        { headers: { cookie, "x-arforge-directory": tmp.path } },
      )
      expect(response.status).toBe(200)
      return (await response.json()) as unknown[]
    }
    expect(await approvals(firstCookie)).toEqual([])
    expect(await approvals(secondCookie)).toEqual([])

    const statusPath = `${ExperimentalPaths.controlOperationStatus.replace(":requestID", requestID)}?operation=worktree.create`
    const [firstStatus, secondStatus] = await Promise.all([
      server.request(statusPath, { headers: { cookie: firstCookie, "x-arforge-directory": tmp.path } }),
      server.request(statusPath, { headers: { cookie: secondCookie, "x-arforge-directory": tmp.path } }),
    ])
    expect(firstStatus.status).toBe(400)
    expect(secondStatus.status).toBe(400)
  }, 30_000)
})
