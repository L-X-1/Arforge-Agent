import { writeFileSync } from "node:fs"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { ExperienceStoreV1 } from "@arforge-ai/core/experience-store"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { Project } from "@arforge-ai/core/project"
import * as AdmissionEvidence from "@arforge-ai/core/runtime/admission-evidence"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as RuntimeEvaluation from "@arforge-ai/core/runtime/evaluation"
import * as SettlementOutbox from "@arforge-ai/core/runtime/settlement-outbox"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { DateTime, Effect, Layer } from "effect"
import { descriptorDigest, identity, phases, runIDs, type Phase } from "./admission-settlement-cross-owner-contract"

const [databasePath, phaseInput, readyMarker] = Bun.argv.slice(2)
const isPhase = (value: string | undefined): value is Phase =>
  value !== undefined && phases.some((phase) => phase === value)
if (!databasePath || !readyMarker || !isPhase(phaseInput))
  throw new Error(
    "usage: <databasePath> <before-evidence|after-evidence|after-result|after-owners-before-ack|after-outbox-commit> <readyMarker>",
  )
const phase = phaseInput

const project = Project.ID.global
const location = AbsolutePath.make("C:/cross-owner-settlement")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory: location, project: { id: project, directory: location } }),
)
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    DurableAction.node,
    DurableRun.node,
    RuntimeEvaluation.node,
    ActionGateway.node,
    LearningV2.node,
    ExperienceStoreV1.node,
    SettlementOutbox.globalNode,
  ]),
  [
    [Database.node, Database.layerFromPath(databasePath)],
    [Location.node, current],
  ],
)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 2,
  maxDurationMs: 60_000,
  maxCostMicros: 100_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const admission = (): AgentRuntime.CustomAgentAdmissionEvidence => ({
  schema_version: 1,
  kind: "custom-agent-admission",
  role: "CustomAgent.CrossOwner",
  profile_path: "profiles/cross-owner.json",
  status: "admitted",
  decision: "admitted",
  reason: "cross-owner crash fixture admission",
  ready: true,
  descriptor_digest: descriptorDigest,
  checks: {
    status_consistent: true,
    descriptor_digest_consistent: true,
    tool_projection_consistent: true,
    payload_free: true,
  },
  declared_tool_count: 1,
  canonical_tool_count: 1,
  unsupported_tool_count: 0,
  valid: true,
  violations: [],
})

const running = (runs: DurableRun.Interface, runID: AgentRuntime.RunID) =>
  Effect.gen(function* () {
    yield* runs.transition({ runID, to: "preflight", reason: "cross-owner fixture preflight" })
    yield* runs.transition({ runID, to: "queued", reason: "cross-owner fixture queued" })
    yield* runs.transition({ runID, to: "running", reason: "cross-owner fixture running" })
  })

const { parentRunID, childRunID, idempotencyKey } = runIDs(phase)

