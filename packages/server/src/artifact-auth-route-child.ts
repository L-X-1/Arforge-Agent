import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentRuntime as AgentRuntimeSchema } from "@arforge-ai/schema/agent-runtime"

const [databasePath, home] = Bun.argv.slice(2)
if (!databasePath || !home) throw new Error("authenticated artifact route child requires database and home")

// These assignments happen before the dynamic imports below.  The dialect is
// selected at module initialization and must see SQLite even when the parent
// test process has a PostgreSQL environment configured.
process.env.ARFORGE_DB = databasePath
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_HOME = home
process.env.ARFORGE_AUTH_MODE = "users"
process.env.ARFORGE_AUTH_SECRET = "artifact-auth-route-test-secret-with-32-characters"
process.env.ARFORGE_AUTH_EXPOSE_TOKENS = "true"
process.env.ARFORGE_PUBLIC_URL = "http://localhost"

const { DateTime, Effect, Schema } = await import("effect")
const { and, eq } = await import("drizzle-orm")
const { Database } = await import("@arforge-ai/core/database/database")
const {
  IdentityTenantMemberTable,
  IdentityTenantTable,
  IdentityUserTable,
} = await import("@arforge-ai/core/identity/sql")
const { AgentRuntime } = await import("@arforge-ai/schema/agent-runtime")
const { OpaqueArtifact } = await import("@arforge-ai/core/runtime/artifact-ref")
const { UserAuth } = await import("./user-auth")

const config: import("./user-auth").UserAuth.Info = {
  mode: "users",
  secret: (await import("effect")).Option.some("artifact-auth-route-test-secret-with-32-characters"),
  publicUrl: "http://localhost",
  emailWebhookUrl: (await import("effect")).Option.none(),
  emailWebhookToken: (await import("effect")).Option.none(),
  exposeTokens: "true",
  trustProxy: "false",
}

const seeded = await Effect.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const register = (email: string, displayName: string) =>
      Effect.gen(function* () {
        const result = yield* UserAuth.register(
          db,
          config,
          { email, password: "artifact-route-secure-password", displayName },
          Date.now(),
        )
        if (!result.accepted || !result.delivery) throw new Error(`registration failed for ${email}`)
        if (!(yield* UserAuth.verifyEmail(db, result.delivery.token, Date.now() + 1)))
          throw new Error(`verification failed for ${email}`)
        const user = yield* db
          .select()
          .from(IdentityUserTable)
          .where(eq(IdentityUserTable.normalized_email, email))
          .get()
          .pipe(Effect.orDie)
        if (!user) throw new Error(`user row missing for ${email}`)
        const personalMembership = yield* db
          .select()
          .from(IdentityTenantMemberTable)
          .where(eq(IdentityTenantMemberTable.user_id, user.id))
          .get()
          .pipe(Effect.orDie)
        if (!personalMembership) throw new Error(`membership row missing for ${email}`)
        return { userID: user.id, personalTenantID: personalMembership.tenant_id, email }
      })

    const owner = yield* register("owner@artifact-route.test", "Owner")
    const admin = yield* register("admin@artifact-route.test", "Admin")
    const member = yield* register("member@artifact-route.test", "Member")
    const now = Date.now()

    yield* db
      .update(IdentityTenantMemberTable)
      .set({ status: "suspended", time_updated: now })
      .where(
        and(
          eq(IdentityTenantMemberTable.tenant_id, admin.personalTenantID),
          eq(IdentityTenantMemberTable.user_id, admin.userID),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(IdentityTenantMemberTable)
      .set({ status: "suspended", time_updated: now })
      .where(
        and(
          eq(IdentityTenantMemberTable.tenant_id, member.personalTenantID),
          eq(IdentityTenantMemberTable.user_id, member.userID),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db.insert(IdentityTenantMemberTable).values([
      {
        tenant_id: owner.personalTenantID,
        user_id: admin.userID,
        role: "admin",
        status: "active",
        time_created: now,
        time_updated: now,
      },
      {
        tenant_id: owner.personalTenantID,
        user_id: member.userID,
        role: "member",
        status: "active",
        time_created: now,
        time_updated: now,
      },
    ]).run().pipe(Effect.orDie)

    const ownerLogin = yield* UserAuth.login(
      db,
      config,
      { email: owner.email, password: "artifact-route-secure-password", ip: "127.0.0.1", userAgent: "owner-test" },
      now + 2,
    )
    const adminLogin = yield* UserAuth.login(
      db,
      config,
      { email: admin.email, password: "artifact-route-secure-password", ip: "127.0.0.2", userAgent: "admin-test" },
      now + 3,
    )
    const memberLogin = yield* UserAuth.login(
      db,
      config,
      { email: member.email, password: "artifact-route-secure-password", ip: "127.0.0.3", userAgent: "member-test" },
      now + 4,
    )
    if (!ownerLogin.ok || !adminLogin.ok || !memberLogin.ok) throw new Error("role login failed")
    return {
      tenantID: owner.personalTenantID,
      owner: { userID: owner.userID, token: ownerLogin.token },
      admin: { userID: admin.userID, token: adminLogin.token },
      member: { userID: member.userID, token: memberLogin.token },
    }
  }).pipe(Effect.provide(Database.layerFromPath(databasePath)), Effect.scoped),
)

const { HttpRouter } = await import("effect/unstable/http")
const { createRoutes } = await import("./routes")
const web = HttpRouter.toWebHandler(createRoutes() as never, { disableLogger: true }) as unknown as {
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

const outputDirectory = join(home, "tool-output")
const indexDirectory = join(outputDirectory, "index")
mkdirSync(indexDirectory, { recursive: true })
const content = Buffer.from("authenticated tenant artifact\n", "utf8")
const reference = OpaqueArtifact.make({
  version: 1,
  kind: "tool_output",
  digest: createHash("sha256").update(content).digest("hex"),
  mime: "text/plain",
  sizeBytes: content.byteLength,
  owner: { scope: "tenant", id: seeded.tenantID },
  retention: { mode: "durable" },
  retrievalHint: { kind: "managed", handle: "tool_authenticated_tenant" },
  createdAt: DateTime.makeUnsafe(Date.now()),
})
writeFileSync(join(outputDirectory, reference.retrievalHint.handle), content, { flag: "wx" })
writeFileSync(
  join(indexDirectory, `${reference.retrievalHint.handle}.json`),
  JSON.stringify(Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference)),
  "utf8",
)

const requestFor = (path: string, token: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Cookie: `${UserAuth.COOKIE_NAME}=${token}`,
      ...(init.method && init.method !== "GET" ? { Origin: "http://localhost" } : {}),
    },
  })

