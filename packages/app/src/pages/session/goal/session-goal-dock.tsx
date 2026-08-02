import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { Icon } from "@arforge-ai/ui/icon"
import { Show, createComputed, createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import type { SessionGoal, SessionGoalController } from "./session-goal-controller"
import { useSessionGoalText } from "./session-goal-text"

const ACTIVE = new Set<SessionGoal["status"]>(["active", "running", "paused", "blocked"])

type GoalDockIdentity = Pick<SessionGoal, "id" | "objective">

export function createSessionGoalDockViewState(goal: Accessor<GoalDockIdentity | undefined>) {
  const [expanded, setExpanded] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [objective, setObjective] = createSignal("")
  const goalID = createMemo(() => goal()?.id)

  createComputed(
    on(goalID, (id) => {
      setExpanded(false)
      setEditing(false)
      if (!id) return
      setObjective(goal()?.objective ?? "")
    }),
  )

  return {
    expanded,
    setExpanded,
    editing,
    setEditing,
    objective,
    setObjective,
  }
}

export function SessionGoalDock(props: { controller: SessionGoalController }) {
  const language = useLanguage()
  const text = useSessionGoalText()
  const [now, setNow] = createSignal(Date.now())
  const goal = () => props.controller.active()
  const { expanded, setExpanded, editing, setEditing, objective, setObjective } =
    createSessionGoalDockViewState(goal)
  let timer: number | undefined

  createEffect(() => {
    const current = goal()
    if (!current || !ACTIVE.has(current.status)) {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      return
    }
    if (timer !== undefined) return
    setNow(Date.now())
    timer = window.setInterval(() => setNow(Date.now()), 1_000)
  })

  onCleanup(() => {
    if (timer !== undefined) window.clearInterval(timer)
  })

  const elapsed = () => {
    const current = goal()
    if (!current) return ""
    const value = current.time.started ?? current.time.created
    const raw: unknown = value
    const started = typeof raw === "number" ? raw : new Date(String(raw)).getTime()
    if (!Number.isFinite(started)) return ""
    const total = Math.max(0, Math.floor((now() - started) / 1_000))
    const hours = Math.floor(total / 3_600)
    const minutes = Math.floor((total % 3_600) / 60)
    const seconds = total % 60
    return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${seconds}s`].filter(Boolean).join(" ")
  }

  const status = () => {
    const current = goal()
    if (!current) return ""
    return text().status[current.status]
  }

  const save = async () => {
    const current = goal()
    if (!current) return
    try {
      await props.controller.replace(current, objective())
      setEditing(false)
    } catch {
      // The controller already reports the localized error. Keep the editor
      // open so the user can correct the objective and retry.
    }
  }

  const cancel = async () => {
    const current = goal()
    if (!current) return
    if (!window.confirm(text().cancelConfirm.replace("{{objective}}", current.objective))) return
    try {
      await props.controller.cancel(current)
    } catch {
      // The controller owns user-facing error reporting.
    }
  }

  const settle = (action: Promise<unknown>) => {
    void action.catch(() => undefined)
  }

  return (
    <Show when={goal()} keyed>
      {(current) => (
        <section
          data-component="session-goal-dock"
          class="relative z-[1] -mb-px overflow-hidden rounded-[12px] border border-border-weak-base bg-background-base shadow-sm"
          aria-label={text().activeAria}
        >
          <div class="flex min-h-11 items-center gap-2 px-3">
            <Icon name="task" class="shrink-0 text-icon-warning-base" />
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left text-13-regular text-text-base"
              onClick={() => setExpanded((value) => !value)}
            >
              <span class="font-medium text-text-strong">{text().activeLabel}</span>
              <span class="ml-1 text-text-weak">{current.objective}</span>
            </button>
            <span class="shrink-0 text-11-regular text-text-weak">{status()}</span>
            <span class="hidden shrink-0 text-11-regular text-text-weak sm:inline">{elapsed()}</span>
            <ButtonV2
              variant="ghost-muted"
              size="small"
              aria-label={text().edit}
              disabled={props.controller.saving()}
              onClick={() => {
                setObjective(current.objective)
                setEditing(true)
                setExpanded(true)
              }}
            >
              <Icon name="edit-small-2" />
            </ButtonV2>
            <Show when={current.status === "running"}>
              <ButtonV2
                variant="ghost-muted"
                size="small"
                aria-label={text().pause}
                disabled={props.controller.saving()}
                onClick={() => settle(props.controller.pause(current))}
              >
                <span aria-hidden="true">Ⅱ</span>
              </ButtonV2>
            </Show>
            <Show when={current.status === "paused" || current.status === "blocked"}>
              <ButtonV2
                variant="ghost-muted"
                size="small"
                aria-label={text().resume}
                disabled={props.controller.saving()}
                onClick={() => settle(props.controller.resume(current))}
              >
                <span aria-hidden="true">▶</span>
              </ButtonV2>
            </Show>
            <Show when={current.status === "active"}>
              <ButtonV2
                variant="ghost-muted"
                size="small"
                aria-label={text().run}
                disabled={props.controller.saving()}
                onClick={() => settle(props.controller.run(current))}
              >
                <span aria-hidden="true">▶</span>
              </ButtonV2>
            </Show>
            <ButtonV2
              variant="ghost-muted"
              size="small"
              aria-label={text().cancel}
              disabled={props.controller.saving()}
              onClick={() => void cancel()}
            >
              <Icon name="trash" />
            </ButtonV2>
            <ButtonV2
              variant="ghost-muted"
              size="small"
              aria-label={expanded() ? text().collapse : text().expand}
              onClick={() => setExpanded((value) => !value)}
            >
              <Icon name={expanded() ? "chevron-down" : "chevron-right"} />
            </ButtonV2>
          </div>
          <Show when={expanded()}>
            <div class="border-t border-border-weak-base px-3 py-3">
              <Show
                when={editing()}
                fallback={
                  <div class="whitespace-pre-wrap text-13-regular leading-6 text-text-base">{current.objective}</div>
                }
              >
                <textarea
                  class="min-h-24 w-full resize-y rounded-md border border-border-weak-base bg-background-stronger px-3 py-2 text-13-regular text-text-strong outline-none focus:border-border-focus"
                  value={objective()}
                  aria-label={text().editLabel}
                  onInput={(event) => setObjective(event.currentTarget.value)}
                />
                <div class="mt-2 flex justify-end gap-2">
                  <ButtonV2 variant="ghost-muted" size="small" onClick={() => setEditing(false)}>
                    {language.t("common.cancel")}
                  </ButtonV2>
                  <ButtonV2
                    variant="contrast"
                    size="small"
                    disabled={!objective().trim() || props.controller.saving()}
                    onClick={() => void save()}
                  >
                    {language.t("common.save")}
                  </ButtonV2>
                </div>
              </Show>
              <Show when={current.lastError}>
                <p class="mt-2 rounded-md bg-background-danger px-3 py-2 text-12-regular text-text-danger">
                  {current.lastError}
                </p>
              </Show>
            </div>
          </Show>
        </section>
      )}
    </Show>
  )
}
