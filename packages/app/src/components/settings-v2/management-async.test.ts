import { describe, expect, test } from "bun:test"
import {
  afterManagementWrite,
  bindManagementApi,
  createManagementScope,
  createManagementReadRecovery,
  ManagementRefreshFailure,
  loadManagementPartition,
  managementWriteBlocked,
  runManagementMutation,
  type ManagementPartition,
} from "./management-async"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fakeSDK(scope: string) {
  const calls: Array<{ method: string; sessionID: string; revision?: number }> = []
  return {
    url: "http://localhost:4096",
    scope,
    calls,
    goals: {
      async list(input: { sessionID: string }) {
        calls.push({ method: "goals.list", ...input })
        return [scope]
      },
      async replace(input: { sessionID: string; expectedRevision: number }) {
        calls.push({ method: "goals.replace", sessionID: input.sessionID, revision: input.expectedRevision })
        return { id: "goal-1", revision: input.expectedRevision + 1 }
      },
    },
    personalJobs: {
      async list(input: { sessionID: string }) {
        calls.push({ method: "jobs.list", ...input })
        return [scope]
      },
      async create(input: { sessionID: string; idempotencyKey: string }) {
        calls.push({ method: "jobs.create", sessionID: input.sessionID })
        return { id: "job-1", idempotencyKey: input.idempotencyKey }
      },
      async dispatch(input: { sessionID: string }) {
        calls.push({ method: "jobs.dispatch", ...input })
        return { attempted: 0 }
      },
    },
  }
}

function fixture() {
  const first = fakeSDK("sidecar")
  const second = fakeSDK("http")
  let source = first
  let sessionID = "session-a"
  const scope = createManagementScope(first, sessionID, () => ({ source, sessionID }))
  return {
    first, second, scope, api: bindManagementApi(first, scope),
    switchSDK: (next = second) => { source = next },
    switchSession: () => { sessionID = "session-b" },
  }
}

const fresh = (): ManagementPartition => ({ loading: false, fresh: true, error: "" })

describe("management request ownership", () => {
  test("same URL with a different scope/SDK instance invalidates the old owner", async () => {
    const f = fixture()
    f.switchSDK()
    const result = await runManagementMutation(f.scope, () => f.api.personalJobs.dispatch({ sessionID: "session-a" }))
    expect(result.status).toBe("stale")
    expect(f.first.calls).toEqual([])
    expect(f.second.calls).toEqual([])
  })

  test("replacement SDK at the same URL and scope is also a new owner", () => {
    const f = fixture()
    f.switchSDK(fakeSDK("sidecar"))
    expect(f.scope.live()).toBe(false)
  })

  test("the same SDK with a different session invalidates pending work", async () => {
    const f = fixture()
    const result = deferred<string[]>()
    let committed = false
    const pending = loadManagementPartition(f.scope, "goals", () => result.promise, {
      start() {}, commit() { committed = true }, fail() {}, finish() {},
    })
    f.switchSession()
    result.resolve(["old goal"])
    expect(await pending).toBe(false)
    expect(committed).toBe(false)
  })

  test("late goal write cannot refresh through either the old or replacement SDK", async () => {
    const f = fixture()
    const write = deferred<{ id: string; revision: number }>()
    f.first.goals.replace = async (input) => {
      f.first.calls.push({ method: "goals.replace", sessionID: input.sessionID, revision: input.expectedRevision })
      return write.promise
    }
    const operation = runManagementMutation(f.scope,
      () => f.api.goals.replace({ sessionID: "session-a", expectedRevision: 17 }),
      () => f.api.goals.list({ sessionID: "session-a" }))
    f.switchSDK()
    write.resolve({ id: "goal-1", revision: 18 })
    expect((await operation).status).toBe("stale")
    expect(f.first.calls).toEqual([{ method: "goals.replace", sessionID: "session-a", revision: 17 }])
    expect(f.second.calls).toEqual([])
  })

  test.each(["dispose", "server", "session"] as const)("startup jobs refresh never dispatches after %s", async (change) => {
    const f = fixture()
    const read = deferred<string[]>()
    const pending = loadManagementPartition(f.scope, "jobs", () => read.promise, {
      start() {}, commit() {}, fail() {}, finish() {},
    }).then((loaded) => loaded && f.scope.live()
      ? f.api.personalJobs.dispatch({ sessionID: "session-a" }) : undefined)
    if (change === "dispose") f.scope.dispose()
    if (change === "server") f.switchSDK()
    if (change === "session") f.switchSession()
    read.resolve(["due"])
    await pending
    expect(f.first.calls).toEqual([])
    expect(f.second.calls).toEqual([])
  })

  test("disposed multi-write notification chains stop before the next API call", async () => {
    const f = fixture()
    const first = deferred<void>()
    let calls = 0
    const api = bindManagementApi({ async notificationRead() { calls++; await first.promise } }, f.scope)
    const operation = runManagementMutation(f.scope, async () => {
      await api.notificationRead()
      await api.notificationRead()
    })
    f.scope.dispose()
    first.resolve()
    expect((await operation).status).toBe("stale")
    expect(calls).toBe(1)
  })

  test("a missing reactive source fails closed without throwing into cleanup", () => {
    const scope = createManagementScope({}, "", () => { throw new Error("server removed") })
    expect(scope.live()).toBe(false)
  })
})

