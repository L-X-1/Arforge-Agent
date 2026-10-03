import { AgentV2 } from "@arforge-ai/core/agent"
import { AnalysisQuality } from "@arforge-ai/core/analysis/quality"
import { CostOptimizationAnalysis } from "@arforge-ai/core/analysis/cost-optimization"
import { FeaturePolicyAnalysis } from "@arforge-ai/core/analysis/feature-policy"
import { FileStateAnalysis } from "@arforge-ai/core/analysis/file-state"
import { MemoryFeedbackAnalysis } from "@arforge-ai/core/analysis/memory-feedback"
import { PermissionPolicyAnalysis } from "@arforge-ai/core/analysis/permission-policy"
import { Plugins, PluginInstallRuntime } from "@arforge-ai/core/analysis/plugins"
import * as PluginControl from "@arforge-ai/core/plugin-control"
import { RepoScale } from "@arforge-ai/core/analysis/repo-scale"
import { AnalysisRuns } from "@arforge-ai/core/analysis/runs"
import {
  customAgentRuntimeAdmission,
  customAgentRuntimeAdmissionEvidence,
  discoverCustomAgentProfiles,
} from "@arforge-ai/core/custom-agent-profile"
import { EvolutionCandidateV1, EvolutionExposureV1, EvolutionV2, GovernedEvolutionV1 } from "@arforge-ai/core/evolution"
import { ExperienceStoreV1 } from "@arforge-ai/core/experience-store"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { PermissionSaved } from "@arforge-ai/core/permission/saved"
import {
  defaultHome as defaultSkillHome,
  defaultSkillRoots,
  ManagedSkillRegistry,
} from "@arforge-ai/core/skill/managed"
import { SkillStoreV1 } from "@arforge-ai/core/skill-store"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { diagnosticReadOnlyExecutionBoundary } from "@arforge-ai/core/runtime/execution-boundary"
import { DurableWorkflowGraphRuntime } from "@arforge-ai/core/analysis/durable-workflow"
import {
  discoverWorkflows,
  loadWorkflow,
  previewWorkflow,
  TERMINAL_NODE_STATUSES,
  type WorkflowDefinition as WorkflowDefinition2,
} from "@arforge-ai/core/analysis/workflow-graph"
import type { RunReport } from "@arforge-ai/core/analysis/runs"
import { randomUUID } from "node:crypto"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { InvalidRequestError, ServiceUnavailableError } from "@arforge-ai/protocol/errors"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { accessSync, existsSync, constants as fsConstants } from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { createHash } from "node:crypto"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { Api } from "../api"
import { CAPABILITY_CATALOG, nativeFeatures, nativeHealth, nativeStatus } from "../capability-catalog"
import { response } from "../location"
import { IdentityContext } from "../identity-context"

const decodeHealth = Schema.decodeUnknownEffect(AgentCapability.Health)

function resolveWorkflowDefinitionPath(workspace: string, input: string) {
  const root = resolve(workspace)
  const candidate = resolve(root, input)
  const scoped = relative(root, candidate)
  if (scoped.startsWith("..") || isAbsolute(scoped))
    throw new Error("workflow definition must stay inside the current workspace")
  return candidate
}
const decodeList = Schema.decodeUnknownEffect(AgentCapability.List)
const decodeSystemOverview = Schema.decodeUnknownEffect(AgentCapability.SystemOverview)
const decodeDeepInsights = Schema.decodeUnknownEffect(AgentCapability.DeepInsights)
const decodeRepoScaleReport = Schema.decodeUnknownEffect(AgentCapability.RepoScaleReport)
const decodeRunList = Schema.decodeUnknownEffect(AgentCapability.RunList)
const decodeRunReportResult = Schema.decodeUnknownEffect(AgentCapability.RunReportResult)
const decodeQualityAssessment = Schema.decodeUnknownEffect(AgentCapability.QualityAssessment)
const decodeManagedSkillList = Schema.decodeUnknownEffect(AgentCapability.ManagedSkillList)
const decodeManagedSkillMutation = Schema.decodeUnknownEffect(AgentCapability.ManagedSkillMutation)
const decodeSkillReadResult = Schema.decodeUnknownEffect(AgentCapability.SkillReadResult)
const decodeSkillRoute = Schema.decodeUnknownEffect(AgentCapability.SkillRoute)
const decodeCustomizationList = Schema.decodeUnknownEffect(AgentCapability.CustomizationList)
const decodeCustomizationRender = Schema.decodeUnknownEffect(AgentCapability.CustomizationRender)
const decodePlanPreview = Schema.decodeUnknownEffect(AgentCapability.PlanPreview)
const decodeRunTraceExport = Schema.decodeUnknownEffect(AgentCapability.RunTraceExport)

const withDiagnosticExecutionBoundary = <T extends object>(value: T) => ({
  ...value,
  execution_boundary: diagnosticReadOnlyExecutionBoundary(),
})
const decodeWorkflowEventList = Schema.decodeUnknownEffect(AgentCapability.WorkflowEventList)
const decodeManagedPluginList = Schema.decodeUnknownEffect(AgentCapability.ManagedPluginList)
const decodePluginInspection = Schema.decodeUnknownEffect(AgentCapability.PluginInspection)
const decodePluginTransactionResult = Schema.decodeUnknownEffect(AgentCapability.PluginTransactionResult)
const decodeWorkflowDefinitionList = Schema.decodeUnknownEffect(AgentCapability.WorkflowDefinitionList)
const decodeWorkflowPreview = Schema.decodeUnknownEffect(AgentCapability.WorkflowPreview)
const decodeWorkflowRunList = Schema.decodeUnknownEffect(AgentCapability.WorkflowRunList)
const decodeWorkflowRun = Schema.decodeUnknownEffect(AgentCapability.WorkflowRun)
const decodeEvolutionStatus = Schema.decodeUnknownEffect(AgentCapability.EvolutionStatus)
const decodeEvolutionCandidateList = Schema.decodeUnknownEffect(AgentCapability.EvolutionCandidateList)
const decodeEvolutionExposureList = Schema.decodeUnknownEffect(AgentCapability.EvolutionExposureList)
const decodeEvolutionExposureArchivePlan = Schema.decodeUnknownEffect(AgentCapability.EvolutionExposureArchivePlan)
const decodeEvolutionExposureArchiveResult = Schema.decodeUnknownEffect(AgentCapability.EvolutionExposureArchiveResult)
const decodeEvolutionExposureArchiveList = Schema.decodeUnknownEffect(AgentCapability.EvolutionExposureArchiveList)
const decodeEvolutionExposureArchiveDetail = Schema.decodeUnknownEffect(AgentCapability.EvolutionExposureArchiveDetail)
const decodeEvolutionExposureRestorePlan = Schema.decodeUnknownEffect(AgentCapability.EvolutionExposureRestorePlan)
const decodeEvolutionExposureRestoreResult = Schema.decodeUnknownEffect(AgentCapability.EvolutionExposureRestoreResult)
const decodeEvolutionExposureArchiveExport = Schema.decodeUnknownEffect(AgentCapability.EvolutionExposureArchiveExport)
const decodeEvolutionAuditEventList = Schema.decodeUnknownEffect(AgentCapability.EvolutionAuditEventList)
const decodeEvolutionCandidate = Schema.decodeUnknownEffect(AgentCapability.EvolutionCandidate)
const decodeEvolutionOpportunityList = Schema.decodeUnknownEffect(AgentCapability.EvolutionOpportunityList)
const decodeEvolutionCanaryReport = Schema.decodeUnknownEffect(AgentCapability.EvolutionCanaryReport)
const decodeEvolutionContextPreview = Schema.decodeUnknownEffect(AgentCapability.EvolutionContextPreview)
const decodeExperienceCandidate = Schema.decodeUnknownEffect(AgentCapability.ExperienceCandidate)
const decodeExperienceCandidateList = Schema.decodeUnknownEffect(AgentCapability.ExperienceCandidateList)
const decodeExperienceReviewResult = Schema.decodeUnknownEffect(AgentCapability.ExperienceReviewResult)
const decodeExperienceSourceList = Schema.decodeUnknownEffect(AgentCapability.ExperienceSourceList)
const decodeSkillLifecycleCandidate = Schema.decodeUnknownEffect(AgentCapability.SkillLifecycleCandidate)
const decodeSkillLifecycleCandidateDetail = Schema.decodeUnknownEffect(AgentCapability.SkillLifecycleCandidateDetail)
const decodeSkillLifecycleCandidateList = Schema.decodeUnknownEffect(AgentCapability.SkillLifecycleCandidateList)
const decodeSkillDeployment = Schema.decodeUnknownEffect(AgentCapability.SkillDeployment)
const decodeSkillPromotionResult = Schema.decodeUnknownEffect(AgentCapability.SkillPromotionResult)
const decodeSkillRollbackResult = Schema.decodeUnknownEffect(AgentCapability.SkillRollbackResult)
const decodeSkillEvaluationResult = Schema.decodeUnknownEffect(AgentCapability.SkillEvaluationResult)
const decodeSkillCanaryObservationResult = Schema.decodeUnknownEffect(AgentCapability.SkillCanaryObservationResult)

