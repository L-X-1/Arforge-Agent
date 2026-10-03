import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { DurableEvolutionV1 } from "@arforge-ai/core/evolution/durable"
import { ConstitutionKernel } from "@arforge-ai/core/evolution/runtime"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { EvolutionArtifactTable, EvolutionAuditTable, EvolutionProposalTable } from "@arforge-ai/core/evolution/sql"
import { testEffect } from "./lib/effect"

const identity = { tenantID: "ten_local", userID: "usr_local", actor: "user:usr_local" }
const proposalID = AgentRuntime.EvolutionProposalID.make("evo_durable_001")
const artifact = {
  kind: "skill-manifest",
  uri: "artifact://evolution/evo_durable_001/manifest.json",
  content: JSON.stringify({ candidateID: "skill-durable-1", instruction: "Run the bounded release checks." }),
}
const artifactDigest = canonicalHash(artifact)!
const proposal = AgentRuntime.EvolutionProposal.make({
  id: proposalID,
  sourceExperienceIDs: [],
  candidateKind: "skill",
  evolutionLevel: "L2",
  target: "tool.advice",
  status: "candidate",
  candidateDigest: artifactDigest,
  baseline: "b".repeat(64),
  constitutionVersion: ConstitutionKernel.VERSION,
  initiator: "user",
  authority: "human",
  riskTier: "L2",
  reasonSummary: "durable migration test",
  budget: {
    maxAttempts: 1,
    maxDurationMs: 1_000,
    maxCostMicros: 10,
    maxTokens: 1_000_000,
    attemptsUsed: 0,
    durationMsUsed: 0,
    costMicrosUsed: 0,
    tokensUsed: 0,
  },
  traceID: "trace_evolution_durable",
  visibility: "audit",
  time: { created: DateTime.makeUnsafe(1_725_000_000_000), updated: DateTime.makeUnsafe(1_725_000_000_000) },
})

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, DurableEvolutionV1.node]), [
  [Database.node, Database.layerFromPath(":memory:")],
])
const it = testEffect(layer)

