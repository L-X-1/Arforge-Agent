import { Button } from "@arforge-ai/ui/button"
import { Checkbox } from "@arforge-ai/ui/checkbox"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import type { OperationsApi } from "@/utils/server"
import { useLanguage } from "@/context/language"
import { useSessionOperationsText } from "./session-operations-text"
import { useSessionOperationsAuxText } from "./session-operations-aux-text"
import { useSessionGoalText } from "@/pages/session/goal/session-goal-text"

type GoalPage = Awaited<ReturnType<OperationsApi["goals"]["list"]>>
type Goal = GoalPage["items"][number]

export function SessionGoalControl(props: { sessionID: string }) {
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
    error: "",
    notice: "",
  })
  const api = () => serverSDK().operationsApi.goals
  const message = (error: unknown) => {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    try {
      return JSON.stringify(error)
    } catch {
      return "Unknown goal error"
    }
  }
  const refresh = async () => {
    setState("loading", true)
    try {
      setState("page", reconcile(await api().list({ sessionID: props.sessionID, history: "true" })))
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("loading", false)
    }
  }
  const mutate = async (action: () => Promise<unknown>, notice: string) => {
    if (state.saving) return
    setState({ saving: true, error: "", notice: "" })
    try {
      await action()
      await refresh()
      setState("notice", notice)
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("saving", false)
    }
  }
  const revision = (goal: Goal) => ({
    sessionID: props.sessionID,
    goalID: goal.id,
    expectedRevision: goal.revision,
  })
  const cancelEdit = () => setState({ objective: "", editingGoalID: "", editingGoalRevision: 0 })
  const replace = (goal: Goal) =>
    setState({ objective: goal.objective, editingGoalID: goal.id, editingGoalRevision: goal.revision })
  const saveEdit = () => {
    if (!state.editingGoalID || !state.objective.trim()) return
    void mutate(async () => {
      await api().replace({
        sessionID: props.sessionID,
        goalID: state.editingGoalID,
        expectedRevision: state.editingGoalRevision,
        objective: state.objective.trim(),
      })
      cancelEdit()
    }, "Goal objective replaced.")
  }
  const remove = (goal: Goal) => {
    if (!window.confirm(`Delete queued goal “${goal.objective}”?`)) return
    void mutate(() => api().deleteQueued(revision(goal)), "Queued goal deleted.")
  }
  const cancel = (goal: Goal) => {
    if (!window.confirm(`Cancel goal “${goal.objective}”?`)) return
    void mutate(() => api().cancel(revision(goal)), "Goal cancelled.")
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
          sessionID: props.sessionID,
          goals: items.map((item) => ({ id: item.id, revision: item.revision })),
        }),
      "Goal queue reordered.",
    )
  }

  onMount(() => void refresh())

  return (
    <section class="flex flex-col gap-3 border-t border-border-weak-base pt-5" aria-labelledby="operations-goal-title">
      <div class="flex items-center justify-between gap-3">
        <h2 id="operations-goal-title" class="text-14-medium text-text-strong">
          {c().goalTitle}
        </h2>
        <Button size="small" variant="ghost" disabled={state.saving} onClick={() => void refresh()}>
          {language.t("controlCenter.m020")}
        </Button>
      </div>
      <p class="text-12-regular text-text-weak">{c().goalDescription}</p>
      <TextField
        label={goalText().editLabel}
        multiline
        value={state.objective}
        onChange={(value) => setState("objective", value)}
        placeholder={goalText().menuDescription}
        disabled={state.saving}
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
              disabled={state.saving || !state.objective.trim()}
              onClick={() =>
                void mutate(async () => {
                  await api().create({
                    sessionID: props.sessionID,
                    objective: state.objective.trim(),
                    queue: state.queue,
                  })
                  setState("objective", "")
                }, "Goal created.")
              }
            >
              {aux().createGoal}
            </Button>
          }
        >
          <Button type="button" size="small" variant="secondary" disabled={state.saving || !state.objective.trim()} onClick={saveEdit}>
            {language.t("common.save")} Goal
          </Button>
          <Button type="button" size="small" variant="ghost" disabled={state.saving} onClick={cancelEdit}>
            {language.t("common.cancel")}
          </Button>
        </Show>
      </div>
      <TextField
        label={aux().blockedReason}
        value={state.blockReason}
        onChange={(value) => setState("blockReason", value)}
        placeholder={aux().blockedPlaceholder}
        disabled={state.saving}
      />

      <Show when={state.page.active}>
        {(active) => (
          <article class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div class="text-13-medium text-text-strong">{active().objective}</div>
                <div class="text-11-regular text-text-weak">
                  {active().status} · revision {active().revision}
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <Show when={active().status === "active"}>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={state.saving}
                    onClick={() =>
                      void mutate(() => api().run(revision(active())), "Goal prompt queued for execution.")
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
                    disabled={state.saving}
                    onClick={() => void mutate(() => api().pause(revision(active())), "Goal paused.")}
                  >
                    {goalText().pause}
                  </Button>
                </Show>
                <Show when={active().status === "paused" || active().status === "blocked"}>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={state.saving}
                    onClick={() => void mutate(() => api().resume(revision(active())), "Goal resumed.")}
                  >
                    {goalText().resume}
                  </Button>
                </Show>
                <Show when={active().status === "active" || active().status === "running"}>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={state.saving}
                    onClick={() => void mutate(() => api().complete(revision(active())), "Goal completed.")}
                  >
                    {goalText().status.completed}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={state.saving || !state.blockReason.trim()}
                    onClick={() =>
                      void mutate(
                        () => api().block({ ...revision(active()), error: state.blockReason.trim() }),
                        "Goal marked blocked.",
                      )
                    }
                  >
                    {aux().blockGoal}
                  </Button>
                </Show>
                <Button size="small" variant="ghost" disabled={state.saving || state.editingGoalID === active().id} onClick={() => replace(active())}>
                  {language.t("common.edit")}
                </Button>
                <Button size="small" variant="ghost" disabled={state.saving} onClick={() => cancel(active())}>
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
                  queued #{goal.queuePosition} · revision {goal.revision}
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button
                  size="small"
                  variant="ghost"
                  disabled={state.saving || index() === 0}
                  onClick={() => reorder(goal, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={state.saving || index() === state.page.queued.length - 1}
                  onClick={() => reorder(goal, 1)}
                >
                  ↓
                </Button>
                <Button size="small" variant="ghost" disabled={state.saving || state.editingGoalID === goal.id} onClick={() => replace(goal)}>
                  {language.t("common.edit")}
                </Button>
                <Button size="small" variant="ghost" disabled={state.saving} onClick={() => remove(goal)}>
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
                    {goal.status} · revision {goal.revision}
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
      <Show when={!state.loading && !state.page.active && state.page.queued.length === 0}>
        <p class="text-12-regular text-text-weak">{aux().noGoals}</p>
      </Show>
      <Show when={state.notice}>
        <p role="status" aria-live="polite" class="text-12-regular text-text-weak">{state.notice}</p>
      </Show>
      <Show when={state.error}>
        <div role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-warning p-3">
          <p class="whitespace-pre-wrap break-words text-12-regular text-text-critical">{state.error}</p>
          <Button type="button" size="small" variant="ghost" disabled={state.loading || state.saving} onClick={() => void refresh()}>
            {language.t("controlCenter.m020")}
          </Button>
        </div>
      </Show>
    </section>
  )
}
