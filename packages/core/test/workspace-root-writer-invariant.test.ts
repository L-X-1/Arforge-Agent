import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import * as WorkspaceRootWriterInvariant from "../src/workspace-root-writer-invariant"
import { inspectWorkspaceRootFileWriter } from "../src/workspace-root-file-writer"
import {
  inspectWorkspaceRootProductionOwner,
  type WorkspaceRootProductionOwnerEvidence,
} from "../src/workspace-root-production-evidence"
import { makeWorkspaceRootProductionOwner } from "../src/workspace-root-owner"
import { workspaceRootMutationEnableGate } from "../src/workspace-roots"

describe("workspace root writer runtime invariant", () => {
  test("accepts a clean read-only preflight and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-invariant-"))
    try {
      const preflight = inspectWorkspaceRootFileWriter({ profileDirectory: join(root, "profile"), primary: root })
      const registry = RuntimeInvariants.createRuntimeInvariantRegistry()
      WorkspaceRootWriterInvariant.registerInvariants(registry)
      WorkspaceRootWriterInvariant.registerInvariants(registry)
      const report = await Effect.runPromise(WorkspaceRootWriterInvariant.inspect(registry, { preflight }))
      expect(report).toMatchObject({ checked: 1, skipped: 0, passed: 1, failed: 0, passedAll: true })
      expect(registry.list(WorkspaceRootWriterInvariant.OWNER)).toHaveLength(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fails closed on status/ready drift, missing reasons and duplicate checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-invariant-negative-"))
    try {
      const preflight = inspectWorkspaceRootFileWriter({ profileDirectory: join(root, "profile"), primary: root })
      const registry = RuntimeInvariants.createRuntimeInvariantRegistry()
      const cases = [
        { ...preflight, ready: false },
        {
          ...preflight,
          status: "blocked" as const,
          ready: false,
          blocking_reasons: ["state_conflict"],
          checks: preflight.checks.map((check, index) =>
            index === 0 ? { ...check, status: "blocked" as const, reason: "state_malformed" as const } : check,
          ),
        },
        {
          ...preflight,
          status: "blocked" as const,
          ready: false,
          blocking_reasons: ["state_malformed" as const],
          checks: preflight.checks.map((check, index) =>
            index === 0
              ? { ...check, status: "blocked" as const, reason: "state_malformed" as const }
              : index === 1
                ? { ...check, status: "pending" as const, reason: "recovery_required" as const }
                : check,
          ),
        },
        { ...preflight, checks: [...preflight.checks, preflight.checks[0]!] },
      ]
      for (const candidate of cases) {
        const report = await Effect.runPromise(WorkspaceRootWriterInvariant.inspect(registry, { preflight: candidate }))
        expect(report.passedAll).toBe(false)
        expect(report.failed).toBe(1)
        expect(report.results[0]?.status).toBe("failed")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("validates the fail-closed enable gate through the same owner", async () => {
    const registry = RuntimeInvariants.createRuntimeInvariantRegistry()
    const gate = workspaceRootMutationEnableGate()
    const report = await Effect.runPromise(
      WorkspaceRootWriterInvariant.inspect(registry, { kind: "enable-gate", gate }),
    )
    expect(report).toMatchObject({ checked: 1, skipped: 0, passed: 1, failed: 0, passedAll: true })

    const tampered = await Effect.runPromise(
      WorkspaceRootWriterInvariant.inspect(registry, {
        kind: "enable-gate",
        gate: { ...gate, ready: true } as never,
      }),
    )
    expect(tampered.passedAll).toBe(false)
    expect(tampered.failed).toBe(1)
    expect(tampered.results[0]?.status).toBe("failed")
  })

  test("validates the complete canonical production owner evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-production-evidence-"))
    try {
      const owner = makeWorkspaceRootProductionOwner({ profileDirectory: join(root, "profile"), primary: root })
      const evidence = inspectWorkspaceRootProductionOwner(owner)
      expect(evidence).toMatchObject({
        execution_mode: "read-only-workspace-root-production-owner-evidence",
        side_effects: "none",
        owner: "typescript-core-workspace-root-writer",
        binding_status: "complete",
        missing_seams: [],
        writer_enabled: false,
        status: "blocked",
        ready: false,
        decision: "keep-disabled",
      })
      expect(evidence.required_seams.every((seam) => seam.bound)).toBe(true)
      const registry = RuntimeInvariants.createRuntimeInvariantRegistry()
      const report = await Effect.runPromise(
        WorkspaceRootWriterInvariant.inspect(registry, { kind: "production-owner", evidence }),
      )
      expect(report).toMatchObject({ checked: 1, skipped: 0, passed: 1, failed: 0, passedAll: true })
      expect(registry.list(WorkspaceRootWriterInvariant.OWNER)).toHaveLength(3)

      const tampered = {
        ...evidence,
        required_seams: evidence.required_seams.map((seam, index) => (index === 0 ? { ...seam, bound: false } : seam)),
      } satisfies WorkspaceRootProductionOwnerEvidence
      const failed = await Effect.runPromise(
        WorkspaceRootWriterInvariant.inspect(registry, { kind: "production-owner", evidence: tampered }),
      )
      expect(failed.passedAll).toBe(false)
      expect(failed.failed).toBe(1)
      expect(failed.results[0]?.status).toBe("failed")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
