export function workspaceCreationCommandDisabled(workspacesEnabled: boolean, creating: boolean) {
  return !workspacesEnabled || creating
}

export function workspaceCreationAnnouncement(creating: boolean, message: string) {
  return creating ? message : ""
}

export async function runWorkspaceCreation<T>(
  pending: Set<string>,
  key: string,
  action: () => Promise<T>,
  onPendingChange: (key: string, pending: boolean) => void,
) {
  if (pending.has(key)) return

  pending.add(key)
  try {
    onPendingChange(key, true)
    return await action()
  } finally {
    pending.delete(key)
    onPendingChange(key, false)
  }
}