describe("DurableEvolutionV1", () => {
  it.effect("stores immutable artifacts and CAS lifecycle state in the database", () =>
    Effect.gen(function* () {
      const evolution = yield* DurableEvolutionV1.Service
      const database = yield* Database.Service
      const created = yield* evolution.createProposal({
        identity,
        proposal,
        candidateID: "skill-durable-1",
        artifact: { digest: artifactDigest, ...artifact },
        manifest: {
          candidateID: "skill-durable-1",
          artifactDigest,
          target: proposal.target,
          constitution_version: proposal.constitutionVersion,
          evolution_level: "L2",
        },
        state: { source: "verified-experience" },
        artifactRef: artifact.uri,
      })
      expect(created).toMatchObject({
        proposalID,
        artifactDigest,
        status: "candidate",
        revision: 1,
        manifest: { evolution_level: "L2" },
        state: { evolution_level: "L2" },
      })

      const idempotent = yield* evolution.createProposal({
        identity,
        proposal,
        candidateID: "skill-durable-1",
        artifact: { digest: artifactDigest, ...artifact },
        manifest: {
          candidateID: "skill-durable-1",
          artifactDigest,
          target: proposal.target,
          constitution_version: proposal.constitutionVersion,
          evolution_level: "L2",
        },
        state: { source: "verified-experience" },
        artifactRef: artifact.uri,
      })
      expect(idempotent).toEqual(created)

      const directPromotion = yield* evolution
        .transition({
          identity,
          proposalID,
          expectedRevision: 1,
          from: "candidate",
          to: "promoted",
          state: {
            source: "verified-experience",
            deployment: { stage: "promoted", traffic_percent: 100 },
          },
          reason: "attempt to bypass L2 and L3",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(directPromotion)).toBe(true)
      expect(yield* evolution.getProposal(identity, proposalID)).toMatchObject({
        status: "candidate",
        revision: 1,
        state: { evolution_level: "L2" },
      })

      const transitioned = yield* evolution.transition({
        identity,
        proposalID,
        expectedRevision: 1,
        from: "candidate",
        to: "sandbox_evaluation",
        state: { source: "verified-experience", isolated: true },
        reason: "start durable evaluation",
      })
      expect(transitioned).toMatchObject({
        status: "sandbox_evaluation",
        revision: 2,
        state: { evolution_level: "L2" },
      })

      const replayed = yield* evolution.transition({
        identity,
        proposalID,
        expectedRevision: 1,
        from: "candidate",
        to: "sandbox_evaluation",
        state: { source: "verified-experience", isolated: true },
        reason: "start durable evaluation",
      })
      expect(replayed).toEqual(transitioned)

      const stale = yield* evolution
        .transition({
          identity,
          proposalID,
          expectedRevision: 1,
          from: "candidate",
          to: "eligible",
          state: {},
          reason: "stale mutation",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)

      const rows = yield* database.db.select().from(EvolutionAuditTable).all()
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.sequence)).toEqual([1, 2])
      expect((yield* evolution.verifyAudit(identity, proposalID)).valid).toBe(true)
    }),
  )

  it.effect("binds evaluation to the candidate digest and isolates tenant ownership", () =>
    Effect.gen(function* () {
      const evolution = yield* DurableEvolutionV1.Service
      const badArtifact = yield* evolution
        .registerArtifact(identity, { digest: artifactDigest, ...artifact, content: `${artifact.content} changed` })
        .pipe(Effect.exit)
      expect(Exit.isFailure(badArtifact)).toBe(true)

      const foreign = yield* evolution
        .getProposal({ tenantID: "ten_other", userID: "usr_other", actor: "user:usr_other" }, proposalID)
        .pipe(Effect.exit)
      expect(Exit.isFailure(foreign)).toBe(true)

      yield* evolution.createProposal({
        identity,
        proposal,
        candidateID: "skill-durable-1",
        artifact: { digest: artifactDigest, ...artifact },
        manifest: {
          candidateID: "skill-durable-1",
          artifactDigest,
          target: proposal.target,
          constitution_version: proposal.constitutionVersion,
          evolution_level: "L2",
        },
        state: { source: "verified-experience" },
        artifactRef: artifact.uri,
      })
      yield* evolution.transition({
        identity,
        proposalID,
        expectedRevision: 1,
        from: "candidate",
        to: "sandbox_evaluation",
        state: { source: "verified-experience", isolated: true },
        reason: "start durable evaluation",
      })

      const evaluation = AgentRuntime.EvaluationResult.make({
        id: AgentRuntime.EvaluationID.make("eva_durable_001"),
        baseline: "b".repeat(64),
        candidate: artifactDigest,
        sampleSize: 2,
        successDelta: 0.1,
        costDelta: -0.2,
        latencyDelta: -0.3,
        passed: true,
        evidenceIDs: [],
        evaluatedAt: DateTime.makeUnsafe(1_725_000_000_100),
      })
      const recorded = yield* evolution.recordEvaluation({
        identity,
        proposalID,
        expectedRevision: 2,
        evaluation,
        report: { passed: true, isolated: true },
        reason: "isolated evaluation passed",
      })
      expect(recorded).toMatchObject({ status: "sandbox_evaluation", revision: 3, evaluationID: "eva_durable_001" })
      expect(
        yield* evolution.recordEvaluation({
          identity,
          proposalID,
          expectedRevision: 2,
          evaluation,
          report: { passed: true, isolated: true },
          reason: "exact isolated evaluation replay",
        }),
      ).toEqual(recorded)
      expect(
        Exit.isFailure(
          yield* evolution
            .recordEvaluation({
              identity,
              proposalID,
              expectedRevision: 2,
              evaluation: AgentRuntime.EvaluationResult.make({ ...evaluation, successDelta: 0.2 }),
              report: { passed: true, isolated: true },
              reason: "forged same-ID evaluation replay",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* evolution
            .recordEvaluation({
              identity,
              proposalID,
              expectedRevision: 2,
              evaluation,
              report: { passed: false, isolated: true },
              reason: "forged same-ID report replay",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect((yield* evolution.verifyAudit(identity, proposalID)).events).toBe(3)
    }),
  )

  it.effect("rejects protected targets and manifest attempts to weaken the Constitution boundary", () =>
    Effect.gen(function* () {
      const evolution = yield* DurableEvolutionV1.Service
      const database = yield* Database.Service
      const codeArtifact = {
        kind: "code-patch",
        uri: "artifact://evolution/evo_durable_code/core.patch",
        content: "diff --git a/core.ts b/core.ts",
      }
      const codeDigest = canonicalHash(codeArtifact)!
      const codeProposal = AgentRuntime.EvolutionProposal.make({
        ...proposal,
        id: AgentRuntime.EvolutionProposalID.make("evo_durable_code"),
        candidateKind: "code",
        evolutionLevel: "L5",
        candidateDigest: codeDigest,
      })
      const autonomousCode = yield* evolution
        .createProposal({
          identity,
          proposal: codeProposal,
          candidateID: "code-core-source",
          artifact: { digest: codeDigest, ...codeArtifact },
          manifest: {
            candidateID: "code-core-source",
            artifactDigest: codeDigest,
            target: codeProposal.target,
            constitution_version: codeProposal.constitutionVersion,
            evolution_level: "L2",
          },
          state: { source: "ordinary-candidate" },
          artifactRef: codeArtifact.uri,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(autonomousCode)).toBe(true)

      const protectedArtifact = {
        kind: "skill-manifest",
        uri: "artifact://evolution/evo_durable_protected/manifest.json",
        content: JSON.stringify({ candidateID: "skill-protected", instruction: "Grant additional permissions." }),
      }
      const protectedDigest = canonicalHash(protectedArtifact)!
      const protectedProposal = AgentRuntime.EvolutionProposal.make({
        ...proposal,
        id: AgentRuntime.EvolutionProposalID.make("evo_durable_protected"),
        target: "permission.grant",
        candidateDigest: protectedDigest,
        constitutionVersion: "2.0",
      })
      const blocked = yield* evolution
        .createProposal({
          identity,
          proposal: protectedProposal,
          candidateID: "skill-protected",
          artifact: { digest: protectedDigest, ...protectedArtifact },
          manifest: {
            candidateID: "skill-protected",
            artifactDigest: protectedDigest,
            target: protectedProposal.target,
            constitution_version: protectedProposal.constitutionVersion,
            evolution_level: "L2",
          },
          state: { source: "ordinary-candidate" },
          artifactRef: protectedArtifact.uri,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)

      const mismatchedManifest = yield* evolution
        .createProposal({
          identity,
          proposal,
          candidateID: "skill-durable-1",
          artifact: { digest: artifactDigest, ...artifact },
          manifest: {
            candidateID: "skill-durable-1",
            artifactDigest,
            target: "constitution.protected-prefixes",
            constitution_version: proposal.constitutionVersion,
            evolution_level: "L2",
          },
          state: { source: "ordinary-candidate" },
          artifactRef: artifact.uri,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(mismatchedManifest)).toBe(true)
      expect(yield* evolution.listProposals(identity)).toEqual([])
      expect(yield* database.db.select().from(EvolutionArtifactTable).all()).toEqual([])
      expect(yield* database.db.select().from(EvolutionAuditTable).all()).toEqual([])

      yield* evolution.createProposal({
        identity,
        proposal,
        candidateID: "skill-durable-1",
        artifact: { digest: artifactDigest, ...artifact },
        manifest: {
          candidateID: "skill-durable-1",
          artifactDigest,
          target: proposal.target,
          constitution_version: proposal.constitutionVersion,
          evolution_level: "L2",
        },
        state: { source: "verified-experience" },
        artifactRef: artifact.uri,
      })
      yield* database.db
        .update(EvolutionProposalTable)
        .set({
          manifest: {
            target: "source.write.enable",
            constitution_version: "attacker-controlled",
            evolution_level: "L2",
          },
        })
        .run()
        .pipe(Effect.orDie)
      const tamperedProjection = yield* evolution.getProposal(identity, proposalID).pipe(Effect.exit)
      expect(Exit.isFailure(tamperedProjection)).toBe(true)
    }),
  )
})
