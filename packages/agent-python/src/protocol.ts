export const BRIDGE_PROTOCOL = "arforge.bridge" as const
export const BRIDGE_VERSION = "1.2" as const
export const MAX_BRIDGE_LINE_BYTES = 1024 * 1024

export const READ_ONLY_METHODS = [
  "protocol.describe",
  "health",
  "status.get",
  "tools.list",
  "agents.list",
  "capabilities.list",
  "config.get",
  "workspace.get",
  "runtime.stats",
  "runtime.metrics",
  "subagents.roles",
  "learning.status",
  "memory.status",
  "memory.search",
  "memory.facets",
  "memory.governance.preview",
  "memory.semantic_search",
  "memory.recall_quality",
  "skills.list",
  "skills.read",
  "skills.route",
  "customizations.list",
  "customizations.render",
  "features.list",
  "file_state.list",
  "cost.optimization",
  "repo.scale",
  "quality.assess",
  "sandbox.status",
  "permissions.rules",
  "permissions.mode.get",
  "self_correct.eval",
  "plan.preview",
  "run.list",
  "run.report",
  "run.trace.export",
  "multimodal.diagnose",
  "git.status",
  "git.diff",
  "workflows.list",
  "workflows.preview",
  "workflow.graph.list",
  "workflow.graph.get",
  "workflow.graph.events",
  "release.gates",
  "release.remediation_plan",
] as const

export type ReadOnlyMethod = (typeof READ_ONLY_METHODS)[number]

export const MANAGEMENT_METHODS = [
  "plugins.list",
  "skills.enable",
  "skills.disable",
  "skills.refresh",
  "plugins.set_enabled",
  "plugins.install.inspect",
  "plugins.install.apply",
  "plugins.remove",
  "plugins.restore",
  "workflow.graph.start",
  "workflow.graph.pause",
  "workflow.graph.resume",
  "workflow.graph.cancel",
  "workflow.graph.approve",
  "workflow.graph.retry",
] as const

export type ManagementMethod = (typeof MANAGEMENT_METHODS)[number]
export type BridgeMethod = ReadOnlyMethod | ManagementMethod

export interface BridgeRequest {
  readonly protocol: typeof BRIDGE_PROTOCOL
  readonly version: typeof BRIDGE_VERSION
  readonly id: string
  readonly method: BridgeMethod
  readonly params: Readonly<Record<string, unknown>>
}

export interface BridgeSuccess<T = unknown> {
  readonly protocol: typeof BRIDGE_PROTOCOL
  readonly version: string
  readonly id: string
  readonly ok: true
  readonly data: T
}

export interface BridgeFailure {
  readonly protocol: typeof BRIDGE_PROTOCOL
  readonly version: string
  readonly id: string
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export interface BridgeEvent {
  readonly protocol: typeof BRIDGE_PROTOCOL
  readonly version: string
  readonly event: true
  readonly type: string
  readonly [key: string]: unknown
}

export type BridgeEnvelope<T = unknown> = BridgeSuccess<T> | BridgeFailure | BridgeEvent

export function isBridgeEnvelope(value: unknown): value is BridgeEnvelope {
  if (!value || typeof value !== "object") return false
  if (Reflect.get(value, "protocol") !== BRIDGE_PROTOCOL || typeof Reflect.get(value, "version") !== "string") return false
  if (Reflect.get(value, "event") === true) return typeof Reflect.get(value, "type") === "string"
  return typeof Reflect.get(value, "id") === "string" && typeof Reflect.get(value, "ok") === "boolean"
}

export function isReadOnlyMethod(value: string): value is ReadOnlyMethod {
  return (READ_ONLY_METHODS as readonly string[]).includes(value)
}

export function isManagementMethod(value: string): value is ManagementMethod {
  return (MANAGEMENT_METHODS as readonly string[]).includes(value)
}
