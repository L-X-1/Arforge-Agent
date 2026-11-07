import { For, Show, createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@arforge-ai/ui/button"
import { useLanguage } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard } from "@/utils/scope-request"
import { readSessionHistory } from "@/pages/session/execution-run-history-model"
import { projectWaitSources, joinWaitChildren, type WaitChildGroup, type WaitSourceLocation } from "./session-wait-sources"

/** Read-only source preview. Decisions stay in the conversation and child-control owners. */
export function SessionWaitSourcesPanel(props: {
  api: OperationsApi
  sessionID: string
  location: WaitSourceLocation
}) {
  const language = useLanguage()
  const t = (en: string, zh: string, zht = zh) => language.locale() === "zh" ? zh : language.locale() === "zht" ? zht : en
  const [state, setState] = createStore({ loading: false, error: "", data: undefined as ReturnType<typeof projectWaitSources> | undefined, groups: [] as WaitChildGroup[] })
  let disposed = false, controller: AbortController | undefined
  const scope = () => JSON.stringify([props.sessionID, props.location.directory, props.location.workspace ?? ""])
  const guard = createScopeRequestGuard(scope)
  onCleanup(() => { disposed = true; controller?.abort(); guard.invalidate() })
  const load = async () => {
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal, request = guard.invalidate(), api = props.api
    const sessionID = props.sessionID, location = { ...props.location }
    const current = () => !disposed && !signal.aborted && guard.isCurrent(request) && props.api === api
    setState({ loading: true, error: "", data: undefined, groups: [] })
    try {
      const [events, requests] = await Promise.all([
        readSessionHistory(sessionID, input => api.sessions.history(input, { signal }), signal),
        api.permissions.list({ sessionID }, { signal }),
      ])
      if (!current()) return
      const data = projectWaitSources({ sessionID, location, events, requests })
      // Bound the read fanout visibly. Older calls remain explicitly incomplete.
      const parents = [...new Set(data.tasks.map(task => task.parentRunID))].slice(0, 12)
      const groups = await Promise.all(parents.map(async parentRunID => {
        try { return await api.subagentControl.children({ parentRunID, location }, { signal }) }
        catch { return undefined }
      }))
      if (current()) setState({ data, groups: groups.filter((group): group is WaitChildGroup => group !== undefined) })
    } catch (error) {
      if (current()) setState("error", error instanceof Error ? error.message : String(error))
    } finally { if (current()) setState("loading", false) }
  }
  createEffect(on(() => [scope(), props.api] as const, () => void load()))
  const children = () => joinWaitChildren(state.data?.tasks ?? [], state.groups)
  const childState = (child: ReturnType<typeof children>[number]["child"]) => {
    if (!child) return t("Child source unavailable", "子任务来源暂不可用", "子任務來源暫不可用")
    if (child.resultReceiptStatus === "present") return t("Result receipt present; parent continuation is separate", "结果回执已存在；父任务是否继续须单独确认", "結果回執已存在；父任務是否繼續須另外確認")
    if (child.resultReceiptStatus === "missing") return t("Result receipt missing", "结果回执缺失", "結果回執缺失")
    if (child.resultReceiptStatus === "not-required") return t("Cancelled; no result receipt required", "已取消；无需结果回执", "已取消；無需結果回執")
    if (child.resultReceiptStatus === "pending") return t("Waiting for child result", "等待子任务结果", "等待子任務結果")
    return t("Result receipt unknown", "结果回执状态未知", "結果回執狀態未知")
  }
  return <section class="flex flex-col gap-3" data-testid="session-wait-sources" aria-busy={state.loading}>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-13-medium text-text-strong">{t("Approval and child sources", "审批与子任务来源", "審批與子任務來源")}</h3>
      <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void load()}>{t("Refresh sources", "刷新来源", "重新整理來源")}</Button>
    </div>
    <p class="text-11-regular text-text-weak">{t("Read-only snapshot. Open the original conversation for approval or Personal Workspace for child controls. Timed Wait wake does not resolve either source.", "这里只读展示当前快照。审批请打开原会话，子任务控制位于个人工作台；定时 Wait 的唤醒不会替代这些操作。", "這裡唯讀顯示目前快照。審批請開啟原對話，子任務控制位於個人工作台；定時 Wait 的喚醒不會取代這些操作。")}</p>
    <Show when={state.error}><p role="alert" class="text-12-regular text-text-warning">{state.error}</p></Show>
    <For each={state.data?.approvals}>{approval => <article class="flex flex-col gap-1 rounded-md border border-border-warning p-3" data-testid="wait-approval-source">
      <b class="text-12-medium">{t("Waiting for approval", "等待审批", "等待審批")} · {approval.action}</b>
      <code class="break-all text-11-regular">{approval.requestID}</code>
      <Show when={approval.source}>{source => <code class="break-all text-11-regular">{source().messageID} · {source().callID}</code>}</Show>
      <Show when={approval.parentRunID} fallback={<span class="text-11-regular text-text-weak">{t("Parent Run binding unavailable", "父任务 Run 关联不可用", "父任務 Run 關聯不可用")}</span>}>{runID => <code class="break-all text-11-regular">{runID()}</code>}</Show>
    </article>}</For>
    <For each={children()}>{source => <article class="flex flex-col gap-1 rounded-md border border-border-weak-base p-3" data-testid="wait-child-source">
      <b class="text-12-medium">{childState(source.child)}</b>
      <code class="break-all text-11-regular">{source.parentRunID} → {source.childRunID}</code>
      <code class="break-all text-11-regular">{source.childSessionID} · {source.assistantMessageID} · {source.callID}</code>
    </article>}</For>
    <Show when={(state.data?.incomplete ?? 0) > 0}><p class="text-11-regular text-text-weak">{t("Some Task calls have no complete stored child binding.", "部分 Task 调用尚无完整的已存储子任务关联。", "部分 Task 呼叫尚無完整的已儲存子任務關聯。")}</p></Show>
    <Show when={state.data && !state.data.approvals.length && !state.data.tasks.length && !state.data.incomplete}><p class="text-12-regular text-text-weak">{t("No pending approval or bound foreground child call in this snapshot.", "当前快照没有待审批请求或已关联的前台子任务调用。", "目前快照沒有待審批請求或已關聯的前景子任務呼叫。")}</p></Show>
  </section>
}
