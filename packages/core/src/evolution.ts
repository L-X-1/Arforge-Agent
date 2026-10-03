export * as EvolutionV2 from "./evolution"
export * as GovernedEvolutionV1 from "./evolution/governed"
export * as EvolutionCandidateV1 from "./evolution/candidate"
export * as EvolutionExposureV1 from "./evolution/exposure"
export * as EvolutionLevelV1 from "./evolution/level"
export * as EvolutionPromotionGateV1 from "./evolution/promotion-gate"

import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { makeLocationNode } from "./effect/app-node"
import { Database } from "./database/database"
import { NonNegativeInt } from "./schema"
import * as EvolutionCandidateV1 from "./evolution/candidate"
import * as EvolutionExposureV1 from "./evolution/exposure"
import type { CanaryGateReport } from "./evolution/promotion-gate"
import {
  EvolutionRuntime,
  EvolutionStateError,
  type CandidateView,
  type EvaluationCase,
  type ExposureSource,
  type LearningPatternInput,
} from "./evolution/runtime"

const LearningSyncResult = Schema.Struct({
  schema_version: Schema.Literal(1),
  seen: NonNegativeInt,
  created: NonNegativeInt,
  existing: NonNegativeInt,
  skipped: NonNegativeInt,
  failed: NonNegativeInt,
  items: Schema.Array(
    Schema.Struct({
      source_ref: Schema.String,
      status: Schema.Literals(["created", "existing", "skipped", "failed"]),
      candidate_id: Schema.String,
      reason: Schema.String,
      evaluation: Schema.optional(
        Schema.Struct({
          status: Schema.Literals(["evaluated", "already_evaluated", "evaluate_failed"]),
          gate_passed: Schema.optional(Schema.Boolean),
          reason: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
})
export type LearningSyncResult = typeof LearningSyncResult.Type

export interface LearningPatternEvidence {
  readonly id: string
  readonly type: string
  readonly description: string
  readonly frequency: number
  readonly confidence: number
}

export interface PreparedContext {
  readonly text: string
  /** All active experiments, including control cohorts that inject no advice. */
  readonly activeCandidateIDs: ReadonlyArray<string>
  /** Candidate IDs whose bounded advice was actually injected for this cohort. */
  readonly injectedCandidateIDs: ReadonlyArray<string>
  /** Opaque immutable assignment ticket for exact terminal-result attribution. */
  readonly exposureID?: string
}

export const emptyContext: PreparedContext = {
  text: "",
  activeCandidateIDs: [],
  injectedCandidateIDs: [],
}

export interface Interface {
  // --- agent-loop surface (native) ---
  readonly prepare: (input: {
    readonly userInput: string
    readonly cohortKey: string
    readonly source?: {
      readonly sessionID: string
      readonly userMessageID: string
      readonly turnStep: number
    }
  }) => Effect.Effect<PreparedContext, unknown>
  readonly recordOutcome: (input: {
    readonly exposureID: string
    readonly success: boolean
    readonly stopReason?: string
    readonly safetyIncident?: boolean
    readonly assistantMessageID?: string
  }) => Effect.Effect<number, unknown>
  readonly syncLearningPatterns: (
    patterns: ReadonlyArray<LearningPatternEvidence>,
  ) => Effect.Effect<LearningSyncResult, unknown>

  // --- capability API surface (native) ---
  readonly status: () => Effect.Effect<Record<string, unknown>, unknown>
  readonly listCandidates: (input?: {
    readonly status?: string
    readonly limit?: number
  }) => Effect.Effect<Record<string, unknown>, unknown>
  readonly getCandidate: (candidateId: string) => Effect.Effect<CandidateView, unknown>
  readonly createCandidate: (input: {
    title: string
    target: string
    instruction: string
    rationale: string
    evidenceRefs: string[]
    createdBy: string
  }) => Effect.Effect<CandidateView, unknown>
  readonly proposeLearningPattern: (
    patternId: string,
    pattern?: LearningPatternEvidence,
  ) => Effect.Effect<CandidateView, unknown>
  readonly listOpportunities: (input: {
    readonly limit?: number
    readonly evidence?: ReadonlyArray<LearningPatternEvidence>
  }) => Effect.Effect<Record<string, unknown>, unknown>
  readonly evaluateCandidate: (candidateId: string, expectedRevision: number) => Effect.Effect<CandidateView, unknown>
  readonly approveCandidate: (input: {
    candidateId: string
    expectedRevision: number
    actor: string
    reason: string
  }) => Effect.Effect<CandidateView, unknown>
  readonly rejectCandidate: (input: {
    candidateId: string
    expectedRevision: number
    actor: string
    reason: string
  }) => Effect.Effect<CandidateView, unknown>
  readonly startCanary: (input: {
    candidateId: string
    expectedRevision: number
    actor: string
    reason: string
    trafficPercent?: number
  }) => Effect.Effect<CandidateView, unknown>
  readonly promoteCandidate: (input: {
    candidateId: string
    expectedRevision: number
    actor: string
    reason: string
  }) => Effect.Effect<CandidateView, unknown>
  readonly rollbackCandidate: (input: {
    candidateId: string
    expectedRevision: number
    actor: string
    reason: string
  }) => Effect.Effect<CandidateView, unknown>
  readonly canaryReport: (candidateId: string) => Effect.Effect<CanaryGateReport, unknown>
  readonly listExposures: (input?: {
    readonly status?: string
    readonly limit?: number
  }) => Effect.Effect<Record<string, unknown>, unknown>
  readonly previewExposureArchive: (input?: {
    readonly keepRecorded?: number
  }) => Effect.Effect<Record<string, unknown>, unknown>
  readonly applyExposureArchive: (input: {
    keepRecorded?: number
    expectedPlanDigest: string
    actor: string
    reason: string
  }) => Effect.Effect<Record<string, unknown>, unknown>
  readonly listExposureArchives: (input?: {
    readonly limit?: number
  }) => Effect.Effect<Record<string, unknown>, unknown>
  readonly getExposureArchive: (
    archiveId: string,
    input?: { readonly limit?: number },
  ) => Effect.Effect<Record<string, unknown>, unknown>
  readonly previewExposureRestore: (archiveId: string) => Effect.Effect<Record<string, unknown>, unknown>
  readonly applyExposureRestore: (input: {
    archiveId: string
    expectedPlanDigest: string
    actor: string
    reason: string
  }) => Effect.Effect<Record<string, unknown>, unknown>
  readonly exportExposureArchiveAudit: (archiveId: string) => Effect.Effect<Record<string, unknown>, unknown>
  readonly verifyAudit: () => Effect.Effect<Record<string, unknown>, unknown>
  readonly listAuditEvents: (input?: {
    readonly limit?: number
    readonly beforeSequence?: number
  }) => Effect.Effect<Record<string, unknown>, unknown>
  readonly renderContext: (input: {
    userInput: string
    cohortKey: string
  }) => Effect.Effect<Record<string, unknown>, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Evolution") {}

export interface EvolutionLayerOptions {
  readonly root?: string
  /** Explicitly enables the retired filesystem writer for isolated compatibility tests only. */
  readonly legacyWriteMode?: "test-only"
}

const trySync = <T>(run: () => T): Effect.Effect<T, unknown> =>
  Effect.try({
    try: run,
    catch: (error) => error,
  })

export function legacyLayer(options: EvolutionLayerOptions = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const allowLegacyWrites = options.legacyWriteMode === "test-only"
      const runtime = new EvolutionRuntime({
        root: options.root,
        ...(allowLegacyWrites ? { legacyWriteMode: "test-only" as const } : {}),
      })
      const legacyWrite = <A>(operation: string, run: () => A) =>
        allowLegacyWrites
          ? trySync(run)
          : Effect.fail(
              new EvolutionStateError(
                `Legacy filesystem Evolution operation ${operation} is read-only; use the durable DB service`,
              ),
            )
      const toLearningPattern = (pattern: LearningPatternEvidence): LearningPatternInput => ({
        id: String(pattern.id ?? "").slice(0, 160),
        type: String(pattern.type ?? "").slice(0, 64),
        description: String(pattern.description ?? "").slice(0, 500),
        frequency: Math.trunc(Number(pattern.frequency) || 0),
        confidence: Number(pattern.confidence) || 0,
      })
      const toExposureSource = (source: {
        readonly sessionID: string
        readonly userMessageID: string
        readonly turnStep: number
      }): ExposureSource => ({
        kind: "session_turn",
        authority: "typescript-core",
        session_id: String(source.sessionID).slice(0, 160),
        user_message_id: String(source.userMessageID).slice(0, 160),
        turn_step: Math.max(1, Math.min(10_000, Math.trunc(source.turnStep))),
      })

      return Service.of({
        prepare: Effect.fn("Evolution.prepare")(function* (input) {
          if (!allowLegacyWrites) {
            const rendered = yield* trySync(() =>
              runtime.renderContext(String(input.userInput).slice(0, 20_000), String(input.cohortKey).slice(0, 500)),
            )
            return {
              text: rendered.text,
              activeCandidateIDs: Object.keys(rendered.cohorts),
              injectedCandidateIDs: rendered.candidate_ids,
            }
          }
          const rendered = yield* trySync(() =>
            runtime.prepareContext({
              userInput: String(input.userInput).slice(0, 20_000),
              cohortKey: String(input.cohortKey).slice(0, 500),
              source: input.source ? toExposureSource(input.source) : undefined,
            }),
          )
          return {
            text: rendered.text,
            activeCandidateIDs: Object.keys(rendered.cohorts),
            injectedCandidateIDs: rendered.candidate_ids,
            ...(rendered.exposure_id.length > 0 ? { exposureID: rendered.exposure_id } : {}),
          }
        }),
        recordOutcome: Effect.fn("Evolution.recordOutcome")(function* (input) {
          const result = yield* legacyWrite("recordOutcome", () =>
            runtime.recordExposureOutcome({
              exposureId: String(input.exposureID).slice(0, 35),
              success: input.success,
              stopReason: String(input.stopReason ?? "").slice(0, 1_000),
              safetyIncident: input.safetyIncident ?? false,
              ...(input.assistantMessageID
                ? { assistantMessageId: String(input.assistantMessageID).slice(0, 160) }
                : {}),
            }),
          )
          return result.count
        }),
        syncLearningPatterns: Effect.fn("Evolution.syncLearningPatterns")(function* (patterns) {
          const raw = yield* legacyWrite("syncLearningPatterns", () =>
            runtime.syncLearningPatterns(patterns.slice(0, 50).map(toLearningPattern)),
          )
          return yield* Schema.decodeUnknownEffect(LearningSyncResult)(raw)
        }),
        status: Effect.fn("Evolution.status")(() => trySync(() => runtime.status())),
        listCandidates: Effect.fn("Evolution.listCandidates")((input = {}) =>
          trySync(() => runtime.listCandidates({ status: input.status, limit: input.limit })),
        ),
        getCandidate: Effect.fn("Evolution.getCandidate")((candidateId) =>
          trySync(() => runtime.getCandidate(candidateId)),
        ),
        createCandidate: Effect.fn("Evolution.createCandidate")((input) =>
          legacyWrite("createCandidate", () => {
            const created = runtime.createCandidate(input)
            return { ...created.manifest, state: created.state } as unknown as CandidateView
          }),
        ),
        proposeLearningPattern: Effect.fn("Evolution.proposeLearningPattern")(function* (patternId, pattern) {
          return yield* legacyWrite("proposeLearningPattern", () => {
            const evidenceRef = `learning-pattern:${String(patternId).slice(0, 160)}`
            const existing = runtime.candidateForEvidence(evidenceRef)
            if (existing !== null) return existing
            if (pattern === undefined) {
              throw new EvolutionStateError(`learning pattern not found: ${patternId}`)
            }
            const target = patternTargetFor(pattern.type)
            if (target === null) {
              throw new EvolutionStateError(`learning pattern type is not deployable: ${pattern.type}`)
            }
            const description = String(pattern.description ?? "").slice(0, 500)
            const created = runtime.createCandidate({
              title: `Governed ${pattern.type} strategy from learning pattern ${patternId}`,
              target,
              instruction:
                String(pattern.type).toLowerCase() === "failure"
                  ? `When this failure pattern recurs, diagnose the underlying cause before retrying. Observed pattern: ${description}`
                  : description,
              rationale: `Existing learning evidence: frequency=${Math.trunc(Number(pattern.frequency) || 0)}, confidence=${(Number(pattern.confidence) || 0).toFixed(2)}. Activation remains subject to isolated evaluation and human approval.`,
              evidenceRefs: [evidenceRef],
              createdBy: "user:product",
            })
            return { ...created.manifest, state: created.state } as unknown as CandidateView
          })
        }),
        listOpportunities: Effect.fn("Evolution.listOpportunities")((input) =>
          trySync(() => mineOpportunities(runtime, input.evidence ?? [], input.limit ?? 50)),
        ),
        evaluateCandidate: Effect.fn("Evolution.evaluateCandidate")((candidateId, expectedRevision) =>
          legacyWrite("evaluateCandidate", () => runtime.evaluateCandidate(candidateId, expectedRevision)),
        ),
        approveCandidate: Effect.fn("Evolution.approveCandidate")((input) =>
          legacyWrite("approveCandidate", () =>
            runtime.approveCandidate(input.candidateId, input.expectedRevision, input.actor, input.reason),
          ),
        ),
        rejectCandidate: Effect.fn("Evolution.rejectCandidate")((input) =>
          legacyWrite("rejectCandidate", () =>
            runtime.rejectCandidate(input.candidateId, input.expectedRevision, input.actor, input.reason),
          ),
        ),
        startCanary: Effect.fn("Evolution.startCanary")((input) =>
          legacyWrite("startCanary", () =>
            runtime.startCanary(
              input.candidateId,
              input.expectedRevision,
              input.actor,
              input.reason,
              input.trafficPercent,
            ),
          ),
        ),
        promoteCandidate: Effect.fn("Evolution.promoteCandidate")((input) =>
          legacyWrite("promoteCandidate", () =>
            runtime.promoteCandidate(input.candidateId, input.expectedRevision, input.actor, input.reason),
          ),
        ),
        rollbackCandidate: Effect.fn("Evolution.rollbackCandidate")((input) =>
          legacyWrite("rollbackCandidate", () =>
            runtime.rollbackCandidate(input.candidateId, input.expectedRevision, input.actor, input.reason),
          ),
        ),
        canaryReport: Effect.fn("Evolution.canaryReport")((candidateId) =>
          trySync(() => runtime.canaryReport(candidateId)),
        ),
        listExposures: Effect.fn("Evolution.listExposures")((input = {}) =>
          trySync(() => runtime.listExposures({ status: input.status, limit: input.limit })),
        ),
        previewExposureArchive: Effect.fn("Evolution.previewExposureArchive")((input = {}) =>
          trySync(() => runtime.previewExposureArchive({ keepRecorded: input.keepRecorded })),
        ),
        applyExposureArchive: Effect.fn("Evolution.applyExposureArchive")((input) =>
          legacyWrite("applyExposureArchive", () =>
            runtime.applyExposureArchive({
              keepRecorded: input.keepRecorded,
              expectedPlanDigest: input.expectedPlanDigest,
              actor: input.actor,
              reason: input.reason,
            }),
          ),
        ),
        listExposureArchives: Effect.fn("Evolution.listExposureArchives")((input = {}) =>
          trySync(() => runtime.listExposureArchives({ limit: input.limit })),
        ),
        getExposureArchive: Effect.fn("Evolution.getExposureArchive")((archiveId, input = {}) =>
          trySync(() => runtime.getExposureArchive(archiveId, { limit: input.limit })),
        ),
        previewExposureRestore: Effect.fn("Evolution.previewExposureRestore")((archiveId) =>
          trySync(() => runtime.previewExposureRestore(archiveId)),
        ),
        applyExposureRestore: Effect.fn("Evolution.applyExposureRestore")((input) =>
          legacyWrite("applyExposureRestore", () =>
            runtime.applyExposureRestore({
              archiveId: input.archiveId,
              expectedPlanDigest: input.expectedPlanDigest,
              actor: input.actor,
              reason: input.reason,
            }),
          ),
        ),
        exportExposureArchiveAudit: Effect.fn("Evolution.exportExposureArchiveAudit")((archiveId) =>
          trySync(() => runtime.exportExposureArchiveAudit(archiveId)),
        ),
        verifyAudit: Effect.fn("Evolution.verifyAudit")(() => trySync(() => runtime.verifyAudit())),
        listAuditEvents: Effect.fn("Evolution.listAuditEvents")((input = {}) =>
          trySync(() => runtime.listAuditEvents({ limit: input.limit, beforeSequence: input.beforeSequence })),
        ),
        renderContext: Effect.fn("Evolution.renderContext")((input) =>
          trySync(() => runtime.renderContext(input.userInput, input.cohortKey)),
        ),
      })
    }),
  )
}

const localIdentity = {
  tenantID: "ten_local",
  userID: "usr_local",
  actor: "system:session-runner",
} as const

const durableUnavailable = (operation: string) =>
  Effect.fail(new EvolutionStateError(`Evolution operation ${operation} is not available in the DB facade yet`))

const withRuntimeIdentity = <A, E, R>(
  actor: string,
  run: (identity: { tenantID: string; userID: string; actor: string }) => Effect.Effect<A, E, R>,
) =>
  Database.CurrentPrincipal.pipe(
    Effect.flatMap((principal) =>
      run({
        tenantID: principal?.tenantID ?? localIdentity.tenantID,
        userID: principal?.userID ?? localIdentity.userID,
        actor,
      }),
    ),
  )

/**
 * Production facade. The old synchronous runtime remains available only via
 * an explicit root for tests and migration compatibility; the default layer
 * uses database projections for the agent-loop read/write surface.
 */
export function layer(options: EvolutionLayerOptions = {}) {
  if (options.root !== undefined) return legacyLayer(options)
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const candidates = yield* EvolutionCandidateV1.Service
      const exposures = yield* EvolutionExposureV1.Service
      return Service.of({
        prepare: (input) =>
          withRuntimeIdentity("system:session-runner", (identity) =>
            exposures.prepare({
              identity,
              userInput: String(input.userInput).slice(0, 20_000),
              cohortKey: String(input.cohortKey).slice(0, 500),
              ...(input.source
                ? {
                    source: {
                      kind: "session_turn" as const,
                      authority: "typescript-core" as const,
                      session_id: String(input.source.sessionID).slice(0, 160),
                      user_message_id: String(input.source.userMessageID).slice(0, 160),
                      turn_step: Math.max(1, Math.min(10_000, Math.trunc(input.source.turnStep))),
                    },
                  }
                : {}),
            }),
          ).pipe(
            Effect.map((prepared) => ({
              text: prepared.text,
              activeCandidateIDs: prepared.activeCandidateIDs,
              injectedCandidateIDs: prepared.injectedCandidateIDs,
              ...(prepared.exposureID ? { exposureID: prepared.exposureID } : {}),
            })),
          ),
        recordOutcome: (input) =>
          withRuntimeIdentity("system:session-runner", (identity) =>
            candidates.recordOutcome({
              identity,
              exposureID: input.exposureID,
              success: input.success,
              stopReason: input.stopReason,
              safetyIncident: input.safetyIncident,
              assistantMessageID: input.assistantMessageID,
            }),
          ),
        syncLearningPatterns: (patterns) =>
          withRuntimeIdentity("system:core-learning", (identity) =>
            candidates.syncLearningPatterns(identity, patterns.slice(0, 51)),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(LearningSyncResult))),
        status: () => withRuntimeIdentity("system:evolution-reader", (identity) => candidates.status(identity)),
        listCandidates: (input = {}) =>
          withRuntimeIdentity("system:evolution-reader", (identity) => candidates.listCandidates(identity, input)),
        getCandidate: (candidateId) =>
          withRuntimeIdentity("system:evolution-reader", (identity) => candidates.getCandidate(identity, candidateId)),
        createCandidate: () => durableUnavailable("createCandidate"),
        proposeLearningPattern: () => durableUnavailable("proposeLearningPattern"),
        listOpportunities: (input) =>
          Effect.succeed(mineOpportunitiesFromEvidence(input.evidence ?? [], input.limit ?? 50)),
        evaluateCandidate: () => durableUnavailable("evaluateCandidate"),
        approveCandidate: () => durableUnavailable("approveCandidate"),
        rejectCandidate: () => durableUnavailable("rejectCandidate"),
        startCanary: () => durableUnavailable("startCanary"),
        promoteCandidate: () => durableUnavailable("promoteCandidate"),
        rollbackCandidate: () => durableUnavailable("rollbackCandidate"),
        canaryReport: (candidateId) =>
          withRuntimeIdentity("system:evolution-reader", (identity) => exposures.canaryReport(identity, candidateId)),
        listExposures: (input = {}) =>
          withRuntimeIdentity("system:evolution-reader", (identity) => exposures.listExposures(identity, input)),
        previewExposureArchive: (input = {}) =>
          withRuntimeIdentity("system:evolution-reader", (identity) =>
            exposures.previewExposureArchive(identity, input),
          ),
        applyExposureArchive: () => durableUnavailable("applyExposureArchive"),
        listExposureArchives: (input = {}) =>
          withRuntimeIdentity("system:evolution-reader", (identity) => exposures.listExposureArchives(identity, input)),
        getExposureArchive: (archiveId, input = {}) =>
          withRuntimeIdentity("system:evolution-reader", (identity) =>
            exposures.getExposureArchive(identity, archiveId, input),
          ),
        previewExposureRestore: (archiveId) =>
          withRuntimeIdentity("system:evolution-reader", (identity) =>
            exposures.previewExposureRestore(identity, archiveId),
          ),
        applyExposureRestore: () => durableUnavailable("applyExposureRestore"),
        exportExposureArchiveAudit: (archiveId) =>
          withRuntimeIdentity("system:evolution-reader", (identity) =>
            exposures.exportExposureArchiveAudit(identity, archiveId),
          ),
        verifyAudit: () =>
          withRuntimeIdentity("system:evolution-reader", (identity) => exposures.verifyAudit(identity)),
        listAuditEvents: (input = {}) =>
          withRuntimeIdentity("system:evolution-reader", (identity) => exposures.listAuditEvents(identity, input)),
        renderContext: (input) =>
          withRuntimeIdentity("system:evolution-reader", (identity) => exposures.previewContext(identity, input)),
      })
    }),
  )
}