for (const [role, account, tenantReadable] of [
  ["owner", seeded.owner, true],
  ["admin", seeded.admin, true],
  ["member", seeded.member, false],
] as const) {
  const contextResponse = await web.handler(requestFor("/api/artifacts/owner-context", account.token))
  if (contextResponse.status !== 200) throw new Error(`${role} owner context returned ${contextResponse.status}`)
  const context = (await contextResponse.json()) as {
    readonly profile?: { readonly scope?: string; readonly id?: string }
    readonly tenant?: { readonly scope?: string; readonly id?: string }
    readonly tenantReadable?: boolean
  }
  if (
    context.profile?.scope !== "profile" ||
    context.profile.id !== account.userID ||
    context.tenant?.scope !== "tenant" ||
    context.tenant.id !== seeded.tenantID ||
    context.tenantReadable !== tenantReadable
  )
    throw new Error(`${role} owner context is not principal-bound`)
  if (JSON.stringify(context).includes("path") || JSON.stringify(context).includes("secret"))
    throw new Error(`${role} owner context exposed a local secret or path`)

  const maintenanceProfile = await web.handler(
    requestFor("/api/artifacts/maintenance-context?scope=profile", account.token),
  )
  if (maintenanceProfile.status !== 200)
    throw new Error(`${role} profile maintenance context returned ${maintenanceProfile.status}`)
  const maintenanceProfileBody = (await maintenanceProfile.json()) as {
    readonly owner?: { readonly scope?: string; readonly id?: string }
    readonly maintenanceScope?: string
    readonly canMaintain?: boolean
    readonly scan?: unknown
    readonly reason?: string
  }
  const expectedCanMaintain = role !== "member"
  if (
    maintenanceProfileBody.owner?.scope !== "profile" ||
    maintenanceProfileBody.owner.id !== account.userID ||
    maintenanceProfileBody.maintenanceScope !== "profile" ||
    maintenanceProfileBody.canMaintain !== expectedCanMaintain ||
    typeof maintenanceProfileBody.reason !== "string"
  )
    throw new Error(`${role} profile maintenance context is not principal-bound`)
  if (JSON.stringify(maintenanceProfileBody).includes("path") || JSON.stringify(maintenanceProfileBody).includes("secret"))
    throw new Error(`${role} maintenance context exposed a local secret or path`)

  const maintenanceTenant = await web.handler(
    requestFor("/api/artifacts/maintenance-context?scope=tenant", account.token),
  )
  if (maintenanceTenant.status !== 200)
    throw new Error(`${role} tenant maintenance context returned ${maintenanceTenant.status}`)
  const maintenanceTenantBody = (await maintenanceTenant.json()) as {
    readonly owner?: { readonly scope?: string; readonly id?: string }
    readonly maintenanceScope?: string
    readonly canMaintain?: boolean
    readonly scan?: unknown
    readonly reason?: string
  }
  if (
    maintenanceTenantBody.owner?.scope !== "tenant" ||
    maintenanceTenantBody.owner.id !== seeded.tenantID ||
    maintenanceTenantBody.maintenanceScope !== "profile" ||
    maintenanceTenantBody.canMaintain !== false ||
    maintenanceTenantBody.scan !== null ||
    typeof maintenanceTenantBody.reason !== "string"
  )
    throw new Error(`${role} tenant maintenance context widened profile maintenance authority`)

  const profileCatalog = await web.handler(
    requestFor("/api/artifacts/catalog", account.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: { scope: "profile", id: account.userID }, limit: 10 }),
    }),
  )
  if (profileCatalog.status !== 200) throw new Error(`${role} profile catalog returned ${profileCatalog.status}`)

  const tenantCatalog = await web.handler(
    requestFor("/api/artifacts/catalog", account.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: { scope: "tenant", id: seeded.tenantID }, limit: 10 }),
    }),
  )
  if (tenantCatalog.status !== (tenantReadable ? 200 : 403))
    throw new Error(`${role} tenant catalog returned ${tenantCatalog.status}`)

  const tenantRead = await web.handler(
    requestFor("/api/artifacts/read", account.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference) }),
    }),
  )
  if (tenantRead.status !== (tenantReadable ? 200 : 403))
    throw new Error(`${role} tenant read returned ${tenantRead.status}`)
  if (tenantReadable && (await tenantRead.text()) !== content.toString("utf8"))
    throw new Error(`${role} tenant bytes changed`)
}

await web.dispose()
console.log("artifact-auth-route-ok")
