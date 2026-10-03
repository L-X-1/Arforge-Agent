import "../../../src/index.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Route, Router } from "@solidjs/router"
import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { SystemOverview } from "../../../src/components/control-center/dialog-control-center"
import type { OperationsApi } from "../../../src/utils/server"

type Workspace = "workspace-a" | "workspace-b"
type Resolve = () => void

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const calls: string[] = []
const pending = new Map<Workspace, Resolve[]>()

const overviewFor = (current: Workspace) => ({
  schema_version: 1 as const,
  sections: [
    {
      id: "status" as const,
      title: "Runtime status",
      data: { workspace: current, marker: "overview-" + current },
    },
  ],
})

const enqueue = <T,>(current: Workspace, value: T) =>
  new Promise<T>((resolve) => {
    const entries = pending.get(current) ?? []
    entries.push(() => resolve(value))
    pending.set(current, entries)
  })

const delayed = async <T,>(kind: string, input: { location?: { workspace?: string } }, value: T) => {
  const current = (input.location?.workspace ?? workspace()) as Workspace
  calls.push(kind + ":" + current)
  return enqueue(current, value)
}

const resolveWorkspace = (current: Workspace) => {
  const entries = pending.get(current) ?? []
  if (entries.length === 0) throw new Error("no pending System Overview requests for " + current)
  pending.delete(current)
  for (const resolve of entries) resolve()
}

;(globalThis as typeof globalThis & {
  __systemOverviewScopeFixture: {
    calls: string[]
    resolve: (workspace: Workspace) => void
  }
}).__systemOverviewScopeFixture = { calls, resolve: resolveWorkspace }

const api = {
  health: {
    get: async () => ({ healthy: true as const }),
  },
  agents: {
    list: (input: { location?: { workspace?: string } }) =>
      delayed("agents", input, { data: [{ id: "agent-" + (input.location?.workspace ?? "unknown") }] }),
  },
  agentCapabilities: {
    health: (input: { location?: { workspace?: string } }) =>
      delayed("capability-health", input, { data: { status: "ok" } }),
    list: (input: { location?: { workspace?: string } }) =>
      delayed("capabilities", input, {
        data: {
          items: [
            {
              name: "scope-" + (input.location?.workspace ?? "unknown"),
              enabled: true,
              kind: "fixture",
              description: "scope fixture",
            },
          ],
        },
      }),
    systemOverview: (input: { location?: { workspace?: string } }) =>
      delayed("overview", input, { data: overviewFor((input.location?.workspace ?? "unknown") as Workspace) }),
  },
} as unknown as OperationsApi

const location = () => ({
  location: {
    directory: "C:/Arforge/SystemOverviewScopeFixture",
    workspace: workspace(),
  },
})

const RoutedPage = () => (
  <DialogProvider>
    <div class="flex flex-col gap-4 p-6">
      <div class="flex gap-2">
        <button data-testid="system-overview-scope-a" onClick={() => setWorkspace("workspace-a")}>
          workspace-a
        </button>
        <button data-testid="system-overview-scope-b" onClick={() => setWorkspace("workspace-b")}>
          workspace-b
        </button>
      </div>
      <SystemOverview api={() => api} location={location} ready={() => true} />
    </div>
  </DialogProvider>
)

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
        <Router>
          <Route path="*" component={RoutedPage} />
        </Router>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
