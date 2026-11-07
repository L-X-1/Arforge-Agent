import type { ServerCtx } from "./global"
import type { LocalProject } from "./layout"
import { normalizeProjectInfo } from "./global-sync/utils"
import { Binary } from "@arforge-ai/core/util/binary"

type MetadataSource = Pick<ServerCtx, "sdk" | "sync">
type MetadataPatch = Omit<Parameters<MetadataSource["sdk"]["api"]["project"]["update"]>[0], "projectID" | "directory">

export function captureProjectMetadata(
  source: MetadataSource,
  projects: () => readonly { worktree: string }[],
  { id, worktree }: LocalProject,
  isOwnerCurrent: () => boolean,
) {
  const row = projects().find((item) => item.worktree === worktree)
  if (!row) return undefined
  const lifetime = source.sync.captureRequestLifetime()

  return {
    sdk: source.sdk,
    sync: source.sync,
    id,
    worktree,
    // The persisted row is replaced on close/reopen, even when its path and Git ID match.
    current: () => lifetime() && isOwnerCurrent() && projects().includes(row),
  }
}

type ProjectMetadataRequest = NonNullable<ReturnType<typeof captureProjectMetadata>>

export async function resolveProjectMetadataID(request: ProjectMetadataRequest) {
  const { sdk, sync, id, worktree, current } = request
  if (!current()) return undefined
  if (id) return id

  const [child, setChild] = sync.child(worktree, { bootstrap: false })
  if (child.project) return child.project
  const project = await sdk.api.project.current({ location: { directory: worktree } })
  if (!current()) return undefined
  if (child.project) return child.project
  setChild("project", project.id)
  return project.id
}

export async function updateProjectMetadata(request: ProjectMetadataRequest, patch: MetadataPatch) {
  const { sdk, sync, id, current } = request
  if (!id || id === "global" || !current()) return undefined

  let directory = sync.data.project.find((item) => item.id === id)?.worktree
  if (!directory) {
    const projects = await sdk.api.project.list()
    if (!current()) return undefined
    directory = projects.find((item) => item.id === id)?.worktree
    if (!directory) return undefined
  }

  const result = await sdk.api.project.update({ ...patch, projectID: id, directory })
  if (!current() || result.id !== id) return undefined
  const cachedRevision = sync.data.project.find((item) => item.id === id)?.time?.updated
  if (cachedRevision !== undefined && cachedRevision > result.time.updated) return "superseded"

  const updated = normalizeProjectInfo(result)
  sync.set("project", (items) => {
    const position = Binary.search(items, id, (item) => item.id)
    const next = items.slice()
    next.splice(position.index, position.found ? 1 : 0, updated)
    return next
  })
  return "saved"
}
