import "../../../src/index.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { ExperienceCandidateWorkbench } from "../../../src/components/control-center/governance-workbench"
import type { OperationsApi } from "../../../src/utils/server"

type Workspace = "workspace-a" | "workspace-b"
type Candidate = {
  schema_version: 1
  candidate_id: string
  problem_signature: string
  applicable_scope: string
  conditions: string[]
  attempted_strategy: string
  counterexamples: string[]
  support_count: number
  source_run_ids: string[]
  source_support_ids: string[]
  evidence_ids: string[]
  evaluation_digest: string | null
  review_actor: string | null
  review_reason: string | null
  review_status: "pending"
  status: "candidate"
  policy_version: string
  expiry_at: number | null
  digest: string
  revision: number
  created_by: string
  created_at: string
  updated_at: string
}
type Resolve = () => void

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const calls: string[] = []
const pending = new Map<Workspace, Resolve[]>()

const makeCandidate = (current: Workspace): Candidate => ({
  schema_version: 1,
  candidate_id: "exc_" + current + "_candidate",
  problem_signature: current + "-experience-candidate",
  applicable_scope: current,
  conditions: ["scope fixture is active"],
  attempted_strategy: "Keep the verified experience scoped to its workspace.",
  counterexamples: ["A response from a different workspace must be ignored."],
  support_count: 1,
  source_run_ids: ["run_" + current],
  source_support_ids: ["exs_" + current],
  evidence_ids: ["evd_" + current],
  evaluation_digest: null,
  review_actor: null,
  review_reason: null,
  review_status: "pending",
  status: "candidate",
  policy_version: "experience-policy-v1",
  expiry_at: null,
  digest: "a".repeat(64),
  revision: 1,
  created_by: "fixture-user",
  created_at: "2026-09-02T00:00:00.000Z",
  updated_at: "2026-09-02T00:00:00.000Z",
})

const candidateList = async (input: { location: { workspace?: string } }) => {
  const current = (input.location.workspace ?? "workspace-a") as Workspace
  calls.push(current)
  return await new Promise<{ data: { schema_version: 1; count: number; items: Candidate[] } }>((resolve) => {
    const entries = pending.get(current) ?? []
    entries.push(() => resolve({ data: { schema_version: 1, count: 1, items: [makeCandidate(current)] } }))
    pending.set(current, entries)
  })
}

const resolveWorkspace = (current: Workspace) => {
  const resolver = pending.get(current)?.shift()
  if (!resolver) throw new Error("no pending Experience candidate request for " + current)
  resolver()
}

;(globalThis as typeof globalThis & {
  __experienceCandidateScopeFixture: {
    calls: string[]
    resolve: (workspace: Workspace) => void
  }
}).__experienceCandidateScopeFixture = { calls, resolve: resolveWorkspace }

const api = {
  agentCapabilities: {
    experienceCandidateList: candidateList,
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
            <button data-testid="experience-scope-a" onClick={() => setWorkspace("workspace-a")}>
              workspace-a
            </button>
            <button data-testid="experience-scope-b" onClick={() => setWorkspace("workspace-b")}>
              workspace-b
            </button>
          </div>
          <ExperienceCandidateWorkbench
            api={() => api}
            location={() => ({
              location: { directory: "C:/Arforge/ExperienceCandidateScopeFixture", workspace: workspace() },
            })}
            ready={() => true}
          />
        </div>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
