import { afterEach, expect, mock, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import { ClientError } from "@arforge-ai/client"
import type { ServerApi } from "@/utils/server"
import type { State, VcsCache } from "./types"
import type { ArforgeClient } from "@arforge-ai/sdk/v2/client"
import { ServerScope } from "@/utils/server-scope"

const notices: unknown[] = []
mock.module("@/utils/toast", () => ({ showToast: (notice: unknown) => notices.push(notice) }))
const { bootstrapDirectory } = await import("./bootstrap")
const clients: QueryClient[] = []
const flush = async () => {
  for (let index = 0; index < 8; index++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
  notices.splice(0)
})

function fixture(
  options: {
    vcs?: () => Promise<unknown>
    config?: () => Promise<unknown>
    permissions?: () => Promise<unknown>
    session?: () => Promise<unknown>
    beforeCurrent?: () => void
  } = {},
) {
  let alive = true
  const provider = { all: new Map(), connected: [], default: {} }
  const path = { state: "", config: "", worktree: "/owned", directory: "/owned", home: "/home" }
  const [state, setStore] = createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path,
    session: [],
    sessionTotal: 0,
    session_list_status: "loading",
    session_status: {},
    session_working: () => false,
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  const api = {
    agent: { list: async () => ({ location: {}, data: [] }) },
    provider: { list: async () => ({ location: {}, data: [] }) },
    model: { list: async () => ({ location: {}, data: [] }), default: async () => ({ location: {}, data: null }) },
    permission: { request: { list: options.permissions ?? (async () => ({ location: {}, data: [] })) } },
    session: { get: options.session },
    question: { request: { list: async () => ({ location: {}, data: [] }) } },
    project: { current: async () => ({ id: "owned-project", directory: "/owned" }) },
    path: { get: async () => path },
    reference: { list: async () => ({ location: {}, data: [] }) },
    vcs: { get: options.vcs ?? (async () => ({ location: {}, data: { branch: "owned" } })) },
  } as unknown as ServerApi
  const sdk = { config: { get: options.config ?? (async () => ({ data: {} })) } } as unknown as ArforgeClient
  const input: Parameters<typeof bootstrapDirectory>[0] & { isCurrent: () => boolean } = {
    directory: "/owned",
    scope: ServerScope.local,
    mcp: false,
    sdk,
    api,
    store: state,
    setStore,
    vcsCache: { setStore() {} } as unknown as VcsCache,
    loadSessions() {},
    translate: (key) => key,
    global: { config: {}, path, project: [{ id: "owned-project", worktree: "/owned" }] as never[], provider },
    queryClient: client,
    protocol: Promise.resolve("v2"),
    isCurrent: () => {
      options.beforeCurrent?.()
      return alive
    },
  }
  return {
    state,
    start: () => bootstrapDirectory(input),
    retire: () => {
      alive = false
    },
  }
}

test("one transient wrapped GET recovers directory bootstrap without replaying writes", async () => {
  let reads = 0
  const h = fixture({
    vcs: async () => {
      reads++
      if (reads === 1) throw new ClientError("Transport", { cause: new TypeError("Failed to fetch") })
      return { location: {}, data: { branch: "recovered" } }
    },
  })
  await h.start()
  for (let index = 0; index < 100 && h.state.status !== "complete" && notices.length === 0; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  expect(reads).toBe(2)
  expect(h.state.status).toBe("complete")
  expect(h.state.vcs?.branch).toBe("recovered")
  expect(notices).toHaveLength(0)
})

test("a retired captured source cannot publish its held config or complete bootstrap", async () => {
  const started = deferred<void>()
  const held = deferred<{ data: { theme: string } }>()
  const h = fixture({
    config: async () => {
      started.resolve()
      return held.promise
    },
  })
  await h.start()
  await started.promise
  h.retire()
  held.resolve({ data: { theme: "old-source" } })
  await flush()
  expect(h.state.config).toEqual({})
  expect(h.state.status).toBe("partial")
  expect(notices).toHaveLength(0)
})

test("a genuine forbidden GET remains partial and visible without automatic replay", async () => {
  let reads = 0
  const h = fixture({
    vcs: async () => {
      reads++
      throw { _tag: "ForbiddenError", message: "Forbidden", status: 403 }
    },
  })
  await h.start()
  for (let index = 0; index < 100 && notices.length === 0; index++)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  expect(reads).toBe(1)
  expect(h.state.status).toBe("partial")
  expect(notices).toHaveLength(1)
})

test("a newer bootstrap generation for the same scope and directory fences its predecessor", async () => {
  const started = deferred<void>()
  const held = deferred<{ data: { model: string } }>()
  const older = fixture({
    config: async () => {
      started.resolve()
      return held.promise
    },
  })
  await older.start()
  await started.promise
  const newer = fixture({ config: async () => ({ data: { model: "owned/new-generation" } }) })
  await newer.start()
  for (let index = 0; index < 100 && newer.state.status !== "complete"; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  held.resolve({ data: { model: "owned/old-generation" } })
  await flush()
  expect(older.state.config).toEqual({})
  expect(older.state.status).toBe("partial")
  expect(newer.state.config).toEqual({ model: "owned/new-generation" })
  expect(newer.state.status).toBe("complete")
})

test("warm-session publication rejects a microtask retirement after the helper returns", async () => {
  const started = deferred<void>()
  const held = deferred<unknown>()
  let armed = false
  let retargeted = 0
  const h = fixture({
    permissions: async () => ({
      location: {},
      data: [{ id: "perm-owned", sessionID: "ses-owned", action: "read", resources: [] }],
    }),
    session: async () => {
      started.resolve()
      return held.promise
    },
    beforeCurrent: () => {
      if (!armed) return
      armed = false
      queueMicrotask(() => {
        retargeted++
        h.retire()
      })
    },
  })
  await h.start()
  await started.promise
  await flush()
  armed = true
  held.resolve({
    id: "ses-owned",
    projectID: "owned-project",
    agent: "build",
    title: "Owned warm session",
    model: { id: "owned-model", providerID: "owned-provider" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory: "/owned" },
    time: { created: 1, updated: 1 },
  })
  await flush()
  expect(retargeted).toBe(1)
  expect(h.state.session).toEqual([])
  expect(h.state.permission).toEqual({})
  expect(h.state.status).toBe("partial")
  expect(notices).toHaveLength(0)
})
