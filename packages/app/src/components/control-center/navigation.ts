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
    description: "管理模型服务连接和凭据；具体模型选择仍在“模型”设置中完成。",
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

export function isArforgeSettingsValue(value: string): value is ArforgeSettingsValue {
  return ARFORGE_SETTINGS_TABS.some((item) => item.value === value)
}

export function arforgeSettingsTab(value: string) {
  return ARFORGE_SETTINGS_TABS.find((item) => item.value === value)
}
