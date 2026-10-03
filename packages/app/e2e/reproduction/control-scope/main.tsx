import "../../../src/index.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { MemoryControl, SavedPermissionControl } from "../../../src/components/control-center/dialog-control-center"
import type { OperationsApi } from "../../../src/utils/server"

type Workspace = "workspace-a" | "workspace-b"
type Resolve = () => void

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const calls: string[] = []
const pending = new Map<Workspace, Resolve[]>()

const enqueue = <T,>(current: Workspace, value: T) =>
  new Promise<T>((resolve) => {
    const entries = pending.get(current) ?? []
    entries.push(() => resolve(value))
    pending.set(current, entries)
  })

const workspaceFromLocation = (input: { location?: { workspace?: string } }) =>
  (input.location?.workspace ?? workspace()) as Workspace

const permissionsListSaved = () => {
  const current = workspace()
  calls.push("permissions-saved:" + current)
  return enqueue(current, [
    {
      id: "rule_" + current,
      action: current + "-permission",
      resource: current + "-resource",
      scope: current,
      projectID: current + "-project",
      createdAt: 0,
    },
  ])
}

const permissionsListRequests = (input: { location: { workspace?: string } }) => {
  const current = workspaceFromLocation(input)
  calls.push("permissions-pending:" + current)
  return enqueue(current, { data: [] })
}

const memoriesList = (input: { location: { workspace?: string } }) => {
  const current = workspaceFromLocation(input)
  calls.push("memory-list:" + current)
  return enqueue(current, {
    items: [
      {
        id: "mem_" + current,
        content: current + " memory",
        type: "fact",
        scope: current,
        importance: 0.7,
        tags: [current],
        version: 1,
      },
    ],
  })
}

const memoriesFacets = (input: { location: { workspace?: string } }) => {
  const current = workspaceFromLocation(input)
  calls.push("memory-facets:" + current)
  return enqueue(current, { types: [{ value: current, count: 1 }], tags: [{ value: current, count: 1 }] })
}

const memoriesRecallQuality = (input: { location: { workspace?: string } }) => {
  const current = workspaceFromLocation(input)
  calls.push("memory-quality:" + current)
  return enqueue(current, { top1Rate: 0.9, meanReciprocalRank: 0.9, caveat: current + " quality" })
}

const resolveWorkspace = (current: Workspace) => {
  const entries = pending.get(current) ?? []
  if (entries.length === 0) throw new Error("no pending control-center request for " + current)
  pending.set(current, [])
  entries.forEach((resolve) => resolve())
}

;(globalThis as typeof globalThis & {
  __controlScopeFixture: {
    calls: string[]
    resolve: (workspace: Workspace) => void
  }
}).__controlScopeFixture = { calls, resolve: resolveWorkspace }

const api = {
  permissions: {
    listSaved: permissionsListSaved,
    listRequests: permissionsListRequests,
  },
  memories: {
    list: memoriesList,
    facets: memoriesFacets,
    recallQuality: memoriesRecallQuality,
  },
} as unknown as OperationsApi

const location = () => ({ location: { directory: "C:/Arforge/ControlScopeFixture", workspace: workspace() } })

render(
  () => (
    <PlatformProvider
      value={{
        platform: "web",
        openLink: () => undefined,
        restart: async () => undefined,
        back: () => undefined,
        forward: () => undefined,
        notify: async () => undefined,
      }}
    >
      <LanguageProvider locale="en">
        <div class="flex flex-col gap-4 p-6">
          <div class="flex gap-2">
            <button data-testid="control-scope-a" onClick={() => setWorkspace("workspace-a")}>
              workspace-a
            </button>
            <button data-testid="control-scope-b" onClick={() => setWorkspace("workspace-b")}>
              workspace-b
            </button>
          </div>
          <SavedPermissionControl api={() => api} location={location} ready={() => true} />
          <MemoryControl api={() => api} location={location} ready={() => true} />
        </div>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
