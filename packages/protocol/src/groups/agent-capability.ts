import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Location } from "@arforge-ai/schema/location"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ControlRequestID = AgentRuntime.ControlPlaneRequestID.pipe(Schema.optional)

const RunListQuery = Schema.Struct({
  ...LocationQuery.fields,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.optional),
})

const RunReportQuery = Schema.Struct({
  ...LocationQuery.fields,
  runID: AgentCapability.RunID.pipe(Schema.optional),
})

const SkillReadQuery = Schema.Struct({
  ...LocationQuery.fields,
  maxChars: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 })).pipe(Schema.optional),
})

const WorkflowEventQuery = Schema.Struct({
  ...LocationQuery.fields,
  after: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 })).pipe(Schema.optional),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).pipe(Schema.optional),
})

const SkillResourceOutcomePayload = Schema.Struct({
  success: Schema.Boolean,
  steps: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  tokens: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  costMinor: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  newFailures: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  newSecretFindings: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  newEgressAttempts: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})

const SkillEvaluationObservationPayload = Schema.Struct({
  caseID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  baseline: SkillResourceOutcomePayload,
  candidate: SkillResourceOutcomePayload,
  evidenceIDs: Schema.Array(Schema.String.check(Schema.isTrimmed(), Schema.isStartsWith("evd_"))).check(
    Schema.isMinLength(1),
  ),
})

