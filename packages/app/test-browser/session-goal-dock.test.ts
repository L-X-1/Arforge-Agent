import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionGoalDockViewState } from "@/pages/session/goal/session-goal-dock"

function setup() {
  let result!: {
    dispose: () => void
    setGoal: (goal: { id: string; objective: string }) => void
    view: ReturnType<typeof createSessionGoalDockViewState>
  }
  createRoot((dispose) => {
    const [goal, setGoal] = createSignal({ id: "gol_1", objective: "first objective" })
    result = {
      dispose,
      setGoal,
      view: createSessionGoalDockViewState(goal),
    }
  })
  return result
}

describe("SessionGoalDock view state", () => {
  test("keeps expanded editing state when polling returns a new object for the same Goal", async () => {
    const { dispose, setGoal, view } = setup()
    await Promise.resolve()

    view.setExpanded(true)
    view.setEditing(true)
    view.setObjective("draft edit")
    setGoal({ id: "gol_1", objective: "first objective" })
    await Promise.resolve()

    expect(view.expanded()).toBe(true)
    expect(view.editing()).toBe(true)
    expect(view.objective()).toBe("draft edit")
    dispose()
  })

  test("collapses and resets the editor when the active Goal ID changes", async () => {
    const { dispose, setGoal, view } = setup()
    await Promise.resolve()

    view.setExpanded(true)
    view.setEditing(true)
    view.setObjective("draft edit")
    setGoal({ id: "gol_2", objective: "second objective" })
    await Promise.resolve()

    expect(view.expanded()).toBe(false)
    expect(view.editing()).toBe(false)
    expect(view.objective()).toBe("second objective")
    dispose()
  })
})
