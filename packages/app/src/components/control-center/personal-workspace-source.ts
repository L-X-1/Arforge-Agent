import { PersonalWorkspace } from "@arforge-ai/schema/personal-workspace"
import { Schema } from "effect"
import type { OperationsApi } from "@/utils/server"
import type { useTabs } from "@/context/tabs"
import type { ServerConnection } from "@/context/server"

type WireSnapshot = Awaited<ReturnType<OperationsApi["personalWorkspace"]["snapshot"]>>
export type WorkspaceRun = WireSnapshot["runs"][number] & { readonly source: PersonalWorkspace.RunSource }
export type WorkspaceSnapshot = Omit<WireSnapshot, "runs"> & { readonly runs: readonly WorkspaceRun[] }

/** The generated SDK predates this additive field. Validate it at the App
 * boundary; old or malformed summaries stay visible and explicitly read-only.
 * The transport preserves response JSON; no generated client edit is needed.
 */
export function workspaceSnapshotSources(snapshot: WireSnapshot): WorkspaceSnapshot {
  return { ...snapshot, runs: snapshot.runs.map(run => {
    const source: unknown = Reflect.get(run, "source")
    return { ...run, source: Schema.is(PersonalWorkspace.RunSource)(source)
      ? source : { inspectability: "missing-binding" as const } }
  }) }
}

// Structural strings allow the browser-safe decoded SDK projection as well as
// Schema's branded values; the server remains the authority for every read.
export type WorkspaceRunSource = {
  inspectability: PersonalWorkspace.RunSource["inspectability"]
  projectID?: string
  directory?: string
}
export type WorkspaceSourceRun = {
  runID: string
  sessionID: string
  source?: WorkspaceRunSource
}

export function canReadRunSource(run: WorkspaceSourceRun, location: { projectID: string; directory: string }) {
  return run.source?.inspectability === "current" &&
    run.source.projectID === location.projectID && run.source.directory === location.directory
}

/** Keep manual origin navigation on the existing production tab owner. */
export function selectRunSourceSession(
  tabs: Pick<ReturnType<typeof useTabs>, "addSessionTab" | "select">,
  server: ServerConnection.Key,
  sessionID: string,
  beforeSelect?: () => void,
) {
  const tab = tabs.addSessionTab({ server, sessionId: sessionID })
  beforeSelect?.()
  tabs.select(tab)
}

/** Called only by an explicit user action; never reads children or changes defaults.
 * Capture server identity in the supplied bound readers and tab-router callback.
 */
export async function navigateToRunSource(run: WorkspaceSourceRun, context: {
  current: () => boolean
  getSession: (id: string) => Promise<{ id: string; projectID: string; directory: string }>
  getLocation: (directory: string) => Promise<{ projectID: string; directory: string }>
  selectSession: (id: string) => void
}) {
  const source = run.source
  if (source?.inspectability !== "requires-navigation" || !source.projectID || !source.directory || !context.current()) return false
  const expected = { sessionID: run.sessionID, projectID: source.projectID, directory: source.directory }
  const session = await context.getSession(expected.sessionID)
  if (!context.current()) return false
  if (session.id !== expected.sessionID || session.projectID !== expected.projectID || session.directory !== expected.directory)
    throw new Error("The session no longer matches the historical parent source.")
  const location = await context.getLocation(expected.directory)
  if (!context.current()) return false
  if (location.projectID !== expected.projectID || location.directory !== expected.directory)
    throw new Error("The original workspace no longer matches the historical parent source.")
  context.selectSession(expected.sessionID)
  return true
}
