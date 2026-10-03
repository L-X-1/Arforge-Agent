import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { PtyID } from "@arforge-ai/core/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function app(input: { password?: string; username?: string; userMode?: boolean }) {
  const config: Record<string, string> = {
    ARFORGE_AUTH_MODE: input.userMode ? "users" : "private",
    ARFORGE_PUBLIC_URL: "http://localhost",
    ARFORGE_AUTH_EXPOSE_TOKENS: input.userMode ? "true" : "false",
  }
  if (input.password) config.ARFORGE_SERVER_PASSWORD = input.password
  if (input.username) config.ARFORGE_SERVER_USERNAME = input.username
  if (input.userMode) config.ARFORGE_AUTH_SECRET = "test-only-auth-secret-with-at-least-32-characters"
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config)))),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
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
    const signIn = async (email: string) => {
      const registration = await server.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct horse battery staple" }),
      })
      const registered = (await registration.json()) as { developmentToken?: string }
      if (!registered.developmentToken) throw new Error(`Missing verification token for ${email}`)
      const verification = await server.request("/auth/verify-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: registered.developmentToken }),
      })
      expect(verification.status).toBe(200)
      const login = await server.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct horse battery staple" }),
      })
      expect(login.status).toBe(200)
      return login.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
    }
    const [firstCookie, secondCookie] = await Promise.all([
      signIn("first-principal@example.com"),
      signIn("second-principal@example.com"),
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
