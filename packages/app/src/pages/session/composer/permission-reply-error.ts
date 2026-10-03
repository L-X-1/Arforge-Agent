function unwrapErrorBody(error: unknown) {
  if (!(error instanceof Error)) return error
  if (!error.cause || typeof error.cause !== "object") return error
  const cause = error.cause as Record<string, unknown>
  return "body" in cause ? cause.body : error
}

/**
 * A permission can disappear after it was rendered when another window,
 * auto-response rule, or the agent runtime answers it first. Treat that as a
 * stale local prompt, not as a failed user decision.
 */
export function isPermissionRequestGone(error: unknown, requestID: string) {
  const body = unwrapErrorBody(error)
  if (body && typeof body === "object") {
    const value = body as Record<string, unknown>
    const tag = value._tag ?? value.name
    if (tag === "PermissionNotFoundError") {
      return typeof value.requestID !== "string" || value.requestID === requestID
    }
  }

  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return message.startsWith("Permission request not found:") && message.includes(requestID)
}
