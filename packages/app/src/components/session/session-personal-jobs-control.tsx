import { afterManagementWrite, bindManagementApi, createManagementScope, loadManagementPartition, runManagementMutation } from "@/components/settings-v2/management-async"
import { ManagementStatus } from "@/components/settings-v2/management-status"
import "@/components/settings-v2/management-review.css"
import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { ScheduledPrompt } from "@arforge-ai/schema/scheduled-prompt"
import * as CronSchedule from "@arforge-ai/core/scheduled-prompt/cron"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import type { OperationsApi } from "@/utils/server"
import {
  budgetPercent,
  cronForSchedulePreset,
  defaultOneTimeValue,
  durationParts,
  epochFromOneTimeValue,
  microsFromCurrencyUnits,
  millisecondsFromMinutes,
  retainUntilFromPreset,
  schedulePresetFromCron,
  type RetentionPreset,
  type SchedulePreset,
} from "./personal-job-schedule"

type PersonalJob = Awaited<ReturnType<OperationsApi["personalJobs"]["list"]>>[number]
type PersonalJobStatus = PersonalJob["status"]
type ApprovalMode = "automatic" | "user_once" | "user_each_run"
type NotificationMode = "none" | "in_app"
type CredentialOption = {
  readonly id: string
  readonly integrationID: string
  readonly label: string
  readonly integrationName: string
}

const minuteFromClock = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

const formatArtifactSize = (sizeBytes: number) => {
  if (sizeBytes < 1_024) return `${sizeBytes} B`
  if (sizeBytes < 1_024 * 1_024) return `${(sizeBytes / 1_024).toFixed(1)} KiB`
  return `${(sizeBytes / (1_024 * 1_024)).toFixed(1)} MiB`
}

