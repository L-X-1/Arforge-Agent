import "../../../src/index.css"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { MemoryControl, ProviderControl } from "../../../src/components/control-center/dialog-control-center"
import { TenantPlatformWorkbench } from "../../../src/components/control-center/governance-workbench"
import type { OperationsApi } from "../../../src/utils/server"

const [state, setState] = createStore({ directory: "C:/Isolated/Management/A", ready: true, mounted: true })
type Call = { name: string; input: unknown }
const calls: Call[] = []
const failures = new Set<string>()
const holds = new Map<string, Array<() => void>>()
const holding = new Set<string>()
const records = Array.from({ length: 43 }, (_, i) => ({
  id: `mem_${i + 1}`, version: 7, type: "fact", scope: "project", importance: 0.7,
  content: `Memory ${i + 1}: ` + "Full authentic fixture text with multiple lines.\n".repeat(10),
  source: "fixture", tags: ["isolated"], strength: 1, reviewLevel: 0,
  time: { created: 1700000000000, updated: 1700000000000 },
}))
const call = async <T,>(name: string, input: unknown, produce: () => T): Promise<T> => {
  calls.push({ name, input: structuredClone(input) })
  if (holding.has(name)) await new Promise<void>(resolve => { holds.set(name, [...(holds.get(name) ?? []), resolve]) })
  if (failures.delete(name)) throw new Error("409 Fixture version conflict")
  return produce()
}
const api = {
  memories: {
    list: (input: { query?: string }) => call("memory.list", input, () => ({ items: structuredClone(input.query ? records.filter(item => item.content.includes(input.query!)) : records), total: records.length })),
    facets: (input: unknown) => call("memory.facets", input, () => ({ types: [{ value: "fact", count: records.length }], tags: [] })),
    recallQuality: (input: unknown) => call("memory.quality", input, () => ({ top1Rate: 0.8, meanReciprocalRank: 0.85, caveat: "Isolated data" })),
    semantic: (input: unknown) => call("memory.semantic", input, () => ({ items: [{ memory: records[0] }] })),
    update: (input: { memoryID: string; content: string }) => call("memory.update", input, () => {
      const item = records.find(item => item.id === input.memoryID)!
      item.content = input.content; item.version++; return item
    }),
    maintenanceDelete: (input: { memoryID: string }) => call("memory.delete", input, () => { records.splice(records.findIndex(item => item.id === input.memoryID), 1); return true }),
    maintenanceDeleteMany: (input: { items: Array<{ memoryID: string }> }) => call("memory.deleteMany", input, () => { for (const item of input.items) records.splice(records.findIndex(row => row.id === item.memoryID), 1); return true }),
  },
  integrations: { list: (input: unknown) => call("integration.list", input, () => ({ data: [{ id: "int_fixture", name: "Fixture integration", methods: [{ type: "key" }], connections: [{ type: "credential", id: "cred_fixture", label: "Fixture credential" }, { type: "env", name: "FIXTURE_KEY" }] }] })) },
  credentials: { update: (input: unknown) => call("credential.update", input, () => true), remove: (input: unknown) => call("credential.remove", input, () => true) },
  tenantPlatform: {
    overview: () => call("tenant.overview", {}, () => { throw new Error("500 Fixture tenant backend unavailable") }),
    listSecrets: () => call("tenant.secrets", {}, () => { throw new Error("500 Fixture tenant secret backend unavailable") }),
  },
  artifacts: { ownerContext: () => call("tenant.owner", {}, () => undefined) },
} as unknown as OperationsApi
const fixture = {
  snapshot: () => ({ calls, pending: Object.fromEntries([...holds].map(([name, list]) => [name, list.length])), directory: state.directory }),
  fail: (name: string) => failures.add(name),
  hold: (name: string) => holding.add(name),
  release: (name: string) => { holding.delete(name); for (const resolve of holds.get(name) ?? []) resolve(); holds.delete(name) },
  switchScope: () => setState("directory", "C:/Isolated/Management/B"),
  setReady: (ready: boolean) => setState("ready", ready),
}
Object.assign(window, { __managementAudit: fixture })
const forbidden = () => { throw new Error("Native action forbidden in isolated regression") }
if (new URLSearchParams(location.search).has("session")) void import("./session-main")
else if (new URLSearchParams(location.search).has("general")) void import("./general-main")
else if (new URLSearchParams(location.search).has("approval")) void import("./approval-main")
else if (new URLSearchParams(location.search).has("navigation")) void import("./navigation-main")
else render(() => <PlatformProvider value={{ platform: "web", openLink: forbidden, restart: async () => forbidden(), back: forbidden, forward: forbidden, notify: async () => forbidden() }}>
  <LanguageProvider locale="en"><DialogProvider>
    <main class="settings-v2-surface" style={{ padding: "16px" }}>
      <div class="settings-v2-panel">
        <MemoryControl api={() => api} ready={() => state.ready} location={() => ({ location: { directory: state.directory } })} />
        <ProviderControl api={() => api} ready={() => state.ready} location={() => ({ location: { directory: state.directory } })} onNavigate={() => undefined} />
        <TenantPlatformWorkbench api={() => api} scopeKey={() => state.directory} ready={() => state.ready} />
      </div>
    </main>
  </DialogProvider></LanguageProvider>
</PlatformProvider>, document.getElementById("root")!)

export type ManagementAuditFixture = typeof fixture
declare global { interface Window { __managementAudit: ManagementAuditFixture } }
