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
const fixtureQuery = new URLSearchParams(window.location.search)
const fixtureLocale = fixtureQuery.get("locale") === "zh" ? "zh" : "en"
const includeMovedSource = fixtureQuery.has("sourceMoved")

const [workspace, setWorkspace] = createSignal<Workspace>("workspace-a")
const calls: string[] = []
const pending = new Map<Workspace, Resolve[]>()
const directoryFor = (current: Workspace) => current === "workspace-a"
  ? "C:/Arforge/PersonalWorkspaceScopeFixture"
  : "D:/Arforge/PersonalWorkspaceHistoryFixture"
const sourceJumps: string[] = []

const snapshotFor = (current: Workspace) => ({
  asOf: 0,
  project: { id: "global", directory: "C:/" },
  location: {
    directory: directoryFor(current),
    workspaceID: current,
    projectID: "global",
    projectDirectory: "C:/",
  },
  sessions: [
    {
      id: "ses_" + current,
      title: current + " session",
      projectID: "global",
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
      source: { inspectability: "current", projectID: "global", directory: directoryFor(current) },
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
    ...["foreign", "legacy", ...(includeMovedSource ? ["moved"] : [])].map((kind) => ({
      runID: "run_" + kind + "_" + current,
      sessionID: "ses_" + (current === "workspace-a" ? "workspace-b" : "workspace-a"),
      source: kind === "legacy"
        ? { inspectability: "missing-binding" }
        : kind === "moved"
          ? { inspectability: "session-moved", projectID: "global", directory: "D:/Arforge/PreviousWorkspace" }
        : { inspectability: "requires-navigation", projectID: "global", directory: directoryFor(current === "workspace-a" ? "workspace-b" : "workspace-a") },
      status: "completed", initiator: "agent", authority: "automatic", riskTier: "L0",
      state: "settled", recoveryRequired: false,
      budget: { attemptsUsed: 0, maxAttempts: 1, durationMsUsed: 0, maxDurationMs: 1000, costMicrosUsed: 0, maxCostMicros: 100 },
      createdAt: 0, updatedAt: 0,
    })),
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
      historyReads: string[]
      sourceJumps: string[]
    }
  }
).__personalWorkspaceScopeFixture = { calls, resolve: resolveWorkspace, get historyReads() { return historyReads }, sourceJumps }

const historyReads: string[] = []
const api = {
  personalWorkspace: { snapshot },
  subagentControl: {
    children: async (input: { parentRunID: string; location: { directory: string; workspace?: string } }) => {
      historyReads.push(input.parentRunID)
      if (input.parentRunID !== "run_history_" + workspace() || input.location.directory !== directoryFor(workspace()) || input.location.workspace !== workspace())
        throw new Error("409: fixture parent source mismatch")
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
const location = () => ({ location: { directory: directoryFor(workspace()), workspace: workspace() } })
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
      <div class="arforge-control-center-body">
      <PersonalWorkspace api={() => api} location={location} ready={() => true} serverName={fixtureLocale === "zh" ? "隔离测试服务器" : "Isolated fixture server"}
        onOpenSource={async (run) => {
          sourceJumps.push(run.source.directory!)
          setWorkspace(run.source.directory === directoryFor("workspace-a") ? "workspace-a" : "workspace-b")
        }} />
      </div>
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
      <LanguageProvider locale={fixtureLocale}>
        <Router>
          <Route path="*" component={RoutedPage} />
        </Router>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
