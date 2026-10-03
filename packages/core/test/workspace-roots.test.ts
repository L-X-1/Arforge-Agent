import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  authorizedWorkspaceRoots,
  configuredWorkspaceRoots,
  isPersistedWorkspaceTrusted,
  isWorkspaceTrusted,
  planWorkspaceRootMutation,
  readWorkspaceRootMutationState,
  workspaceRootMutationEnableGate,
  assertWorkspaceRootMutationEnableGate,
  workspaceRootMutationIntentDigest,
  workspaceRootMutationContract,
  workspaceRootsReport,
} from "../src/workspace-roots"

const withHome = async <A>(home: string, fn: () => Promise<A>): Promise<A> => {
  const previous = process.env.ARFORGE_HOME
  process.env.ARFORGE_HOME = home
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.ARFORGE_HOME
    else process.env.ARFORGE_HOME = previous
  }
}

describe("workspace roots read-only contract", () => {
  test("exposes one fail-closed production writer decision card", () => {
    const gate = workspaceRootMutationEnableGate()
    expect(gate).toMatchObject({
      schema_version: 1,
      decision: "keep-disabled",
      ready: false,
    })
    expect(gate.gates).toHaveLength(5)
    expect(gate.gates.map((item) => item.id)).toEqual([
      "unique-production-owner",
      "durable-state-owner",
      "cas-rollback",
      "recovery-outbox-audit",
      "runtime-invariant",
    ])
    expect(gate.gates.map((item) => item.status)).toEqual(["satisfied", "blocked", "blocked", "blocked", "deferred"])
    expect(gate.blocking_gate_ids).toEqual(gate.gates.slice(1).map((item) => item.id))
    expect(gate.decision_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(() => assertWorkspaceRootMutationEnableGate(gate)).not.toThrow()
    expect(() => assertWorkspaceRootMutationEnableGate({ ...gate, decision_digest: "0".repeat(64) })).toThrow(
      "workspace root mutation enable gate decision digest drifted",
    )
    expect(workspaceRootMutationContract().enable_gate).toEqual(gate)
  })

  test("returns the primary root without creating profile state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-workspace-roots-"))
    const home = join(workspace, "profile")
    try {
      const report = await withHome(home, async () => workspaceRootsReport(workspace))
      expect(report).toEqual({
        primary: resolve(workspace),
        roots: [{ path: resolve(workspace), primary: true, trusted: false }],
      })
      await expect(readFile(join(home, "workspace_roots.json"), "utf8")).rejects.toThrow()
      await expect(readFile(join(home, "trusted_workspaces.json"), "utf8")).rejects.toThrow()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("filters missing or untrusted roots and deduplicates overlaps", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-workspace-roots-"))
    const home = join(workspace, "profile")
    const extra = await mkdtemp(join(tmpdir(), "arforge-authorized-root-"))
    const nested = join(extra, "nested")
    try {
      await mkdir(nested, { recursive: true })
      await mkdir(home, { recursive: true })
      await writeFile(
        join(home, "trusted_workspaces.json"),
        JSON.stringify({ workspaces: [resolve(workspace), resolve(extra)] }),
        "utf8",
      )
      await writeFile(
        join(home, "workspace_roots.json"),
        JSON.stringify({ schema_version: 1, roots: [extra, nested, extra, join(workspace, "missing")] }),
        "utf8",
      )

      await withHome(home, async () => {
        expect(isPersistedWorkspaceTrusted(workspace)).toBe(true)
        expect(configuredWorkspaceRoots()).toEqual([resolve(extra)])
        expect(authorizedWorkspaceRoots(workspace)).toEqual([resolve(workspace), resolve(extra)])
        expect(workspaceRootsReport(workspace)).toEqual({
          primary: resolve(workspace),
          roots: [
            { path: resolve(workspace), primary: true, trusted: true },
            { path: resolve(extra), primary: false, trusted: true },
          ],
        })
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(extra, { recursive: true, force: true })
    }
  })

  test("fails closed on malformed state and keeps automation bypass separate from persistence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-workspace-roots-"))
    const home = join(workspace, "profile")
    const previousTrust = process.env.ARFORGE_TRUST_WORKSPACE
    try {
      await mkdir(home, { recursive: true })
      await writeFile(join(home, "trusted_workspaces.json"), "{not-json", "utf8")
      await writeFile(join(home, "workspace_roots.json"), JSON.stringify({ roots: "not-an-array" }), "utf8")
      await withHome(home, async () => {
        delete process.env.ARFORGE_TRUST_WORKSPACE
        expect(isPersistedWorkspaceTrusted(workspace)).toBe(false)
        expect(isWorkspaceTrusted(workspace)).toBe(false)
        expect(configuredWorkspaceRoots()).toEqual([])
        process.env.ARFORGE_TRUST_WORKSPACE = "1"
        expect(isPersistedWorkspaceTrusted(workspace)).toBe(false)
        expect(isWorkspaceTrusted(workspace)).toBe(true)
      })
    } finally {
      if (previousTrust === undefined) delete process.env.ARFORGE_TRUST_WORKSPACE
      else process.env.ARFORGE_TRUST_WORKSPACE = previousTrust
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("plans a typed trust mutation without writing profile state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-workspace-mutation-"))
    const target = await mkdtemp(join(tmpdir(), "arforge-workspace-target-"))
    const home = join(workspace, "profile")
    const request = {
      action: "trust" as const,
      primary: workspace,
      primaryIsDirectory: true,
      target,
      targetIsDirectory: true,
      trustedWorkspaces: [] as string[],
      configuredRoots: [] as string[],
    }
    try {
      const authorization = {
        kind: "action-gateway" as const,
        status: "approved" as const,
        receiptID: "receipt_workspace_trust",
        actionID: "action_workspace_trust",
        workspace: resolve(workspace),
        target: resolve(target),
        intentDigest: workspaceRootMutationIntentDigest(request),
      }
      const plan = planWorkspaceRootMutation({ ...request, authorization })
      expect(plan.status).toBe("planned")
      expect(plan.changed).toBe(true)
      expect(plan.nextTrustedWorkspaces).toEqual([resolve(target)])
      expect(plan.nextConfiguredRoots).toEqual([])
      expect(plan.before.trusted).not.toBe(plan.after.trusted)
      expect(plan.commit).toEqual({
        mode: "read-only-plan",
        owner: "typescript-core-workspace-root-writer",
        requires: ["action-gateway", "cas", "rollback", "recovery-outbox", "audit"],
      })
      await expect(readFile(join(home, "trusted_workspaces.json"), "utf8")).rejects.toThrow()
      await expect(readFile(join(home, "workspace_roots.json"), "utf8")).rejects.toThrow()
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  test("requires an ActionGateway receipt even when automation trust is enabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-workspace-mutation-"))
    const previousTrust = process.env.ARFORGE_TRUST_WORKSPACE
    const request = {
      action: "trust" as const,
      primary: workspace,
      primaryIsDirectory: true,
      target: workspace,
      targetIsDirectory: true,
      trustedWorkspaces: [] as string[],
      configuredRoots: [] as string[],
    }
    try {
      process.env.ARFORGE_TRUST_WORKSPACE = "1"
      expect(() => planWorkspaceRootMutation(request)).toThrow("authorization_required")
    } finally {
      if (previousTrust === undefined) delete process.env.ARFORGE_TRUST_WORKSPACE
      else process.env.ARFORGE_TRUST_WORKSPACE = previousTrust
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("plans add/remove with independent trust, overlap and primary guards", async () => {
    const primary = await mkdtemp(join(tmpdir(), "arforge-workspace-primary-"))
    const extra = await mkdtemp(join(tmpdir(), "arforge-workspace-extra-"))
    const nested = join(extra, "nested")
    await mkdir(nested, { recursive: true })
    const trusted = [resolve(extra)]
    const configured = [] as string[]
    const addRequest = {
      action: "add" as const,
      primary,
      primaryIsDirectory: true,
      target: extra,
      targetIsDirectory: true,
      trustedWorkspaces: trusted,
      configuredRoots: configured,
    }
    const authorize = (request: Parameters<typeof workspaceRootMutationIntentDigest>[0]) => ({
      ...request,
      authorization: {
        kind: "action-gateway" as const,
        status: "approved" as const,
        receiptID: `receipt_${request.action}`,
        actionID: `action_${request.action}`,
        workspace: resolve(request.primary),
        target: resolve(request.target),
        intentDigest: workspaceRootMutationIntentDigest(request),
      },
    })
    try {
      const added = planWorkspaceRootMutation(authorize(addRequest))
      expect(added.status).toBe("planned")
      expect(added.nextConfiguredRoots).toEqual([resolve(extra)])

      const alreadyAdded = planWorkspaceRootMutation(authorize({ ...addRequest, configuredRoots: [resolve(extra)] }))
      expect(alreadyAdded.status).toBe("noop")
      expect(alreadyAdded.changed).toBe(false)

      expect(() =>
        planWorkspaceRootMutation(
          authorize({
            ...addRequest,
            target: nested,
            trustedWorkspaces: [resolve(extra), resolve(nested)],
            configuredRoots: [resolve(extra)],
          }),
        ),
      ).toThrow("root_overlap")
      expect(() => planWorkspaceRootMutation(authorize({ ...addRequest, target: primary }))).toThrow(
        "primary_not_mutable",
      )

      const removeRequest = {
        ...addRequest,
        action: "remove" as const,
        configuredRoots: [resolve(extra)],
      }
      const removed = planWorkspaceRootMutation(authorize(removeRequest))
      expect(removed.status).toBe("planned")
      expect(removed.nextConfiguredRoots).toEqual([])
      expect(removed.nextTrustedWorkspaces).toEqual([resolve(extra)])
    } finally {
      await rm(primary, { recursive: true, force: true })
      await rm(extra, { recursive: true, force: true })
    }
  })

  test("keeps mutation intent deterministic and rejects forged bindings", async () => {
    const primary = await mkdtemp(join(tmpdir(), "arforge-workspace-primary-"))
    const extra = await mkdtemp(join(tmpdir(), "arforge-workspace-extra-"))
    const request = {
      action: "add" as const,
      primary,
      primaryIsDirectory: true,
      target: extra,
      targetIsDirectory: true,
      trustedWorkspaces: [resolve(extra)],
      configuredRoots: [] as string[],
    }
    try {
      expect(workspaceRootMutationIntentDigest({ ...request, trustedWorkspaces: [resolve(extra)] })).toBe(
        workspaceRootMutationIntentDigest({ ...request, trustedWorkspaces: [resolve(extra)] }),
      )
      const authorization = {
        kind: "action-gateway" as const,
        status: "approved" as const,
        receiptID: "receipt_forged",
        actionID: "action_forged",
        workspace: resolve(primary),
        target: resolve(extra),
        intentDigest: "0".repeat(64),
      }
      expect(() => planWorkspaceRootMutation({ ...request, authorization })).toThrow("authorization_digest_mismatch")
      expect(() =>
        planWorkspaceRootMutation({
          ...request,
          authorization: { ...authorization, target: resolve(primary) },
        }),
      ).toThrow("authorization_mismatch")
    } finally {
      await rm(primary, { recursive: true, force: true })
      await rm(extra, { recursive: true, force: true })
    }
  })

  test("reads a writer-ready snapshot without creating or repairing profile files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-workspace-state-"))
    const target = await mkdtemp(join(tmpdir(), "arforge-workspace-state-target-"))
    const home = join(workspace, "profile")
    try {
      await mkdir(home, { recursive: true })
      await writeFile(
        join(home, "trusted_workspaces.json"),
        JSON.stringify({ workspaces: [resolve(workspace), resolve(target)] }),
        "utf8",
      )
      await writeFile(
        join(home, "workspace_roots.json"),
        JSON.stringify({ schema_version: 1, roots: [resolve(target)] }),
        "utf8",
      )
      const state = await withHome(home, async () => readWorkspaceRootMutationState(workspace))
      expect(state.trustedWorkspaces).toEqual([resolve(workspace), resolve(target)])
      expect(state.configuredRoots).toEqual([resolve(target)])
      expect(state.digest.trusted).toMatch(/^[a-f0-9]{64}$/)
      expect(state.digest.configured).toMatch(/^[a-f0-9]{64}$/)

      await writeFile(join(home, "workspace_roots.json"), JSON.stringify({ roots: [resolve(workspace)] }), "utf8")
      await expect(withHome(home, async () => readWorkspaceRootMutationState(workspace))).rejects.toThrow(
        "state_malformed",
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })
})
