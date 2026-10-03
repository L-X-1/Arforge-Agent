import { describe, expect, test } from "bun:test"
import { Memory } from "@arforge-ai/schema/memory"
import * as MemoryCandidate from "@arforge-ai/schema/memory-candidate"
import * as MemoryPolicy from "@arforge-ai/schema/memory-policy"
import { evaluateWrite } from "@arforge-ai/core/memory-policy"

const input = (overrides: Partial<MemoryPolicy.WriteInput> = {}): MemoryPolicy.WriteInput => ({
  source: "auto",
  proposedClass: "semantic",
  scope: "workspace",
  sensitivity: "internal",
  explicitUserAuthority: false,
  crossWorkspace: false,
  credentialLike: false,
  shortTermState: false,
  ...overrides,
})

describe("Memory Step 5.4 write policy", () => {
  test("allows explicit user Memory as audited active and correction as a revision", () => {
    expect(evaluateWrite(input({ source: "user", explicitUserAuthority: true }))).toMatchObject({
      action: "active",
      trust: "trusted",
      requiresRevision: true,
      requiresReview: false,
    })
    expect(evaluateWrite(input({ source: "user-corrected", explicitUserAuthority: true }))).toMatchObject({
      action: "active_revision",
      trust: "trusted",
      requiresRevision: true,
    })
  })

  test("isolates imported, model, and automatic writes as review candidates", () => {
    for (const source of ["imported", "model", "auto"] as const) {
      expect(evaluateWrite(input({ source }))).toMatchObject({
        action: "candidate",
        isolated: true,
        requiresReview: true,
        requiresRevision: true,
      })
    }
    expect(evaluateWrite(input({ source: "imported" })).trust).toBe("untrusted-memory")
    expect(evaluateWrite(input({ source: "model" })).trust).toBe("derived")
  })

  test("rejects spoofed user labels, secrets, credentials, working state, and short-term state", () => {
    expect(evaluateWrite(input({ source: "user" })).action).toBe("reject")
    expect(evaluateWrite(input({ sensitivity: "secret" })).action).toBe("reject")
    expect(evaluateWrite(input({ credentialLike: true })).action).toBe("reject")
    expect(evaluateWrite(input({ proposedClass: "working" })).action).toBe("reject")
    expect(evaluateWrite(input({ shortTermState: true })).action).toBe("reject")
  })

  test("requires explicit authority for global or cross-workspace writes", () => {
    expect(evaluateWrite(input({ scope: "global" })).action).toBe("reject")
    expect(evaluateWrite(input({ crossWorkspace: true })).action).toBe("reject")
    expect(evaluateWrite(input({ source: "user", scope: "global", explicitUserAuthority: true }))).toMatchObject({
      action: "active",
      trust: "trusted",
    })
  })

  test("does not allow a quarantined source to bypass the policy", () => {
    for (const source of ["quarantined", "quarantined:auto", "quarantined:model"] as const) {
      expect(evaluateWrite(input({ source }))).toMatchObject({ action: "reject" })
    }
  })

  test("keeps policy schema and Candidate sensitivity aligned", () => {
    expect(MemoryCandidate.Sensitivity.literals).toEqual(MemoryPolicy.WriteInput.fields.sensitivity.literals)
    expect(Memory.Source.literals).toContain("imported")
  })
})
