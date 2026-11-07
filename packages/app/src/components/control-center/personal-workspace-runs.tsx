import { Button } from "@arforge-ai/ui/button"
import { For, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ManagementDetail } from "./management-detail"
import { ManagementStatus } from "@/components/settings-v2/management-status"
import { formatWorkspaceTime, riskTierLabel, runAuthorityLabel, runInitiatorLabel, statusLabel, workspaceCopy } from "./personal-workspace-presentation"
import type { WorkspaceRunSource, WorkspaceRun } from "./personal-workspace-source"

export function PersonalWorkspaceRuns(props: {
  runs: readonly WorkspaceRun[]
  serverName?: string
  onOpenSource?: (run: WorkspaceRun, current: () => boolean) => Promise<unknown>
}) {
  const language = useLanguage()
  const copy = () => workspaceCopy(language.locale())
  const zh = () => language.locale() === "zh" || language.locale() === "zht"
  const text = (cn: string, en: string) => zh() ? cn : en
  const [state, setState] = createStore({ selected: "", openRequest: 0, navigating: "", error: "" })
  let generation = 0
  let disposed = false
  onCleanup(() => { disposed = true; generation += 1 })
  const selected = () => props.runs.find(run => run.runID === state.selected)
  const sourceLabel = (source: WorkspaceRunSource | undefined) => source?.inspectability === "current"
    ? text("当前来源", "Current source")
    : source?.inspectability === "requires-navigation"
      ? text("其他来源 · 当前只读", "Other workspace · read-only here")
      : source?.inspectability === "session-moved"
        ? text("会话来源已变更 · 只读", "Session source changed · read-only")
        : text("历史来源绑定缺失 · 只读", "Historical source binding missing · read-only")
  const origin = (run: WorkspaceRun) => [props.serverName, run.source?.directory].filter(Boolean).join(" · ") || text("未保存权威绑定", "Authoritative binding not saved")
  const sourceBadge = (source: WorkspaceRunSource | undefined) => source?.inspectability === "current"
    ? text("当前来源", "Current source")
    : source?.inspectability === "session-moved"
      ? text("来源已变更·只读", "Source moved · read-only")
      : source?.inspectability === "requires-navigation"
        ? text("其他来源·只读", "Other workspace · read-only")
        : text("绑定缺失·只读", "Binding missing · read-only")
  const select = (id: string) => {
    generation += 1
    setState({ selected: id, openRequest: state.openRequest + 1, error: "", navigating: "" })
  }
  const open = async (run: WorkspaceRun) => {
    if (!props.onOpenSource || run.source?.inspectability !== "requires-navigation" || state.navigating) return
    const request = ++generation
    setState({ navigating: run.runID, error: "" })
    const current = () => !disposed && request === generation && props.runs.some(item =>
      item.runID === run.runID && item.sessionID === run.sessionID &&
      item.source?.inspectability === "requires-navigation" &&
      item.source.projectID === run.source.projectID && item.source.directory === run.source.directory)
    try { await props.onOpenSource(run, current) }
    catch (error) { if (current()) setState("error", error instanceof Error ? error.message : String(error)) }
    finally { if (current()) setState("navigating", "") }
  }
  return (
    <div class="arforge-management-master-detail" data-testid="personal-workspace-run-history">
      <div class="arforge-management-master-content">
        <ManagementStatus error={state.error || undefined} />
        <div class="arforge-management-entity-list">
          <For each={props.runs}>{run => (
            <div class="arforge-management-entity-row" data-density="double" data-testid="personal-workspace-run-row">
              <button type="button" class="arforge-management-entity-select" data-testid="personal-workspace-run-select"
                data-management-detail-id={run.runID} aria-pressed={selected()?.runID === run.runID} onClick={() => select(run.runID)}>
                <span class="arforge-management-entity-preview" title={run.runID}>{run.runID} · {statusLabel(run.status, language.locale())}</span>
                <span class="arforge-management-entity-meta" title={origin(run)}><code>{origin(run)}</code></span>
              </button>
              <Show when={run.source?.inspectability !== "requires-navigation" || !props.onOpenSource}>
                <span class="shrink-0 whitespace-nowrap rounded-md border border-border-weak-base px-2 py-1 text-12-regular text-text-weak"
                  data-testid="personal-workspace-run-source-badge" aria-label={sourceLabel(run.source)}>
                  {sourceBadge(run.source)}
                </span>
              </Show>
              <Show when={run.source?.inspectability === "requires-navigation" && props.onOpenSource}>
                <Button variant="secondary" size="small" disabled={!!state.navigating} data-testid="personal-workspace-open-source"
                  aria-label={`${text("在原工作区查看", "View in original workspace")}: ${run.runID}`} onClick={() => void open(run)}>
                  {state.navigating === run.runID ? text("正在核对来源…", "Checking source…") : text("在原工作区查看", "View in original workspace")}
                </Button>
              </Show>
            </div>
          )}</For>
        </div>
      </div>
      <Show when={selected()}>{run => (
        <ManagementDetail identity={run().runID} openRequest={state.openRequest} title={text("运行详情", "Run details")}>
          <div class="arforge-management-memory-inspector" data-testid="personal-workspace-run-inspector">
            <strong class="break-all">{run().runID}</strong>
            <dl>
              <Show when={props.serverName}><dt>{text("服务器", "Server")}</dt><dd>{props.serverName}</dd></Show>
              <dt>{text("原工作区", "Original workspace")}</dt><dd>{run().source?.directory ?? text("未保存权威绑定", "Authoritative binding not saved")}</dd>
              <dt>{text("项目绑定", "Project binding")}</dt><dd>{run().source?.projectID ?? text("未保存权威绑定", "Authoritative binding not saved")}</dd>
              <dt>{copy().sessions}</dt><dd>{run().sessionID}</dd>
              <dt>{copy().executionStatus}</dt><dd>{statusLabel(run().status, language.locale())}</dd>
              <dt>{text("自动化状态", "Automation state")}</dt><dd>{statusLabel(run().state, language.locale())}</dd>
              <dt>{copy().initiatedBy}</dt><dd>{runInitiatorLabel(run().initiator, language.locale())}</dd>
              <dt>{text("权限与风险", "Authority and risk")}</dt><dd>{runAuthorityLabel(run().authority, language.locale())} · {riskTierLabel(run().riskTier, language.locale())}</dd>
              <dt>{text("费用", "Cost")}</dt><dd>{run().budget.costMicrosUsed.toLocaleString()} µ / {run().budget.maxCostMicros.toLocaleString()} µ</dd>
              <dt>{copy().updated}</dt><dd>{formatWorkspaceTime(run().updatedAt, language.locale())}</dd>
              <Show when={run().recoveryRequired}><dt>{text("恢复", "Recovery")}</dt><dd>{statusLabel("recovery_required", language.locale())}</dd></Show>
            </dl>
            <p class="text-12-regular text-text-weak">{sourceLabel(run().source)}</p>
            <Show when={run().source?.inspectability !== "current"}>
              <ManagementStatus readOnly={run().source?.inspectability === "requires-navigation"
                ? text("只有点击“在原工作区查看”后才切换来源；当前视图仅保留摘要。", "Only View in original workspace changes the source. This view retains the summary.")
                : run().source?.inspectability === "session-moved"
                  ? text("会话目录与父运行的原来源不一致，不能替换原绑定或按新目录读取子任务。", "The session directory differs from the parent's original source. Its binding cannot be substituted for child reads.")
                  : text("父运行未保存完整来源绑定。不猜测目录、不发起子任务读取，历史记录仍保留。", "The parent has no complete historical source binding. No path is guessed or children queried; the historical row is retained.")} />
            </Show>
          </div>
        </ManagementDetail>
      )}</Show>
    </div>
  )
}
