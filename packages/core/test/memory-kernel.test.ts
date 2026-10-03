import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { Location } from "@arforge-ai/core/location"
import * as MemoryKernel from "@arforge-ai/core/memory-kernel"
import { MemoryCandidateAuditTable, MemoryCandidateTable, MemoryRevisionTable } from "@arforge-ai/core/memory/sql"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Memory } from "@arforge-ai/schema/memory"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("C:/workspaces/kernel")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory, project: { id: Project.ID.global, directory } }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, MemoryKernel.node]), [[Location.node, current]]),
)

const proposal = () => ({
  content: Memory.Content.make("A user-approved durable kernel fact."),
  proposedClass: "semantic" as const,
  sourceEvidenceIDs: ["evd_kernel_source"],
  scope: "workspace" as const,
  sensitivity: "internal" as const,
  confidence: 0.95,
  dedup: { status: "novel" as const, comparedMemoryIDs: [] },
  retention: { mode: "indefinite" as const, reason: "User-approved durable memory." },
  proposer: { kind: "agent" as const },
  policy: { status: "review" as const, policyVersion: "memory-v1", reason: "Explicit user approval required." },
  reason: "Explicit durable signal",
})

describe("MemoryKernel Step 5.12 exit gate", () => {
  it.effect("keeps candidates separate, promotes with provenance, and verifies forget/delete", () =>
    Effect.gen(function* () {
      const kernel = yield* MemoryKernel.Service
      const database = yield* Database.Service
      const candidate = yield* kernel.propose(proposal())

      expect(candidate.status).toBe("proposed")
      expect(
        yield* Effect.flip(
          kernel.promote({
            candidateID: candidate.candidateID,
            actor: { kind: "user" },
            policyVersion: "memory-v1",
            evidenceIDs: ["evd_kernel_approval"],
          }),
        ),
      ).toMatchObject({
        _tag: "MemoryKernel.GateError",
      })

      yield* kernel.approve({ candidateID: candidate.candidateID, actor: { kind: "user" }, policyVersion: "memory-v1" })
      expect(
        yield* Effect.flip(
          kernel.promote({
            candidateID: candidate.candidateID,
            actor: { kind: "agent" },
            policyVersion: "memory-v1",
            evidenceIDs: ["evd_kernel_agent"],
          }),
        ),
      ).toMatchObject({ _tag: "MemoryKernel.GateError" })
      expect(
        yield* Effect.flip(
          kernel.promote({
            candidateID: candidate.candidateID,
            actor: { kind: "user" },
            policyVersion: "memory-v1",
            evidenceIDs: ["evd_kernel_model_source"],
            source: "model",
          }),
        ),
      ).toMatchObject({ _tag: "MemoryKernel.GateError" })
      const promoted = yield* kernel.promote({
        candidateID: candidate.candidateID,
        actor: { kind: "user" },
        policyVersion: "memory-v1",
        evidenceIDs: ["evd_kernel_approval"],
      })
      const active = yield* kernel.read(promoted.id)
      expect(active).toMatchObject({
        lifecycle: "active",
        version: 1,
        provenanceStatus: "verified",
        scope: "workspace",
      })

      const promotedCandidate = yield* database.db
        .select({ status: MemoryCandidateTable.status })
        .from(MemoryCandidateTable)
        .where(eq(MemoryCandidateTable.id, candidate.candidateID))
        .get()
        .pipe(Effect.orDie)
      const revision = yield* database.db
        .select({
          operation: MemoryRevisionTable.operation,
          version: MemoryRevisionTable.version,
          policy: MemoryRevisionTable.policy_version,
        })
        .from(MemoryRevisionTable)
        .where(eq(MemoryRevisionTable.memory_id, promoted.id))
        .get()
        .pipe(Effect.orDie)
      expect(promotedCandidate?.status).toBe("promoted")
      expect(revision).toEqual({ operation: "activate", version: 1, policy: "memory-v1" })

      const secret = yield* kernel.propose({
        ...proposal(),
        content: Memory.Content.make("secret candidate"),
        sensitivity: "secret",
      })
      expect(
        yield* Effect.flip(
          kernel.approve({ candidateID: secret.candidateID, actor: { kind: "user" }, policyVersion: "memory-v1" }),
        ),
      ).toMatchObject({ _tag: "MemoryKernel.GateError" })

      const forgotten = yield* kernel.forget({
        memoryID: promoted.id,
        expectedVersion: 1,
        actor: "user",
        reason: "User requested forget.",
        policyVersion: "memory-v1",
        evidenceIDs: ["evd_kernel_forget"],
      })
      expect(forgotten).toMatchObject({ lifecycle: "forgotten", version: 2 })

      const deniedDelete = yield* Effect.flip(
        kernel.maintenanceDelete({
          memoryID: promoted.id,
          expectedVersion: 999,
          actor: "maintenance",
          maintenanceAuthority: true,
          explicitDestructive: true,
          actionID: AgentRuntime.ActionID.make("act_kernel_delete"),
          redactionEvidenceID: AgentRuntime.EvidenceID.make("evd_kernel_redaction"),
          reason: "stale version",
          policyVersion: "memory-v1",
        }),
      )
      expect(deniedDelete).toMatchObject({ _tag: "MemoryKernel.GateError" })

      expect(
        yield* kernel.maintenanceDelete({
          memoryID: promoted.id,
          expectedVersion: 2,
          actor: "maintenance",
          maintenanceAuthority: true,
          explicitDestructive: true,
          actionID: AgentRuntime.ActionID.make("act_kernel_delete"),
          redactionEvidenceID: AgentRuntime.EvidenceID.make("evd_kernel_redaction"),
          reason: "Authorized redaction.",
          policyVersion: "memory-v1",
        }),
      ).toEqual({ deleted: true })
      expect(yield* database.db.get(sql`SELECT id FROM memory WHERE id = ${promoted.id}`)).toBeUndefined()
      expect(
        yield* database.db.get(sql`SELECT id FROM memory_revision WHERE memory_id = ${promoted.id}`),
      ).toBeUndefined()
    }),
  )

  it.effect("reviews candidates with owner isolation, CAS transitions, fail-closed policy, and immutable audit", () =>
    Effect.gen(function* () {
      const kernel = yield* MemoryKernel.Service
      const database = yield* Database.Service
      const candidate = yield* kernel.propose(proposal())
      const initial = yield* kernel.reviewCandidate(candidate.candidateID)
      expect(initial.candidate.content).toBe("A user-approved durable kernel fact.")
      expect(initial.audit.map((entry) => entry.operation)).toEqual(["proposed"])

      const expectedUpdatedAt = DateTime.toEpochMillis(initial.candidate.time.updated)
      const approved = yield* kernel.approve({
        candidateID: candidate.candidateID,
        actor: { kind: "user" },
        policyVersion: "memory-v1",
        expectedUpdatedAt,
        reason: "Confirmed against project evidence.",
      })
      expect(approved.status).toBe("approved")
      expect(approved.policy.status).toBe("allow")

      const stale = yield* Effect.flip(
        kernel.reject({
          candidateID: candidate.candidateID,
          actor: { kind: "user" },
          policyVersion: "memory-v1",
          expectedUpdatedAt,
          reason: "This stale decision must not apply.",
        }),
      )
      expect(stale).toMatchObject({ _tag: "MemoryKernel.GateError" })

      const activated = yield* kernel.promote({
        candidateID: candidate.candidateID,
        actor: { kind: "user" },
        policyVersion: "memory-v1",
        expectedUpdatedAt: DateTime.toEpochMillis(approved.time.updated),
        evidenceIDs: ["evd_kernel_approval"],
        reason: "Activate the verified durable fact.",
      })
      expect(activated.scope).toBe("workspace")
      const finalReview = yield* kernel.reviewCandidate(candidate.candidateID)
      expect(finalReview.audit.map((entry) => entry.operation)).toEqual(["proposed", "approved", "activated"])

      const rejectedCandidate = yield* kernel.propose({
        ...proposal(),
        content: Memory.Content.make("Reject this unsupported claim."),
      })
      const rejected = yield* kernel.reject({
        candidateID: rejectedCandidate.candidateID,
        actor: { kind: "user" },
        policyVersion: "memory-v1",
        expectedUpdatedAt: DateTime.toEpochMillis(rejectedCandidate.time.updated),
        reason: "The cited evidence does not support this claim.",
      })
      expect(rejected.status).toBe("rejected")

      const credential = yield* kernel.propose({
        ...proposal(),
        content: Memory.Content.make("api_key=TEST_ONLY_NOT_A_REAL_KEY_1234567890"),
      })
      expect(credential.sensitivity).toBe("secret")
      expect(credential.content).not.toContain("TEST_ONLY_NOT_A_REAL_KEY_1234567890")
      expect(
        yield* Effect.flip(
          kernel.approve({
            candidateID: credential.candidateID,
            actor: { kind: "user" },
            policyVersion: "memory-v1",
          }),
        ),
      ).toMatchObject({ _tag: "MemoryKernel.GateError" })

      const hidden = yield* database.runAsPrincipal(
        { tenantID: "ten_other", userID: "usr_other" },
        Effect.flip(kernel.reviewCandidate(candidate.candidateID)),
      )
      expect(hidden).toMatchObject({ _tag: "MemoryKernel.GateError" })

      const audits = yield* database.db.select().from(MemoryCandidateAuditTable).all().pipe(Effect.orDie)
      expect(audits.map((entry) => entry.operation)).toContain("rejected")
    }),
  )
})
