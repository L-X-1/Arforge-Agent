import "../../../src/index.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { SkillLifecycleWorkbench } from "../../../src/components/control-center/governance-workbench"
import type { OperationsApi } from "../../../src/utils/server"

type Workspace = "workspace-a" | "workspace-b"
type Candidate = {
  schema_version: 1
  candidate_id: string
  skill_id: string
  version: string
  status: "draft"
  purpose: string
  triggers: string[]
  instructions: string
  allowed_tools: string[]
  allowed_capabilities: string[]
  input_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  test_ids: string[]
  source_experience_ids: string[]
  source_evidence_ids: string[]
  evaluation_passed: null
  traffic_percent: number
  revision: number
  digest: string
  created_at: string
  updated_at: string
}
type Source = {
  experience_id: string
  summary: string
  evidence_count: number
  created_at: string
}
type Resolve = () => void

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const calls: string[] = []
const pendingCandidates = new Map<Workspace, Resolve[]>()
const pendingSources = new Map<Workspace, Resolve[]>()
const makeCandidate = (workspace: Workspace, marker: string): Candidate => ({
  schema_version: 1,
  candidate_id: workspace + "-candidate",
  skill_id: marker,
  version: "1.0.0",
  status: "draft",
  purpose: "Scope fixture candidate",
  triggers: ["scope"],
  instructions: "Keep this fixture bounded.",
  allowed_tools: [],
  allowed_capabilities: [],
  input_schema: {},
  output_schema: {},
  test_ids: [],
  source_experience_ids: [],
  source_evidence_ids: [],
  evaluation_passed: null,
  traffic_percent: 0,
  revision: 1,
  digest: "a".repeat(64),
  created_at: "2026-09-02T00:00:00.000Z",
  updated_at: "2026-09-02T00:00:00.000Z",
})

const candidateList = async (input: { location: { workspace?: string } }) => {
  const current = (input.location.workspace ?? "workspace-a") as Workspace
  calls.push("candidate:" + current)
  return await new Promise<{ data: { items: Candidate[] } }>((resolve) => {
    const entries = pendingCandidates.get(current) ?? []
    entries.push(() => resolve({ data: { items: [makeCandidate(current, current + "-skill")] } }))
    pendingCandidates.set(current, entries)
  })
}

const sourceList = async (input: { location: { workspace?: string } }) => {
  const current = (input.location.workspace ?? "workspace-a") as Workspace
  calls.push("source:" + current)
  return await new Promise<{ data: { items: Source[] } }>((resolve) => {
    const entries = pendingSources.get(current) ?? []
    entries.push(() =>
      resolve({
        data: {
          items: [
            {
              experience_id: current + "-experience",
              summary: current + " verified experience",
              evidence_count: 1,
              created_at: "2026-09-02T00:00:00.000Z",
            },
          ],
        },
      }),
    )
    pendingSources.set(current, entries)
  })
}

const resolveWorkspace = (current: Workspace) => {
  const candidate = pendingCandidates.get(current)?.shift()
  const source = pendingSources.get(current)?.shift()
  if (!candidate || !source) throw new Error("no pending Skill lifecycle request for " + current)
  candidate()
  source()
}

;(globalThis as typeof globalThis & {
  __skillLifecycleScopeFixture: {
    calls: string[]
    resolve: (workspace: Workspace) => void
  }
}).__skillLifecycleScopeFixture = { calls, resolve: resolveWorkspace }

const api = {
  agentCapabilities: {
    skillLifecycleCandidateList: candidateList,
    experienceSourceList: sourceList,
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
            <button data-testid="skill-scope-a" onClick={() => setWorkspace("workspace-a")}>
              workspace-a
            </button>
            <button data-testid="skill-scope-b" onClick={() => setWorkspace("workspace-b")}>
              workspace-b
            </button>
          </div>
          <SkillLifecycleWorkbench
            api={() => api}
            location={() => ({ location: { directory: "C:/Arforge/SkillScopeFixture", workspace: workspace() } })}
            ready={() => true}
          />
        </div>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
