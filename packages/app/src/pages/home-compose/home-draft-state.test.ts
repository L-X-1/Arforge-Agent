import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import type { DraftTab, Tab } from "@/context/tabs"
import { activeDraftID, bindDraftActions, createHomeDraftOwner, sameDraftSource } from "./home-draft-state"

const serverA = "server-a" as ServerConnection.Key
const serverB = "server-b" as ServerConnection.Key
const sourceA = { server: serverA, directory: "E:/workspace" }
const sourceB = { server: serverB, directory: "E:/workspace" }
const draft = (id: string, source = sourceA): DraftTab => ({ type: "draft", home: true, draftID: id, ...source })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("home draft ownership", () => {
  test("waits for hydration, deduplicates same-source creation and restores its owner draft", async () => {
    const hydrated = deferred<void>()
    const created = deferred<DraftTab>()
    const tabs: Tab[] = []
    let calls = 0
    const ensure = createHomeDraftOwner({
      ready: () => hydrated.promise,
      list: () => tabs,
      create: async () => {
        calls++
        const next = await created.promise
        tabs.push(next)
        return next
      },
    })
    const first = ensure(sourceA)
    const second = ensure({ ...sourceA, directory: "E:\\workspace\\" })
    expect(calls).toBe(0)
    hydrated.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    created.resolve(draft("home-a"))
    expect(await first).toBe(await second)
    expect((await ensure(sourceA)).draftID).toBe("home-a")
    expect(calls).toBe(1)
  })

  test("separates identical paths on different servers and different workspaces on one server", async () => {
    const tabs: Tab[] = [{ ...draft("ordinary"), home: undefined }]
    let calls = 0
    const ensure = createHomeDraftOwner({
      ready: async () => {},
      list: () => tabs,
      create: async (source) => {
        const next = draft(`home-${++calls}`, source)
        tabs.push(next)
        return next
      },
    })
    const a = await ensure(sourceA, "ordinary")
    const b = await ensure(sourceB, a.draftID)
    const workspace = await ensure({ ...sourceA, directory: "E:/workspace/sandbox" })
    expect(new Set([a.draftID, b.draftID, workspace.draftID]).size).toBe(3)
    expect(await ensure(sourceA, b.draftID)).toBe(a)
    expect(tabs[0]).toEqual({ ...draft("ordinary"), home: undefined })
  })

  test("a failed creation can be retried without reusing a rejected pending request", async () => {
    let calls = 0
    const ensure = createHomeDraftOwner({
      ready: async () => {},
      list: () => [],
      create: async () => {
        if (++calls === 1) throw new Error("preload failed")
        return draft("recovered")
      },
    })
    await expect(ensure(sourceA)).rejects.toThrow("preload failed")
    expect((await ensure(sourceA)).draftID).toBe("recovered")
  })

  test("captures the requested source before asynchronous hydration completes", async () => {
    const gate = deferred<void>()
    const source = { ...sourceA }
    const ensure = createHomeDraftOwner({
      ready: () => gate.promise,
      list: () => [],
      create: async (value) => draft("captured", value),
    })
    const pending = ensure(source)
    source.server = serverB
    source.directory = "E:/other"
    gate.resolve()
    expect(await pending).toEqual(draft("captured", sourceA))
  })
})

describe("mounted draft action isolation", () => {
  test("a late response stays with its original draft and server when the current URL names a new draft", () => {
    const a = draft("a")
    const b = draft("b", sourceB)
    const promotions: unknown[] = []
    const bound = bindDraftActions({
      draft: a,
      active: () => false,
      tabs: {
        store: [a, b],
        updateDraft: () => {
          throw new Error("unexpected update")
        },
        promoteDraft: (id, session, expected, canNavigate) => {
          promotions.push({ id, session, expected, navigate: canNavigate?.() })
        },
      },
    })
    // The existing submit owner reads search.draftId after awaiting creation.
    expect(bound.draft("b")).toEqual(a)
    bound.promoteDraft("b", { server: serverB, sessionId: "created-on-a" })
    expect(promotions).toEqual([
      { id: "a", session: { server: serverA, sessionId: "created-on-a" }, expected: a, navigate: false },
    ])
    expect(b).toEqual(draft("b", sourceB))
  })

  test("home retargeting selects another owner draft and leaves the current draft unchanged", () => {
    const a = draft("a")
    const selected: unknown[] = []
    const writes: unknown[] = []
    const bound = bindDraftActions({
      draft: a,
      active: () => true,
      retarget: (source) => selected.push(source),
      tabs: {
        store: [a],
        updateDraft: (...args) => writes.push(args),
        promoteDraft: () => {},
      },
    })
    bound.updateDraft("a", sourceB)
    expect(selected).toEqual([sourceB])
    expect(writes).toEqual([])
    expect(a).toEqual(draft("a"))
  })

  test("ignores a stale picker callback after the source or active draft changes", () => {
    const a = draft("a")
    let active = false
    const calls: unknown[] = []
    const tabs = {
      store: [a],
      updateDraft: (...args: unknown[]) => calls.push(args),
      promoteDraft: (...args: unknown[]) => {
        calls.push(args)
      },
    }
    const bound = bindDraftActions({ draft: a, active: () => active, retarget: (source) => calls.push(source), tabs })
    bound.updateDraft("new-current-draft", sourceB)
    active = true
    a.directory = "E:/retargeted"
    bound.promoteDraft("a", { server: serverA, sessionId: "late" })
    expect(() => bound.draft("a")).toThrow("Draft source changed")
    expect(calls).toEqual([])
  })

  test("legacy new-session project changes still use the existing updateDraft owner", () => {
    const calls: unknown[] = []
    const bound = bindDraftActions({
      draft: draft("legacy"),
      active: () => true,
      tabs: {
        store: [draft("legacy")],
        updateDraft: (...args) => calls.push(args),
        promoteDraft: () => {},
      },
    })
    bound.updateDraft("legacy", sourceB)
    expect(calls).toEqual([["legacy", sourceB]])
  })
})

describe("active draft routes", () => {
  test("recognizes home and existing new-session drafts without treating history/archive as an active composer", () => {
    expect(activeDraftID("/", "?draftId=home%20draft")).toBe("home draft")
    expect(activeDraftID("/new-session", "?draftId=existing")).toBe("existing")
    expect(activeDraftID("/", "?history=1&draftId=home")).toBeUndefined()
    expect(activeDraftID("/", "?archived=1&draftId=home")).toBeUndefined()
    expect(activeDraftID("/settings", "?draftId=home")).toBeUndefined()
    expect(activeDraftID("/", "")).toBeUndefined()
    expect(sameDraftSource(sourceA, sourceB)).toBe(false)
  })
})
