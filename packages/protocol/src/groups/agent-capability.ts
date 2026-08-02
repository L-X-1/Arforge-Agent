import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { Location } from "@arforge-ai/schema/location"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

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
              "Explicitly load file-state, permission, self-correction, feature-policy, and private release-governance diagnostics.",
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
        payload: Schema.Struct({ enabled: Schema.Boolean }),
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
        payload: Schema.Struct({ enabled: Schema.Boolean }),
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
        params: { runID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)) },
        query: LocationQuery,
        success: Location.response(AgentCapability.WorkflowRun),
        error: [InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get(
        "agentCapability.workflowRunEvents",
        "/api/agent-capabilities/workflow-runs/:runID/events",
        {
          params: { runID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)) },
          query: WorkflowEventQuery,
          success: Location.response(AgentCapability.WorkflowEventList),
          error: [InvalidRequestError, ServiceUnavailableError],
        },
      )
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
        params: { runID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)) },
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
        params: { runID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)) },
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
        params: { runID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)) },
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
    .annotateMerge(
      OpenApi.annotations({
        title: "agent capabilities",
        description:
          "Read-only, workspace-scoped access to the preserved Arforge Python capability engine, bounded repository telemetry, persisted run reports, and its typed quality gate.",
      }),
    )
