import { bindManagementApi, createManagementScope, loadManagementPartition, runManagementMutation } from "@/components/settings-v2/management-async"
import { ManagementStatus } from "@/components/settings-v2/management-status"
import "@/components/settings-v2/management-review.css"
import { Button } from "@arforge-ai/ui/button"
import { Checkbox } from "@arforge-ai/ui/checkbox"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import type { OperationsApi } from "@/utils/server"
import { useLanguage } from "@/context/language"
import { useSessionOperationsText } from "./session-operations-text"
import { useSessionOperationsAuxText } from "./session-operations-aux-text"
import { useSessionGoalText } from "@/pages/session/goal/session-goal-text"

type GoalPage = Awaited<ReturnType<OperationsApi["goals"]["list"]>>
type Goal = GoalPage["items"][number]

export function SessionGoalControl(props: { sessionID: string; disabled?: boolean }) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const c = useSessionOperationsText()
  const aux = useSessionOperationsAuxText()
  const goalText = useSessionGoalText()
  const [state, setState] = createStore({
    loading: true,
    saving: false,
    objective: "",
    queue: false,
    editingGoalID: "",
    editingGoalRevision: 0,
    blockReason: "",
    page: { queued: [], history: [], items: [] } as unknown as GoalPage,
    fresh: false,
    readError: "",
    error: "",
    notice: "",
  })
  const source = serverSDK()
  const sessionID = props.sessionID
  const scope = createManagementScope(source, sessionID, () => ({ source: serverSDK(), sessionID: props.sessionID }))
  onCleanup(scope.dispose)
  const scopedAPI = bindManagementApi(source.operationsApi.goals, scope)
  const api = () => scopedAPI
  const blocked = () => !scope.live() || !!props.disabled || state.saving || state.loading || !state.fresh
  const ui = (en: string, zh: string, zht = zh) => {
    if (language.locale() === "zh") return zh
    if (language.locale() === "zht") return zht
    return en
  }
  const message = (error: unknown) => {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    try {
      return JSON.stringify(error)
    } catch {
      return ui("Unknown goal error", "未知目标错误", "未知目標錯誤")
    }
  }
  const refresh = () => loadManagementPartition(scope, "goals",
    () => api().list({ sessionID, history: "true" }), {
      start: () => setState({ loading: true, fresh: false, readError: "" }),
      commit: (page) => { setState("page", reconcile(page)); setState("fresh", true) },
      fail: (error) => setState("readError", message(error)),
      finish: () => setState("loading", false),
    })
  const mutate = async (action: () => Promise<unknown>, notice: string) => {
    if (blocked()) return
    setState({ saving: true, error: "", notice: "" })
    const result = await runManagementMutation(scope, action, async () => {
      const refreshed = await refresh()
      scope.assert()
      if (!refreshed) throw new Error(state.readError)
    })
    if (!scope.live()) return
    if (result.status === "failed") setState({ error: message(result.error), fresh: false })
    if (result.status === "confirmed" || result.status === "confirmed-refresh-failed") {
      setState("notice", notice + (result.status === "confirmed-refresh-failed"
        ? ui(" Refresh failed; retry only refresh, not the write.", " 刷新失败；请仅重试刷新，不要重复提交。") : ""))
    }
    setState("saving", false)
  }
  const revision = (goal: Goal) => ({
    sessionID,
    goalID: goal.id,
    expectedRevision: goal.revision,
  })
  const cancelEdit = () => setState({ objective: "", editingGoalID: "", editingGoalRevision: 0 })
  const replace = (goal: Goal) =>
    setState({ objective: goal.objective, editingGoalID: goal.id, editingGoalRevision: goal.revision })
  const saveEdit = () => {
    if (!state.editingGoalID || !state.objective.trim()) return
    void mutate(
      async () => {
        await api().replace({
          sessionID,
          goalID: state.editingGoalID,
          expectedRevision: state.editingGoalRevision,
          objective: state.objective.trim(),
        })
        cancelEdit()
      },
      ui("Goal objective replaced.", "目标内容已更新。", "目標內容已更新。"),
    )
  }
  const remove = (goal: Goal) => {
    const prompt = ui(
      "Delete queued goal “" + goal.objective + "”?",
      "删除排队目标“" + goal.objective + "”？",
      "刪除排隊目標「" + goal.objective + "」？",
    )
    if (!window.confirm(prompt)) return
    void mutate(
      () => api().deleteQueued(revision(goal)),
      ui("Queued goal deleted.", "排队目标已删除。", "排隊目標已刪除。"),
    )
  }
  const cancel = (goal: Goal) => {
    const prompt = ui(
      "Cancel goal “" + goal.objective + "”?",
      "取消目标“" + goal.objective + "”？",
      "取消目標「" + goal.objective + "」？",
    )
    if (!window.confirm(prompt)) return
    void mutate(() => api().cancel(revision(goal)), ui("Goal cancelled.", "目标已取消。", "目標已取消。"))
  }
  const reorder = (goal: Goal, direction: -1 | 1) => {
    const items = [...state.page.queued]
    const index = items.findIndex((item) => item.id === goal.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= items.length) return
    ;[items[index], items[target]] = [items[target]!, items[index]!]
    void mutate(
      () =>
        api().reorder({
          sessionID,
          goals: items.map((item) => ({ id: item.id, revision: item.revision })),
        }),
      ui("Goal queue reordered.", "目标队列顺序已更新。", "目標佇列順序已更新。"),
    )
  }

  onMount(() => void refresh())

  return (
    <section class="flex flex-col gap-3 border-t border-border-weak-base pt-5" aria-labelledby="operations-goal-title" aria-busy={state.loading || state.saving}>
      <div class="flex items-center justify-between gap-3">
        <h2 id="operations-goal-title" class="text-14-medium text-text-strong">
          {c().goalTitle}
        </h2>
        <Button size="small" variant="ghost" disabled={state.loading || state.saving} onClick={() => void refresh()}>
          {language.t("controlCenter.m020")}
        </Button>
      </div>
      <p class="text-12-regular text-text-weak">{c().goalDescription}</p>
      <ManagementStatus saving={state.saving} error={state.error} notice={state.notice} />
      <ManagementStatus loading={state.loading} saving={state.saving} error={state.readError} onRetry={() => void refresh()} />
      <TextField
        label={goalText().editLabel}
        multiline
        value={state.objective}
        onChange={(value) => setState("objective", value)}
        placeholder={goalText().menuDescription}
        disabled={blocked()}
      />
      <div class="flex flex-wrap items-center gap-3">
        <Show when={!state.editingGoalID}>
          <Checkbox checked={state.queue} onChange={(value) => setState("queue", value)}>
            {aux().appendGoal}
          </Checkbox>
        </Show>
        <Show
          when={state.editingGoalID}
          fallback={
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={blocked() || !state.objective.trim()}
              onClick={() =>
                void mutate(
                  async () => {
                    await api().create({
                      sessionID,
                      objective: state.objective.trim(),
                      queue: state.queue,
                    })
                    setState("objective", "")
                  },
                  ui("Goal created.", "目标已创建。", "目標已建立。"),
                )
              }
            >
              {aux().createGoal}
            </Button>
          }
        >
          <Button
            type="button"
            size="small"
            variant="secondary"
            disabled={blocked() || !state.objective.trim()}
            onClick={saveEdit}
          >
            {ui("Save goal", "保存目标", "儲存目標")}
          </Button>
          <Button type="button" size="small" variant="ghost" disabled={blocked()} onClick={cancelEdit}>
            {language.t("common.cancel")}
          </Button>
        </Show>
      </div>
      <TextField
        label={aux().blockedReason}
        value={state.blockReason}
        onChange={(value) => setState("blockReason", value)}
        placeholder={aux().blockedPlaceholder}
        disabled={blocked()}
      />

      <Show when={state.page.active}>
        {(active) => (
          <article class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div class="text-13-medium text-text-strong">{active().objective}</div>
                <div class="text-11-regular text-text-weak">
                  {goalText().status[active().status]} · {ui("revision", "版本", "版本")} {active().revision}
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <Show when={active().status === "active"}>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={blocked()}
                    onClick={() =>
                      void mutate(
                        () => api().run(revision(active())),
                        ui("Goal prompt queued for execution.", "目标已加入执行队列。", "目標已加入執行佇列。"),
                      )
                    }
                  >
                    {goalText().run}
                  </Button>
                </Show>
                <Show
                  when={active().status === "active" || active().status === "running" || active().status === "blocked"}
                >
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={blocked()}
                    onClick={() =>
                      void mutate(
                        () => api().pause(revision(active())),
                        ui("Goal paused.", "目标已暂停。", "目標已暫停。"),
                      )
                    }
                  >
                    {goalText().pause}
                  </Button>
                </Show>
                <Show when={active().status === "paused" || active().status === "blocked"}>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={blocked()}
                    onClick={() =>
                      void mutate(
                        () => api().resume(revision(active())),
                        ui("Goal resumed.", "目标已恢复。", "目標已恢復。"),
                      )
                    }
                  >
                    {goalText().resume}
                  </Button>
                </Show>
                <Show when={active().status === "active" || active().status === "running"}>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={blocked()}
                    onClick={() =>
                      void mutate(
                        () => api().complete(revision(active())),
                        ui("Goal completed.", "目标已完成。", "目標已完成。"),
                      )
                    }
                  >
                    {goalText().status.completed}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={blocked() || !state.blockReason.trim()}
                    onClick={() =>
                      void mutate(
                        () => api().block({ ...revision(active()), error: state.blockReason.trim() }),
                        ui("Goal marked blocked.", "目标已标记为阻塞。", "目標已標記為阻塞。"),
                      )
                    }
                  >
                    {aux().blockGoal}
                  </Button>
                </Show>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={blocked() || state.editingGoalID === active().id}
                  onClick={() => replace(active())}
                >
                  {language.t("common.edit")}
                </Button>
                <Button size="small" variant="ghost" disabled={blocked()} onClick={() => cancel(active())}>
                  {goalText().cancel}…
                </Button>
              </div>
            </div>
            <Show when={active().lastError}>
              <p class="whitespace-pre-wrap break-words text-12-regular text-text-weak">{active().lastError}</p>
            </Show>
          </article>
        )}
      </Show>

      <div class="flex flex-col gap-2">
        <For each={state.page.queued}>
          {(goal, index) => (
            <article class="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border-weak-base p-3">
              <div>
                <div class="text-13-medium text-text-strong">{goal.objective}</div>
                <div class="text-11-regular text-text-weak">
                  {ui("queued", "排队序号", "排隊序號")} #{goal.queuePosition} · {ui("revision", "版本", "版本")}{" "}
                  {goal.revision}
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button
                  size="small"
                  variant="ghost"
                  disabled={blocked() || index() === 0}
                  aria-label={ui("Move goal up", "目标上移", "目標上移")}
                  onClick={() => reorder(goal, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={blocked() || index() === state.page.queued.length - 1}
                  aria-label={ui("Move goal down", "目标下移", "目標下移")}
                  onClick={() => reorder(goal, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={blocked() || state.editingGoalID === goal.id}
                  onClick={() => replace(goal)}
                >
                  {language.t("common.edit")}
                </Button>
                <Button size="small" variant="ghost" disabled={blocked()} onClick={() => remove(goal)}>
                  {language.t("common.delete")}…
                </Button>
              </div>
            </article>
          )}
        </For>
      </div>

      <Show when={state.page.history.length > 0}>
        <details>
          <summary class="cursor-pointer text-12-medium text-text-strong">
            {aux().goalHistory} ({state.page.history.length})
          </summary>
          <div class="mt-2 flex flex-col gap-2">
            <For each={state.page.history}>
              {(goal) => (
                <article class="rounded-md border border-border-weak-base p-3">
                  <div class="text-12-medium text-text-strong">{goal.objective}</div>
                  <div class="text-11-regular text-text-weak">
                    {goalText().status[goal.status]} · {ui("revision", "版本", "版本")} {goal.revision}
                  </div>
                  <Show when={goal.lastError}>
                    <p class="whitespace-pre-wrap break-words text-11-regular text-text-weak">{goal.lastError}</p>
                  </Show>
                </article>
              )}
            </For>
          </div>
        </details>
      </Show>
      <Show when={!state.loading && !state.readError && !state.error && !state.page.active && state.page.queued.length === 0}>
        <p class="text-12-regular text-text-weak">{aux().noGoals}</p>
      </Show>
    </section>
  )
}
