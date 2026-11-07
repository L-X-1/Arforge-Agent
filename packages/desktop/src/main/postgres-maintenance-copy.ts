import type { PostgresMaintenanceResult } from "./postgres-maintenance"

export function postgresMaintenanceCopy(locale: string) {
  const normalized = locale.toLowerCase()
  const traditional = normalized.startsWith("zh-tw") || normalized.startsWith("zh-hk") || normalized.startsWith("zh-hant")
  if (traditional) return {
    title: "PostgreSQL 結構維護", close: "關閉", cancel: "取消", apply: "套用遷移", cancelRepair: "取消修復",
    confirm: "套用待處理的 PostgreSQL 結構遷移？",
    detail: "這會明確修改私人 Arforge 環境設定中 ARFORGE_DB_ADMIN_URL 指向的資料庫。請準備備份及管理權限。PostgreSQL 必須已可連線；不會啟動或停止 Docker 或共用資料庫服務。",
    busy: "請先正常關閉現有 Arforge，再執行 PostgreSQL 維護。未停止任何執行中的應用程式或共用服務。",
    invalid: "請使用 Arforge.exe --migrate-postgres，不要加入資料庫位址參數。ARFORGE_DB_ADMIN_URL 僅能放在私人 Arforge 環境設定中。",
    progress: "正在套用 PostgreSQL 結構遷移…", progressDetail: "取消後會等待交易清理及所屬維護程序結束。",
    cleanupPending: "所屬維護程序尚未結束。請再次選擇結束以重試停止。未停止共用服務。",
    cleanupHeld: "所屬維護程序尚未結束。請選擇結束以重試停止；清理確認前 Arforge 會保持開啟。未停止共用服務。",
    startupFailed: "PostgreSQL 維護無法啟動。請檢查套件資源與私人設定；此處不包含憑證或 SQL 詳情。",
    result: (value: PostgresMaintenanceResult) => value.ok
      ? `PostgreSQL 結構已更新（${value.current}），套用 ${value.appliedCount} 項遷移。準備好後可正常啟動 Arforge。`
      : value.code === "admin-url-missing" ? "請在私人 Arforge 環境設定中配置 ARFORGE_DB_ADMIN_URL，再執行 Arforge.exe --migrate-postgres。未改用應用程式位址。"
      : value.code === "configuration-unavailable" ? "無法載入私人 PostgreSQL 遷移設定。請檢查私人環境檔及 PostgreSQL 位址後重試。"
      : value.code === "cancelled" ? "已取消 PostgreSQL 修復。未停止共用 PostgreSQL 或 Docker 服務。若取消發生於提交前後，請檢查結構再重試。"
      : value.code === "timed-out" ? "PostgreSQL 修復逾時，所屬維護程序已結束。請檢查資料庫連線與管理權限後重試。"
      : "PostgreSQL 修復失敗。請檢查私人設定中的資料庫連線與管理權限後重試；此訊息不包含憑證或 SQL 詳情。",
  }
  if (normalized.startsWith("zh")) return {
    title: "PostgreSQL 结构维护", close: "关闭", cancel: "取消", apply: "应用迁移", cancelRepair: "取消修复",
    confirm: "应用待处理的 PostgreSQL 结构迁移？",
    detail: "这会明确修改私有 Arforge 环境配置中 ARFORGE_DB_ADMIN_URL 指向的数据库。请准备备份及管理权限。PostgreSQL 必须已可连接；不会启动或停止 Docker 或共享数据库服务。",
    busy: "请先正常关闭现有 Arforge，再执行 PostgreSQL 维护。未停止任何运行中的应用或共享服务。",
    invalid: "请使用 Arforge.exe --migrate-postgres，不要添加数据库地址参数。ARFORGE_DB_ADMIN_URL 只能放在私有 Arforge 环境配置中。",
    progress: "正在应用 PostgreSQL 结构迁移…", progressDetail: "取消后会等待事务清理及所属维护进程退出。",
    cleanupPending: "所属维护进程尚未退出。请再次选择退出以重试停止。未停止共享服务。",
    cleanupHeld: "所属维护进程尚未退出。请选择退出以重试停止；清理确认前 Arforge 会保持打开。未停止共享服务。",
    startupFailed: "PostgreSQL 维护无法启动。请检查安装包资源与私有配置；此处不包含凭据或 SQL 详情。",
    result: (value: PostgresMaintenanceResult) => value.ok
      ? `PostgreSQL 结构已更新（${value.current}），应用 ${value.appliedCount} 项迁移。准备好后可正常启动 Arforge。`
      : value.code === "admin-url-missing" ? "请在私有 Arforge 环境配置中设置 ARFORGE_DB_ADMIN_URL，再执行 Arforge.exe --migrate-postgres。未改用应用程序地址。"
      : value.code === "configuration-unavailable" ? "无法加载私有 PostgreSQL 迁移配置。请检查私有环境文件及 PostgreSQL 地址后重试。"
      : value.code === "cancelled" ? "已取消 PostgreSQL 修复。未停止共享 PostgreSQL 或 Docker 服务。若取消发生在提交前后，请检查结构再重试。"
      : value.code === "timed-out" ? "PostgreSQL 修复超时，所属维护进程已退出。请检查数据库连接及管理权限后重试。"
      : "PostgreSQL 修复失败。请检查私有配置中的数据库连接及管理权限后重试；此消息不包含凭据或 SQL 详情。",
  }
  return {
    title: "PostgreSQL schema maintenance", close: "Close", cancel: "Cancel", apply: "Apply migrations", cancelRepair: "Cancel repair",
    confirm: "Apply pending PostgreSQL schema migrations?",
    detail: "This explicitly changes the database configured by ARFORGE_DB_ADMIN_URL in your private Arforge environment. Ensure its backup and administrative permissions are ready. PostgreSQL must already be reachable. No Docker or shared database service will be started or stopped.",
    busy: "Close the existing Arforge instance before running PostgreSQL maintenance. No running application or shared service was stopped.",
    invalid: "Use Arforge.exe --migrate-postgres without a URL argument. Configure ARFORGE_DB_ADMIN_URL only in the private Arforge environment file.",
    progress: "Applying PostgreSQL schema migrations…", progressDetail: "Cancel waits for transaction cleanup and the owned utility to exit.",
    cleanupPending: "The owned maintenance utility has not exited. Quit again to retry stopping it. Shared services were not stopped.",
    cleanupHeld: "The owned maintenance utility has not exited. Quit to retry stopping it. Arforge remains open until cleanup can be confirmed; shared services were not stopped.",
    startupFailed: "PostgreSQL maintenance could not start. Check the packaged resources and private configuration. No credentials or SQL details are included here.",
    result: (value: PostgresMaintenanceResult) => value.ok
      ? `PostgreSQL schema is current (${value.current}). Applied ${value.appliedCount} migration(s). Start Arforge normally when ready.`
      : value.code === "admin-url-missing" ? "Configure ARFORGE_DB_ADMIN_URL in your private Arforge environment file, then run Arforge.exe --migrate-postgres again. The application URL was not used as a fallback."
      : value.code === "configuration-unavailable" ? "The private PostgreSQL migration configuration could not be loaded. Check the private environment file and PostgreSQL URL, then retry."
      : value.code === "cancelled" ? "PostgreSQL repair was cancelled. No shared PostgreSQL or Docker service was stopped. Check the schema before retrying if cancellation occurred near commit."
      : value.code === "timed-out" ? "PostgreSQL repair timed out and its owned utility exited. Check database reachability and administrative permissions before retrying."
      : "PostgreSQL repair failed. Check database reachability and administrative permissions in the private configuration, then retry. No credentials or SQL details were included in this message.",
  }
}
