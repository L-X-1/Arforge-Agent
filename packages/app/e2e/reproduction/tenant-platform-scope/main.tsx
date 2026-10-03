import "../../../src/index.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Route, Router } from "@solidjs/router"
import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { TenantPlatformWorkbench } from "../../../src/components/control-center/governance-workbench"
import type { OperationsApi } from "../../../src/utils/server"

type Workspace = "workspace-a" | "workspace-b"
type FixtureRole = "member" | "owner" | "admin"
type Resolve = () => void

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const query = new URLSearchParams(window.location.search)
const fixtureRole: FixtureRole =
  query.get("role") === "owner" || query.get("role") === "admin" ? (query.get("role") as FixtureRole) : "member"
const fixtureMode = query.get("mode") ?? "scope"
const fixtureLocale = query.get("locale") === "zht" ? "zht" : query.get("locale") === "zh" ? "zh" : "en"
const calls: string[] = []
const pending = new Map<Workspace, Resolve[]>()

const tenantFor = (current: Workspace) => {
  const suffix = current === "workspace-a" ? "a" : "b"
  return {
    schema_version: 1 as const,
    policy: {
      schema_version: 1 as const,
      tenant_id: "ten_fixture_" + suffix,
      region: "region-" + suffix,
      retention_days: 30,
      quota: { currency: "USD", limit_minor: 1000 },
      rate_limit: { requests_per_minute: 60, burst: 10 },
      key_version: 1,
      revision: 1,
      updated_at: "2026-09-02T00:00:00.000Z",
    },
    usage: {
      tenant_id: "ten_fixture_" + suffix,
      currency: "USD",
      settled_amount_minor: 0,
      settled_records: 0,
      source: "settled-runtime-usage" as const,
    },
    active_rate_window_count: 0,
    pending_requests: 0,
  }
}

const secretsFor = (current: Workspace) => [
  {
    tenant_id: tenantFor(current).policy.tenant_id,
    secret_id: "secret-" + current,
    key_version: 1,
    fingerprint: "a".repeat(64),
    status: "active" as const,
    created_at: "2026-09-02T00:00:00.000Z",
  },
]

const ownerContextFor = (current: Workspace) => ({
  profile: { scope: "profile" as const, id: "profile-" + current },
  tenant: { scope: "tenant" as const, id: tenantFor(current).policy.tenant_id },
  tenantReadable: fixtureRole !== "member",
})

const enqueue = <T,>(current: Workspace, value: T) =>
  new Promise<T>((resolve) => {
    const entries = pending.get(current) ?? []
    entries.push(() => resolve(value))
    pending.set(current, entries)
  })

const delayed = async <T,>(kind: string, value: T) => {
  const current = workspace() as Workspace
  calls.push(kind + ":" + current)
  return enqueue(current, value)
}

const resolveWorkspace = (current: Workspace) => {
  const entries = pending.get(current) ?? []
  if (entries.length === 0) throw new Error("no pending Tenant Platform requests for " + current)
  pending.delete(current)
  for (const resolve of entries) resolve()
}

;(globalThis as typeof globalThis & {
  __tenantPlatformScopeFixture: {
    calls: string[]
    resolve: (workspace: Workspace) => void
  }
}).__tenantPlatformScopeFixture = { calls, resolve: resolveWorkspace }

const api = {
  tenantPlatform: {
    overview: () => delayed("overview", tenantFor(workspace())),
    listSecrets: () => delayed("secrets", secretsFor(workspace())),
    setPolicy: async () => {
      if (fixtureMode === "member-error" && fixtureRole === "member")
        throw new Error(
          JSON.stringify({
            kind: "tenant-platform-authorization",
            message: "tenant role member cannot perform admin operation",
          }),
        )
      return tenantFor(workspace()).policy
    },
    requestData: async () => ({}) as never,
    approveData: async () => ({}) as never,
    createBackup: async () => ({}) as never,
    verifyBackup: async () => ({}) as never,
    exportAudit: async () => ({}) as never,
    revokeSecret: async () => ({}) as never,
  },
  artifacts: {
    ownerContext: () => delayed("owner-context", ownerContextFor(workspace())),
    catalogScoped: async () => ({ entries: [], headSequence: 0, headHash: "", droppedAuditEntries: 0 }),
    auditScoped: async () => [],
    maintenanceContext: async () => ({
      owner: { scope: "profile" as const, id: "profile-" + workspace() },
      maintenanceScope: "profile" as const,
      canMaintain: false,
      scan: null,
      reason: "fixture",
    }),
  },
} as unknown as OperationsApi

const RoutedPage = () => (
  <DialogProvider>
    <div class="flex flex-col gap-4 p-6">
      <div class="flex gap-2">
        <button data-testid="tenant-platform-scope-a" onClick={() => setWorkspace("workspace-a")}>
          workspace-a
        </button>
        <button data-testid="tenant-platform-scope-b" onClick={() => setWorkspace("workspace-b")}>
          workspace-b
        </button>
      </div>
      <TenantPlatformWorkbench
        api={() => api}
        scopeKey={() => workspace()}
        ready={() => true}
      />
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
      <LanguageProvider locale={fixtureLocale}>
        <Router>
          <Route path="*" component={RoutedPage} />
        </Router>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