/**
 * Safe, bounded projection for the System Overview card. Admission receipts
 * are evidence only: prompts, profile contents, lease owners and arbitrary
 * filesystem paths never cross this boundary.
 */
const customAgentAdmissionOverview = (workspace: string) => {
  const discovered = discoverCustomAgentProfiles(workspace)
  const items = discovered.profiles.slice(0, 64).map((profile) => {
    const evidence = customAgentRuntimeAdmissionEvidence(customAgentRuntimeAdmission(profile, workspace))
    return {
      role: evidence.role,
      status: evidence.status,
      decision: evidence.decision,
      reason: evidence.reason,
      ...(evidence.descriptor_digest === undefined ? {} : { descriptor_digest: evidence.descriptor_digest }),
      checks: evidence.checks,
      declared_tool_count: evidence.declared_tool_count,
      canonical_tool_count: evidence.canonical_tool_count,
      unsupported_tool_count: evidence.unsupported_tool_count,
      valid: evidence.valid,
      violations: [...evidence.violations].slice(0, 8),
    }
  })
  return {
    schema_version: 1 as const,
    count: items.length,
    items,
    errors: discovered.errors.slice(0, 16).map((item) => ({ file: basename(item.path), error: item.error })),
    truncated: discovered.profiles.length > items.length,
  }
}

const unavailable = () =>
  new ServiceUnavailableError({
    service: "arforge-agent-capability",
    message: "Arforge Agent's native capability runtime is unavailable or returned an invalid response.",
  })

const runtimeInfrastructureErrors = new Set([
  "BRIDGE_FAILURE",
  "BRIDGE_NOT_RUNNING",
  "BRIDGE_START_FAILED",
  "BRIDGE_WRITE_FAILED",
  "BRIDGE_EXITED",
  "BRIDGE_CLOSED",
  "PYTHON_NOT_FOUND",
  "REQUEST_TIMEOUT",
  "INVALID_RESPONSE",
  "RESPONSE_TOO_LARGE",
])

function runtimeError(error: unknown) {
  if (typeof error !== "object" || error === null) return
  if ("code" in error && typeof error.code === "string")
    return {
      code: error.code,
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : "The requested Arforge capability operation was rejected.",
    }
  if (
    "_tag" in error &&
    typeof error._tag === "string" &&
    /^(?:DurableRun|DurableAction|ActionGateway|ControlClaimIndex|PluginControl)\./.test(error._tag)
  ) {
    const code = error._tag
      .slice(error._tag.indexOf(".") + 1)
      .replaceAll(/([a-z])([A-Z])/g, "$1_$2")
      .toUpperCase()
    const message =
      "reason" in error && typeof error.reason === "string"
        ? error.reason
        : error._tag.endsWith("NotFoundError") && "runID" in error && typeof error.runID === "string"
          ? `durable run not found: ${error.runID}`
          : "message" in error && typeof error.message === "string"
            ? error.message
            : "The requested Arforge capability operation was rejected."
    return { code, message }
  }
}

const capabilityError = (error: unknown) => {
  const runtime = runtimeError(error)
  if (!runtime || runtimeInfrastructureErrors.has(runtime.code)) return unavailable()
  return new InvalidRequestError({
    kind: `agent-capability-${runtime.code.toLowerCase().replaceAll("_", "-")}`,
    message: runtime.message,
  })
}

const managementError = (error: unknown) => {
  const runtime = runtimeError(error)
  if (!runtime || runtimeInfrastructureErrors.has(runtime.code)) return unavailable()
  return new InvalidRequestError({
    kind: `agent-management-${runtime.code.toLowerCase().replaceAll("_", "-")}`,
    message: runtime.message,
  })
}

const lifecycleError = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("_tag" in error) || typeof error._tag !== "string")
    return unavailable()
  const reason = "reason" in error && typeof error.reason === "string" ? error.reason : undefined
  const detail =
    reason ??
    ("kind" in error && typeof error.kind === "string" && "id" in error && typeof error.id === "string"
      ? `${error.kind} not found: ${error.id}`
      : "The requested lifecycle operation was rejected.")
  return new InvalidRequestError({
    kind: error._tag.toLowerCase().replaceAll(".", "-").replaceAll("_", "-"),
    message: detail,
  })
}

const toISO = (milliseconds: number) => new Date(milliseconds).toISOString()

const pluginControlSubject = (input: {
  readonly location: Location.Interface
  readonly principal: { readonly tenantID: string; readonly userID: string }
  readonly action: string
  readonly requestID: AgentRuntime.ControlPlaneRequestID
}) => {
  const principalRef = ControlPrincipal.principalRef(input.principal)
  return AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: ControlPrincipal.controlPlaneID(input.principal, {
      location: input.location.directory,
      projectID: input.location.project.id,
      action: input.action,
    }),
    location: input.location.directory,
    project: input.location.project.id,
    actor: "user",
    principalRef,
    requestID: input.requestID,
  })
}

const pluginControlSemantics = (input: {
  readonly profileRoot: string
  readonly resources: ReadonlyArray<string>
  readonly egress?: ReadonlyArray<string>
  readonly secrets?: ReadonlyArray<string>
  readonly operation: string
}) =>
  AgentRuntime.EffectSemantics.make({
    riskTier: "L3",
    authority: "human",
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "reversible",
    filesystemScope: [input.profileRoot],
    networkScope: [...(input.egress ?? [])],
    secretScope: [...(input.secrets ?? [])],
    externalServices: ["plugin-manager", ...(input.egress?.length ? ["plugin-source"] : [])],
    expectedArtifacts: [`plugin-management:${input.operation}`, ...input.resources],
    successCriteria: ["manifest and security contract validated", "plugin state committed", "audit event committed"],
  })

const managedSkillRegistry = (location: Location.Interface) =>
  new ManagedSkillRegistry({ roots: defaultSkillRoots({ cwd: location.directory }) })

const managedPluginRuntime = (location: Location.Interface) =>
  new PluginInstallRuntime({ home: join(location.directory, ".arforge") })

const stablePluginJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stablePluginJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stablePluginJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

const pluginRequestID = (operation: string, payload: unknown) =>
  AgentRuntime.ControlPlaneRequestID.make(
    `cpr_${createHash("sha256")
      .update(`arforge.plugin-request/v1\0${operation}\0${stablePluginJson(payload)}`)
      .digest("hex")
      .slice(0, 32)}`,
  )

const runPluginControl = <A, B>(
  input: Omit<PluginControl.ExecuteInput<A>, "subject" | "principal"> & {
    readonly requestPayload: unknown
    readonly requestID?: AgentRuntime.ControlPlaneRequestID
  },
  decode: (value: unknown) => Effect.Effect<B, unknown>,
) =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const principal = yield* IdentityContext.Current
    const control = yield* PluginControl.Service
    const { requestID: explicitRequestID, ...execution } = input
    const requestID = explicitRequestID ?? pluginRequestID(input.operation, input.requestPayload)
    const subject = pluginControlSubject({ location, principal, action: input.action, requestID })
    const baseClaimMaterial = execution.claimMaterial ?? {
      input: execution.input,
      payload: execution.payload,
    }
    const scopedExecution = explicitRequestID
      ? {
          ...execution,
          claimMaterial: {
            input: { operationIntentID: explicitRequestID, value: baseClaimMaterial.input },
            payload: { operationIntentID: explicitRequestID, value: baseClaimMaterial.payload },
          },
        }
      : execution
    return yield* response(control.execute({ ...scopedExecution, subject, principal }).pipe(Effect.flatMap(decode)))
  })

