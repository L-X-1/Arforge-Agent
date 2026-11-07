import type { PromptInputV2Option } from "@arforge-ai/session-ui/v2/prompt-input/types"

/** Public fields already returned by the existing Agent catalog. Never project prompt/options. */
export type AgentMenuCatalogEntry = {
  name: string
  mode: string
  hidden?: boolean
  description?: string
  native?: boolean
  permission?: readonly { permission: string; pattern: string; action: string }[]
  model?: { providerID: string; modelID: string }
  variant?: string
}

export function agentMenuOptions(
  names: readonly string[],
  catalog: readonly AgentMenuCatalogEntry[],
  locale: string,
): PromptInputV2Option[] {
  const zh = locale.startsWith("zh")
  return names.flatMap(name => {
    const agent = catalog.find(item => item.name === name)
    if (agent?.hidden || agent?.mode === "subagent") return []
    if (!agent) return [{ id: name, label: name }]
    const source = agent.native === true ? (zh ? "内置" : "Built-in")
      : agent.native === false ? (zh ? "已配置" : "Configured") : (zh ? "服务器目录" : "Server catalog")
    const description = [
      agent.description,
      `${zh ? "来源" : "Source"}: ${source}`,
      `${zh ? "模式" : "Mode"}: ${agent.mode}`,
      zh ? "可见性：当前选择器中可见" : "Visibility: Listed in this selector",
      ...(agent.model ? [`${zh ? "模型" : "Model"}: ${agent.model.providerID}/${agent.model.modelID}`] : []),
      ...(agent.variant ? [`${zh ? "变体" : "Variant"}: ${agent.variant}`] : []),
      ...(agent.permission ? [
        `${zh ? "目录权限规则：" : "Catalog permission rules: "}${agent.permission.length}`,
        ...agent.permission.map(rule => `${rule.action} · ${rule.permission} · ${rule.pattern}`),
      ] : []),
    ].filter(Boolean).join("\n")
    return [{ id: name, label: name, description }]
  })
}
