export type OperationLocation = {
  directory: string
  workspace?: string
}

export function resolveOperationLocation(
  session: { directory?: string; workspaceID?: string },
  fallbackDirectory?: string,
): OperationLocation {
  const directory = session.directory?.trim() || fallbackDirectory?.trim() || ""
  return {
    directory,
    ...(session.workspaceID ? { workspace: session.workspaceID } : {}),
  }
}

export function hasOperationDirectory(input: { location: { directory: string } }) {
  return input.location.directory.trim().length > 0
}

export function isMissingTeam(error: unknown) {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false
  return error._tag === "Team.NotFoundError" || error._tag === "TeamNotFoundError"
}
