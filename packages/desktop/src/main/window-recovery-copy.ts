export type WindowRecoveryAction = "relaunch" | "export_logs" | "keep_waiting" | "quit"

type RecoveryCopy = {
  actions: Record<WindowRecoveryAction, string>
  loadFailed: string
  terminated: string
  unresponsive: string
  unresponsiveDetail: string
  window: string
  url: string
  error: string
  reason: string
  code: string
  unknown: string
}

export function windowRecoveryCopy(locale: string): RecoveryCopy {
  const normalized = locale.toLowerCase()
  if (normalized.startsWith("zh-tw") || normalized.startsWith("zh-hk") || normalized.startsWith("zh-hant"))
    return {
      actions: { relaunch: "重新啟動", export_logs: "匯出日誌", keep_waiting: "繼續等待", quit: "結束 Arforge" },
      loadFailed: "Arforge 載入失敗",
      terminated: "Arforge 視窗意外終止",
      unresponsive: "Arforge 沒有回應",
      unresponsiveDetail: "你可以重新啟動應用程式、匯出診斷日誌，或繼續等待。",
      window: "視窗",
      url: "位址",
      error: "錯誤",
      reason: "原因",
      code: "代碼",
      unknown: "未知",
    }
  if (normalized.startsWith("zh"))
    return {
      actions: { relaunch: "重新启动", export_logs: "导出日志", keep_waiting: "继续等待", quit: "退出 Arforge" },
      loadFailed: "Arforge 加载失败",
      terminated: "Arforge 窗口意外终止",
      unresponsive: "Arforge 未响应",
      unresponsiveDetail: "你可以重新启动应用、导出诊断日志，或继续等待。",
      window: "窗口",
      url: "地址",
      error: "错误",
      reason: "原因",
      code: "代码",
      unknown: "未知",
    }
  return {
    actions: { relaunch: "Relaunch", export_logs: "Export Logs", keep_waiting: "Keep Waiting", quit: "Quit" },
    loadFailed: "Arforge failed to load",
    terminated: "Arforge window terminated unexpectedly",
    unresponsive: "Arforge is not responding",
    unresponsiveDetail: "You can relaunch the app, export diagnostic logs, or keep waiting.",
    window: "Window",
    url: "URL",
    error: "Error",
    reason: "Reason",
    code: "Code",
    unknown: "unknown",
  }
}