describe("partition freshness and partial failure", () => {
  test("overlapping lists commit only the latest generation and its loading state", async () => {
    const f = fixture()
    const first = deferred<string[]>(), second = deferred<string[]>()
    let items: string[] = [], loading = false, errors = 0
    const events = {
      start() { loading = true },
      commit(value: string[]) { items = value },
      fail() { errors++ },
      finish() { loading = false },
    }
    const old = loadManagementPartition(f.scope, "goals", () => first.promise, events)
    const next = loadManagementPartition(f.scope, "goals", () => second.promise, events)
    first.reject(new Error("late old failure"))
    await old
    expect(loading).toBe(true)
    expect(errors).toBe(0)
    second.resolve(["current"])
    await next
    expect(items).toEqual(["current"])
    expect(loading).toBe(false)
  })

  test.each(["team 403", "trigger timeout", "inbox unavailable"])("%s preserves independent successful panels", async (failure) => {
    const f = fixture()
    const rows = { goals: [] as string[], team: ["cached"] }
    const sections = { goals: fresh(), team: fresh() }
    const load = (key: keyof typeof rows, read: () => Promise<string[]>) =>
      loadManagementPartition(f.scope, key, read, {
        start() { sections[key] = { loading: true, fresh: false, error: "" } },
        commit(value) { rows[key] = value; sections[key].fresh = true },
        fail(error) { sections[key].error = (error as Error).message },
        finish() { sections[key].loading = false },
      })
    await Promise.allSettled([
      load("goals", () => f.api.goals.list({ sessionID: "session-a" })),
      load("team", async () => { throw new Error(failure) }),
    ])
    expect(rows.goals).toEqual(["sidecar"])
    expect(rows.team).toEqual(["cached"])
    expect(sections.team).toEqual({ loading: false, fresh: false, error: failure })
    expect(managementWriteBlocked({ live: true, saving: false, identity: fresh(), activity: fresh(), section: sections.goals })).toBe(false)
    expect(managementWriteBlocked({ live: true, saving: false, identity: fresh(), activity: fresh(), section: sections.team })).toBe(true)
  })

  test.each(["identity", "activity", "section"] as const)("unknown or failed %s disables writes", (key) => {
    const input = { live: true, saving: false, identity: fresh(), activity: fresh(), section: fresh() }
    input[key].fresh = false
    expect(managementWriteBlocked(input)).toBe(true)
  })

  test("the disabled predicate and handler gate stay busy during refresh without clearing a draft", async () => {
    const f = fixture(), read = deferred<string[]>()
    const part = fresh()
    const input = { live: true, saving: false, identity: fresh(), activity: fresh(), section: part }
    const draft = "keep my pending edit"
    const disabled = () => managementWriteBlocked(input)
    const clickOrKeyboard = () => {
      if (disabled()) return
      return f.api.goals.replace({ sessionID: "session-a", expectedRevision: 4 })
    }
    const pending = loadManagementPartition(f.scope, "goals", () => read.promise, {
      start() { part.loading = true; part.fresh = false },
      commit() { part.fresh = true },
      fail() {},
      finish() { part.loading = false },
    })
    expect(disabled()).toBe(true)
    await clickOrKeyboard()
    await clickOrKeyboard()
    expect(f.first.calls).toEqual([])
    expect(draft).toBe("keep my pending edit")
    read.resolve([])
    await pending
    expect(disabled()).toBe(false)
    await clickOrKeyboard()
    expect(f.first.calls).toHaveLength(1)
  })
})

