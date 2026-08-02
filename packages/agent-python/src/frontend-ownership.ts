import type { BridgeMethod } from "./protocol"

export type BridgeOwnershipKind = "typed-server-endpoint" | "core-authoritative-duplicate" | "transport-internal"
export type BridgeOwnershipSurface =
  | "global-control-center"
  | "session-control-center"
  | "workspace-surface"
  | "transport"

export interface BridgeFrontendOwnership {
  readonly kind: BridgeOwnershipKind
  readonly surface: BridgeOwnershipSurface
  readonly feature: string
  readonly methods: readonly BridgeMethod[]
  readonly replacement: readonly string[]
  readonly reason: string
}

/**
 * Scheme B ownership contract for the Python JSONL Bridge.
 *
 * This is not a menu manifest. It proves that every callable Bridge method is
 * either owned by a typed user-semantic Server surface, superseded by a
 * stronger Core contract, or intentionally private transport metadata.
 */
export const BRIDGE_FRONTEND_OWNERSHIP = [
  {
    kind: "transport-internal",
    surface: "transport",
    feature: "bridge-negotiation",
    methods: ["protocol.describe"],
    replacement: [],
    reason: "Protocol/version negotiation belongs to the sidecar transport and is never a user action.",
  },
  {
    kind: "typed-server-endpoint",
    surface: "global-control-center",
    feature: "agent-health-capability-catalog",
    methods: ["health", "capabilities.list"],
    replacement: ["agentCapabilities.health", "agentCapabilities.list"],
    reason: "The control center exposes a decoded health result and capability catalog.",
  },
  {
    kind: "typed-server-endpoint",
    surface: "global-control-center",
    feature: "system-overview",
    methods: [
      "status.get",
      "tools.list",
      "runtime.stats",
      "runtime.metrics",
      "subagents.roles",
      "cost.optimization",
      "sandbox.status",
    ],
    replacement: ["agentCapabilities.systemOverview"],
    reason: "These read-only signals are aggregated into one bounded overview instead of seven unrelated buttons.",
  },
  {
    kind: "core-authoritative-duplicate",
    surface: "global-control-center",
    feature: "agent-and-workspace-authority",
    methods: ["agents.list", "config.get", "workspace.get"],
    replacement: ["agents.list", "location.get", "settings surfaces"],
    reason: "Core already owns active agents, location/workspace identity, and product settings.",
  },
  {
    kind: "core-authoritative-duplicate",
    surface: "global-control-center",
    feature: "memory-learning-authority",
    methods: [
      "learning.status",
      "memory.status",
      "memory.search",
      "memory.facets",
      "memory.governance.preview",
      "memory.semantic_search",
      "memory.recall_quality",
    ],
    replacement: [
      "learning.status",
      "memories.status",
      "memories.list",
      "memories.facets",
      "memories.governancePreview",
      "memories.semantic",
      "memories.recallQuality",
    ],
    reason: "The Core memory/learning API is typed, persistent, paginated, and already owns frontend state.",
  },
  {
    kind: "typed-server-endpoint",
    surface: "global-control-center",
    feature: "skill-management-and-routing",
    methods: ["skills.list", "skills.read", "skills.route", "skills.enable", "skills.disable", "skills.refresh"],
    replacement: [
      "agentCapabilities.skillList",
      "agentCapabilities.skillRead",
      "agentCapabilities.skillRoute",
      "agentCapabilities.skillSetEnabled",
      "agentCapabilities.skillRefresh",
    ],
    reason: "Skill lifecycle, content inspection, and deterministic routing share one extension-management surface.",
  },
  {
    kind: "typed-server-endpoint",
    surface: "global-control-center",
    feature: "customization-inspection",
    methods: ["customizations.list", "customizations.render"],
    replacement: ["agentCapabilities.customizationList", "agentCapabilities.customizationRender"],
    reason: "Custom commands and Hooks are inspectable; rendering never executes a Hook.",
  },
  {
    kind: "typed-server-endpoint",
    surface: "global-control-center",
    feature: "deep-agent-diagnostics",
    methods: [
      "features.list",
      "file_state.list",
      "permissions.rules",
      "permissions.mode.get",
      "self_correct.eval",
      "release.gates",
      "release.remediation_plan",
    ],
    replacement: ["agentCapabilities.deepInsights"],
    reason: "Potentially expensive private diagnostics load only after an explicit user action.",
  },
  {
    kind: "typed-server-endpoint",
    surface: "global-control-center",
    feature: "repository-quality-and-run-evidence",
    methods: ["repo.scale", "quality.assess", "plan.preview", "run.list", "run.report", "run.trace.export"],
    replacement: [
      "agentCapabilities.repoScale",
      "agentCapabilities.qualityAssess",
      "agentCapabilities.planPreview",
      "agentCapabilities.runList",
      "agentCapabilities.runReport",
      "agentCapabilities.runTraceExport",
    ],
    reason: "Repository analysis, plan normalization, persisted reports, and portable traces are typed diagnostics.",
  },
  {
    kind: "core-authoritative-duplicate",
    surface: "workspace-surface",
    feature: "workspace-diagnostics-authority",
    methods: ["multimodal.diagnose", "git.status", "git.diff"],
    replacement: ["diagnostics.diagnose", "files and VCS workspace surfaces"],
    reason: "Core owns multimodal diagnostics and live workspace/VCS state; a second Bridge state source would drift.",
  },
  {
    kind: "typed-server-endpoint",
    surface: "global-control-center",
    feature: "workflow-definition-and-run",
    methods: [
      "workflows.list",
      "workflows.preview",
      "workflow.graph.list",
      "workflow.graph.get",
      "workflow.graph.events",
      "workflow.graph.start",
      "workflow.graph.pause",
      "workflow.graph.resume",
      "workflow.graph.cancel",
      "workflow.graph.approve",
      "workflow.graph.retry",
    ],
    replacement: [
      "agentCapabilities.workflowList",
      "agentCapabilities.workflowPreview",
      "agentCapabilities.workflowRunList",
      "agentCapabilities.workflowRunGet",
      "agentCapabilities.workflowRunEvents",
      "agentCapabilities.workflowStart",
      "agentCapabilities.workflowControl",
      "agentCapabilities.workflowApprove",
      "agentCapabilities.workflowRetry",
    ],
    reason: "Workflow definitions, events, approval, retry, and lifecycle control are one coherent product surface.",
  },
  {
    kind: "typed-server-endpoint",
    surface: "global-control-center",
    feature: "plugin-transaction-lifecycle",
    methods: [
      "plugins.list",
      "plugins.set_enabled",
      "plugins.install.inspect",
      "plugins.install.apply",
      "plugins.remove",
      "plugins.restore",
    ],
    replacement: [
      "agentCapabilities.pluginList",
      "agentCapabilities.pluginSetEnabled",
      "agentCapabilities.pluginInspect",
      "agentCapabilities.pluginApply",
      "agentCapabilities.pluginRemove",
      "agentCapabilities.pluginRestore",
    ],
    reason: "The frontend preserves two-phase inspection/apply and recoverable removal semantics.",
  },
] as const satisfies readonly BridgeFrontendOwnership[]

export const mappedBridgeMethods = () => BRIDGE_FRONTEND_OWNERSHIP.flatMap((entry) => [...entry.methods])

export const ownershipForBridgeMethod = (method: BridgeMethod) =>
  BRIDGE_FRONTEND_OWNERSHIP.find((entry) => entry.methods.some((candidate) => candidate === method))
