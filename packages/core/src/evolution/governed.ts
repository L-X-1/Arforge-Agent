export * as GovernedEvolutionV1 from "./governed"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Project } from "@arforge-ai/schema/project"
import { Context, Effect, Layer, Schema } from "effect"
import * as ActionGateway from "../action-gateway"
import { makeLocationNode } from "../effect/app-node"
import * as ControlClaimIndex from "../runtime/control-claim-index"
import { ControlPrincipal } from "../runtime/control-principal"
import { DurableRun } from "../runtime/durable-run"
import { AbsolutePath } from "../schema"
import { canonicalHash } from "../util/canonical-hash"
import {
  DurableEvolutionV1,
  type ArtifactInput,
  type ProposalProjection,
  type TrustedEvolutionIdentity,
} from "./durable"
import * as EvolutionExposureV1 from "./exposure"
import { EvolutionLevels } from "./level"
import { ConstitutionKernel, policyFromEnv } from "./runtime"

const CONTROL_LOCATION = "/arforge/evolution"
const CONTROL_LEASE_TTL_MS = 120_000

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: CONTROL_LEASE_TTL_MS,
  maxCostMicros: 0,
  maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

export interface CreateProposalInput {
  readonly identity: TrustedEvolutionIdentity
  /** A caller retry may mint a fresh request ID; the claim index aliases it to the same operation. */
  readonly requestID: string
  readonly traceID: string
  readonly proposal: AgentRuntime.EvolutionProposal
  readonly candidateID: string
  readonly artifact: ArtifactInput
  readonly rollbackArtifact?: ArtifactInput
  readonly sourceProvenanceArtifact?: ArtifactInput
  readonly manifest: Record<string, unknown>
  readonly state: Record<string, unknown>
  readonly artifactRef: string
}

export interface TransitionInput {
  readonly identity: TrustedEvolutionIdentity
  readonly requestID: string
  readonly traceID: string
  readonly proposalID: string
  readonly expectedRevision: number
  readonly from: AgentRuntime.EvolutionStatus
  readonly to: AgentRuntime.EvolutionStatus
  readonly state: Record<string, unknown>
  readonly reason: string
  readonly metadata?: Record<string, unknown>
}

export interface RecordEvaluationInput {
  readonly identity: TrustedEvolutionIdentity
  readonly requestID: string
  readonly traceID: string
  readonly proposalID: string
  readonly expectedRevision: number
  readonly evaluation: AgentRuntime.EvaluationResult
  readonly report: Record<string, unknown>
  readonly reason: string
}

export interface ApplyExposureArchiveInput {
  readonly identity: TrustedEvolutionIdentity
  readonly requestID: string
  readonly traceID: string
  readonly expectedPlanDigest: string
  readonly keepRecorded?: number
  readonly reason: string
}

export interface ApplyExposureRestoreInput {
  readonly identity: TrustedEvolutionIdentity
  readonly requestID: string
  readonly traceID: string
  readonly archiveID: string
  readonly expectedPlanDigest: string
  readonly reason: string
}

