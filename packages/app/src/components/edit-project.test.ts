import { expect, mock, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { Project } from "@arforge-ai/sdk/v2/client"
import { createComponent, createRoot } from "solid-js"
import { createStore } from "solid-js/store"

const conn = { type: "http", http: { url: "https://projects.example.test" } } as const
const project = { id: "repo-id", worktree: "/repo/packages/app", expanded: true, name: "Original" }
const metadata: Project = {
  ...project,
  worktree: "/repo",
  sandboxes: [],
  time: { created: 1, updated: 1 },
}
const rows = [{ worktree: project.worktree }]
let dialogID: string | undefined
let source: ReturnType<typeof fixture>["source"]
const ownerSDK = Object.assign(() => source.sdk, { isAlive: () => true })
const closed: string[] = []

await mock.module("@arforge-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    get active() {
      return dialogID ? { id: dialogID } : undefined
    },
    close() {
      if (dialogID) closed.push(dialogID)
      dialogID = undefined
    },
  }),
}))
await mock.module("@/context/global", () => ({
  useGlobal: () => ({ ensureServerCtx: () => source, servers: { list: () => [conn] } }),
}))
await mock.module("@/context/server", () => ({
  ServerConnection: { key: (connection: typeof conn) => connection.http.url },
  useServer: () => ({ projects: { forServer: () => ({ list: () => rows }) } }),
}))
await mock.module("@/context/server-sdk", () => ({ useServerSDK: () => ownerSDK }))

const { createEditProjectModel } = await import("./edit-project")

function fixture() {
  const [data, set] = createStore({ project: [metadata] })
  const patches: unknown[] = []
  const icons: [string, string | undefined][] = []
  const firstRequest = Promise.withResolvers<void>()
  const firstResult = Promise.withResolvers<Project>()
  return {
    source: {
      sdk: {
        api: {
          project: {
            update(input: { name: string; icon: Project["icon"] }) {
              patches.push(input)
              if (patches.length === 1) {
                firstRequest.resolve()
                return firstResult.promise
              }
              return Promise.resolve({
                ...metadata,
                name: input.name,
                icon: input.icon,
                time: { created: 1, updated: 3 },
              })
            },
          },
        },
      },
      sync: {
        data,
        set,
        captureRequestLifetime: () => () => true,
        project: { icon: (directory: string, icon: string | undefined) => icons.push([directory, icon]) },
      },
    },
    data,
    set,
    firstRequest,
    firstResult,
    patches,
    icons,
  }
}

function mountModel(queryClient: QueryClient) {
  let model!: ReturnType<typeof createEditProjectModel>
  const dispose = createRoot((dispose) => {
    createComponent(QueryClientProvider, {
      client: queryClient,
      get children() {
        model = createEditProjectModel({ project, server: conn })
        return null
      },
    })
    return dispose
  })
  return { model, dispose }
}

function nextMutationSuccess(queryClient: QueryClient) {
  return new Promise<void>((resolve) => {
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return
      unsubscribe()
      resolve()
    })
  })
}

test("a delayed save leaves a replacement dialog and its local icon cache alone", async () => {
  closed.length = 0
  const f = fixture()
  source = f.source
  const queryClient = new QueryClient()
  dialogID = "first"
  const first = mountModel(queryClient)
  first.model.setStore("name", "Retired")
  first.model.setStore("iconOverride", "old icon")
  const firstSettled = nextMutationSuccess(queryClient)
  first.model.submit(new SubmitEvent("submit", { cancelable: true }))
  await f.firstRequest.promise

  dialogID = "reopened"
  const reopened = mountModel(queryClient)
  try {
    reopened.model.setStore("name", "Fresh draft")
    reopened.model.setStore("iconOverride", "fresh icon")
    f.firstResult.resolve({ ...metadata, name: "Retired", time: { created: 1, updated: 2 } })
    await firstSettled
    expect(f.data.project[0]?.name).toBe("Original")
    expect(reopened.model.store.name).toBe("Fresh draft")
    expect(dialogID).toBe("reopened")
    expect(f.icons).toEqual([])
    expect(closed).toEqual([])

    const reopenedSettled = nextMutationSuccess(queryClient)
    reopened.model.submit(new SubmitEvent("submit", { cancelable: true }))
    await reopenedSettled
    expect(f.patches).toEqual([
      {
        projectID: project.id,
        directory: "/repo",
        name: "Retired",
        icon: { color: "", override: "old icon" },
        commands: { start: "" },
      },
      {
        projectID: project.id,
        directory: "/repo",
        name: "Fresh draft",
        icon: { color: "", override: "fresh icon" },
        commands: { start: "" },
      },
    ])
    expect(f.data.project[0]?.name).toBe("Fresh draft")
    expect(f.icons).toEqual([[project.worktree, "fresh icon"]])
    expect(closed).toEqual(["reopened"])
  } finally {
    reopened.dispose()
    first.dispose()
    queryClient.clear()
  }
})

test("a superseded edit closes the current dialog without applying its submitted icon", async () => {
  closed.length = 0
  const f = fixture()
  source = f.source
  const queryClient = new QueryClient()
  dialogID = "current"
  const dialog = mountModel(queryClient)
  try {
    dialog.model.setStore("iconOverride", "older icon")
    const settled = nextMutationSuccess(queryClient)
    dialog.model.submit(new SubmitEvent("submit", { cancelable: true }))
    await f.firstRequest.promise
    f.set("project", [
      { ...metadata, name: "newer", icon: { override: "newer icon" }, time: { created: 1, updated: 3 } },
    ])
    f.firstResult.resolve({ ...metadata, icon: { override: "older icon" }, time: { created: 1, updated: 2 } })
    await settled

    expect(f.data.project[0]).toMatchObject({ name: "newer", icon: { override: "newer icon" } })
    expect(f.icons).toEqual([])
    expect(closed).toEqual(["current"])
  } finally {
    dialog.dispose()
    queryClient.clear()
  }
})