export const makeAgentCapabilityGroup = <I extends HttpApiMiddleware.AnyId, S>(locationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.agentCapability")
    .add(
      HttpApiEndpoint.get("agentCapability.health", "/api/agent-capabilities/health", {
        query: LocationQuery,
        success: Location.response(AgentCapability.Health),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.list", "/api/agent-capabilities", {
        query: LocationQuery,
        success: Location.response(AgentCapability.List),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.systemOverview", "/api/agent-capabilities/system-overview", {
        query: LocationQuery,
        success: Location.response(AgentCapability.SystemOverview),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.agentCapability.systemOverview",
            summary: "Get Agent system overview",
            description:
              "Aggregate safe read-only runtime, sandbox, tool, subagent-role, and cost signals for the control center.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.deepInsights", "/api/agent-capabilities/deep-insights", {
        query: LocationQuery,
        success: Location.response(AgentCapability.DeepInsights),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.agentCapability.deepInsights",
            summary: "Run deep Agent diagnostics",
            description:
              "Explicitly load file-state, memory-feedback, feature-policy, permission-policy, permission, self-correction, and private release-governance diagnostics.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.repoScale", "/api/agent-capabilities/repository-scale", {
        query: LocationQuery,
        payload: Schema.Struct({
          path: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)).pipe(
            Schema.optional,
          ),
          query: Schema.String.check(Schema.isMaxLength(300)).pipe(Schema.optional),
          maxFiles: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })).pipe(Schema.optional),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.RepoScaleReport),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.runList", "/api/agent-capabilities/runs", {
        query: RunListQuery,
        success: Location.response(AgentCapability.RunList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.runReport", "/api/agent-capabilities/run-report", {
        query: RunReportQuery,
        success: Location.response(AgentCapability.RunReportResult),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.qualityAssess", "/api/agent-capabilities/quality", {
        query: LocationQuery,
        payload: Schema.Struct({
          files: Schema.Array(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_096)))
            .check(Schema.isMaxLength(200))
            .pipe(Schema.optional),
          patchText: Schema.String.check(Schema.isMaxLength(500_000)).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.QualityAssessment),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.skillList", "/api/agent-capabilities/skills", {
        query: LocationQuery,
        success: Location.response(AgentCapability.ManagedSkillList),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.skillRead", "/api/agent-capabilities/skills/:skillID", {
        params: { skillID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)) },
        query: SkillReadQuery,
        success: Location.response(AgentCapability.SkillReadResult),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.skillRoute", "/api/agent-capabilities/skills/route", {
        query: LocationQuery,
        payload: Schema.Struct({
          request: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
        }),
        success: Location.response(AgentCapability.SkillRoute),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.skillSetEnabled", "/api/agent-capabilities/skills/:skillID/enabled", {
        params: { skillID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)) },
        query: LocationQuery,
        payload: Schema.Struct({ enabled: Schema.Boolean, requestID: ControlRequestID }),
        success: Location.response(AgentCapability.ManagedSkillMutation),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.skillRefresh", "/api/agent-capabilities/skills/refresh", {
        query: LocationQuery,
        success: Location.response(AgentCapability.ManagedSkillList),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.pluginList", "/api/agent-capabilities/plugins", {
        query: LocationQuery,
        success: Location.response(AgentCapability.ManagedPluginList),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.customizationList", "/api/agent-capabilities/customizations", {
        query: LocationQuery,
        success: Location.response(AgentCapability.CustomizationList),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.customizationRender", "/api/agent-capabilities/customizations/render", {
        query: LocationQuery,
        payload: Schema.Struct({
          name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
          args: Schema.String.check(Schema.isMaxLength(20_000)).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.CustomizationRender),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.pluginSetEnabled", "/api/agent-capabilities/plugins/:name/enabled", {
        params: { name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)) },
        query: LocationQuery,
        payload: Schema.Struct({ enabled: Schema.Boolean, requestID: ControlRequestID }),
        success: Location.response(AgentCapability.ManagedPluginList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.pluginInspect", "/api/agent-capabilities/plugins/install/inspect", {
        query: LocationQuery,
        payload: Schema.Struct({
          source: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
        }),
        success: Location.response(AgentCapability.PluginInspection),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.pluginApply", "/api/agent-capabilities/plugins/install/apply", {
        query: LocationQuery,
        payload: Schema.Struct({
          token: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)),
          name: Schema.String.check(Schema.isMaxLength(64)).pipe(Schema.optional),
          replace: Schema.Boolean.pipe(Schema.optional),
          requestID: ControlRequestID,
        }),
        success: Location.response(AgentCapability.PluginTransactionResult),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.pluginRemove", "/api/agent-capabilities/plugins/:name/remove", {
        params: { name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)) },
        query: LocationQuery,
        payload: Schema.Struct({ requestID: ControlRequestID }),
        success: Location.response(AgentCapability.PluginTransactionResult),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.pluginRestore", "/api/agent-capabilities/plugins/restore", {
        query: LocationQuery,
        payload: Schema.Struct({
          recoveryID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)),
          requestID: ControlRequestID,
        }),
        success: Location.response(AgentCapability.PluginTransactionResult),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.workflowList", "/api/agent-capabilities/workflows", {
        query: LocationQuery,
        success: Location.response(AgentCapability.WorkflowDefinitionList),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.workflowPreview", "/api/agent-capabilities/workflows/preview", {
        query: LocationQuery,
        payload: Schema.Struct({
          path: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
        }),
        success: Location.response(AgentCapability.WorkflowPreview),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.workflowRunList", "/api/agent-capabilities/workflow-runs", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          sessionID: Schema.String.check(Schema.isMaxLength(256)).pipe(Schema.optional),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.WorkflowRunList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.workflowRunGet", "/api/agent-capabilities/workflow-runs/:runID", {
        params: { runID: AgentRuntime.RunID },
        query: LocationQuery,
        success: Location.response(AgentCapability.WorkflowRun),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.workflowRunEvents", "/api/agent-capabilities/workflow-runs/:runID/events", {
        params: { runID: AgentRuntime.RunID },
        query: WorkflowEventQuery,
        success: Location.response(AgentCapability.WorkflowEventList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.planPreview", "/api/agent-capabilities/plan-preview", {
        query: LocationQuery,
        payload: Schema.Struct({
          task: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
          planText: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(20_000)),
          exploredFiles: Schema.Array(
            Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
          )
            .check(Schema.isMaxLength(50))
            .pipe(Schema.optional),
          estimatedSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.PlanPreview),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.runTraceExport", "/api/agent-capabilities/runs/:runID/trace", {
        params: { runID: AgentCapability.RunID },
        query: LocationQuery,
        success: Location.response(AgentCapability.RunTraceExport),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.workflowStart", "/api/agent-capabilities/workflow-runs/start", {
        query: LocationQuery,
        payload: Schema.Struct({
          path: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
          sessionID: Schema.String.check(Schema.isMaxLength(256)).pipe(Schema.optional),
          permissionMode: Schema.Literals(["plan", "acceptEdits", "fullAccess"]).pipe(Schema.optional),
          maxParallel: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.WorkflowRun),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.workflowControl", "/api/agent-capabilities/workflow-runs/:runID/control", {
        params: { runID: AgentRuntime.RunID },
        query: LocationQuery,
        payload: Schema.Struct({ action: Schema.Literals(["pause", "resume", "cancel"]) }),
        success: Location.response(AgentCapability.WorkflowRun),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.workflowApprove", "/api/agent-capabilities/workflow-runs/:runID/approve", {
        params: { runID: AgentRuntime.RunID },
        query: LocationQuery,
        payload: Schema.Struct({
          nodeID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
          approved: Schema.Boolean,
          comment: Schema.String.check(Schema.isMaxLength(1_000)).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.WorkflowRun),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.workflowRetry", "/api/agent-capabilities/workflow-runs/:runID/retry", {
        params: { runID: AgentRuntime.RunID },
        query: LocationQuery,
        payload: Schema.Struct({
          nodeID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
          includeDescendants: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.WorkflowRun),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.evolutionStatus", "/api/agent-capabilities/evolution/status", {
        query: LocationQuery,
        success: Location.response(AgentCapability.EvolutionStatus),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.evolutionCandidates", "/api/agent-capabilities/evolution/candidates", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          status: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(32)).pipe(Schema.optional),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.EvolutionCandidateList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.evolutionExposures", "/api/agent-capabilities/evolution/exposures", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          status: Schema.Literals(["pending", "recorded"]).pipe(Schema.optional),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.EvolutionExposureList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.evolutionExposureArchivePreview",
        "/api/agent-capabilities/evolution/exposures/archive",
        {
          query: Schema.Struct({
            ...LocationQuery.fields,
            keepRecorded: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })).pipe(Schema.optional),
          }),
          success: Location.response(AgentCapability.EvolutionExposureArchivePlan),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.evolutionExposureArchiveApply",
        "/api/agent-capabilities/evolution/exposures/archive/apply",
        {
          query: LocationQuery,
          payload: Schema.Struct({
            keepRecorded: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
            expectedPlanDigest: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^[0-9a-f]{64}$/)),
            reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
          }),
          success: Location.response(AgentCapability.EvolutionExposureArchiveResult),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.evolutionExposureArchives",
        "/api/agent-capabilities/evolution/exposures/archives",
        {
          query: Schema.Struct({
            ...LocationQuery.fields,
            limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
          }),
          success: Location.response(AgentCapability.EvolutionExposureArchiveList),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.evolutionExposureArchiveGet",
        "/api/agent-capabilities/evolution/exposures/archives/:archiveID",
        {
          params: {
            archiveID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^xa-[0-9a-f]{24}$/)),
          },
          query: Schema.Struct({
            ...LocationQuery.fields,
            limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
          }),
          success: Location.response(AgentCapability.EvolutionExposureArchiveDetail),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.evolutionExposureRestorePreview",
        "/api/agent-capabilities/evolution/exposures/archives/:archiveID/restore",
        {
          params: {
            archiveID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^xa-[0-9a-f]{24}$/)),
          },
          query: LocationQuery,
          success: Location.response(AgentCapability.EvolutionExposureRestorePlan),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.evolutionExposureRestoreApply",
        "/api/agent-capabilities/evolution/exposures/archives/:archiveID/restore/apply",
        {
          params: {
            archiveID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^xa-[0-9a-f]{24}$/)),
          },
          query: LocationQuery,
          payload: Schema.Struct({
            expectedPlanDigest: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^[0-9a-f]{64}$/)),
            reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
          }),
          success: Location.response(AgentCapability.EvolutionExposureRestoreResult),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.evolutionExposureArchiveExport",
        "/api/agent-capabilities/evolution/exposures/archives/:archiveID/export",
        {
          params: {
            archiveID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^xa-[0-9a-f]{24}$/)),
          },
          query: LocationQuery,
          success: Location.response(AgentCapability.EvolutionExposureArchiveExport),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.evolutionAuditEvents", "/api/agent-capabilities/evolution/audit/events", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
          beforeSequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })).pipe(
            Schema.optional,
          ),
        }),
        success: Location.response(AgentCapability.EvolutionAuditEventList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.evolutionCandidateGet",
        "/api/agent-capabilities/evolution/candidates/:candidateID",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32)) },
          query: LocationQuery,
          success: Location.response(AgentCapability.EvolutionCandidate),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.evolutionOpportunities", "/api/agent-capabilities/evolution/opportunities", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.EvolutionOpportunityList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.evolutionCreate", "/api/agent-capabilities/evolution/candidates", {
        query: LocationQuery,
        payload: Schema.Struct({
          title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
          target: Schema.Literals([
            "learning.failure",
            "learning.fix",
            "learning.preference",
            "routing.advice",
            "tool.advice",
          ]),
          instruction: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_000)),
          rationale: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
          evidenceRefs: Schema.Array(
            Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
          ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
          sourceExperienceIDs: Schema.Array(
            Schema.String.check(Schema.isTrimmed(), Schema.isStartsWith("exp_"), Schema.isMaxLength(160)),
          )
            .check(Schema.isMaxLength(20))
            .pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.EvolutionCandidate),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.evolutionFromPattern",
        "/api/agent-capabilities/evolution/patterns/:patternID/candidate",
        {
          params: { patternID: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) },
          query: LocationQuery,
          success: Location.response(AgentCapability.EvolutionCandidate),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.evolutionTransition",
        "/api/agent-capabilities/evolution/candidates/:candidateID/transition",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32)) },
          query: LocationQuery,
          payload: Schema.Struct({
            action: Schema.Literals(["evaluate", "approve", "reject", "startCanary", "promote", "rollback"]),
            expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            reason: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(500)).pipe(Schema.optional),
            trafficPercent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.optional),
          }),
          success: Location.response(AgentCapability.EvolutionCandidate),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.evolutionCanaryReport",
        "/api/agent-capabilities/evolution/candidates/:candidateID/canary",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32)) },
          query: LocationQuery,
          success: Location.response(AgentCapability.EvolutionCanaryReport),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("agentCapability.evolutionContextPreview", "/api/agent-capabilities/evolution/context", {
        query: LocationQuery,
        payload: Schema.Struct({
          userInput: Schema.String.check(Schema.isMaxLength(20_000)),
          cohortKey: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
        }),
        success: Location.response(AgentCapability.EvolutionContextPreview),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.experienceCandidateList", "/api/agent-capabilities/experience/candidates", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          status: Schema.Literals(["candidate", "active", "rejected", "expired"]).pipe(Schema.optional),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.ExperienceCandidateList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.experienceCandidateGet",
        "/api/agent-capabilities/experience/candidates/:candidateID",
        {
          params: {
            candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^exc_[A-Za-z0-9_-]{8,255}$/)),
          },
          query: LocationQuery,
          success: Location.response(AgentCapability.ExperienceCandidate),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.experienceCandidateReview",
        "/api/agent-capabilities/experience/candidates/:candidateID/review",
        {
          params: {
            candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^exc_[A-Za-z0-9_-]{8,255}$/)),
          },
          query: LocationQuery,
          payload: Schema.Struct({
            expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            decision: Schema.Literals(["approve", "reject"]),
            reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
          }),
          success: Location.response(AgentCapability.ExperienceReviewResult),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("agentCapability.experienceSourceList", "/api/agent-capabilities/experience/sources", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
        }),
        success: Location.response(AgentCapability.ExperienceSourceList),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.skillLifecycleCandidateList",
        "/api/agent-capabilities/skill-lifecycle/candidates",
        {
          query: Schema.Struct({
            ...LocationQuery.fields,
            skillID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)).pipe(
              Schema.optional,
            ),
            status: Schema.Literals(["draft", "candidate", "canary", "active", "retired"]).pipe(Schema.optional),
            limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(Schema.optional),
          }),
          success: Location.response(AgentCapability.SkillLifecycleCandidateList),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.skillLifecycleCandidateGet",
        "/api/agent-capabilities/skill-lifecycle/candidates/:candidateID",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^skc_[0-9a-f]{24}$/)) },
          query: LocationQuery,
          success: Location.response(AgentCapability.SkillLifecycleCandidateDetail),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.skillLifecycleCandidateCreate",
        "/api/agent-capabilities/skill-lifecycle/candidates",
        {
          query: LocationQuery,
          payload: Schema.Struct({
            skillID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),
            version: Schema.String.check(
              Schema.isTrimmed(),
              Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
              Schema.isMaxLength(64),
            ),
            purpose: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
            triggers: Schema.Array(
              Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
            ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
            allowedTools: Schema.Array(
              Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
            ).check(Schema.isMaxLength(100)),
            allowedCapabilities: Schema.Array(
              Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
            ).check(Schema.isMaxLength(100)),
            inputSchema: Schema.Record(Schema.String, Schema.Unknown),
            outputSchema: Schema.Record(Schema.String, Schema.Unknown),
            instructions: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
            assets: Schema.Array(
              Schema.Struct({
                path: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
                content: Schema.String.check(Schema.isMaxLength(100_000)),
              }),
            )
              .check(Schema.isMaxLength(63))
              .pipe(Schema.optional),
            scripts: Schema.Array(
              Schema.Struct({
                path: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
                content: Schema.String.check(Schema.isMaxLength(100_000)),
              }),
            )
              .check(Schema.isMaxLength(63))
              .pipe(Schema.optional),
            sourceExperienceIDs: Schema.Array(
              Schema.String.check(Schema.isTrimmed(), Schema.isStartsWith("exp_"), Schema.isMaxLength(160)),
            ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
            testCases: Schema.Array(
              Schema.Struct({
                id: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
                input: Schema.Record(Schema.String, Schema.Unknown),
                expected: Schema.Record(Schema.String, Schema.Unknown),
              }),
            ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
            policyVersion: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(120)),
          }),
          success: Location.response(AgentCapability.SkillLifecycleCandidate),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.skillLifecycleEvaluate",
        "/api/agent-capabilities/skill-lifecycle/candidates/:candidateID/evaluate",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^skc_[0-9a-f]{24}$/)) },
          query: LocationQuery,
          payload: Schema.Struct({
            expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            observations: Schema.Array(SkillEvaluationObservationPayload).check(
              Schema.isMinLength(1),
              Schema.isMaxLength(100),
            ),
          }),
          success: Location.response(AgentCapability.SkillEvaluationResult),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.skillLifecycleCanaryObservation",
        "/api/agent-capabilities/skill-lifecycle/candidates/:candidateID/canary/observations",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^skc_[0-9a-f]{24}$/)) },
          query: LocationQuery,
          payload: Schema.Struct({
            expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            idempotencyKey: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
            cohortKey: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
            runID: Schema.String.check(Schema.isTrimmed(), Schema.isStartsWith("run_")),
            evaluationID: Schema.String.check(Schema.isTrimmed(), Schema.isStartsWith("eva_")),
            evidenceIDs: Schema.Array(Schema.String.check(Schema.isTrimmed(), Schema.isStartsWith("evd_"))).check(
              Schema.isMinLength(1),
            ),
            success: Schema.Boolean,
            safetyIncident: Schema.Boolean,
          }),
          success: Location.response(AgentCapability.SkillCanaryObservationResult),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.skillLifecycleCanaryStart",
        "/api/agent-capabilities/skill-lifecycle/candidates/:candidateID/canary",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^skc_[0-9a-f]{24}$/)) },
          query: LocationQuery,
          payload: Schema.Struct({
            expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            trafficPercent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
            reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
          }),
          success: Location.response(AgentCapability.SkillLifecycleCandidate),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.skillLifecyclePromote",
        "/api/agent-capabilities/skill-lifecycle/candidates/:candidateID/promote",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^skc_[0-9a-f]{24}$/)) },
          query: LocationQuery,
          payload: Schema.Struct({
            expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
          }),
          success: Location.response(AgentCapability.SkillPromotionResult),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post(
        "agentCapability.skillLifecycleRollback",
        "/api/agent-capabilities/skill-lifecycle/candidates/:candidateID/rollback",
        {
          params: { candidateID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^skc_[0-9a-f]{24}$/)) },
          query: LocationQuery,
          payload: Schema.Struct({
            expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
            reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
          }),
          success: Location.response(AgentCapability.SkillRollbackResult),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.skillLifecycleDeploymentGet",
        "/api/agent-capabilities/skill-lifecycle/deployments/:skillID",
        {
          params: {
            skillID: Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),
          },
          query: LocationQuery,
          success: Location.response(AgentCapability.SkillDeployment),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "agent capabilities",
        description:
          "Workspace-scoped access to the native TypeScript capability runtime, bounded repository telemetry, persisted run reports, and typed quality gates.",
      }),
    )
