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
const nativeFetch = globalThis.fetch
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
const calls: { operation: string; input: unknown; principal?: unknown }[] = []
let preparations = 0
const execution = Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
  active: Effect.succeed(new Set()),
  exclusive: () => Effect.succeed(false), resume: () => Effect.void, resumeWith: () => Effect.void,
  wake: () => Effect.void, wakeAndWait: () => Effect.void, interrupt: () => Effect.void,
  shell: input => Effect.gen(function* () {
    calls.push({ operation: "shell", input, principal: yield* Database.CurrentPrincipal })
    if (input.command === "busy") return yield* new SessionExecution.OperationError({ operation: "shell", reason: "busy", message: "busy" })
  }),
  preparePrompt: input => Effect.sync(() => {
    preparations++
    calls.push({ operation: "command", input })
    return { ...input.prompt, files: input.prompt.files?.map(file => ({ ...file, mime: file.mime ?? "text/plain" })), text: `Resolved ${input.prompt.command?.name}: ${input.prompt.command?.arguments}` }
  }),
  compact: input => Effect.gen(function* () {
    calls.push({ operation: "compact", input, principal: yield* Database.CurrentPrincipal })
    if (input.expectedContext === "stale") return yield* new SessionExecution.OperationError({ operation: "compact", reason: "conflict", message: "stale" })
    if (input.expectedContext === "failed") return yield* new SessionExecution.OperationError({ operation: "compact", reason: "unavailable", message: "failed" })
  }),
}))
const services = AppNodeBuilder.build(applicationServices, [
  [Database.node, database],
  [ProjectV2.node, projects],
  [SessionExecution.node, execution],
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
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => web.handler(request) })
const request = (input: Request) => nativeFetch(new Request(new URL(new URL(input.url).pathname + new URL(input.url).search, server.url), input))
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

const probes: unknown[] = []
const post = (operation: string, body: unknown, id = sessionID, kind: Parameters<typeof headers>[0] = "normal") => request(new Request(`http://localhost/api/session/${id}/${operation}?location[directory]=${encodeURIComponent(join(workspace, "forged"))}`, {
  method: "POST", headers: headers(kind), body: JSON.stringify(body),
}))
try {
  for (const [operation, body] of [
    ["shell", { id: "msg_contract_shell", command: "NOT_EXECUTED", agent: "fixture", model: { providerID: "fixture", id: "fixture" } }],
    ["command", { id: "msg_contract_command", command: "review", arguments: "fixture", resume: false }],
    ["compact", { model: { providerID: "fixture", id: "fixture" } }],
  ] as const) {
    const response = await post(operation, body)
    expect(response.status).toBe(operation === "command" ? 200 : 204)
    probes.push({ operation, status: response.status, body: await response.text() })
  }
  expect(calls[0]).toMatchObject({ operation: "shell", input: { id: "msg_contract_shell", command: "NOT_EXECUTED", agent: "fixture", model: { providerID: "fixture", id: "fixture" } }, principal: { userID: accounts.owner.userID, tenantID: accounts.owner.tenantID } })
  expect(calls[2]).toMatchObject({ operation: "compact", input: { model: { providerID: "fixture", id: "fixture" } } })
  expect(resolvedDirectories.every(directory => directory === workspace)).toBe(true)
  const retry = await post("command", { id: "msg_contract_command", command: "review", arguments: "fixture", resume: false })
  expect(retry.status).toBe(200)
  expect(preparations).toBe(1)
  expect((await retry.json()).data.prompt.text).toBe("Resolved review: fixture")
  expect((await post("command", { id: "msg_contract_command", command: "review", arguments: "changed", resume: false })).status).toBe(409)
  const queued = await post("prompt", { id: "msg_contract_queued", prompt: { text: "/review queued", command: { name: "review", arguments: "queued" } }, delivery: "queue", resume: false })
  expect(queued.status).toBe(200)
  expect((await queued.json()).data.prompt.text).toBe("Resolved review: queued")
  expect((await post("shell", { command: "busy" })).status).toBe(409)
  expect((await post("compact", { expectedContext: "stale" })).status).toBe(409)
  expect((await post("compact", { expectedContext: "failed" })).status).toBe(503)
  for (const operation of ["shell", "command", "compact"]) {
    const count = calls.length
    const body = operation === "shell" ? { command: "NOT_EXECUTED" } : operation === "command" ? { command: "review", resume: false } : {}
    expect((await post(operation, body, SessionV2.ID.make("ses_missing"))).status).toBe(404)
    if (mode !== "private") expect((await post(operation, body, sessionID, "none")).status).toBe(401)
    if (mode === "users") expect((await post(operation, body, sessionID, "foreign")).status).toBe(404)
    expect(calls.length).toBe(count)
  }
  expect(externalRequests).toBe(0)
  console.log(JSON.stringify({ mode, probes, externalRequests }))
  console.log(`session-command-route-ok:${mode}`)
} finally {
  await server.stop(true)
  await web.dispose()
}
