import "../../../src/index.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Route, Router } from "@solidjs/router"
import { DialogProvider } from "@arforge-ai/ui/context/dialog"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { ChildControlCard, PersonalWorkspace } from "../../../src/components/control-center/personal-workspace"
import { workspaceCopy } from "../../../src/components/control-center/personal-workspace-presentation"
import type { OperationsApi } from "../../../src/utils/server"

type Workspace = "workspace-a" | "workspace-b"
type Resolve = () => void

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const calls: string[] = []
const pending = new Map<Workspace, Resolve[]>()

const snapshotFor = (current: Workspace) => ({
  asOf: 0,
  project: { id: "project-" + current, directory: "C:/Arforge/PersonalWorkspaceScopeFixture" },
  location: {
    directory: "C:/Arforge/PersonalWorkspaceScopeFixture",
    workspaceID: current,
    projectID: "project-" + current,
    projectDirectory: "C:/Arforge/PersonalWorkspaceScopeFixture",
  },
  sessions: [
    {
      id: "ses_" + current,
      title: current + " session",
      projectID: "project-" + current,
      state: "human_visible" as const,
      createdAt: 0,
      updatedAt: 0,
      taskCount: 0,
      runCount: 0,
      personalJobCount: 0,
      attentionCount: 0,
    },
  ],
  tasks: [],
  runs: [
    {
      runID: "run_history_" + current,
      sessionID: "ses_" + current,
      status: "completed" as const,
      initiator: "agent" as const,
      authority: "automatic" as const,
      riskTier: "L0" as const,
      state: "human_visible" as const,
      recoveryRequired: false,
      budget: {
        attemptsUsed: 0,
        maxAttempts: 1,
        durationMsUsed: 0,
        maxDurationMs: 1000,
        costMicrosUsed: 0,
        maxCostMicros: 100,
      },
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  personalJobs: [],
  memoryCandidates: [],
  attention: [],
  counts: {
    sessions: 1,
    activeSessions: 0,
    tasks: 0,
    pendingTasks: 0,
    runs: 0,
    activeRuns: 0,
    recoveringRuns: 0,
    personalJobs: 0,
    pendingApprovals: 0,
    artifacts: 0,
    memoryCandidates: 0,
  },
  cost: { runUsedMicros: 0, runLimitMicros: 100, jobUsedMicros: 0, jobLimitMicros: 100 },
})

const snapshot = async (input: { location?: { workspace?: string } }) => {
  const current = (input.location?.workspace ?? workspace()) as Workspace
  calls.push(current)
  return await new Promise<ReturnType<typeof snapshotFor>>((resolve) => {
    const entries = pending.get(current) ?? []
    entries.push(() => resolve(snapshotFor(current)))
    pending.set(current, entries)
  })
}

const resolveWorkspace = (current: Workspace) => {
  const resolver = pending.get(current)?.shift()
  if (!resolver) throw new Error("no pending Personal Workspace request for " + current)
  resolver()
}

;(
  globalThis as typeof globalThis & {
    __personalWorkspaceScopeFixture: {
      calls: string[]
      resolve: (workspace: Workspace) => void
    }
  }
).__personalWorkspaceScopeFixture = { calls, resolve: resolveWorkspace }

const historyReads: string[] = []
const api = {
  personalWorkspace: { snapshot },
  subagentControl: {
    children: async (input: { parentRunID: string }) => {
      historyReads.push(input.parentRunID)
      return {
        parentRunID: input.parentRunID,
        controlAvailable: false,
        children: [
          {
            childRunID: "run_history_child",
            sessionID: "ses_history_child",
            status: "completed",
            depth: 1,
            objectiveDigest: "b".repeat(64),
            resultReceiptStatus: historyReads.length > 1 ? "present" : "missing",
          },
        ],
      }
    },
  },
} as unknown as OperationsApi
const location = () => ({ location: { directory: "C:/Arforge/PersonalWorkspaceScopeFixture", workspace: workspace() } })
function ReceiptFixture() {
  const [state, setState] = createStore<{
    receipt?: "missing" | "present"
    controlAvailable?: boolean
    waits: number
    opened: string
  }>({
    receipt: "missing",
    controlAvailable: true,
    waits: 0,
    opened: "",
  })
  const receiptApi = {
    subagentControl: {
      wait: async () => {
        setState("waits", (value) => value + 1)
        return { status: "completed", resultReceiptStatus: "present", timedOut: false }
      },
    },
  } as unknown as OperationsApi
  return (
    <section data-testid="receipt-fixture">
      <button
        data-testid="receipt-legacy"
        onClick={() => setState({ receipt: undefined, controlAvailable: undefined })}
      >
        Legacy response
      </button>
      <output data-testid="receipt-waits">{state.waits}</output>
      <output data-testid="receipt-opened">{state.opened}</output>
      <ChildControlCard
        api={() => receiptApi}
        location={location}
        child={{
          childRunID: "run_receipt_fixture",
          sessionID: "ses_receipt_fixture",
          status: "completed",
          resultReceiptStatus: state.receipt,
          depth: 1,
          objectiveDigest: "a".repeat(64),
        }}
        parentRunID="run_receipt_parent"
        controlAvailable={state.controlAvailable}
        locale="zh"
        copy={workspaceCopy("zh")}
        onOpenSession={(id) => setState("opened", id)}
        onChanged={() => setState("receipt", "present")}
      />
    </section>
  )
}
const RoutedPage = () => (
  <DialogProvider>
    <div class="flex flex-col gap-4 p-6">
      <div class="flex gap-2">
        <button data-testid="personal-scope-a" onClick={() => setWorkspace("workspace-a")}>
          workspace-a
        </button>
        <button data-testid="personal-scope-b" onClick={() => setWorkspace("workspace-b")}>
          workspace-b
        </button>
      </div>
      <PersonalWorkspace api={() => api} location={location} ready={() => true} />
      <ReceiptFixture />
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
