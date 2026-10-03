import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { makeWorkspaceRootProductionOwner } from "../src/workspace-root-owner"

describe("workspace root production owner binding", () => {
  test("binds one canonical owner while the aggregate gate keeps writes disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-owner-"))
    const profile = join(root, "profile")
    try {
      const owner = makeWorkspaceRootProductionOwner({ profileDirectory: profile, primary: root })
      expect(owner.owner).toBe("typescript-core-workspace-root-writer")
      expect(owner.profileDirectory).toBe(resolve(profile))
      expect(owner.primary).toBe(resolve(root))
      expect(owner.enabled).toBe(false)
      expect(owner.writer.enabled).toBe(false)
      expect(owner.preflight()).toMatchObject({
        execution_mode: "read-only-workspace-root-writer-preflight",
        side_effects: "none",
        status: "clear",
        ready: true,
        blocking_reasons: [],
      })
      expect(owner.gate.gates[0]).toMatchObject({
        id: "unique-production-owner",
        status: "satisfied",
        evidenceScope: "production",
      })
      expect(owner.gate.decision).toBe("keep-disabled")

      const exit = await Effect.runPromiseExit(owner.writer.readState())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("writer_disabled")
      expect(await Bun.file(join(profile, "trusted_workspaces.json")).exists()).toBe(false)
      expect(await Bun.file(join(profile, "workspace_roots.json")).exists()).toBe(false)
      expect(await Bun.file(join(profile, ".workspace-root-writer", "lock")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("resolves the same ARFORGE_HOME profile as read-only workspace state", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-owner-home-"))
    const profile = join(root, "profile")
    const previous = process.env.ARFORGE_HOME
    try {
      await mkdir(profile, { recursive: true })
      process.env.ARFORGE_HOME = profile
      const owner = makeWorkspaceRootProductionOwner({ primary: root })
      expect(owner.profileDirectory).toBe(resolve(profile))
      expect(owner.primary).toBe(resolve(root))
      expect(owner.enabled).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.ARFORGE_HOME
      else process.env.ARFORGE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })
})