export const locationLayer = layer()

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [EvolutionCandidateV1.node, EvolutionExposureV1.node],
})

export const cohortKeyForSession = (sessionID: string) =>
  createHash("sha256").update(`arforge-evolution-session-cohort-v1\0${sessionID}`).digest("hex")

/**
 * Native port of ``mine_opportunities``: learning-pattern evidence (Core
 * Learning) that reached the proposal threshold, grouped deterministically.
 * The legacy Python LearningPattern table and dogfood outcome files are
 * retired with the sidecar.
 */
function mineOpportunities(
  runtime: EvolutionRuntime,
  evidence: ReadonlyArray<LearningPatternEvidence>,
  limit: number,
): Record<string, unknown> {
  if (limit < 1 || limit > 200) throw new Error("limit must be between 1 and 200")
  const items: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const pattern of evidence) {
    const sourceRef = `learning-pattern:${String(pattern.id ?? "").slice(0, 160)}`
    if (seen.has(sourceRef)) continue
    seen.add(sourceRef)
    items.push({
      kind: "learning_pattern",
      source_ref: sourceRef,
      category: String(pattern.type ?? "unknown").slice(0, 64),
      frequency: Math.trunc(Number(pattern.frequency) || 0),
      confidence: Math.round((Number(pattern.confidence) || 0) * 10_000) / 10_000,
      proposal_available: patternTargetFor(pattern.type) !== null,
    })
  }
  items.sort((left, right) => {
    const leftFrequency = Number(left.frequency ?? left.count ?? 0)
    const rightFrequency = Number(right.frequency ?? right.count ?? 0)
    if (leftFrequency !== rightFrequency) return rightFrequency - leftFrequency
    return String(left.source_ref).localeCompare(String(right.source_ref))
  })
  return { schema_version: 1, count: Math.min(items.length, limit), items: items.slice(0, limit) }
}