export function SessionPersonalJobsControl(props: { sessionID: string; disabled?: boolean }) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const ui = (english: string, simplifiedChinese: string, traditionalChinese = simplifiedChinese) => {
    if (language.locale() === "zh") return simplifiedChinese
    if (language.locale() === "zht") return traditionalChinese
    return english
  }
  const [jobs, setJobs] = createSignal<PersonalJob[]>([])
  const [loading, setLoading] = createSignal(true)
  const [dispatching, setDispatching] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")
  const [credentialError, setCredentialError] = createSignal("")
  const [formError, setFormError] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [readError, setReadError] = createSignal("")
  const [fresh, setFresh] = createSignal(false)
  const [createdReceipt, setCreatedReceipt] = createSignal("")
  const [idempotencyKey, setIdempotencyKey] = createSignal(`personal-job-${Date.now()}`)
  const [title, setTitle] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [cron, setCron] = createSignal("0 9 * * *")
  const [schedulePreset, setSchedulePreset] = createSignal<SchedulePreset>("once")
  const [oneTimeAt, setOneTimeAt] = createSignal(defaultOneTimeValue())
  const [approvalMode, setApprovalMode] = createSignal<ApprovalMode>("user_once")
  const [notificationMode, setNotificationMode] = createSignal<NotificationMode>("in_app")
  const [quietHoursEnabled, setQuietHoursEnabled] = createSignal(false)
  const [quietStart, setQuietStart] = createSignal("22:00")
  const [quietEnd, setQuietEnd] = createSignal("08:00")
  const [maxAttempts, setMaxAttempts] = createSignal("2")
  const [maxDurationMinutes, setMaxDurationMinutes] = createSignal("10")
  const [maxCostUnits, setMaxCostUnits] = createSignal("0.5")
  const [retentionPreset, setRetentionPreset] = createSignal<RetentionPreset>("none")
  const [credentialIDs, setCredentialIDs] = createSignal<string[]>([])
  const [credentialOptions, setCredentialOptions] = createSignal<CredentialOption[]>([])
  const [credentialLoading, setCredentialLoading] = createSignal(false)
  const [advancedOpen, setAdvancedOpen] = createSignal(false)
  const [showAllJobs, setShowAllJobs] = createSignal(false)

  const source = serverSDK()
  const sessionID = props.sessionID
  const scope = createManagementScope(source, sessionID, () => ({ source: serverSDK(), sessionID: props.sessionID }))
  onCleanup(scope.dispose)
  const scopedAPI = bindManagementApi(source.operationsApi, scope)
  const api = () => scopedAPI
  const blocked = () => !scope.live() || !!props.disabled || saving() || loading() || dispatching() || !fresh()
  const fail = (reason: unknown) => {
    if (reason instanceof Error) setError(reason.message)
    else if (typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string")
      setError(reason.message)
    else setError(ui("The operation failed. Refresh and try again.", "操作失败，请刷新后重试。"))
    setNotice("")
  }

  const refresh = () => loadManagementPartition(scope, "jobs",
    () => api().personalJobs.list({ sessionID }), {
      start: () => { setLoading(true); setFresh(false); setReadError("") },
      commit: (items) => { setJobs([...items]); setFresh(true) },
      fail: (reason) => setReadError(reason instanceof Error ? reason.message : ui("Jobs could not be refreshed.", "无法刷新任务列表。")),
      finish: () => setLoading(false),
    })
  const refreshWrittenJobs = async () => {
    const refreshed = await refresh()
    scope.assert()
    if (!refreshed) throw new Error(readError())
  }

  const refreshCredentials = async () => {
    if (!scope.live()) return
    const current = scope.next("credentials")
    setCredentialLoading(true)
    setCredentialError("")
    try {
      const integrations = (await api().integrations.list({})).data
      if (!current()) return
      setCredentialOptions(
        integrations.flatMap((integration) =>
          integration.connections.flatMap((connection) =>
            connection.type === "credential"
              ? [
                  {
                    id: connection.id,
                    integrationID: integration.id,
                    label: connection.label,
                    integrationName: integration.name,
                  },
                ]
              : [],
          ),
        ),
      )
    } catch (reason) {
      if (!current()) return
      setCredentialOptions([])
      if (reason instanceof Error) setCredentialError(reason.message)
      else setCredentialError(ui("Stored credentials could not be loaded.", "无法加载已保存的凭据。"))
    } finally {
      if (current()) setCredentialLoading(false)
    }
  }

  const dispatchDue = async () => {
    if (blocked()) return
    setDispatching(true)
    setError("")
    try {
      const result = await api().personalJobs.dispatch({ sessionID, limit: 4 })
      await refresh()
      if (!scope.live()) return
      const launched = Math.max(0, result.attempted - result.completed - result.failed - result.skipped)
      setNotice(
        result.attempted > 0 || result.recovered > 0
          ? ui(
              `Scheduler recovered ${result.recovered} stale job(s) and checked ${result.attempted} due job(s): ${launched} started in background, ${result.completed} completed, ${result.failed} failed, ${result.skipped} skipped.`,
              `调度器恢复了 ${result.recovered} 个失联任务，并检查了 ${result.attempted} 个到期任务：${launched} 个已转入后台运行，${result.completed} 个完成，${result.failed} 个失败，${result.skipped} 个未运行。`,
            )
          : ui("Scheduler is up to date; no job is due now.", "调度器状态正常，目前没有到期任务。"),
      )
    } catch (reason) {
      if (scope.live()) fail(reason)
    } finally {
      if (scope.live()) setDispatching(false)
    }
  }

  onMount(() => {
    void refresh().then((loaded) => { if (loaded && scope.live()) return dispatchDue() })
    void refreshCredentials()
    const timer = window.setInterval(() => void dispatchDue(), 15_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const mutate = async (action: () => Promise<void>, message: string) => {
    if (blocked()) return
    setSaving(true)
    setError("")
    setNotice("")
    const result = await runManagementMutation(scope, action)
    if (!scope.live()) return
    if (result.status === "failed") { fail(result.error); setFresh(false) }
    if (result.status === "confirmed" || result.status === "confirmed-refresh-failed") {
      setNotice(message + (result.status === "confirmed-refresh-failed"
        ? ui(" Refresh failed; retry only refresh, not creation.", " 刷新失败；请仅重试刷新，不要重复创建。") : ""))
    }
    setSaving(false)
  }

  const create = () => {
    if (blocked()) return
    const attempts = Number(maxAttempts())
    const duration = millisecondsFromMinutes(maxDurationMinutes())
    const cost = microsFromCurrencyUnits(maxCostUnits())
    const oneTimeTimestamp = epochFromOneTimeValue(oneTimeAt())
    const recurring = schedulePreset() !== "once"
    const validation = !title().trim()
      ? ui("Enter a task name.", "请输入任务名称。")
      : !prompt().trim()
        ? ui("Enter task instructions.", "请输入任务内容。")
        : schedulePreset() === "once" && (oneTimeTimestamp === undefined || oneTimeTimestamp <= Date.now())
          ? ui("Choose a future date and time for the one-time run.", "请选择未来的一次运行日期和时间。")
          : recurring && cron().trim().split(/\s+/).length !== 5
            ? ui("The custom schedule must contain five Cron fields.", "自定义时间必须包含五段 Cron 表达式。")
            : !Number.isInteger(attempts) || attempts < 1
              ? ui("Maximum attempts must be a positive whole number.", "最大尝试次数必须是正整数。")
              : duration === undefined
                ? ui("Maximum duration must be a positive number of minutes.", "最大运行时长必须是大于零的分钟数。")
                : cost === undefined
                  ? ui("Maximum cost must be zero or a positive amount.", "最大成本额度必须为零或正数。")
                  : ""
    if (validation) {
      setFormError(validation)
      return
    }
    setFormError("")
    void mutate(
      async () => {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        const schedule =
          schedulePreset() === "once"
            ? {
                kind: "once" as const,
                label: ui("One-time automatic task", "一次性自动任务"),
                nextRunAt: oneTimeTimestamp!,
                timezone,
              }
            : {
                kind: "cron" as const,
                label: ui("User-visible recurring job", "用户可见的周期任务"),
                cron: cron().trim(),
                nextRunAt: CronSchedule.nextInTimeZone(
                  ScheduledPrompt.Cron.make(cron().trim()),
                  Date.now(),
                  timezone,
                ),
                timezone,
              }
        const startMinute = quietHoursEnabled() ? minuteFromClock(quietStart()) : undefined
        const endMinute = quietHoursEnabled() ? minuteFromClock(quietEnd()) : undefined
        const retainUntil = retainUntilFromPreset(retentionPreset())
        if (quietHoursEnabled() && (startMinute === undefined || endMinute === undefined || startMinute === endMinute))
          throw new Error(ui("Quiet hours must use two different valid times.", "免打扰时间必须是两个不同的有效时间。"))
        const admittedKey = idempotencyKey().trim()
        const created: unknown = await api().personalJobs.create({
          sessionID,
          idempotencyKey: admittedKey,
          title: title().trim(),
          prompt: prompt().trim(),
          schedule,
          credentialIDs: credentialIDs().length > 0 ? credentialIDs() : undefined,
          budget: {
            maxAttempts: Number(maxAttempts()),
            maxDurationMs: duration!,
            maxCostMicros: cost!,
          },
          approvalPolicy: {
            mode: approvalMode(),
            rationale: ui("Created from the Session Personal Jobs panel.", "由 Session 的个人任务面板创建。"),
          },
          quietHours:
            startMinute === undefined || endMinute === undefined ? undefined : { timezone, startMinute, endMinute },
          notificationPolicy: {
            mode: notificationMode(),
            events: ["approval_required", "started", "completed", "failed", "paused", "cancelled", "budget_exhausted"],
          },
          retainUntil,
        })
        const createdID = typeof created === "object" && created !== null && "id" in created && typeof created.id === "string" ? created.id : ""
        setCreatedReceipt(createdID ? `${createdID} / ${admittedKey}` : admittedKey)
        setIdempotencyKey(`personal-job-${Date.now()}`)
        setTitle("")
        setPrompt("")
        setOneTimeAt(defaultOneTimeValue())
        setCredentialIDs([])
        setRetentionPreset("none")
        await afterManagementWrite(refreshWrittenJobs)
      },
      ui("Background job admitted.", "后台自动任务已持久化准入。"),
    )
  }

  const selectSchedule = (value: string) => {
    if (value === "once") {
      setSchedulePreset("once")
      return
    }
    if (value === "custom") {
      setSchedulePreset("custom")
      setAdvancedOpen(true)
      return
    }
    if (value === "daily" || value === "weekdays" || value === "weekly") {
      setSchedulePreset(value)
      setCron(cronForSchedulePreset(value))
    }
  }

  const update = async (job: PersonalJob, action: "approve" | "execute" | "pause" | "resume" | "cancel") => {
    const next = await api().personalJobs[action]({
      sessionID,
      jobID: job.id,
      expectedRevision: job.revision,
      ...(action === "cancel" ? { reason: ui("Cancelled from the Personal Jobs panel.", "由个人任务面板取消。") } : {}),
    })
    setJobs((items) => items.map((item) => (item.id === next.id ? next : item)))
  }

  const deleteJob = (job: PersonalJob) => {
    if (!window.confirm(ui(`Delete “${job.title}” from the visible job list?`, `从可见任务列表删除“${job.title}”？`)))
      return
    void mutate(
      async () => {
        await api().personalJobs.delete({ sessionID, jobID: job.id, expectedRevision: job.revision })
        setJobs((items) => items.filter((item) => item.id !== job.id))
      },
      ui(
        "Job deleted from the visible list; its audit record remains durable.",
        "任务已从可见列表删除，审计记录仍持久保留。",
      ),
    )
  }

  const markNotificationsRead = (job: PersonalJob) =>
    void mutate(
      async () => {
        let current = job
        for (const notification of job.notifications) {
          if (notification.readAt !== undefined || notification.availableAt > Date.now()) continue
          current = await api().personalJobs.notificationRead({
            sessionID,
            jobID: current.id,
            notificationID: notification.id,
            expectedRevision: current.revision,
          })
        }
        setJobs((items) => items.map((item) => (item.id === current.id ? current : item)))
      },
      ui("Notifications marked as read.", "通知已标记为已读。"),
    )

  const run = (job: PersonalJob) =>
    void mutate(
      () => update(job, "execute"),
      ui(
        "Background job started. You can keep using Arforge, pause it, or cancel it from this card.",
        "后台任务已开始。你可以继续使用 Arforge，并可在此任务卡片中暂停或取消。",
      ),
    )
  const approve = (job: PersonalJob) => void mutate(() => update(job, "approve"), ui("Job approved.", "任务已批准。"))
  const pause = (job: PersonalJob) => void mutate(() => update(job, "pause"), ui("Job paused.", "任务已暂停。"))
  const resume = (job: PersonalJob) => void mutate(() => update(job, "resume"), ui("Job resumed.", "任务已恢复。"))
  const cancel = (job: PersonalJob) => {
    if (!window.confirm(ui(`Cancel “${job.title}”?`, `取消“${job.title}”？`))) return
    void mutate(() => update(job, "cancel"), ui("Job cancelled.", "任务已取消。"))
  }

  const formatDate = (timestamp: number, timeZone?: string) =>
    new Intl.DateTimeFormat(language.locale() === "zht" ? "zh-TW" : language.locale() === "zh" ? "zh-CN" : "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(timestamp)

  return (
    <section
      class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
      aria-labelledby="operations-personal-jobs-title"
      aria-busy={loading() || saving() || dispatching()}
      data-testid="personal-jobs-control"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="operations-personal-jobs-title" class="text-14-medium text-text-strong">
            {ui("Personal Jobs · 后台自动", "个人任务 · 后台自动")}
          </h2>
          <p class="mt-1 max-w-3xl text-12-regular text-text-weak">
            {ui(
              "Every automatic task is visible, budgeted, approval-aware, and user-controllable. The panel never hides long-running work.",
              "每个自动任务都会显示、受预算约束并遵循审批策略；此面板不会隐藏长期后台工作。",
            )}
          </p>
          <p class="mt-1 max-w-3xl text-11-regular text-text-weak">
            {ui(
              "Local automatic tasks run while Arforge is open. If the app restarts, overdue or interrupted work is recovered from durable state.",
              "本地自动任务会在 Arforge 打开期间运行；应用重启后，到期或中断的任务会依据持久状态安全恢复。",
            )}
          </p>
        </div>
        <Button
          type="button"
          size="small"
          variant="ghost"
          class="min-h-11"
          disabled={loading() || saving() || dispatching()}
          onClick={() => void refresh()}
        >
          {ui("Refresh jobs", "刷新任务")}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          class="min-h-11"
          disabled={blocked()}
          onClick={() => void dispatchDue()}
        >
          {dispatching() ? ui("Checking…", "检查中…") : ui("Check scheduler", "检查调度器")}
        </Button>
      </div>

      <div class="rounded-md border border-border-weak-base bg-background-weak p-3" data-testid="personal-job-create">
        <h3 class="text-12-medium text-text-strong">{ui("Create an automatic task", "创建自动任务")}</h3>
        <p class="mt-1 text-11-regular text-text-weak">
          {ui(
            "Start with the task, schedule, and confirmation policy. Technical limits remain available under Advanced settings.",
            "先填写任务、运行时间和确认方式；技术限制保留在“高级设置”中。",
          )}
        </p>
      </div>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <TextField
          label={ui("Task name (required)", "任务名称（必填）")}
          value={title()}
          onChange={setTitle}
          disabled={blocked()}
        />
        <label class="flex min-w-0 flex-col gap-1 text-12-medium text-text-strong">
          {ui("When to run", "运行时间")}
          <select
            class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            value={schedulePreset()}
            onChange={(event) => selectSchedule(event.currentTarget.value)}
            disabled={blocked()}
          >
            <option value="once">{ui("Run once…", "运行一次…")}</option>
            <option value="daily">{ui("Every day at 09:00", "每天 09:00")}</option>
            <option value="weekdays">{ui("Weekdays at 09:00", "工作日 09:00")}</option>
            <option value="weekly">{ui("Every Monday at 09:00", "每周一 09:00")}</option>
            <option value="custom">{ui("Custom schedule…", "自定义时间…")}</option>
          </select>
        </label>
        <label class="flex min-w-0 flex-col gap-1 text-12-medium text-text-strong">
          {ui("Confirmation", "确认方式")}
          <select
            class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            value={approvalMode()}
            onChange={(event) => {
              const next = event.currentTarget.value
              if (next === "automatic" || next === "user_once" || next === "user_each_run") setApprovalMode(next)
            }}
            disabled={blocked()}
          >
            <option value="automatic">{ui("Run automatically", "自动运行")}</option>
            <option value="user_once">{ui("Confirm once before enabling", "启用前确认一次")}</option>
            <option value="user_each_run">{ui("Confirm before every run", "每次运行前确认")}</option>
          </select>
        </label>
      </div>
      <Show when={schedulePreset() === "once"}>
        <label class="flex max-w-sm flex-col gap-1 text-12-medium text-text-strong">
          {ui("Run once at", "一次运行时间")}
          <input
            type="datetime-local"
            value={oneTimeAt()}
            onChange={(event) => setOneTimeAt(event.currentTarget.value)}
            disabled={blocked()}
            class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          />
        </label>
      </Show>
      <TextField
        label={ui("Task instructions (required)", "任务内容（必填）")}
        multiline
        value={prompt()}
        onChange={setPrompt}
        placeholder={ui(
          "Review the current implementation and report verified changes.",
          "复查当前实现并报告已验证的变更。",
        )}
        disabled={blocked()}
      />

      <Button
        type="button"
        size="small"
        variant="ghost"
        class="min-h-11 self-start"
        aria-expanded={advancedOpen()}
        onClick={() => setAdvancedOpen((value) => !value)}
      >
        {advancedOpen() ? ui("Hide advanced settings", "收起高级设置") : ui("Show advanced settings", "显示高级设置")}
      </Button>

      <Show when={advancedOpen()}>
        <div class="grid grid-cols-1 gap-3 rounded-md border border-border-weak-base p-3 md:grid-cols-2">
          <div class="md:col-span-2">
            <h3 class="text-12-medium text-text-strong">{ui("Advanced safeguards", "高级限制与安全")}</h3>
            <p class="mt-1 text-11-regular text-text-weak">
              {ui(
                "These defaults are suitable for most tasks. Change them only when you need a custom schedule, credential boundary, or stricter budget.",
                "默认值适合大多数任务。只有需要自定义时间、限定凭据或更严格预算时才需修改。",
              )}
            </p>
          </div>
          <TextField
            label={ui("Request identity", "请求标识")}
            value={idempotencyKey()}
            onChange={setIdempotencyKey}
            disabled={blocked()}
          />
          <Show when={schedulePreset() !== "once"}>
            <TextField
              label={ui("Custom schedule (cron)", "自定义时间（Cron）")}
              value={cron()}
              onChange={(value) => {
                setCron(value)
                setSchedulePreset("custom")
              }}
              placeholder="0 9 * * *"
              disabled={blocked()}
            />
          </Show>
        </div>
        <label class="flex min-w-0 flex-col gap-1 text-12-medium text-text-strong">
          {ui("Scoped credentials (optional)", "限定凭据（可选）")}
          <select
            multiple
            size={Math.min(Math.max(credentialOptions().length, 2), 5)}
            class="min-h-18 rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-12-regular text-text-base outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            value={credentialIDs()}
            onChange={(event) =>
              setCredentialIDs(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
            }
            disabled={saving() || credentialLoading()}
            aria-describedby="personal-job-credentials-help"
          >
            <For each={credentialOptions()}>
              {(credential) => (
                <option value={credential.id}>
                  {credential.integrationName} · {credential.label}
                </option>
              )}
            </For>
          </select>
          <span id="personal-job-credentials-help" class="text-11-regular text-text-weak">
            {credentialLoading()
              ? ui("Loading stored credentials…", "正在加载已保存的凭据…")
              : credentialOptions().length > 0
                ? ui(
                    "Select one or more stored credentials. Secrets are never shown; the runner will not fall back outside this scope.",
                    "可选择一个或多个已保存凭据。界面不会显示密钥，执行器也不会使用选择范围之外的凭据。",
                  )
                : ui(
                    "No stored credential is available; the normal session provider connection will be used.",
                    "没有可用的已保存凭据；任务将使用会话的默认服务商连接。",
                  )}
          </span>
          <Show when={credentialError()}>
            <span class="text-11-regular text-text-danger">{credentialError()}</span>
          </Show>
        </label>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label class="flex min-w-0 flex-col gap-1 text-12-medium text-text-strong">
            {ui("Notifications", "通知")}
            <select
              class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              value={notificationMode()}
              onChange={(event) => {
                const next = event.currentTarget.value
                if (next === "none" || next === "in_app") setNotificationMode(next)
              }}
              disabled={blocked()}
            >
              <option value="in_app">{ui("In-app notifications", "应用内通知")}</option>
              <option value="none">{ui("No notifications", "不发送通知")}</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-12-medium text-text-strong">
            {ui("Deletion protection", "删除保护", "刪除保護")}
            <select
              class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              value={retentionPreset()}
              onChange={(event) => {
                const next = event.currentTarget.value
                if (next === "none" || next === "7d" || next === "30d" || next === "90d" || next === "365d")
                  setRetentionPreset(next)
              }}
              disabled={blocked()}
              aria-describedby="personal-job-retention-help"
            >
              <option value="none">
                {ui("Allow deletion after terminal state", "终态后允许删除", "終態後允許刪除")}
              </option>
              <option value="7d">{ui("Protect for 7 days", "保护 7 天", "保護 7 天")}</option>
              <option value="30d">{ui("Protect for 30 days", "保护 30 天", "保護 30 天")}</option>
              <option value="90d">{ui("Protect for 90 days", "保护 90 天", "保護 90 天")}</option>
              <option value="365d">{ui("Protect for 1 year", "保护 1 年", "保護 1 年")}</option>
            </select>
            <span id="personal-job-retention-help" class="text-11-regular text-text-weak">
              {ui(
                "This only delays deleting the visible job record; its audit history remains durable.",
                "这只会延迟删除可见任务记录；审计历史始终持久保留。",
                "這只會延遲刪除可見任務記錄；稽核歷史始終持久保留。",
              )}
            </span>
          </label>
          <label class="flex min-w-0 items-center gap-2 pt-6 text-12-medium text-text-strong">
            <input
              type="checkbox"
              checked={quietHoursEnabled()}
              onChange={(event) => setQuietHoursEnabled(event.currentTarget.checked)}
              disabled={blocked()}
            />
            {ui("Enable quiet hours", "启用免打扰时间")}
          </label>
          <Show when={quietHoursEnabled()}>
            <div class="grid grid-cols-2 gap-2">
              <label class="flex min-w-0 flex-col gap-1 text-12-medium text-text-strong">
                {ui("Quiet start", "免打扰开始")}
                <input
                  type="time"
                  value={quietStart()}
                  onChange={(event) => setQuietStart(event.currentTarget.value)}
                  disabled={blocked()}
                  class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                />
              </label>
              <label class="flex min-w-0 flex-col gap-1 text-12-medium text-text-strong">
                {ui("Quiet end", "免打扰结束")}
                <input
                  type="time"
                  value={quietEnd()}
                  onChange={(event) => setQuietEnd(event.currentTarget.value)}
                  disabled={blocked()}
                  class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                />
              </label>
            </div>
          </Show>
        </div>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
          <TextField
            label={ui("Max attempts", "最大尝试次数")}
            value={maxAttempts()}
            onChange={setMaxAttempts}
            disabled={blocked()}
          />
          <TextField
            label={ui("Max duration (minutes)", "最大时长（分钟）")}
            value={maxDurationMinutes()}
            onChange={setMaxDurationMinutes}
            disabled={blocked()}
          />
          <TextField
            label={ui("Max cost (provider currency)", "最大成本（服务商计价单位）")}
            value={maxCostUnits()}
            onChange={setMaxCostUnits}
            disabled={blocked()}
          />
        </div>
      </Show>
      <Show when={formError()}>
        <p role="alert" class="text-11-regular text-text-danger">
          {formError()}
        </p>
      </Show>
      <div>
        <Button type="button" size="small" variant="primary" class="min-h-11" disabled={blocked()} onClick={create}>
          {saving() ? ui("Saving…", "保存中…") : ui("Create automatic task", "创建自动任务")}
        </Button>
      </div>

      <ManagementStatus saving={saving() || dispatching()} error={error()} notice={notice()} />
      <ManagementStatus loading={loading()} saving={saving() || dispatching()} error={readError()} onRetry={() => void refresh()} />
      <Show when={createdReceipt()}>
        <p role="status" class="break-all text-11-regular text-text-weak">
          {ui("Confirmed job / idempotency receipt: ", "已确认任务 / 幂等回执：")}{createdReceipt()}
        </p>
      </Show>
      <div class="flex flex-col gap-2" data-testid="personal-job-list">
        <For each={showAllJobs() ? jobs() : jobs().slice(0, 6)}>
          {(job) => (
            <PersonalJobCard
              job={job}
              busy={blocked()}
              onApprove={approve}
              onRun={run}
              onPause={pause}
              onResume={resume}
              onCancel={cancel}
              onDelete={deleteJob}
              onMarkNotificationsRead={markNotificationsRead}
              ui={ui}
              formatDate={formatDate}
            />
          )}
        </For>
        <Show when={jobs().length > 6}>
          <Button
            type="button"
            size="small"
            variant="secondary"
            class="self-start"
            onClick={() => setShowAllJobs((value) => !value)}
          >
            {showAllJobs()
              ? ui("Show fewer", "收起任务")
              : ui(`Show all ${jobs().length} jobs`, `查看全部 ${jobs().length} 个任务`)}
          </Button>
        </Show>
        <Show when={!loading() && !readError() && !error() && jobs().length === 0}>
          <p class="text-12-regular text-text-weak">
            {ui("No visible background jobs yet.", "当前还没有可见后台任务。")}
          </p>
        </Show>
      </div>
    </section>
  )
}

function PersonalJobCard(props: {
  job: PersonalJob
  busy: boolean
  onApprove: (job: PersonalJob) => void
  onRun: (job: PersonalJob) => void
  onPause: (job: PersonalJob) => void
  onResume: (job: PersonalJob) => void
  onCancel: (job: PersonalJob) => void
  onDelete: (job: PersonalJob) => void
  onMarkNotificationsRead: (job: PersonalJob) => void
  ui: (english: string, simplifiedChinese: string, traditionalChinese?: string) => string
  formatDate: (timestamp: number, timeZone?: string) => string
}) {
  const { job } = props
  const retainUntil = job.retention.retainUntil
  const retentionActive = retainUntil !== undefined && retainUntil > Date.now()
  const statusLabel = (status: PersonalJobStatus) =>
    ({
      awaiting_approval: props.ui("Awaiting approval", "等待审批"),
      queued: props.ui("Queued", "排队中"),
      running: props.ui("Running", "运行中"),
      paused: props.ui("Paused", "已暂停"),
      completed: props.ui("Completed", "已完成"),
      failed: props.ui("Failed", "失败"),
      cancelled: props.ui("Cancelled", "已取消"),
    })[status]
  const scheduleLabel = () => {
    if (job.schedule.kind === "once") return props.ui("One time", "运行一次")
    const preset = schedulePresetFromCron(job.schedule.cron ?? "")
    if (preset === "daily") return props.ui("Every day at 09:00", "每天 09:00")
    if (preset === "weekdays") return props.ui("Weekdays at 09:00", "工作日 09:00")
    if (preset === "weekly") return props.ui("Every Monday at 09:00", "每周一 09:00")
    return job.schedule.cron ?? job.schedule.kind
  }
  const durationLabel = (milliseconds: number) => {
    const duration = durationParts(milliseconds)
    const unit = {
      seconds: props.ui("sec", "秒"),
      minutes: props.ui("min", "分钟"),
      hours: props.ui("hr", "小时"),
    }[duration.unit]
    return `${duration.value} ${unit}`
  }

  return (
    <article class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3" data-testid="personal-job-card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2 text-13-medium text-text-strong">
            <span>{job.title}</span>
            <span class="rounded-full border border-border-focus px-2 py-0.5 text-11-medium text-text-base">
              {job.visibility.label}
            </span>
          </div>
          <div class="text-11-regular text-text-weak">
            {statusLabel(job.status)} · {scheduleLabel()}
          </div>
          <div class="text-11-regular text-text-weak">
            {job.schedule.kind === "cron"
              ? props.ui("Next schedule", "下一计划时间")
            : props.ui("Scheduled for", "计划时间")}
            : {props.formatDate(job.schedule.nextRunAt, job.schedule.timezone)} · {job.schedule.timezone}
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Show when={job.status === "awaiting_approval"}>
            <Button
              type="button"
              size="small"
              variant="primary"
              disabled={props.busy}
              onClick={() => props.onApprove(job)}
            >
              {props.ui("Approve", "批准")}
            </Button>
          </Show>
          <Show when={job.status === "queued"}>
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={props.busy}
              title={props.ui("Run now without waiting for the saved schedule", "不等待计划时间，立即运行")}
              onClick={() => props.onRun(job)}
            >
              {props.ui("Run now", "立即运行")}
            </Button>
            <Button type="button" size="small" variant="ghost" disabled={props.busy} onClick={() => props.onPause(job)}>
              {props.ui("Pause", "暂停")}
            </Button>
          </Show>
          <Show when={job.status === "running"}>
            <Button type="button" size="small" variant="ghost" disabled={props.busy} onClick={() => props.onPause(job)}>
              {props.ui("Pause", "暂停")}
            </Button>
          </Show>
          <Show when={job.status === "paused"}>
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={props.busy}
              onClick={() => props.onResume(job)}
            >
              {props.ui("Resume", "恢复")}
            </Button>
          </Show>
          <Show when={!["completed", "failed", "cancelled"].includes(job.status)}>
            <Button
              type="button"
              size="small"
              variant="ghost"
              disabled={props.busy}
              onClick={() => props.onCancel(job)}
            >
              {props.ui("Cancel", "取消")}
            </Button>
          </Show>
          <Show when={["completed", "failed", "cancelled"].includes(job.status)}>
            <Button
              type="button"
              size="small"
              variant="ghost"
              disabled={props.busy || retentionActive}
              title={
                retentionActive
                  ? props.ui(
                      "Deletion is protected until the retention deadline.",
                      "任务仍处于删除保护期。",
                      "任務仍處於刪除保護期。",
                    )
                  : undefined
              }
              onClick={() => props.onDelete(job)}
            >
              {props.ui("Delete", "删除")}
            </Button>
          </Show>
        </div>
      </div>
      <p class="whitespace-pre-wrap break-words text-12-regular text-text-weak">{job.prompt}</p>
      <div class="grid grid-cols-1 gap-1 text-11-regular text-text-weak md:grid-cols-3">
        <span>
          {props.ui("Attempts", "尝试次数")}: {job.budget.attemptsUsed}/{job.budget.maxAttempts}
        </span>
        <span>
          {props.ui("Run time", "运行时长")}: {durationLabel(job.budget.durationMsUsed)} /{" "}
          {durationLabel(job.budget.maxDurationMs)}
        </span>
        <span>
          {props.ui("Cost budget used", "成本额度已用")}:{" "}
          {budgetPercent(job.budget.costMicrosUsed, job.budget.maxCostMicros)}
        </span>
        <Show when={job.credentialIDs.length > 0}>
          <span>
            {props.ui("Scoped credentials", "限定凭据")}: {job.credentialIDs.length}
          </span>
        </Show>
      </div>
      <Show when={retainUntil !== undefined}>
        <p role="status" class="text-11-regular text-text-weak">
          {retentionActive
            ? props.ui(
                `Deletion protected until ${props.formatDate(retainUntil)}`,
                `删除保护至 ${props.formatDate(retainUntil)}。`,
                `刪除保護至 ${props.formatDate(retainUntil)}。`,
              )
            : props.ui(
                "Deletion protection ended; you can remove this visible record.",
                "删除保护已结束，可以删除此可见记录。",
                "刪除保護已結束，可以刪除這筆可見記錄。",
              )}
        </p>
      </Show>
      <Show when={job.result}>
        {(result) => (
          <>
            <p class="whitespace-pre-wrap break-words text-11-regular text-text-weak">{result().summary}</p>
            <Show when={(result().artifacts?.length ?? 0) > 0}>
              <div class="rounded border border-border-weak bg-background-weak px-2 py-2">
                <p class="mb-1 text-11-medium text-text-base">
                  {props.ui("Verified result artifacts", "已验证的结果工件")} ({result().artifacts?.length ?? 0})
                </p>
                <div class="grid gap-1 text-11-regular text-text-weak">
                  <For each={result().artifacts ?? []}>
                    {(artifact) => (
                      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span class="max-w-full break-all text-text-base">{artifact.name}</span>
                        <span>{artifact.mime}</span>
                        <span>{formatArtifactSize(artifact.sizeBytes)}</span>
                        <span title={artifact.digest} class="font-mono">
                          {artifact.digest.slice(0, 12)}…
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={job.lastError}>
        <p class="whitespace-pre-wrap break-words text-11-regular text-text-danger">{job.lastError}</p>
      </Show>
      <Show
        when={job.notifications.some(
          (notification) => notification.readAt === undefined && notification.availableAt <= Date.now(),
        )}
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-11-medium text-text-base">{props.ui("Unread notification available.", "有未读通知。")}</p>
          <Button
            type="button"
            size="small"
            variant="ghost"
            disabled={props.busy}
            onClick={() => props.onMarkNotificationsRead(job)}
          >
            {props.ui("Mark read", "标记已读")}
          </Button>
        </div>
      </Show>
    </article>
  )
}
