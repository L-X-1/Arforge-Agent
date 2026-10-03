import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import * as ArtifactMaintenanceScan from "@arforge-ai/core/runtime/artifact-maintenance-scan"
import * as ProfileMaintenanceLifecycle from "@arforge-ai/core/runtime/profile-maintenance-lifecycle"
import { testEffect } from "../lib/effect"

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, ArtifactMaintenanceScan.node, ProfileMaintenanceLifecycle.node]),
)
const it = testEffect(runtimeLayer)

describe("ProfileMaintenanceLifecycle", () => {
  it.effect("binds hooks to the current tenant/profile and observes every lifecycle phase", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scans = yield* ArtifactMaintenanceScan.Service
      const lifecycle = yield* ProfileMaintenanceLifecycle.Service
      const owner = { tenantID: "ten_profile_lifecycle", userID: "usr_profile_lifecycle" }
      const other = { tenantID: "ten_profile_other", userID: "usr_profile_other" }
      const now = Date.now()

      yield* database.runAsPrincipal(owner, scans.create({ nowMs: now - 5_000, ttlMs: 1_000 }))
      yield* database.runAsPrincipal(owner, scans.create({ nowMs: now, ttlMs: 10_000 }))

      const opened = yield* database.runAsPrincipal(owner, lifecycle.open({ nowMs: now }))
      expect(opened.phase).toBe("open")
      expect(opened.tick).toMatchObject({
        observedAt: now,
        expiredScans: 1,
        activeScans: 1,
        completeScans: 0,
        expiredTotal: 1,
      })

      const bound = yield* database.runAsPrincipal(owner, lifecycle.binding)
      expect(bound.profileID).toBe(opened.profileID)
      expect(ProfileMaintenanceLifecycle.isProfileID(bound.profileID)).toBe(true)
      expect(bound).toMatchObject({ tenantID: owner.tenantID, ownerUserID: owner.userID })

      const resumed = yield* database.runAsPrincipal(
        owner,
        lifecycle.resume({ profileID: opened.profileID, nowMs: now + 1 }),
      )
      const idled = yield* database.runAsPrincipal(
        owner,
        lifecycle.idle({ profileID: resumed.profileID, nowMs: now + 2 }),
      )
      const closed = yield* database.runAsPrincipal(
        owner,
        lifecycle.close({ profileID: idled.profileID, nowMs: now + 3 }),
      )
      expect([resumed.phase, idled.phase, closed.phase]).toEqual(["resume", "idle", "close"])
      expect(resumed.profileID).toBe(opened.profileID)
      expect(idled.profileID).toBe(opened.profileID)
      expect(closed.profileID).toBe(opened.profileID)

      const wrongTenant = yield* database.runAsPrincipal(
        other,
        lifecycle.idle({ profileID: opened.profileID, nowMs: now + 4 }).pipe(Effect.exit),
      )
      expect(Exit.isFailure(wrongTenant)).toBe(true)
      if (Exit.isFailure(wrongTenant)) expect(wrongTenant.cause).toBeDefined()

      const invalid = yield* database.runAsPrincipal(
        owner,
        lifecycle.open({ profileID: "not-a-profile", nowMs: now + 5 }).pipe(Effect.exit),
      )
      expect(Exit.isFailure(invalid)).toBe(true)
    }),
  )

  it.effect("derives different opaque bindings for different tenant/user pairs", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const lifecycle = yield* ProfileMaintenanceLifecycle.Service
      const first = yield* database.runAsPrincipal(
        { tenantID: "ten_profile_a", userID: "usr_profile" },
        lifecycle.binding,
      )
      const second = yield* database.runAsPrincipal(
        { tenantID: "ten_profile_b", userID: "usr_profile" },
        lifecycle.binding,
      )
      expect(first.profileID).not.toBe(second.profileID)
      expect(first.profileID).not.toContain(first.tenantID)
      expect(first.profileID).not.toContain(first.ownerUserID)
    }),
  )
})
