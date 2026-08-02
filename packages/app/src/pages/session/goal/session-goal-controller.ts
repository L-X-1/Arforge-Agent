import { createQuery, skipToken } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import type { PromptInputGoalControl } from "@/components/prompt-input/contracts"
import type { OperationsApi } from "@/utils/server"
import { showToast } from "@/utils/toast"
import { useSessionGoalText } from "./session-goal-text"

type GoalPage = Awaited<ReturnType<OperationsApi["goals"]["list"]>>
export type SessionGoal = GoalPage["items"][number]
type GoalApi = OperationsApi["goals"]

export async function startSessionGoal(api: GoalApi, input: { sessionID: string; objective: string }) {
  const created = await api.create({
    sessionID: input.sessionID,
    objective: input.objective,
    queue: false,
  })
  if (created.status === "active") {
    await api.run({
      sessionID: input.sessionID,
      goalID: created.id,
      expectedRevision: created.revision,
    })
  }
  return created
}

export function createSessionGoalController(input: { sessionID: Accessor<string | undefined> }) {
  const serverSDK = useServerSDK()
  const text = useSessionGoalText()
  const [selected, setSelected] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  const query = createQuery(() => {
    const sessionID = input.sessionID()
    return {
      queryKey: [serverSDK().scope, sessionID ?? "", "session-goal-dock"] as const,
      queryFn: sessionID ? () => serverSDK().operationsApi.goals.list({ sessionID, history: "false" }) : skipToken,
      refetchInterval: sessionID ? 1_000 : false,
    }
  })

  const active = createMemo(() => query.data?.active)
  const enabled = createMemo(() => selected() || !!active())
  const canSelect = createMemo(() => !active() && !saving())

  createEffect(
    on(
      input.sessionID,
      () => {
        setSelected(false)
      },
      { defer: true },
    ),
  )

  const api = () => serverSDK().operationsApi.goals
  const fail = (error: unknown) => {
    const description = error instanceof Error ? error.message : String(error)
    showToast({
      title: text().toastFailed,
      description,
    })
  }

  const refresh = async () => {
    await query.refetch()
  }

  const mutate = async (action: () => Promise<unknown>, success?: string) => {
    if (saving()) return
    setSaving(true)
    try {
      await action()
      await refresh()
      if (success) showToast({ title: success })
    } catch (error) {
      fail(error)
      throw error
    } finally {
      setSaving(false)
    }
  }

  const submit: PromptInputGoalControl["submit"] = async ({ sessionID, objective }) => {
    if (!selected() || active()) return false
    const value = objective.trim()
    if (!value) return false

    await mutate(async () => {
      await startSessionGoal(api(), { sessionID, objective: value })
      setSelected(false)
    })
    return true
  }

  const revision = (goal: SessionGoal) => ({
    sessionID: goal.sessionID,
    goalID: goal.id,
    expectedRevision: goal.revision,
  })

  const pause = (goal: SessionGoal) => mutate(() => api().pause(revision(goal)), text().toastPaused)

  const resume = (goal: SessionGoal) =>
    mutate(async () => {
      const resumed = await api().resume(revision(goal))
      await api().run({
        sessionID: resumed.sessionID,
        goalID: resumed.id,
        expectedRevision: resumed.revision,
      })
    }, text().toastResumed)

  const run = (goal: SessionGoal) => mutate(() => api().run(revision(goal)), text().toastStarted)

  const replace = async (goal: SessionGoal, objective: string) => {
    const value = objective.trim()
    if (!value || value === goal.objective) return
    await mutate(() => api().replace({ ...revision(goal), objective: value }), text().toastUpdated)
  }

  const cancel = (goal: SessionGoal) => mutate(() => api().cancel(revision(goal)), text().toastCancelled)

  const goal: PromptInputGoalControl = {
    enabled,
    selected,
    active: () => !!active(),
    canSelect,
    label: () => text().modeLabel,
    menuTitle: () => text().menuTitle,
    menuDescription: () => text().menuDescription,
    onToggle: () => {
      if (!canSelect()) return
      setSelected((value) => !value)
    },
    submit,
  }

  return {
    query,
    goal,
    active,
    saving,
    refresh,
    pause,
    resume,
    run,
    replace,
    cancel,
  }
}

export type SessionGoalController = ReturnType<typeof createSessionGoalController>
