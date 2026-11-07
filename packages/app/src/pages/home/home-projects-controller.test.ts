import { expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerProjects } from "@/context/server"
import type { LocalProject } from "@/context/layout"
import { ServerScope } from "@/utils/server-scope"
import type { HomeController } from "./home-controller"

const conn = { type: "http", http: { url: "https://home-projects.example.test" } } as const
const project = { id: "shared-git-id", worktree: "/repo/packages/app", expanded: true } satisfies LocalProject
const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
const rows = createServerProjects({ scope: () => ServerScope.local, store, setStore })
const source = { sync: { captureRequestLifetime: () => () => true }, projects: rows }
const home = {
  selection: {},
  server: { context: () => source },
  project: {},
} as unknown as HomeController

const showScoped = mock((_render: () => unknown) => {})
let registered: typeof conn | { type: "http"; http: { url: string; password: string } } = conn
let activeDialog: { id: string } | undefined
const serverModule = await import("@/context/server")
mock.module("@/context/server", () => ({
  ...serverModule,
  useServer: () => ({
    get list() {
      return [registered]
    },
    projects: { forServer: () => rows },
  }),
}))
mock.module("@arforge-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    get active() {
      return activeDialog
    },
    showScoped,
  }),
}))
mock.module("@/components/directory-picker", () => ({ useDirectoryPicker: () => undefined }))
mock.module("@/components/dialog-select-server", () => ({ useServerManagementController: () => ({}) }))
mock.module("@/components/settings-dialog", () => ({ useSettingsCommand: () => undefined }))
mock.module("@/components/settings-v2/dialog-server-v2", () => ({ DialogServerV2: () => undefined }))
mock.module("@/context/language", () => ({ useLanguage: () => ({}) }))
mock.module("@/context/notification", () => ({ useNotification: () => ({}) }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
mock.module("@/utils/persist", () => ({
  Persist: { global: () => ({}) },
  persisted: (_key: unknown, store: readonly unknown[]) => [...store, undefined, {}],
}))

const importStarted = Promise.withResolvers<void>()
const releaseImport = Promise.withResolvers<void>()
await Bun.plugin({
  name: "hold-home-project-edit-import",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]dialog-edit-project-v2\.tsx$/ }, async () => {
      importStarted.resolve()
      await releaseImport.promise
      return { contents: "export function DialogEditProjectV2() {}", loader: "ts" }
    })
  },
})

const { createHomeProjectsController } = await import("./home-projects-controller")

test("a cold edit click cannot open against a closed and reopened project row", async () => {
  rows.open(project.worktree)
  const oldRow = rows.list()[0]
  const { edit, dispose } = createRoot((dispose) => ({ edit: createHomeProjectsController(home).project.edit, dispose }))

  try {
    edit(conn, project)
    await importStarted.promise
    rows.close(project.worktree)
    rows.open(project.worktree)
    expect(rows.list()[0]).toEqual(oldRow)
    expect(rows.list()[0]).not.toBe(oldRow)

    releaseImport.resolve()
    await import("@/components/dialog-edit-project-v2")
    expect(showScoped).not.toHaveBeenCalled()

    edit(conn, project)
    await import("@/components/dialog-edit-project-v2")
    expect(showScoped).toHaveBeenCalledTimes(1)
  } finally {
    releaseImport.resolve()
    dispose()
  }
})

test("only the latest valid edit click opens after the import", async () => {
  releaseImport.resolve()
  showScoped.mockClear()
  rows.open(project.worktree)
  const latest = { ...project, worktree: "/repo/packages/ui" }
  rows.open(latest.worktree)
  const { edit, dispose } = createRoot((dispose) => ({ edit: createHomeProjectsController(home).project.edit, dispose }))

  const react = Object.getOwnPropertyDescriptor(globalThis, "React")
  Object.defineProperty(globalThis, "React", {
    configurable: true,
    value: { createElement: (_component: unknown, props: unknown) => props },
  })
  try {
    edit(conn, project)
    edit(conn, latest)
    await import("@/components/dialog-edit-project-v2")
    expect(showScoped).toHaveBeenCalledTimes(1)
    expect(showScoped.mock.calls[0][0]()).toEqual({ server: conn, project: latest })
  } finally {
    if (react) Object.defineProperty(globalThis, "React", react)
    else Reflect.deleteProperty(globalThis, "React")
    dispose()
  }
})

test("a later dialog keeps focus when the pending edit finishes loading", async () => {
  showScoped.mockClear()
  rows.open(project.worktree)
  const { edit, dispose } = createRoot((dispose) => ({ edit: createHomeProjectsController(home).project.edit, dispose }))
  try {
    edit(conn, project)
    activeDialog = { id: "newer-server-settings" }
    await import("@/components/dialog-edit-project-v2")
    expect(showScoped).not.toHaveBeenCalled()
  } finally {
    activeDialog = undefined
    dispose()
  }
})

test("same-address credential changes retire the pending edit", async () => {
  showScoped.mockClear()
  rows.open(project.worktree)
  const { edit, dispose } = createRoot((dispose) => ({ edit: createHomeProjectsController(home).project.edit, dispose }))
  try {
    edit(conn, project)
    registered = { ...conn, http: { ...conn.http, password: "fixture-rotated" } }
    await import("@/components/dialog-edit-project-v2")
    expect(showScoped).not.toHaveBeenCalled()
  } finally {
    registered = conn
    dispose()
  }
})
