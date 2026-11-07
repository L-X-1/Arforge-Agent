import { expect } from "bun:test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

const [databasePath, workspace, mode] = Bun.argv.slice(2)
if (!databasePath || !workspace || !["private", "basic", "users"].includes(mode))
  throw new Error("Invalid isolated rename fixture arguments")
process.env.ARFORGE_DB = databasePath
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_HOME = join(dirname(databasePath), "home")
process.env.ARFORGE_AUTH_MODE = mode === "users" ? "users" : "private"
process.env.ARFORGE_AUTH_SECRET = "rename-route-isolated-fixture-secret-32-characters"
process.env.ARFORGE_AUTH_EMAIL_WEBHOOK_URL = ""
process.env.ARFORGE_AUTH_EMAIL_WEBHOOK_TOKEN = ""
process.env.ARFORGE_AUTH_EXPOSE_TOKENS = "true"
process.env.ARFORGE_PUBLIC_URL = "http://localhost"
mkdirSync(process.env.ARFORGE_HOME, { recursive: true })
let externalRequests = 0
globalThis.fetch = Object.assign(
  async () => {
    externalRequests++
    throw new Error("External fetch is forbidden in rename route fixture")
  },
  { preconnect: () => {} },
)

const { Effect, Layer, Option, Schema } = await import("effect")
const { HttpRouter, HttpServer } = await import("effect/unstable/http")
const { HttpApiBuilder } = await import("effect/unstable/httpapi")
const { eq, sql } = await import("drizzle-orm")
const { Database } = await import("@arforge-ai/core/database/database")
const { EventTable } = await import("@arforge-ai/core/event/sql")
const { ProjectTable } = await import("@arforge-ai/core/project/sql")
const { ProjectV2 } = await import("@arforge-ai/core/project")
const { Git } = await import("@arforge-ai/core/git")
const { SessionV2 } = await import("@arforge-ai/core/session")
const { SessionTable, SessionMessageTable } = await import("@arforge-ai/core/session/sql")
const { SessionExecution } = await import("@arforge-ai/core/session/execution")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const { IdentityUserTable, IdentityTenantMemberTable } = await import("@arforge-ai/core/identity/sql")
const { UserAuth } = await import("./user-auth")
const { ServerAuth } = await import("./auth")
const { SessionAuth } = await import("./session-auth")
const { IdentityContext } = await import("./identity-context")
const { Api } = await import("./api")
const { handlers, RuntimeInsightPersistence } = await import("./handlers")
const { applicationServices } = await import("./routes")
const { authorizationLayer } = await import("./middleware/authorization")
const { sessionLocationLayer } = await import("./middleware/session-location")
const { schemaErrorLayer } = await import("./middleware/schema-error")
const { layer: locationLayer } = await import("./location")
const { ControlClaimIndex } = await import("@arforge-ai/core/runtime")
const { ArforgeEvent } = await import("@arforge-ai/protocol/groups/event")

const database = Database.layerFromPath(databasePath)
const userConfig: import("./user-auth").UserAuth.Info = {
  mode: mode === "users" ? "users" : "private",
  secret: Option.some("rename-route-isolated-fixture-secret-32-characters"),
  publicUrl: "http://localhost",
  emailWebhookUrl: Option.none(),
  emailWebhookToken: Option.none(),
  exposeTokens: "true",
  trustProxy: "false",
}
const serverConfig: import("./auth").ServerAuth.Info = {
  username: "rename-fixture",
  password: mode === "basic" ? Option.some("rename-fixture-password") : Option.none(),
}
const sessionID = SessionV2.ID.make("ses_rename_transport_target")
const foreignID = SessionV2.ID.make("ses_rename_transport_foreign")
const initialTitle = "Initial synthetic title"

