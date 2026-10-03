import { describe, expect, test } from "bun:test"
import { acknowledgeSave, createTextDraftRepository, isDirty, textDraftKey, type DraftStorage, type TextDraft } from "./text-document-draft"

const base = { path: "notes.md", text: "base", version: "a".repeat(64), bom: false, lineEnding: "lf" as const }
const draft: TextDraft = { format: 1, base, text: "my draft" }
const key = textDraftKey("local", "C:/project", base.path)

function storage() {
  const values = new Map<string, string>()
  const api: DraftStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
  return { values, api }
}

describe("text document drafts", () => {
  test("isolates servers, workspaces and paths without separator collisions", () => {
    const keys = [key, textDraftKey("remote", "C:/project", base.path), textDraftKey("local", "C:/other", base.path), textDraftKey("local", "C:/project", "other.md"), textDraftKey("local|C:/project", "", base.path)]
    expect(new Set(keys).size).toBe(keys.length)
    expect(key.startsWith("arforge.")).toBe(false)
  })
  test("persists a draft and restores it in a new repository", () => {
    const target = storage()
    const first = createTextDraftRepository(() => target.api)
    expect(first.restore(key)).toBeUndefined()
    first.remember(key, draft)
    first.flush(key)
    expect(createTextDraftRepository(() => target.api).restore(key)).toEqual(draft)
    expect(first.hasUnsaved()).toBe(true)
  })
  test("a completed save does not replace newer typing", () => {
    const result = acknowledgeSave({ ...draft, text: "typed during save" }, { ...base, text: "my draft", version: "b".repeat(64) })
    expect(result.text).toBe("typed during save")
    expect(result.base.text).toBe("my draft")
    expect(isDirty(result)).toBe(true)
    expect(isDirty(acknowledgeSave(draft, { ...base, text: draft.text, version: "b".repeat(64) }))).toBe(false)
  })
  test("quota failure keeps both the prior stored draft and the newest in-memory edit", () => {
    const target = storage()
    const prior = JSON.stringify(draft)
    target.values.set(key, prior)
    const api = { ...target.api, setItem: () => { throw new Error("QuotaExceededError") } }
    const repository = createTextDraftRepository(() => api)
    repository.restore(key)
    const newer = { ...draft, text: "newer text" }
    repository.remember(key, newer)
    expect(() => repository.flush(key)).toThrow("QuotaExceededError")
    expect(repository.restore(key)).toEqual(newer)
    expect(target.values.get(key)).toBe(prior)
  })
  test("does not silently overwrite another window's draft", () => {
    const target = storage()
    const first = createTextDraftRepository(() => target.api)
    const second = createTextDraftRepository(() => target.api)
    first.restore(key)
    second.restore(key)
    first.remember(key, draft)
    first.flush(key)
    second.remember(key, { ...draft, text: "other window" })
    expect(() => second.flush(key)).toThrow("Another window")
    expect(JSON.parse(target.values.get(key)!).text).toBe(draft.text)
    expect(second.restore(key)?.text).toBe("other window")
  })
  test("discard clears the draft and no stale in-memory entry is recovered", () => {
    const target = storage()
    const repository = createTextDraftRepository(() => target.api)
    repository.restore(key)
    repository.remember(key, draft)
    repository.flush(key)
    repository.remember(key, null)
    repository.flush(key)
    expect(repository.restore(key)).toBeUndefined()
    expect(repository.hasUnsaved()).toBe(false)
    expect(target.values.has(key)).toBe(false)
  })
  test("leaves malformed draft bytes intact", () => {
    const target = storage()
    target.values.set(key, "{malformed")
    const repository = createTextDraftRepository(() => target.api)
    expect(() => repository.restore(key)).toThrow()
    expect(target.values.get(key)).toBe("{malformed")
  })
})
