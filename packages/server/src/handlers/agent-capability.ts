import { AgentPython } from "@arforge-ai/core/agent-python"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { InvalidRequestError, ServiceUnavailableError } from "@arforge-ai/protocol/errors"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Api } from "../api"
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
  existsSync(join(root, "arforge", "__init__.py")) &&
  existsSync(join(root, "packages", "desktop"))

export const AgentCapabilityHandler = HttpApiBuilder.group(Api, "server.agentCapability", (handlers) =>
  handlers
    .handle(
      "agentCapability.health",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        return yield* response(bridge.call("health").pipe(Effect.flatMap(decodeHealth), Effect.mapError(unavailable)))
      }),
    )
    .handle(
      "agentCapability.list",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        const result = yield* bridge
          .call("capabilities.list")
          .pipe(Effect.flatMap(decodeList), Effect.mapError(unavailable))
        if (result.count !== result.items.length) return yield* unavailable()
        return yield* response(Effect.succeed(result))
      }),
    )
    .handle(
      "agentCapability.systemOverview",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        const definitions = [
          ["status", "Runtime status", "status.get"],
          ["runtime-stats", "Runtime statistics", "runtime.stats"],
          ["runtime-metrics", "Runtime metrics", "runtime.metrics"],
          ["sandbox", "Sandbox", "sandbox.status"],
          ["tools", "Tools", "tools.list"],
          ["subagent-roles", "Subagent roles", "subagents.roles"],
          ["cost-optimization", "Cost optimization", "cost.optimization"],
        ] as const
        const sections = yield* Effect.forEach(
          definitions,
          ([id, title, method]) =>
            bridge.call(method, {}, { timeoutMs: 8_000 }).pipe(
              Effect.map((data) => ({ id, title, data })),
              Effect.catch((error) =>
                Effect.succeed({
                  id,
                  title,
                  data: unavailableSection(error),
                }),
              ),
            ),
          // The Python Bridge is a serial worker. Keeping the aggregation
          // sequential prevents later sections from expiring while queued
          // behind an earlier probe.
          { concurrency: 1 },
        )
        return yield* response(
          decodeSystemOverview({
            schema_version: 1,
            sections,
          }).pipe(Effect.mapError(unavailable)),
        )
      }),
    )
    .handle(
      "agentCapability.deepInsights",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        const definitions = [
          ["features", "Feature policy", "features.list", {}],
          ["file-state", "Observed file state", "file_state.list", { limit: 200 }],
          ["permission-rules", "Agent permission rules", "permissions.rules", {}],
          ["permission-mode", "Agent permission mode", "permissions.mode.get", {}],
          ["self-correct", "Self-correction evaluation", "self_correct.eval", {}],
        ] as const
        const sections = yield* Effect.forEach(
          definitions,
          ([id, title, method, params]) =>
            bridge.call(method, params, { timeoutMs: method === "self_correct.eval" ? 20_000 : 8_000 }).pipe(
              Effect.map((data) => ({ id, title, data })),
              Effect.catch((error) =>
                Effect.succeed({
                  id,
                  title,
                  data: unavailableSection(error),
                }),
              ),
            ),
          { concurrency: 1 },
        )
        const workspace = yield* bridge
          .call<{ root?: unknown }>("workspace.get", {}, { timeoutMs: 3_000 })
          .pipe(Effect.catch(() => Effect.succeed({ root: undefined })))
        const releaseDefinitions = [
          ["release-gates", "Private release gates", "release.gates"],
          ["release-remediation", "Release remediation plan", "release.remediation_plan"],
        ] as const
        const releaseSections = isArforgeReleaseWorkspace(workspace.root)
          ? yield* Effect.forEach(
              releaseDefinitions,
              ([id, title, method]) =>
                bridge.call(method, {}, { timeoutMs: 8_000 }).pipe(
                  Effect.map((data) => ({ id, title, data })),
                  Effect.catch((error) =>
                    Effect.succeed({
                      id,
                      title,
                      data: unavailableSection(error),
                    }),
                  ),
                ),
              { concurrency: 1 },
            )
          : releaseDefinitions.map(([id, title]) => ({
              id,
              title,
              data: {
                status: "not_applicable",
                message: "Release gates apply only when the selected workspace is the Arforge product source root.",
              },
            }))
        return yield* response(
          decodeDeepInsights({
            schema_version: 1,
            sections: [...sections, ...releaseSections],
          }).pipe(Effect.mapError(unavailable)),
        )
      }),
    )
    .handle(
      "agentCapability.repoScale",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("repo.scale", {
              ...(ctx.payload.path === undefined ? {} : { path: ctx.payload.path }),
              ...(ctx.payload.query === undefined ? {} : { query: ctx.payload.query }),
              ...(ctx.payload.maxFiles === undefined ? {} : { max_files: ctx.payload.maxFiles }),
              ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
            })
            .pipe(Effect.flatMap(decodeRepoScaleReport), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.runList",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        const result = yield* bridge
          .call("run.list", { limit: ctx.query.limit ?? 20 })
          .pipe(Effect.flatMap(decodeRunList), Effect.mapError(capabilityError))
        if (result.count !== result.items.length) return yield* unavailable()
        return yield* response(Effect.succeed(result))
      }),
    )
    .handle(
      "agentCapability.runReport",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        const result = yield* bridge
          .call("run.report", ctx.query.runID === undefined ? {} : { run_id: ctx.query.runID })
          .pipe(Effect.flatMap(decodeRunReportResult), Effect.mapError(capabilityError))
        if (result.found && result.report.run_id !== result.run_id) return yield* unavailable()
        return yield* response(Effect.succeed(result))
      }),
    )
    .handle(
      "agentCapability.qualityAssess",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("quality.assess", {
              files: ctx.payload.files ?? [],
              ...(ctx.payload.patchText === undefined ? {} : { patch_text: ctx.payload.patchText }),
            })
            .pipe(Effect.flatMap(decodeQualityAssessment), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.skillList",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.call("skills.list", { cached: true }).pipe(
            Effect.flatMap(decodeManagedSkillList),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.skillRead",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("skills.read", {
              skill_id: ctx.params.skillID,
              max_chars: ctx.query.maxChars ?? 60_000,
            })
            .pipe(Effect.flatMap(decodeSkillReadResult), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.skillRoute",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("skills.route", { request: ctx.payload.request })
            .pipe(Effect.flatMap(decodeSkillRoute), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.skillSetEnabled",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .mutate(ctx.payload.enabled ? "skills.enable" : "skills.disable", { skill_id: ctx.params.skillID })
            .pipe(Effect.flatMap(decodeManagedSkillMutation), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.skillRefresh",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.mutate("skills.refresh").pipe(
            Effect.flatMap(decodeManagedSkillList),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.pluginList",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.mutate("plugins.list").pipe(
            Effect.flatMap(decodeManagedPluginList),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.customizationList",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.call("customizations.list").pipe(
            Effect.flatMap(decodeCustomizationList),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.customizationRender",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("customizations.render", {
              name: ctx.payload.name,
              args: ctx.payload.args ?? "",
            })
            .pipe(Effect.flatMap(decodeCustomizationRender), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.pluginSetEnabled",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .mutate("plugins.set_enabled", { name: ctx.params.name, enabled: ctx.payload.enabled })
            .pipe(Effect.flatMap(decodeManagedPluginList), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.pluginInspect",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.mutate("plugins.install.inspect", { source: ctx.payload.source }).pipe(
            Effect.flatMap(decodePluginInspection),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.pluginApply",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .mutate("plugins.install.apply", {
              token: ctx.payload.token,
              name: ctx.payload.name ?? "",
              replace: ctx.payload.replace ?? false,
            })
            .pipe(Effect.flatMap(decodePluginTransactionResult), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.pluginRemove",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.mutate("plugins.remove", { name: ctx.params.name }).pipe(
            Effect.flatMap(decodePluginTransactionResult),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.pluginRestore",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.mutate("plugins.restore", { recovery_id: ctx.payload.recoveryID }).pipe(
            Effect.flatMap(decodePluginTransactionResult),
            Effect.mapError(managementError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.workflowList",
      Effect.fn(function* () {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.call("workflows.list").pipe(
            Effect.flatMap(decodeWorkflowDefinitionList),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.workflowPreview",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.call("workflows.preview", { path: ctx.payload.path }).pipe(
            Effect.flatMap(decodeWorkflowPreview),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRunList",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("workflow.graph.list", {
              ...(ctx.query.sessionID === undefined ? {} : { session_id: ctx.query.sessionID }),
              limit: ctx.query.limit ?? 50,
            })
            .pipe(Effect.flatMap(decodeWorkflowRunList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRunGet",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge.call("workflow.graph.get", { run_id: ctx.params.runID }).pipe(
            Effect.flatMap(decodeWorkflowRun),
            Effect.mapError(capabilityError),
          ),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRunEvents",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("workflow.graph.events", {
              run_id: ctx.params.runID,
              after: ctx.query.after ?? 0,
              limit: ctx.query.limit ?? 200,
            })
            .pipe(Effect.flatMap(decodeWorkflowEventList), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.planPreview",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("plan.preview", {
              task: ctx.payload.task,
              plan_text: ctx.payload.planText,
              explored_files: ctx.payload.exploredFiles ?? [],
              ...(ctx.payload.estimatedSteps === undefined
                ? {}
                : { estimated_steps: ctx.payload.estimatedSteps }),
            })
            .pipe(Effect.flatMap(decodePlanPreview), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.runTraceExport",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .call("run.trace.export", { run_id: ctx.params.runID })
            .pipe(Effect.flatMap(decodeRunTraceExport), Effect.mapError(capabilityError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowStart",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .mutate(
              "workflow.graph.start",
              {
                path: ctx.payload.path,
                ...(ctx.payload.sessionID === undefined ? {} : { session_id: ctx.payload.sessionID }),
                permission_mode: ctx.payload.permissionMode ?? "acceptEdits",
                max_parallel: ctx.payload.maxParallel ?? 4,
              },
              { timeoutMs: 300_000 },
            )
            .pipe(Effect.flatMap(decodeWorkflowRun), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowControl",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        const method =
          ctx.payload.action === "pause"
            ? "workflow.graph.pause"
            : ctx.payload.action === "resume"
              ? "workflow.graph.resume"
              : "workflow.graph.cancel"
        return yield* response(
          bridge
            .mutate(method, { run_id: ctx.params.runID }, { timeoutMs: 300_000 })
            .pipe(Effect.flatMap(decodeWorkflowRun), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowApprove",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .mutate("workflow.graph.approve", {
              run_id: ctx.params.runID,
              node_id: ctx.payload.nodeID,
              approved: ctx.payload.approved,
              ...(ctx.payload.comment === undefined ? {} : { comment: ctx.payload.comment }),
            })
            .pipe(Effect.flatMap(decodeWorkflowRun), Effect.mapError(managementError)),
        )
      }),
    )
    .handle(
      "agentCapability.workflowRetry",
      Effect.fn(function* (ctx) {
        const bridge = yield* AgentPython.Service
        return yield* response(
          bridge
            .mutate("workflow.graph.retry", {
              run_id: ctx.params.runID,
              node_id: ctx.payload.nodeID,
              include_descendants: ctx.payload.includeDescendants ?? true,
            })
            .pipe(Effect.flatMap(decodeWorkflowRun), Effect.mapError(managementError)),
        )
      }),
    ),
)
