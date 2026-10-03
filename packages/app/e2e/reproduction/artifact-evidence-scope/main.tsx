import "../../../src/index.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { ArtifactEvidenceWorkbench } from "../../../src/components/control-center/artifact-evidence-workbench"
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

const workspaceFromSession = (sessionID: string) => (sessionID.endsWith("workspace-b") ? "workspace-b" : "workspace-a") as Workspace

const makeReference = (current: Workspace) => ({
  version: 1 as const,
  artifactID: "art_" + "a".repeat(60) + (current === "workspace-a" ? "a" : "b"),
  kind: "application/json",
  digest: "b".repeat(64),
  mime: "application/json",
  sizeBytes: 512,
  owner: { scope: "session" as const, id: "ses_" + current },
  retention: { mode: "session" as const },
  retrievalHint: { kind: "managed" as const, handle: "handle_" + current },
  label: current + " artifact",
  createdAt: 0,
})

const catalog = async (input: { sessionID: string }) => {
  const current = workspaceFromSession(input.sessionID)
  calls.push("catalog:" + current)
  return enqueue(current, {
    entries: [{ reference: makeReference(current), firstSeenAt: 0, lastSeenAt: 0, lastSequence: 1, readCount: 1 }],
    headSequence: 1,
    headHash: "c".repeat(64),
    droppedAuditEntries: 0,
  })
}

const audit = async (input: { sessionID: string }) => {
  const current = workspaceFromSession(input.sessionID)
  calls.push("audit:" + current)
  return enqueue(current, [
    {
      sequence: 1,
      recordedAt: 0,
      actor: current + " actor",
      action: "registered" as const,
      artifactID: makeReference(current).artifactID,
      digest: "b".repeat(64),
      owner: { scope: "session" as const, id: "ses_" + current },
      previousHash: "genesis",
      recordHash: "c".repeat(64),
    },
  ])
}

const resolveWorkspace = (current: Workspace) => {
  const entries = pending.get(current) ?? []
  if (entries.length === 0) throw new Error("no pending Artifact Evidence request for " + current)
  pending.set(current, [])
  entries.forEach((resolve) => resolve())
}

;(globalThis as typeof globalThis & {
  __artifactEvidenceScopeFixture: {
    calls: string[]
    resolve: (workspace: Workspace) => void
  }
}).__artifactEvidenceScopeFixture = { calls, resolve: resolveWorkspace }

const api = {
  artifacts: {
    catalog,
    audit,
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
            <button data-testid="artifact-scope-a" onClick={() => setWorkspace("workspace-a")}>
              workspace-a
            </button>
            <button data-testid="artifact-scope-b" onClick={() => setWorkspace("workspace-b")}>
              workspace-b
            </button>
          </div>
          <ArtifactEvidenceWorkbench
            api={() => api}
            sessionID={"ses_" + workspace()}
            ready={() => true}
          />
        </div>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