describe("confirmed write and refresh are separate outcomes", () => {
  test("goal replacement succeeds once; a failed list only offers a read retry", async () => {
    const f = fixture()
    let listCalls = 0
    const refresh = async () => { if (++listCalls === 1) throw new Error("list denied") }
    const result = await runManagementMutation(f.scope,
      () => f.api.goals.replace({ sessionID: "session-a", expectedRevision: 8 }), refresh)
    expect(result.status).toBe("confirmed-refresh-failed")
    await refresh()
    expect(f.first.calls).toHaveLength(1)
    expect(f.first.calls[0]?.revision).toBe(8)
    expect(listCalls).toBe(2)
  })

  test("job admission retains its identity and key when the following list fails", async () => {
    const f = fixture()
    let receipt: { id: string; idempotencyKey: string } | undefined
    let reads = 0
    const refresh = async () => { if (++reads === 1) throw new Error("temporarily offline") }
    const result = await runManagementMutation(f.scope, async () => {
      receipt = await f.api.personalJobs.create({ sessionID: "session-a", idempotencyKey: "stable-key" })
      await afterManagementWrite(refresh)
    })
    expect(result.status).toBe("confirmed-refresh-failed")
    expect(receipt).toEqual({ id: "job-1", idempotencyKey: "stable-key" })
    await refresh()
    expect(f.first.calls.filter((call) => call.method === "jobs.create")).toHaveLength(1)
  })

  test("a rejected write is never labelled confirmed and never triggers refresh", async () => {
    const f = fixture()
    let refreshed = false
    const result = await runManagementMutation(f.scope,
      async () => { throw new Error("revision conflict") },
      async () => { refreshed = true })
    expect(result.status).toBe("failed")
    expect(refreshed).toBe(false)
  })
})

describe("acknowledged rewind read recovery", () => {
  test.each(["sync", "list"] as const)("a failed %s keeps checkpoints stale and retries reads without repeating rewind", async (failure) => {
    const f = fixture()
    const recovery = createManagementReadRecovery(f.scope)
    const checkpointState = fresh()
    const writes: Array<{ sessionID: string; checkpointID: string; expectedLastSequence: number }> = []
    let syncReads = 0, listReads = 0
    const api = bindManagementApi({
      async rewindApply(input: { sessionID: string; checkpointID: string; expectedLastSequence: number }) {
        writes.push(input)
      },
      async sync() {
        syncReads++
        if (failure === "sync" && syncReads === 1) throw new Error("sync unavailable")
      },
      async checkpointList() {
        listReads++
        if (failure === "list" && listReads === 1) throw new Error("checkpoint list unavailable")
        return ["checkpoint-1"]
      },
    }, f.scope)
    let items: string[] = []
    const refresh = () => loadManagementPartition(f.scope, "checkpoints",
      () => recovery.refresh(() => api.checkpointList()), {
        start() { checkpointState.loading = true; checkpointState.fresh = false; checkpointState.error = "" },
        commit(value) { items = value; checkpointState.fresh = true },
        fail(error) { checkpointState.error = (error as Error).message },
        finish() { checkpointState.loading = false },
      })
    const receipt = await runManagementMutation(f.scope, async () => {
      await api.rewindApply({ sessionID: "session-a", checkpointID: "checkpoint-1", expectedLastSequence: 71 })
      recovery.require(() => api.sync())
      if (!await refresh()) throw new ManagementRefreshFailure(new Error(checkpointState.error))
    })
    expect(receipt.status).toBe("confirmed-refresh-failed")
    expect(checkpointState.fresh).toBe(false)
    expect(checkpointState.error).toContain("unavailable")
    expect(managementWriteBlocked({
      live: true, saving: false, identity: fresh(), activity: fresh(), section: checkpointState,
    })).toBe(true)

    expect(await refresh()).toBe(true)
    expect(checkpointState).toEqual({ loading: false, fresh: true, error: "" })
    expect(items).toEqual(["checkpoint-1"])
    expect(writes).toEqual([{ sessionID: "session-a", checkpointID: "checkpoint-1", expectedLastSequence: 71 }])
    expect(syncReads).toBe(2)
    expect(listReads).toBe(failure === "sync" ? 1 : 2)
    // Once recovered, ordinary list refreshes need not repeat conversation sync.
    expect(await refresh()).toBe(true)
    expect(syncReads).toBe(2)
    expect(writes).toHaveLength(1)
    expect(receipt.status).toBe("confirmed-refresh-failed")
  })

  test.each(["dispose", "server"] as const)("pending recovery cannot continue after %s", async (change) => {
    const f = fixture()
    const recovery = createManagementReadRecovery(f.scope)
    const sync = deferred<void>()
    let reads = 0
    recovery.require(() => sync.promise)
    const pending = runManagementMutation(f.scope, () => recovery.refresh(async () => { reads++; return [] }))
    if (change === "dispose") f.scope.dispose()
    else f.switchSDK()
    sync.resolve()
    expect((await pending).status).toBe("stale")
    expect(reads).toBe(0)
    expect(f.first.calls).toEqual([])
    expect(f.second.calls).toEqual([])
  })
})