const program = Effect.gen(function* () {
  const runs = yield* DurableRun.Service
  const events = yield* EventV2.Service
  const gateway = yield* ActionGateway.Service
  const actions = yield* DurableAction.Service
  const experience = yield* ExperienceStoreV1.Service

  const parent = yield* runs.create({
    id: parentRunID,
    sessionID: SessionSchema.ID.make(`ses_cross_owner_${phase}_parent`),
    initiator: "user",
    authority: "automatic",
    riskTier: "L1",
    reasonSummary: "cross-owner settlement parent",
    budget,
    traceID: `trace-cross-owner-${phase}-parent`,
    visibility: "audit",
    project,
    location,
  })
  yield* running(runs, parent.run.id)

  const child = yield* runs.createChild({
    parentRunID: parent.run.id,
    sessionID: SessionSchema.ID.make(`ses_cross_owner_${phase}_child`),
    idempotencyKey,
    runtimeDescriptorDigest: descriptorDigest,
    runtimeAdmission: { evidence: admission(), evidenceRefs: [] },
    delegatedObjective: "exercise cross-owner settlement recovery",
    allowedCapabilities: [{ action: "shell", resources: ["fixture:cross-owner"], access: "read" }],
    project,
    location,
    expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
    initiator: "agent",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "cross-owner settlement child",
    budget,
    traceID: `trace-cross-owner-${phase}-child`,
    parentTraceID: parent.run.traceID,
    visibility: "audit",
  })
  yield* running(runs, child.run.id)

  const context = {
    sessionID: child.run.sessionID,
    assistantMessageID: SessionMessage.ID.create(),
    toolCallID: `call-cross-owner-${phase}`,
  }
  const actionID = ActionGateway.stableActionID(context)
  yield* gateway.execute(
    {
      ...context,
      actionID,
      runID: child.run.id,
      agent: AgentV2.ID.make("build"),
      name: "shell",
      resources: ["fixture:cross-owner"],
      semantics: AgentRuntime.EffectSemantics.make({
        riskTier: "L0",
        authority: "automatic",
        idempotency: "idempotent",
        retryability: "safe",
        reversibility: "not_applicable",
        filesystemScope: [],
        networkScope: [],
        secretScope: [],
        externalServices: [],
        expectedArtifacts: [],
        successCriteria: ["fixture succeeds"],
      }),
      reasonSummary: "persist cross-owner admission observation",
      inputDigest: canonicalHash({ phase })!,
    },
    { execute: () => Effect.succeed({ exitCode: 0 }) },
  )
  const action = yield* actions.load(actionID)
  if (!action.observation) throw new Error("cross-owner fixture Action has no Observation")
  yield* runs.transition({ runID: child.run.id, to: "completed", reason: "cross-owner fixture terminal status" })

  const evidencePlan = AdmissionEvidence.plan({
    identity,
    parentRunID,
    childRunID,
    idempotencyKey,
    admission: admission(),
    evidenceRefs: [],
  })
  const materialized = AdmissionEvidence.materialize({ plan: evidencePlan, actionID, observation: action.observation })
  const intentAt = yield* DateTime.now
  const resultInput = {
    status: "completed" as const,
    summary: `cross-owner crash window ${phase}`,
    artifactRefs: [] as ReadonlyArray<AgentRuntime.ArtifactID>,
    evidenceRefs: [evidencePlan.evidenceID],
    usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
  }
  const settlement = ChildSettlement.createIntent({
    parentRunID,
    childRunID,
    idempotencyKey,
    result: resultInput,
    admissionEvidence: {
      evidenceID: evidencePlan.evidenceID,
      recordDigest: materialized.recordDigest,
      actionID,
      observationID: action.observation.id,
    },
    createdAtMs: DateTime.toEpochMillis(intentAt),
  })
  const result = AgentRuntime.ChildRunResult.make({
    ...resultInput,
    resultDigest: settlement.resultDigest,
    recordedAt: intentAt,
  })
  const parentSnapshot = yield* runs.load(parentRunID)
  if (!("sessionID" in parentSnapshot.run)) throw new Error("cross-owner fixture parent is not a SessionRun")
  // The normal auto-settlement path owns the intent publication itself.  It
  // intentionally leaves an Evidence-bearing outbox in `prepared` state so
  // this phase can terminate after every durable owner is present and before
  // the metadata acknowledgement; a fresh process must finalize that row.
  if (phase !== "after-owners-before-ack" && phase !== "after-outbox-commit")
    yield* events.publish(
      AgentRuntime.Event.ChildRunSettlementIntentRecorded,
      {
        runID: parentRunID,
        sessionID: parentSnapshot.run.sessionID,
        childRunID,
        idempotencyKey,
        intentID: settlement.intentID,
        idempotencyDigest: settlement.idempotencyDigest,
        result,
        admissionEvidence: {
          evidenceID: evidencePlan.evidenceID,
          recordDigest: materialized.recordDigest,
          actionID,
          observationID: action.observation.id,
        },
        intentAt,
      },
      { expectedSequence: parentSnapshot.lastSequence },
    )

  if (phase !== "before-evidence" && phase !== "after-owners-before-ack" && phase !== "after-outbox-commit") {
    const written = yield* experience.recordAdmissionEvidence({
      identity,
      parentRunID,
      childRunID,
      idempotencyKey,
      admission: admission(),
      evidenceRefs: [],
      actionID,
    })
    if (
      String(written.evidenceID) !== String(evidencePlan.evidenceID) ||
      written.recordDigest !== materialized.recordDigest
    )
      throw new Error("cross-owner fixture Evidence receipt drifted")
  }

  if (phase === "after-owners-before-ack" || phase === "after-outbox-commit") {
    yield* Effect.provideService(
      runs.recordChildResult({
        runID: childRunID,
        admissionEvidence: {
          evidenceID: evidencePlan.evidenceID,
          recordDigest: materialized.recordDigest,
          actionID,
          observationID: action.observation.id,
        },
        result: resultInput,
      }),
      Database.CurrentPrincipal,
      { tenantID: identity.tenantID, userID: identity.userID },
    )
    const written = yield* experience.recordAdmissionEvidence({
      identity,
      parentRunID,
      childRunID,
      idempotencyKey,
      admission: admission(),
      evidenceRefs: [],
      actionID,
    })
    if (
      String(written.evidenceID) !== String(evidencePlan.evidenceID) ||
      written.recordDigest !== materialized.recordDigest
    )
      throw new Error("cross-owner acknowledgement fixture Evidence receipt drifted")
  }

  if (phase === "after-outbox-commit") {
    const intent = yield* runs.readChildSettlementIntent({ parentRunID, childRunID })
    if (!intent) throw new Error("cross-owner committed fixture settlement intent is missing")
    const plan = ChildSettlement.planSettlementCommit(intent, {
      mode: "recovery-outbox",
      atomicDatabaseTransaction: false,
      durableRecoveryOutbox: true,
    })
    const outbox = yield* SettlementOutbox.Service
    const receipt = yield* outbox.read({ identity, intentID: plan.intentID })
    if (!receipt || receipt.status !== "prepared")
      throw new Error("cross-owner committed fixture did not find its prepared receipt")
    for (const owner of plan.ownerOrder) {
      const ownerDigest =
        owner === "admission-evidence"
          ? plan.expectedDigests.evidence
          : owner === "child-result"
            ? plan.expectedDigests.childResult
            : plan.expectedDigests.parentBudget
      if (!ownerDigest) throw new Error(`cross-owner committed fixture digest is missing for ${owner}`)
      yield* outbox.promoteOwner({ identity, plan, owner, ownerDigest, observedAtMs: Date.now() })
    }
    const committed = yield* outbox.commitPromoted({ identity, plan, observedAtMs: Date.now() })
    if (committed.record.status !== "committed")
      throw new Error("cross-owner committed fixture did not commit its receipt")
  }

  if (phase === "after-result") {
    const current = yield* runs.load(childRunID)
    if (!("sessionID" in current.run)) throw new Error("cross-owner fixture child is not a SessionRun")
    yield* events.publish(
      AgentRuntime.Event.ChildRunResultRecorded,
      { runID: childRunID, parentRunID, sessionID: current.run.sessionID, result },
      { expectedSequence: current.lastSequence },
    )
  }

  writeFileSync(
    readyMarker,
    JSON.stringify({
      phase,
      parentRunID,
      childRunID,
      intentID: settlement.intentID,
      actionID,
      evidenceID: evidencePlan.evidenceID,
    }),
    "utf8",
  )
  yield* Effect.never
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