const accounts = await Effect.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const register = Effect.fnUntraced(function* (name: string) {
      const email = `${name}@rename-route.test`
      const registration = yield* UserAuth.register(
        db,
        userConfig,
        { email, password: "rename-route-fixture-password", displayName: name },
        Date.now(),
      )
      if (!registration.accepted || !registration.delivery) throw new Error("Fixture account registration failed")
      if (!(yield* UserAuth.verifyEmail(db, registration.delivery.token, Date.now())))
        throw new Error("Fixture account verification failed")
      const user = yield* db
        .select()
        .from(IdentityUserTable)
        .where(eq(IdentityUserTable.normalized_email, email))
        .get()
        .pipe(Effect.orDie)
      if (!user) throw new Error("Fixture account missing")
      const membership = yield* db
        .select()
        .from(IdentityTenantMemberTable)
        .where(eq(IdentityTenantMemberTable.user_id, user.id))
        .get()
        .pipe(Effect.orDie)
      if (!membership) throw new Error("Fixture tenant membership missing")
      const login = yield* UserAuth.login(
        db,
        userConfig,
        { email, password: "rename-route-fixture-password", ip: "127.0.0.1", userAgent: "rename-fixture" },
        Date.now(),
      )
      if (!login.ok) throw new Error("Fixture login failed")
      return { userID: user.id, tenantID: membership.tenant_id, token: login.token }
    })
    const local = {
      userID: Database.DefaultLocalPrincipal.userID,
      tenantID: Database.DefaultLocalPrincipal.tenantID,
      token: "",
    }
    const owner = mode === "users" ? yield* register("owner") : local
    const foreign = mode === "users" ? yield* register("foreign") : local
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(workspace), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    for (const [id, account] of [
      [sessionID, owner],
      [foreignID, foreign],
    ] as const) {
      yield* db
        .insert(SessionTable)
        .values({
          id,
          project_id: ProjectV2.ID.global,
          slug: id,
          directory: workspace,
          title: initialTitle,
          version: "rename-route-test",
          tenant_id: account.tenantID,
          owner_user_id: account.userID,
          time_updated: 1234,
          cost: 7,
          metadata: { retained: true },
        })
        .run()
        .pipe(Effect.orDie)
    }
    return { owner, foreign }
  }).pipe(Effect.scoped, Effect.provide(database)),
)

// Real Session/Core/DB/auth/HTTP owners. Only unrelated project discovery and
// location-service construction are isolated: no Git, tools or model graph.
const resolvedDirectories: string[] = []
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) =>
      Effect.sync(() => {
        resolvedDirectories.push(directory)
        return { id: ProjectV2.ID.global, directory }
      }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
// Keep its service shape while preventing all repository discovery/commands in
// unrelated location initialization. Rename still uses the real location map.
const git = Layer.effect(
  Git.Service,
  Effect.map(Git.Service, (service) =>
    Git.Service.of({ ...service, repo: { ...service.repo, discover: () => Effect.succeed(undefined) } }),
  ),
).pipe(Layer.provide(LayerNode.compile(Git.node)))
const services = AppNodeBuilder.build(applicationServices, [
  [Database.node, database],
  [ProjectV2.node, projects],
  [SessionExecution.node, SessionExecution.noopLayer],
  [Git.node, { ...Git.node, implementation: git }],
])
const routes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(RuntimeInsightPersistence),
  Layer.provide(sessionLocationLayer),
  Layer.provide(locationLayer),
  Layer.provide(authorizationLayer),
  Layer.provide(schemaErrorLayer),
  Layer.provide(ServerAuth.Config.configLayer(serverConfig)),
  Layer.provide(UserAuth.Config.layer),
  Layer.provide(Layer.succeed(IdentityContext.Current, IdentityContext.LocalPrincipal)),
  Layer.provide(Layer.succeed(ControlClaimIndex.CurrentPrincipal, undefined)),
  Layer.provide(services),
)
const web = HttpRouter.toWebHandler(
  routes.pipe(
    // Route request dependencies use the same real service layer. Authorization
    // and SessionLocation still replace the fallback per authenticated request.
    HttpRouter.provideRequest(services),
    HttpRouter.provideRequest(Layer.succeed(IdentityContext.Current, IdentityContext.LocalPrincipal)),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
)
const request = (input: Request) => web.handler(input)
const headers = (kind: "normal" | "none" | "cookie" | "foreign" = "normal", origin = "http://localhost") => {
  const result = new Headers({ Host: "localhost", Origin: origin, "Content-Type": "application/json" })
  if (mode === "users" && kind !== "none")
    result.set(
      "Cookie",
      `${UserAuth.COOKIE_NAME}=${kind === "foreign" ? accounts.foreign.token : accounts.owner.token}`,
    )
  if (mode === "basic" && kind === "normal")
    result.set("Authorization", `Basic ${Buffer.from("rename-fixture:rename-fixture-password").toString("base64")}`)
  if (mode === "basic" && kind === "cookie") {
    const issued = SessionAuth.issue(serverConfig)
    if (!issued) throw new Error("Fixture private cookie missing")
    result.set("Cookie", `${SessionAuth.COOKIE_NAME}=${issued.token}`)
  }
  return result
}
const post = (body: unknown, kind: Parameters<typeof headers>[0] = "normal", origin?: string, id = sessionID) =>
  request(
    new Request(
      `http://localhost/api/session/${id}/rename?location[directory]=${encodeURIComponent(join(workspace, "forged"))}`,
      { method: "POST", headers: headers(kind, origin), body: JSON.stringify(body) },
    ),
  )
const snapshot = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return {
        row: yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
        events: yield* db.select().from(EventTable).all(),
        messages: yield* db.select().from(SessionMessageTable).all(),
      }
    }).pipe(Effect.scoped, Effect.provide(database)),
  )
