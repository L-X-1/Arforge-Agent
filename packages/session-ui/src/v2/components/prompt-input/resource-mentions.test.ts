import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { parsePromptInputV2Editor, renderPromptInputV2Editor } from "./index"
import { createPromptInputV2Controller } from "./interaction"
import type { PromptInputV2FilePart, PromptInputV2PersistedState, PromptInputV2Prompt } from "./types"

const resource = (server: string): PromptInputV2FilePart => ({
  type: "file",
  path: "manual",
  filename: "manual.txt",
  mime: "text/plain",
  url: "data:text/plain;base64,",
  content: "",
  start: 0,
  end: 0,
  source: {
    type: "resource",
    clientName: server,
    uri: "evidence://same/manual",
    text: { value: "", start: 0, end: 0 },
  },
})
const text = (content: string) => ({ type: "text" as const, content, start: 0, end: content.length })
const image = {
  type: "image" as const,
  id: "image-owned",
  filename: "image.png",
  mime: "image/png",
  dataUrl: "data:image/png;base64,AA==",
}
const disposals: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
})

function fixture(prompt: PromptInputV2Prompt, options: { disabled?: boolean; composing?: boolean } = {}) {
  const store = createStore<PromptInputV2PersistedState>({ prompt, cursor: 0, context: { items: [] } })
  let submits = 0,
    inputs = 0
  const controller = createRoot((dispose) => {
    disposals.push(dispose)
    return createPromptInputV2Controller({
      store,
      commands: () => [],
      context: () => [],
      searchContextFiles: () => [],
      view: {
        submit: {
          stopping: () => false,
          onSubmit: () => {
            submits++
          },
          onStop() {},
        },
      },
    })
  })
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  document.body.append(editor)
  controller.setEditor(editor)
  editor.addEventListener("input", () => {
    inputs++
    const parsed = parsePromptInputV2Editor(editor)
    controller.onInput(parsed.map((part) => part.content).join(""), [
      ...parsed,
      ...controller.parts().filter((part) => part.type === "image"),
    ])
  })
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) submits++
  })
  renderPromptInputV2Editor(editor, prompt, {
    removeLabel: "Remove attachment",
    disabled: options.disabled,
    isComposing: () => !!options.composing,
  })
  return { editor, controller, store, inputs: () => inputs, submits: () => submits }
}

describe("empty MCP resource mentions", () => {
  test("shows exact server/name pseudo-labels and accessible removal without changing text or WeakMap identity", () => {
    const a = resource("server-A"),
      b = resource("server-B")
    const f = fixture([a, b])
    const pills = [...f.editor.querySelectorAll<HTMLElement>('[data-mention="file"]')]
    expect(pills.map((pill) => pill.dataset.resourceLabel)).toEqual(["server-A: manual.txt", "server-B: manual.txt"])
    for (const pill of pills) {
      expect(pill.classList.contains("before:content-[attr(data-resource-label)]")).toBe(true)
      expect(pill.textContent).toBe("")
      expect(pill.getAttribute("role")).toBe("button")
      expect(pill.tabIndex).toBe(0)
      expect(pill.getAttribute("aria-label")).toContain("Remove attachment")
      expect(pill.getAttribute("aria-label")).toContain("evidence://same/manual")
    }
    expect(f.editor.textContent).toBe("")
    expect(parsePromptInputV2Editor(f.editor)).toEqual([a, b])
  })

  test("resource-only submission is valid while truly empty and whitespace drafts remain disabled", () => {
    const f = fixture([resource("server-A")])
    expect(f.controller.canSubmit()).toBe(true)
    f.store[1]("prompt", [text("")])
    expect(f.controller.canSubmit()).toBe(false)
    f.store[1]("prompt", [text(" \n\t")])
    expect(f.controller.canSubmit()).toBe(false)
    f.store[1]("prompt", [text("hello")])
    expect(f.controller.canSubmit()).toBe(true)
    f.store[1]("prompt", [image])
    expect(f.controller.canSubmit()).toBe(true)
    f.store[1]({
      prompt: [text("")],
      context: { items: [{ type: "file", key: "comment", path: "a.ts", comment: "inspect this" }] },
    })
    expect(f.controller.canSubmit()).toBe(true)
  })

  for (const key of ["click", "Enter", " ", "Backspace", "Delete"]) {
    test(`${JSON.stringify(key)} removes only its resource and retains other references, text and image bytes`, () => {
      const a = resource("server-A"),
        b = resource("server-B")
      const f = fixture([text("before "), a, text(" after"), b, image])
      const pill = f.editor.querySelector<HTMLElement>('[data-mention="file"]')!
      if (key === "click") pill.click()
      else pill.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      const parts = f.controller.parts()
      expect(parts.filter((part) => part.type === "file").map((part) => part.source)).toEqual([b.source])
      expect(
        parts
          .filter((part) => part.type === "text")
          .map((part) => part.content)
          .join(""),
      ).toBe("before  after")
      expect(parts.find((part) => part.type === "image")).toEqual(image)
      expect(f.editor.textContent).toBe("before  after")
      expect(f.inputs()).toBe(1)
      expect(f.submits()).toBe(0)
      expect(f.controller.canSubmit()).toBe(true)
    })
  }

  test("removing the final resource produces a genuinely empty disabled draft", () => {
    const f = fixture([resource("server-A")])
    f.editor.querySelector<HTMLElement>('[data-mention="file"]')!.click()
    expect(f.controller.parts()).toEqual([text("")])
    expect(f.controller.canSubmit()).toBe(false)
    expect(f.inputs()).toBe(1)
  })

  test("composition and disabled owners do not remove a resource", () => {
    for (const options of [{ composing: true }, { disabled: true }]) {
      const f = fixture([resource("server-A")], options)
      f.editor
        .querySelector<HTMLElement>('[data-mention="file"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }))
      expect(parsePromptInputV2Editor(f.editor)[0]).toEqual(resource("server-A"))
      expect(f.inputs()).toBe(0)
    }
    const f = fixture([resource("server-A")])
    for (const event of [
      new KeyboardEvent("keydown", { key: "Backspace", isComposing: true, bubbles: true }),
      new KeyboardEvent("keydown", { key: "Backspace", keyCode: 229, bubbles: true }),
    ]) {
      f.editor.querySelector<HTMLElement>('[data-mention="file"]')!.dispatchEvent(event)
    }
    expect(f.inputs()).toBe(0)
  })

  test("a detached old node cannot remove the new draft's resource", () => {
    const f = fixture([resource("server-A")])
    const old = f.editor.querySelector<HTMLElement>('[data-mention="file"]')!
    f.store[1]("prompt", [resource("server-B")])
    renderPromptInputV2Editor(f.editor, f.controller.parts(), { removeLabel: "Remove attachment" })
    old.click()
    expect(parsePromptInputV2Editor(f.editor)).toEqual([resource("server-B")])
    expect(f.inputs()).toBe(0)
  })

  test("ordinary file and agent mentions retain content and forged attributes do not acquire resource identity", () => {
    const file = { type: "file" as const, content: "@a.ts", path: "a.ts", start: 0, end: 5 }
    const agent = { type: "agent" as const, content: "@build", name: "build", start: 5, end: 11 }
    const f = fixture([file, agent])
    expect(parsePromptInputV2Editor(f.editor)).toEqual([file, agent])
    expect(f.editor.querySelector('[role="button"]')).toBeNull()
    f.editor.innerHTML =
      '<span data-mention="file" data-path="manual" data-resource-label="server-A: manual.txt"></span>'
    expect(parsePromptInputV2Editor(f.editor)[0]).not.toHaveProperty("source")
  })
})
