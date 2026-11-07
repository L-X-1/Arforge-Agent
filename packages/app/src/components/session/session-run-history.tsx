import { ManagementCollection } from "../control-center/management-collection"
import { ManagementStatus } from "../settings-v2/management-status"
import { useControlCenterText } from "@/components/control-center/control-center-text"
import { useLanguage } from "@/context/language"
import { Button } from "@arforge-ai/ui/button"
import { For, Show, createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"
import { hasOperationDirectory } from "./session-operation-boundary"
import "@/components/preview/workbench-review.css"
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
  const language = useLanguage()
  let request = 0
  onCleanup(() => request++)
  const [state, setState] = createStore({
    loading: true,
    error: "",
    limit: 20,
    items: [] as RunSummary[],
    report: undefined as RunReport | undefined,
  })
  const refresh = async () => {
    if (props.disabled) return
    const location = props.location()
    if (!hasOperationDirectory(location)) {
      setState({
        loading: false,
        error: t("Workspace context is still loading. Reopen this panel if the Session was just imported."),
      })
      return
    }
    if (state.loading && state.items.length > 0) return
    const current = ++request
    const api = props.api()
    setState({ loading: true, error: "" })
    try {
      const result = await api.agentCapabilities.runList({
        ...location,
        limit: state.limit,
      })
      if (current !== request) return
      setState({ items: [...result.data.items] })
      if (state.report && !result.data.items.some((item) => item.run_id === state.report?.run_id)) {
        setState("report", undefined)
      }
    } catch (error) {
      if (current !== request) return
      setState("error", publicError(error, t("Run history could not be loaded. Refresh and try again.")))
    } finally {
      if (current === request) setState("loading", false)
    }
  }
  const open = async (runID: string) => {
    if (props.disabled || state.loading || !hasOperationDirectory(props.location())) return
    const current = ++request
    const api = props.api()
    const location = props.location()
    setState({ loading: true, error: "" })
    try {
      const result = await api.agentCapabilities.runReport({
        ...location,
        runID,
      })
      if (current !== request) return
      if (!result.data.found) {
        setState({
          report: undefined,
          error: t("Run {{run}} no longer exists. Refresh the list.", { run: runID }),
        })
        return
      }
      setState("report", result.data.report)
    } catch (error) {
      if (current !== request) return
      setState("error", publicError(error, t("Run history could not be loaded. Refresh and try again.")))
    } finally {
      if (current === request) setState("loading", false)
    }
  }
  createEffect(
    on(
      [() => props.api(), () => props.location().location.directory, () => props.location().location.workspace],
      () => {
        request++
        setState({ items: [], report: undefined, error: "", loading: false })
        if (hasOperationDirectory(props.location())) void refresh()
      },
    ),
  )
  return (
    <div
      class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
      data-testid="run-history"
      aria-busy={state.loading}
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="arforge-management-section-title text-text-strong">{t("Persistent run history")}</h3>
          <p class="arforge-management-copy text-text-weak">
            {t(
              "Read the Arforge Core transaction, trace, and message artifacts through the shared typed Server API. Reports are read-only and remain owned by one persistence source.",
            )}
          </p>
        </div>
        <div class="flex items-end gap-2">
          <label class="flex flex-col gap-1 arforge-management-section-title text-text-strong">
            {t("Limit")}
            <select
              class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 arforge-management-copy text-text-strong"
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
        <p role="alert" class="rounded-md border border-border-warning p-3 arforge-management-copy text-text-warning">
          {state.error}
        </p>
      </Show>
      <ManagementStatus
        loading={state.loading}
        initialLoading={state.items.length === 0}
        scope={props.location().location.directory}
      />

      <ManagementCollection
        label={t("Persistent run history")}
        scope={JSON.stringify(props.location().location)}
        scopeLabel={props.location().location.directory}
        items={state.items}
        identity={(item) => item.run_id}
        title={(item) => item.run_id}
        description={(item) =>
          formatTime(item.created, t("Time unknown")) + " · " + item.changed_files + " " + t("Changed files")
        }
        searchText={(item) => item.answer_preview ?? ""}
        selectedIdentity={state.report?.run_id}
        loading={state.loading}
        selectionDisabled={props.disabled || state.loading}
        onSelect={(item) => void open(item.run_id)}
        emptyText={t("No persisted runs are available in this Arforge profile.")}
      >
        {(item) => (
          <div class="arforge-management-task-form">
            <dl class="arforge-management-definition">
              <div>
                <dt>Run ID</dt>
                <dd>
                  <code>{item.run_id}</code>
                </dd>
              </div>
              <div>
                <dt>{t("Trace events")}</dt>
                <dd>{item.trace_events}</dd>
              </div>
              <div>
                <dt>{t("Messages")}</dt>
                <dd>{item.messages_count}</dd>
              </div>
            </dl>
            <Show when={state.report?.run_id === item.run_id ? state.report : undefined}>
              {(report) => (
                <div class="flex flex-col gap-3 rounded-md bg-background-weak p-3" data-testid="run-report">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <h4 class="arforge-management-section-title text-text-strong">{report().run_id}</h4>
                    <Button size="small" variant="ghost" onClick={() => setState("report", undefined)}>
                      {t("Close report")}
                    </Button>
                  </div>
                  <div data-slot="run-report-metrics" class="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Metric label={t("Changed files")} value={report().changed_files.length} />
                    <Metric label={t("Commands")} value={report().commands_run.length} />
                    <Metric label={t("Trace events")} value={report().trace_events} />
                    <Metric label={t("Messages")} value={report().messages_count} />
                  </div>
                  <Show when={report().trace_truncated}>
                    <p class="arforge-management-copy text-text-warning">
                      {t("The displayed trace is bounded; the persisted trace is larger.")}
                    </p>
                  </Show>
                  <Show when={report().answer}>
                    <p class="max-h-40 overflow-auto whitespace-pre-wrap break-words arforge-management-copy text-text-weak">
                      {report().answer}
                    </p>
                  </Show>
                  <Show when={report().changed_files.length > 0}>
                    <ul class="max-h-32 overflow-auto">
                      <For each={report().changed_files}>
                        {(file) => <li class="break-all arforge-management-copy text-text-weak">{file}</li>}
                      </For>
                    </ul>
                  </Show>
                  <Show when={report().commands_run.length > 0}>
                    <ul class="max-h-32 overflow-auto">
                      <For each={report().commands_run}>
                        {(command) => (
                          <li class="break-all arforge-management-copy text-text-weak">
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
        )}
      </ManagementCollection>
    </div>
  )
}
function Metric(props: { label: string; value: string | number }) {
  const t = useControlCenterText()
  return (
    <div class="rounded-md border border-border-weak-base p-2">
      <div class="text-14-medium text-text-strong">{props.value}</div>
      <div class="arforge-management-copy text-text-weak">{props.label}</div>
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