const execute = (command: string) =>
  Effect.runPromise(
    Database.Service.use(({ db }) => db.run(sql.raw(command)).pipe(Effect.orDie)).pipe(
      Effect.scoped,
      Effect.provide(database),
    ),
  )
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
const abort = new AbortController()
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
try {
  const before = await snapshot()
  if (!before.row) throw new Error("Seeded rename target disappeared")
  if (mode !== "private") {
    const unauthenticated = await post({ title: "must not commit" }, "none")
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toMatchObject({ _tag: "UnauthorizedError" })
  }
  if (mode === "basic" || mode === "users") {
    const crossOrigin = await post(
      { title: "must not commit" },
      mode === "basic" ? "cookie" : "normal",
      "https://other.fixture.invalid",
    )
    expect(crossOrigin.status).toBe(401)
  }
  if (mode === "users") {
    const foreign = await post({ title: "must not commit" }, "foreign")
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
  }
  for (const payload of [{}, { title: 42 }, { title: null }, { title: [] }]) {
    const response = await post(payload)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ _tag: "InvalidRequestError" })
  }
  const missing = await post({ title: "must not commit" }, "normal", undefined, SessionV2.ID.make("ses_missing_rename"))
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ _tag: "SessionNotFoundError" })
  expect(await snapshot()).toEqual(before)

  const stream = await request(new Request("http://localhost/api/event", { headers: headers(), signal: abort.signal }))
  expect(stream.status).toBe(200)
  if (!stream.body) throw new Error("Native SSE body missing")
  reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  const readEvent = async () => {
    for (;;) {
      const split = buffered.indexOf("\n\n")
      if (split >= 0) {
        const frame = buffered.slice(0, split)
        buffered = buffered.slice(split + 2)
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim()
        if (data) return Schema.decodeUnknownSync(ArforgeEvent)(JSON.parse(data))
        continue
      }
      const chunk = await reader!.read()
      if (chunk.done) throw new Error("Native SSE ended early")
      buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
    }
  }
  expect((await readEvent()).type).toBe("server.connected")
  const title = "  手动\r\n" + "🧪".repeat(150) + "  "
  const renamed = await post({ title }, mode === "basic" ? "cookie" : "normal")
  expect(renamed.status).toBe(204)
  expect(await renamed.text()).toBe("")
  const event = await readEvent()
  expect(event.type).toBe("session.next.renamed")
  if (event.type !== "session.next.renamed") throw new Error("Wrong native rename event")
  expect(event.data.title).toBe(title)
  expect(event.data.sessionID).toBe(sessionID)
  expect(event.data).not.toHaveProperty("messageID")
  expect(event.location?.directory).toBe(AbsolutePath.make(before.row.directory))
  expect(event.durable).toMatchObject({ aggregateID: sessionID, seq: 0, version: 1 })
  const get = await request(new Request(`http://localhost/api/session/${sessionID}`, { headers: headers() }))
  expect(get.status).toBe(200)
  expect(await get.json()).toMatchObject({ data: { id: sessionID, title } })
  const after = await snapshot()
  expect(after.row).toEqual({ ...before.row, title })
  expect(after.events).toHaveLength(1)
  expect(after.messages).toEqual([])
  expect(resolvedDirectories.every((value) => value === before.row?.directory)).toBe(true)
  const conflictTitle = "synthetic source conflict"
  await execute(
    `CREATE TRIGGER rename_source_conflict AFTER UPDATE OF title ON session WHEN NEW.id=${literal(sessionID)} AND NEW.title=${literal(conflictTitle)} BEGIN UPDATE session SET directory=${literal(join(workspace, "changed-during-commit"))} WHERE id=NEW.id; END`,
  )
  const conflict = await post({ title: conflictTitle })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({
    _tag: "ConflictError",
    resource: sessionID,
    message: "Session source changed. Reload the session before renaming it.",
  })
  expect(await snapshot()).toEqual(after)
  expect(externalRequests).toBe(0)
  console.log(`session-rename-route-ok:${mode}`)
} finally {
  abort.abort()
  await reader?.cancel().catch(() => {})
  await web.dispose()
}
