import { describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { canSubmitDraftDirectory, guardDraftSubmission } from "@/pages/home-compose/home-draft-state"

mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/layout", () => ({ getProjectAvatarVariant: () => "default" }))
mock.module("@/pages/layout/helpers", () => ({ displayName: (project: { worktree: string }) => project.worktree, getProjectAvatarSource: () => undefined }))
mock.module("@arforge-ai/ui/dropdown-menu", () => ({ DropdownMenu: {} }))
mock.module("@arforge-ai/ui/icon", () => ({ Icon: () => undefined }))
mock.module("@arforge-ai/ui/v2/icon", () => ({ Icon: () => undefined }))
mock.module("@arforge-ai/ui/v2/project-avatar-v2", () => ({ ProjectAvatar: () => undefined }))
const { createPromptProjectController } = await import("./prompt-project-selector")

describe("unavailable project ownership", () => {
  test("keeps the selected unavailable directory visible but excludes it from keyboard selection", () => {
    createRoot((dispose) => {
      try {
        const missing = { worktree: "C:/missing", unavailable: "Directory unavailable: C:/missing" }
        const selected: string[] = []
        let closed = 0
        const controller = createPromptProjectController({ controls: () => ({
          available: [missing, { worktree: "C:/valid" }], directory: missing.worktree,
          select: (directory: string) => selected.push(directory), add() {},
        }), onDone: () => { closed++ } })
        expect(controller.selected()).toBe(missing)
        controller.setOpen(true)
        expect(controller.activeProject()?.worktree).toBe("C:/valid")
        controller.select(missing)
        expect(selected).toEqual([])
        expect(closed).toBe(0)
        expect(controller.open()).toBe(true)
      } finally { dispose() }
    })
  })

  test("revalidates stale pointer choices and refreshes availability when reopened", () => {
    createRoot((dispose) => {
      try {
        const [state, set] = createStore({ unavailable: undefined as string | undefined })
        let selected = 0, refreshed = 0
        const stale = { worktree: "C:/other" }
        const controls = () => ({
          available: [{ ...stale, unavailable: state.unavailable }], directory: "C:/original",
          select() { selected++ }, add() {}, refresh() { refreshed++ },
        })
        const controller = createPromptProjectController({ controls, onDone() {} })
        controller.setOpen(true)
        expect(refreshed).toBe(1)
        set("unavailable", "Directory unavailable: C:/other")
        controller.select(stale)
        expect(selected).toBe(0)
        set("unavailable", undefined)
        controller.select(stale)
        expect(selected).toBe(1)
      } finally { dispose() }
    })
  })

  test("does not label a nonempty invalid source as the first unrelated project", () => {
    createRoot((dispose) => {
      try {
        const controller = createPromptProjectController({ controls: () => ({
          available: [{ worktree: "C:/valid" }], directory: "D:/not-in-this-source", select() {}, add() {},
        }), onDone() {} })
        expect(controller.selected()).toBeUndefined()
      } finally { dispose() }
    })
  })

  test("a matching path response cannot permit a keyboard submit without a readable directory; Abort remains usable", () => {
    let sent = 0, aborted = 0
    const state = { directory: "C:/missing", pathDirectory: "C:/missing", pending: false, success: true, readable: false }
    const submit = guardDraftSubmission({ handleSubmit() { sent++ }, abort() { aborted++ } }, () => canSubmitDraftDirectory(state))
    submit.handleSubmit(new Event("submit"))
    submit.abort()
    expect(sent).toBe(0)
    expect(aborted).toBe(1)
    state.readable = true
    submit.handleSubmit(new Event("submit"))
    expect(sent).toBe(1)
  })
})
