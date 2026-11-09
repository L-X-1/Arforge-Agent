import type { ControlCenterMessage } from "./control-center-text"

export const ARFORGE_SETTINGS_TABS = [
  {
    value: "arforge-workspace",
    icon: "status",
    label: "个人工作区",
    description:
      "统一查看项目（Project）、工作区（Location）、会话（Session）、任务（Task）、运行记录（Run）与后台任务的安全状态。",
  },
  {
    value: "arforge-overview",
    icon: "status",
    label: "系统概览",
    description: "查看 Server、当前工作区和 Agent 引擎是否正常；此页面不会修改数据。",
  },
  {
    value: "arforge-integrations",
    icon: "providers",
    label: "模型与服务商（Provider）",
    description: "统一管理模型服务配置、连接与凭据，以及在聊天中显示的模型。",
  },
  {
    value: "arforge-permissions",
    icon: "warning",
    label: "权限与安全",
    description: "查看待处理请求以及已经持久化的权限规则，并可精确撤销单条规则。",
  },
  {
    value: "arforge-memory",
    icon: "brain",
    label: "记忆与学习（Memory / Learning）",
    description: "查看、搜索和管理当前工作区长期保留的记忆，并检查召回质量。",
  },
  {
    value: "arforge-evolution",
    icon: "brain",
    label: "受控自主进化",
    description: "审查学习证据提出的策略候选，并通过隔离评测、人工批准、灰度和回滚治理能力变化。",
  },
  {
    value: "arforge-runtime",
    icon: "console",
    label: "运行时透视",
    description: "上下文分层编译、模型路由决策、独立验证、审计链与运行状态的可视化。",
  },
  {
    value: "arforge-extensions",
    icon: "task",
    label: "工作流、插件与技能（Workflow / Plugin / Skill）",
    description: "运行 Workflow，管理 Plugin 和 Skill；安装与启用分开确认，并通过同一 typed Server API 执行。",
  },
  {
    value: "arforge-diagnostics",
    icon: "checklist",
    label: "诊断与运行报告",
    description: "查看真实运行记录和诊断结果；报告只读取现有数据。",
  },
  {
    value: "arforge-operations",
    icon: "console",
    label: "数据库与本地运维",
    description: "破坏性运维不伪装成普通按钮；此处明确展示当前安全入口和执行边界。",
  },
  {
    value: "arforge-coverage",
    icon: "file-tree",
    label: "开发者：能力映射",
    description: "供开发者核对前端功能与 Server API 的覆盖关系。",
  },
] as const satisfies ReadonlyArray<{
  value: `arforge-${string}`
  icon: string
  label: ControlCenterMessage
  description: ControlCenterMessage
}>

export type ArforgeSettingsTab = (typeof ARFORGE_SETTINGS_TABS)[number]
export type ArforgeSettingsValue = ArforgeSettingsTab["value"]

/** Existing section anchors/views reused by focused navigation from the memory page. */
export const PERSONAL_WORKSPACE_MEMORY_CANDIDATES_ID = "personal-workspace-memory-candidates"
export const MEMORY_RECALL_EVIDENCE_VIEW_ID = "memory-2"

/**
 * A queued focused navigation is only valid for the workspace it was requested
 * from. The settings dialog also remounts on server changes, so switching the
 * project/workspace or the server discards a stale request.
 */
export interface NavigationScopeRequest {
  readonly scope: string
}

export const settingsLocationScope = (location: {
  readonly directory: string
  readonly workspace?: string
}) => `${location.directory}\u0000${location.workspace ?? ""}`

export const createNavigationScopeRequest = (location: {
  readonly directory: string
  readonly workspace?: string
}): NavigationScopeRequest => ({ scope: settingsLocationScope(location) })

export function isNavigationScopeCurrent(
  request: NavigationScopeRequest | undefined,
  location: { readonly directory: string; readonly workspace?: string },
): boolean {
  return request !== undefined && request.scope === settingsLocationScope(location)
}

/** Only an existing view may be requested, so a stale/mistyped id cannot select a blank panel. */
export function requestedNavigationView(
  views: ReadonlyArray<{ readonly id: string }>,
  requested: string | undefined,
): string | undefined {
  return requested !== undefined && views.some((view) => view.id === requested) ? requested : undefined
}

/**
 * Only the memory page and Personal Workspace resolve their settings location
 * from the current session. Sharing that source keeps a focused navigation
 * queued on the memory page valid when it switches to Personal Workspace.
 */
export const SESSION_LOCATION_PAGES = ["arforge-memory", "arforge-workspace"] as const
export type SessionLocationPage = (typeof SESSION_LOCATION_PAGES)[number]

export const isSessionLocationPage = (value: string): value is SessionLocationPage =>
  SESSION_LOCATION_PAGES.some((page) => page === value)

/** The session whose location owns this settings page, if any. */
export const sessionLocationSource = (value: string, sessionID: string | undefined) =>
  sessionID !== undefined && sessionID !== "" && isSessionLocationPage(value) ? sessionID : undefined

/**
 * Source-derived settings pages are only ready when the latest location
 * resolution succeeded. `error` must participate: after a failed source switch
 * `state.location` can still hold the previous workspace, and it must not stay
 * actionable or trigger new queries for that stale directory.
 */
export const settingsLocationReady = (loading: boolean, error: string, hasLocation: boolean) =>
  !loading && error === "" && hasLocation

/** Presentation groups only. The eleven existing values still own their panels. */
export const ARFORGE_SETTINGS_GROUPS = [
  { id: "connections", values: ["arforge-integrations"] },
  { id: "agent", values: ["arforge-evolution", "arforge-runtime", "arforge-extensions"] },
  { id: "security", values: ["arforge-permissions"] },
  { id: "data", values: ["arforge-workspace", "arforge-overview", "arforge-memory", "arforge-diagnostics", "arforge-operations", "arforge-coverage"] },
] as const satisfies ReadonlyArray<{ id: string; values: readonly ArforgeSettingsValue[] }>

export function isArforgeSettingsValue(value: string): value is ArforgeSettingsValue {
  return ARFORGE_SETTINGS_TABS.some((item) => item.value === value)
}

export function arforgeSettingsTab(value: string) {
  return ARFORGE_SETTINGS_TABS.find((item) => item.value === value)
}
