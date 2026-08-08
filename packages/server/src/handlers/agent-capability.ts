import { AgentV2 } from "@arforge-ai/core/agent"
import { AnalysisQuality } from "@arforge-ai/core/analysis/quality"
import { Plugins, PluginInstallRuntime } from "@arforge-ai/core/analysis/plugins"
import { RepoScale } from "@arforge-ai/core/analysis/repo-scale"
import { AnalysisRuns } from "@arforge-ai/core/analysis/runs"
import { EvolutionV2 } from "@arforge-ai/core/evolution"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { PermissionSaved } from "@arforge-ai/core/permission/saved"
import { ManagedSkillRegistry } from "@arforge-ai/core/skill/managed"
import { Database } from "@arforge-ai/core/database/database"
import { WorkflowGraphRuntime, discoverWorkflows, loadWorkflow, previewWorkflow, TERMINAL_NODE_STATUSES, type WorkflowDefinition as WorkflowDefinition2 } from "@arforge-ai/core/analysis/workflow-graph"
import type { RunReport } from "@arforge-ai/core/analysis/runs"
import { randomUUID } from "node:crypto"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { InvalidRequestError, ServiceUnavailableError } from "@arforge-ai/protocol/errors"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { accessSync, existsSync, constants as fsConstants } from "node:fs"
import { join } from "node:path"
import { Api } from "../api"
import { CAPABILITY_CATALOG, nativeFeatures, nativeHealth, nativeStatus } from "../capability-catalog"
import { response } from "../location"

const decodeHealth = Schema.decodeUnknownEffect(AgentCapability.Health)
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

const unavailable = () =>
  new ServiceUnavailableError({
    service: "arforge-agent-python",
    message: "Arforge Agent capability service is unavailable or returned an invalid response.",
  })

const infrastructureErrors = new Set([
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

function bridgeError(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return
  return {
    code: error.code,
    message:
      "message" in error && typeof error.message === "string"
        ? error.message
        : "The requested Arforge capability operation was rejected.",
  }
}

const capabilityError = (error: unknown) => {
  const bridge = bridgeError(error)
  if (!bridge || infrastructureErrors.has(bridge.code)) return unavailable()
  return new InvalidRequestError({
    kind: `agent-capability-${bridge.code.toLowerCase().replaceAll("_", "-")}`,
    message: bridge.message,
  })
}

const managementError = (error: unknown) => {
  const bridge = bridgeError(error)
  if (!bridge || infrastructureErrors.has(bridge.code)) return unavailable()
  return new InvalidRequestError({
    kind: `agent-management-${bridge.code.toLowerCase().replaceAll("_", "-")}`,
    message: bridge.message,
  })
}

const retired = (message: string) => Effect.fail(new InvalidRequestError({ kind: "agent-capability-retired", message }))

function workflowRuntime(db: unknown): WorkflowGraphRuntime {
  const client = db as {
    all: (sql: string, ...params: unknown[]) => Promise<unknown[]>
    run: (sql: string, ...params: unknown[]) => Promise<unknown>
  }
  return new WorkflowGraphRuntime({
    database: {
      query: async (sql, params = []) => (await client.all(sql, ...params)) as unknown as Array<Record<string, unknown>>,
      execute: async (sql, params = []) => {
        await client.run(sql, ...params)
        return undefined
      },
    },
  })
}

async function workflowRunView(runtime: WorkflowGraphRuntime, runId: string): Promise<Record<string, unknown>> {
  const run = await runtime.getRun(runId)
  const nodes = await runtime.nodesFor(runId)
  const byStatus: Record<string, number> = {}
  for (const node of nodes.values()) {
    byStatus[node.status] = (byStatus[node.status] ?? 0) + 1
  }
  const settled = [...nodes.values()].filter((node) => TERMINAL_NODE_STATUSES.has(node.status) || node.status === "waiting_approval").length
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
    })),
  }
}

