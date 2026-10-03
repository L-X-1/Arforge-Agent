import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { shouldOpenSessionInBackground } from "../home-session-open"
import {
  applyPinnedNavigationEvent,
  filterRemovedNavigationSessions,
  loadPinnedNavigationSessions,
  pinnedNavigationEventsKey,
  pinnedNavigationRemoved,
  pinnedNavigationRevision,
  type PinnedNavigationEvents,
  type PinnedNavigationResult,
  mergePinnedNavigationSessions,
  navigationPinTargets,
  pinnedNavigationQueryKey,
  retainPinnedNavigationRecords,
  shouldOpenNavigationSessionInBackground,
  navigationMatches,
  navigationSessionKey,
  projectContainsDirectory,
  runNavigationRequest,
  workspaceSidebarWidth,
} from "./workspace-shell-state"

describe("workspace shell navigation", () => {
  test("uses the approved default only when a usable width is absent", () => {
    expect(workspaceSidebarWidth(undefined)).toBe(216)
    expect(workspaceSidebarWidth(Number.NaN)).toBe(216)
    expect(workspaceSidebarWidth(0)).toBe(216)
    expect(workspaceSidebarWidth(260)).toBe(260)
    expect(workspaceSidebarWidth(720)).toBe(720)
  })

  test("pins cannot cross servers or workspaces with identical session IDs", () => {
    const base = { server: "one", directory: "/work/one", sessionID: "same" }
    expect(navigationSessionKey(base)).not.toBe(navigationSessionKey({ ...base, server: "two" }))
    expect(navigationSessionKey(base)).not.toBe(navigationSessionKey({ ...base, directory: "/work/two" }))
    expect(navigationSessionKey(base)).toBe(navigationSessionKey({ ...base }))
  })

  test("project membership includes explicit worktrees without prefix collisions", () => {
    const project = { worktree: "/work/project", sandboxes: ["/work/branch"] }
    expect(projectContainsDirectory(project, "/work/project")).toBe(true)
    expect(projectContainsDirectory(project, "/work/branch")).toBe(true)
    expect(projectContainsDirectory(project, "/work/project-copy")).toBe(false)
    expect(projectContainsDirectory(project, "/work/project/nested")).toBe(false)
  })

  test("search supports multiword project and session names without changing identifiers", () => {
    expect(navigationMatches("  PLAN   API ", "API changes", "/work/plan")).toBe(true)
    expect(navigationMatches("plan missing", "API changes", "/work/plan")).toBe(false)
    expect(navigationMatches("", "anything")).toBe(true)
  })

  test("a delayed rename commits only to its captured source", async () => {
    const target = { server: "one", directory: "/work/one", sessionID: "same" }
    let finish!: (value: string) => void
    const committed: unknown[] = []
    const request = runNavigationRequest(target, (origin) => {
      expect(Object.isFrozen(origin)).toBe(true)
      return new Promise<string>((resolve) => { finish = resolve })
    }, (origin, result) => committed.push({ ...origin, result }))
    target.server = "two"
    target.directory = "/work/two"
    expect(committed).toEqual([])
    finish("saved")
    await request
    expect(committed).toEqual([{ server: "one", directory: "/work/one", sessionID: "same", result: "saved" }])
  })

  test("failed writes do not fabricate a success state", async () => {
    let committed = false
    await expect(runNavigationRequest(
      { server: "one", directory: "/work", sessionID: "same" },
      async () => { throw new Error("permission revoked") },
      () => { committed = true },
    )).rejects.toThrow("permission revoked")
    expect(committed).toBe(false)
  })
})

