import { Effect } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { ProjectV2 } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { IdentityContext } from "./identity-context"
import { describe, expect, test } from "bun:test"
import { recoveryRollbackPermission, runtimeInsightAccess, runtimeInsightVisibility, trustedPrivateRuntimeInsightPrincipal } from "./handlers/runtime-insight"

describe("runtime insight access projection", () => {
  test.each([
    ["member", false, false, false],
    ["owner", true, true, true],
    ["admin", true, true, true],
  ] as const)("keeps %s capabilities bounded and explicit", (role, canRollback, canMaintain, canRecordMcp) => {
    expect(runtimeInsightAccess(role)).toEqual({
      role,
      canReviewMutation: true,
      canRollbackMutation: canRollback,
      canMaintainArtifacts: canMaintain,
      canRecordMcpEvidence: canRecordMcp,
    })
  })

  test("does not expose profile or tenant identity", () => {
    const projection = runtimeInsightAccess("member")
    expect(Object.keys(projection).sort()).toEqual([
      "canMaintainArtifacts",
      "canRecordMcpEvidence",
      "canReviewMutation",
      "canRollbackMutation",
      "role",
    ])
  })

  test("keeps the destructive rollback gate server-side", () => {
    expect(recoveryRollbackPermission("member")).toBe(
      "Guarded mutation rollback requires an authenticated Owner or Admin.",
    )
    expect(recoveryRollbackPermission("owner")).toBeUndefined()
    expect(recoveryRollbackPermission("admin")).toBeUndefined()
  })
})

test("runtime visibility resolves canonical tenant AND user Session ownership without a role bypass", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* Database.Service
    const directory = AbsolutePath.make("/runtime-scope47")
    yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [], time_created: 1, time_updated: 1 }).onConflictDoNothing().run().pipe(Effect.orDie)
    for (const [id, tenant, user] of [["ses_scope_owned", "ten_a", "usr_a"], ["ses_scope_peer", "ten_a", "usr_b"], ["ses_scope_tenant", "ten_b", "usr_a"]] as const) {
      yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make(id), tenant_id: tenant, owner_user_id: user, project_id: ProjectV2.ID.global, directory, slug: id, title: id, version: "test", time_created: 1, time_updated: 1 }).run().pipe(Effect.orDie)
    }
    const principal = { userID: "usr_a", tenantID: "ten_a", role: "member" as const, email: "a@example.invalid", sessionID: "aus_scope" }
    for (const role of ["member", "owner", "admin"] as const) {
      const visibility = yield* runtimeInsightVisibility().pipe(Effect.provideService(IdentityContext.Current, { ...principal, role }))
      expect(visibility?.tenantID).toBe("ten_a")
      expect(visibility?.userID).toBe("usr_a")
      expect([...(visibility?.sessionIDs ?? [])]).toEqual(["ses_scope_owned"])
    }
    const unknown = yield* runtimeInsightVisibility().pipe(Effect.provideService(IdentityContext.Current, { ...principal, userID: "usr_missing" }))
    expect(unknown?.sessionIDs.size).toBe(0)
    const localCookiePrincipal = { ...IdentityContext.LocalPrincipal, sessionID: "aus_ordinary_cookie" }
    const localCookie = yield* runtimeInsightVisibility().pipe(Effect.provideService(IdentityContext.Current, localCookiePrincipal))
    expect(localCookie).toBeDefined()
    expect(localCookie?.sessionIDs.size).toBe(0)
    expect(trustedPrivateRuntimeInsightPrincipal(localCookiePrincipal)).toBe(false)
    expect(trustedPrivateRuntimeInsightPrincipal(IdentityContext.LocalPrincipal)).toBe(true)
    expect(yield* runtimeInsightVisibility().pipe(Effect.provideService(IdentityContext.Current, IdentityContext.LocalPrincipal))).toBeUndefined()
  }).pipe(Effect.scoped, Effect.provide(Database.layerFromPath(":memory:"))))
})
