import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { makeWorkspaceRootProductionOwner } from "@arforge-ai/core/workspace-root-owner"
import { buildWorkspaceRootControlRequest, executeWorkspaceRootControl } from "../src/workspace-root-control-gateway"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"

describe("workspace root control gateway", () => {
  test("builds one canonical control action from the Core-owned state snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-control-"))
    const target = await mkdtemp(join(tmpdir(), "arforge-workspace-control-target-"))
    try {
      const owner = makeWorkspaceRootProductionOwner({ profileDirectory: join(root, "profile"), primary: root })
      const requestID = AgentRuntime.ControlPlaneRequestID.create()
      const prepared = buildWorkspaceRootControlRequest({
        owner,
        principal: ControlPrincipal.LOCAL_PRINCIPAL,
        requestID,
        action: "trust",
        target,
      })
      expect(prepared.request).toMatchObject({
        action: "trust",
        primary: resolve(root),
        target: resolve(target),
        trustedWorkspaces: [],
        configuredRoots: [],
        primaryIsDirectory: true,
        targetIsDirectory: true,
      })
      expect(prepared.subject).toMatchObject({
        type: "control-plane",
        location: resolve(root),
        project: "global",
        actor: "user",
        requestID,
      })
      expect(prepared.action).toMatchObject({
        kind: "control-plane",
        name: "workspace.root.trust",
        resources: [resolve(root), resolve(target)].toSorted((a, b) => a.localeCompare(b)),
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(prepared.action.actionID).toMatch(/^act_[a-f0-9]{32}$/)
      expect(prepared.action.semantics).toMatchObject({ riskTier: "L3", authority: "human", networkScope: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  test("keeps the production path fail-closed before ActionGateway or filesystem mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-control-disabled-"))
    const target = await mkdtemp(join(tmpdir(), "arforge-workspace-control-disabled-target-"))
    try {
      const owner = makeWorkspaceRootProductionOwner({ profileDirectory: join(root, "profile"), primary: root })
      let gatewayCalls = 0
      const gateway: Pick<ActionGateway.Interface, "execute"> = {
        execute: () => {
          gatewayCalls += 1
          return Effect.die(new Error("gateway must not be called while writer is disabled"))
        },
      }
      const exit = await Effect.runPromiseExit(
        executeWorkspaceRootControl({
          owner,
          gateway,
          principal: ControlPrincipal.LOCAL_PRINCIPAL,
          requestID: AgentRuntime.ControlPlaneRequestID.create(),
          action: "trust",
          target,
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("writer_disabled")
      expect(gatewayCalls).toBe(0)
      expect(await Bun.file(join(root, "profile", "trusted_workspaces.json")).exists()).toBe(false)
      expect(await Bun.file(join(root, "profile", "workspace_roots.json")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })
})
