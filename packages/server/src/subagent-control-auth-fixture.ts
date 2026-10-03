import { Database } from "@arforge-ai/core/database/database"
import { IdentityTenantMemberTable, IdentityUserTable } from "@arforge-ai/core/identity/sql"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Effect, Option } from "effect"
import { UserAuth } from "./user-auth"

// Test-only helper: real credential verification and cookie middleware, never
// an injected IdentityContext. All accounts live in the caller's temporary DB.
export async function verifyAuthenticatedChildren(input: {
  databasePath: string
  parentSessionID: SessionSchema.ID
  childSessionID: SessionSchema.ID
  descendantSessionID: SessionSchema.ID
  childRunID: string
  endpoint: string
  handler: (request: Request) => Promise<Response>
  persistedAccess: (runID: string) => Promise<boolean>
  withControlLease: (verify: () => Promise<void>, afterVerification: () => Promise<void>) => Promise<void>
}) {
  const layer = Database.layerFromPath(input.databasePath)
  const config: UserAuth.Info = {
    mode: "users",
    secret: Option.some("subagent-auth-route-fixture-secret-32-characters"),
    publicUrl: "http://localhost",
    emailWebhookUrl: Option.none(),
    emailWebhookToken: Option.none(),
    exposeTokens: "true",
    trustProxy: "false",
  }
  const accounts = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const register = Effect.fnUntraced(function* (name: string) {
        const email = `${name}@subagent-route.test`
        const result = yield* UserAuth.register(
          db,
          config,
          { email, password: "subagent-route-fixture-password", displayName: name },
          Date.now(),
        )
        if (!result.accepted || !result.delivery) throw new Error("fixture registration failed")
        if (!(yield* UserAuth.verifyEmail(db, result.delivery.token, Date.now())))
          throw new Error("fixture verification failed")
        const user = yield* db
          .select()
          .from(IdentityUserTable)
          .where(eq(IdentityUserTable.normalized_email, email))
          .get()
          .pipe(Effect.orDie)
        if (!user) throw new Error("fixture user missing")
        const membership = yield* db
          .select()
          .from(IdentityTenantMemberTable)
          .where(eq(IdentityTenantMemberTable.user_id, user.id))
          .get()
          .pipe(Effect.orDie)
        if (!membership) throw new Error("fixture membership missing")
        return { userID: user.id, tenantID: membership.tenant_id, email }
      })
      const owner = yield* register("owner")
      const admin = yield* register("admin")
      const member = yield* register("member")
      const foreign = yield* register("foreign")
      for (const [account, role] of [
        [admin, "admin"],
        [member, "member"],
      ] as const) {
        yield* db
          .update(IdentityTenantMemberTable)
          .set({ status: "suspended" })
          .where(eq(IdentityTenantMemberTable.user_id, account.userID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(IdentityTenantMemberTable)
          .values({
            tenant_id: owner.tenantID,
            user_id: account.userID,
            role,
            status: "active",
          })
          .run()
          .pipe(Effect.orDie)
      }
      const login = Effect.fnUntraced(function* (account: typeof owner) {
        const result = yield* UserAuth.login(
          db,
          config,
          {
            email: account.email,
            password: "subagent-route-fixture-password",
            ip: "127.0.0.1",
            userAgent: "subagent-auth-fixture",
          },
          Date.now(),
        )
        if (!result.ok) throw new Error("fixture login failed")
        return { ...account, token: result.token, principal: result.principal }
      })
      return {
        owner: yield* login(owner),
        admin: yield* login(admin),
        member: yield* login(member),
        foreign: yield* login(foreign),
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )
  for (const role of ["owner", "admin", "member"] as const) {
    if (accounts[role].principal.role !== role || accounts[role].principal.tenantID !== accounts.owner.tenantID)
      throw new Error(`${role} fixture authenticated into the wrong scope`)
  }
  const setOwner = (id: SessionSchema.ID, tenantID: string, userID: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ tenant_id: tenantID, owner_user_id: userID })
          .where(eq(SessionTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
  const request = async (token: string | undefined, expected: number, label: string) => {
    const response = await input.handler(
      new Request(input.endpoint, {
        headers: token ? { Cookie: `${UserAuth.COOKIE_NAME}=${token}` } : {},
      }),
    )
    const body = await response.text()
    if (response.status !== expected) throw new Error(`${label}: expected ${expected}, received ${response.status}`)
    if (expected === 200) {
      const decoded = JSON.parse(body)
      if (decoded.children?.length !== 1 || decoded.children[0].childRunID !== input.childRunID)
        throw new Error(`${label}: wrong children projection`)
      if (decoded.controlAvailable !== false) throw new Error(`${label}: read-only parent exposed execution controls`)
    } else if (body.includes(input.childRunID) || body.includes("objectiveDigest")) {
      throw new Error(`${label}: denied response leaked child metadata`)
    }
  }
  await request(undefined, 401, "anonymous")
  await request("invalid-fixture-cookie", 401, "invalid cookie")
  await setOwner(input.descendantSessionID, accounts.foreign.tenantID, accounts.foreign.userID)
  for (const id of [input.parentSessionID, input.childSessionID])
    await setOwner(id, accounts.owner.tenantID, accounts.member.userID)
  for (const role of ["owner", "admin", "member"] as const)
    await request(accounts[role].token, 200, `${role} readable member sessions`)
  await request(accounts.foreign.token, 403, "foreign tenant owner")

  // Each side must be authorized independently. An authorized parent cannot
  // launder another user's child, and an owned child cannot expose its parent.
  for (const id of [input.parentSessionID, input.childSessionID]) {
    await setOwner(id, accounts.owner.tenantID, accounts.owner.userID)
    await request(accounts.member.token, 403, "member other-user session")
    await request(accounts.admin.token, 200, "admin same-tenant session")
    await setOwner(id, accounts.foreign.tenantID, accounts.foreign.userID)
    for (const role of ["owner", "admin", "member"] as const)
      await request(accounts[role].token, 403, `${role} foreign session`)
    await setOwner(id, accounts.owner.tenantID, accounts.member.userID)
    await request(accounts.member.token, 200, "member restored ownership")
  }
  await input.withControlLease(
    async () => {
      let serial = 0
      for (const id of [input.parentSessionID, input.childSessionID]) {
        await setOwner(id, accounts.owner.tenantID, accounts.owner.userID)
        for (const account of [accounts.member, accounts.foreign]) {
          for (const operation of ["steer", "followup", "wait", "cancel", "status"]) {
            const url = new URL(input.endpoint)
            url.pathname = url.pathname.replace(
              /children$/,
              `${input.childRunID}/${operation === "status" ? "wait/cpr_auth_missing" : operation}`,
            )
            const response = await input.handler(
              new Request(url, {
                method: operation === "status" ? "GET" : "POST",
                headers: {
                  Cookie: `${UserAuth.COOKIE_NAME}=${account.token}`,
                  Origin: "http://localhost",
                  "content-type": "application/json",
                },
                ...(operation === "status"
                  ? {}
                  : {
                      body: JSON.stringify({
                        requestID: `cpr_auth_denied_${++serial}`,
                        ...(operation === "steer" || operation === "followup"
                          ? { prompt: { text: "must not admit" } }
                          : operation === "cancel"
                            ? { reason: "must not cancel" }
                            : { timeoutMs: 0 }),
                      }),
                    }),
              }),
            )
            if (response.status !== 403)
              throw new Error(`unauthorized ${operation}: expected 403, received ${response.status}`)
            const body = await response.text()
            if (body.includes(input.childRunID) || body.includes("controlRunID"))
              throw new Error("denied control leaked metadata")
          }
        }
        await setOwner(id, accounts.owner.tenantID, accounts.member.userID)
      }
      const cancelURL = new URL(input.endpoint)
      cancelURL.pathname = cancelURL.pathname.replace(/children$/, `${input.childRunID}/cancel`)
      const deniedTree = await input.handler(
        new Request(cancelURL, {
          method: "POST",
          headers: {
            Cookie: `${UserAuth.COOKIE_NAME}=${accounts.member.token}`,
            Origin: "http://localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestID: "cpr_auth_foreign_descendant",
            reason: "must not cancel foreign descendant",
          }),
        }),
      )
      if (deniedTree.status !== 403) throw new Error(`foreign descendant cancellation returned ${deniedTree.status}`)
      await setOwner(input.descendantSessionID, accounts.owner.tenantID, accounts.member.userID)
      // A denial-only suite could pass if all controls were disabled. Exercise
      // the original claim/Gateway path and principal-bound status for each role.
      for (const role of ["owner", "admin", "member"] as const) {
        const url = new URL(input.endpoint)
        url.pathname = url.pathname.replace(/children$/, `${input.childRunID}/wait`)
        const requestID = `cpr_auth_allowed_${role}`
        const headers = {
          Cookie: `${UserAuth.COOKIE_NAME}=${accounts[role].token}`,
          Origin: "http://localhost",
          "content-type": "application/json",
        }
        const response = await input.handler(
          new Request(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ requestID, timeoutMs: 0 }),
          }),
        )
        if (response.status !== 200) throw new Error(`${role} authorized wait failed: ${response.status}`)
        const admitted = await response.json()
        if (!admitted.controlRunID || admitted.childRunID !== input.childRunID)
          throw new Error("authorized wait did not use the durable control path")
        if (!(await input.persistedAccess(admitted.controlRunID)))
          throw new Error("persisted claim access rejected its current owner")
        url.pathname += `/${requestID}`
        const status = await input.handler(new Request(url, { headers }))
        if (status.status !== 200 || (await status.json()).controlRunID !== admitted.controlRunID)
          throw new Error(`${role} cannot retrieve its own control claim`)
        const replayURL = new URL(url)
        replayURL.pathname = replayURL.pathname.slice(0, -`/${requestID}`.length)
        if (role === "admin") {
          const setRole = (next: "admin" | "member") =>
            Effect.runPromise(
              Effect.gen(function* () {
                const { db } = yield* Database.Service
                yield* db
                  .update(IdentityTenantMemberTable)
                  .set({ role: next })
                  .where(
                    and(
                      eq(IdentityTenantMemberTable.tenant_id, accounts.owner.tenantID),
                      eq(IdentityTenantMemberTable.user_id, accounts.admin.userID),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
              }).pipe(Effect.scoped, Effect.provide(layer)),
            )
          await setRole("member")
          if (await input.persistedAccess(admitted.controlRunID))
            throw new Error("persisted claim retained old admin role")
          try {
            for (const method of ["GET", "POST"]) {
              const denied = await input.handler(
                new Request(method === "GET" ? url : replayURL, {
                  method,
                  headers,
                  ...(method === "POST" ? { body: JSON.stringify({ requestID, timeoutMs: 0 }) } : {}),
                }),
              )
              if (denied.status !== 403) throw new Error(`demoted admin retained ${method} access: ${denied.status}`)
            }
          } finally {
            await setRole("admin")
          }
          const restored = await input.handler(new Request(url, { headers }))
          if (restored.status !== 200 || (await restored.json()).controlRunID !== admitted.controlRunID)
            throw new Error("restored admin cannot read its original claim")
        }
        // Existing claim IDs and still-valid login cookies must not preserve
        // authority after either session moves outside the principal's scope.
        for (const id of [input.parentSessionID, input.childSessionID]) {
          await setOwner(id, accounts.foreign.tenantID, accounts.foreign.userID)
          if (await input.persistedAccess(admitted.controlRunID))
            throw new Error("persisted claim retained foreign session access")
          for (const method of ["GET", "POST"]) {
            const denied = await input.handler(
              new Request(method === "GET" ? url : replayURL, {
                method,
                headers,
                ...(method === "POST" ? { body: JSON.stringify({ requestID, timeoutMs: 0 }) } : {}),
              }),
            )
            if (denied.status !== 403) throw new Error(`${role} revoked ${method} claim returned ${denied.status}`)
            const body = await denied.text()
            if (body.includes(admitted.controlRunID) || body.includes(input.childRunID))
              throw new Error("revoked claim leaked durable identifiers")
          }
          await setOwner(id, accounts.owner.tenantID, accounts.member.userID)
          const replay = await input.handler(
            new Request(replayURL, {
              method: "POST",
              headers,
              body: JSON.stringify({ requestID, timeoutMs: 0 }),
            }),
          )
          if (replay.status !== 200 || (await replay.json()).controlRunID !== admitted.controlRunID)
            throw new Error(`${role} restored replay lost the original claim identity`)
        }
      }
    },
    async () => {
      const url = new URL(input.endpoint)
      url.pathname = url.pathname.replace(/children$/, `${input.childRunID}/cancel`)
      const headers = {
        Cookie: `${UserAuth.COOKIE_NAME}=${accounts.member.token}`,
        Origin: "http://localhost",
        "content-type": "application/json",
      }
      const response = await input.handler(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ requestID: "cpr_auth_allowed_tree_cancel", reason: "authorized tree cancellation" }),
        }),
      )
      if (response.status !== 200 || (await response.json()).status !== "cancelled")
        throw new Error("authorized recursive cancellation did not cancel the child")
      url.pathname = `/api/subagent-control/${input.childRunID}/children`
      const descendants = await input.handler(new Request(url, { headers }))
      if (descendants.status !== 200) throw new Error("authorized descendant observation failed")
      const result = await descendants.json()
      if (result.children?.length !== 1 || result.children[0].status !== "cancelled")
        throw new Error("authorized recursive cancellation did not reach the descendant")
    },
  )
}
