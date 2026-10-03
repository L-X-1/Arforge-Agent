import "../../../src/index.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { AgentExtensionInsights } from "../../../src/components/control-center/agent-extension-insights"
import type { OperationsApi } from "../../../src/utils/server"

type Workspace = "workspace-a" | "workspace-b"
type CustomizationData = {
  commands: { count: number; enabled_count: number; items: unknown[] }
  hooks: { count: number; enabled_count: number; items: unknown[] }
  roots: string[]
}
type Resolve = (value: { data: CustomizationData }) => void

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const calls: Workspace[] = []
const pending = new Map<Workspace, Resolve[]>()

const customizationList = async (input: { location: { workspace?: string } }) => {
  const current = (input.location.workspace ?? "workspace-a") as Workspace
  calls.push(current)
  return await new Promise<{ data: CustomizationData }>((resolve) => {
    const entries = pending.get(current) ?? []
    entries.push(resolve)
    pending.set(current, entries)
  })
}

const resolveWorkspace = (current: Workspace, marker: string) => {
  const resolver = pending.get(current)?.shift()
  if (!resolver) throw new Error("no pending customization request for " + current)
  resolver({
    data: {
      commands: {
        count: 1,
        enabled_count: 1,
        items: [
          {
            name: marker,
            description: current + " fixture command",
            template: "Review {{args}}",
            source: "fixture",
            path: ".arforge/commands/" + marker + ".md",
            category: "acceptance",
            problems: [],
          },
        ],
      },
      hooks: { count: 0, enabled_count: 0, items: [] },
      roots: [".arforge/" + current],
    },
  })
}

;(globalThis as typeof globalThis & {
  __agentExtensionScopeFixture: {
    calls: Workspace[]
    resolve: (workspace: Workspace, marker: string) => void
  }
}).__agentExtensionScopeFixture = { calls, resolve: resolveWorkspace }

const api = {
  agentCapabilities: {
    customizationList,
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
            <button data-testid="extension-scope-a" onClick={() => setWorkspace("workspace-a")}>
              workspace-a
            </button>
            <button data-testid="extension-scope-b" onClick={() => setWorkspace("workspace-b")}>
              workspace-b
            </button>
          </div>
          <AgentExtensionInsights
            api={() => api}
            location={() => ({ location: { directory: "C:/Arforge/ExtensionScopeFixture", workspace: workspace() } })}
            ready={() => true}
          />
        </div>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