export interface Interface {
  /**
   * Lifecycle writes are server-owned: the input is sealed into a durable
   * ControlRun and can reach DurableEvolution only from ActionGateway.
   */
  readonly createProposal: (input: CreateProposalInput) => Effect.Effect<ProposalProjection, unknown>
  /**
   * Narrow automatic entrypoint for Core Learning. It may only persist an
   * L2 review candidate; it cannot approve, deploy, promote, or mutate an
   * existing candidate lifecycle.
   */
  readonly createAutomaticCandidateProposal: (input: CreateProposalInput) => Effect.Effect<ProposalProjection, unknown>
  readonly transition: (input: TransitionInput) => Effect.Effect<ProposalProjection, unknown>
  /**
   * Narrow automatic safety path. It may only move an active deployment to
   * rolled_back when bound to an immutable recorded exposure.
   */
  readonly transitionAutomaticRollback: (input: TransitionInput) => Effect.Effect<ProposalProjection, unknown>
  readonly recordEvaluation: (input: RecordEvaluationInput) => Effect.Effect<ProposalProjection, unknown>
  /** Records deterministic offline evaluation while keeping the candidate review-only. */
  readonly recordAutomaticCandidateEvaluation: (
    input: RecordEvaluationInput,
  ) => Effect.Effect<ProposalProjection, unknown>
  readonly applyExposureArchive: (input: ApplyExposureArchiveInput) => Effect.Effect<Record<string, unknown>, unknown>
  readonly applyExposureRestore: (input: ApplyExposureRestoreInput) => Effect.Effect<Record<string, unknown>, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/GovernedEvolution") {}

const ProposalProjectionSchema = Schema.Struct({
  proposalID: Schema.String,
  candidateID: Schema.String,
  artifactDigest: Schema.String,
  artifactRef: Schema.String,
  manifest: Schema.Record(Schema.String, Schema.Unknown),
  state: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.String,
  revision: Schema.Number,
  evaluationID: Schema.optional(Schema.String),
  controlRunID: Schema.optional(Schema.String),
  createdBy: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

type GovernanceMode = "human" | "automatic-candidate" | "automatic-rollback"

type Mutation<A> = {
  readonly actionName: string
  readonly reason: string
  readonly traceID: string
  readonly requestID: string
  readonly identity: TrustedEvolutionIdentity
  readonly input: Record<string, unknown>
  readonly payload: Record<string, unknown>
  readonly resources: ReadonlyArray<string>
  readonly governance: GovernanceMode
  readonly runMutation: () => Effect.Effect<A, unknown>
  readonly replay: (run: AgentRuntime.ControlRun) => Effect.Effect<A, unknown>
  readonly durableResult: {
    readonly encode: (value: A) => unknown
    readonly decode: (value: unknown) => A
  }
}

const normalizeRequestID = (requestID: string) => {
  const value = requestID.trim()
  if (!value) throw new Error("control requestID is required")
  return AgentRuntime.ControlPlaneRequestID.make(value.startsWith("cpr_") ? value : `cpr_${value}`)
}

const normalizeTraceID = (traceID: string) => {
  const value = traceID.trim()
  if (!value) throw new Error("control traceID is required")
  return value.slice(0, 256)
}

const jsonRecord = (value: unknown, reason: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(reason)
  return Object.fromEntries(Object.entries(value))
}

const encodedProposal = (proposal: AgentRuntime.EvolutionProposal) =>
  jsonRecord(
    Schema.encodeUnknownSync(AgentRuntime.EvolutionProposal)(proposal),
    "Evolution proposal cannot be encoded as canonical JSON",
  )

// Wall-clock timestamps are execution metadata, not mutation intent. Leaving
// them in the frozen claim would make a crash retry of identical candidate
// material conflict with its own durable ControlRun.
const encodedProposalIntent = (proposal: AgentRuntime.EvolutionProposal) => {
  const { time: _time, ...intent } = encodedProposal(proposal)
  return intent
}

const assertAutomaticCandidateCreate = (input: CreateProposalInput) => {
  if (input.identity.actor !== "system:core-learning")
    throw new Error("Automatic Evolution candidates require the trusted Core Learning actor")
  if (
    input.proposal.initiator !== "evolution" ||
    input.proposal.authority !== "scoped_grant" ||
    input.proposal.riskTier !== "L2" ||
    input.proposal.evolutionLevel !== "L2" ||
    input.proposal.status !== "proposal"
  )
    throw new Error("Automatic Evolution proposal must remain an L2 scoped candidate")
  const evidence = input.manifest.evidence_refs
  if (
    input.manifest.created_by !== input.identity.actor ||
    input.manifest.evolution_level !== "L2" ||
    !Array.isArray(evidence) ||
    evidence.length !== 1 ||
    typeof evidence[0] !== "string" ||
    !evidence[0].startsWith("core-learning-pattern:") ||
    input.state.status !== "proposed" ||
    input.state.evolution_level !== "L2" ||
    input.state.approval !== null ||
    input.state.deployment !== null ||
    input.state.rollback !== null
  )
    throw new Error("Automatic Evolution proposal escaped the review-only candidate boundary")
}

const assertCandidateLevel = (input: CreateProposalInput) => {
  if (
    input.proposal.evolutionLevel !== "L2" ||
    input.manifest.evolution_level !== input.proposal.evolutionLevel ||
    input.state.evolution_level !== "L2"
  )
    throw new Error("Evolution candidate creation must remain at L2")
  EvolutionLevels.assert({
    level: "L2",
    operation: "create_candidate",
    candidateKind: input.proposal.candidateKind,
  })
}

const assertHumanTransitionLevel = (input: TransitionInput) => {
  ConstitutionKernel.requireHuman(input.identity.actor)
  if (input.to === "canary") {
    EvolutionLevels.assert({
      level: "L3",
      operation: "start_canary",
      candidateKind: "skill",
      isolated: true,
      reversible: true,
    })
  }
  if (input.to === "promoted") {
    EvolutionLevels.assert({
      level: "L4",
      operation: "promote",
      candidateKind: "skill",
      humanApproved: true,
      controlled: true,
      rollbackReady: true,
    })
  }
}

const assertAutomaticRollback = (input: TransitionInput) => {
  const metadata = input.metadata ?? {}
  const rollback = jsonRecord(input.state.rollback, "Automatic Evolution rollback metadata is required")
  const trigger = metadata.trigger
  const exposureID = metadata.exposureID
  const expectedReason =
    trigger === "safety_incident"
      ? `automatic rollback after candidate-cohort safety incident (exposure:${String(exposureID)})`
      : `automatic rollback after sustained canary health failure (exposure:${String(exposureID)})`
  if (input.identity.actor !== "system:evolution-monitor")
    throw new Error("Automatic Evolution rollback requires the trusted monitor actor")
  if (
    (input.from !== "canary" && input.from !== "promoted") ||
    input.to !== "rolled_back" ||
    input.state.status !== "rolled_back" ||
    input.state.revision !== input.expectedRevision ||
    metadata.action !== "automaticRollback" ||
    metadata.automatic !== true ||
    (trigger !== "safety_incident" && trigger !== "canary_health") ||
    typeof exposureID !== "string" ||
    !/^ex-[0-9a-f]{32}$/.test(exposureID) ||
    rollback.actor !== input.identity.actor ||
    rollback.reason !== input.reason ||
    input.reason !== expectedReason ||
    typeof rollback.at !== "string" ||
    rollback.automatic !== true ||
    rollback.trigger !== trigger ||
    rollback.source_exposure_id !== exposureID ||
    rollback.from_status !== input.from ||
    input.state.evolution_level !== "L2"
  )
    throw new Error("Automatic Evolution rollback escaped the exposure-bound safety boundary")
}

const humanSemantics = AgentRuntime.EffectSemantics.make({
  // Control-plane actions are deliberately L3. The ActionGateway owns the
  // fresh human approval; this service never downgrades it to automatic.
  riskTier: "L3",
  authority: "human",
  idempotency: "idempotent",
  retryability: "safe",
  reversibility: "reversible",
  filesystemScope: [],
  networkScope: [],
  secretScope: [],
  externalServices: [],
  expectedArtifacts: ["evolution-projection", "evolution-audit"],
  successCriteria: ["database mutation committed", "audit event committed"],
})

const automaticCandidateSemantics = AgentRuntime.EffectSemantics.make({
  // This is the reversible write of a review-only projection. The candidate
  // itself declares L2 and cannot cross the human lifecycle gates through
  // this entrypoint.
  riskTier: "L1",
  authority: "automatic",
  idempotency: "idempotent",
  retryability: "safe",
  reversibility: "reversible",
  filesystemScope: [],
  networkScope: [],
  secretScope: [],
  externalServices: [],
  expectedArtifacts: ["evolution-candidate-projection", "evolution-audit"],
  successCriteria: ["candidate remains review-only", "database mutation committed", "audit event committed"],
})

const automaticRollbackSemantics = AgentRuntime.EffectSemantics.make({
  // A verified receipt may only reduce an active deployment's impact. The
  // immutable prior artifact remains available for human-governed recovery.
  riskTier: "L1",
  authority: "automatic",
  idempotency: "idempotent",
  retryability: "safe",
  reversibility: "compensatable",
  filesystemScope: [],
  networkScope: [],
  secretScope: [],
  externalServices: [],
  expectedArtifacts: ["evolution-rollback-projection", "evolution-audit"],
  successCriteria: [
    "deployment impact reduced",
    "recorded exposure receipt verified",
    "database mutation committed",
    "audit event committed",
  ],
})

const governance = (mode: GovernanceMode) =>
  mode === "automatic-candidate"
    ? {
        semantics: automaticCandidateSemantics,
        initiator: "evolution" as const,
        authority: "automatic" as const,
        riskTier: "L1" as const,
      }
    : mode === "automatic-rollback"
      ? {
          semantics: automaticRollbackSemantics,
          initiator: "evolution" as const,
          authority: "automatic" as const,
          riskTier: "L1" as const,
        }
      : {
          semantics: humanSemantics,
          initiator: "user" as const,
          authority: "human" as const,
          riskTier: "L3" as const,
        }

const operationPayload = <A>(mutation: Mutation<A>) => mutation.payload

const buildClaim = <A>(mutation: Mutation<A>): ControlClaimIndex.ClaimInput => {
  const requestID = normalizeRequestID(mutation.requestID)
  const traceID = normalizeTraceID(mutation.traceID)
  const resources = [...mutation.resources]
  const authorization: ActionGateway.AuthorizationPlan = {
    requests: [{ action: mutation.actionName, resources }],
    metadata: { domain: "evolution", version: 1 },
  }
  const payload = operationPayload(mutation)
  const control = governance(mutation.governance)
  const inputDigest = canonicalHash(mutation.input)
  const payloadDigest = canonicalHash(payload)
  if (!inputDigest || !payloadDigest) throw new Error("Evolution control mutation is not canonical JSON")
  const subject = AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: ControlPrincipal.controlPlaneID(mutation.identity, {
      location: CONTROL_LOCATION,
      projectID: Project.ID.global,
      action: mutation.actionName,
    }),
    location: AbsolutePath.make(CONTROL_LOCATION),
    project: Project.ID.global,
    actor: "user",
    principalRef: ControlPrincipal.principalRef(mutation.identity),
    requestID,
  })
  return {
    subject,
    gateway: {
      kind: "control-plane",
      name: mutation.actionName,
      resources,
      semantics: control.semantics,
      reasonSummary: mutation.reason.slice(0, 500),
    },
    authorization,
    input: mutation.input,
    operation: { kind: mutation.actionName, payload },
    run: {
      initiator: control.initiator,
      authority: control.authority,
      riskTier: control.riskTier,
      reasonSummary: mutation.reason.slice(0, 500),
      budget,
      traceID,
      visibility: "audit",
    },
  }
}

const sameMutation = <A>(run: AgentRuntime.ControlRun, mutation: Mutation<A>) =>
  run.operation.kind === mutation.actionName &&
  run.operation.payloadDigest === canonicalHash(operationPayload(mutation))

const terminalReplay = <A>(run: AgentRuntime.ControlRun, mutation: Mutation<A>) => {
  if (!sameMutation(run, mutation)) throw new Error("durable Evolution control run payload does not match the request")
  return mutation.replay(run)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const claims = yield* ControlClaimIndex.Service
    const gateway = yield* ActionGateway.Service
    const runs = yield* DurableRun.Service
    const durable = yield* DurableEvolutionV1.Service
    const exposures = yield* EvolutionExposureV1.Service

    const execute = <A>(mutation: Mutation<A>): Effect.Effect<A, unknown> =>
      Effect.gen(function* () {
        const principal = { tenantID: mutation.identity.tenantID, userID: mutation.identity.userID }
        const claim = yield* claims
          .claim(buildClaim(mutation))
          .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
        const run = claim.snapshot.run
        if (run.status === "completed") return yield* terminalReplay(run, mutation)
        if (run.status === "failed" || run.status === "cancelled")
          throw new Error(`Evolution control run is terminal and cannot be retried: ${run.status}`)

        const leased = yield* runs.acquireControlLease({
          runID: run.id,
          ownerID: `evolution:${mutation.identity.tenantID}:${mutation.identity.userID}`,
          ttlMs: CONTROL_LEASE_TTL_MS,
        })
        const executeWithLease = Effect.gen(function* () {
          let current = leased.snapshot
          const automatic = mutation.governance !== "human"
          if (current.run.status === "draft") {
            current = yield* runs.transitionControl(leased.capability, {
              runID: run.id,
              to: "preflight",
              reason: "Evolution control mutation entered durable preflight",
            })
            current = yield* runs.transitionControl(leased.capability, {
              runID: run.id,
              to: automatic ? "queued" : "awaiting_authorization",
              reason: automatic
                ? "Review-only Evolution projection passed automatic preflight"
                : "Evolution control mutation awaits fresh human approval",
            })
          } else if (
            (automatic && !["queued", "running", "verifying"].includes(current.run.status)) ||
            (!automatic && !["awaiting_authorization", "queued", "running", "verifying"].includes(current.run.status))
          ) {
            throw new Error(`Evolution control run is not executable: ${current.run.status}`)
          }
          const result = yield* Effect.gen(function* () {
            // These states are reached only after ActionGateway returned a
            // settled durable result. A coordinator crash here resumes the
            // run finalization from the domain projection without reopening
            // authorization or executing the action again.
            if (current.run.status === "running" || current.run.status === "verifying")
              return yield* terminalReplay(current.run, mutation)
            const operation = current.run.operation
            const actionInput: ActionGateway.Input & { readonly kind: "control-plane" } = {
              kind: "control-plane",
              controlPlane: current.run.subject,
              actionID: operation.actionID,
              runID: current.run.id,
              name: mutation.actionName,
              resources: [...operation.resources],
              semantics: operation.semantics,
              reasonSummary: current.run.reasonSummary,
              initiator: current.run.initiator,
              traceID: current.run.traceID,
              inputDigest: operation.inputDigest,
              runLease: leased.capability,
            }
            const authorization: ActionGateway.AuthorizationPlan = {
              requests: [{ action: mutation.actionName, resources: [...operation.resources] }],
              metadata: { domain: "evolution", version: 1 },
            }
            return yield* gateway.execute(actionInput, {
              authorization,
              execute: () => mutation.runMutation(),
              successSummary: () => `Evolution ${mutation.actionName} committed`,
              durableResult: {
                encode: mutation.durableResult.encode,
                decode: mutation.durableResult.decode,
              },
            })
          })
          if (current.run.status === "awaiting_authorization")
            current = yield* runs.transitionControl(leased.capability, {
              runID: run.id,
              to: "queued",
              reason: "Evolution mutation authorized and queued",
            })
          if (current.run.status === "queued")
            current = yield* runs.transitionControl(leased.capability, {
              runID: run.id,
              to: "running",
              reason: "Evolution mutation executing through ActionGateway",
            })
          if (current.run.status === "running")
            current = yield* runs.transitionControl(leased.capability, {
              runID: run.id,
              to: "verifying",
              reason: "Evolution mutation result is being verified",
            })
          if (current.run.status === "verifying")
            yield* runs.transitionControl(leased.capability, {
              runID: run.id,
              to: "completed",
              reason: "Evolution mutation committed and verified",
            })
          return result
        }).pipe(
          Effect.ensuring(
            runs
              .releaseControlLease(leased.capability, { runID: run.id, reason: "Evolution mutation worker finished" })
              .pipe(Effect.ignore),
          ),
        )
        return yield* executeWithLease
      })

    const createProposalWith = (input: CreateProposalInput, mode: GovernanceMode) => {
      assertCandidateLevel(input)
      if (mode === "automatic-candidate") assertAutomaticCandidateCreate(input)
      const encoded = encodedProposalIntent(input.proposal)
      const mutation: Mutation<ProposalProjection> = {
        actionName: mode === "automatic-candidate" ? "evolution.candidate.auto-propose" : "evolution.proposal.create",
        reason: input.proposal.reasonSummary,
        traceID: input.traceID,
        requestID: input.requestID,
        identity: input.identity,
        governance: mode,
        input: {
          kind: "create",
          proposal: encoded,
          candidateID: input.candidateID,
          artifact: input.artifact,
          ...(input.rollbackArtifact ? { rollbackArtifact: input.rollbackArtifact } : {}),
          ...(input.sourceProvenanceArtifact ? { sourceProvenanceArtifact: input.sourceProvenanceArtifact } : {}),
          manifest: input.manifest,
          state: input.state,
          artifactRef: input.artifactRef,
        },
        payload: {
          kind: "create",
          proposal: encoded,
          candidateID: input.candidateID,
          artifact: input.artifact,
          ...(input.rollbackArtifact ? { rollbackArtifact: input.rollbackArtifact } : {}),
          ...(input.sourceProvenanceArtifact ? { sourceProvenanceArtifact: input.sourceProvenanceArtifact } : {}),
          manifest: input.manifest,
          state: input.state,
          artifactRef: input.artifactRef,
        },
        resources: [`evolution:${input.proposal.id}`],
        runMutation: () =>
          durable.createProposal({
            identity: input.identity,
            proposal: input.proposal,
            candidateID: input.candidateID,
            artifact: input.artifact,
            rollbackArtifact: input.rollbackArtifact,
            sourceProvenanceArtifact: input.sourceProvenanceArtifact,
            manifest: input.manifest,
            state: input.state,
            artifactRef: input.artifactRef,
          }),
        replay: () => durable.getProposal(input.identity, input.proposal.id),
        durableResult: {
          encode: (value) => value,
          decode: (value) => Schema.decodeUnknownSync(ProposalProjectionSchema)(value),
        },
      }
      return execute(mutation)
    }

    const createProposal: Interface["createProposal"] = (input) => createProposalWith(input, "human")

    const createAutomaticCandidateProposal: Interface["createAutomaticCandidateProposal"] = (input) =>
      createProposalWith(input, "automatic-candidate")

    const transitionWith = (input: TransitionInput, mode: GovernanceMode) => {
      if (mode === "automatic-rollback") assertAutomaticRollback(input)
      else assertHumanTransitionLevel(input)
      const mutation: Mutation<ProposalProjection> = {
        actionName:
          mode === "automatic-rollback" ? "evolution.candidate.auto-rollback" : "evolution.proposal.transition",
        reason: input.reason,
        traceID: input.traceID,
        requestID: input.requestID,
        identity: input.identity,
        governance: mode,
        input: {
          kind: "transition",
          proposalID: input.proposalID,
          expectedRevision: input.expectedRevision,
          from: input.from,
          to: input.to,
          state: input.state,
          reason: input.reason,
          metadata: input.metadata ?? {},
        },
        payload: {
          kind: "transition",
          proposalID: input.proposalID,
          expectedRevision: input.expectedRevision,
          from: input.from,
          to: input.to,
          state: input.state,
          reason: input.reason,
          metadata: input.metadata ?? {},
        },
        resources: [
          `evolution:${input.proposalID}`,
          ...(mode === "automatic-rollback" ? [`evolution:exposure:${String(input.metadata?.exposureID)}`] : []),
        ],
        runMutation: () =>
          Effect.gen(function* () {
            if (mode === "automatic-rollback") {
              const current = yield* durable.getProposal(input.identity, input.proposalID)
              const metadata = input.metadata ?? {}
              const trigger = metadata.trigger
              const exposureID = String(metadata.exposureID)
              const exposure = yield* exposures.getExposure(input.identity, exposureID)
              const assignment = exposure.assignments.find((item) => item.candidate_id === current.candidateID)
              const rollback = jsonRecord(input.state.rollback, "Automatic Evolution rollback metadata is required")
              if (
                exposure.status !== "recorded" ||
                exposure.receipt === null ||
                exposure.receipt.outcome === null ||
                rollback.at !== exposure.receipt.recorded_at ||
                metadata.candidateID !== current.candidateID ||
                !assignment ||
                assignment.candidate_digest !== current.artifactDigest
              )
                throw new Error("Automatic Evolution rollback is not bound to a verified exposure receipt")
              if (
                trigger === "safety_incident" &&
                (!exposure.receipt.outcome.safety_incident || assignment.cohort !== "candidate")
              )
                throw new Error("Automatic safety rollback requires a candidate-cohort safety incident")
              if (trigger === "canary_health") {
                const report = yield* exposures.canaryReport(input.identity, current.candidateID)
                const policy = policyFromEnv()
                const candidateObservations = Number(report.candidate_observations)
                const controlObservations = Number(report.control_observations)
                const candidateSuccessRate = Number(report.candidate_success_rate)
                const successRateDelta = Number(report.success_rate_delta)
                if (
                  !Number.isFinite(candidateObservations) ||
                  !Number.isFinite(controlObservations) ||
                  !Number.isFinite(candidateSuccessRate) ||
                  !Number.isFinite(successRateDelta) ||
                  candidateObservations < policy.auto_rollback_min_observations ||
                  candidateSuccessRate >= policy.auto_rollback_success_rate ||
                  (controlObservations > 0 && successRateDelta >= policy.min_success_rate_delta)
                )
                  throw new Error("Automatic health rollback requires the durable canary failure threshold")
              }
              const replayState = { ...input.state, status: input.to, revision: input.expectedRevision + 1 }
              const active = current.revision === input.expectedRevision && current.status === input.from
              const exactReplay =
                current.revision === input.expectedRevision + 1 &&
                current.status === input.to &&
                canonicalHash(current.state) === canonicalHash(replayState)
              if (!active && !exactReplay)
                throw new Error("Automatic Evolution rollback no longer matches the active deployment")
            }
            return yield* durable.transition({
              identity: input.identity,
              proposalID: input.proposalID,
              expectedRevision: input.expectedRevision,
              from: input.from,
              to: input.to,
              state: input.state,
              reason: input.reason,
              ...(input.metadata ? { metadata: input.metadata } : {}),
            })
          }),
        replay: () => durable.getProposal(input.identity, input.proposalID),
        durableResult: {
          encode: (value) => value,
          decode: (value) => Schema.decodeUnknownSync(ProposalProjectionSchema)(value),
        },
      }
      return execute(mutation)
    }

    const transition: Interface["transition"] = (input) => transitionWith(input, "human")

    const transitionAutomaticRollback: Interface["transitionAutomaticRollback"] = (input) =>
      transitionWith(input, "automatic-rollback")

    const recordEvaluationWith = (input: RecordEvaluationInput, mode: GovernanceMode) => {
      if (mode === "automatic-candidate" && input.identity.actor !== "system:core-learning")
        throw new Error("Automatic Evolution evaluation requires the trusted Core Learning actor")
      EvolutionLevels.assert({
        level: "L2",
        operation: "offline_evaluate",
        candidateKind: "skill",
        isolated: true,
      })
      const encodedEvaluation = jsonRecord(
        Schema.encodeUnknownSync(AgentRuntime.EvaluationResult)(input.evaluation),
        "Evolution evaluation cannot be encoded as canonical JSON",
      )
      const mutation: Mutation<ProposalProjection> = {
        actionName:
          mode === "automatic-candidate" ? "evolution.candidate.auto-evaluate" : "evolution.proposal.evaluate",
        reason: input.reason,
        traceID: input.traceID,
        requestID: input.requestID,
        identity: input.identity,
        governance: mode,
        input: {
          kind: "evaluation",
          proposalID: input.proposalID,
          expectedRevision: input.expectedRevision,
          evaluation: encodedEvaluation,
          report: input.report,
          reason: input.reason,
        },
        payload: {
          kind: "evaluation",
          proposalID: input.proposalID,
          expectedRevision: input.expectedRevision,
          evaluation: encodedEvaluation,
          report: input.report,
          reason: input.reason,
        },
        resources: [`evolution:${input.proposalID}`],
        runMutation: () =>
          Effect.gen(function* () {
            if (mode === "automatic-candidate") {
              const current = yield* durable.getProposal(input.identity, input.proposalID)
              if (
                current.createdBy !== "system:core-learning" ||
                (current.status !== "proposal" && current.status !== "sandbox_evaluation") ||
                current.state.approval !== null ||
                current.state.deployment !== null ||
                current.state.rollback !== null
              )
                throw new Error("Automatic evaluation may only update a review-only Core Learning candidate")
            }
            return yield* durable.recordEvaluation({
              identity: input.identity,
              proposalID: input.proposalID,
              expectedRevision: input.expectedRevision,
              evaluation: input.evaluation,
              report: input.report,
              reason: input.reason,
            })
          }),
        replay: () => durable.getProposal(input.identity, input.proposalID),
        durableResult: {
          encode: (value) => value,
          decode: (value) => Schema.decodeUnknownSync(ProposalProjectionSchema)(value),
        },
      }
      return execute(mutation)
    }

    const recordEvaluation: Interface["recordEvaluation"] = (input) => recordEvaluationWith(input, "human")

    const recordAutomaticCandidateEvaluation: Interface["recordAutomaticCandidateEvaluation"] = (input) =>
      recordEvaluationWith(input, "automatic-candidate")

    const recordResult = {
      encode: (value: Record<string, unknown>) => value,
      decode: (value: unknown) => jsonRecord(value, "Evolution control result is invalid"),
    }

    const applyExposureArchive: Interface["applyExposureArchive"] = (input) => {
      const payload = {
        kind: "exposure_archive",
        expectedPlanDigest: input.expectedPlanDigest,
        keepRecorded: input.keepRecorded ?? 1000,
        reason: input.reason,
      }
      return execute({
        actionName: "evolution.exposure.archive",
        reason: input.reason,
        traceID: input.traceID,
        requestID: input.requestID,
        identity: input.identity,
        governance: "human",
        input: payload,
        payload,
        resources: ["evolution:exposures", `evolution:archive:${input.expectedPlanDigest.slice(0, 24)}`],
        runMutation: () =>
          exposures.applyExposureArchive({
            identity: input.identity,
            expectedPlanDigest: input.expectedPlanDigest,
            keepRecorded: input.keepRecorded,
            reason: input.reason,
          }),
        replay: () =>
          exposures.applyExposureArchive({
            identity: input.identity,
            expectedPlanDigest: input.expectedPlanDigest,
            keepRecorded: input.keepRecorded,
            reason: input.reason,
          }),
        durableResult: recordResult,
      })
    }

    const applyExposureRestore: Interface["applyExposureRestore"] = (input) => {
      const payload = {
        kind: "exposure_restore",
        archiveID: input.archiveID,
        expectedPlanDigest: input.expectedPlanDigest,
        reason: input.reason,
      }
      return execute({
        actionName: "evolution.exposure.restore",
        reason: input.reason,
        traceID: input.traceID,
        requestID: input.requestID,
        identity: input.identity,
        governance: "human",
        input: payload,
        payload,
        resources: ["evolution:exposures", `evolution:archive:${input.archiveID}`],
        runMutation: () =>
          exposures.applyExposureRestore({
            identity: input.identity,
            archiveID: input.archiveID,
            expectedPlanDigest: input.expectedPlanDigest,
            reason: input.reason,
          }),
        replay: () =>
          exposures.applyExposureRestore({
            identity: input.identity,
            archiveID: input.archiveID,
            expectedPlanDigest: input.expectedPlanDigest,
            reason: input.reason,
          }),
        durableResult: recordResult,
      })
    }

    return Service.of({
      createProposal,
      createAutomaticCandidateProposal,
      transition,
      transitionAutomaticRollback,
      recordEvaluation,
      recordAutomaticCandidateEvaluation,
      applyExposureArchive,
      applyExposureRestore,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    ControlClaimIndex.node,
    ActionGateway.node,
    DurableRun.node,
    DurableEvolutionV1.node,
    EvolutionExposureV1.node,
  ],
})
