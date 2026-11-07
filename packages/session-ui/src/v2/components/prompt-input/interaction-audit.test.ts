import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createPromptInputV2Controller } from "./interaction"
import type { PromptInputV2PersistedState } from "./types"

const makeDraft = (text: string) => createStore<PromptInputV2PersistedState>({
  prompt: [{ type: "text", content: text, start: 0, end: text.length }], cursor: text.length, context: { items: [] },
})

describe("V2 composer asynchronous attachment ownership", () => {
  test("a browser file chooser stays on its opener draft until its change event", async () => {
    let dispose!: () => void
    const a = makeDraft("draft A")
    const b = makeDraft("draft B")
    let active = a
    const controller = createRoot((cleanup) => {
      dispose = cleanup
      return createPromptInputV2Controller({
        store: () => active, commands: () => [], context: () => [], searchContextFiles: () => [],
        view: { submit: { stopping: () => false, onSubmit() {}, onStop() {} } },
        attachments: { directory: () => "fixture", isDialogActive: () => false, warn() {}, onError(error) { throw error } },
      })
    })
    controller.setEditor(document.createElement("div"))
    controller.setFileInput(document.createElement("input"))
    controller.attach()
    active = b
    await controller.addAttachments([new File(["isolated"], "browser.txt", { type: "text/plain" })])
    try {
      expect(a[0].prompt.filter((part) => part.type === "image").map((part) => part.filename)).toEqual(["browser.txt"])
      expect(b[0].prompt).toEqual([{ type: "text", content: "draft B", start: 0, end: 7 }])
    } finally { dispose() }
  })
  test("a delayed read completes on its captured draft after the active session changes", async () => {
    let dispose!: () => void
    const a = makeDraft("draft A")
    const b = makeDraft("draft B")
    let active = a
    const controller = createRoot((cleanup) => {
      dispose = cleanup
      return createPromptInputV2Controller({
        store: () => active, commands: () => [], context: () => [], searchContextFiles: () => [],
        view: { submit: { stopping: () => false, onSubmit() {}, onStop() {} } },
        attachments: { directory: () => "fixture", isDialogActive: () => false, warn() {}, onError(error) { throw error } },
      })
    })
    controller.setEditor(document.createElement("div"))
    const pending = controller.addAttachments([new File(["isolated"], "note.txt", { type: "text/plain" })])
    active = b
    await pending
    try {
      expect(a[0].prompt.filter((part) => part.type === "image").map((part) => part.filename)).toEqual(["note.txt"])
      expect(b[0].prompt).toEqual([{ type: "text", content: "draft B", start: 0, end: 7 }])
    } finally { dispose() }
  })

  test("a native picker callback stays on the draft where the picker opened", async () => {
    let dispose!: () => void
    const a = makeDraft("draft A")
    const b = makeDraft("draft B")
    let active = a
    let fileCallback!: (file: File) => Promise<unknown>
    const controller = createRoot((cleanup) => {
      dispose = cleanup
      return createPromptInputV2Controller({
        store: () => active, commands: () => [], context: () => [], searchContextFiles: () => [],
        view: { submit: { stopping: () => false, onSubmit() {}, onStop() {} } },
        attachments: {
          directory: () => "fixture", isDialogActive: () => false, warn() {}, onError(error) { throw error },
          picker: async (_options, onFile) => { fileCallback = onFile },
        },
      })
    })
    controller.setEditor(document.createElement("div"))
    controller.attach()
    active = b
    await fileCallback(new File(["isolated"], "picked.txt", { type: "text/plain" }))
    try {
      expect(a[0].prompt.filter((part) => part.type === "image").map((part) => part.filename)).toEqual(["picked.txt"])
      expect(b[0].prompt).toEqual([{ type: "text", content: "draft B", start: 0, end: 7 }])
    } finally { dispose() }
  })
})
