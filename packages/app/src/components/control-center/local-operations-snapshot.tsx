import { For, Show } from "solid-js"
import type { ControlCenterMessage } from "./control-center-text"
import type { OperationsApi } from "@/utils/server"

/**
 * Presentational read-only local-operations cards. The projection separates
 * archive availability, actual checksum verification, the catalog verification
 * recorded by the manifest, and recovery evidence bound to the exact archive
 * and digest. Nothing here performs I/O or mutates state; `t` and `intl` are
 * injected so the cards can be rendered in a focused check without the whole
 * control-center context.
 */

export type LocalOperationsOverview = Awaited<ReturnType<OperationsApi["privateOperations"]["overview"]>>["data"]
export type LocalOperationsTaskStatus = NonNullable<LocalOperationsOverview["windowsBackupTasks"]>[number]["status"]

type Translate = (message: ControlCenterMessage) => string

function backupFileMessage(state: LocalOperationsOverview["backup"]["fileState"]): ControlCenterMessage {
  if (state === "available") return "存在"
  if (state === "missing") return "缺失"
  return "未知"
}

function checksumMessage(state: LocalOperationsOverview["backup"]["checksumState"]): ControlCenterMessage {
  if (state === "verified") return "已核验"
  if (state === "mismatch") return "不匹配"
  if (state === "unreadable") return "不可读取"
  if (state === "missing") return "缺失"
  return "未核验"
}

function catalogMessage(state: LocalOperationsOverview["backup"]["catalogState"]): ControlCenterMessage {
  if (state === "recorded") return "已记录"
  if (state === "unrecorded") return "未记录"
  if (state === "missing") return "缺失"
  return "未知"
}

function drillMessage(state: LocalOperationsOverview["recoveryDrill"]["state"]): ControlCenterMessage {
  if (state === "verified") return "演练已验证"
  if (state === "failed") return "演练失败"
  if (state === "unbound") return "未绑定当前备份"
  if (state === "historical") return "历史演练报告（当前归档未核验）"
  return "尚无演练"
}

function taskMessage(state: LocalOperationsTaskStatus): ControlCenterMessage {
  if (state === "succeeded") return "成功"
  if (state === "failed") return "失败"
  if (state === "running") return "运行中"
  if (state === "never") return "从未运行"
  if (state === "disabled") return "已禁用"
  return "未知"
}

export function BackupSnapshot(props: { overview: LocalOperationsOverview; t: Translate }) {
  const backup = () => props.overview.backup
  // Mixed-version rule: when a server predates the new state fields, the old
  // manifest-claim booleans must not be promoted into presence or verification.
  // Absent fields degrade to unknown / not verified / unrecorded-unknown.
  const fileState = () => backup().fileState ?? "unavailable"
  const checksumState = () => backup().checksumState ?? "unverified"
  const catalogState = () => backup().catalogState ?? "unknown"
  return (
    <article class="rounded-md border border-border-weak-base p-3">
      <h3 class="arforge-management-section-title text-text-strong">{props.t("PostgreSQL 备份")}</h3>
      <div class="mt-2 arforge-management-copy text-text-weak">
        <div>
          {backup().createdAt ?? "—"} · {backup().database ?? "PostgreSQL"} · {backup().bytes} B
        </div>
        <div>
          {props.t("备份文件")} {props.t(backupFileMessage(fileState()))} · {props.t("SHA-256 校验")}{" "}
          {props.t(checksumMessage(checksumState()))}
        </div>
        <div>
          {props.t("归档校验")} {props.t(catalogMessage(catalogState()))} · AES-256-CBC{" "}
          {backup().encrypted ? "✓" : "—"}
        </div>
      </div>
    </article>
  )
}

export function RecoveryDrillSnapshot(props: { overview: LocalOperationsOverview; t: Translate }) {
  const drill = () => props.overview.recoveryDrill
  // An old server's `passed` may have come from an unbound report, so a missing
  // `state` degrades to "unbound" instead of reviving a legacy pass.
  const state = () => drill().state ?? "unbound"
  const countsVisible = () => state() === "verified" || state() === "failed"
  return (
    <article class="rounded-md border border-border-weak-base p-3">
      <h3 class="arforge-management-section-title text-text-strong">{props.t("恢复演练")}</h3>
      <div class="mt-2 arforge-management-copy text-text-weak">
        <div>{drill().completedAt ?? "—"}</div>
        <div>{props.t(drillMessage(state()))}</div>
        <Show when={countsVisible()}>
          <div>
            {drill().tables} tables · {drill().sourceRows}/{drill().restoredRows} rows · Δ {drill().differences}
          </div>
        </Show>
      </div>
    </article>
  )
}

export function WindowsBackupSnapshot(props: {
  tasks: LocalOperationsOverview["windowsBackupTasks"]
  t: Translate
  intl: () => string
}) {
  const tasks = () => props.tasks ?? []
  return (
    <article class="rounded-md border border-border-weak-base p-3">
      <h3 class="arforge-management-section-title text-text-strong">{props.t("Windows 备份计划任务")}</h3>
      <div class="mt-2 flex flex-col gap-2 arforge-management-copy text-text-weak">
        <Show when={tasks().length > 0} fallback={<div>{props.t("计划任务状态未知")}</div>}>
          <For each={tasks()}>
            {(task) => (
              <div class="flex items-start justify-between gap-3">
                <span class="text-text-strong">{task.name}</span>
                <span class="text-right">
                  {props.t(taskMessage(task.status))} · {props.t("最近运行")}{" "}
                  {task.lastRunAt ? new Date(task.lastRunAt).toLocaleString(props.intl()) : props.t("未知")}
                  {task.exitCode !== undefined ? ` · ${props.t("退出码")} ${task.exitCode}` : ""}
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </article>
  )
}