describe("pinned session supplementation", () => {
  const target = (sessionID: string, server = "one", directory = "/work") => ({ server, directory, sessionID })
  const session = (id: string, directory = "/work", archived?: number) => ({ id, directory, time: { archived } })

  test("restores existing boolean pins and rejects malformed or mismatched metadata", () => {
    const pin = target("old")
    const key = navigationSessionKey(pin)
    expect(navigationPinTargets({ [key]: true, broken: true, '["one"]': true, [navigationSessionKey(target("off"))]: false }))
      .toEqual([pin])
    expect(navigationPinTargets({ [key]: true }, { [key]: target("old", "other") })).toEqual([pin])
    expect(pinnedNavigationQueryKey("one", [pin])).not.toEqual(pinnedNavigationQueryKey("two", [target("old", "two")]))
    expect(pinnedNavigationQueryKey("one", [pin])).not.toEqual(pinnedNavigationQueryKey("one", [target("old", "one", "/other")]))
  })

  test("keeps pins beyond both recent limits without crossing server or workspace", () => {
    const recent = Array.from({ length: 64 }, (_, i) => session("recent-" + i))
    const cached = session("cached-old")
    const fetched = session("fetched-old")
    const pins = [target(cached.id), target(fetched.id), target("foreign", "two")]
    const merged = mergePinnedNavigationSessions(recent, [...recent, cached], [
      { target: target(fetched.id), session: fetched },
      { target: target("foreign", "two"), session: session("foreign") },
      { target: target("wrong", "one", "/other"), session: session("wrong", "/other") },
    ], pins, "one")
    const records = retainPinnedNavigationRecords(merged.map((session) => ({ session })), pins, "one", 64)
    expect(records.map((item) => item.session.id)).toEqual([...recent.map((item) => item.id), cached.id, fetched.id])
    expect(retainPinnedNavigationRecords(records, [], "one", 64)).toHaveLength(64)
    expect(mergePinnedNavigationSessions([], [], [{ target: target(fetched.id), session: fetched }], [target(fetched.id, "two")], "two")).toEqual([])
  })

  test("fetches exact targets once and isolates failures, archives, and identity mismatches", async () => {
    const pins = ["good", "wrong-dir", "wrong-id", "archived", "failed"].map((id) => target(id))
    const requests: unknown[] = []
    const result = await loadPinnedNavigationSessions([...pins, pins[0]], async (origin) => {
      requests.push(origin)
      expect(Object.isFrozen(origin)).toBe(true)
      if (origin.sessionID === "failed") throw new Error("offline")
      if (origin.sessionID === "wrong-dir") return session(origin.sessionID, "/elsewhere")
      if (origin.sessionID === "wrong-id") return session("different")
      return session(origin.sessionID, origin.directory, origin.sessionID === "archived" ? 0 : undefined)
    })
    expect(requests).toHaveLength(5)
    expect(result.entries.map((entry) => entry.session.id)).toEqual(["good"])
    expect(result.failures).toHaveLength(3)
    expect(pins).toHaveLength(5)
    const stale = [{ target: target("good"), session: session("good") }]
    expect(mergePinnedNavigationSessions([], [session("good", "/work", 123)], stale, [target("good")], "one")).toEqual([])
  })

  test("a delayed supplemental read retains its original identity", async () => {
    const pin = target("old")
    let finish!: (value: ReturnType<typeof session>) => void
    const pending = loadPinnedNavigationSessions([pin], () => new Promise<ReturnType<typeof session>>((resolve) => { finish = resolve }))
    pin.server = "two"
    pin.directory = "/other"
    finish(session("old"))
    const result = await pending
    expect(result.entries[0].target).toEqual(target("old"))
    expect(mergePinnedNavigationSessions([], [], result.entries, [pin], "two")).toEqual([])
  })

  test("sidebar mouse handling delegates every platform and modifier combination", () => {
    for (const mac of [false, true]) for (const button of [0, 1, 2]) for (let bits = 0; bits < 16; bits++) {
      const event = { button, metaKey: !!(bits & 1), ctrlKey: !!(bits & 2), shiftKey: !!(bits & 4), altKey: !!(bits & 8) }
      expect(shouldOpenNavigationSessionInBackground(event, mac)).toBe(shouldOpenSessionInBackground({
        button, mac, meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey,
      }))
    }
  })
})

