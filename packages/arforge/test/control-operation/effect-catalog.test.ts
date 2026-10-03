import { describe, expect, it } from "bun:test"
import {
  auditControlOperationCatalog,
  ControlOperationManifest,
  worktreeEffectSemantics,
} from "@/control-operation/effect-catalog"

describe("control operation effect catalog", () => {
  it("covers every sealed worktree operation with a deadline and recovery policy", () => {
    expect(auditControlOperationCatalog()).toEqual({
      expected: 3,
      observed: 3,
      missing: [],
      invalidDeadlines: [],
    })
    expect(Object.values(ControlOperationManifest).every((entry) => entry.recovery === "manual")).toBe(true)
  })

  it("centralizes worktree risk semantics while allowing operation-specific evidence", () => {
    const semantics = worktreeEffectSemantics({
      filesystemScope: ["C:/project", "C:/worktree"],
      expectedArtifacts: ["C:/worktree"],
      successCriteria: ["worktree is clean"],
      networkScope: ["git:submodule-remotes"],
    })
    expect(semantics).toMatchObject({
      riskTier: "L3",
      authority: "human",
      idempotency: "idempotent",
      retryability: "safe",
      reversibility: "irreversible",
      networkScope: ["git-filter-processes", "git:submodule-remotes"],
      externalServices: ["git", "project-registry", "repository-configured-processes"],
    })
  })
})
