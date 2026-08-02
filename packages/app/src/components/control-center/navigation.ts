import type { ControlCenterMessage } from "./control-center-text"

export const ARFORGE_SETTINGS_TABS = [
  {
    value: "arforge-overview",
    icon: "status",
    label: "系统概览",
    description: "Server、工作区和 Agent 能力引擎的实时只读状态。",
  },
  {
    value: "arforge-integrations",
    icon: "providers",
    label: "Provider / 模型",
    description: "模型配置仍由成熟设置界面管理；这里补齐集成连接和凭据生命周期。",
  },
  {
    value: "arforge-permissions",
    icon: "warning",
    label: "权限 / 安全",
    description: "查看待处理请求以及已经持久化的权限规则，并可精确撤销单条规则。",
  },
  {
    value: "arforge-memory",
    icon: "brain",
    label: "Memory / Learning",
    description: "同一工作区中的持久记忆、语义检索、召回质量、编辑和治理闭环。",
  },
  {
    value: "arforge-extensions",
    icon: "task",
    label: "Workflow / Plugin / Skill",
    description: "Workflow 运行、插件两阶段安装、Skill 开关与恢复入口共用同一 typed Server API。",
  },
  {
    value: "arforge-diagnostics",
    icon: "checklist",
    label: "诊断 / 运行报告",
    description: "读取持久运行事实；报告不会创建第二份状态源。",
  },
  {
    value: "arforge-operations",
    icon: "console",
    label: "数据库 / 私有运维",
    description: "破坏性运维不伪装成普通按钮；此处明确展示当前安全入口和执行边界。",
  },
  {
    value: "arforge-coverage",
    icon: "file-tree",
    label: "能力映射",
    description: "由机器可读合同生成的覆盖视图。新增 Server API 未归属时，测试会失败。",
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