describe("external pinned session invalidation", () => {
  const target = (server = "one", directory = "/work") => ({ server, directory, sessionID: "same" })
  const session = (directory = "/work", archived?: number) => ({ id: "same", directory, time: { archived } })
  type Result = PinnedNavigationResult<ReturnType<typeof session>>
  const seed = (client: QueryClient, pin: ReturnType<typeof target>) => {
    const key = pinnedNavigationQueryKey(pin.server, [pin])
    client.setQueryData<Result>(key, { entries: [{ target: pin, session: session(pin.directory) }], failures: [] })
    return key
  }

  test("archive invalidates only the matching server and directory without removing pins", () => {
    const client = new QueryClient()
    try {
      const pin = target()
      const key = seed(client, pin)
      const otherDirectory = seed(client, target("one", "/other"))
      const otherServer = seed(client, target("two"))
      const values = { [navigationSessionKey(pin)]: true }
      expect(applyPinnedNavigationEvent(client, "one", {
        type: "session.updated", properties: { info: session("/work", 0) },
      })).toBe(true)
      expect(client.getQueryData<Result>(key)?.entries).toEqual([])
      expect(client.getQueryState(key)?.isInvalidated).toBe(true)
      expect(client.getQueryData<Result>(otherDirectory)?.entries).toHaveLength(1)
      expect(client.getQueryState(otherDirectory)?.isInvalidated).toBe(false)
      expect(client.getQueryData<Result>(otherServer)?.entries).toHaveLength(1)
      expect(client.getQueryState(otherServer)?.isInvalidated).toBe(false)
      expect(navigationPinTargets(values)).toEqual([pin])
      expect(filterRemovedNavigationSessions([session()], "one",
        client.getQueryData<PinnedNavigationEvents>(pinnedNavigationEventsKey("one")) ?? {})).toEqual([])
      expect(applyPinnedNavigationEvent(client, "one", {
        type: "session.updated", properties: { info: session("/work", 0) },
      })).toBe(false)
      expect(pinnedNavigationRevision(client, pin)).toBe(1)
    } finally { client.clear() }
  })

  test("delete rejects a pre-event response even when the transport cannot abort", async () => {
    const client = new QueryClient()
    try {
      const pin = target()
      seed(client, pin)
      let finish!: (value: ReturnType<typeof session>) => void
      const response = new Promise<ReturnType<typeof session>>((resolve) => { finish = resolve })
      const pending = loadPinnedNavigationSessions([pin], () => response, undefined,
        (origin) => pinnedNavigationRevision(client, origin))
      applyPinnedNavigationEvent(client, "one", { type: "session.deleted", properties: { info: session() } })
      finish(session())
      expect((await pending).entries).toEqual([])
      expect(pinnedNavigationRemoved(client, pin)).toBe(true)
      expect(pinnedNavigationRemoved(client, target("two"))).toBe(false)
      expect(pinnedNavigationRemoved(client, target("one", "/other"))).toBe(false)
    } finally { client.clear() }
  })

  test("cancels a cached in-flight query without reverting to or committing stale rows", async () => {
    const client = new QueryClient()
    try {
      const pin = target()
      const key = seed(client, pin)
      let finish!: (value: ReturnType<typeof session>) => void
      const response = new Promise<ReturnType<typeof session>>((resolve) => { finish = resolve })
      const pending = client.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: ({ signal }) => loadPinnedNavigationSessions([pin], () => response, signal,
          (origin) => pinnedNavigationRevision(client, origin)),
      }).then(() => "resolved", () => "cancelled")
      applyPinnedNavigationEvent(client, "one", { type: "session.deleted", properties: { info: session() } })
      finish(session())
      expect(await pending).toBe("cancelled")
      expect(client.getQueryData<Result>(key)?.entries).toEqual([])
      expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    } finally { client.clear() }
  })

  test("unarchive restores the pin but delete requires an explicit create event", async () => {
    const client = new QueryClient()
    try {
      const pin = target()
      seed(client, pin)
      applyPinnedNavigationEvent(client, "one", {
        type: "session.updated", properties: { info: session("/work", 1) },
      })
      let finish!: (value: ReturnType<typeof session>) => void
      const response = new Promise<ReturnType<typeof session>>((resolve) => { finish = resolve })
      const stale = loadPinnedNavigationSessions([pin], () => response, undefined,
        (origin) => pinnedNavigationRevision(client, origin))
      applyPinnedNavigationEvent(client, "one", { type: "session.updated", properties: { info: session() } })
      finish(session())
      expect((await stale).entries).toEqual([])
      expect(pinnedNavigationRemoved(client, pin)).toBe(false)
      const fresh = await loadPinnedNavigationSessions([pin], async () => session(), undefined,
        (origin) => pinnedNavigationRevision(client, origin))
      expect(fresh.entries).toHaveLength(1)
      applyPinnedNavigationEvent(client, "one", { type: "session.deleted", properties: { info: session() } })
      applyPinnedNavigationEvent(client, "one", { type: "session.updated", properties: { info: session() } })
      expect(pinnedNavigationRemoved(client, pin)).toBe(true)
      applyPinnedNavigationEvent(client, "one", { type: "session.created", properties: { info: session() } })
      expect(pinnedNavigationRemoved(client, pin)).toBe(false)
    } finally { client.clear() }
  })

  test("a temporarily unloaded index and ordinary updates retain supplemental pins", () => {
    const client = new QueryClient()
    try {
      const pin = target()
      const key = seed(client, pin)
      expect(applyPinnedNavigationEvent(client, "one", {
        type: "session.updated", properties: { info: session() },
      })).toBe(false)
      const loaded = client.getQueryData<Result>(key)?.entries ?? []
      const merged = mergePinnedNavigationSessions([], [], loaded, [pin], "one")
      expect(filterRemovedNavigationSessions(merged, "one", {})).toEqual([session()])
      expect(client.getQueryState(key)?.isInvalidated).toBe(false)
      expect(navigationPinTargets({ [navigationSessionKey(pin)]: true })).toEqual([pin])
    } finally { client.clear() }
  })
})
