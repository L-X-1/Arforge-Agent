import { describe, expect, test } from "bun:test"
import { createTextDocumentCloseGuard } from "./text-document-close-guard"
import { isDirty, textDraftKey, type TextDraft } from "./text-document-draft"

function fixture() {
  const drafts = new Map<string, TextDraft>()
  const flushed: string[] = []
  const prompts: string[] = []
  const alerts: string[] = []
  const deferred: (() => void)[] = []
  let accepted = true
  let failure: "read" | "write" | undefined
  const guard = createTextDocumentCloseGuard({
    restore: (key) => {
      if (failure === "read") throw new Error("private token and file details")
      return drafts.get(key)
    },
    flush: (key) => {
      if (failure === "write") throw new Error("private storage details")
      flushed.push(key)
    },
    unsavedKeys: () => [...drafts].filter(([, draft]) => isDirty(draft)).map(([key]) => key),
  }, {
    confirm: (message) => { prompts.push(message); return accepted },
    alert: (message) => { alerts.push(message) },
    defer: (callback) => { deferred.push(callback) },
  })
  const add = (scope = "local", directory = "/workspace", path = "notes.md") => {
    const key = textDraftKey(scope, directory, path)
    // The guard consumes text and identity only; document validation is owned by the repository.
    drafts.set(key, { format: 1, base: { text: "disk" }, text: "draft" } as TextDraft)
    return key
  }
  return { guard, drafts, flushed, prompts, alerts, deferred, add,
    cancel: () => { accepted = false },
    fail: (value: "read" | "write") => { failure = value },
  }
}

describe("shared text document close guard", () => {
  test("clean state proceeds without a dialog or storage writes", () => {
    const f = fixture()
    expect(f.guard.confirm(undefined, false)).toBe(true)
    expect(f.prompts).toHaveLength(0)
    expect(f.flushed).toHaveLength(0)
  })

  test("cancelling leaves every draft and caller action untouched", () => {
    const f = fixture()
    const key = f.add()
    f.cancel()
    let closed = false
    if (f.guard.confirm(undefined, false)) closed = true
    expect(closed).toBe(false)
    expect(f.drafts.get(key)?.text).toBe("draft")
    expect(f.flushed).toHaveLength(0)
  })

  test("confirmation flushes but never saves or discards the draft", () => {
    const f = fixture()
    const key = f.add()
    expect(f.guard.confirm(undefined, false, true)).toBe(true)
    expect(f.flushed).toEqual([key])
    expect(f.drafts.get(key)?.base.text).toBe("disk")
    expect(f.drafts.get(key)?.text).toBe("draft")
  })

  test("file selection isolates server, directory, and path", () => {
    const f = fixture()
    const key = f.add()
    f.add("remote")
    f.add("local", "/other")
    f.add("local", "/workspace", "other.md")
    expect(f.guard.confirm({ scope: "local", directory: "/workspace", paths: ["notes.md"] }, false)).toBe(true)
    expect(f.flushed).toEqual([key])
  })

  test("server-wide selection includes only that server", () => {
    const f = fixture()
    const a = f.add("remote", "/one")
    const b = f.add("remote", "/two")
    f.add("local")
    expect(f.guard.confirm({ scope: "remote" }, false)).toBe(true)
    expect(f.flushed).toEqual([a, b])
  })

  test("nested close and navigation ask once in the same action", () => {
    const f = fixture()
    f.add()
    expect(f.guard.confirm(undefined, false)).toBe(true)
    expect(f.guard.confirm(undefined, false, true)).toBe(true)
    expect(f.prompts).toHaveLength(1)
    for (const callback of f.deferred.splice(0)) callback()
    expect(f.guard.confirm(undefined, false)).toBe(true)
    expect(f.prompts).toHaveLength(2)
  })

  test("editing after consent invalidates the earlier approval", () => {
    const f = fixture()
    const key = f.add()
    f.guard.confirm(undefined, false)
    f.drafts.set(key, { ...f.drafts.get(key)!, text: "new draft" })
    f.cancel()
    expect(f.guard.confirm(undefined, false)).toBe(false)
    expect(f.prompts).toHaveLength(2)
  })

  test("existing side-panel confirmation can wrap the lower-level guard without a second dialog", () => {
    const f = fixture()
    f.add()
    let closed = false
    expect(f.guard.withConfirmation({ scope: "local" }, false, () => {
      if (f.guard.confirm({ scope: "local" }, false)) closed = true
    })).toBe(true)
    expect(closed).toBe(true)
    expect(f.prompts).toHaveLength(0)
  })

  for (const failure of ["read", "write"] as const) {
    test(failure + " failures block the action and expose no raw error", () => {
      const f = fixture()
      const key = f.add()
      f.fail(failure)
      expect(f.guard.confirm(undefined, false)).toBe(false)
      expect(f.alerts).toHaveLength(1)
      expect(f.alerts[0]).not.toContain("private")
      expect(f.drafts.get(key)?.text).toBe("draft")
    })
  }
})
