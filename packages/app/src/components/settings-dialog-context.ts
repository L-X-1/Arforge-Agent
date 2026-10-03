/**
 * The global settings command is mounted above the route-specific Session
 * subtree, so useParams() can be empty even while the renderer is visibly on
 * a Session page. Read only the canonical route segment as presentation
 * context; the server still verifies the Session owner before any mutation.
 */
export function sessionIDFromRoutePath(pathname: string): string | undefined {
  const match = /\/session\/([^/]+)$/.exec(pathname)
  if (!match?.[1]) return undefined
  try {
    const value = decodeURIComponent(match[1]).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Build the shared settings route while preserving the originating Session. */
export function settingsRoute(sessionID?: string): string {
  const value = sessionID?.trim()
  return value ? `/settings?sessionID=${encodeURIComponent(value)}` : "/settings"
}
