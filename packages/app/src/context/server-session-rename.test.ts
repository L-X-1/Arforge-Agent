import { describe, expect, test } from "bun:test"
import type { ArforgeClient, Session } from "@arforge-ai/sdk/v2/client"
import { SessionEvent } from "@arforge-ai/schema/session-event"
import { Schema } from "effect"
import { createEffect, createMemo, createRoot } from "solid-js"
import { unwrap } from "solid-js/store"
import { createServerSession } from "./server-session"
import { createRequestLifetime } from "./request-lifetime"

const sessionID = "ses_native_rename"
const directory = "C:/isolated/rename"
const original = (): Session => ({ id: sessionID, slug: "rename", projectID: "project", directory,
  title: "Original", version: "1", time: { created: 1, updated: 9 },
})
const renamed = (title: string, seq = 1, source = directory, timestamp = 1000): typeof SessionEvent.Renamed.Encoded => {
  const event = { id: `evt_rename_${seq}`, type: "session.next.renamed" as const,
    data: { sessionID, title, timestamp }, location: { directory: source },
    durable: { aggregateID: sessionID, seq, version: 1 } }
  Schema.decodeUnknownSync(SessionEvent.Renamed)(event)
  return event
}

describe("native manual-title projection", () => {
  test("memo and effect observers receive a canonical rename without replacing the session proxy", () => {
    const observed: (string | undefined)[] = []
    const owner = createRoot((dispose) => {
      const store = createServerSession({} as ArforgeClient)
      const session = createMemo(() => store.peek(sessionID))
      const title = createMemo(() => session()?.title)
      createEffect(() => { observed.push(title()) })
      return { dispose, store, session }
    })
    try {
      expect(observed).toEqual([undefined])
      owner.store.remember(original())
      const proxy = owner.session()
      expect(observed).toEqual([undefined, "Original"])
      expect(owner.store.applyV2(renamed("Observed committed title"))).toBe(true)
      expect(owner.session()).toBe(proxy)
      expect(observed).toEqual([undefined, "Original", "Observed committed title"])
    } finally {
      owner.dispose()
    }
  })

  test("changes only title without audit timestamp, conversation, model or busy-state writes", () => {
    const store = createServerSession({} as ArforgeClient)
    store.remember(original())
    store.set("session_status", sessionID, { type: "busy" })
    store.set("todo", sessionID, [{ content: "Keep", status: "pending", priority: "high" }])
    const before = JSON.parse(JSON.stringify(unwrap(store.data)))
    const event = renamed("Manual 😀 title")
    expect(event.data).not.toHaveProperty("messageID")
    store.applyV2(event)
    expect(unwrap(store.get(sessionID))).toEqual({ ...original(), title: "Manual 😀 title" })
    expect({ ...JSON.parse(JSON.stringify(unwrap(store.data))), info: before.info }).toEqual(before)
  })

  test("late GET and later bootstrap remember retain the committed title while accepting other metadata", async () => {
    let finish!: (value: { data: Session }) => void
    const client = { session: { get: () => new Promise<{ data: Session }>(resolve => { finish = resolve }) } } as unknown as ArforgeClient
    const store = createServerSession(client)
    store.remember(original())
    const loading = store.resolve(sessionID, { force: true })
    store.applyV2(renamed("Committed title"))
    finish({ data: { ...original(), slug: "fetched-metadata" } })
    expect((await loading).title).toBe("Committed title")
    expect(store.get(sessionID)?.title).toBe("Committed title")
    expect(store.get(sessionID)?.slug).toBe("fetched-metadata")
    const indexed = store.remember({ ...original(), slug: "bootstrap" })
    expect(indexed.title).toBe("Committed title")
    expect(store.get(sessionID)?.title).toBe("Committed title")
  })

  test("uncached rename does not fabricate info and is applied once real metadata resolves", async () => {
    let reads = 0
    const store = createServerSession({ session: { get: async () => { reads++; return { data: original() } } } } as unknown as ArforgeClient)
    store.applyV2(renamed("Uncached committed"))
    expect(store.get(sessionID)).toBeUndefined()
    expect(reads).toBe(0)
    expect((await store.resolve(sessionID)).title).toBe("Uncached committed")
    expect(reads).toBe(1)
    expect(store.get(sessionID)?.time).toEqual(original().time)
  })

  test("durable order wins over audit timestamps and duplicate/older events are harmless", () => {
    const store = createServerSession({} as ArforgeClient)
    store.remember(original())
    store.applyV2(renamed("First", 10, directory, 9999))
    store.applyV2(renamed("Latest", 11, directory, 1))
    store.applyV2(renamed("First", 10, directory, 9999))
    store.applyV2(renamed("Latest", 11, directory, 1))
    expect(store.get(sessionID)?.title).toBe("Latest")
    expect(store.get(sessionID)?.time).toEqual(original().time)
  })

  test("same ID in another server or workspace cannot acquire a foreign-source title", () => {
    const first = createServerSession({} as ArforgeClient), second = createServerSession({} as ArforgeClient)
    first.remember(original()); second.remember(original())
    first.applyV2(renamed("Only first"))
    first.applyV2(renamed("Foreign", 2, "D:/another-workspace"))
    expect(first.get(sessionID)?.title).toBe("Only first")
    expect(second.get(sessionID)?.title).toBe("Original")
    expect(first.remember({ ...original(), directory: "D:/another-workspace" }).title).toBe("Original")
  })

  test("deleted metadata cannot be recreated by a pending old read or replayed rename", async () => {
    let finish!: (value: { data: Session }) => void
    const store = createServerSession({ session: { get: () => new Promise<{ data: Session }>(resolve => { finish = resolve }) } } as unknown as ArforgeClient)
    store.remember(original())
    const loading = store.resolve(sessionID, { force: true })
    store.applyV2(renamed("Before delete"))
    store.apply({ type: "session.deleted", properties: { info: original() } })
    finish({ data: original() }); await loading
    expect(store.get(sessionID)).toBeUndefined()
  })

  test("a move invalidates the old source overlay and returning cannot revive its old title", () => {
    const store = createServerSession({} as ArforgeClient)
    store.remember(original()); store.applyV2(renamed("Title in A"))
    const moved = (source: string, target: string, seq: number): typeof SessionEvent.Moved.Encoded => ({
      id: `evt_move_${seq}`, type: "session.next.moved", location: { directory: source },
      durable: { aggregateID: sessionID, seq, version: 1 },
      data: { sessionID, timestamp: seq, location: { directory: target } },
    })
    store.applyV2(moved(directory, "D:/moved", 2))
    store.remember({ ...original(), directory: "D:/moved", title: "Current title in B" })
    store.applyV2(moved("D:/moved", directory, 3))
    expect(store.get(sessionID)?.title).toBe("Current title in B")
  })

  test("an old GET cannot move a renamed session back into its prior source", async () => {
    let finish!: (value: { data: Session }) => void
    const store = createServerSession({ session: { get: () => new Promise<{ data: Session }>(resolve => { finish = resolve }) } } as unknown as ArforgeClient)
    store.remember(original())
    const pending = store.resolve(sessionID, { force: true })
    store.applyV2(renamed("Committed"))
    store.applyV2({ id: "evt_move_pending", type: "session.next.moved", location: { directory },
      durable: { aggregateID: sessionID, seq: 2, version: 1 },
      data: { sessionID, timestamp: 2, location: { directory: "D:/moved" } } })
    finish({ data: original() }); await pending
    expect(store.get(sessionID)?.directory).toBe("D:/moved")
    expect(store.get(sessionID)?.title).toBe("Committed")
  })

  test("opaque full snapshots cannot undo a canonical rename while the next canonical manual rename still wins", () => {
    const store = createServerSession({} as ArforgeClient)
    store.remember(original()); store.applyV2(renamed("Canonical manual", 10))
    store.apply({ type: "session.updated", properties: { info: { ...original(), slug: "refreshed metadata" } } })
    expect(store.get(sessionID)?.title).toBe("Canonical manual")
    expect(store.get(sessionID)?.slug).toBe("refreshed metadata")
    store.applyV2(renamed("Next manual", 11))
    expect(store.get(sessionID)?.title).toBe("Next manual")
  })

  test("an old request stays invalid after page hide/show and source disposal", async () => {
    let finish!: (value: { data: Session }) => void
    const page = new EventTarget(), lifetime = createRequestLifetime(page)
    const store = createServerSession({ session: { get: () => new Promise<{ data: Session }>(resolve => { finish = resolve }) } } as unknown as ArforgeClient, { capture: lifetime.capture })
    const pending = store.resolve(sessionID)
    page.dispatchEvent(new Event("pagehide")); page.dispatchEvent(new Event("pageshow"))
    finish({ data: original() }); await pending
    expect(store.get(sessionID)).toBeUndefined()
    const after = store.resolve(sessionID); lifetime.dispose(); finish({ data: original() }); await after
    expect(store.get(sessionID)).toBeUndefined()
  })
})
