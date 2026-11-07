import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createComponent, getOwner } from "solid-js"
import { render } from "solid-js/web"
import type { QueryOptionsApi } from "../server-sync"
import type { State } from "./types"
import { createChildStoreManager } from "./child-store"
import { resolveAgentSelection } from "../local-agent"
import { ServerScope } from "@/utils/server-scope"

const build = {
  name: "build",
  mode: "primary",
  native: true,
  hidden: false,
  options: {},
  permission: [],
} as State["agent"][number]
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose()
})
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((done) => setTimeout(done, 0))
}

function fixture({ directory = "/owned", read = async () => [build] as State["agent"] } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  })
  const scope = ServerScope.local,
    provider = { all: new Map(), connected: [], default: {} }
  const path = { state: "", config: "", worktree: directory, directory, home: "" }
  let reads = 0
  const options = {
    path: (dir: string) => ({ queryKey: [scope, dir, "path"], queryFn: async () => path }),
    providers: (dir: string) => ({ queryKey: [scope, dir, "providers"], queryFn: async () => provider }),
    agents: (dir: string) => ({
      queryKey: [scope, dir, "agents"],
      queryFn: async () => {
        reads++
        return read()
      },
    }),
    mcp: (dir: string) => ({ queryKey: [scope, dir, "mcp"], queryFn: async () => ({}) }),
    mcpResources: (dir: string) => ({ queryKey: [scope, dir, "mcpResources"], queryFn: async () => ({}) }),
    lsp: (dir: string) => ({ queryKey: [scope, dir, "lsp"], queryFn: async () => [] }),
    references: (dir: string) => ({ queryKey: [scope, dir, "references"], queryFn: async () => [] }),
  }
  let manager!: ReturnType<typeof createChildStoreManager>
  const host = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(QueryClientProvider, {
        client,
        get children() {
          const owner = getOwner()!
          manager = createChildStoreManager({
            owner,
            scope,
            global: { provider },
            queryOptions: options as unknown as QueryOptionsApi,
            persist: (_target, store) => [store[0], store[1], null, Object.assign(() => true, { promise: undefined })],
            isBooting: () => false,
            isLoadingSessions: () => false,
            onBootstrap() {},
            onMcp() {},
            onDispose() {},
            translate: (key) => key,
          })
          return null
        },
      }),
    host,
  )
  cleanups.push(() => {
    dispose()
    client.clear()
    host.remove()
  })
  const key = [scope, directory, "agents"] as const
  return {
    client,
    manager,
    key,
    directory,
    options,
    dispose,
    get reads() {
      return reads
    },
  }
}

test("cached agents recovered after a failed bootstrap populate the current directory and its real selection", async () => {
  const f = fixture()
  const [state] = f.manager.child(f.directory)
  // Model the observed successful scoped query after bootstrap's one-shot copy
  // has already failed. A cache-only bootstrap projection must not remain empty.
  f.client.setQueryData(f.key, [build])
  await flush()
  expect(state.agent.map((x) => x.name)).toEqual(["build"])
  expect(resolveAgentSelection(state.agent, {}).current?.name).toBe("build")
})

test("a later successful empty catalog removes the selected Agent without a silent fallback", async () => {
  const f = fixture()
  const [state] = f.manager.child(f.directory)
  f.client.setQueryData(f.key, [build])
  await flush()
  expect(state.agent).toHaveLength(1)
  f.client.setQueryData(f.key, [])
  await flush()
  const selection = resolveAgentSelection(state.agent, { selected: "build" })
  expect(state.agent).toEqual([])
  expect(selection.current).toBeUndefined()
  expect(selection.unavailable).toBe("build")
})

test("a background catalog failure retains the last successful directory list", async () => {
  let failing = false
  const f = fixture({
    read: async () => {
      if (failing) throw new TypeError("Failed to fetch")
      return [build]
    },
  })
  const [state] = f.manager.child(f.directory)
  await f.client.fetchQuery(f.options.agents(f.directory))
  await flush()
  expect(state.agent.map((x) => x.name)).toEqual(["build"])
  failing = true
  await f.client.fetchQuery({ ...f.options.agents(f.directory), staleTime: 0 }).catch(() => {})
  await flush()
  expect(state.agent.map((x) => x.name)).toEqual(["build"])
})

test("a passive directory does not fetch Agents; activation deduplicates with its existing caller", async () => {
  const f = fixture()
  const [state] = f.manager.child(f.directory, { bootstrap: false })
  await flush()
  expect(f.reads).toBe(0)
  expect(state.agent).toEqual([])
  f.manager.child(f.directory)
  await f.client.fetchQuery(f.options.agents(f.directory))
  await flush()
  expect(f.reads).toBe(1)
  expect(state.agent.map((x) => x.name)).toEqual(["build"])
})

test("a recovered list cannot leak into another server cache using the same directory", async () => {
  const a = fixture({ read: async () => [] }),
    b = fixture({ read: async () => [] })
  const [left] = a.manager.child(a.directory),
    [right] = b.manager.child(b.directory)
  await Promise.all([
    a.client.fetchQuery(a.options.agents(a.directory)),
    b.client.fetchQuery(b.options.agents(b.directory)),
  ])
  a.client.setQueryData(a.key, [build])
  await flush()
  expect(left.agent.map((x) => x.name)).toEqual(["build"])
  expect(right.agent).toEqual([])
})

test("disposing a directory projection retires its Agent updates while a replacement owns the recovered cache", async () => {
  const old = fixture()
  const [retired] = old.manager.child(old.directory)
  await old.client.fetchQuery(old.options.agents(old.directory))
  await flush()
  expect(retired.agent.map((x) => x.name)).toEqual(["build"])
  old.dispose()
  expect(old.client.getQueryCache().find({ queryKey: old.key })?.getObserversCount()).toBe(0)
  expect(() => old.manager.child(old.directory)).toThrow("Directory sync owner is disposed")
  old.client.setQueryData(old.key, [{ ...build, name: "new-agent" }])
  await flush()
  expect(retired.agent.map((x) => x.name)).toEqual(["build"])
  const current = fixture({ read: async () => [{ ...build, name: "current-agent" }] })
  const [live] = current.manager.child(current.directory)
  await current.client.fetchQuery(current.options.agents(current.directory))
  await flush()
  expect(live.agent.map((x) => x.name)).toEqual(["current-agent"])
})
