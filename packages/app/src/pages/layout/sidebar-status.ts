export type SessionStatus = "permission" | "error" | "working" | "unread"
export type SessionListPresentation = "loading" | "retrying" | "error" | "empty" | "ready"

export function resolveSessionStatus(input: {
  hasPermissions: boolean
  hasError: boolean
  isWorking: boolean
  unseenCount: number
}): SessionStatus | undefined {
  if (input.hasPermissions) return "permission"
  if (input.hasError) return "error"
  if (input.isWorking) return "working"
  if (input.unseenCount > 0) return "unread"
}

export function resolveSessionListPresentation(input: {
  status: "loading" | "ready" | "error"
  retrying: boolean
  count: number
}): SessionListPresentation {
  if (input.retrying && input.count === 0) return "retrying"
  if (input.status === "loading" && input.count === 0) return "loading"
  if (input.status === "error" && input.count === 0) return "error"
  if (input.count === 0) return "empty"
  return "ready"
}
