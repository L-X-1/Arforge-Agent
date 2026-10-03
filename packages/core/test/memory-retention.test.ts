import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Memory } from "@arforge-ai/schema/memory"
import * as Retention from "@arforge-ai/schema/memory-retention"
import { defaultPolicy, maintenanceDeleteDecision, strengthAfterDays } from "@arforge-ai/core/memory-retention"

describe("Memory Step 5.7 retention and delete boundary", () => {
  test("keeps explicit user memory indefinite and without decay", () => {
    const policy = defaultPolicy({ source: "user", lifecycle: "active", explicitUserAuthority: true })
    expect(policy).toMatchObject({ mode: "indefinite", autoForget: false, userExplicitNoDecay: true })
    expect(strengthAfterDays({ strength: 0.8, elapsedDays: 365, policy })).toBe(0.8)
  })

  test("allows candidate/auto memory TTL and decay", () => {
    const policy = defaultPolicy({
      source: "auto",
      lifecycle: "candidate",
      explicitUserAuthority: false,
      expiresAt: DateTime.makeUnsafe(100),
    })
    expect(policy).toMatchObject({ mode: "ttl_and_decay", autoForget: true, halfLifeDays: 30 })
    expect(strengthAfterDays({ strength: 1, elapsedDays: 30, policy })).toBeCloseTo(0.5)
  })

  test("does not auto-decay an active project record without a candidate/TTL policy", () => {
    const policy = defaultPolicy({ source: "imported", lifecycle: "active", explicitUserAuthority: false })
    expect(policy).toMatchObject({ mode: "indefinite", autoForget: false })
  })

  test("requires ActionGateway maintenance authority and redaction evidence for delete", () => {
    const base = {
      memoryID: Memory.ID.make("mem_delete"),
      expectedVersion: 2,
      actionID: AgentRuntime.ActionID.make("act_delete"),
      actor: "maintenance" as const,
      maintenanceAuthority: true as const,
      explicitDestructive: true as const,
      redactionEvidenceID: AgentRuntime.EvidenceID.make("evd_redaction"),
      reason: "User requested data deletion.",
    }
    expect(maintenanceDeleteDecision({ ...base, actor: "user" })).toMatchObject({ allowed: false })
    expect(maintenanceDeleteDecision({ ...base, redactionEvidenceID: undefined })).toMatchObject({ allowed: false })
    expect(maintenanceDeleteDecision(base)).toMatchObject({
      allowed: true,
      clearsProjection: true,
      clearsRevisions: true,
      clearsRelations: true,
      updatesRetrievalIndex: true,
      recordsRedactionEvidence: true,
    })
  })

  test("exposes forget/restore/delete lifecycle as separate contracts", () => {
    expect(Retention.Lifecycle.literals).toEqual([
      "candidate",
      "active",
      "superseded",
      "quarantined",
      "forgotten",
      "rejected",
      "deleted",
    ])
    expect(Retention.ForgetRequest.fields.expectedVersion).toBeDefined()
    expect(Retention.RestoreRequest.fields.expectedVersion).toBeDefined()
    expect(Retention.MaintenanceDeleteRequest.fields.actionID).toBeDefined()
  })
})
