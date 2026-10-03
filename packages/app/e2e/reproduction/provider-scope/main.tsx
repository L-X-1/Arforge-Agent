import "../../../src/index.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { ProviderControl } from "../../../src/components/control-center/dialog-control-center"
import type { OperationsApi } from "../../../src/utils/server"

type Workspace = "workspace-a" | "workspace-b"
type Resolve = () => void

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const calls: string[] = []
const pending = new Map<Workspace, Resolve[]>()

const integrationsList = async (input: { location: { workspace?: string } }) => {
  const current = (input.location.workspace ?? "workspace-a") as Workspace
  calls.push(current)
  return await new Promise<{ data: Array<{ id: string; name: string; methods: unknown[]; connections: unknown[] }> }>(
    (resolve) => {
      const entries = pending.get(current) ?? []
      entries.push(() =>
        resolve({
          data: [
            {
              id: current + "-provider",
              name: current + " provider",
              methods: [{ type: "key" }],
              connections: [{ type: "env", name: current + "_API_KEY" }],
            },
          ],
        }),
      )
      pending.set(current, entries)
    },
  )
}

const resolveWorkspace = (current: Workspace) => {
  const resolver = pending.get(current)?.shift()
  if (!resolver) throw new Error("no pending Provider request for " + current)
  resolver()
}

;(globalThis as typeof globalThis & {
  __providerScopeFixture: {
    calls: string[]
    resolve: (workspace: Workspace) => void
  }
}).__providerScopeFixture = { calls, resolve: resolveWorkspace }

const api = {
  integrations: {
    list: integrationsList,
  },
} as unknown as OperationsApi

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
            <button data-testid="provider-scope-a" onClick={() => setWorkspace("workspace-a")}>
              workspace-a
            </button>
            <button data-testid="provider-scope-b" onClick={() => setWorkspace("workspace-b")}>
              workspace-b
            </button>
          </div>
          <ProviderControl
            api={() => api}
            location={() => ({ location: { directory: "C:/Arforge/ProviderScopeFixture", workspace: workspace() } })}
            ready={() => true}
            onNavigate={() => undefined}
          />
        </div>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