const experienceCandidateView = (value: ExperienceStoreV1.CandidateProjection) => ({
  schema_version: 1 as const,
  candidate_id: value.candidateID,
  problem_signature: value.problemSignature,
  applicable_scope: value.applicableScope,
  conditions: value.conditions,
  attempted_strategy: value.attemptedStrategy,
  counterexamples: value.counterexamples,
  support_count: value.supportCount,
  source_run_ids: value.sourceRunIDs.map(String),
  source_support_ids: value.sourceSupportIDs,
  evidence_ids: value.evidenceIDs.map(String),
  evaluation_digest: value.evaluationDigest ?? null,
  review_actor: value.reviewActor ?? null,
  review_reason: value.reviewReason ?? null,
  review_status: value.reviewStatus,
  status: value.status,
  policy_version: value.policyVersion,
  expiry_at: value.expiryAt ?? null,
  digest: value.digest,
  revision: value.revision,
  created_by: value.createdBy,
  created_at: toISO(value.createdAt),
  updated_at: toISO(value.updatedAt),
})

const experienceSourceView = (value: ExperienceStoreV1.ExperienceSourceProjection) => ({
  schema_version: 1 as const,
  experience_id: String(value.experienceID),
  candidate_id: value.candidateID,
  summary: value.summary,
  evidence_count: value.evidenceCount,
  record_digest: value.recordDigest,
  policy_version: value.policyVersion,
  created_at: toISO(value.createdAt),
})

const skillCandidateView = (value: SkillStoreV1.SkillCandidateProjection) => ({
  schema_version: 1 as const,
  candidate_id: value.candidateID,
  skill_id: String(value.skill.skillID),
  version: value.skill.version,
  digest: value.skill.digest,
  status: value.skill.status,
  purpose: value.skill.purpose,
  triggers: value.skill.triggers,
  allowed_tools: value.skill.allowedTools,
  allowed_capabilities: value.skill.allowedCapabilities,
  source_experience_ids: value.skill.sourceExperienceIDs.map(String),
  source_evidence_ids: value.sourceEvidenceIDs.map(String),
  test_ids: value.skill.testIDs,
  evaluation_id: String(value.skill.evaluationID ?? ""),
  evaluation_digest: value.evaluationDigest ?? null,
  evaluation_passed: value.evaluationPassed ?? null,
  baseline_candidate_id: value.baselineCandidateID ?? null,
  revision: value.revision,
  created_by: value.createdBy,
  review_actor: value.reviewActor ?? null,
  review_reason: value.reviewReason ?? null,
  traffic_percent: value.trafficPercent ?? null,
  canary_digest: value.canaryDigest ?? null,
  rollback_version: value.rollbackVersion ?? null,
  record_digest: value.recordDigest,
  created_at: toISO(value.createdAt),
  updated_at: toISO(value.updatedAt),
})

const skillDeploymentView = (value: SkillStoreV1.SkillDeploymentProjection) => ({
  schema_version: 1 as const,
  skill_id: String(value.skillID),
  active_candidate_id: value.activeCandidateID,
  previous_candidate_id: value.previousCandidateID ?? null,
  generation: value.generation,
  digest: value.digest,
})

const skillEvaluationReportView = (value: {
  readonly candidateDigest: string
  readonly baselineDigest: string
  readonly sampleSize: number
  readonly utilityDelta: number
  readonly regressionCases: ReadonlyArray<string>
  readonly newFailureCount: number
  readonly newSecretFindings: number
  readonly newEgressAttempts: number
  readonly checks: {
    readonly noPermissionExpansion: boolean
    readonly noNewSecret: boolean
    readonly noNewEgress: boolean
    readonly noRegression: boolean
    readonly utilityNonRegression: boolean
  }
  readonly passed: boolean
  readonly evidenceIDs: ReadonlyArray<string>
}) => ({
  candidate_digest: value.candidateDigest,
  baseline_digest: value.baselineDigest,
  sample_size: value.sampleSize,
  utility_delta: value.utilityDelta,
  regression_cases: [...value.regressionCases],
  new_failure_count: value.newFailureCount,
  new_secret_findings: value.newSecretFindings,
  new_egress_attempts: value.newEgressAttempts,
  checks: {
    no_permission_expansion: value.checks.noPermissionExpansion,
    no_new_secret: value.checks.noNewSecret,
    no_new_egress: value.checks.noNewEgress,
    no_regression: value.checks.noRegression,
    utility_non_regression: value.checks.utilityNonRegression,
  },
  passed: value.passed,
  evidence_ids: [...value.evidenceIDs],
})

const skillCandidateDetailView = (value: SkillStoreV1.SkillCandidateDetailProjection) => ({
  schema_version: 1 as const,
  candidate: skillCandidateView(value.candidate),
  evaluation: value.evaluation ? skillEvaluationReportView(value.evaluation) : null,
  canary: {
    observation_count: value.canary.observationCount,
    success_count: value.canary.successCount,
    safety_incident_count: value.canary.safetyIncidentCount,
    success_rate: value.canary.successRate,
    minimum_observations: value.canary.minimumObservations,
    minimum_success_rate: value.canary.minimumSuccessRate,
    promotion_ready: value.canary.promotionReady,
  },
})

const retired = (message: string) => Effect.fail(new InvalidRequestError({ kind: "agent-capability-retired", message }))

function workflowRuntime(durableRun: DurableRun.Interface): DurableWorkflowGraphRuntime {
  return new DurableWorkflowGraphRuntime({ durableRun })
}

async function workflowRunView(runtime: DurableWorkflowGraphRuntime, runId: string): Promise<Record<string, unknown>> {
  const run = await runtime.getRun(runId)
  const nodes = await runtime.nodesFor(runId)
  const byStatus: Record<string, number> = {}
  for (const node of nodes.values()) {
    byStatus[node.status] = (byStatus[node.status] ?? 0) + 1
  }
  const settled = [...nodes.values()].filter(
    (node) => TERMINAL_NODE_STATUSES.has(node.status) || node.status === "waiting_approval",
  ).length
  const total = nodes.size
  return {
    schema_version: 1,
    run_id: run.run_id,
    session_id: run.session_id,
    name: run.name,
    description: run.description,
    source_path: run.source_path,
    workspace: run.workspace,
    permission_mode: run.permission_mode,
    status: run.status,
    max_parallel: run.max_parallel,
    created_at: run.created_at,
    updated_at: run.updated_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    last_error: run.last_error,
    ...(run.definition_digest ? { definition_digest: run.definition_digest } : {}),
    ...(run.budget ? { budget: run.budget } : {}),
    ...(run.scheduling ? { scheduling: run.scheduling } : {}),
    ...(run.verification ? { verification: run.verification } : {}),
    progress: {
      settled,
      total,
      percent: total > 0 ? Math.round((settled / total) * 100) : 0,
      by_status: byStatus,
    },
    nodes: [...nodes.values()].map((node) => ({
      node_id: node.node_id,
      title: node.title,
      kind: node.kind,
      access: node.access,
      status: node.status,
      attempt: node.attempt,
      max_attempts: node.max_attempts,
      depends_on: JSON.parse(node.depends_on_json) as string[],
      continue_on_error: node.continue_on_error,
      condition: { when_step: node.when_step, when_statuses: JSON.parse(node.when_statuses_json) },
      output: node.output,
      error: node.error,
      started_at: node.started_at,
      finished_at: node.finished_at,
      ...(node.budget_reserved_attempts !== undefined
        ? { budget_reserved_attempts: node.budget_reserved_attempts }
        : {}),
      ...(node.child_run_id ? { child_run_id: node.child_run_id } : {}),
    })),
  }
}

