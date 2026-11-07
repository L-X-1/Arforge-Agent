import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState } from "@/context/prompt-state"
import { createPromptSubmissionState } from "./submission-state"

test("a delayed submission cannot clear newer text, model or context from its captured draft", () => {
  createRoot((dispose) => {
    const draft = createPromptState({ prompt: "A1 submitted", model: { providerID: "owned", modelID: "old" } })
    draft.context.add({ type: "file", path: "a1.ts", comment: "submitted context" })
    const submitted = createPromptSubmissionState({
      target: draft,
      prompt: draft.current(),
      context: draft.context.items().slice(),
    })
    draft.set([{ type: "text", content: "A2 new text", start: 0, end: 11 }], 4)
    draft.model.set({ providerID: "owned", modelID: "new", variant: "low" })
    draft.context.add({ type: "file", path: "a2.ts", comment: "new context" })
    submitted.clear()
    expect(draft.current()[0]).toMatchObject({ content: "A2 new text" })
    expect(draft.model.current()).toEqual({ providerID: "owned", modelID: "new", variant: "low" })
    expect(draft.context.items().map((item) => item.path)).toEqual(["a1.ts", "a2.ts"])
    dispose()
  })
})

test("retargeting a created Session never resets an edited original draft", () => {
  createRoot((dispose) => {
    const draft = createPromptState({ prompt: "sent" })
    const submitted = createPromptSubmissionState({ target: draft, prompt: draft.current(), context: [] })
    const session = createPromptState()
    submitted.retarget(session)
    draft.set([{ type: "text", content: "new draft", start: 0, end: 9 }], 5)
    submitted.clear()
    expect(draft.current()[0]).toMatchObject({ content: "new draft" })
    expect(draft.cursor()).toBe(5)
    dispose()
  })
})

test("restoration and comment mutations cannot overwrite edits made after the submitted input was cleared", () => {
  createRoot((dispose) => {
    const draft = createPromptState({ prompt: "sent" })
    draft.context.add({ type: "file", path: "old.ts", comment: "sent comment" })
    const submitted = createPromptSubmissionState({
      target: draft,
      prompt: draft.current(),
      context: draft.context.items().slice(),
    })
    expect(submitted.clear()).toBe(true)
    draft.set([{ type: "text", content: "new", start: 0, end: 3 }])
    expect(submitted.restore()).toBeUndefined()
    expect(submitted.update(() => draft.context.remove(draft.context.items()[0].key))).toBe(false)
    expect(draft.context.items()).toHaveLength(1)
    expect(submitted.prompt[0]).toMatchObject({ content: "sent" })
    dispose()
  })
})

test("a created Session already edited by the user is not reset or given stale context", () => {
  createRoot((dispose) => {
    const draft = createPromptState({ prompt: "original request" })
    draft.context.add({ type: "file", path: "original.ts" })
    const submitted = createPromptSubmissionState({
      target: draft,
      prompt: draft.current(),
      context: draft.context.items().slice(),
    })
    const session = createPromptState({ prompt: "next user input" })
    session.context.add({ type: "file", path: "new.ts" })
    submitted.retarget(session, { consumeInitial: false })
    expect(submitted.clear()).toBe(false)
    expect(session.current()[0]).toMatchObject({ content: "next user input" })
    expect(session.context.items().map((item) => item.path)).toEqual(["new.ts"])
    dispose()
  })
})
