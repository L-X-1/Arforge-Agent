import { describe, expect } from "bun:test"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import { DurableEvolutionV1 } from "@arforge-ai/core/evolution/durable"
import { EvolutionCandidateV1, EvolutionExposureV1, EvolutionV2, GovernedEvolutionV1 } from "@arforge-ai/core/evolution"
import { EvolutionExposureTable, EvolutionObservationTable } from "@arforge-ai/core/evolution/sql"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { testEffect } from "./lib/effect"
import { location } from "./fixture/location"

const identity = { tenantID: "ten_exposure", userID: "usr_exposure", actor: "system:session-runner" }
const mutationIdentity = { ...identity, actor: "user:usr_exposure" }
const currentLocation = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)

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
    EvolutionCandidateV1.node,
    EvolutionExposureV1.node,
    EvolutionV2.node,
  ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [Location.node, currentLocation],
      [PermissionV2.node, permissionLayer],
    [
      SecretProvider.node,
      Layer.succeed(SecretProvider.Service, SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(23), "exposure-test")),
    ],
  ],
)

const it = testEffect(layer)

const runWithApproval = <A, R>(
  events: EventV2.Interface,
  authorizer: Authorizer.Interface,
  action: Effect.Effect<A, unknown, R>,
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
      Effect.sleep("5 seconds").pipe(Effect.andThen(Effect.fail(new Error("timed out waiting for exposure approval")))),
    )
    yield* authorizer.reply({ requestID: request.id, reply: "once" })
    return yield* Fiber.join(fiber)
  })

