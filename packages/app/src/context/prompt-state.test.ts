import { describe, expect, test } from "bun:test"
import { createComputed, createMemo, createRoot } from "solid-js"
import {
  createPromptState,
  DEFAULT_PROMPT,
  hasPromptContent,
  hasPromptResources,
  isPromptEqual,
  type FileAttachmentPart,
  type Prompt,
} from "./prompt-state"

const resource = (clientName = "server-A", content = "@manual"): FileAttachmentPart => ({
  type: "file",
  path: "evidence://shared/manual",
  url: "evidence://shared/manual",
  filename: "manual",
  mime: "text/plain",
  content,
  start: 0,
  end: content.length,
  source: {
    type: "resource",
    clientName,
    uri: "evidence://shared/manual",
    text: { value: content, start: 0, end: content.length },
  },
})

describe("prompt resource equality", () => {
  test("resources count as content without changing canonical text or ordinary empty drafts", () => {
    const prompt: Prompt = [resource("server-B", "")]
    expect(hasPromptContent(prompt)).toBe(true)
    expect(hasPromptResources(prompt)).toBe(true)
    expect(prompt.map((part) => ("content" in part ? part.content : "")).join("")).toBe("")
    expect(hasPromptContent(DEFAULT_PROMPT)).toBe(false)
    expect(hasPromptContent([{ type: "text", content: " \n", start: 0, end: 2 }])).toBe(false)
    expect(
      hasPromptContent([
        { type: "image", id: "a", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
      ]),
    ).toBe(true)
    expect(
      hasPromptResources([
        { type: "image", id: "a", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
      ]),
    ).toBe(false)
  })

  test("same URI and display name on different servers require editor reconciliation", () => {
    expect(isPromptEqual([resource("server-A")], [resource("server-B")])).toBe(false)
    expect(isPromptEqual([resource("server-B")], [resource("server-A")])).toBe(false)
  })

  test("changed resource target, kind, MIME or mention cannot reuse an old file pill", () => {
    const original = resource()
    if (original.source?.type !== "resource") throw new Error("expected resource fixture")
    const changed: FileAttachmentPart[] = [
      { ...original, source: { ...original.source, uri: "evidence://other/manual" } },
      { ...original, source: { type: "file", path: original.path, text: original.source.text } },
      { ...original, source: undefined },
      { ...original, url: "evidence://other/manual" },
      { ...original, mime: "application/pdf" },
      { ...original, filename: "renamed manual" },
      resource("server-A", ""),
      { ...original, source: { ...original.source, text: { ...original.source.text, start: 1, end: 8 } } },
    ]
    for (const next of changed) {
      expect(isPromptEqual([original], [next])).toBe(false)
      expect(isPromptEqual([next], [original])).toBe(false)
    }
  })

  test("identical reconstructed resources stay stable without extra equality notifications", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      prompt.set([resource()])
      const same = createMemo(() => isPromptEqual(prompt.current(), [resource()]))
      let notifications = 0
      createComputed(() => {
        same()
        notifications += 1
      })
      prompt.set([resource()])
      expect(same()).toBe(true)
      expect(notifications).toBe(1)
      prompt.set([resource("server-B")])
      expect(same()).toBe(false)
      expect(notifications).toBe(2)
      expect(isPromptEqual([resource("server-B", "")], [resource("server-B", "")])).toBe(true)
      dispose()
    })
  })

  test("ordinary files, images and agents keep their existing equality behavior", () => {
    const ordinary: Prompt = [
      { type: "file", path: "src/a.ts", content: "@a", start: 0, end: 2 },
      { type: "image", id: "image_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
      { type: "agent", name: "build", content: "@build", start: 2, end: 8 },
    ]
    const image = ordinary[1]
    const agent = ordinary[2]
    if (image?.type !== "image" || agent?.type !== "agent") throw new Error("expected ordinary fixture")
    expect(
      isPromptEqual(
        ordinary,
        ordinary.map((part) => ({ ...part })),
      ),
    ).toBe(true)
    expect(isPromptEqual(ordinary, [resource(), ...ordinary.slice(1)])).toBe(false)
    expect(isPromptEqual([image], [{ ...image, id: "image_2" }])).toBe(false)
    expect(isPromptEqual([agent], [{ ...agent, name: "review" }])).toBe(false)
  })
})

describe("prompt state initialization", () => {
  test("initializes prompt text, cursor, and model together", () => {
    createRoot((dispose) => {
      const model = { providerID: "anthropic", modelID: "claude", variant: "high" }
      const prompt = createPromptState({ prompt: "hello", model })

      expect(prompt.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
      expect(prompt.cursor()).toBe(5)
      expect(prompt.model.current()).toEqual(model)
      expect(prompt.model.current()).not.toBe(model)
      dispose()
    })
  })

  test("uses the default prompt without initial values", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()

      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      expect(prompt.cursor()).toBeUndefined()
      expect(prompt.model.current()).toBeUndefined()
      dispose()
    })
  })
})

describe("draft consumption ownership", () => {
  test("takeover permanently retires an old ticket even when the new owner leaves without editing", () => {
    createRoot((dispose) => {
      const draft = createPromptState({ prompt: "unchanged" })
      draft.ownership.claim()
      const old = draft.ownership.capture()
      expect(old.current()).toBe(true)
      draft.ownership.claim()
      const next = draft.ownership.capture()
      expect(old.current()).toBe(false)
      expect(next.current()).toBe(true)
      dispose()
      expect(next.current()).toBe(false)
    })
  })

  test("text/model/context direct V2 writes invalidate tickets, including edit-and-revert, but cursor-only changes do not", () => {
    createRoot((dispose) => {
      const draft = createPromptState({ prompt: "original", model: { providerID: "provider", modelID: "A" } })
      const [, write] = draft.store
      const cursor = draft.ownership.capture()
      write("cursor", 3)
      expect(cursor.current()).toBe(true)
      draft.set([{ type: "text", content: "original", start: 0, end: 8 }], 5)
      expect(cursor.current()).toBe(true)
      const text = draft.ownership.capture()
      write("prompt", [{ type: "text", content: "new", start: 0, end: 3 }])
      write("prompt", [{ type: "text", content: "original", start: 0, end: 8 }])
      expect(text.current()).toBe(false)
      const model = draft.ownership.capture()
      write("model", { providerID: "provider", modelID: "B", variant: "low" })
      expect(model.current()).toBe(false)
      const context = draft.ownership.capture()
      write("context", "items", [{ type: "file", key: "new", path: "new.ts" }])
      expect(context.current()).toBe(false)
      dispose()
    })
  })
})
