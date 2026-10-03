export type ManagementState = "loading" | "saving" | "permission" | "conflict" | "error" | "notice" | "empty" | "ready"

export function managementErrorText(error: unknown, fallback = "The operation failed.") {
  const message = typeof error === "string" ? error
    : error instanceof Error ? error.message
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : fallback
  // Only render the public message, never serialize a response or credential object.
  return message
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|token|client[_-]?secret|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]+)/gi, "$1[redacted]")
}

export function managementState(input: { loading?: boolean; saving?: boolean; error?: unknown; notice?: string; empty?: boolean }): ManagementState {
  if (input.error) {
    const error = managementErrorText(input.error)
    const status = typeof input.error === "object" && input.error !== null && "status" in input.error
      ? input.error.status : undefined
    if (status === 401 || status === 403 || /\b(?:401|403|unauthorized|forbidden|permission denied)\b|无权限|权限不足|未授权|無權限|權限不足/i.test(error)) return "permission"
    if (status === 409 || /\b409\b|revision.{0,24}(?:conflict|mismatch|stale)|版本冲突|修订冲突|版本衝突/i.test(error)) return "conflict"
    return "error"
  }
  if (input.saving) return "saving"
  if (input.loading) return "loading"
  if (input.notice) return "notice"
  if (input.empty) return "empty"
  return "ready"
}

export function managementCopy(locale: string) {
  if (locale === "zh" || locale === "zht") return {
    loading: "正在加载，请稍候。",
    saving: "正在提交，请勿重复操作。",
    permission: "当前权限不足",
    permissionHint: "请检查当前服务器、工作区和会话的访问权限，然后重试。",
    conflict: "内容已发生变化",
    conflictHint: "请刷新最新版本并核对后，再提交修改。",
    error: "操作未完成",
    retry: "重试",
    saved: "已保存。",
    empty: "当前没有记录。",
    clearSearch: "清除搜索",
    sessionRequired: "请先打开来源会话。",
    resetShortcuts: "将所有自定义快捷键恢复为默认值？此操作只重置快捷键，其他设置不变。",
    disconnect: "断开此服务商连接？依赖它的模型将暂时无法使用。",
  }
  return {
    loading: "Loading. Please wait.",
    saving: "Submitting. Please wait before trying again.",
    permission: "Access is unavailable",
    permissionHint: "Check access to the current server, workspace, and Session, then retry.",
    conflict: "This record has changed",
    conflictHint: "Refresh and review the current revision before submitting again.",
    error: "The operation did not complete",
    retry: "Retry",
    saved: "Saved.",
    empty: "No records yet.",
    clearSearch: "Clear search",
    sessionRequired: "Open the source Session first.",
    resetShortcuts: "Reset all custom keyboard shortcuts? Only shortcuts will be reset; other settings are unchanged.",
    disconnect: "Disconnect this provider? Models using this connection will be unavailable.",
  }
}
