import { useControlCenterText } from "@/components/control-center/control-center-text"
import { Button } from "@arforge-ai/ui/button"
import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"
import { hasOperationDirectory } from "./session-operation-boundary"
type RunList = Awaited<ReturnType<OperationsApi["agentCapabilities"]["runList"]>>["data"]
type RunSummary = RunList["items"][number]
type RunReportResult = Awaited<ReturnType<OperationsApi["agentCapabilities"]["runReport"]>>["data"]
type RunReport = Extract<
  RunReportResult,
  {
    found: true
  }
>["report"]
type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}
export function SessionRunHistory(props: {
  api: () => OperationsApi
  location: () => LocationInput
  disabled?: boolean
}) {
  const t = useControlCenterText()
  const [state, setState] = createStore({
    loading: true,
    error: "",
    limit: 20,
    items: [] as RunSummary[],
    report: undefined as RunReport | undefined,
  })
  const refresh = async () => {
    const location = props.location()
    if (!hasOperationDirectory(location)) {
      setState({
        loading: false,
        error: t("Workspace context is still loading. Reopen this panel if the Session was just imported."),
      })
      return
    }
    if (state.loading && state.items.length > 0) return
    setState({ loading: true, error: "" })
    try {
      const result = await props.api().agentCapabilities.runList({
        ...location,
        limit: state.limit,
      })
      setState({ items: [...result.data.items] })
      if (state.report && !result.data.items.some((item) => item.run_id === state.report?.run_id)) {
        setState("report", undefined)
      }
    } catch (error) {
      setState("error", publicError(error, t("Run history could not be loaded. Refresh and try again.")))
    } finally {
      setState("loading", false)
    }
  }
  const open = async (runID: string) => {
    setState({ loading: true, error: "" })
    try {
      const result = await props.api().agentCapabilities.runReport({
        ...props.location(),
        runID,
      })
      if (!result.data.found) {
        setState({
          report: undefined,
          error: t("Run {{run}} no longer exists. Refresh the list.", { run: runID }),
        })
        return
      }
      setState("report", result.data.report)
    } catch (error) {
      setState("error", publicError(error, t("Run history could not be loaded. Refresh and try again.")))
    } finally {
      setState("loading", false)
    }
  }
  createEffect(
    on([() => props.location().location.directory, () => props.location().location.workspace], () => {
      if (hasOperationDirectory(props.location())) void refresh()
    }),
  )
  return (
    <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3" data-testid="run-history">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="text-12-medium text-text-strong">{t("Persistent run history")}</h3>
          <p class="text-12-regular text-text-weak">
            {t(
              "Read the Python Core transaction, trace, and message artifacts through the shared typed Server API. Reports are read-only and remain owned by one persistence source.",
            )}
          </p>
        </div>
        <div class="flex items-end gap-2">
          <label class="flex flex-col gap-1 text-11-medium text-text-strong">
            {t("Limit")}
            <select
              class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-strong"
              value={state.limit}
              onChange={(event) => {
                setState("limit", Number(event.currentTarget.value))
                void refresh()
              }}
              disabled={props.disabled || state.loading}
            >
              <For each={[10, 20, 50, 100]}>{(limit) => <option value={limit}>{limit}</option>}</For>
            </select>
          </label>
          <Button
            size="small"
            variant="ghost"
            disabled={props.disabled || state.loading}
            onClick={() => void refresh()}
          >
            {t("Refresh")}
          </Button>
        </div>
      </div>

      <Show when={state.error}>
        <p class="rounded-md border border-border-warning p-3 text-12-regular text-text-warning">{state.error}</p>
      </Show>

      <div class="flex flex-col gap-2">
        <For each={state.items}>
          {(item) => (
            <button
              type="button"
              class="flex w-full flex-col gap-1 rounded-md border border-border-weak-base bg-background-base p-3 text-left hover:bg-background-weak disabled:opacity-50"
              disabled={props.disabled || state.loading}
              onClick={() => void open(item.run_id)}
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-12-medium text-text-strong">{item.run_id}</span>
                <span class="text-10-regular text-text-weak">{formatTime(item.created, t("Time unknown"))}</span>
              </div>
              <span class="text-11-regular text-text-weak">
                {item.changed_files}
                {t("files \u00B7")}
                {item.trace_events}
                {t("events \u00B7")}
                {item.messages_count}
                {t("messages")}
              </span>
              <Show when={item.answer_preview}>
                <span class="line-clamp-2 text-11-regular text-text-weak">{item.answer_preview}</span>
              </Show>
            </button>
          )}
        </For>
        <Show when={!state.loading && state.items.length === 0}>
          <p class="text-12-regular text-text-weak">{t("No persisted runs are available in this Arforge profile.")}</p>
        </Show>
      </div>

      <Show when={state.report}>
        {(report) => (
          <div class="flex flex-col gap-3 rounded-md bg-background-weak p-3" data-testid="run-report">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h4 class="text-12-medium text-text-strong">{report().run_id}</h4>
              <Button size="small" variant="ghost" onClick={() => setState("report", undefined)}>
                {t("Close report")}
              </Button>
            </div>
            <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Metric label={t("Changed files")} value={report().changed_files.length} />
              <Metric label={t("Commands")} value={report().commands_run.length} />
              <Metric label={t("Trace events")} value={report().trace_events} />
              <Metric label={t("Messages")} value={report().messages_count} />
            </div>
            <Show when={report().trace_truncated}>
              <p class="text-11-regular text-text-warning">
                {t("The displayed trace is bounded; the persisted trace is larger.")}
              </p>
            </Show>
            <Show when={report().answer}>
              <p class="max-h-40 overflow-auto whitespace-pre-wrap break-words text-12-regular text-text-weak">
                {report().answer}
              </p>
            </Show>
            <Show when={report().changed_files.length > 0}>
              <ul class="max-h-32 overflow-auto">
                <For each={report().changed_files}>
                  {(file) => <li class="break-all text-11-regular text-text-weak">{file}</li>}
                </For>
              </ul>
            </Show>
            <Show when={report().commands_run.length > 0}>
              <ul class="max-h-32 overflow-auto">
                <For each={report().commands_run}>
                  {(command) => (
                    <li class="break-all text-11-regular text-text-weak">
                      {command.success ? "✓" : "✕"} {command.command}
                      {command.returncode === null ? "" : ` · exit ${command.returncode}`}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
function Metric(props: { label: string; value: string | number }) {
  const t = useControlCenterText()
  return (
    <div class="rounded-md border border-border-weak-base p-2">
      <div class="text-14-medium text-text-strong">{props.value}</div>
      <div class="text-10-regular text-text-weak">{props.label}</div>
    </div>
  )
}
function formatTime(value: string, fallback: string) {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
function publicError(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return fallback
}
