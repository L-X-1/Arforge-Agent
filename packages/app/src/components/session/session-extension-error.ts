type ErrorShape = {
  kind?: unknown
  message?: unknown
  body?: unknown
  cause?: unknown
  data?: unknown
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function errorMessage(value: unknown, seen = new Set<unknown>()): string | undefined {
  const parsed = parse(value instanceof Error ? value.message : value)
  if (typeof parsed === "string") return parsed.trim() || undefined
  if (!parsed || typeof parsed !== "object" || seen.has(parsed)) return
  seen.add(parsed)
  const current = parsed as ErrorShape
  if (typeof current.message === "string" && current.message.trim()) {
    const nested = parse(current.message)
    if (nested !== current.message) return errorMessage(nested, seen)
    return current.message.trim()
  }
  return errorMessage(current.data, seen) ?? errorMessage(current.body, seen) ?? errorMessage(current.cause, seen)
}

export function sessionExtensionPublicError(error: unknown, fallback: string, locale: string): string {
  const message = errorMessage(error)
  if (!message) return fallback
  if (
    /ProviderModelNotFoundError|Model not found|unselected\/unselected|no model (?:selected|configured)/i.test(message)
  ) {
    if (locale === "zht") return "尚未設定可用模型。請在設定中選擇提供商和模型後重試。"
    if (locale === "zh") return "尚未配置可用模型。请在设置中选择提供商和模型后重试。"
    return "No usable model is configured. Choose a provider and model in Settings, then retry."
  }
  if (/(?:[A-Za-z][\w]*(?:Error|Exception)|stack trace| at [\w$.[\]()]+)/i.test(message)) {
    if (locale === "zht") return "任務未能產生可用結果。請檢查工作流程與模型設定後重試。"
    if (locale === "zh") return "任务未能生成可用结果。请检查工作流和模型设置后重试。"
    return "The workflow failed before producing a usable result. Check its workflow and model settings, then retry."
  }
  if (locale !== "zh" && locale !== "zht") return message

  if (
    /undeclared.{0,40}(egress|network|secret)|(?:egress|secret).{0,40}(manifest|undeclared)|(?:egress|secret).{0,60}without a declared/i.test(
      message,
    )
  ) {
    return "插件内容未通过安全检查：检测到未声明的联网或密钥访问。操作已停止，受管插件未被修改。"
  }
  if (/plugin recovery entry was not found|recovery_not_found/i.test(message)) {
    return "找不到该插件恢复记录。请核对恢复编号，或确认本地回收内容尚未被清理。"
  }
  if (/plugin is already installed|plugin_already_installed/i.test(message)) {
    return "同名插件当前已安装。请先核对现有版本，再决定是否卸载或更新。"
  }
  if (/invalid plugin recovery|invalid_recovery/i.test(message)) {
    return "插件恢复记录无效，操作已停止。请不要修改恢复编号或回收记录。"
  }
  return message
}