const unavailableSection = (error: unknown) => {
  const bridge = bridgeError(error)
  return {
    status: "unavailable",
    code: bridge?.code ?? "BRIDGE_FAILURE",
    message: bridge?.message ?? "The Arforge capability section is temporarily unavailable.",
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
        return yield* response(Effect.succeed(nativeHealth()).pipe(Effect.flatMap(decodeHealth), Effect.mapError(unavailable)))
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
          ["subagent-roles", "Subagent roles", { count: roles.length, items: roles }],
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
            yield* Effect.succeed(nativeFeatures()).pipe(Effect.catch((error) => Effect.succeed(unavailableSection(error)))),
          ],
          ["permission-rules", "Agent permission rules", { count: rules.length, items: rules }],
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
            sections,
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
          ctx.payload.path === undefined || ctx.payload.path === "." ? location.directory : join(location.directory, ctx.payload.path)
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
        const registry = new ManagedSkillRegistry()
        return yield* response(
          Effect.succeed(registry.list(true)).pipe(Effect.flatMap(decodeManagedSkillList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.skillRead",
      Effect.fn(function* (ctx) {
        const registry = new ManagedSkillRegistry()
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
        const registry = new ManagedSkillRegistry()
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
        const registry = new ManagedSkillRegistry()
        return yield* response(
          Effect.try({
            try: () => registry.setEnabled(ctx.params.skillID, ctx.payload.enabled),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodeManagedSkillMutation), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.skillRefresh",
      Effect.fn(function* () {
        const registry = new ManagedSkillRegistry()
        return yield* response(
          Effect.succeed(registry.refresh()).pipe(Effect.flatMap(decodeManagedSkillList), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.pluginList",
      Effect.fn(function* () {
        return yield* response(
          Effect.succeed(Plugins.listPlugins()).pipe(Effect.flatMap(decodeManagedPluginList), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.customizationList",
      Effect.fn(function* () {
        return yield* retired("customization inspection was retired with the Python sidecar")
      }),
    )
    .handle(
      "agentCapability.customizationRender",
      Effect.fn(function* () {
        return yield* retired("customization rendering was retired with the Python sidecar")
      }),
    )
    .handle(
      "agentCapability.pluginSetEnabled",
      Effect.fn(function* (ctx) {
        const listed = Plugins.listPlugins()
        const matches = listed.items.filter((item) => item.name.toLowerCase() === ctx.params.name.toLowerCase())
        if (matches.length !== 1) {
          return yield* response(
            Effect.fail(new InvalidRequestError({ kind: "plugin-not-found", message: `plugin not found or ambiguous: ${ctx.params.name}` })),
          )
        }
        Plugins.setPluginEnabled(matches[0].manifest_path, ctx.payload.enabled)
        return yield* response(
          Effect.succeed(Plugins.listPlugins()).pipe(Effect.flatMap(decodeManagedPluginList), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.pluginInspect",
      Effect.fn(function* (ctx) {
        const runtime = new PluginInstallRuntime()
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
        const runtime = new PluginInstallRuntime()
        return yield* response(
          Effect.try({
            try: () => runtime.apply(ctx.payload.token, ctx.payload.name ?? "", ctx.payload.replace ?? false),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodePluginTransactionResult), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.pluginRemove",
      Effect.fn(function* (ctx) {
        const runtime = new PluginInstallRuntime()
        return yield* response(
          Effect.try({
            try: () => runtime.remove(ctx.params.name),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodePluginTransactionResult), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.pluginRestore",
      Effect.fn(function* (ctx) {
        const runtime = new PluginInstallRuntime()
        return yield* response(
          Effect.try({
            try: () => runtime.restore(ctx.payload.recoveryID),
            catch: (error) => error,
          }).pipe(Effect.flatMap(decodePluginTransactionResult), Effect.mapError(managementError)),
        )
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
              path,
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
        const resolved = join(location.directory, ctx.payload.path)
        let definition: WorkflowDefinition2
        try {
          definition = loadWorkflow(resolved, location.directory)
        } catch (error) {
          return yield* response(
            Effect.fail(new InvalidRequestError({ kind: "workflow-invalid-definition", message: error instanceof Error ? error.message : String(error) })),
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
            steps: definition.steps.map((step) => ({ id: step.id, title: step.title, status: "planned", output: "", error: "" })),
            edges: preview.edges,
            node_kinds: Object.fromEntries(definition.steps.map((step) => [step.id, step.kind])),
          }).pipe(Effect.flatMap(decodeWorkflowPreview), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRunList",
      Effect.fn(function* (ctx) {
        const database = yield* Database.Service
        const runtime = workflowRuntime(database.db)
        const listed = yield* Effect.tryPromise({
          try: () => runtime.listRuns({ sessionId: ctx.query.sessionID, limit: ctx.query.limit ?? 50 }),
          catch: (error) => error,
        }).pipe(Effect.mapError(capabilityError))
        const items = yield* Effect.forEach(
          listed.items,
          (item) =>
            Effect.tryPromise({ try: () => workflowRunView(runtime, String(item.run_id)), catch: (error) => error }).pipe(
              Effect.mapError(capabilityError),
            ),
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
        const database = yield* Database.Service
        const runtime = workflowRuntime(database.db)
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
        const database = yield* Database.Service
        const runtime = workflowRuntime(database.db)
        return yield* response(
          Effect.tryPromise({
            try: () => runtime.events(ctx.params.runID, ctx.query.after ?? 0, ctx.query.limit ?? 200),
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
        const database = yield* Database.Service
        const runtime = workflowRuntime(database.db)
        const resolved = join(location.directory, ctx.payload.path)
        const definition = loadWorkflow(resolved, location.directory)
        const created = yield* Effect.tryPromise({
          try: () =>
            runtime.createRun({
              definition,
              sessionId: ctx.payload.sessionID ?? `wf-${randomUUID()}`,
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
        const database = yield* Database.Service
        const runtime = workflowRuntime(database.db)
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
          }).pipe(Effect.flatMap((run) => Effect.tryPromise({ try: () => workflowRunView(runtime, run.run_id), catch: (error) => error })), Effect.flatMap(decodeWorkflowRun), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowApprove",
      Effect.fn(function* (ctx) {
        const database = yield* Database.Service
        const runtime = workflowRuntime(database.db)
        return yield* response(
          Effect.tryPromise({
            try: () => runtime.decideApproval(ctx.params.runID, ctx.payload.nodeID, ctx.payload.approved, ctx.payload.comment ?? ""),
            catch: (error) => error,
          }).pipe(Effect.flatMap((run) => Effect.tryPromise({ try: () => workflowRunView(runtime, run.run_id), catch: (error) => error })), Effect.flatMap(decodeWorkflowRun), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRetry",
      Effect.fn(function* (ctx) {
        const database = yield* Database.Service
        const runtime = workflowRuntime(database.db)
        return yield* response(
          Effect.tryPromise({
            try: () => runtime.retryNode(ctx.params.runID, ctx.payload.nodeID, ctx.payload.includeDescendants ?? true),
            catch: (error) => error,
          }).pipe(Effect.flatMap((run) => Effect.tryPromise({ try: () => workflowRunView(runtime, run.run_id), catch: (error) => error })), Effect.flatMap(decodeWorkflowRun), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionStatus",
      Effect.fn(function* () {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution.status().pipe(Effect.flatMap(decodeEvolutionStatus), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionCandidates",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .listCandidates({
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
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .listExposures({
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
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .previewExposureArchive({ keepRecorded: ctx.query.keepRecorded ?? 1000 })
            .pipe(Effect.flatMap(decodeEvolutionExposureArchivePlan), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchiveApply",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .applyExposureArchive({
              keepRecorded: ctx.payload.keepRecorded,
              expectedPlanDigest: ctx.payload.expectedPlanDigest,
              actor: "user:product",
              reason: ctx.payload.reason,
            })
            .pipe(Effect.flatMap(decodeEvolutionExposureArchiveResult), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchives",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .listExposureArchives({ limit: ctx.query.limit ?? 100 })
            .pipe(Effect.flatMap(decodeEvolutionExposureArchiveList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchiveGet",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .getExposureArchive(ctx.params.archiveID, { limit: ctx.query.limit ?? 500 })
            .pipe(Effect.flatMap(decodeEvolutionExposureArchiveDetail), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureRestorePreview",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .previewExposureRestore(ctx.params.archiveID)
            .pipe(Effect.flatMap(decodeEvolutionExposureRestorePlan), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureRestoreApply",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .applyExposureRestore({
              archiveId: ctx.params.archiveID,
              expectedPlanDigest: ctx.payload.expectedPlanDigest,
              actor: "user:product",
              reason: ctx.payload.reason,
            })
            .pipe(Effect.flatMap(decodeEvolutionExposureRestoreResult), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionExposureArchiveExport",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .exportExposureArchiveAudit(ctx.params.archiveID)
            .pipe(Effect.flatMap(decodeEvolutionExposureArchiveExport), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionAuditEvents",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .listAuditEvents({
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
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .getCandidate(ctx.params.candidateID)
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
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .createCandidate({
              title: ctx.payload.title,
              target: ctx.payload.target,
              instruction: ctx.payload.instruction,
              rationale: ctx.payload.rationale,
              evidenceRefs: [...ctx.payload.evidenceRefs],
              createdBy: "user:product",
            })
            .pipe(Effect.flatMap(decodeEvolutionCandidate), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionFromPattern",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        const learning = yield* LearningV2.Service
        const patterns = yield* learning.proposalCandidates().pipe(Effect.catch(() => Effect.succeed([] as never[])))
        const pattern = patterns.find((item) => String(item.id) === String(ctx.params.patternID))
        return yield* response(
          evolution
            .proposeLearningPattern(String(ctx.params.patternID), pattern)
            .pipe(Effect.flatMap(decodeEvolutionCandidate), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionTransition",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        const reason = ctx.payload.reason?.trim() ?? ""
        if (ctx.payload.action !== "evaluate" && !reason)
          return yield* new InvalidRequestError({
            kind: "evolution-reason-required",
            message: "A human-readable reason is required for governed Evolution lifecycle decisions.",
          })
        const common = {
          candidateId: ctx.params.candidateID,
          expectedRevision: ctx.payload.expectedRevision,
        } as const
        const effect =
          ctx.payload.action === "evaluate"
            ? evolution.evaluateCandidate(common.candidateId, common.expectedRevision)
            : ctx.payload.action === "approve"
              ? evolution.approveCandidate({ ...common, actor: "user:product", reason })
              : ctx.payload.action === "reject"
                ? evolution.rejectCandidate({ ...common, actor: "user:product", reason })
                : ctx.payload.action === "startCanary"
                  ? evolution.startCanary({
                      ...common,
                      actor: "user:product",
                      reason,
                      ...(ctx.payload.trafficPercent !== undefined ? { trafficPercent: ctx.payload.trafficPercent } : {}),
                    })
                  : ctx.payload.action === "promote"
                    ? evolution.promoteCandidate({ ...common, actor: "user:product", reason })
                    : evolution.rollbackCandidate({ ...common, actor: "user:product", reason })
        return yield* response(effect.pipe(Effect.flatMap(decodeEvolutionCandidate), Effect.mapError(managementError)))
      }),
    )
    .handle(
      "agentCapability.evolutionCanaryReport",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .canaryReport(ctx.params.candidateID)
            .pipe(Effect.flatMap(decodeEvolutionCanaryReport), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.evolutionContextPreview",
      Effect.fn(function* (ctx) {
        const evolution = yield* EvolutionV2.Service
        return yield* response(
          evolution
            .renderContext({ userInput: ctx.payload.userInput, cohortKey: ctx.payload.cohortKey })
            .pipe(Effect.flatMap(decodeEvolutionContextPreview), Effect.mapError(capabilityError)),
        )
      }),
    ),
)
