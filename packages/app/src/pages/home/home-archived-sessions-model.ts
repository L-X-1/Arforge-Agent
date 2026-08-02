import type { GlobalSession } from "@arforge-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"

export type HomeArchivedSessionRecord = {
  session: GlobalSession
  projectName: string
}

function directoryName(directory: string) {
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.split("/").at(-1) || directory
}

export function buildHomeArchivedSessionRecords(sessions: GlobalSession[]) {
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .filter((session) => !session.parentID && typeof session.time.archived === "number")
    .sort(
      (a, b) =>
        (b.time.archived ?? b.time.updated ?? b.time.created) - (a.time.archived ?? a.time.updated ?? a.time.created),
    )
    .map((session) => ({
      session,
      projectName: session.project?.name || directoryName(session.project?.worktree || session.directory),
    }))
}

export function filterHomeArchivedSessionRecords(records: HomeArchivedSessionRecord[], query: string) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return records
  return records.filter((record) =>
    [record.session.title, record.projectName, pathKey(record.session.directory), record.session.id].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    ),
  )
}