const unavailableSection = (error: unknown) => {
  const runtime = runtimeError(error)
  return {
    status: "unavailable",
    code: runtime?.code ?? "RUNTIME_FAILURE",
    message: runtime?.message ?? "The Arforge capability section is temporarily unavailable.",
  }
}

const isArforgeReleaseWorkspace = (root: unknown): root is string =>
  typeof root === "string" &&
  root.length > 0 &&
  existsSync(join(root, "ARFORGE.md")) &&
  existsSync(join(root, "packages", "desktop"))

const isWritable = (root: string) => {
  try {
    accessSync(root, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

export const AgentCapabilityHandler = HttpApiBuilder.group(Api, "server.agentCapability", (handlers) =>
  handlers
    .handle(
      "agentCapability.health",
      Effect.fn(function* () {
        return yield* response(
          Effect.succeed(nativeHealth()).pipe(Effect.flatMap(decodeHealth), Effect.mapError(unavailable)),
        )
      }),
    )
    .handle(
      "agentCapability.list",
      Effect.fn(function* () {
        const result = {
          count: CAPABILITY_CATALOG.length,
          items: CAPABILITY_CATALOG,
        }
        return yield* response(Effect.succeed(result).pipe(Effect.flatMap(decodeList), Effect.mapError(unavailable)))
      }),
    )
    .handle(
      "agentCapability.systemOverview",
      Effect.fn(function* () {
        const agents = yield* AgentV2.Service
        const location = yield* Location.Service
        const agentInfos = yield* agents.all()
        const roles = agentInfos
          .filter((info) => info.mode === "subagent" && !info.hidden)
          .map((info) => ({
            id: String(info.id),
            description: info.description ?? "",
            mode: info.mode,
          }))
        const tools = agentInfos
          .filter((info) => !info.hidden)
          .map((info) => ({
            id: String(info.id),
            description: info.description ?? "",
            mode: info.mode,
          }))
        const sections = [
          ["status", "Runtime status", nativeStatus()],
          ["tools", "Tools", { count: tools.length, items: tools }],
          [
            "subagent-roles",
            "Subagent roles",
            { count: roles.length, items: roles, custom_agents: customAgentAdmissionOverview(location.directory) },
          ],
          ["cost-optimization", "Cost optimization contract", CostOptimizationAnalysis.audit()],
        ] as const
        return yield* response(
          decodeSystemOverview({
            schema_version: 1,
            sections: sections.map(([id, title, data]) => ({ id, title, data })),
          }).pipe(Effect.mapError(unavailable)),
        )
      }),
    )
    .handle(
      "agentCapability.deepInsights",
      Effect.fn(function* () {
        const saved = yield* PermissionSaved.Service
        const location = yield* Location.Service
        const rules = yield* saved.list().pipe(Effect.catch(() => Effect.succeed([] as never[])))
        const root = location.directory
        const sections = [
          [
            "features",
            "Feature policy",
            yield* Effect.succeed(nativeFeatures()).pipe(
              Effect.catch((error) => Effect.succeed(unavailableSection(error))),
            ),
          ],
          ["file-state", "File observation contract", withDiagnosticExecutionBoundary(FileStateAnalysis.audit())],
          [
            "memory-feedback",
            "Memory feedback contract",
            withDiagnosticExecutionBoundary(MemoryFeedbackAnalysis.audit()),
          ],
          [
            "feature-policy-contract",
            "Feature policy contract",
            withDiagnosticExecutionBoundary(FeaturePolicyAnalysis.audit()),
          ],
          ["permission-rules", "Agent permission rules", { count: rules.length, items: rules }],
          [
            "permission-policy-contract",
            "Permission policy contract",
            withDiagnosticExecutionBoundary(PermissionPolicyAnalysis.audit()),
          ],
          ["permission-mode", "Agent permission mode", { mode: "ask", source: "typescript-core" }],
        ]
        const workspace = yield* Effect.succeed({
          root,
          exists: existsSync(root),
          writable: isWritable(root),
        }).pipe(Effect.catch(() => Effect.succeed({ root: undefined })))
        return yield* response(
          decodeDeepInsights({
            schema_version: 1,
            sections: sections.map(([id, title, data]) => ({ id, title, data })),
            workspace,
          }).pipe(Effect.mapError(unavailable)),
        )
      }),
    )
    .handle(
      "agentCapability.repoScale",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const root =
          ctx.payload.path === undefined || ctx.payload.path === "."
            ? location.directory
            : resolve(location.directory, ctx.payload.path)
        if (!RepoScale.isWithinRoot(location.directory, root)) {
          return yield* response(
            Effect.fail(
              new InvalidRequestError({
                kind: "agent-capability-path-outside-workspace",
                message: "Repository scan path must remain inside the selected workspace.",
              }),
            ),
          )
        }
        const report = RepoScale.buildRepoScaleReport(root, {
          query: ctx.payload.query,
          maxFiles: ctx.payload.maxFiles,
          limit: ctx.payload.limit,
        })
        return yield* response(
          Effect.succeed(report).pipe(Effect.flatMap(decodeRepoScaleReport), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.runList",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const home = process.env.ARFORGE_HOME
        const result = {
          schema_version: 1,
          count: 0,
          items: [],
        }
        const items = AnalysisRuns.listRunReports(ctx.query.limit ?? 20, home)
        return yield* response(
          Effect.succeed({ ...result, count: items.length, items }).pipe(
            Effect.flatMap(decodeRunList),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.runReport",
      Effect.fn(function* (ctx) {
        const home = process.env.ARFORGE_HOME
        const runId = ctx.query.runID
        if (runId === undefined) {
          return yield* response(
            Effect.succeed({ schema_version: 1, found: false, run_id: "", report: null }).pipe(
              Effect.flatMap(decodeRunReportResult),
              Effect.mapError(capabilityError),
            ),
          )
        }
        let report: RunReport
        try {
          report = AnalysisRuns.buildRunReport(runId, home)
        } catch {
          return yield* response(
            Effect.succeed({ schema_version: 1, found: false, run_id: runId, report: null }).pipe(
              Effect.flatMap(decodeRunReportResult),
              Effect.mapError(capabilityError),
            ),
          )
        }
        return yield* response(
          Effect.succeed({ schema_version: 1, found: true, run_id: report.run_id, report }).pipe(
            Effect.flatMap(decodeRunReportResult),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.qualityAssess",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const report = AnalysisQuality.assessQualityChange([...(ctx.payload.files ?? [])], {
          patchText: ctx.payload.patchText,
          root: location.directory,
        })
        return yield* response(
          Effect.succeed(report).pipe(Effect.flatMap(decodeQualityAssessment), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.skillList",
      Effect.fn(function* () {
        const location = yield* Location.Service
        const registry = managedSkillRegistry(location)
        return yield* response(
          Effect.succeed(registry.list(true)).pipe(
            Effect.flatMap(decodeManagedSkillList),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.skillRead",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const registry = managedSkillRegistry(location)
        return yield* response(
          Effect.try({
            try: () => registry.read(ctx.params.skillID, ctx.query.maxChars ?? 60_000),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodeSkillReadResult), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.skillRoute",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const registry = managedSkillRegistry(location)
        return yield* response(
          Effect.succeed(registry.route(ctx.payload.request)).pipe(
            Effect.flatMap(decodeSkillRoute),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.skillSetEnabled",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const registry = managedSkillRegistry(location)
        const skillID = ctx.params.skillID
        const enabled = ctx.payload.enabled
        const operation = enabled ? "skill.enable" : "skill.disable"
        const profileRoot = defaultSkillHome()
        const resources = [`skill:${skillID}`, `filesystem:${profileRoot}`]
        return yield* runPluginControl(
          {
            requestPayload: { skillID, enabled },
            requestID: ctx.payload.requestID,
            action: operation,
            operation,
            payload: { skillID, enabled },
            input: { skillID, enabled },
            resources,
            semantics: pluginControlSemantics({ profileRoot, resources, operation }),
            authorization: {
              requests: [{ action: operation, resources }],
              metadata: { domain: "skill-center", version: 1 },
            },
            reasonSummary: `${enabled ? "Enable" : "Disable"} managed skill ${skillID}`,
            traceID: `plugin-control:${operation}:${skillID}`,
            mutate: () =>
              Effect.try({
                try: () => registry.setEnabled(skillID, enabled),
                catch: (error) => error,
              }),
            replay: () =>
              Effect.sync(() => {
                const skills = registry.list(false)
                const current = skills.items.find((item) => item.id.toLowerCase() === skillID.toLowerCase())
                return {
                  skill_id: skillID,
                  enabled: current?.enabled ?? enabled,
                  changed: false,
                  skills,
                }
              }),
            durableResult: {
              encode: (value) => value,
              decode: (value) => value as ReturnType<ManagedSkillRegistry["setEnabled"]>,
            },
          },
          decodeManagedSkillMutation,
        ).pipe(Effect.mapError(managementError))
      }),
    )
    .handle(
      "agentCapability.skillRefresh",
      Effect.fn(function* () {
        const location = yield* Location.Service
        const registry = managedSkillRegistry(location)
        return yield* response(
          Effect.succeed(registry.refresh()).pipe(
            Effect.flatMap(decodeManagedSkillList),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.pluginList",
      Effect.fn(function* () {
        const location = yield* Location.Service
        const runtime = managedPluginRuntime(location)
        return yield* response(
          Effect.succeed(Plugins.listPlugins({ home: runtime.profileRoot })).pipe(
            Effect.flatMap(decodeManagedPluginList),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.customizationList",
      Effect.fn(function* () {
        return yield* retired("customization inspection is not available in the unified TypeScript runtime")
      }),
    )
    .handle(
      "agentCapability.customizationRender",
      Effect.fn(function* () {
        return yield* retired("customization rendering is not available in the unified TypeScript runtime")
      }),
    )
    .handle(
      "agentCapability.pluginSetEnabled",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const runtime = managedPluginRuntime(location)
        const name = ctx.params.name
        const enabled = ctx.payload.enabled
        const operation = enabled ? "plugin.enable" : "plugin.disable"
        const reviewed = Plugins.listPlugins({ home: runtime.profileRoot }).items.find(
          (item) => item.managed && item.name === name,
        )
        const expectedVersion = reviewed?.version ?? ""
        const expectedDigest = reviewed?.sha256 ?? ""
        const resources = [`plugin:${name}@${expectedVersion || "missing"}`, `filesystem:${runtime.pluginsRoot}`]
        return yield* runPluginControl(
          {
            requestPayload: { name, enabled, expectedVersion, expectedDigest },
            requestID: ctx.payload.requestID,
            action: operation,
            operation,
            payload: { name, enabled, expectedVersion, expectedDigest },
            input: { name, enabled, expectedVersion, expectedDigest },
            resources,
            semantics: pluginControlSemantics({
              profileRoot: runtime.profileRoot,
              resources,
              operation,
            }),
            authorization: {
              requests: [{ action: operation, resources }],
              metadata: { domain: "plugin-center", version: 1 },
            },
            reasonSummary: `${enabled ? "Enable" : "Disable"} managed plugin ${name} ${expectedVersion || "missing"}`,
            traceID: `plugin-control:${operation}:${name}:${expectedDigest.slice(0, 16) || "missing"}`,
            mutate: () =>
              Effect.try({
                try: () => {
                  runtime.setEnabled(name, enabled, { version: expectedVersion, sha256: expectedDigest })
                  return Plugins.listPlugins({ home: runtime.profileRoot })
                },
                catch: (error) => error,
              }),
            replay: () => Effect.sync(() => Plugins.listPlugins({ home: runtime.profileRoot })),
            durableResult: {
              encode: (value) => value,
              decode: (value) => value as ReturnType<typeof Plugins.listPlugins>,
            },
          },
          decodeManagedPluginList,
        ).pipe(Effect.mapError(managementError))
      }),
    )
    .handle(
      "agentCapability.pluginInspect",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const runtime = managedPluginRuntime(location)
        return yield* response(
          Effect.try({
            try: () => runtime.inspect(ctx.payload.source),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodePluginInspection), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.pluginApply",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const runtime = managedPluginRuntime(location)
        const payload = {
          token: ctx.payload.token,
          name: ctx.payload.name ?? "",
          replace: ctx.payload.replace ?? false,
        }
        const resources = [`filesystem:${runtime.pluginsRoot}`, `plugin:${payload.name || "selected"}`]
        const transaction = (value: unknown) => ({
          transaction: value,
          plugins: Plugins.listPlugins({ home: runtime.profileRoot }),
        })
        return yield* runPluginControl(
          {
            requestPayload: payload,
            requestID: ctx.payload.requestID,
            action: payload.replace ? "plugin.update" : "plugin.install",
            operation: payload.replace ? "plugin.update" : "plugin.install",
            payload,
            input: payload,
            resources,
            semantics: pluginControlSemantics({
              profileRoot: runtime.profileRoot,
              resources,
              operation: payload.replace ? "plugin.update" : "plugin.install",
            }),
            authorization: {
              requests: [
                {
                  action: payload.replace ? "plugin.update" : "plugin.install",
                  resources,
                },
              ],
              metadata: { domain: "plugin-center", version: 1 },
            },
            reasonSummary: `${payload.replace ? "Update" : "Install"} a managed plugin after security inspection`,
            traceID: `plugin-control:${payload.replace ? "update" : "install"}:${payload.token}`,
            mutate: () =>
              Effect.try({
                try: () => transaction(runtime.apply(payload.token, payload.name, payload.replace)),
                catch: (error) => error,
              }),
            replay: () =>
              Effect.try({
                try: () => transaction(runtime.replayApply(payload.name || undefined)),
                catch: (error) => error,
              }),
            durableResult: {
              encode: (value) => value,
              decode: (value) => value as ReturnType<typeof transaction>,
            },
          },
          decodePluginTransactionResult,
        ).pipe(Effect.mapError(managementError))
      }),
    )
    .handle(
      "agentCapability.pluginRemove",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const runtime = managedPluginRuntime(location)
        const name = ctx.params.name
        const resources = [`filesystem:${runtime.pluginsRoot}`, `plugin:${name}`]
        const transaction = (value: unknown) => ({
          transaction: value,
          plugins: Plugins.listPlugins({ home: runtime.profileRoot }),
        })
        return yield* runPluginControl(
          {
            requestPayload: { name },
            requestID: ctx.payload.requestID,
            action: "plugin.uninstall",
            operation: "plugin.uninstall",
            payload: { name },
            input: { name },
            resources,
            semantics: pluginControlSemantics({
              profileRoot: runtime.profileRoot,
              resources,
              operation: "plugin.uninstall",
            }),
            authorization: {
              requests: [{ action: "plugin.uninstall", resources }],
              metadata: { domain: "plugin-center", version: 1 },
            },
            reasonSummary: `Uninstall managed plugin ${name} into recoverable local storage`,
            traceID: `plugin-control:uninstall:${name}`,
            mutate: () =>
              Effect.try({
                try: () => transaction(runtime.remove(name)),
                catch: (error) => error,
              }),
            replay: () =>
              Effect.try({
                try: () => transaction(runtime.replayRemove(name)),
                catch: (error) => error,
              }),
            durableResult: {
              encode: (value) => value,
              decode: (value) => value as ReturnType<typeof transaction>,
            },
          },
          decodePluginTransactionResult,
        ).pipe(Effect.mapError(managementError))
      }),
    )
    .handle(
      "agentCapability.pluginRestore",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const runtime = managedPluginRuntime(location)
        const recoveryID = ctx.payload.recoveryID
        const resources = [`filesystem:${runtime.pluginsRoot}`, `recovery:${recoveryID}`]
        const transaction = (value: unknown) => ({
          transaction: value,
          plugins: Plugins.listPlugins({ home: runtime.profileRoot }),
        })
        return yield* runPluginControl(
          {
            requestPayload: { recoveryID },
            requestID: ctx.payload.requestID,
            action: "plugin.rollback",
            operation: "plugin.rollback",
            payload: { recoveryID },
            input: { recoveryID },
            resources,
            semantics: pluginControlSemantics({
              profileRoot: runtime.profileRoot,
              resources,
              operation: "plugin.rollback",
            }),
            authorization: {
              requests: [{ action: "plugin.rollback", resources }],
              metadata: { domain: "plugin-center", version: 1 },
            },
            reasonSummary: `Rollback managed plugin recovery ${recoveryID}`,
            traceID: `plugin-control:rollback:${recoveryID}`,
            mutate: () =>
              Effect.try({
                try: () => transaction(runtime.restore(recoveryID)),
                catch: (error) => error,
              }),
            replay: () =>
              Effect.try({
                try: () => transaction(runtime.replayRestore(recoveryID)),
                catch: (error) => error,
              }),
            durableResult: {
              encode: (value) => value,
              decode: (value) => value as ReturnType<typeof transaction>,
            },
          },
          decodePluginTransactionResult,
        ).pipe(Effect.mapError(managementError))
      }),
    )
    .handle(
      "agentCapability.workflowList",
      Effect.fn(function* () {
        const location = yield* Location.Service
        const items = discoverWorkflows(location.directory).map((path) => {
          try {
            const definition = loadWorkflow(path, location.directory)
            const preview = previewWorkflow(definition)
            return {
              path: definition.source_path,
              valid: true,
              name: preview.name,
              description: definition.description,
              schema_version: preview.schema_version,
              nodes: preview.steps,
              edges: preview.edges.length,
              has_approval: definition.steps.some((step) => step.kind === "approval"),
            }
          } catch (error) {
            return { path, valid: false, error: error instanceof Error ? error.message : String(error) }
          }
        })
        return yield* response(
          Effect.succeed({ schema_version: 1, items, count: items.length }).pipe(
            Effect.flatMap(decodeWorkflowDefinitionList),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.workflowPreview",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        let definition: WorkflowDefinition2
        try {
          const resolved = resolveWorkflowDefinitionPath(location.directory, ctx.payload.path)
          definition = loadWorkflow(resolved, location.directory)
        } catch (error) {
          return yield* response(
            Effect.fail(
              new InvalidRequestError({
                kind: "workflow-invalid-definition",
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          )
        }
        const preview = previewWorkflow(definition)
        return yield* response(
          Effect.succeed({
            schema_version: preview.schema_version,
            name: preview.name,
            source_path: preview.source_path,
            success: true,
            dry_run: true,
            steps: definition.steps.map((step) => ({
              id: step.id,
              title: step.title,
              kind: step.kind,
              access: step.access,
              max_attempts: step.max_attempts,
              depends_on: [...step.depends_on],
              continue_on_error: step.continue_on_error,
              condition: { when_step: step.when_step, when_statuses: [...step.when_statuses] },
              status: "planned",
              output: "",
              error: "",
            })),
            edges: preview.edges,
            node_kinds: Object.fromEntries(definition.steps.map((step) => [step.id, step.kind])),
          }).pipe(Effect.flatMap(decodeWorkflowPreview), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRunList",
      Effect.fn(function* (ctx) {
        const durableRun = yield* DurableRun.Service
        const runtime = workflowRuntime(durableRun)
        yield* Effect.tryPromise({
          try: () => runtime.ensureSchema(),
          catch: (error) => error,
        }).pipe(Effect.mapError(capabilityError))
        const listed = yield* Effect.tryPromise({
          try: () => runtime.listRuns({ sessionId: ctx.query.sessionID, limit: ctx.query.limit ?? 50 }),
          catch: (error) => error,
        }).pipe(Effect.mapError(capabilityError))
        const items = yield* Effect.forEach(
          listed.items,
          (item) =>
            Effect.tryPromise({
              try: () => workflowRunView(runtime, String(item.run_id)),
              catch: (error) => error,
            }).pipe(Effect.mapError(capabilityError)),
          { concurrency: 4 },
        )
        return yield* response(
          Effect.succeed({ schema_version: 1, items, count: items.length }).pipe(
            Effect.flatMap(decodeWorkflowRunList),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRunGet",
      Effect.fn(function* (ctx) {
        const durableRun = yield* DurableRun.Service
        const runtime = workflowRuntime(durableRun)
        yield* Effect.tryPromise({
          try: () => runtime.ensureSchema(),
          catch: (error) => error,
        }).pipe(Effect.mapError(capabilityError))
        return yield* response(
          Effect.tryPromise({
            try: () => workflowRunView(runtime, ctx.params.runID),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodeWorkflowRun), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRunEvents",
      Effect.fn(function* (ctx) {
        const durableRun = yield* DurableRun.Service
        const runtime = workflowRuntime(durableRun)
        yield* Effect.tryPromise({
          try: () => runtime.ensureSchema(),
          catch: (error) => error,
        }).pipe(Effect.mapError(capabilityError))
        return yield* response(
          Effect.tryPromise({
            try: async () => {
              const listed = await runtime.events(ctx.params.runID, ctx.query.after ?? 0, ctx.query.limit ?? 200)
              return {
                schema_version: 1 as const,
                run_id: ctx.params.runID,
                count: listed.count,
                items: listed.items.map((event) => ({
                  sequence: event.sequence,
                  type: event.event_type,
                  node_id: event.node_id,
                  data: JSON.parse(event.data_json) as unknown,
                  created_at: event.created_at,
                })),
                next_after: listed.items.at(-1)?.sequence ?? ctx.query.after ?? 0,
              }
            },
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodeWorkflowEventList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.planPreview",
      Effect.fn(function* () {
        return yield* retired("plan preview was retired with the Python agent")
      }),
    )
    .handle(
      "agentCapability.runTraceExport",
      Effect.fn(function* (ctx) {
        const home = process.env.ARFORGE_HOME
        return yield* response(
          Effect.try({
            try: () => AnalysisRuns.exportRunTrace(ctx.params.runID, home),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodeRunTraceExport), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowStart",
      Effect.fn(function* (ctx) {
        const location = yield* Location.Service
        const durableRun = yield* DurableRun.Service
        const runtime = workflowRuntime(durableRun)
        yield* Effect.tryPromise({
          try: () => runtime.ensureSchema(),
          catch: (error) => error,
        }).pipe(Effect.mapError(managementError))
        let definition: WorkflowDefinition2
        try {
          const resolved = resolveWorkflowDefinitionPath(location.directory, ctx.payload.path)
          definition = loadWorkflow(resolved, location.directory)
        } catch (error) {
          return yield* response(
            Effect.fail(
              new InvalidRequestError({
                kind: "workflow-invalid-definition",
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          )
        }
        const created = yield* Effect.tryPromise({
          try: () =>
            runtime.createRun({
              definition,
              sessionId: ctx.payload.sessionID ?? `ses_workflow_${randomUUID()}`,
              workspace: location.directory,
              permissionMode: ctx.payload.permissionMode ?? "acceptEdits",
              maxParallel: ctx.payload.maxParallel ?? 4,
            }),
          catch: (error) => error,
        }).pipe(Effect.mapError(managementError))
        yield* Effect.tryPromise({
          try: () => runtime.start(created.run_id),
          catch: (error) => error,
        }).pipe(Effect.mapError(managementError))
        return yield* response(
          Effect.tryPromise({
            try: () => workflowRunView(runtime, created.run_id),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodeWorkflowRun), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowControl",
      Effect.fn(function* (ctx) {
        const durableRun = yield* DurableRun.Service
        const runtime = workflowRuntime(durableRun)
        yield* Effect.tryPromise({
          try: () => runtime.ensureSchema(),
          catch: (error) => error,
        }).pipe(Effect.mapError(managementError))
        const control =
          ctx.payload.action === "pause"
            ? runtime.pause(ctx.params.runID)
            : ctx.payload.action === "resume"
              ? runtime.resume(ctx.params.runID)
              : runtime.cancel(ctx.params.runID)
        return yield* response(
          Effect.tryPromise({
            try: () => control,
            catch: (error) => error,
          }).pipe(
            Effect.flatMap((run) =>
              Effect.tryPromise({ try: () => workflowRunView(runtime, run.run_id), catch: (error) => error }),
            ),
            Effect.flatMap(decodeWorkflowRun),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.workflowApprove",
      Effect.fn(function* (ctx) {
        const durableRun = yield* DurableRun.Service
        const runtime = workflowRuntime(durableRun)
        yield* Effect.tryPromise({
          try: () => runtime.ensureSchema(),
          catch: (error) => error,
        }).pipe(Effect.mapError(managementError))
        return yield* response(
          Effect.tryPromise({
            try: () =>
              runtime.decideApproval(
                ctx.params.runID,
                ctx.payload.nodeID,
                ctx.payload.approved,
                ctx.payload.comment ?? "",
              ),
            catch: (error) => error,
          }).pipe(
            Effect.flatMap((run) =>
              Effect.tryPromise({ try: () => workflowRunView(runtime, run.run_id), catch: (error) => error }),
            ),
            Effect.flatMap(decodeWorkflowRun),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRetry",
      Effect.fn(function* (ctx) {
        const durableRun = yield* DurableRun.Service
        const runtime = workflowRuntime(durableRun)
        yield* Effect.tryPromise({
          try: () => runtime.ensureSchema(),
          catch: (error) => error,
        }).pipe(Effect.mapError(managementError))
        return yield* response(
          Effect.tryPromise({
            try: () => runtime.retryNode(ctx.params.runID, ctx.payload.nodeID, ctx.payload.includeDescendants ?? true),
            catch: (error) => error,
          }).pipe(
            Effect.flatMap((run) =>
              Effect.tryPromise({ try: () => workflowRunView(runtime, run.run_id), catch: (error) => error }),
            ),
            Effect.flatMap(decodeWorkflowRun),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionStatus",
      Effect.fn(function* () {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionCandidateV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution.status(identity).pipe(Effect.flatMap(decodeEvolutionStatus), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionCandidates",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionCandidateV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .listCandidates(identity, {
              ...(ctx.query.status ? { status: ctx.query.status } : {}),
              limit: ctx.query.limit ?? 100,
            })
            .pipe(Effect.flatMap(decodeEvolutionCandidateList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposures",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .listExposures(identity, {
              ...(ctx.query.status ? { status: ctx.query.status } : {}),
              limit: ctx.query.limit ?? 100,
            })
            .pipe(Effect.flatMap(decodeEvolutionExposureList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchivePreview",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .previewExposureArchive(identity, { keepRecorded: ctx.query.keepRecorded ?? 1000 })
            .pipe(Effect.flatMap(decodeEvolutionExposureArchivePlan), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchiveApply",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* GovernedEvolutionV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .applyExposureArchive({
              identity,
              requestID: `exposure-archive-${ctx.payload.expectedPlanDigest}`,
              traceID: `evolution:exposure-archive:${ctx.payload.expectedPlanDigest}`,
              keepRecorded: ctx.payload.keepRecorded,
              expectedPlanDigest: ctx.payload.expectedPlanDigest,
              reason: ctx.payload.reason,
            })
            .pipe(Effect.flatMap(decodeEvolutionExposureArchiveResult), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchives",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .listExposureArchives(identity, { limit: ctx.query.limit ?? 100 })
            .pipe(Effect.flatMap(decodeEvolutionExposureArchiveList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchiveGet",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .getExposureArchive(identity, ctx.params.archiveID, { limit: ctx.query.limit ?? 500 })
            .pipe(Effect.flatMap(decodeEvolutionExposureArchiveDetail), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureRestorePreview",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .previewExposureRestore(identity, ctx.params.archiveID)
            .pipe(Effect.flatMap(decodeEvolutionExposureRestorePlan), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureRestoreApply",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* GovernedEvolutionV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .applyExposureRestore({
              identity,
              requestID: `exposure-restore-${ctx.payload.expectedPlanDigest}`,
              traceID: `evolution:exposure-restore:${ctx.payload.expectedPlanDigest}`,
              archiveID: ctx.params.archiveID,
              expectedPlanDigest: ctx.payload.expectedPlanDigest,
              reason: ctx.payload.reason,
            })
            .pipe(Effect.flatMap(decodeEvolutionExposureRestoreResult), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchiveExport",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .exportExposureArchiveAudit(identity, ctx.params.archiveID)
            .pipe(Effect.flatMap(decodeEvolutionExposureArchiveExport), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionAuditEvents",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .listAuditEvents(identity, {
              limit: ctx.query.limit ?? 100,
              ...(ctx.query.beforeSequence === undefined ? {} : { beforeSequence: ctx.query.beforeSequence }),
            })
            .pipe(Effect.flatMap(decodeEvolutionAuditEventList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionCandidateGet",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionCandidateV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .getCandidate(identity, ctx.params.candidateID)
            .pipe(Effect.flatMap(decodeEvolutionCandidate), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionOpportunities",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        const learning = yield* LearningV2.Service
        const patterns = yield* learning.proposalCandidates().pipe(Effect.catch(() => Effect.succeed([] as never[])))
        return yield* response(
          evolution
            .listOpportunities({ limit: ctx.query.limit ?? 50, evidence: patterns })
            .pipe(Effect.flatMap(decodeEvolutionOpportunityList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionCreate",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionCandidateV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .createCandidate({
              identity,
              title: ctx.payload.title,
              target: ctx.payload.target,
              instruction: ctx.payload.instruction,
              rationale: ctx.payload.rationale,
              evidenceRefs: [...ctx.payload.evidenceRefs],
              sourceExperienceIDs: ctx.payload.sourceExperienceIDs ? [...ctx.payload.sourceExperienceIDs] : undefined,
            })
            .pipe(Effect.flatMap(decodeEvolutionCandidate), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionFromPattern",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionCandidateV1.Service
        const learning = yield* LearningV2.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        const patterns = yield* learning.proposalCandidates().pipe(Effect.catch(() => Effect.succeed([] as never[])))
        const pattern = patterns.find((item) => String(item.id) === String(ctx.params.patternID))
        if (!pattern)
          return yield* new InvalidRequestError({
            kind: "evolution-pattern-not-found",
            message: `Learning pattern not found: ${ctx.params.patternID}`,
          })
        const target = {
          failure: "learning.failure",
          fix: "learning.fix",
          preference: "learning.preference",
          convention: "learning.preference",
          constraint: "routing.advice",
          workflow: "tool.advice",
        }[pattern.type.toLowerCase()]
        if (!target)
          return yield* new InvalidRequestError({
            kind: "evolution-pattern-not-deployable",
            message: `Learning pattern type is not deployable: ${pattern.type}`,
          })
        const description = pattern.description.slice(0, 500)
        return yield* response(
          evolution
            .createCandidate({
              identity,
              title: `Governed ${pattern.type} strategy from learning pattern ${ctx.params.patternID}`,
              target,
              instruction:
                pattern.type.toLowerCase() === "failure"
                  ? `When this failure pattern recurs, diagnose the underlying cause before retrying. Observed pattern: ${description}`
                  : description,
              rationale: `Existing learning evidence: frequency=${Math.trunc(pattern.frequency || 0)}, confidence=${(pattern.confidence || 0).toFixed(2)}. Activation remains subject to isolated evaluation and human approval.`,
              evidenceRefs: [`learning-pattern:${String(ctx.params.patternID).slice(0, 160)}`],
            })
            .pipe(Effect.flatMap(decodeEvolutionCandidate), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionTransition",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionCandidateV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        const reason = ctx.payload.reason?.trim() ?? ""
        if (ctx.payload.action !== "evaluate" && !reason)
          return yield* new InvalidRequestError({
            kind: "evolution-reason-required",
            message: "A human-readable reason is required for governed Evolution lifecycle decisions.",
          })
        const common = {
          identity,
          candidateID: ctx.params.candidateID,
          expectedRevision: ctx.payload.expectedRevision,
        } as const
        return yield* response(
          evolution
            .transition({
              ...common,
              action: ctx.payload.action,
              reason,
              ...(ctx.payload.trafficPercent !== undefined ? { trafficPercent: ctx.payload.trafficPercent } : {}),
            })
            .pipe(Effect.flatMap(decodeEvolutionCandidate), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionCanaryReport",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .canaryReport(identity, ctx.params.candidateID)
            .pipe(Effect.flatMap(decodeEvolutionCanaryReport), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionContextPreview",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const evolution = yield* EvolutionExposureV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          evolution
            .previewContext(identity, { userInput: ctx.payload.userInput, cohortKey: ctx.payload.cohortKey })
            .pipe(Effect.flatMap(decodeEvolutionContextPreview), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.experienceCandidateList",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* ExperienceStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .listCandidates(identity, {
              ...(ctx.query.status === undefined ? {} : { status: ctx.query.status }),
              limit: ctx.query.limit ?? 100,
            })
            .pipe(
              Effect.map((items) => ({
                schema_version: 1 as const,
                count: items.length,
                items: items.map(experienceCandidateView),
              })),
              Effect.flatMap(decodeExperienceCandidateList),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.experienceCandidateGet",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* ExperienceStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .getCandidate(identity, ctx.params.candidateID)
            .pipe(
              Effect.map(experienceCandidateView),
              Effect.flatMap(decodeExperienceCandidate),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.experienceCandidateReview",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* ExperienceStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .review({
              identity,
              candidateID: ctx.params.candidateID,
              expectedRevision: ctx.payload.expectedRevision,
              decision: ctx.payload.decision,
              reason: ctx.payload.reason,
            })
            .pipe(
              Effect.map((result) => ({
                schema_version: 1 as const,
                candidate: experienceCandidateView(result.candidate),
                experience_ids: result.experiences.map((item) => String(item.id)),
                receipt_digest: result.receiptDigest,
              })),
              Effect.flatMap(decodeExperienceReviewResult),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.experienceSourceList",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* ExperienceStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store.listSources(identity, { limit: ctx.query.limit ?? 100 }).pipe(
            Effect.map((items) => ({
              schema_version: 1 as const,
              count: items.length,
              items: items.map(experienceSourceView),
            })),
            Effect.flatMap(decodeExperienceSourceList),
            Effect.mapError(lifecycleError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecycleCandidateList",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .listCandidates(identity, {
              ...(ctx.query.skillID === undefined ? {} : { skillID: ctx.query.skillID }),
              ...(ctx.query.status === undefined ? {} : { status: ctx.query.status }),
              limit: ctx.query.limit ?? 100,
            })
            .pipe(
              Effect.map((items) => ({
                schema_version: 1 as const,
                count: items.length,
                items: items.map(skillCandidateView),
              })),
              Effect.flatMap(decodeSkillLifecycleCandidateList),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecycleCandidateGet",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .getCandidateDetail(identity, ctx.params.candidateID)
            .pipe(
              Effect.map(skillCandidateDetailView),
              Effect.flatMap(decodeSkillLifecycleCandidateDetail),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecycleCandidateCreate",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .createCandidate({
              identity,
              skillID: ctx.payload.skillID,
              version: ctx.payload.version,
              purpose: ctx.payload.purpose,
              triggers: [...ctx.payload.triggers],
              allowedTools: [...ctx.payload.allowedTools],
              allowedCapabilities: [...ctx.payload.allowedCapabilities],
              inputSchema: ctx.payload.inputSchema,
              outputSchema: ctx.payload.outputSchema,
              instructions: ctx.payload.instructions,
              assets: ctx.payload.assets?.map((item) => ({ path: item.path, content: item.content })),
              scripts: ctx.payload.scripts?.map((item) => ({ path: item.path, content: item.content })),
              sourceExperienceIDs: ctx.payload.sourceExperienceIDs.map((id) => AgentRuntime.ExperienceID.make(id)),
              testCases: ctx.payload.testCases.map((item) => ({
                id: item.id,
                input: item.input,
                expected: item.expected,
              })),
              policyVersion: ctx.payload.policyVersion,
            })
            .pipe(
              Effect.map(skillCandidateView),
              Effect.flatMap(decodeSkillLifecycleCandidate),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecycleEvaluate",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .recordEvaluation({
              identity,
              candidateID: ctx.params.candidateID,
              expectedRevision: ctx.payload.expectedRevision,
              observations: ctx.payload.observations.map((observation) => ({
                caseID: observation.caseID,
                baseline: {
                  success: observation.baseline.success,
                  steps: observation.baseline.steps,
                  tokens: observation.baseline.tokens,
                  costMinor: observation.baseline.costMinor,
                  newFailures: observation.baseline.newFailures,
                  newSecretFindings: observation.baseline.newSecretFindings,
                  newEgressAttempts: observation.baseline.newEgressAttempts,
                },
                candidate: {
                  success: observation.candidate.success,
                  steps: observation.candidate.steps,
                  tokens: observation.candidate.tokens,
                  costMinor: observation.candidate.costMinor,
                  newFailures: observation.candidate.newFailures,
                  newSecretFindings: observation.candidate.newSecretFindings,
                  newEgressAttempts: observation.candidate.newEgressAttempts,
                },
                evidenceIDs: [...observation.evidenceIDs],
              })),
            })
            .pipe(
              Effect.map((result) => ({
                schema_version: 1 as const,
                candidate: skillCandidateView(result.candidate),
                report: skillEvaluationReportView(result.report),
              })),
              Effect.flatMap(decodeSkillEvaluationResult),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecycleCanaryObservation",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .recordCanaryObservation({
              identity,
              candidateID: ctx.params.candidateID,
              expectedRevision: ctx.payload.expectedRevision,
              idempotencyKey: ctx.payload.idempotencyKey,
              cohortKey: ctx.payload.cohortKey,
              runID: AgentRuntime.RunID.make(ctx.payload.runID),
              evaluationID: AgentRuntime.EvaluationID.make(ctx.payload.evaluationID),
              evidenceIDs: ctx.payload.evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(id)),
              success: ctx.payload.success,
              safetyIncident: ctx.payload.safetyIncident,
            })
            .pipe(
              Effect.map((result) => ({
                schema_version: 1 as const,
                candidate: skillCandidateView(result.candidate),
                observation_id: result.observationID,
                replayed: result.replayed,
              })),
              Effect.flatMap(decodeSkillCanaryObservationResult),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecycleCanaryStart",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .startCanary({
              identity,
              candidateID: ctx.params.candidateID,
              expectedRevision: ctx.payload.expectedRevision,
              trafficPercent: ctx.payload.trafficPercent,
              reason: ctx.payload.reason,
            })
            .pipe(
              Effect.map(skillCandidateView),
              Effect.flatMap(decodeSkillLifecycleCandidate),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecyclePromote",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .promote({
              identity,
              candidateID: ctx.params.candidateID,
              expectedRevision: ctx.payload.expectedRevision,
              reason: ctx.payload.reason,
            })
            .pipe(
              Effect.map((result) => ({
                schema_version: 1 as const,
                candidate: skillCandidateView(result.candidate),
                deployment: skillDeploymentView(result.deployment),
                receipt_digest: result.receiptDigest,
              })),
              Effect.flatMap(decodeSkillPromotionResult),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecycleRollback",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        return yield* response(
          store
            .rollback({
              identity,
              candidateID: ctx.params.candidateID,
              expectedRevision: ctx.payload.expectedRevision,
              reason: ctx.payload.reason,
            })
            .pipe(
              Effect.map((result) => ({
                schema_version: 1 as const,
                rolled_back: skillCandidateView(result.rolledBack),
                restored: skillCandidateView(result.restored),
                deployment: skillDeploymentView(result.deployment),
                receipt_digest: result.receiptDigest,
              })),
              Effect.flatMap(decodeSkillRollbackResult),
              Effect.mapError(lifecycleError),
            ),
        )
      }),
    )
    .handle(
      "agentCapability.skillLifecycleDeploymentGet",
      Effect.fn(function* (ctx) {
        const principal = yield* IdentityContext.Current
        const store = yield* SkillStoreV1.Service
        const identity = { tenantID: principal.tenantID, userID: principal.userID, actor: `user:${principal.userID}` }
        const deployment = yield* store
          .getDeployment(identity, ctx.params.skillID)
          .pipe(Effect.mapError(lifecycleError))
        if (!deployment)
          return yield* new InvalidRequestError({
            kind: "skill-deployment-not-found",
            message: `Skill deployment not found: ${ctx.params.skillID}`,
          })
        return yield* response(
          decodeSkillDeployment(skillDeploymentView(deployment)).pipe(Effect.mapError(lifecycleError)),
        )
      }),
    ),
)
