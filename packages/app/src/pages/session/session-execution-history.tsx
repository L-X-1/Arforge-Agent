import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { safeControlServerLabel } from "@/context/control-approval"
import { useSessionLayout } from "./session-layout"
import { ManagementStatus } from "@/components/settings-v2/management-status"
import { managementErrorText } from "@/components/settings-v2/management-state"
import { canReadRunSource, navigateToRunSource, selectRunSourceSession, workspaceSnapshotSources } from "@/components/control-center/personal-workspace-source"
import { statusLabel } from "@/components/control-center/personal-workspace-presentation"
import { ExecutionStepDetail } from "./execution-step-detail"
import { ExecutionEvidenceViews, type ExecutionEvidenceView } from "./execution-evidence-view"
import { projectExecutionEvidence } from "./execution-evidence"
import { executionToolKey, executionToolStep } from "./execution-trace-model"
import { projectRunHistory, readSessionHistory, type RunHistorySummary, type SessionHistoryEvent } from "./execution-run-history-model"
import type { OperationsApi } from "@/utils/server"
import "./session-execution-history.css"

type NativeSession = Awaited<ReturnType<OperationsApi["sessions"]["get"]>>

export function SessionExecutionHistory() {
  const sdk = useSDK()
  const server = useServerSDK()
  const tabs = useTabs()
  const language = useLanguage()
  const { params } = useSessionLayout()
  const t = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  const [state, setState] = createStore({
    loading: false, loaded: false, error: "", navigating: false,
    session: undefined as NativeSession | undefined,
    events: [] as SessionHistoryEvent[], summaries: [] as RunHistorySummary[],
    selected: undefined as string | undefined, step: undefined as string | undefined,
    tool: undefined as string | undefined, view: "tools" as ExecutionEvidenceView,
  })
  const scope = () => `${server().scope}\u0000${sdk().directory}\u0000${params.id ?? ""}`
  let generation = 0
  let navigationGeneration = 0
  let disposed = false
  let controller: AbortController | undefined
  let refreshTimer: number | undefined
  let dirty = false
  const projection = createMemo(() => projectRunHistory(params.id ?? "", state.events, state.summaries))
  const selected = createMemo(() => state.selected
    ? projection().runs.find(run => run.runID === state.selected)
    : projection().runs[0])
  const inspectable = () => {
    const summary = selected()?.summary
    const session = state.session
    return !!summary && !!session && summary.sessionID === session.id && canReadRunSource(summary, {
      projectID: session.projectID, directory: session.location.directory,
    })
  }
  const traces = createMemo(() => inspectable() && selected() ? projection().traces(selected()!.runID) : [])
  const steps = createMemo(() => traces().flatMap((trace) => trace.steps))
  const evidence = createMemo(() => projectExecutionEvidence(traces(), selected()?.summary?.source.directory))
  const selectedStep = createMemo(() => state.step ? steps().find(step => step.id === state.step) : steps()[0])
  const detailStep = createMemo(() => (state.tool ? executionToolStep(steps(), state.tool) : undefined) ?? selectedStep())
  const sourceText = () => [safeControlServerLabel(ServerConnection.key(server().server)), state.session?.location.directory ?? sdk().directory, params.id].filter(Boolean).join(" · ")
  const refreshSoon = () => {
    dirty = true
    if (state.loading || refreshTimer !== undefined) return
    refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void load() }, 150)
  }
  const load = async () => {
    const sessionID = params.id
    if (!sessionID) return
    controller?.abort()
    const signal = (controller = new AbortController()).signal
    const version = ++generation
    const origin = scope()
    const source = server()
    const api = source.operationsApi
    const directory = sdk().directory
    const current = () => !disposed && version === generation && origin === scope() && !signal.aborted
    dirty = false
    setState({ loading: true, error: "" })
    try {
      const session = await api.sessions.get({ sessionID }, { signal })
      if (!current()) return
      if (session.id !== sessionID || session.location.directory !== directory) throw new Error(t("会话来源已变化，请回到原工作区重新打开。", "The session source changed. Reopen it in its original workspace."))
      const results = await Promise.allSettled([
        readSessionHistory(sessionID, input => api.sessions.history(input, { signal }), signal),
        api.personalWorkspace.snapshot({ location: { directory, workspace: session.location.workspaceID }, limit: 100 }, { signal }),
      ])
      if (!current()) return
      setState("session", session)
      const errors: string[] = []
      if (results[0].status === "fulfilled") setState("events", [...results[0].value])
      else errors.push(managementErrorText(results[0].reason).slice(0, 500))
      if (results[1].status === "fulfilled") setState("summaries", [...workspaceSnapshotSources(results[1].value).runs])
      else errors.push(managementErrorText(results[1].reason).slice(0, 500))
      setState({ loaded: true, error: errors.join("\n") })
    } catch (error) {
      if (current()) setState("error", managementErrorText(error).slice(0, 500))
    } finally {
      if (current()) {
        setState("loading", false)
        if (dirty) refreshSoon()
      }
    }
  }
  createEffect(on(scope, () => {
    controller?.abort()
    generation++
    navigationGeneration++
    setState({ loaded: false, error: "", navigating: false, session: undefined, events: [], summaries: [],
      selected: undefined, step: undefined, tool: undefined, view: "tools" })
    void load()
  }))
  createEffect(() => {
    const source = server()
    const stop = source.event.listen(message => {
      if (message.name !== sdk().directory) return
      const event = message.details.current
      if (!event || !["agent.run.state-changed", "session.next.step.started", "session.next.step.ended", "session.next.step.failed"].includes(event.type)) return
      if ("sessionID" in event.data && event.data.sessionID === params.id) refreshSoon()
    })
    onCleanup(stop)
  })
  onCleanup(() => {
    disposed = true
    generation++
    navigationGeneration++
    controller?.abort()
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
  })
  const openSource = async () => {
    const run = selected()?.summary
    if (!run || state.navigating) return
    const version = ++navigationGeneration
    const origin = scope()
    const source = server()
    const current = () => !disposed && navigationGeneration === version && origin === scope() && selected()?.runID === run.runID
      && selected()?.summary?.source.directory === run.source.directory && selected()?.summary?.source.projectID === run.source.projectID
    setState({ navigating: true, error: "" })
    try {
      await navigateToRunSource(run, {
        current,
        getSession: async sessionID => { const info = await source.operationsApi.sessions.get({ sessionID }); return { id: info.id, projectID: info.projectID, directory: info.location.directory } },
        getLocation: async directory => { const location = await source.operationsApi.location.get({ location: { directory } }); return { projectID: location.project.id, directory: location.directory } },
        selectSession: sessionID => selectRunSourceSession(tabs, ServerConnection.key(source.server), sessionID),
      })
    } catch (error) { if (current()) setState("error", managementErrorText(error).slice(0, 500)) }
    finally { if (!disposed && navigationGeneration === version && origin === scope()) setState("navigating", false) }
  }
  return <section class="execution-history" data-component="session-execution-history" aria-label={t("当前会话运行历史", "Run history for this session")}>
    <div class="execution-history-toolbar"><p class="execution-history-metadata">{sourceText()}</p>
      <button type="button" disabled={state.loading} onClick={() => void load()}>{t("刷新历史", "Refresh history")}</button></div>
    <ManagementStatus loading={state.loading} initialLoading={!state.loaded} error={state.error || undefined}
      partial={state.loaded && !!state.error} onRetry={() => void load()} />
    <p class="execution-history-metadata">{t("历史只读，不会改变当前运行或停止目标。运行摘要最多读取100条；缺失的旧状态与来源会明确标记。", "History is read-only and does not change the current execution or stop target. Run summaries are limited to100; missing older status or source bindings stay explicit.")}</p>
    <Show when={projection().unboundAssistantIDs.length > 0}><p class="execution-history-metadata" role="status">
      {t("另有未绑定运行ID的旧步骤，未归入任何运行：", "Legacy steps without a run binding are not assigned to any run: ")}{projection().unboundAssistantIDs.join(", ")}
    </p></Show>
    <Show when={state.loaded && !state.loading && projection().runs.length === 0}><p>{t("当前会话尚无可读取的持久运行。", "No durable runs are available for this session.")}</p></Show>
    <div class="execution-history-list" role="list" aria-label={t("运行记录", "Durable runs")}>
      <For each={projection().runs}>{run => <div role="listitem"><button type="button" data-history-run={run.runID}
        aria-pressed={selected()?.runID === run.runID} onClick={() => {
          navigationGeneration++
          setState({ selected: run.runID, step: undefined, tool: undefined, view: "tools", navigating: false })
        }}>
        <span>{run.runID}</span><span class="execution-history-metadata">{run.summary ? statusLabel(run.summary.status, language.locale()) : t("运行状态未读取", "Run status unavailable")}</span>
      </button></div>}</For>
    </div>
    <Show when={selected()}>{run => <div class="execution-history-detail">
      <h3>{run().runID}</h3>
      <p class="execution-history-metadata">{run().models.join(" · ")}</p>
      <p class="execution-history-metadata">
        <Show when={!run().summary?.source.directory || run().summary?.source.inspectability === "missing-binding"}>
          {t("历史来源绑定缺失 · 只读", "Historical source binding missing · read-only")}
          {run().summary?.source.directory ? " · " : ""}
        </Show>
        {run().summary?.source.directory}
      </p>
      <Show when={!inspectable()}><p role="status">{t("此记录不属于当前可检查来源，未读取其步骤正文。", "This record is not bound to the current inspectable source; its step content is not displayed.")}</p></Show>
      <Show when={run().summary?.source.inspectability === "requires-navigation"}>
        <button type="button" disabled={state.navigating} onClick={() => void openSource()}>{state.navigating ? t("正在核对来源…", "Checking source…") : t("在原工作区查看", "View in original workspace")}</button>
      </Show>
      <Show when={inspectable()}>
        <ExecutionEvidenceViews evidence={evidence()} view={state.view}
          onView={(view) => setState("view", view)}
          onTool={(tool) => setState({ tool, step: steps().find((step) => step.tools?.some((part) => executionToolKey(part) === tool))?.id })}
          chinese={language.locale().startsWith("zh")}>
          <Show when={steps().length > 0} fallback={<p>{t("此运行没有已记录的可展开步骤。", "No expandable steps were recorded for this run.")}</p>}>
            <div class="execution-history-steps"><For each={steps()}>{step => <button type="button" data-history-step={step.id}
              aria-pressed={selectedStep()?.id === step.id} onClick={() => setState({ step: step.id, tool: undefined })}>
              <span>{step.title || step.kind}</span><span class="execution-history-metadata">{step.status}</span>
            </button>}</For></div>
            <Show when={detailStep()}>{step => <ExecutionStepDetail step={step()} chinese={language.locale().startsWith("zh")}
              focusTool={state.tool} directory={run().summary?.source.directory} />}</Show>
          </Show>
        </ExecutionEvidenceViews>
      </Show>
    </div>}</Show>
  </section>
}
