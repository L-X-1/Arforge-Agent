import { pathKey } from "@/utils/path-key"

export type WorkspaceExpansionByProject = Record<string, Record<string, boolean>>

export function workspaceExpansionKeys(project: string, directory: string) {
  return {
    project: pathKey(project),
    directory: pathKey(directory),
  }
}

export function workspaceExpansionValue(input: {
  byProject?: WorkspaceExpansionByProject
  legacy?: Record<string, boolean>
  project: string
  directory: string
  local: boolean
}) {
  const keys = workspaceExpansionKeys(input.project, input.directory)
  return (
    input.byProject?.[keys.project]?.[keys.directory] ??
    input.legacy?.[input.directory] ??
    input.legacy?.[keys.directory] ??
    input.local
  )
}
