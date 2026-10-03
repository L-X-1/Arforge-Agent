import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Authorizer } from "@arforge-ai/core/authorizer"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { EventV2 } from "@arforge-ai/core/event"
import { DurableEvolutionV1 } from "@arforge-ai/core/evolution/durable"
import { GovernedEvolutionV1 } from "@arforge-ai/core/evolution/governed"
import { ConstitutionKernel } from "@arforge-ai/core/evolution/runtime"
import { EvolutionProposalTable } from "@arforge-ai/core/evolution/sql"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { testEffect } from "./lib/effect"

const identity = { tenantID: "ten_governed", userID: "usr_governed", actor: "user:usr_governed" }
const artifactContent = JSON.stringify({ candidateID: "skill-governed-1", instruction: "Use the bounded test." })
const artifact = {
  kind: "skill-manifest",
  uri: "artifact://evolution/governed/manifest.json",
  content: artifactContent,
}
const artifactDigest = canonicalHash(artifact)!
const proposal = AgentRuntime.EvolutionProposal.make({
  id: AgentRuntime.EvolutionProposalID.make("evo_governed_001"),
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
  reasonSummary: "governed Evolution E2E",
  budget: {
    maxAttempts: 1,
    maxDurationMs: 60_000,
    maxCostMicros: 0,
    maxTokens: 1_000_000,
    attemptsUsed: 0,
    durationMsUsed: 0,
    costMicrosUsed: 0,
    tokensUsed: 0,
  },
  traceID: "trace_governed_e2e",
  visibility: "audit",
  time: { created: DateTime.makeUnsafe(1_725_000_000_000), updated: DateTime.makeUnsafe(1_725_000_000_000) },
})

const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const secretLayer = Layer.succeed(
  SecretProvider.Service,
  SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(13), "governed-evolution-test"),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    DurableAction.node,
    DurableRun.node,
    Authorizer.node,
    ActionGateway.node,
    ControlClaimIndex.node,
    DurableEvolutionV1.node,
    GovernedEvolutionV1.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [PermissionV2.node, permissionLayer],
    [SecretProvider.node, secretLayer],
  ],
)
const it = testEffect(layer)

const runWithApproval = <A>(
  events: EventV2.Interface,
  authorizer: Authorizer.Interface,
  action: Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<AgentRuntime.ControlRequest>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === AgentRuntime.ControlEvent.Asked.type
        ? Deferred.succeed(asked, Schema.decodeUnknownSync(AgentRuntime.ControlRequest)(event.data)).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* action.pipe(Effect.forkScoped)
    const request = yield* Effect.race(
      Deferred.await(asked),
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(Effect.fail(new Error("timed out waiting for Evolution approval"))),
      ),
    )
    yield* authorizer.reply({ requestID: request.id, reply: "once" })
    return yield* Fiber.join(fiber)
  })

describe("GovernedEvolutionV1", () => {
  it.live("routes create and transition through ControlRun, ActionGateway, DB, CAS, and idempotent replay", () =>
    Effect.gen(function* () {
      const governed = yield* GovernedEvolutionV1.Service
      const durable = yield* DurableEvolutionV1.Service
      const runs = yield* DurableRun.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const authorizer = yield* Authorizer.Service

      const createInput = {
        identity,
        requestID: "create-governed",
        traceID: "trace_governed_e2e",
        proposal,
        candidateID: "skill-governed-1",
        artifact: { digest: artifactDigest, ...artifact },
        manifest: {
          candidateID: "skill-governed-1",
          artifactDigest,
          target: proposal.target,
          constitution_version: proposal.constitutionVersion,
          evolution_level: "L2",
        },
        state: { source: "verified-experience", evolution_level: "L2" },
        artifactRef: artifact.uri,
      }
      const created = yield* runWithApproval(events, authorizer, governed.createProposal(createInput))
      expect(created).toMatchObject({ proposalID: proposal.id, status: "candidate", revision: 1 })

      const controlRuns = yield* runs.list({ limit: 20 })
      expect(controlRuns.filter((item) => "subject" in item.run)).toHaveLength(1)
      expect(controlRuns[0]?.run.status).toBe("completed")

      const repeated = yield* governed.createProposal({ ...createInput, requestID: "create-governed-retry" })
      expect(repeated).toEqual(created)

      const transitioned = yield* runWithApproval(
        events,
        authorizer,
        governed.transition({
          identity,
          requestID: "transition-governed",
          traceID: "trace_governed_transition",
          proposalID: proposal.id,
          expectedRevision: 1,
          from: "candidate",
          to: "sandbox_evaluation",
          state: { source: "verified-experience", isolated: true },
          reason: "start governed evaluation",
        }),
      )
      const evaluated = transitioned
      expect(evaluated).toMatchObject({ status: "sandbox_evaluation", revision: 2 })

      const retryTransition = yield* governed.transition({
        identity,
        requestID: "transition-governed-retry",
        traceID: "trace_governed_transition",
        proposalID: proposal.id,
        expectedRevision: 1,
        from: "candidate",
        to: "sandbox_evaluation",
        state: { source: "verified-experience", isolated: true },
        reason: "start governed evaluation",
      })
      expect(retryTransition).toEqual(evaluated)
      const afterRetryRuns = yield* runs.list({ limit: 20 })
      expect(afterRetryRuns.filter((item) => "subject" in item.run)).toHaveLength(2)

      const rows = yield* database.db.select().from(EvolutionProposalTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe("sandbox_evaluation")
      expect((yield* durable.getProposal(identity, proposal.id)).revision).toBe(2)
    }),
  )
})