function patternTargetFor(patternType: unknown): string | null {
  const map: Record<string, string> = {
    failure: "learning.failure",
    fix: "learning.fix",
    preference: "learning.preference",
    convention: "learning.preference",
    constraint: "routing.advice",
    workflow: "tool.advice",
  }
  return map[String(patternType ?? "").toLowerCase()] ?? null
}

export type { EvaluationCase }

function mineOpportunitiesFromEvidence(
  evidence: ReadonlyArray<LearningPatternEvidence>,
  limit: number,
): Record<string, unknown> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new EvolutionStateError("limit must be between 1 and 200")
  const items: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const pattern of evidence) {
    const sourceRef = `learning-pattern:${String(pattern.id ?? "").slice(0, 160)}`
    if (seen.has(sourceRef)) continue
    seen.add(sourceRef)
    items.push({
      kind: "learning_pattern",
      source_ref: sourceRef,
      category: String(pattern.type ?? "unknown").slice(0, 64),
      frequency: Math.trunc(Number(pattern.frequency) || 0),
      confidence: Math.round((Number(pattern.confidence) || 0) * 10_000) / 10_000,
      proposal_available: patternTargetFor(pattern.type) !== null,
    })
  }
  items.sort(
    (left, right) =>
      Number(right.frequency ?? 0) - Number(left.frequency ?? 0) ||
      String(left.source_ref).localeCompare(String(right.source_ref)),
  )
  return { schema_version: 1, count: Math.min(items.length, limit), items: items.slice(0, limit) }
}