describe("EvolutionExposureV1", () => {
  it.live("uses the database facade by default and keeps an empty projection fail-closed", () =>
    Effect.gen(function* () {
      const evolution = yield* EvolutionV2.Service
      expect(yield* evolution.prepare({ userInput: "hello", cohortKey: "empty" })).toMatchObject({
        text: "",
        activeCandidateIDs: [],
        injectedCandidateIDs: [],
      })
      expect(yield* evolution.status()).toMatchObject({ total: 0, active: 0 })
      expect(yield* evolution.listExposures()).toMatchObject({ total: 0, count: 0 })
      expect(yield* evolution.renderContext({ userInput: "hello", cohortKey: "empty" })).toMatchObject({
        text: "",
        candidate_ids: [],
        cohorts: {},
      })
    }),
  )

  it.live("stores ticket, receipt, and observations with digest-bound idempotent outcome recording", () =>
    Effect.gen(function* () {
      const candidates = yield* EvolutionCandidateV1.Service
      const exposures = yield* EvolutionExposureV1.Service
      const governed = yield* GovernedEvolutionV1.Service
      const evolutionFacade = yield* EvolutionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const authorizer = yield* Authorizer.Service
      const created = yield* runWithApproval(
        events,
        authorizer,
        candidates.createCandidate({
          identity: mutationIdentity,
          title: "Exposure strategy",
          target: "learning.failure",
          instruction: "Diagnose before retrying.",
          rationale: "Bounded exposure E2E",
          evidenceRefs: ["test:exposure"],
        }),
      )
      const evaluated = yield* runWithApproval(
        events,
        authorizer,
        candidates.transition({
          identity: mutationIdentity,
          candidateID: created.candidate_id,
          expectedRevision: created.state.revision,
          action: "evaluate",
          reason: "evaluate exposure fixture",
        }),
      )
      const approved = yield* runWithApproval(
        events,
        authorizer,
        candidates.transition({
          identity: mutationIdentity,
          candidateID: created.candidate_id,
          expectedRevision: evaluated.state.revision,
          action: "approve",
          reason: "approve exposure fixture",
        }),
      )
      const canary = yield* runWithApproval(
        events,
        authorizer,
        candidates.transition({
          identity: mutationIdentity,
          candidateID: created.candidate_id,
          expectedRevision: approved.state.revision,
          action: "startCanary",
          reason: "start bounded exposure fixture",
          trafficPercent: 100,
        }),
      )
      expect(canary.state).toMatchObject({ status: "canary", evolution_level: "L3" })
      expect(yield* database.runAsPrincipal(identity, evolutionFacade.status())).toMatchObject({ total: 1 })
      expect(yield* evolutionFacade.status()).toMatchObject({ total: 0 })

      const preview = yield* exposures.previewContext(identity, { userInput: "retry", cohortKey: "session-1" })
      expect(preview).toMatchObject({ candidate_ids: [created.candidate_id] })
      Schema.decodeUnknownSync(AgentCapability.EvolutionContextPreview)(preview)
      expect((yield* database.db.select().from(EvolutionExposureTable).all()).length).toBe(0)

      const source = {
        kind: "session_turn" as const,
        authority: "typescript-core" as const,
        session_id: "ses-1",
        user_message_id: "msg_user_1",
        turn_step: 1,
      }
      const prepared = yield* exposures.prepare({ identity, userInput: "retry", cohortKey: "session-1", source })
      expect(prepared.exposureID).toMatch(/^ex-[0-9a-f]{32}$/)
      expect(prepared.injectedCandidateIDs).toEqual([created.candidate_id])
      const repeatedPreparation = yield* exposures.prepare({
        identity,
        userInput: "retry",
        cohortKey: "session-1",
        source,
      })
      expect(repeatedPreparation.exposureID).toBe(prepared.exposureID)

      const first = yield* exposures.recordOutcome({
        identity,
        exposureID: prepared.exposureID!,
        success: true,
        stopReason: "completed",
        assistantMessageID: "msg_assistant_1",
      })
      expect(first).toBe(1)
      expect(
        yield* exposures.recordOutcome({
          identity,
          exposureID: prepared.exposureID!,
          success: true,
          stopReason: "completed",
          assistantMessageID: "msg_assistant_1",
        }),
      ).toBe(1)

      const listed = yield* exposures.listExposures(identity)
      expect(listed).toMatchObject({ total: 1, counts: { pending: 0, recorded: 1 } })
      expect((yield* database.db.select().from(EvolutionExposureTable).all()).length).toBe(1)
      expect((yield* database.db.select().from(EvolutionObservationTable).all()).length).toBe(1)
      expect((yield* exposures.canaryReport(identity, created.candidate_id)).candidate_observations).toBe(1)

      const archivePreview = yield* exposures.previewExposureArchive(identity, { keepRecorded: 0 })
      expect(archivePreview).toMatchObject({ eligible_count: 1, counts: { pending: 0, recorded: 1 } })
      Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchivePlan)(archivePreview)
      const archiveInput = {
        identity: { ...identity, actor: "user:archive-owner" },
        requestID: `archive-${String(archivePreview.plan_digest)}`,
        traceID: `trace-archive-${String(archivePreview.plan_digest)}`,
        keepRecorded: 0,
        expectedPlanDigest: String(archivePreview.plan_digest),
        reason: "retain immutable evidence in the artifact store",
      }
      const archived = yield* runWithApproval(events, authorizer, governed.applyExposureArchive(archiveInput))
      expect(archived).toMatchObject({ applied: true, archived_count: 1 })
      Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchiveResult)(archived)
      expect(yield* governed.applyExposureArchive(archiveInput)).toEqual(archived)
      expect((yield* exposures.listExposures(identity)).total).toBe(0)
      const archives = yield* exposures.listExposureArchives(identity)
      expect(archives).toMatchObject({ total: 1, valid_count: 1, invalid_count: 0 })
      Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchiveList)(archives)
      const archiveDetail = yield* exposures.getExposureArchive(identity, String(archived.archive_id))
      expect(archiveDetail).toMatchObject({ restore: { missing: 1, identical: 0, conflicts: 0 } })
      expect((archiveDetail.items as Array<Record<string, unknown>>)[0]?.live_status).toBe("missing")
      Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchiveDetail)(archiveDetail)

      const restorePreview = yield* exposures.previewExposureRestore(identity, String(archived.archive_id))
      expect(restorePreview).toMatchObject({ counts: { missing: 1, conflicts: 0 }, can_apply: true })
      Schema.decodeUnknownSync(AgentCapability.EvolutionExposureRestorePlan)(restorePreview)
      const restoreInput = {
        identity: { ...identity, actor: "user:archive-owner" },
        requestID: `restore-${String(restorePreview.plan_digest)}`,
        traceID: `trace-restore-${String(restorePreview.plan_digest)}`,
        archiveID: String(archived.archive_id),
        expectedPlanDigest: String(restorePreview.plan_digest),
        reason: "restore evidence for audit review",
      }
      const restored = yield* runWithApproval(events, authorizer, governed.applyExposureRestore(restoreInput))
      expect(restored).toMatchObject({ applied: true, restored_count: 1 })
      Schema.decodeUnknownSync(AgentCapability.EvolutionExposureRestoreResult)(restored)
      expect(yield* governed.applyExposureRestore(restoreInput)).toEqual(restored)
      expect((yield* exposures.listExposures(identity)).total).toBe(1)
      const restoredArchives = yield* exposures.listExposureArchives(identity)
      expect(restoredArchives).toMatchObject({
        items: [{ restore: { missing: 0, identical: 1, conflicts: 0, can_restore: false } }],
      })

      const nextGeneration = yield* exposures.previewExposureArchive(identity, { keepRecorded: 0 })
      expect(nextGeneration.plan_digest).not.toBe(archivePreview.plan_digest)
      const secondPrepared = yield* exposures.prepare({
        identity,
        userInput: "retry again",
        cohortKey: "session-2",
        source: { ...source, session_id: "ses-2", user_message_id: "msg_user_2", turn_step: 2 },
      })
      yield* exposures.recordOutcome({
        identity,
        exposureID: secondPrepared.exposureID!,
        success: true,
        stopReason: "completed",
        assistantMessageID: "msg_assistant_2",
      })
      expect(
        String(
          yield* exposures
            .applyExposureArchive({
              identity: { ...identity, actor: "user:archive-owner" },
              keepRecorded: 0,
              expectedPlanDigest: String(nextGeneration.plan_digest),
              reason: "stale plan must not apply",
            })
            .pipe(Effect.flip),
        ),
      ).toContain("preview again")

      const freshArchivePlan = yield* exposures.previewExposureArchive(identity, { keepRecorded: 0 })
      const freshArchiveInput = {
        identity: { ...identity, actor: "user:archive-owner" },
        requestID: `archive-${String(freshArchivePlan.plan_digest)}`,
        traceID: `trace-archive-${String(freshArchivePlan.plan_digest)}`,
        keepRecorded: 0,
        expectedPlanDigest: String(freshArchivePlan.plan_digest),
        reason: "archive the next durable exposure generation",
      }
      const secondArchive = yield* runWithApproval(events, authorizer, governed.applyExposureArchive(freshArchiveInput))
      expect(secondArchive).toMatchObject({ applied: true, archived_count: 2 })
      const secondRestorePlan = yield* exposures.previewExposureRestore(identity, String(archived.archive_id))
      expect(secondRestorePlan).toMatchObject({ counts: { missing: 1, conflicts: 0 } })
      expect(secondRestorePlan.plan_digest).not.toBe(restorePreview.plan_digest)
      const secondRestoreInput = {
        identity: { ...identity, actor: "user:archive-owner" },
        requestID: `restore-${String(secondRestorePlan.plan_digest)}`,
        traceID: `trace-restore-${String(secondRestorePlan.plan_digest)}`,
        archiveID: String(archived.archive_id),
        expectedPlanDigest: String(secondRestorePlan.plan_digest),
        reason: "restore the archived evidence from its next generation",
      }
      expect(
        yield* runWithApproval(events, authorizer, governed.applyExposureRestore(secondRestoreInput)),
      ).toMatchObject({ applied: true, restored_count: 1 })
      const evolutionEventTypes = (yield* database.db.select({ type: EventTable.type }).from(EventTable).all()).map(
        (row) => row.type,
      )
      expect(evolutionEventTypes).toContain("agent.evolution.exposure-archived.1")
      expect(evolutionEventTypes).toContain("agent.evolution.exposure-restored.1")

      expect((yield* exposures.verifyAudit(identity)).valid).toBe(true)
      const audit = yield* exposures.listAuditEvents(identity, { limit: 2 })
      expect(audit).toMatchObject({ valid: true, count: 2, truncated: true })
      Schema.decodeUnknownSync(AgentCapability.EvolutionAuditEventList)(audit)
      const auditPage2 = yield* exposures.listAuditEvents(identity, {
        limit: 2,
        beforeSequence: Number((audit.items as Array<Record<string, unknown>>).at(-1)?.sequence),
      })
      expect((auditPage2.items as Array<Record<string, unknown>>)[0]?.sequence).toBeLessThan(
        Number((audit.items as Array<Record<string, unknown>>).at(-1)?.sequence),
      )
      const exported = yield* exposures.exportExposureArchiveAudit(identity, String(archived.archive_id))
      expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/)
      Schema.decodeUnknownSync(AgentCapability.EvolutionExposureArchiveExport)(exported)
      expect(exported.content).not.toContain('"cohort_key"')
    }),
  )
})
